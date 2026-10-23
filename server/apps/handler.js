// Runs in its own Node process, under the permission model, for one request to an app's
// backend (apps/backend.js starts it in the app's folder). It reads the request from stdin,
// calls the default export of the app's backend.js, and prints the answer as one JSON object.
// Anything the backend logs goes to stderr, so it can't spoil the answer; Nova shows it when
// the backend fails. Not part of Nova's server: nothing imports this file.
import { pathToFileURL } from 'node:url';
import path from 'node:path';
import * as nodeModule from 'node:module';

// An app's .js files are ES modules, whatever a package.json further up the disk says (the
// apps folder can be anywhere). In-thread hooks, as the permission model allows no workers.
const appUrl = pathToFileURL(process.cwd() + path.sep).href;
nodeModule.registerHooks?.({
  load(url, context, nextLoad) {
    return nextLoad(url, url.startsWith(appUrl) && /\.js$/.test(url.split(/[?#]/)[0]) ? { ...context, format: 'module' } : context);
  }
});

for (const k of ['log', 'info', 'debug', 'table', 'dir']) console[k] = console.error;
const write = process.stdout.write.bind(process.stdout);
process.stdout.write = (...a) => process.stderr.write(...a);

let raw = '';
for await (const chunk of process.stdin) raw += chunk;
const req = JSON.parse(raw);

const mod = await import(pathToFileURL(path.join(process.cwd(), 'backend.js')).href);
const handle = typeof mod.default === 'function' ? mod.default : mod.handle;
if (typeof handle !== 'function') throw new Error('backend.js must export a function: export default async function (req) { … }');

const out = await handle(req);
const SHAPE = ['status', 'json', 'body', 'base64', 'headers'];
let reply;
if (out === undefined || out === null) reply = { status: 204, body: '' };
else if (typeof out === 'string') reply = { body: out };
else if (Buffer.isBuffer(out) || out instanceof Uint8Array) reply = { base64: Buffer.from(out).toString('base64') };
else if (typeof out === 'object' && Object.keys(out).some((k) => SHAPE.includes(k))) {
  reply = { ...out };
  if (Buffer.isBuffer(out.body) || out.body instanceof Uint8Array) { reply.base64 = Buffer.from(out.body).toString('base64'); delete reply.body; }
} else reply = { json: out };
write(JSON.stringify(reply), () => process.exit(0));
