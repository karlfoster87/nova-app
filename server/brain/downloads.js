// Brain files leaving the server: a file or a whole folder (as a zip) to download, raster
// images shown inline in rendered notes, and video streamed to the viewer's player.
import fs from 'node:fs';
import path from 'node:path';
import { config } from '../core/config.js';
import { UserError } from '../core/errors.js';
import { disposition, streamFile } from '../core/files.js';
import { requireView } from '../accounts/access.js';
import { root, resolve, walkFiles, IMAGES, VIDEOS, extOf } from './resolve.js';
import { zipTo } from './zip.js';

// Everything a folder download would include, skipping hidden paths and symlinks that
// leave the brain. Refuses past the size or count limit before anything is sent.
function collect(profile, abs, rel, top) {
  const files = [];
  let total = 0;
  walkFiles(profile, abs, rel, (f) => {
    total += f.st.size;
    if (total > config.brain.maxZipMB * 1024 * 1024 || files.length >= 65000) {
      throw new UserError(`That folder is too large to download from Nova (the limit is ${config.brain.maxZipMB} MB and 65,000 files). Download a smaller folder.`, 413);
    }
    files.push({ abs: f.abs, name: `${top}/${f.rel.slice(rel ? rel.length + 1 : 0)}`, mtime: f.st.mtimeMs });
  }, { strict: true });
  return { files, total };
}

// A file as it is, or a folder as a zip. check: only report what a folder download would
// hold, so the browser can show an error instead of downloading one.
export function download(profile, input, { check = false } = {}) {
  requireView(profile, 'brain', 'read');
  const { abs, rel } = resolve(profile, input);
  const st = fs.statSync(abs);
  if (st.isFile()) {
    const name = path.basename(rel || abs);
    return check ? { summary: { name, files: 1, bytes: st.size } } : {
      headers: { 'Content-Type': 'application/octet-stream', 'Content-Length': st.size, 'Content-Disposition': disposition(name), 'Cache-Control': 'no-store' },
      write: streamFile(abs)
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

// Raster images, shown inline in rendered markdown. SVG and everything else only download
// (an SVG can carry script).
export function image(profile, input) {
  requireView(profile, 'brain', 'read');
  const { abs } = resolve(profile, input);
  const type = IMAGES[extOf(abs)];
  const st = fs.statSync(abs);
  if (!type || !st.isFile()) throw new UserError('Only PNG, JPEG, GIF, WebP and AVIF images show inline.', 415);
  return { headers: { 'Content-Type': type, 'Content-Length': st.size, 'Cache-Control': 'no-cache' }, write: streamFile(abs) };
}

// Video, streamed for the viewer's player. Browsers fetch video in byte ranges to seek (and
// Safari won't play without them), so one "bytes=start-end" range is honoured with a 206.
// Several ranges, or one past the end, get 416; no Range header gets the whole file.
export function video(profile, input, range) {
  requireView(profile, 'brain', 'read');
  const { abs } = resolve(profile, input);
  const type = VIDEOS[extOf(abs)];
  const st = fs.statSync(abs);
  if (!type || !st.isFile()) throw new UserError('Only MP4, M4V, WebM, OGV and MOV videos play inline.', 415);
  const size = st.size;
  const base = { 'Content-Type': type, 'Accept-Ranges': 'bytes', 'Cache-Control': 'no-cache' };
  if (!range) return { status: 200, headers: { ...base, 'Content-Length': size }, write: streamFile(abs) };
  const m = /^bytes=(\d*)-(\d*)$/.exec(String(range).trim());
  let start = m && m[1] !== '' ? Number(m[1]) : null;
  let end = m && m[2] !== '' ? Number(m[2]) : null;
  if (m && start === null && end !== null) { start = Math.max(0, size - end); end = size - 1; } // the last N bytes
  if (!m || start === null || start >= size || (end !== null && end < start)) {
    return { status: 416, headers: { ...base, 'Content-Range': `bytes */${size}`, 'Content-Length': 0 }, write: async (res) => res.end() };
  }
  end = end === null ? size - 1 : Math.min(end, size - 1);
  return { status: 206, headers: { ...base, 'Content-Length': end - start + 1, 'Content-Range': `bytes ${start}-${end}/${size}` },
    write: streamFile(abs, { start, end }) };
}
