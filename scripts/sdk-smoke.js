// Smoke test for an Agent SDK install: node scripts/sdk-smoke.js <folder holding node_modules>
// Starts an idle session like meta.js (no prompt is sent, so no plan usage), checks that the
// API names Nova relies on exist, and that supportedModels() answers.
// Prints one JSON line and exits 0 on success, 1 on failure. Run with the Nova agent env.
import fs from 'node:fs';
import path from 'node:path';
import { pathToFileURL } from 'node:url';

const root = path.resolve(process.argv[2] || '.');
const pkgDir = path.join(root, 'node_modules', '@anthropic-ai', 'claude-agent-sdk');
const out = (o, code) => { console.log(JSON.stringify(o)); process.exit(code); };
const timer = setTimeout(() => out({ ok: false, error: 'The test session didn\'t answer within 90 seconds.' }, 1), 90_000);

try {
  const pkg = JSON.parse(fs.readFileSync(path.join(pkgDir, 'package.json'), 'utf8'));
  const sdk = await import(pathToFileURL(path.join(pkgDir, pkg.exports?.['.']?.default || pkg.main)).href);
  const missing = ['query', 'getSessionMessages'].filter((n) => typeof sdk[n] !== 'function');
  if (missing.length) out({ ok: false, error: `The SDK no longer exports ${missing.join(', ')}.` }, 1);

  let stop;
  const done = new Promise((r) => { stop = r; });
  const q = sdk.query({
    prompt: { async *[Symbol.asyncIterator]() { await done; } },
    options: { cwd: process.cwd(), settingSources: [], env: process.env }
  });
  (async () => { try { for await (const _ of q) {} } catch {} })();

  const methods = ['supportedModels', 'accountInfo', 'interrupt', 'setPermissionMode', 'close'].filter((n) => typeof q[n] !== 'function');
  if (methods.length) out({ ok: false, error: `Sessions no longer have ${methods.join(', ')}.` }, 1);
  const models = await q.supportedModels();
  if (!Array.isArray(models) || !models.length) out({ ok: false, error: 'supportedModels() returned no models.' }, 1);
  const usage = typeof q.usage_EXPERIMENTAL_MAY_CHANGE_DO_NOT_RELY_ON_THIS_API_YET === 'function';
  stop();
  try { q.close(); } catch {}
  clearTimeout(timer);
  out({ ok: true, version: pkg.version, models: models.length, usage }, 0);
} catch (err) {
  out({ ok: false, error: err.message }, 1);
}
