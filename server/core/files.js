// File helpers shared by the brain viewer, chat attachments, shared settings and the updaters:
// reading JSON, streaming files out, receiving uploads, and replacing a file safely.
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { once } from 'node:events';

// A JSON file's contents, or null if it's missing or unreadable.
export const readJsonFile = (file) => { try { return JSON.parse(fs.readFileSync(file, 'utf8')); } catch { return null; } };

// "1 byte", "12 KB", "3.4 MB": sizes as messages show them.
export const sizeText = (b) => (b < 1024 ? `${b} ${b === 1 ? 'byte' : 'bytes'}` : b < 1048576 ? `${Math.round(b / 1024)} KB` : `${(b / 1048576).toFixed(1)} MB`);

// Content-Disposition with an ASCII fallback name for old clients and the real name in UTF-8.
export const disposition = (name, inline = false) =>
  `${inline ? 'inline' : 'attachment'}; filename="${name.replace(/[^\x20-\x7e]|["\\]/g, '_')}"; filename*=UTF-8''${encodeURIComponent(name)}`;

// A response writer that streams a file, or a byte range of it ({ start, end }). It settles
// when the file is sent or the client goes away.
export const streamFile = (file, range) => (res) => new Promise((resolve, reject) =>
  fs.createReadStream(file, range).on('error', reject).pipe(res).on('finish', resolve).on('close', resolve));

// Windows refuses to rename or replace a file while another program briefly holds it.
export const isLocked = (err) => ['EPERM', 'EBUSY', 'EACCES'].includes(err?.code);

// A temporary name beside `file`. The brain viewer hides names of this shape, so a save or
// upload in progress never shows up in the tree.
export const tempBeside = (file) => path.join(path.dirname(file), `.${path.basename(file)}.nova-${crypto.randomBytes(4).toString('hex')}.tmp`);

// Replaces `file` with `data` all at once: written beside it, then renamed over it, retrying
// a few times while Windows has it locked. Throws the file system's error if that fails.
export async function replaceFile(file, data, { mode } = {}) {
  const temp = tempBeside(file);
  fs.writeFileSync(temp, data, { mode });
  for (let attempt = 0; ; attempt++) {
    try { fs.renameSync(temp, file); return; } catch (err) {
      if (attempt < 5 && isLocked(err)) { await new Promise((r) => setTimeout(r, 150)); continue; }
      try { fs.unlinkSync(temp); } catch {}
      throw err;
    }
  }
}

// Streams a request body into `file`, which must not exist yet, refusing it once it passes
// `limit` bytes with the error tooBig() makes. A partial file is removed. Resolves with the size.
export async function receiveFile(req, file, limit, tooBig) {
  if (Number(req.headers['content-length']) > limit) throw tooBig();
  const out = fs.createWriteStream(file, { flags: 'wx' });
  let size = 0;
  try {
    for await (const chunk of req) {
      size += chunk.length;
      if (size > limit) throw tooBig();
      if (!out.write(chunk)) await once(out, 'drain');
    }
    out.end();
    await once(out, 'finish');
    return size;
  } catch (err) {
    out.destroy();
    try { fs.unlinkSync(file); } catch {}
    throw err;
  }
}
