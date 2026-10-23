// Running an app. /apps/<slug> (signed in) sends the browser on to /apps/<slug>/@<token>/,
// and everything under that is the app's own files, plus its backend under api/.
//
// An app is code, so it must never run as Nova. Every response carries a CSP sandbox that
// allows scripts but never allow-same-origin, so the app gets an opaque origin: it can't read
// Nova's cookies, call Nova's API or script the page around it, even when opened in its own
// tab. That also means its own requests carry no session cookie (SameSite=Strict), so the
// token in the path names the profile, and only for this one app: an app can reach its own
// files and backend, nothing else. Tokens live in memory for 12 hours; opening the app again
// gets a fresh one. Referrer-Policy no-referrer keeps the token out of requests to other sites.
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { UserError } from '../core/errors.js';
import { streamFile } from '../core/files.js';
import { requireView } from '../accounts/access.js';
import { appDir } from './catalog.js';
import { resolveIn } from './files.js';

export const APP_CSP = 'sandbox allow-scripts allow-forms allow-modals allow-popups allow-popups-to-escape-sandbox allow-downloads; ' +
  "default-src 'self' data: blob: https:; script-src 'self' 'unsafe-inline' 'unsafe-eval' blob: https:; " +
  "style-src 'self' 'unsafe-inline' https:; img-src 'self' data: blob: https:; font-src 'self' data: https:; " +
  "media-src 'self' data: blob: https:; connect-src 'self' https: wss:; worker-src 'self' blob:; frame-src 'self' https:; " +
  "form-action 'self'; base-uri 'self'; frame-ancestors 'self'";

const TYPES = {
  '.html': 'text/html', '.htm': 'text/html', '.css': 'text/css', '.js': 'text/javascript', '.mjs': 'text/javascript',
  '.json': 'application/json', '.map': 'application/json', '.txt': 'text/plain', '.md': 'text/markdown', '.csv': 'text/csv',
  '.xml': 'application/xml', '.svg': 'image/svg+xml', '.png': 'image/png', '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg',
  '.gif': 'image/gif', '.webp': 'image/webp', '.avif': 'image/avif', '.ico': 'image/x-icon', '.woff': 'font/woff',
  '.woff2': 'font/woff2', '.ttf': 'font/ttf', '.otf': 'font/otf', '.wasm': 'application/wasm', '.mp3': 'audio/mpeg',
  '.wav': 'audio/wav', '.ogg': 'audio/ogg', '.mp4': 'video/mp4', '.webm': 'video/webm', '.pdf': 'application/pdf'
};
const TEXT = new Set(['.html', '.htm', '.css', '.js', '.mjs', '.json', '.map', '.txt', '.md', '.csv', '.xml', '.svg']);

// The backend's code (backend.js and the backend/ folder) and its private data aren't served:
// only what a browser needs.
const PRIVATE = (rel) => /(^|\/)\./.test(rel) || /^backend(\.js$|\/)/i.test(rel) || /^data(\/|$)/i.test(rel);

const TTL = 12 * 60 * 60 * 1000;
const tokens = new Map(); // token -> { profile, slug, expires }

export function appToken(profile, slug) {
  const now = Date.now();
  for (const [t, v] of tokens) if (v.expires < now) tokens.delete(t);
  for (const [t, v] of tokens) if (v.profile === profile && v.slug === slug && v.expires - now > TTL / 2) return t;
  const token = crypto.randomBytes(24).toString('hex');
  tokens.set(token, { profile, slug, expires: now + TTL });
  return token;
}

// The profile a token stands for, if it was made for this app. Access is checked again on
// every request, so taking Apps access away stops a running app at once.
export function tokenProfile(token, slug) {
  const v = tokens.get(token);
  if (!v || v.expires < Date.now() || v.slug !== slug) throw new UserError('This app link has expired. Open the app again from Nova.', 401);
  requireView(v.profile, 'apps', 'read');
  return v.profile;
}

// /apps/<slug>: where the browser goes to run it.
export function runUrl(profile, slug) {
  requireView(profile, 'apps', 'read');
  appDir(slug);
  return `/apps/${slug}/@${appToken(profile, slug)}/`;
}

// One of the app's files, with the sandbox. A folder serves its index.html.
export function appFile(slug, rel) {
  let target = rel || 'index.html';
  if (target.endsWith('/')) target += 'index.html';
  if (PRIVATE(target)) throw new UserError('That file isn\'t served.', 404);
  let { abs } = resolveIn(slug, target);
  if (fs.statSync(abs).isDirectory()) ({ abs } = resolveIn(slug, `${target}/index.html`));
  const st = fs.statSync(abs);
  const ext = path.extname(abs).toLowerCase();
  const type = TYPES[ext] || 'application/octet-stream';
  return {
    headers: {
      'Content-Type': TEXT.has(ext) ? `${type}; charset=utf-8` : type, 'Content-Length': st.size, 'Cache-Control': 'no-store',
      'Content-Security-Policy': APP_CSP, 'Referrer-Policy': 'no-referrer'
    },
    write: streamFile(abs)
  };
}
