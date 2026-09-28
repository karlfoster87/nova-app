// Brain viewer and editor: list, read, edit and download files in the
// brain folder. Every path is resolved, symlinks included, and must stay inside the brain.
// Hidden paths (.git, node_modules, the ignore list, other profiles' notes folders) are
// treated as missing, both in listings and when asked for directly.
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { execFile } from 'node:child_process';
import { once } from 'node:events';
import { config } from './config.js';
import { UserError } from './errors.js';
import { isAdmin } from './profiles.js';
import { can, requireView } from './access.js';
import { fold, within, toRel } from './paths.js';
import { zipTo } from './zip.js';

const ALWAYS_HIDDEN = new Set(['.git', 'node_modules']);
const MARKDOWN = new Set(['.md', '.markdown', '.mdx']);
const IMAGES = { '.png': 'image/png', '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg', '.gif': 'image/gif', '.webp': 'image/webp', '.avif': 'image/avif' };
// Video browsers play natively. A file whose codec the browser can't play falls back to a
// download prompt in the viewer. (.mov is common from phones and plays when it's H.264.)
const VIDEOS = { '.mp4': 'video/mp4', '.m4v': 'video/mp4', '.webm': 'video/webm', '.ogv': 'video/ogg', '.mov': 'video/quicktime' };
const BOM = Buffer.from([0xef, 0xbb, 0xbf]);
const CASELESS = process.platform === 'win32' || process.platform === 'darwin';

// The brain folder is fixed for the life of the process (changing it restarts Nova).
let rootPath;
const root = () => (rootPath ??= fs.realpathSync.native(config.paths.brainDir));

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

const NOVA_TEMP = /\.nova-[0-9a-f]{8}\.tmp$/; // a save or upload in progress
function isHidden(rel, profile) {
  if (!rel) return false;
  if (rel.split('/').some((n) => ALWAYS_HIDDEN.has(CASELESS ? n.toLowerCase() : n))) return true;
  if (NOVA_TEMP.test(rel)) return true;
  const trash = fold(config.brain.trashDir.replace(/\\/g, '/').replace(/^\/+|\/+$/g, ''));
  if (trash && (fold(rel) === trash || fold(rel).startsWith(`${trash}/`))) return true; // deleted items
  if (matches(rel, ignoreRules ??= compile(config.brain.ignore))) return true;
  return otherProfiles(rel, profile);
}

const adminOnly = (rel) => matches(rel, adminRules ??= compile(config.brain.adminOnly));

// The profiles folder and each profile's notes folder can't be deleted from Nova, and
// neither can a folder holding them. Files inside a profile's own folder can.
function protectedPath(rel) {
  const pr = profilesPrefix();
  if (!rel) return true; // the brain folder itself
  if (!pr) return false;
  const f = fold(rel), p = fold(pr);
  if (f === p || p.startsWith(`${f}/`)) return true;
  return f.startsWith(`${p}/`) && !f.slice(p.length + 1).includes('/');
}

// What a profile may do with an entry: delete it, and (folders) upload into it.
function entryRights(profile, rel, isDir) {
  if (!can(profile, 'brain', 'edit') || (adminOnly(rel) && !isAdmin(profile))) return { canDelete: false, canUpload: false };
  return { canDelete: !protectedPath(rel), canUpload: isDir && fold(rel) !== fold(profilesPrefix() || '\0') };
}

// Why this profile can't edit a path, or null if it can.
function readOnlyReason(profile, rel, size) {
  if (!can(profile, 'brain', 'edit')) return 'access';
  if (adminOnly(rel) && !isAdmin(profile)) return 'admin';
  if (size > config.brain.maxEditKB * 1024) return 'size';
  return null;
}

// ---- Paths ------------------------------------------------------------------

// Turns a browser path into { abs, rel }: abs is the real path on disk, rel the path the
// user navigated (forward slashes, '' for the root).
function resolve(profile, input) {
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
  return { abs: real, rel, lexical }; // lexical: the path as named, which is the link itself if it's a symlink
}

// Stats a directory entry, following a symlink only if it stays inside the brain and
// doesn't land somewhere hidden. Returns null for anything to leave out.
function entryStat(full, dirent, profile) {
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

const byName = (a, b) => (a.type === b.type ? a.name.localeCompare(b.name, undefined, { numeric: true, sensitivity: 'base' }) : a.type === 'dir' ? -1 : 1);

// ---- Listing and reading ----------------------------------------------------

export function listFolder(profile, input) {
  requireView(profile, 'brain', 'read');
  const { abs, rel } = resolve(profile, input);
  if (!fs.statSync(abs).isDirectory()) throw new UserError('That\'s a file, not a folder.');
  const entries = [];
  for (const d of fs.readdirSync(abs, { withFileTypes: true })) {
    const childRel = rel ? `${rel}/${d.name}` : d.name;
    if (isHidden(childRel, profile)) continue;
    const s = entryStat(path.join(abs, d.name), d, profile);
    if (!s) continue;
    const isDir = s.st.isDirectory();
    entries.push({ name: d.name, path: childRel, type: isDir ? 'dir' : 'file', size: s.st.isFile() ? s.st.size : null, mtime: s.st.mtimeMs,
      ...entryRights(profile, childRel, isDir) });
  }
  return { path: rel, ...entryRights(profile, rel, true), entries: entries.sort(byName) };
}

const versionOf = (buf) => crypto.createHash('sha1').update(buf).digest('hex');

// Text if it has no NUL bytes and is valid UTF-8 (a BOM is dropped); otherwise null.
function decode(buf) {
  if (buf.subarray(0, 8000).includes(0)) return null;
  try { return new TextDecoder('utf-8', { fatal: true }).decode(buf); } catch { return null; }
}

export function readFile(profile, input) {
  requireView(profile, 'brain', 'read');
  const { abs, rel } = resolve(profile, input);
  const st = fs.statSync(abs);
  if (st.isDirectory()) throw new UserError('That\'s a folder. Pick a file inside it.');
  const ext = path.extname(abs).toLowerCase();
  const file = { path: rel, name: path.basename(rel || abs), size: st.size, mtime: st.mtimeMs, canDelete: entryRights(profile, rel, false).canDelete };
  if (IMAGES[ext]) return { ...file, kind: 'image' };
  if (VIDEOS[ext]) return { ...file, kind: 'video' };
  if (st.size > config.brain.maxViewKB * 1024) return { ...file, kind: 'large' };
  const buf = fs.readFileSync(abs);
  const text = decode(buf);
  if (text === null) return { ...file, kind: 'binary' };
  return { ...file, kind: MARKDOWN.has(ext) ? 'markdown' : 'text', content: text, version: versionOf(buf),
    readOnly: readOnlyReason(profile, rel, st.size), canDelete: entryRights(profile, rel, false).canDelete };
}

// ---- Saving -----------------------------------------------------------------

// Saves over an existing text file. Refuses if the file changed since the browser read
// it (version is a hash of the bytes it was sent). Keeps the file's BOM and line endings,
// writes a temporary file beside it and renames it into place, then commits if the brain
// is a git repository.
export async function writeFile(profile, input, content, version) {
  requireView(profile, 'brain', 'edit');
  if (typeof content !== 'string') throw new UserError('Nothing to save.');
  const { abs, rel } = resolve(profile, input);
  const st = fs.statSync(abs);
  if (!st.isFile()) throw new UserError('That\'s a folder, not a file.');
  const reason = readOnlyReason(profile, rel, Math.max(st.size, Buffer.byteLength(content)));
  if (reason === 'admin') throw new UserError(`Only an admin can change ${rel}, because it steers every chat.`, 403);
  if (reason === 'size') throw new UserError(`That's too large to save from Nova (the limit is ${config.brain.maxEditKB} KB).`, 413);

  const current = fs.readFileSync(abs);
  if (versionOf(current) !== version) {
    throw new UserError('This file changed on disk since you opened it, so your edit wasn\'t saved. Copy your changes, reload the file, then apply them again.', 409);
  }
  if (decode(current) === null) throw new UserError('That file isn\'t plain text, so Nova can\'t edit it.');
  const crlf = current.includes('\r\n');
  let text = content.replace(/\r\n/g, '\n');
  if (crlf) text = text.replace(/\n/g, '\r\n');
  const data = Buffer.concat([current.subarray(0, 3).equals(BOM) ? BOM : Buffer.alloc(0), Buffer.from(text, 'utf8')]);
  if (data.equals(current)) return { version, unchanged: true, committed: false };

  await replaceFile(abs, data, st.mode);
  console.log(`${profile} saved ${rel} in the brain viewer.`);
  const after = fs.statSync(abs);
  return { version: versionOf(data), size: after.size, mtime: after.mtimeMs, ...(await commit(profile, abs, rel)) };
}

async function replaceFile(file, data, mode) {
  const temp = path.join(path.dirname(file), `.${path.basename(file)}.nova-${crypto.randomBytes(4).toString('hex')}.tmp`);
  fs.writeFileSync(temp, data, { mode });
  // Windows refuses the rename while another program briefly holds the file, so retry a little.
  for (let attempt = 0; ; attempt++) {
    try { fs.renameSync(temp, file); return; } catch (err) {
      if (attempt < 5 && ['EPERM', 'EBUSY', 'EACCES'].includes(err.code)) { await new Promise((r) => setTimeout(r, 150)); continue; }
      try { fs.unlinkSync(temp); } catch {}
      console.error(`Saving ${file} failed:`, err);
      throw new UserError(['EPERM', 'EBUSY', 'EACCES'].includes(err.code)
        ? 'Couldn\'t save: another program has the file open or locked. Close it and try again.'
        : `Couldn't save the file: ${err.message}`, 409);
    }
  }
}

// ---- Deleting and uploading -------------------------------------------------

const clearIndexes = () => indexes.clear(); // file names changed: [[links]] must look again

// Moves a file or folder into <brain>/<brain.trashDir>/<time>/<its path>, the way Obsidian's
// trash works, so a deletion can be undone by moving it back. A symlink is moved as a
// link; what it points at is untouched. Refuses the brain itself, profile folders, paths
// only admins may change, and folders holding things Nova hides (.git, node_modules), which
// the user can't see and wouldn't expect to lose.
export async function deletePath(profile, input) {
  requireView(profile, 'brain', 'edit');
  const { rel, lexical } = resolve(profile, input);
  if (!rel) throw new UserError('The brain folder itself can\'t be deleted.', 403);
  if (protectedPath(rel)) throw new UserError('Profile folders can\'t be deleted from Nova. Remove a profile in Settings; its notes folder stays on disk.', 403);
  if (adminOnly(rel) && !isAdmin(profile)) throw new UserError(`Only an admin can delete ${rel}, because it steers every chat.`, 403);
  const st = fs.lstatSync(lexical);
  if (st.isDirectory()) {
    const walk = (dir) => {
      for (const d of fs.readdirSync(dir, { withFileTypes: true })) {
        if (ALWAYS_HIDDEN.has(CASELESS ? d.name.toLowerCase() : d.name)) {
          throw new UserError(`${rel} contains ${d.name}, which Nova hides. Delete it outside Nova if you mean to.`, 409);
        }
        if (d.isDirectory()) walk(path.join(dir, d.name));
      }
    };
    walk(lexical);
  }
  const stamp = new Date().toISOString().replace(/[:.]/g, '-');
  const dest = path.join(root(), config.brain.trashDir, stamp, ...rel.split('/'));
  fs.mkdirSync(path.dirname(dest), { recursive: true });
  try { fs.renameSync(lexical, dest); } catch (err) {
    console.error(`Deleting ${rel} failed:`, err);
    throw new UserError(['EPERM', 'EBUSY', 'EACCES'].includes(err.code)
      ? `Couldn't delete ${rel}: another program has it open or locked. Close it and try again.`
      : `Couldn't delete ${rel}: ${err.message}`, 409);
  }
  clearIndexes();
  console.log(`${profile} deleted ${rel} (moved to ${path.relative(root(), dest)}).`);
  const trash = toRel(root(), dest);
  return { trashedTo: trash, ...(await commitPaths(profile, [lexical], `Delete ${rel} in Nova`, 'Deleted')) };
}

// A path segment that's safe on Windows and Linux.
function cleanSegment(raw) {
  let s = String(raw).replace(/[\u0000-\u001f<>:"\\|?*]/g, '_').replace(/[. ]+$/, '').trim();
  if (/^(con|prn|aux|nul|com\d|lpt\d)(\.|$)/i.test(s)) s = `_${s}`;
  return s.slice(0, 200);
}

// Streams one uploaded file into a brain folder. relPath may hold subfolders (a folder
// upload), which are created. An existing file is refused with 409 unless overwrite is
// set; the browser asks first. Not committed here: the browser calls commitUpload once
// the whole batch is in, so a folder upload is one commit.
export async function uploadFile(profile, req, dirInput, relPath, overwrite) {
  requireView(profile, 'brain', 'edit');
  const limit = config.brain.maxUploadMB * 1024 * 1024;
  const tooBig = () => new UserError(`That file is over ${config.brain.maxUploadMB} MB, the limit for uploads to the brain.`, 413);
  if (Number(req.headers['content-length']) > limit) throw tooBig();
  const dir = resolve(profile, dirInput);
  if (!fs.statSync(dir.abs).isDirectory()) throw new UserError('Pick a folder to upload into.');
  const raw = String(relPath || '').replace(/\\/g, '/').split('/').filter((s) => s && s !== '.');
  if (!raw.length || raw.includes('..')) throw new UserError('That file name isn\'t valid.');
  const segs = raw.map(cleanSegment);
  if (segs.some((s) => !s)) throw new UserError('That file name isn\'t valid.');
  const rel = [dir.rel, ...segs].filter(Boolean).join('/');
  if (isHidden(rel, profile)) throw new UserError(`${segs.join('/')} would be hidden in Nova, so it wasn't uploaded.`, 403);
  if (adminOnly(rel) && !isAdmin(profile)) throw new UserError(`Only an admin can add files to ${rel.split('/')[0]}, because it steers every chat.`, 403);
  const target = path.join(dir.abs, ...segs);
  fs.mkdirSync(path.dirname(target), { recursive: true });
  // A folder on the way could be a symlink leading out; check where it really landed.
  const realParent = fs.realpathSync.native(path.dirname(target));
  if (!within(realParent, root()) || isHidden(toRel(root(), realParent), profile)) throw new UserError('That folder leads outside the brain.', 403);
  if (fs.existsSync(target)) {
    if (fs.statSync(target).isDirectory()) throw new UserError(`There's already a folder called ${segs.at(-1)} there.`);
    if (!overwrite) throw new UserError(`${segs.join('/')} already exists.`, 409);
  }
  const temp = path.join(path.dirname(target), `.${segs.at(-1)}.nova-${crypto.randomBytes(4).toString('hex')}.tmp`);
  const out = fs.createWriteStream(temp, { flags: 'wx' });
  let size = 0;
  try {
    for await (const chunk of req) {
      size += chunk.length;
      if (size > limit) throw tooBig();
      if (!out.write(chunk)) await once(out, 'drain');
    }
    out.end();
    await once(out, 'finish');
    fs.renameSync(temp, target);
  } catch (err) {
    out.destroy();
    try { fs.unlinkSync(temp); } catch {}
    if (err instanceof UserError) throw err;
    console.error(`Upload of ${rel} failed:`, err);
    throw new UserError(`Couldn't save ${segs.join('/')}: ${err.message}`, 409);
  }
  clearIndexes();
  return { path: rel, size };
}

// One commit for a finished upload batch. paths: what uploadFile returned.
export async function commitUpload(profile, paths, dirInput) {
  requireView(profile, 'brain', 'edit');
  const files = [].concat(paths || []).slice(0, 5000).flatMap((p) => { try { return [resolve(profile, p).lexical]; } catch { return []; } });
  if (!files.length) return { committed: false };
  const where = String(dirInput || '') || 'the brain';
  console.log(`${profile} uploaded ${files.length} file(s) to ${where}.`);
  return commitPaths(profile, files, `Upload ${files.length === 1 ? '1 file' : `${files.length} files`} to ${where} in Nova`, 'Uploaded');
}

// ---- Git --------------------------------------------------------------------

// input: written to git's stdin (NUL-separated paths), so a long list never hits the
// command-line length limit on Windows.
function git(args, env = {}, input = null) {
  return new Promise((resolve) => {
    const child = execFile('git', ['--literal-pathspecs', ...args],
      { cwd: root(), timeout: 60000, windowsHide: true, maxBuffer: 16 * 1024 * 1024, env: { ...process.env, GIT_TERMINAL_PROMPT: '0', ...env } },
      (error, stdout, stderr) => resolve({ ok: !error, missing: error?.code === 'ENOENT', out: String(stdout), err: String(stderr) }));
    child.stdin?.on('error', () => {}); // git may exit before reading, e.g. when it's missing
    child.stdin?.end(input ?? '');
  });
}

// One commit at a time, so two saves never race for git's index lock.
let gitQueue = Promise.resolve();
const NOTHING = /did not match any file|nothing to commit|no changes added/i;

// Commits changes to these paths (absolute; files or folders, present or deleted) in one
// commit with the profile as author. Not a repository, or nothing git tracks: skip silently.
// The change on disk stands either way; a failed commit is reported, never undone.
// what: the start of the message if committing fails ("Saved", "Deleted", "Uploaded").
function commitPaths(profile, paths, message, what = 'Saved') {
  const run = async () => {
    const inside = await git(['rev-parse', '--is-inside-work-tree']);
    if (inside.missing) {
      return fs.existsSync(path.join(root(), '.git'))
        ? { committed: false, commitError: `${what}, but not committed: git isn't installed or isn't on the PATH of the account running Nova.` }
        : { committed: false };
    }
    if (!inside.ok || inside.out.trim() !== 'true') return { committed: false };
    const ignored = new Set((await git(['check-ignore', '-z', '--stdin'], {}, paths.join('\0'))).out.split('\0').filter(Boolean));
    const keep = paths.filter((p) => !ignored.has(p));
    if (!keep.length) return { committed: false };
    const list = keep.join('\0');
    // Use the repository's own committer if it has one; otherwise name Nova.
    const env = (await git(['config', 'user.email'])).ok ? {} : { GIT_COMMITTER_NAME: 'Nova', GIT_COMMITTER_EMAIL: 'nova@localhost' };
    const add = await git(['add', '-A', '--pathspec-from-file=-', '--pathspec-file-nul'], {}, list);
    const done = add.ok && await git(['commit', '-m', message, `--author=${profile} <${profile}@nova.local>`, '--pathspec-from-file=-', '--pathspec-file-nul'], env, list);
    if (done?.ok) return { committed: true };
    const failed = done || add;
    if (NOTHING.test(failed.err + failed.out)) return { committed: false }; // e.g. files git never tracked
    console.error(`git commit "${message}" failed:`, failed.err || failed.out);
    return { committed: false, commitError: `${what}, but the git commit failed: ${failed.err.trim().split('\n').pop() || 'git reported an error'}` };
  };
  const result = gitQueue.then(run, run);
  gitQueue = result.catch(() => {});
  return result;
}
const commit = (profile, abs, rel) => commitPaths(profile, [abs], `Edit ${rel} in Nova`);

// ---- Obsidian-style links ---------------------------------------------------

// Every file this profile can see, as paths from the root, cached briefly per profile so a
// page full of links costs one walk. Same visibility rules as the tree.
const INDEX_TTL = 30 * 1000, INDEX_MAX = 100000;
const indexes = new Map(); // profile -> { at, files }
function brainIndex(profile) {
  const hit = indexes.get(profile);
  if (hit && Date.now() - hit.at < INDEX_TTL) return hit.files;
  const files = [], seen = new Set();
  const walk = (dir, relDir) => {
    const key = fold(fs.realpathSync.native(dir));
    if (seen.has(key)) return;
    seen.add(key);
    let entries;
    try { entries = fs.readdirSync(dir, { withFileTypes: true }); } catch { return; }
    for (const d of entries) {
      if (files.length >= INDEX_MAX) return;
      const childRel = relDir ? `${relDir}/${d.name}` : d.name;
      if (isHidden(childRel, profile)) continue;
      const s = entryStat(path.join(dir, d.name), d, profile);
      if (!s) continue;
      if (s.st.isDirectory()) walk(s.target, childRel);
      else files.push(childRel);
    }
  };
  walk(root(), '');
  indexes.set(profile, { at: Date.now(), files });
  return files;
}

// Finds what [[target]] points at, the way Obsidian does: by file name anywhere in the brain
// (".md" implied), or by a path when the target has a folder in it. With several matches,
// one in the linking note's own folder wins, then the shortest path.
// names: the targets as written, "#heading" and all. Returns { name: path | null }.
export function resolveLinks(profile, from, names) {
  requireView(profile, 'brain', 'read');
  names = [].concat(names || []).map(String).filter((n) => n.length <= 300).slice(0, 300);
  const files = brainIndex(profile);
  const byBase = new Map();
  for (const f of files) {
    const base = fold(f.slice(f.lastIndexOf('/') + 1));
    if (!byBase.has(base)) byBase.set(base, []);
    byBase.get(base).push(f);
  }
  const fromDir = String(from || '').includes('/') ? String(from).slice(0, String(from).lastIndexOf('/')) : '';
  const depth = (f) => f.split('/').length;
  const pick = (list) => list.find((f) => f.slice(0, f.lastIndexOf('/') + 1) === (fromDir ? `${fromDir}/` : ''))
    || [...list].sort((a, b) => depth(a) - depth(b) || a.length - b.length)[0];

  const out = {};
  for (const name of names) {
    const target = name.split('#')[0].trim().replace(/\\/g, '/').replace(/^\/+/, '');
    if (!target) { out[name] = from ? String(from) : null; continue; } // [[#Heading]]: this note
    const candidates = /\.md$/i.test(target) ? [target] : [`${target}.md`, target];
    let found = null;
    for (const cand of candidates) {
      let list = byBase.get(fold(cand.slice(cand.lastIndexOf('/') + 1))) || [];
      if (cand.includes('/')) {
        const want = fold(cand), near = fold(path.posix.normalize(fromDir ? `${fromDir}/${cand}` : cand));
        list = list.filter((f) => { const ff = fold(f); return ff === want || ff === near || ff.endsWith(`/${want}`); });
      }
      if (list.length) { found = pick(list); break; }
    }
    out[name] = found;
  }
  return out;
}

// ---- Downloads --------------------------------------------------------------

const disposition = (name) =>
  `attachment; filename="${name.replace(/[^\x20-\x7e]|["\\]/g, '_')}"; filename*=UTF-8''${encodeURIComponent(name)}`;

// Everything a folder download would include, skipping hidden paths and symlinks that
// leave the brain. Refuses past the size or count limit before anything is sent.
function collect(profile, abs, rel, top) {
  const files = [], seen = new Set();
  let total = 0;
  const limit = config.brain.maxZipMB * 1024 * 1024;
  const walk = (dir, relDir, zipDir) => {
    const key = fold(fs.realpathSync.native(dir));
    if (seen.has(key)) return; // a symlink loop
    seen.add(key);
    for (const d of fs.readdirSync(dir, { withFileTypes: true })) {
      const childRel = relDir ? `${relDir}/${d.name}` : d.name;
      if (isHidden(childRel, profile)) continue;
      const s = entryStat(path.join(dir, d.name), d, profile);
      if (!s) continue;
      if (s.st.isDirectory()) { walk(s.target, childRel, `${zipDir}/${d.name}`); continue; }
      total += s.st.size;
      if (total > limit || files.length >= 65000) {
        throw new UserError(`That folder is too large to download from Nova (the limit is ${config.brain.maxZipMB} MB and 65,000 files). Download a smaller folder.`, 413);
      }
      files.push({ abs: s.target, name: `${zipDir}/${d.name}`, mtime: s.st.mtimeMs });
    }
  };
  walk(abs, rel, top);
  return { files, total };
}

// A file as-is, or a folder as a zip. check: only report what a folder download would
// hold, so the browser can show an error instead of downloading one.
export function download(profile, input, { check = false } = {}) {
  requireView(profile, 'brain', 'read');
  const { abs, rel } = resolve(profile, input);
  const st = fs.statSync(abs);
  if (st.isFile()) {
    const name = path.basename(rel || abs);
    return check ? { summary: { name, files: 1, bytes: st.size } } : {
      headers: { 'Content-Type': 'application/octet-stream', 'Content-Length': st.size, 'Content-Disposition': disposition(name), 'Cache-Control': 'no-store' },
      write: (res) => new Promise((resolve, reject) => fs.createReadStream(abs).on('error', reject).pipe(res).on('finish', resolve).on('close', resolve))
    };
  }
  const top = rel ? path.basename(rel) : path.basename(root()) || 'brain';
  const { files, total } = collect(profile, abs, rel, top);
  const name = `${top}.zip`;
  return check ? { summary: { name, files: files.length, bytes: total } } : {
    headers: { 'Content-Type': 'application/zip', 'Content-Disposition': disposition(name), 'Cache-Control': 'no-store' },
    write: (res) => zipTo(res, files)
  };
}

// Raster images, shown inline in rendered markdown. SVG and everything else only download.
export function image(profile, input) {
  requireView(profile, 'brain', 'read');
  const { abs } = resolve(profile, input);
  const type = IMAGES[path.extname(abs).toLowerCase()];
  const st = fs.statSync(abs);
  if (!type || !st.isFile()) throw new UserError('Only PNG, JPEG, GIF, WebP and AVIF images show inline.', 415);
  return {
    headers: { 'Content-Type': type, 'Content-Length': st.size, 'Cache-Control': 'no-cache' },
    write: (res) => new Promise((resolve, reject) => fs.createReadStream(abs).on('error', reject).pipe(res).on('finish', resolve).on('close', resolve))
  };
}

// Video, streamed for the viewer's player. Browsers fetch video in byte ranges to seek (and
// Safari won't play without them), so one "bytes=start-end" range is honoured with a 206.
// Several ranges, or one past the end, get 416; no Range header gets the whole file.
export function video(profile, input, range) {
  requireView(profile, 'brain', 'read');
  const { abs } = resolve(profile, input);
  const type = VIDEOS[path.extname(abs).toLowerCase()];
  const st = fs.statSync(abs);
  if (!type || !st.isFile()) throw new UserError('Only MP4, M4V, WebM, OGV and MOV videos play inline.', 415);
  const size = st.size;
  const base = { 'Content-Type': type, 'Accept-Ranges': 'bytes', 'Cache-Control': 'no-cache' };
  const stream = (opts) => (res) => new Promise((resolve, reject) =>
    fs.createReadStream(abs, opts).on('error', reject).pipe(res).on('finish', resolve).on('close', resolve));
  if (!range) return { status: 200, headers: { ...base, 'Content-Length': size }, write: stream() };
  const m = /^bytes=(\d*)-(\d*)$/.exec(String(range).trim());
  let start = m && m[1] !== '' ? Number(m[1]) : null;
  let end = m && m[2] !== '' ? Number(m[2]) : null;
  if (m && start === null && end !== null) { start = Math.max(0, size - end); end = size - 1; } // the last N bytes
  if (!m || start === null || start >= size || (end !== null && end < start)) {
    return { status: 416, headers: { ...base, 'Content-Range': `bytes */${size}`, 'Content-Length': 0 }, write: async (res) => res.end() };
  }
  end = end === null ? size - 1 : Math.min(end, size - 1);
  return { status: 206, headers: { ...base, 'Content-Length': end - start + 1, 'Content-Range': `bytes ${start}-${end}/${size}` },
    write: stream({ start, end }) };
}
