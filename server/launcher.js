// Runs the Nova server as a child process and starts it again whenever it exits with
// RESTART_CODE. That is how Settings applies changes that need a fresh process, such as a
// new brain folder. Any other exit ends the launcher with the same code, so NSSM or
// systemd still see real crashes and handle them as before.
//
// Between restarts it also installs a staged Agent SDK update (see server/updates/sdk.js) or a
// staged update of Nova itself (server/updates/app.js). This happens here because no Claude Code
// process is running then, so Windows won't lock its files. After a Nova update it keeps the
// means to undo it for a minute: if the new server stops in that time, the old code goes back.
//
// Options for running with no service manager, as the Windows task does:
//   --keep-alive  after a crash, start the server again, waiting 2 s, 4 s ... up to 60 s
//                 (back to 2 s once a run has lasted five minutes)
//   --log         write all output to <dataDir>/logs/nova.log, timestamped, rotated at 5 MB
import { spawn, execFile } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import util from 'node:util';
import { fileURLToPath } from 'node:url';
import { npm, SDK_PACKAGE, VERSION_RE } from './updates/npm.js';
import { readJsonFile as readJson } from './core/files.js';

const RESTART_CODE = 75; // must match server/core/restart.js
const serverFile = path.join(path.dirname(fileURLToPath(import.meta.url)), 'index.js');
const APP_ROOT = path.resolve(path.dirname(serverFile), '..');
// Same rule as config.js. Not imported, so a broken config.json can't stop the launcher.
const DATA_DIR = path.resolve(process.env.NOVA_DATA_DIR || './data');
const PENDING = path.join(DATA_DIR, 'sdk-update.json');
const RESULT = path.join(DATA_DIR, 'sdk-update-result.json');
const APP_PENDING = path.join(DATA_DIR, 'app-update.json');
const APP_RESULT = path.join(DATA_DIR, 'app-update-result.json');
const APP_BACKUP = path.join(DATA_DIR, 'app-backup');
const BUILD = path.join(APP_ROOT, 'build.json');
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
let rollback = null;    // { undo, pending, until } for a minute after a Nova update

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
    // The new version of Nova stopped soon after an update: put the previous one back.
    if (rollback && code !== RESTART_CODE && !stopping && Date.now() < rollback.until) {
      const { undo, pending } = rollback;
      rollback = null;
      installing = true;
      const result = { ...(readJson(APP_RESULT) || {}), ok: false,
        error: `The new version stopped within a minute of starting (${signal || `exit code ${code}`}), so Nova went back to ${pending.fromVersion}.` };
      console.error(result.error);
      await restore(undo, pending, result);
      fs.writeFileSync(APP_RESULT, JSON.stringify(result, null, 2));
      installing = false;
      if (stopping) process.exit(0);
      start();
      return;
    }
    rollback = null;
    if (code === RESTART_CODE && !stopping) {
      installing = true;
      await applyAppUpdate().catch((err) => console.error('Nova update step failed:', err));
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

const git = (args) => new Promise((resolve, reject) => {
  execFile('git', args, { cwd: APP_ROOT, timeout: 120_000, windowsHide: true },
    (err, stdout, stderr) => (err ? reject(new Error(String(stderr || err.message).trim())) : resolve(String(stdout).trim())));
});

// Top-level entries a Nova update replaces in a copy that isn't a git checkout: what the new
// version has, what the last update installed, and the build stamp. Packages, .git, the data
// folder and anything else someone added are left alone.
function appEntries(staged) {
  const skip = new Set(['node_modules', '.git']);
  const rel = path.relative(APP_ROOT, DATA_DIR);
  if (rel && !rel.startsWith('..') && !path.isAbsolute(rel)) skip.add(rel.split(path.sep)[0]);
  return [...new Set([...fs.readdirSync(staged), ...(readJson(BUILD)?.entries || []), 'build.json'])].filter((n) => !skip.has(n));
}

// Applies the Nova update the server staged and tested. A git checkout fast-forwards to the
// new commit; any other copy has its code swapped, with a backup in <dataDir>/app-backup.
// If anything fails, the previous code goes back.
async function applyAppUpdate() {
  const pending = readJson(APP_PENDING);
  if (!pending) return;
  fs.rmSync(APP_PENDING, { force: true });
  const result = { version: pending.version, commit: pending.commit, fromVersion: pending.fromVersion, from: pending.fromCommit,
    by: pending.by, at: Date.now() };
  let undo = null;
  console.log(`Updating Nova from ${pending.fromVersion} to ${pending.version} (${String(pending.commit).slice(0, 7)})…`);
  try {
    if (pending.mode === 'git') {
      if (await git(['rev-parse', 'HEAD']) !== pending.fromCommit) throw new Error('The checkout moved to another commit after the update was prepared.');
      if (await git(['status', '--porcelain', '--untracked-files=no'])) throw new Error('The checkout has changes that aren\'t committed.');
      await git(['merge', '--ff-only', '--quiet', pending.commit]);
      undo = () => git(['reset', '--hard', '--quiet', pending.fromCommit]); // safe: the tree was clean
    } else {
      const entries = appEntries(pending.staged);
      fs.rmSync(APP_BACKUP, { recursive: true, force: true });
      fs.mkdirSync(APP_BACKUP, { recursive: true });
      for (const n of entries) if (fs.existsSync(path.join(APP_ROOT, n))) fs.cpSync(path.join(APP_ROOT, n), path.join(APP_BACKUP, n), { recursive: true });
      undo = async () => {
        for (const n of entries) fs.rmSync(path.join(APP_ROOT, n), { recursive: true, force: true });
        for (const n of fs.readdirSync(APP_BACKUP)) fs.cpSync(path.join(APP_BACKUP, n), path.join(APP_ROOT, n), { recursive: true });
      };
      for (const n of entries) fs.rmSync(path.join(APP_ROOT, n), { recursive: true, force: true });
      for (const n of fs.readdirSync(pending.staged)) fs.cpSync(path.join(pending.staged, n), path.join(APP_ROOT, n), { recursive: true });
      fs.writeFileSync(BUILD, JSON.stringify({ commit: pending.commit, version: pending.version, entries: fs.readdirSync(pending.staged) }, null, 2));
    }
    if (pending.depsChanged) {
      await new Promise((r) => setTimeout(r, 1500)); // let Claude Code processes finish exiting
      await npm(['install', '--no-audit', '--no-fund'], { cwd: APP_ROOT, timeout: 15 * 60 * 1000 });
    }
    result.ok = true;
    rollback = { undo, pending, until: Date.now() + 60_000 };
    console.log(`Nova ${pending.version} installed.`);
  } catch (err) {
    result.ok = false;
    result.error = err.message;
    console.error(`Nova update failed, putting ${pending.fromVersion} back:`, err.message);
    if (undo) await restore(undo, pending, result);
  }
  fs.writeFileSync(APP_RESULT, JSON.stringify(result, null, 2));
  cleanAppStaging(pending.staged);
}

async function restore(undo, pending, result) {
  try {
    await undo();
    if (pending.depsChanged) await npm(['install', '--no-audit', '--no-fund'], { cwd: APP_ROOT, timeout: 15 * 60 * 1000 });
  } catch (err) {
    result.restoreError = err.message;
    console.error(`Putting the previous version back also failed. Restore it from ${APP_BACKUP} or with git, then run npm install in ${APP_ROOT}.`, err.message);
  }
}

// The staged copy may still hold a link to the app's own packages; unlink it rather than
// delete through it.
function cleanAppStaging(staged) {
  if (!staged) return;
  const nm = path.join(staged, 'node_modules');
  try { if (fs.lstatSync(nm).isSymbolicLink()) fs.unlinkSync(nm); } catch {}
  fs.rmSync(path.dirname(staged), { recursive: true, force: true });
}

const installed = () => readJson(path.join(APP_ROOT, 'node_modules', '@anthropic-ai', 'claude-agent-sdk', 'package.json'))?.version ?? null;

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
