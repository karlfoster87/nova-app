// Brain files an app may use. An app says which in app.json, by path from the brain folder:
//   "brain": { "Inventory/items.yaml": "write", "Recipes/": "read" }
// A path ending in / is a folder and everything under it; "read" lets the app read, "write"
// also lets it save, create and delete there. An app that edits a YAML file the brain keeps
// for Nova is the typical case: the file stays where it belongs, and the app is its form.
//
// Nothing is reachable until an admin allows the list (catalog.js setBrainGrants); a path
// added to app.json later waits for the admin again, and only as much as both app.json and
// the admin said counts. On top of that, every request runs as the profile using the app,
// through the brain viewer's own functions (brain/files.js), so an app never does more than
// that profile could in the Brain view: the same access level, hidden paths, admin-only
// folders, version checks and git commits.
//
// The running app reaches them under its own address (apps/serve.js), relative to its page:
//   GET    brain/<path>   a file's bytes (ETag: its version), or a folder as JSON { entries }
//   PUT    brain/<path>   save the body as the file's text; If-Match: <version> refuses (409) if it
//                         changed meanwhile; a new file is created in an existing folder
//   DELETE brain/<path>   move it to the brain's trash
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { q } from '../core/db.js';
import { fold } from '../core/paths.js';
import { UserError } from '../core/errors.js';
import { hub } from '../core/hub.js';
import { requireView } from '../accounts/access.js';
import { isAdmin } from '../accounts/profiles.js';
import { resolve } from '../brain/resolve.js';
import { listFolder, writeFile, createFile, deletePath } from '../brain/files.js';
import { appDir, manifestOf } from './catalog.js';
import { APP_CSP } from './serve.js';

const LEVELS = { read: 1, write: 2 };
const MAX_GRANTS = 50;
const MAX_READ = 20 * 1024 * 1024;
const versionOf = (buf) => crypto.createHash('sha1').update(buf).digest('hex');

// A grant's path, tidied: forward slashes, no leading slash, folders ending in /. null if it
// isn't a plain path inside the brain.
function cleanPath(p) {
  if (typeof p !== 'string') return null;
  const folder = /[/\\]$/.test(p.trim());
  const parts = p.trim().replace(/\\/g, '/').split('/').filter((s) => s && s !== '.');
  if (!parts.length || parts.includes('..') || /^[a-zA-Z]:$/.test(parts[0]) || p.includes('\0')) return null;
  return parts.join('/') + (folder ? '/' : '');
}

// { path: 'read' | 'write' } from a JSON-ish value, keeping only valid entries.
export function cleanGrants(value) {
  const out = {};
  if (!value || typeof value !== 'object' || Array.isArray(value)) return out;
  for (const [p, level] of Object.entries(value).slice(0, MAX_GRANTS)) {
    const key = cleanPath(p);
    if (key && LEVELS[level]) out[key] = level;
  }
  return out;
}

export const declaredGrants = (dir) => cleanGrants(manifestOf(dir).brain);
export function approvedGrants(slug) {
  try { return cleanGrants(JSON.parse(q.app.get(slug)?.brain_grants || '{}')); } catch { return {}; }
}

// What counts: paths both app.json and the admin named, at the lower of the two levels.
export function effectiveGrants(slug, dir = appDir(slug)) {
  const declared = declaredGrants(dir), approved = approvedGrants(slug);
  const out = {};
  for (const [p, level] of Object.entries(declared)) {
    const ok = approved[p];
    if (ok) out[p] = LEVELS[ok] < LEVELS[level] ? ok : level;
  }
  return out;
}

// For the Apps view: what the app asks for, what's allowed, and what still waits for an admin.
export function grantSummary(slug, dir) {
  const declared = declaredGrants(dir), approved = approvedGrants(slug);
  const list = (o) => Object.entries(o).map(([p, access]) => ({ path: p, access }));
  const pending = Object.entries(declared).filter(([p, level]) => !approved[p] || LEVELS[approved[p]] < LEVELS[level]);
  return { declared: list(declared), allowed: list(effectiveGrants(slug, dir)), pending: pending.map(([p, access]) => ({ path: p, access })) };
}

// An admin allows what app.json asks for right now (allow) or takes every brain path away.
export function setBrainGrants(profile, slug, allow) {
  requireView(profile, 'apps', 'read');
  if (!isAdmin(profile)) throw new UserError('Only an admin can let an app use files in the brain.', 403);
  const dir = appDir(slug);
  const grants = allow ? declaredGrants(dir) : {};
  q.addApp.run(slug, null, Date.now());
  q.setAppBrainGrants.run(Object.keys(grants).length ? JSON.stringify(grants) : null, slug);
  console.log(`${profile} ${allow ? `let the app ${slug} use ${Object.keys(grants).join(', ') || 'nothing'} in the brain` : `took the brain away from the app ${slug}`}.`);
  hub.toAll({ t: 'apps_changed' });
  return grantSummary(slug, dir);
}

// The level a grant gives this path: a file grant names it exactly; a folder grant covers it and
// everything under it. Case-insensitive where the file system is.
function levelFor(grants, rel) {
  let best = 0;
  const f = fold(rel);
  for (const [p, level] of Object.entries(grants)) {
    const key = fold(p);
    const hit = key.endsWith('/') ? f === key.slice(0, -1) || f.startsWith(key) : f === key;
    if (hit) best = Math.max(best, LEVELS[level]);
  }
  return best;
}

const TEXT_TYPES = { '.yaml': 'text/yaml', '.yml': 'text/yaml', '.json': 'application/json', '.md': 'text/markdown', '.csv': 'text/csv',
  '.txt': 'text/plain', '.html': 'text/html', '.css': 'text/css', '.js': 'text/javascript', '.xml': 'application/xml', '.svg': 'image/svg+xml' };
const BIN_TYPES = { '.png': 'image/png', '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg', '.gif': 'image/gif', '.webp': 'image/webp', '.pdf': 'application/pdf' };
const HEADERS = { 'cache-control': 'no-store', 'content-security-policy': APP_CSP, 'x-content-type-options': 'nosniff', 'referrer-policy': 'no-referrer',
  'access-control-expose-headers': 'ETag' };
const json = (res, status, body, extra = {}) => { res.writeHead(status, { ...HEADERS, 'content-type': 'application/json; charset=utf-8', ...extra }); res.end(JSON.stringify(body)); };

async function readBody(req, max) {
  if (Number(req.headers['content-length']) > max) throw new UserError('That\'s too large to save from Nova.', 413);
  const chunks = [];
  let size = 0;
  for await (const c of req) { size += c.length; if (size > max) throw new UserError('That\'s too large to save from Nova.', 413); chunks.push(c); }
  return Buffer.concat(chunks).toString('utf8');
}

// A request from a running app to brain/<rel>.
export async function appBrain(profile, slug, { req, res, rel }) {
  const target = cleanPath(rel);
  if (!target) throw new UserError('Name a file or folder in the brain, like brain/Notes/list.yaml.', 400);
  const p = target.replace(/\/$/, '');
  const level = levelFor(effectiveGrants(slug), p);
  if (!level) {
    const asked = levelFor(declaredGrants(appDir(slug)), p);
    throw new UserError(asked ? `This app may use ${p} once an admin allows it in the Apps view.` : `This app hasn't been given ${p}. Add it to "brain" in app.json, then ask an admin to allow it.`, 403);
  }
  const method = req.method;
  if (method !== 'GET' && level < LEVELS.write) throw new UserError(`This app may read ${p} but not change it.`, 403);

  if (method === 'GET') {
    requireView(profile, 'brain', 'read');
    const { abs, rel: found } = resolve(profile, p);
    const st = fs.statSync(abs);
    if (st.isDirectory()) {
      const { entries } = listFolder(profile, found);
      return json(res, 200, { path: found, entries: entries.map(({ name, path: ep, type, size, mtime }) => ({ name, path: ep, type, size, mtime })) });
    }
    if (st.size > MAX_READ) throw new UserError('That file is too large for an app to read.', 413);
    const buf = fs.readFileSync(abs);
    const ext = path.extname(abs).toLowerCase();
    const type = TEXT_TYPES[ext] ? `${TEXT_TYPES[ext]}; charset=utf-8` : BIN_TYPES[ext] || 'application/octet-stream';
    res.writeHead(200, { ...HEADERS, 'content-type': type, etag: `"${versionOf(buf)}"`, 'content-length': buf.length });
    return res.end(buf);
  }
  if (method === 'PUT' || method === 'POST') {
    const text = await readBody(req, 4 * 1024 * 1024);
    const ifMatch = String(req.headers['if-match'] || '').replace(/^W\//, '').replace(/"/g, '').trim() || null;
    let exists = true;
    try { resolve(profile, p); } catch (err) { if (err.status === 404) exists = false; else throw err; }
    if (!exists) {
      if (ifMatch) throw new UserError(`${p} isn't there any more, so it wasn't saved.`, 409);
      const r = await createFile(profile, p, text, `the app ${slug}`);
      return json(res, 201, { path: r.path, version: r.version, committed: !!r.committed }, { etag: `"${r.version}"` });
    }
    // Without If-Match the app saves over whatever is there now.
    const current = ifMatch || versionOf(fs.readFileSync(resolve(profile, p).abs));
    const r = await writeFile(profile, p, text, current);
    console.log(`${profile} saved ${p} through the app ${slug}.`);
    return json(res, 200, { path: p, version: r.version, unchanged: !!r.unchanged, committed: !!r.committed }, { etag: `"${r.version}"` });
  }
  if (method === 'DELETE') {
    const r = await deletePath(profile, p);
    console.log(`${profile} deleted ${p} through the app ${slug}.`);
    return json(res, 200, { path: p, trashedTo: r.trashedTo, committed: !!r.committed });
  }
  throw new UserError('Use GET, PUT or DELETE for brain files.', 405);
}
