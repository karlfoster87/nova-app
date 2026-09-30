// The brain viewer's rules for what a profile may see and change, and the one way every brain
// route turns a browser path into a file on disk. Every path is resolved, symlinks included,
// and must stay inside the brain. Hidden paths (.git, node_modules, the ignore list, other
// profiles' notes folders) are treated as missing, both in listings and when asked for directly.
import fs from 'node:fs';
import path from 'node:path';
import { config } from '../core/config.js';
import { UserError } from '../core/errors.js';
import { CASELESS, fold, within, toRel } from '../core/paths.js';
import { can } from '../accounts/access.js';
import { isAdmin } from '../accounts/profiles.js';

// File kinds by extension: how the viewer shows a file and what type it's served as.
export const MARKDOWN = new Set(['.md', '.markdown', '.mdx']);
export const HTML = new Set(['.html', '.htm']);
export const IMAGES = { '.png': 'image/png', '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg', '.gif': 'image/gif', '.webp': 'image/webp', '.avif': 'image/avif' };
// Video browsers play natively. A file whose codec the browser can't play falls back to a
// download prompt in the viewer. (.mov is common from phones and plays when it's H.264.)
export const VIDEOS = { '.mp4': 'video/mp4', '.m4v': 'video/mp4', '.webm': 'video/webm', '.ogv': 'video/ogg', '.mov': 'video/quicktime' };
export const extOf = (file) => path.extname(file).toLowerCase();

// Text if it has no NUL bytes and is valid UTF-8 (a BOM is dropped); otherwise null.
export function decode(buf) {
  if (buf.subarray(0, 8000).includes(0)) return null;
  try { return new TextDecoder('utf-8', { fatal: true }).decode(buf); } catch { return null; }
}

const ALWAYS_HIDDEN = new Set(['.git', 'node_modules']);
export const hiddenName = (name) => ALWAYS_HIDDEN.has(CASELESS ? name.toLowerCase() : name);

// The brain folder is fixed for the life of the process (changing it restarts Nova).
let rootPath;
export const root = () => (rootPath ??= fs.realpathSync.native(config.paths.brainDir));

// ---- Visibility -------------------------------------------------------------

// A pattern without a slash matches any single name; with one, a path from the root.
// * stays within a name, ** crosses folders, ? is one character.
function compile(patterns) {
  return (patterns || []).map((p) => {
    const src = String(p).replace(/[.+^${}()|[\]\\]/g, '\\$&')
      .replace(/\*\*/g, '\0').replace(/\*/g, '[^/]*').replace(/\?/g, '[^/]').replace(/\0/g, '.*');
    return { re: new RegExp(`^${src}$`, CASELESS ? 'i' : ''), byName: !String(p).includes('/') };
  });
}
let ignoreRules, adminRules;
// True if the path, or any folder above it, matches one of the rules.
function matches(rel, rules) {
  const parts = rel.split('/');
  for (let i = 0; i < parts.length; i++) {
    const sub = parts.slice(0, i + 1).join('/');
    if (rules.some((r) => r.re.test(r.byName ? parts[i] : sub))) return true;
  }
  return false;
}

// Where the profiles folder sits inside the brain, if it does ('' would be the root itself).
let profilesRel;
function profilesPrefix() {
  if (profilesRel === undefined) {
    try {
      const real = fs.realpathSync.native(config.paths.profilesDir);
      profilesRel = within(real, root()) ? toRel(root(), real) : null;
    } catch { profilesRel = null; }
    if (profilesRel === '') profilesRel = null;
  }
  return profilesRel;
}

// Inside the profiles folder, a profile sees only its own notes folder.
function otherProfiles(rel, profile) {
  const prefix = profilesPrefix();
  if (!prefix || !fold(rel).startsWith(fold(`${prefix}/`))) return false;
  return fold(rel.slice(prefix.length + 1).split('/')[0]) !== fold(profile);
}

const NOVA_TEMP = /\.nova-[0-9a-f]{8}\.tmp$/; // a save or upload in progress (core/files.js tempBeside)
export function isHidden(rel, profile) {
  if (!rel) return false;
  if (rel.split('/').some(hiddenName)) return true;
  if (NOVA_TEMP.test(rel)) return true;
  const trash = fold(config.brain.trashDir.replace(/\\/g, '/').replace(/^\/+|\/+$/g, ''));
  if (trash && (fold(rel) === trash || fold(rel).startsWith(`${trash}/`))) return true; // deleted items
  if (matches(rel, ignoreRules ??= compile(config.brain.ignore))) return true;
  return otherProfiles(rel, profile);
}

// ---- Rights -----------------------------------------------------------------

export const adminOnly = (rel) => matches(rel, adminRules ??= compile(config.brain.adminOnly));

// The profiles folder and each profile's notes folder can't be deleted from Nova, and
// neither can a folder holding them. Files inside a profile's own folder can.
export function protectedPath(rel) {
  const pr = profilesPrefix();
  if (!rel) return true; // the brain folder itself
  if (!pr) return false;
  const f = fold(rel), p = fold(pr);
  if (f === p || p.startsWith(`${f}/`)) return true;
  return f.startsWith(`${p}/`) && !f.slice(p.length + 1).includes('/');
}

// What a profile may do with an entry: delete it, and (folders) upload into it.
export function entryRights(profile, rel, isDir) {
  if (!can(profile, 'brain', 'edit') || (adminOnly(rel) && !isAdmin(profile))) return { canDelete: false, canUpload: false };
  return { canDelete: !protectedPath(rel), canUpload: isDir && fold(rel) !== fold(profilesPrefix() || '\0') };
}

// Why this profile can't edit a path, or null if it can.
export function readOnlyReason(profile, rel, size) {
  if (!can(profile, 'brain', 'edit')) return 'access';
  if (adminOnly(rel) && !isAdmin(profile)) return 'admin';
  if (size > config.brain.maxEditKB * 1024) return 'size';
  return null;
}

// ---- Paths ------------------------------------------------------------------

// Turns a browser path into { abs, rel, lexical }: abs is the real path on disk, rel the path
// the user navigated (forward slashes, '' for the root), lexical the path as named, which is
// the link itself if it's a symlink.
export function resolve(profile, input) {
  const raw = String(input ?? '');
  if (raw.includes('\0')) throw new UserError('That path isn\'t valid.');
  const cleaned = raw.replace(/\\/g, '/').replace(/^\/+/, '');
  if (/^[a-zA-Z]:/.test(cleaned)) throw new UserError('Use a path inside the brain folder.', 403);
  const r = root();
  const lexical = path.resolve(r, cleaned || '.');
  if (!within(lexical, r)) throw new UserError('That path is outside the brain folder.', 403);
  let real;
  try { real = fs.realpathSync.native(lexical); } catch { throw new UserError('That file or folder doesn\'t exist.', 404); }
  if (!within(real, r)) throw new UserError('That path leads outside the brain folder.', 403);
  const rel = toRel(r, lexical);
  if (isHidden(rel, profile) || isHidden(toRel(r, real), profile)) throw new UserError('That file or folder doesn\'t exist.', 404);
  return { abs: real, rel, lexical };
}

// Stats a directory entry, following a symlink only if it stays inside the brain and
// doesn't land somewhere hidden. Returns null for anything to leave out.
export function entryStat(full, dirent, profile) {
  try {
    let target = full;
    if (dirent.isSymbolicLink()) {
      target = fs.realpathSync.native(full);
      if (!within(target, root()) || isHidden(toRel(root(), target), profile)) return null;
    }
    const st = fs.statSync(target);
    return st.isFile() || st.isDirectory() ? { st, target } : null;
  } catch { return null; }
}

// Visits every file under a folder that this profile can see: abs is the folder on disk, rel
// its path from the root. visit({ abs, rel, st }) returning false stops the walk. Symlinks
// are followed as entryStat allows, and a link loop is visited once. strict: an unreadable
// folder throws rather than being skipped.
export function walkFiles(profile, abs, rel, visit, { strict = false } = {}) {
  const seen = new Set();
  let stopped = false;
  const walk = (dir, relDir) => {
    const key = fold(fs.realpathSync.native(dir));
    if (seen.has(key)) return;
    seen.add(key);
    let entries;
    try { entries = fs.readdirSync(dir, { withFileTypes: true }); } catch (err) { if (strict) throw err; return; }
    for (const d of entries) {
      if (stopped) return;
      const childRel = relDir ? `${relDir}/${d.name}` : d.name;
      if (isHidden(childRel, profile)) continue;
      const s = entryStat(path.join(dir, d.name), d, profile);
      if (!s) continue;
      if (s.st.isDirectory()) walk(s.target, childRel);
      else if (visit({ abs: s.target, rel: childRel, st: s.st }) === false) stopped = true;
    }
  };
  walk(abs, rel);
}
