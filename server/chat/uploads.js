// Files attached in the chat composer. Each upload is streamed to
// <dataDir>/uploads/<profile>/<id>/<name>, outside the brain, and recorded in nova.db.
// Sending a message ties its uploads to the chat. Claude reads them from disk (the
// profile's uploads folder is one of every chat's additionalDirectories); images also go in
// as image blocks so Claude sees them without a tool call.
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { q } from '../core/db.js';
import { config, DATA_DIR } from '../core/config.js';
import { UserError } from '../core/errors.js';
import { renamePath } from '../core/paths.js';
import { sizeText, disposition, streamFile, receiveFile } from '../core/files.js';

const TYPES = {
  '.png': 'image/png', '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg', '.gif': 'image/gif', '.webp': 'image/webp',
  '.pdf': 'application/pdf', '.txt': 'text/plain', '.md': 'text/markdown', '.csv': 'text/csv', '.json': 'application/json',
  '.html': 'text/html', '.xml': 'application/xml', '.zip': 'application/zip',
  '.docx': 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
  '.xlsx': 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
  '.pptx': 'application/vnd.openxmlformats-officedocument.presentationml.presentation'
};
// Sent to Claude as image blocks too. The API takes images up to 5 MB once base64-encoded.
const INLINE_IMAGES = new Set(['image/png', 'image/jpeg', 'image/gif', 'image/webp']);
const INLINE_MAX = 3.5 * 1024 * 1024;

export const uploadsDir = (profile) => path.join(DATA_DIR, 'uploads', profile);
const fileOf = (row) => path.join(uploadsDir(row.profile), row.id, row.name);

// A name that's safe on Windows and Linux: no folders, reserved characters or trailing dots.
function cleanName(raw) {
  let name = path.basename(String(raw || '').replace(/\\/g, '/'))
    .replace(/[\u0000-\u001f<>:"/\\|?*]/g, '_').replace(/[. ]+$/, '').trim();
  if (/^(con|prn|aux|nul|com\d|lpt\d)(\.|$)/i.test(name)) name = `_${name}`;
  if (name.length > 120) { const ext = path.extname(name).slice(0, 12); name = name.slice(0, 120 - ext.length) + ext; }
  return name || 'file';
}

const shape = (r) => ({ id: r.id, name: r.name, size: r.size, type: r.type });

// Streams the request body to disk, refusing anything over the size limit.
export async function saveUpload(profile, req, rawName) {
  const limit = config.uploads.maxMB * 1024 * 1024;
  const tooBig = () => new UserError(`That file is over ${config.uploads.maxMB} MB, the limit for attachments.`, 413);
  if (Number(req.headers['content-length']) > limit) throw tooBig();
  const name = cleanName(rawName);
  const id = crypto.randomUUID();
  const dir = path.join(uploadsDir(profile), id);
  fs.mkdirSync(dir, { recursive: true });
  let size;
  try { size = await receiveFile(req, path.join(dir, name), limit, tooBig); } catch (err) {
    fs.rmSync(dir, { recursive: true, force: true });
    throw err;
  }
  const type = TYPES[path.extname(name).toLowerCase()] || 'application/octet-stream';
  q.addUpload.run(id, profile, name, size, type, Date.now());
  return { id, name, size, type };
}

function owned(profile, id) {
  const row = id ? q.upload.get(String(id)) : null;
  if (!row || row.profile !== profile) throw new UserError('That attachment doesn\'t exist any more. Add the file again.', 404);
  return row;
}

// Removes an attachment that hasn't been sent. Sent ones stay with their chat.
export function discardUpload(profile, id) {
  const row = owned(profile, id);
  if (row.chat_id) throw new UserError('That file was already sent, so it stays with its chat.', 409);
  q.deleteUpload.run(row.id, profile);
  fs.rmSync(path.dirname(fileOf(row)), { recursive: true, force: true });
}

// Serves an attachment to its owner: raster images inline, everything else as a download.
export function openUpload(profile, id) {
  const row = owned(profile, id);
  const file = fileOf(row);
  if (!fs.existsSync(file)) throw new UserError('That file is no longer on the server.', 404);
  const inline = INLINE_IMAGES.has(row.type);
  return {
    headers: { 'Content-Type': inline ? row.type : 'application/octet-stream', 'Content-Length': fs.statSync(file).size,
      'Content-Disposition': disposition(row.name, inline), 'Cache-Control': 'private, max-age=3600' },
    write: streamFile(file)
  };
}

// Checks the ids a message wants to send: this profile's, not sent yet, within the limit.
export function claimUploads(profile, ids) {
  if (!Array.isArray(ids) || !ids.length) return [];
  if (ids.length > config.uploads.maxFiles) throw new UserError(`Attach up to ${config.uploads.maxFiles} files per message.`);
  return [...new Set(ids.map(String))].map((id) => {
    const row = owned(profile, id);
    if (row.chat_id) throw new UserError(`${row.name} was already sent. Add it again to send it once more.`, 409);
    return row;
  });
}

// The content blocks for a message with attachments: the user's text, a manifest Claude
// can act on (and the transcript turns back into capsules), and images inline.
export function messageContent(profile, chatId, text, rows) {
  if (!rows.length) return text;
  for (const r of rows) q.sendUpload.run(chatId, r.id, profile);
  const lines = rows.map((r) => `- ${r.name} (${sizeText(r.size)}, ${r.type}) [${r.id}]: ${fileOf(r)}`);
  const blocks = [];
  if (text) blocks.push({ type: 'text', text });
  blocks.push({ type: 'text', text: `<attachments>\nThe user attached ${rows.length === 1 ? 'this file' : 'these files'}. ${rows.length === 1 ? 'It is' : 'They are'} saved at the path shown; read ${rows.length === 1 ? 'it' : 'them'} with the Read tool when relevant.\n${lines.join('\n')}\n</attachments>` });
  for (const r of rows) {
    if (!INLINE_IMAGES.has(r.type) || r.size > INLINE_MAX) continue;
    try { blocks.push({ type: 'image', source: { type: 'base64', media_type: r.type, data: fs.readFileSync(fileOf(r)).toString('base64') } }); }
    catch (err) { console.error(`Couldn't inline ${r.name}:`, err.message); }
  }
  return blocks;
}

// Files added but never sent, older than keepUnsentHours, are deleted.
export function sweepUploads() {
  const cutoff = Date.now() - config.uploads.keepUnsentHours * 3600 * 1000;
  for (const r of q.staleUploads.all(cutoff)) {
    fs.rmSync(path.join(uploadsDir(r.profile), r.id), { recursive: true, force: true });
    q.deleteUpload.run(r.id, r.profile);
  }
}
setInterval(sweepUploads, 3600 * 1000).unref();

// Profile rename moves its uploads folder. Paths quoted in older messages then point at the
// old folder, so Claude re-reading an old attachment may need the new path.
export function moveProfileUploads(oldName, newName) {
  const from = uploadsDir(oldName), to = uploadsDir(newName);
  if (!fs.existsSync(from) || from === to) return;
  const caseOnly = from.toLowerCase() === to.toLowerCase();
  try { if (caseOnly || !fs.existsSync(to)) renamePath(from, to); }
  catch (err) { console.error(`Couldn't move ${from} to ${to}:`, err.message); }
}
