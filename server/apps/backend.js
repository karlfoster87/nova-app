// An app's backend: backend.js in its folder, a JavaScript module whose default export handles
// one request to /apps/<slug>/@<token>/api/... It runs in a fresh Node process per request
// (apps/handler.js loads it), the same Node that runs Nova, so it needs nothing installed:
//   export default async function (req) { return { status: 200, json: { ok: true } }; }
//   req: { method, path, query: { name: value }, headers: { content-type, accept }, body (text), user, app, dataDir,
//          brain: { '<path from app.json>': { path: '<absolute path>', access: 'read' | 'write' } } }
//   return: { status?, headers?, json? | body? (text) | base64? (bytes) }; a string is sent as text,
//   any other value as JSON, and nothing as 204.
// Nothing runs until an admin turns the app's backend on (catalog.js setBackend).
//
// Containment, on every platform, through Node's permission model (--permission): the process
// may read only its own app folder (and the loader), write only to the app's data/ folder,
// plus the brain paths an admin allowed the app (apps/brain.js backendGrants, as far as the
// profile using it may; its changes there are committed after the request), and may not start programs, threads, native add-ons or WASI. It starts with a rebuilt
// environment (no Claude sign-in, no Nova paths), a memory cap and a time limit; request and
// response sizes are capped and only a few requests per app run at once. Node can't yet block
// the network, so a backend can make web requests. data/ and the backend's code (backend.js,
// backend/) are never served to the browser.
import fs from 'node:fs';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { config } from '../core/config.js';
import { UserError } from '../core/errors.js';
import { appDir, backendAllowed } from './catalog.js';
import { APP_CSP } from './serve.js';
import { backendGrants } from './brain.js';
import { commitPaths } from '../brain/git.js';
import { clearLinkIndex } from '../brain/links.js';

const HANDLER = fileURLToPath(new URL('./handler.js', import.meta.url));
const IS_WIN = process.platform === 'win32';
const PER_APP = 3;
const TOTAL = 8;
const running = new Map(); // slug -> requests in flight
let total = 0;

// Only a few environment variables survive.
function cleanEnv(data, slug) {
  const env = { NOVA_APP: slug, NOVA_APP_DATA: data, HOME: data, TMPDIR: data, TEMP: data, TMP: data, LANG: 'C.UTF-8', NODE_ENV: 'production' };
  if (IS_WIN) {
    for (const k of ['SYSTEMROOT', 'SystemRoot', 'WINDIR']) if (process.env[k]) env[k] = process.env[k];
    env.USERPROFILE = data;
  } else env.PATH = '/usr/local/bin:/usr/bin:/bin';
  return env;
}

// Runs the backend for one request and sends its answer.
export async function runBackend(profile, slug, { req, res, rest, url }) {
  const dir = fs.realpathSync.native(appDir(slug));
  if (!fs.existsSync(path.join(dir, 'backend.js'))) throw new UserError('This app has no backend.js.', 404);
  if (!backendAllowed(slug)) throw new UserError('This app\'s backend is off. An admin can turn it on from the app\'s menu in the Apps view.', 403);
  if ((running.get(slug) || 0) >= PER_APP || total >= TOTAL) throw new UserError('This app is busy. Try again in a moment.', 503);

  const max = config.apps.maxRequestKB * 1024;
  if (Number(req.headers['content-length']) > max) throw new UserError('That request is too large for the app.', 413);
  const chunks = [];
  let size = 0;
  for await (const c of req) { size += c.length; if (size > max) throw new UserError('That request is too large for the app.', 413); chunks.push(c); }
  const data = path.join(dir, 'data');
  fs.mkdirSync(data, { recursive: true });
  // Brain paths the app was allowed, as far as this profile may use them (apps/brain.js).
  const grants = backendGrants(profile, slug);
  const input = JSON.stringify({
    method: req.method, path: rest, query: Object.fromEntries(url.searchParams),
    headers: { 'content-type': req.headers['content-type'] || '', accept: req.headers.accept || '' },
    body: Buffer.concat(chunks).toString('utf8'), user: profile, app: slug, dataDir: data, brain: grants.brain
  });
  const args = ['--permission', `--allow-fs-read=${HANDLER}`, `--allow-fs-read=${dir}`, `--allow-fs-write=${data}`,
    ...[...grants.read, ...grants.write].map((p) => `--allow-fs-read=${p}`), ...grants.write.map((p) => `--allow-fs-write=${p}`),
    `--max-old-space-size=${config.apps.memoryMB}`, '--disable-warning=ExperimentalWarning', HANDLER];

  running.set(slug, (running.get(slug) || 0) + 1);
  total++;
  try {
    respond(res, await run(args, { cwd: dir, env: cleanEnv(data, slug), input }));
  } finally {
    running.set(slug, running.get(slug) - 1);
    total--;
  }
  // Whatever it changed in the brain is committed like any brain edit, after the app has its answer.
  // Only paths that are there now: git refuses the whole commit if any path matches nothing
  // (a granted file not created yet, an empty granted folder).
  const changed = grants.write.filter((p) => { try { return fs.statSync(p).isFile() || fs.readdirSync(p).length > 0; } catch { return false; } });
  if (changed.length) {
    clearLinkIndex();
    commitPaths(profile, changed, `Edit through the app ${slug} in Nova`).catch((err) => console.error(`Committing ${slug}'s brain changes failed:`, err));
  }
}

function run(args, { cwd, env, input }) {
  const limit = config.apps.maxResponseKB * 1024 * 1.4 + 1024; // the answer travels as JSON, bytes as base64
  return new Promise((resolve) => {
    const child = spawn(process.execPath, args, { cwd, env, windowsHide: true, stdio: ['pipe', 'pipe', 'pipe'] });
    const out = [], err = [];
    let outSize = 0, errSize = 0, killed = null;
    const stop = (why) => { if (!killed) { killed = why; child.kill('SIGKILL'); } };
    const timer = setTimeout(() => stop('time'), config.apps.timeoutSec * 1000);
    child.stdout.on('data', (c) => { outSize += c.length; if (outSize > limit) stop('size'); else out.push(c); });
    child.stderr.on('data', (c) => { if (errSize < 16384) { errSize += c.length; err.push(c); } });
    child.on('error', (e) => { clearTimeout(timer); resolve({ fail: `The backend couldn't start: ${e.message}` }); });
    child.on('close', (code) => {
      clearTimeout(timer);
      const stderr = Buffer.concat(err).toString('utf8').trim().slice(-3000);
      if (killed === 'time') return resolve({ fail: `The backend took longer than ${config.apps.timeoutSec} seconds and was stopped.`, status: 504 });
      if (killed === 'size') return resolve({ fail: `The backend's answer was larger than ${config.apps.maxResponseKB} KB.` });
      resolve({ code, stdout: Buffer.concat(out).toString('utf8'), stderr });
    });
    child.stdin.on('error', () => {});
    child.stdin.end(input);
  });
}

// Headers a backend may set. The sandbox is Nova's: whatever the backend sends, even a page
// opened on its own, runs with the app's opaque origin.
const PASS = new Set(['content-type', 'content-disposition', 'cache-control', 'location']);
const BASE = { 'x-content-type-options': 'nosniff', 'content-security-policy': APP_CSP, 'referrer-policy': 'no-referrer' };

function respond(res, out) {
  const fail = (status, message, detail = '') => {
    res.writeHead(status, { ...BASE, 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' });
    res.end(JSON.stringify({ error: message, ...(detail ? { detail } : {}) }));
  };
  if (out.fail) return fail(out.status || 502, out.fail);
  let reply;
  try { reply = JSON.parse(out.stdout); } catch { reply = null; }
  if (!reply || typeof reply !== 'object' || out.code) {
    const why = out.stderr.split('\n').find((l) => /Error/.test(l))?.trim();
    return fail(500, why ? `The backend failed: ${why}` : `The backend stopped with an error (exit code ${out.code}).`, out.stderr);
  }
  const status = Number.isInteger(reply.status) && reply.status >= 200 && reply.status <= 599 ? reply.status : 200;
  const headers = { 'cache-control': 'no-store' };
  for (const [k, v] of Object.entries(reply.headers || {})) if (PASS.has(k.toLowerCase()) && typeof v === 'string') headers[k.toLowerCase()] = v.replace(/[\r\n]/g, '');
  let body;
  if ('json' in reply) { body = Buffer.from(JSON.stringify(reply.json) ?? 'null'); headers['content-type'] ??= 'application/json; charset=utf-8'; }
  else if (typeof reply.base64 === 'string') { body = Buffer.from(reply.base64, 'base64'); headers['content-type'] ??= 'application/octet-stream'; }
  else { body = Buffer.from(String(reply.body ?? ''), 'utf8'); headers['content-type'] ??= 'text/plain; charset=utf-8'; }
  res.writeHead(status, { ...headers, ...BASE });
  res.end(status === 204 || status === 304 ? undefined : body);
}
