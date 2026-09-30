// Agent SDK updates. Nova checks npm for a newer version on a timer, but only an admin can
// install one. The new version is installed into a staging folder and smoke-tested
// (scripts/sdk-smoke.js) there first. Only then does Nova restart. The launcher installs the
// version into the app between processes, when no Claude Code process holds its files, and
// rolls back if that fails.
import { execFile } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { config, agentEnv, APP_ROOT, DATA_DIR } from '../core/config.js';
import { readJsonFile } from '../core/files.js';
import { UserError } from '../core/errors.js';
import { busyRunners, busyError } from '../chat/runner.js';
import { npm, SDK_PACKAGE, VERSION_RE } from './npm.js';
import { updateLock, newer, checkTimer } from './shared.js';

const STAGING = path.join(DATA_DIR, 'sdk-staging');
const PENDING = path.join(DATA_DIR, 'sdk-update.json');         // written here, read by the launcher
const RESULT = path.join(DATA_DIR, 'sdk-update-result.json');   // written by the launcher, shown in Settings

const state = { latest: null, checkedAt: null, checkError: null, step: null, error: null };

const installedVersion = () => readJsonFile(path.join(APP_ROOT, 'node_modules', '@anthropic-ai', 'claude-agent-sdk', 'package.json'))?.version || null;

export async function checkLatest() {
  try {
    const v = JSON.parse(await npm(['view', SDK_PACKAGE, 'version', '--json'], { cwd: APP_ROOT, timeout: 60_000 }));
    if (!VERSION_RE.test(v)) throw new Error(`Unexpected version from npm: ${v}`);
    state.latest = v;
    state.checkError = null;
  } catch (err) {
    console.error('SDK update check failed:', err.message);
    state.checkError = 'Couldn\'t reach npm to check for a new version. Check this machine\'s internet or npm proxy settings, then check again.';
  }
  state.checkedAt = Date.now();
}

const schedule = checkTimer(checkLatest);
export const scheduleChecks = (firstDelay = 60_000) => schedule(firstDelay);

export function updateStatus() {
  const installed = installedVersion();
  return {
    installed,
    pinned: readJsonFile(path.join(APP_ROOT, 'package.json'))?.dependencies?.[SDK_PACKAGE] || null,
    latest: state.latest,
    available: !!(state.latest && installed && newer(state.latest, installed)),
    checkedAt: state.checkedAt,
    checkError: state.checkError,
    step: state.step,       // null | 'installing' | 'testing' | 'restarting'
    error: state.error,
    last: readJsonFile(RESULT), // outcome of the last install the launcher ran
    checkHours: config.updates.checkHours,
    busyChats: busyRunners().length
  };
}

// Stages and tests `version`, then calls onReady() to restart into the launcher's install.
// Returns at once; progress is read through updateStatus().
export function startUpdate(profile, version, onReady) {
  if (state.step || updateLock.by) throw new UserError('An update is already in progress.', 409);
  if (!VERSION_RE.test(String(version || ''))) throw new UserError('Choose a version to install.');
  const from = installedVersion();
  if (version === from) throw new UserError(`Version ${version} is already installed.`, 409);
  const busy = busyError('update');
  if (busy) throw busy;

  state.error = null;
  state.step = 'installing';
  updateLock.by = 'sdk';
  console.log(`SDK update to ${version} started by ${profile}.`);
  (async () => {
    fs.rmSync(STAGING, { recursive: true, force: true });
    fs.mkdirSync(STAGING, { recursive: true });
    fs.writeFileSync(path.join(STAGING, 'package.json'), JSON.stringify({ name: 'nova-sdk-staging', private: true, type: 'module' }));
    try {
      await npm(['install', '--no-audit', '--no-fund', '--save-exact', `${SDK_PACKAGE}@${version}`], { cwd: STAGING });
    } catch (err) {
      console.error('SDK staging install failed:', err.message);
      throw new Error(`Couldn't download version ${version}. Nothing was changed. npm said: ${err.message}`);
    }
    state.step = 'testing';
    const smoke = await smokeTest(STAGING);
    if (!smoke.ok) throw new Error(`Version ${version} failed its test, so Nova is staying on ${from}. ${smoke.error}`);
    console.log(`SDK ${version} passed its smoke test (${smoke.models} models${smoke.usage ? '' : ', no usage method'}).`);
    const busy = busyError('update', ' after the test');
    if (busy) throw new Error(`${busy.message} Nothing was changed.`);
    fs.writeFileSync(PENDING, JSON.stringify({ version, from, by: profile, at: Date.now() }));
    state.step = 'restarting';
    onReady(version);
  })().catch((err) => {
    fs.rmSync(STAGING, { recursive: true, force: true });
    state.error = err.message;
    state.step = null;
    updateLock.by = null;
  });
}

// Runs the smoke test in its own process against the staged install, as the chats would run it.
function smokeTest(root) {
  return new Promise((resolve) => {
    execFile(process.execPath, [path.join(APP_ROOT, 'scripts', 'sdk-smoke.js'), root],
      { cwd: config.paths.brainDir, env: agentEnv(), timeout: 120_000, windowsHide: true },
      (err, stdout, stderr) => {
        const line = String(stdout).trim().split('\n').pop();
        try { return resolve(JSON.parse(line)); } catch {}
        console.error('SDK smoke test output:', stdout, stderr, err?.message);
        resolve({ ok: false, error: 'The test session didn\'t start. The server log has the details.' });
      });
  });
}
