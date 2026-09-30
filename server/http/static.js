// Serves the browser app from public/, plus marked and DOMPurify from node_modules. No build
// step: these files are exactly what the browser runs. Only what the sign-in page needs, and
// what the app manifest points at, is served without a session.
import fs from 'node:fs';
import path from 'node:path';
import { APP_ROOT } from '../core/config.js';
import { send } from './respond.js';

const PUBLIC = path.join(APP_ROOT, 'public');
const NODE_MODULES = path.join(APP_ROOT, 'node_modules');
const VENDOR = {
  '/vendor/marked.js': path.join(NODE_MODULES, 'marked', 'lib', 'marked.esm.js'),
  '/vendor/purify.js': path.join(NODE_MODULES, 'dompurify', 'dist', 'purify.es.mjs')
};
const TYPES = { '.html': 'text/html', '.js': 'text/javascript', '.mjs': 'text/javascript', '.css': 'text/css',
  '.json': 'application/json', '.webmanifest': 'application/manifest+json', '.svg': 'image/svg+xml', '.png': 'image/png' };

// Paths made only of lower-case letters, digits and hyphens in folders, so none can climb out
// of public/. A new module or stylesheet needs no list entry.
const STYLESHEET = /^\/css\/[a-z0-9-]+\.css$/;
const MODULE = /^\/js(\/[a-z0-9-]+)+\.js$/;
const ICON = /^\/icons\/[a-z0-9-]+\.(png|svg)$/; // browsers fetch the manifest's icons without the cookie
const PUBLIC_FILES = new Set(['/js/login.js', '/manifest.webmanifest', '/icon.svg']);

function serveFile(res, file) {
  fs.readFile(file, (err, data) => {
    if (err) return send(res, 404, 'Not found');
    send(res, 200, data, { 'Content-Type': TYPES[path.extname(file)] || 'application/octet-stream', 'Cache-Control': 'no-cache' });
  });
  return true;
}

// Before sign-in: the sign-in page, its script, the stylesheets, the vendored libraries,
// the manifest and its icons. Returns true if it served the request.
export function servePublic(res, p) {
  if (p === '/login' || p === '/login.html') return serveFile(res, path.join(PUBLIC, 'login.html'));
  if (VENDOR[p]) return serveFile(res, VENDOR[p]);
  if (PUBLIC_FILES.has(p) || STYLESHEET.test(p) || ICON.test(p)) return serveFile(res, path.join(PUBLIC, p));
  return false;
}

// With a session: the app page and its modules.
export function serveApp(res, p) {
  if (p === '/' || p === '/index.html') return serveFile(res, path.join(PUBLIC, 'index.html'));
  if (MODULE.test(p)) return serveFile(res, path.join(PUBLIC, p));
  return false;
}
