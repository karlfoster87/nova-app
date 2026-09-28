// Runs the Nova server as a child process and starts it again whenever it exits with
// RESTART_CODE. That is how Settings applies changes that need a fresh process, such as a
// new brain folder. Any other exit ends the launcher with the same code, so NSSM or
// systemd still see real crashes and handle them as before.
//
// Between restarts it also installs a staged Agent SDK update (see server/updates.js). This
// happens here because no Claude Code process is running then, so Windows won't lock its files.
//
// Options for running with no service manager, as the Windows task does:
//   --keep-alive  after a crash, start the server again, waiting 2 s, 4 s ... up to 60 s
//                 (back to 2 s once a run has lasted five minutes)
//   --log         write all output to <dataDir>/logs/nova.log, timestamped, rotated at 5 MB
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import util from 'node:util';
import { fileURLToPath } from 'node:url';
import { npm, SDK_PACKAGE, VERSION_RE } from './npm.js';

const RESTART_CODE = 75; // must match server/index.js
const serverFile = path.join(path.dirname(fileURLToPath(import.meta.url)), 'index.js');
const APP_ROOT = path.resolve(path.dirname(serverFile), '..');
// Same rule as config.js. Not imported, so a broken config.json can't stop the launcher.
const DATA_DIR = path.resolve(process.env.NOVA_DATA_DIR || './data');
const PENDING = path.join(DATA_DIR, 'sdk-update.json');
const RESULT = path.join(DATA_DIR, 'sdk-update-result.json');
const KEEP_ALIVE = process.argv.includes('--keep-alive');
const LOG = process.argv.includes('--log') ? path.join(DATA_DIR, 'logs', 'nova.log') : null;
const LOG_MAX = 5 * 1024 * 1024;

// Appends rather than holding the file open, so rotating is a plain rename on Windows too.
let logSize = 0;
function writeLog(text) {
  const lines = String(text).split(/\r?\n/).filter((l) => l.trim()).map((l) => `${new Date().toISOString()} ${l}\n`).join('');
  if (!lines) return;
  try {
    if (logSize > LOG_MAX) { fs.renameSync(LOG, `${LOG}.1`); logSize = 0; }
    fs.appendFileSync(LOG, lines);
    logSize += Buffer.byteLength(lines);
  } catch {} // logging must never stop Nova
}
if (LOG) {
  fs.mkdirSync(path.dirname(LOG), { recursive: true });
  try { logSize = fs.statSync(LOG).size; } catch {}
  for (const k of ['log', 'info', 'warn', 'error']) console[k] = (...args) => writeLog(util.format(...args));
}

let child = null;
let stopping = false;
let installing = false; // a stop request waits for an SDK install to finish rather than leave it half done
let startedAt = 0, crashes = 0;

function start() {
  startedAt = Date.now();
  child = spawn(process.execPath, ['--disable-warning=ExperimentalWarning', serverFile], {
    stdio: LOG ? ['ignore', 'pipe', 'pipe'] : 'inherit',
    env: { ...process.env, NOVA_SUPERVISED: '1' },
    windowsHide: true
  });
  if (LOG) { child.stdout.on('data', writeLog); child.stderr.on('data', writeLog); }
  child.on('exit', async (code, signal) => {
    child = null;
    if (code === RESTART_CODE && !stopping) {
      installing = true;
      await applySdkUpdate().catch((err) => console.error('SDK update step failed:', err));
      installing = false;
      if (stopping) process.exit(0);
      console.log('Restarting Nova…');
      start();
      return;
    }
    if (KEEP_ALIVE && !stopping) {
      if (Date.now() - startedAt > 5 * 60_000) crashes = 0;
      const wait = Math.min(60_000, 2000 * 2 ** crashes++);
      console.error(`Nova stopped (${signal || `exit code ${code}`}). Starting it again in ${wait / 1000} s.`);
      setTimeout(() => { if (!stopping) start(); }, wait);
      return;
    }
    process.exit(code ?? (signal ? 1 : 0));
  });
}

function installed() {
  try { return JSON.parse(fs.readFileSync(path.join(APP_ROOT, 'node_modules', '@anthropic-ai', 'claude-agent-sdk', 'package.json'), 'utf8')).version; }
  catch { return null; }
}

// Installs the version the server staged and tested. If that fails, puts package.json and
// the lockfile back and reinstalls from them, so Nova comes back on the version it had.
async function applySdkUpdate() {
  let pending;
  try { pending = JSON.parse(fs.readFileSync(PENDING, 'utf8')); } catch { return; }
  fs.rmSync(PENDING, { force: true });
  if (!VERSION_RE.test(String(pending.version))) return;
  const result = { version: pending.version, from: pending.from, by: pending.by, at: Date.now() };
  const saved = {};
  for (const f of ['package.json', 'package-lock.json']) {
    try { saved[f] = fs.readFileSync(path.join(APP_ROOT, f)); } catch {}
  }
  console.log(`Installing Agent SDK ${pending.version} (was ${pending.from})…`);
  try {
    await new Promise((r) => setTimeout(r, 1500)); // let Claude Code processes finish exiting
    await npm(['install', '--no-audit', '--no-fund', '--save-exact', `${SDK_PACKAGE}@${pending.version}`], { cwd: APP_ROOT, timeout: 10 * 60 * 1000 });
    const now = installed();
    if (now !== pending.version) throw new Error(`npm finished, but version ${now} is installed.`);
    result.ok = true;
    console.log(`Agent SDK ${pending.version} installed.`);
  } catch (err) {
    result.ok = false;
    result.error = err.message;
    console.error(`Agent SDK install failed, restoring ${pending.from}:`, err.message);
    for (const [f, data] of Object.entries(saved)) fs.writeFileSync(path.join(APP_ROOT, f), data);
    try {
      await npm(['install', '--no-audit', '--no-fund'], { cwd: APP_ROOT, timeout: 10 * 60 * 1000 });
    } catch (e) {
      result.restoreError = e.message;
      console.error(`Restoring the previous Agent SDK also failed. Run npm install in ${APP_ROOT} by hand.`, e.message);
    }
  }
  fs.writeFileSync(RESULT, JSON.stringify(result, null, 2));
  fs.rmSync(path.join(DATA_DIR, 'sdk-staging'), { recursive: true, force: true }); // the staged copy includes a large binary
}

for (const sig of ['SIGINT', 'SIGTERM']) {
  process.on(sig, () => {
    stopping = true;
    if (child) child.kill(sig); else if (!installing) process.exit(0);
  });
}

start();
