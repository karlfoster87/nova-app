// The files of one app, for the Apps view's file list and editor. Every path is resolved,
// symlinks included, and must stay inside the app's folder. Saving checks the version the
// editor started from, so a file Nova changed meanwhile isn't overwritten unseen.
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { config } from '../core/config.js';
import { UserError } from '../core/errors.js';
import { replaceFile } from '../core/files.js';
import { within, toRel } from '../core/paths.js';
import { requireView } from '../accounts/access.js';
import { decode } from '../brain/resolve.js';
import { appDir, appsRoot, moveFolder } from './catalog.js';
import { hub } from '../core/hub.js';

const SKIP = new Set(['.git', 'node_modules', '__pycache__', '.venv']);
const MAX_ENTRIES = 3000;
const IMAGE = /\.(png|jpe?g|gif|webp|avif|svg|ico)$/i;
const versionOf = (buf) => crypto.createHash('sha1').update(buf).digest('hex');

// A path inside an app: real (symlinks followed) and inside its folder. must: 'file' | 'any'.
export function resolveIn(slug, input, { mustExist = true } = {}) {
  const dir = fs.realpathSync.native(appDir(slug));
  const rel = String(input ?? '').replace(/\\/g, '/').replace(/^\/+/, '');
  if (!rel || rel.split('/').some((s) => s === '..' || s === '' || s === '.')) throw new UserError('That path isn\'t valid.');
  const abs = path.resolve(dir, rel);
  if (!within(abs, dir) || abs === dir) throw new UserError('That path isn\'t valid.');
  let real = abs;
  try { real = fs.realpathSync.native(abs); } catch (err) {
    if (mustExist) throw new UserError('That file isn\'t in the app.', 404);
    // A new file: its nearest existing folder must be inside the app.
    let up = path.dirname(abs);
    while (!fs.existsSync(up)) up = path.dirname(up);
    if (!within(fs.realpathSync.native(up), dir)) throw new UserError('That path isn\'t valid.');
  }
  if (!within(real, dir)) throw new UserError('That path isn\'t valid.');
  return { dir, abs: real, rel: toRel(dir, abs) };
}

// Every file and folder in the app, folders first, as a flat list with depth.
export function tree(profile, slug) {
  requireView(profile, 'apps', 'read');
  const dir = fs.realpathSync.native(appDir(slug));
  const out = [];
  let more = false;
  const walk = (abs, depth) => {
    let entries;
    try { entries = fs.readdirSync(abs, { withFileTypes: true }); } catch { return; }
    entries = entries.filter((e) => !SKIP.has(e.name) && !/^\..*\.nova-[0-9a-f]+\.tmp$/.test(e.name) && (e.isDirectory() || e.isFile()));
    entries.sort((a, b) => (b.isDirectory() - a.isDirectory()) || a.name.localeCompare(b.name));
    for (const e of entries) {
      if (out.length >= MAX_ENTRIES) { more = true; return; }
      const child = path.join(abs, e.name);
      const isDir = e.isDirectory();
      let size = 0;
      if (!isDir) try { size = fs.statSync(child).size; } catch {}
      out.push({ path: toRel(dir, child), name: e.name, type: isDir ? 'dir' : 'file', depth, size });
      if (isDir) walk(child, depth + 1);
    }
  };
  walk(dir, 0);
  return { entries: out, more };
}

export function readFile(profile, slug, input) {
  requireView(profile, 'apps', 'read');
  const { abs, rel } = resolveIn(slug, input);
  const st = fs.statSync(abs);
  if (!st.isFile()) throw new UserError('That\'s a folder, not a file.', 400);
  const base = { path: rel, name: path.basename(abs), size: st.size };
  if (IMAGE.test(abs) && !/\.svg$/i.test(abs)) return { ...base, kind: 'image' };
  if (st.size > config.brain.maxViewKB * 1024) return { ...base, kind: 'large' };
  const buf = fs.readFileSync(abs);
  const text = decode(buf);
  if (text === null) return { ...base, kind: 'binary' };
  return { ...base, kind: 'text', content: text, version: versionOf(buf), readOnly: st.size > config.brain.maxEditKB * 1024 };
}

// version: what the editor started from; null creates a file that mustn't exist yet.
export async function writeFile(profile, slug, input, content, version) {
  requireView(profile, 'apps', 'edit');
  if (typeof content !== 'string') throw new UserError('Send the file\'s text as content.');
  const data = Buffer.from(content, 'utf8');
  if (data.length > config.brain.maxEditKB * 1024) throw new UserError('That file is too large to save from Nova.', 413);
  const { dir, abs, rel } = resolveIn(slug, input, { mustExist: false });
  const exists = fs.existsSync(abs);
  if (version == null) {
    if (exists) throw new UserError(`There's already a file called ${rel}.`, 409);
    fs.mkdirSync(path.dirname(abs), { recursive: true });
    fs.writeFileSync(abs, data, { flag: 'wx' });
  } else {
    if (!exists) throw new UserError('That file isn\'t in the app any more.', 404);
    const current = fs.readFileSync(abs);
    if (versionOf(current) !== version) throw new UserError('This file changed on disk since you opened it. Copy your changes, then reload it.', 409);
    if (current.equals(data)) return { version, size: data.length, unchanged: true };
    await replaceFile(abs, data);
  }
  console.log(`${profile} saved ${rel} in the app ${path.basename(dir)}.`);
  hub.toAll({ t: 'apps_changed', slug, path: rel });
  return { path: rel, version: versionOf(data), size: data.length };
}

// Files and folders go to the apps folder's trash, like whole apps.
export async function deleteFile(profile, slug, input) {
  requireView(profile, 'apps', 'edit');
  const { abs, rel } = resolveIn(slug, input);
  const trash = path.join(appsRoot(), '.trash');
  fs.mkdirSync(trash, { recursive: true });
  const stamp = new Date().toISOString().replace(/[:.]/g, '-');
  const to = path.join(trash, `${slug}-${rel.replace(/[/\\]/g, '_')}-${stamp}`);
  await moveFolder(abs, to, `delete ${rel}`);
  console.log(`${profile} deleted ${rel} from the app ${slug}.`);
  hub.toAll({ t: 'apps_changed', slug, path: rel });
  return { trashedTo: `.trash/${path.basename(to)}` };
}
