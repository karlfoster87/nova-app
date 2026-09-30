// The brain viewer's file operations: list a folder, read, save, delete (to the brain's trash)
// and upload. Each checks view access and resolves its path through resolve.js; changes are
// committed through git.js when the brain is a repository.
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { config } from '../core/config.js';
import { UserError } from '../core/errors.js';
import { within, toRel } from '../core/paths.js';
import { isLocked, replaceFile, tempBeside, receiveFile } from '../core/files.js';
import { requireView } from '../accounts/access.js';
import { isAdmin } from '../accounts/profiles.js';
import {
  root, resolve, isHidden, hiddenName, entryStat, entryRights, readOnlyReason, adminOnly, protectedPath,
  decode, extOf, MARKDOWN, HTML, IMAGES, VIDEOS
} from './resolve.js';
import { commitPaths } from './git.js';
import { clearLinkIndex } from './links.js';
import { pageToken } from './pages.js';

const BOM = Buffer.from([0xef, 0xbb, 0xbf]);
const versionOf = (buf) => crypto.createHash('sha1').update(buf).digest('hex');
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

// What the viewer needs to show a file. kind: image | video | large | binary | markdown |
// html | text. Text kinds carry the content, a version (hash of the bytes, sent back with a
// save) and why the profile can't edit it, if it can't. HTML also gets a page token (pages.js).
export function readFile(profile, input) {
  requireView(profile, 'brain', 'read');
  const { abs, rel } = resolve(profile, input);
  const st = fs.statSync(abs);
  if (st.isDirectory()) throw new UserError('That\'s a folder. Pick a file inside it.');
  const ext = extOf(abs);
  const file = { path: rel, name: path.basename(rel || abs), size: st.size, mtime: st.mtimeMs, canDelete: entryRights(profile, rel, false).canDelete };
  if (IMAGES[ext]) return { ...file, kind: 'image' };
  if (VIDEOS[ext]) return { ...file, kind: 'video' };
  if (st.size > config.brain.maxViewKB * 1024) return { ...file, kind: 'large' };
  const buf = fs.readFileSync(abs);
  const text = decode(buf);
  if (text === null) return { ...file, kind: 'binary' };
  return { ...file, kind: MARKDOWN.has(ext) ? 'markdown' : HTML.has(ext) ? 'html' : 'text', content: text, version: versionOf(buf),
    readOnly: readOnlyReason(profile, rel, st.size), pageToken: HTML.has(ext) ? pageToken(profile) : undefined };
}

// ---- Saving -----------------------------------------------------------------

// Saves over an existing text file. Refuses if the file changed since the browser read
// it (version is a hash of the bytes it was sent). Keeps the file's BOM and line endings,
// replaces the file all at once, then commits if the brain is a git repository.
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

  try { await replaceFile(abs, data, { mode: st.mode }); } catch (err) {
    console.error(`Saving ${abs} failed:`, err);
    throw new UserError(isLocked(err)
      ? 'Couldn\'t save: another program has the file open or locked. Close it and try again.'
      : `Couldn't save the file: ${err.message}`, 409);
  }
  console.log(`${profile} saved ${rel} in the brain viewer.`);
  const after = fs.statSync(abs);
  return { version: versionOf(data), size: after.size, mtime: after.mtimeMs, ...(await commitPaths(profile, [abs], `Edit ${rel} in Nova`)) };
}

// ---- Deleting and uploading -------------------------------------------------

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
  if (fs.lstatSync(lexical).isDirectory()) {
    const walk = (dir) => {
      for (const d of fs.readdirSync(dir, { withFileTypes: true })) {
        if (hiddenName(d.name)) throw new UserError(`${rel} contains ${d.name}, which Nova hides. Delete it outside Nova if you mean to.`, 409);
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
    throw new UserError(isLocked(err)
      ? `Couldn't delete ${rel}: another program has it open or locked. Close it and try again.`
      : `Couldn't delete ${rel}: ${err.message}`, 409);
  }
  clearLinkIndex();
  console.log(`${profile} deleted ${rel} (moved to ${path.relative(root(), dest)}).`);
  return { trashedTo: toRel(root(), dest), ...(await commitPaths(profile, [lexical], `Delete ${rel} in Nova`, 'Deleted')) };
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
  const temp = tempBeside(target);
  let size;
  try {
    size = await receiveFile(req, temp, limit, tooBig);
    fs.renameSync(temp, target);
  } catch (err) {
    try { fs.unlinkSync(temp); } catch {}
    if (err instanceof UserError) throw err;
    console.error(`Upload of ${rel} failed:`, err);
    throw new UserError(`Couldn't save ${segs.join('/')}: ${err.message}`, 409);
  }
  clearLinkIndex();
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
