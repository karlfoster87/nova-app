// Nova updates itself from its GitHub repository (Settings → Updates), the way it updates the
// Agent SDK: checked on the same timer, installed only when an admin asks, downloaded into a
// staging folder and tested there (its own syntax check and smoke test), then applied by the
// launcher between processes. The launcher puts the previous code back if applying fails, or
// if the new code stops within a minute of starting.
//
// A copy running newer code than GitHub is never offered an update, since that would throw
// away work in progress: changed tracked files, commits GitHub doesn't have, or (for a copy
// that doesn't know its commit) a version number at least as high as GitHub's.
import { execFile } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import zlib from 'node:zlib';
import { config, DATA_DIR } from './config.js';
import { busyRunners } from './chat.js';
import { UserError } from './errors.js';
import { APP_ROOT, newer, updateLock, busyError } from './updates.js';
import { npm, SDK_PACKAGE } from './npm.js';

const APP_STAGING = path.join(DATA_DIR, 'app-staging');
const STAGED = path.join(APP_STAGING, 'src');
const APP_PENDING = path.join(DATA_DIR, 'app-update.json');       // written here, read by the launcher
const APP_RESULT = path.join(DATA_DIR, 'app-update-result.json'); // written by the launcher, shown in Settings
const BUILD = path.join(APP_ROOT, 'build.json');                  // { commit, version, entries }: which commit a copy without git is

const state = {
  local: null, checkedLocal: null, remote: null, relation: null, ahead: 0, behind: 0,
  checkedAt: null, checkError: null, step: null, error: null
};
let checkTimer = null;

const readJson = (file) => { try { return JSON.parse(fs.readFileSync(file, 'utf8')); } catch { return null; } };
const short = (sha) => (sha ? sha.slice(0, 7) : '');
const repo = () => String(config.updates.appRepo || '').trim();
const branch = () => String(config.updates.appBranch || 'main').trim();

function run(cmd, args, { cwd = APP_ROOT, timeout = 60_000, env } = {}) {
  return new Promise((resolve, reject) => {
    execFile(cmd, args, { cwd, timeout, env, maxBuffer: 32 * 1024 * 1024, windowsHide: true }, (err, stdout, stderr) => {
      if (err) { err.output = `${stdout}\n${stderr}`; return reject(err); }
      resolve(String(stdout));
    });
  });
}
const git = (args) => run('git', args);

// Which code is running: a git checkout's HEAD and how many tracked files are changed, or
// the stamp that an update (or setup-lxc.sh) left beside a copy without git.
async function readLocal() {
  const version = readJson(path.join(APP_ROOT, 'package.json'))?.version || null;
  if (fs.existsSync(path.join(APP_ROOT, '.git'))) {
    try {
      const commit = (await git(['rev-parse', 'HEAD'])).trim();
      // Untracked files don't count: a fast-forward refuses to overwrite them, so they're safe.
      const changes = (await git(['status', '--porcelain', '--untracked-files=no'])).split('\n').filter(Boolean).length;
      return { mode: 'git', version, commit, changes };
    } catch {
      return { mode: 'git', version, commit: null, changes: 0 };
    }
  }
  return { mode: 'files', version, commit: readJson(BUILD)?.commit || null, changes: 0 };
}

const github = (url) => fetch(url, {
  headers: { Accept: 'application/vnd.github+json', 'User-Agent': 'nova-updater' },
  signal: AbortSignal.timeout(30_000)
});

async function readRemote() {
  const res = await github(`https://api.github.com/repos/${repo()}/commits/${encodeURIComponent(branch())}`);
  if (res.status === 404) throw new Error(`GitHub has no branch "${branch()}" in ${repo()}, or the repository is private.`);
  if (res.status === 403 || res.status === 429) throw new Error('GitHub is limiting requests from this address. Check again in an hour.');
  if (!res.ok) throw new Error(`GitHub answered ${res.status}.`);
  const c = await res.json();
  const pkg = await fetch(`https://raw.githubusercontent.com/${repo()}/${c.sha}/package.json`, { signal: AbortSignal.timeout(30_000) });
  return {
    commit: c.sha,
    version: pkg.ok ? (await pkg.json()).version || null : null,
    date: c.commit?.committer?.date || null,
    message: String(c.commit?.message || '').split('\n')[0]
  };
}

// Where the running code stands against GitHub's branch.
async function compare(local, remote) {
  if (local.changes) return { relation: 'modified' };
  if (!local.commit) {
    return { relation: remote.version && local.version && newer(remote.version, local.version) ? 'behind' : 'unknown' };
  }
  if (local.commit === remote.commit) return { relation: 'current' };
  const res = await github(`https://api.github.com/repos/${repo()}/compare/${remote.commit}...${local.commit}`);
  if (res.status === 404) return { relation: 'ahead' }; // a commit GitHub doesn't have: not pushed yet
  if (!res.ok) throw new Error(`GitHub answered ${res.status} when comparing commits.`);
  const c = await res.json(); // how the local commit (head) stands against GitHub's (base)
  return {
    relation: { ahead: 'ahead', behind: 'behind', identical: 'current', diverged: 'diverged' }[c.status] || 'unknown',
    ahead: c.ahead_by || 0, behind: c.behind_by || 0
  };
}

export async function checkApp() {
  if (!repo()) return;
  try {
    const local = await readLocal();
    const remote = await readRemote();
    Object.assign(state, { local, checkedLocal: local, remote, ahead: 0, behind: 0 }, await compare(local, remote));
    state.checkError = null;
  } catch (err) {
    console.error('Nova update check failed:', err.message);
    state.checkError = `Couldn't check GitHub for a new version of Nova. ${err.message}`;
  }
  state.checkedAt = Date.now();
}

// Runs on the Agent SDK's interval (updates.checkHours), re-armed after each check.
export function scheduleAppChecks(firstDelay = 90_000) {
  clearTimeout(checkTimer);
  const hours = config.updates.checkHours;
  if (!(hours > 0) || !repo()) return;
  checkTimer = setTimeout(async () => { await checkApp(); scheduleAppChecks(hours * 3600_000); }, firstDelay);
  checkTimer.unref();
}

export async function appStatus() {
  if (!state.step && repo()) state.local = await readLocal(); // cheap, and shows edits made since the check
  const { local, checkedLocal } = state;
  let relation = state.relation;
  if (local?.changes) relation = 'modified';
  else if (checkedLocal && (local?.commit !== checkedLocal.commit || checkedLocal.changes)) relation = 'stale'; // changed since the check
  return {
    enabled: !!repo(), repo: repo(), branch: branch(),
    local, remote: state.remote, relation, ahead: state.ahead, behind: state.behind,
    available: relation === 'behind',
    checkedAt: state.checkedAt, checkError: state.checkError,
    step: state.step, // null | 'downloading' | 'installing' | 'testing' | 'restarting'
    error: state.error,
    last: readJson(APP_RESULT),
    checkHours: config.updates.checkHours,
    busyChats: busyRunners().length
  };
}

// Stages and tests `commit`, then calls onReady(remote) to restart into the launcher's install.
// Returns at once; progress is read through appStatus().
export function startAppUpdate(profile, commit, onReady) {
  if (!repo()) throw new UserError('Nova\'s own updates are turned off (updates.appRepo is empty in config.json).', 409);
  if (state.step || updateLock.by) throw new UserError('An update is already in progress.', 409);
  if (state.relation !== 'behind' || state.remote?.commit !== commit) {
    throw new UserError('There\'s nothing newer on GitHub to install. Check for updates first.', 409);
  }
  const busy = busyError('');
  if (busy) throw busy;
  const target = state.remote, from = state.checkedLocal;

  state.error = null;
  state.step = 'downloading';
  updateLock.by = 'app';
  console.log(`Nova update to ${target.version} (${short(target.commit)}) started by ${profile}.`);
  (async () => {
    const now = await readLocal();
    if (now.changes || now.commit !== from.commit) throw new Error('This copy of Nova changed since the check. Check again, then update.');
    cleanStaging();
    fs.mkdirSync(STAGED, { recursive: true });
    const res = await fetch(`https://codeload.github.com/${repo()}/tar.gz/${target.commit}`, { signal: AbortSignal.timeout(180_000) });
    if (!res.ok) throw new Error(`Couldn't download ${short(target.commit)} from GitHub (${res.status}). Nothing was changed.`);
    untar(zlib.gunzipSync(Buffer.from(await res.arrayBuffer())), STAGED);
    if (!fs.existsSync(path.join(STAGED, 'server', 'index.js'))) throw new Error('The download doesn\'t look like Nova. Nothing was changed.');

    // The staged copy shares the app's packages unless its lockfile differs. An Agent SDK
    // updated from Settings (newer than the one GitHub pins) is kept, never downgraded.
    const sdkNow = readJson(path.join(APP_ROOT, 'package.json'))?.dependencies?.[SDK_PACKAGE];
    const sdkNew = readJson(path.join(STAGED, 'package.json'))?.dependencies?.[SDK_PACKAGE];
    const keepSdk = sdkNow && sdkNew && newer(sdkNow, sdkNew) ? sdkNow : null;
    const depsChanged = !!keepSdk || lockfile(STAGED) !== lockfile(APP_ROOT);
    if (depsChanged) {
      state.step = 'installing';
      await npm(['ci', '--omit=dev', '--no-audit', '--no-fund'], { cwd: STAGED, timeout: 15 * 60_000 });
      if (keepSdk) await npm(['install', '--no-audit', '--no-fund', '--save-exact', `${SDK_PACKAGE}@${keepSdk}`], { cwd: STAGED, timeout: 15 * 60_000 });
    } else {
      fs.symlinkSync(path.join(APP_ROOT, 'node_modules'), path.join(STAGED, 'node_modules'), 'junction');
    }
    state.step = 'testing';
    await testStaged();
    const busy = busyError(' after the test');
    if (busy) throw new Error(`${busy.message} Nothing was changed.`);
    if (from.mode === 'git') await git(['fetch', '--quiet', `https://github.com/${repo()}.git`, branch()]); // the launcher fast-forwards to it
    removeNodeModules(STAGED); // the launcher installs into the app itself when the lockfile changed
    fs.writeFileSync(APP_PENDING, JSON.stringify({
      mode: from.mode, commit: target.commit, version: target.version, fromCommit: from.commit, fromVersion: from.version,
      depsChanged, staged: STAGED, by: profile, at: Date.now()
    }));
    state.step = 'restarting';
    onReady(target);
  })().catch((err) => {
    console.error('Nova update stopped:', err.message);
    cleanStaging();
    state.error = err.message;
    state.step = null;
    updateLock.by = null;
  });
}

const lockfile = (root) => { try { return fs.readFileSync(path.join(root, 'package-lock.json'), 'utf8').replace(/\r\n/g, '\n'); } catch { return ''; } };

// The staged copy's own checks, run from its folder: the syntax check, then the smoke test,
// which starts a server of the new version on a spare port with throwaway data.
async function testStaged() {
  const env = { ...process.env };
  for (const k of ['NOVA_SUPERVISED', 'NOVA_DATA_DIR', 'CLAUDE_CONFIG_DIR']) delete env[k]; // nothing reaches this Nova's data
  try { await run(process.execPath, ['scripts/check.js'], { cwd: STAGED, timeout: 120_000, env }); }
  catch (err) { throw new Error(`The new version failed its syntax check, so Nova is staying as it is. ${tail(err)}`); }
  if (!fs.existsSync(path.join(STAGED, 'scripts', 'ws-smoke.js'))) return;
  try { await run(process.execPath, ['--disable-warning=ExperimentalWarning', 'scripts/ws-smoke.js'], { cwd: STAGED, timeout: 6 * 60_000, env }); }
  catch (err) {
    const fails = String(err.output || '').split('\n').filter((l) => l.startsWith('FAIL')).slice(0, 3).map((l) => l.slice(6)).join('; ');
    console.error('Staged smoke test output:', err.output);
    throw new Error(`The new version failed its smoke test, so Nova is staying as it is.${fails ? ` Failed: ${fails}.` : ' The server log has the details.'}`);
  }
}
const tail = (err) => String(err.output || err.message).trim().split('\n').slice(-3).join(' ');

// The staged node_modules is either a link to the app's own packages or a separate install.
// Only ever unlink the link: removing through it would delete the app's packages.
function removeNodeModules(dir) {
  const nm = path.join(dir, 'node_modules');
  let st;
  try { st = fs.lstatSync(nm); } catch { return; }
  if (st.isSymbolicLink()) { try { fs.unlinkSync(nm); } catch { fs.rmdirSync(nm); } }
  else fs.rmSync(nm, { recursive: true, force: true });
}
function cleanStaging() {
  removeNodeModules(STAGED);
  fs.rmSync(APP_STAGING, { recursive: true, force: true });
}

// A small reader for GitHub's tarballs: ustar entries, with pax ('x') and GNU ('L') long names.
// The first path segment (the repo-commit folder) is dropped. Links aren't expected and are skipped.
function untar(buf, dest) {
  const root = path.resolve(dest);
  const text = (a, b) => buf.toString('utf8', a, b).replace(/\0[\s\S]*$/, '');
  let off = 0, longName = null;
  while (off + 512 <= buf.length) {
    if (buf.subarray(off, off + 512).every((b) => b === 0)) break;
    const name = text(off, off + 100), prefix = text(off + 345, off + 500);
    const mode = parseInt(text(off + 100, off + 108).trim() || '644', 8);
    const size = parseInt(text(off + 124, off + 136).trim() || '0', 8);
    const type = String.fromCharCode(buf[off + 156]);
    const body = buf.subarray(off + 512, off + 512 + size);
    off += 512 + Math.ceil(size / 512) * 512;
    if (type === 'g') continue;
    if (type === 'x') { longName = /(?:^|\n)\d+ path=([^\n]*)\n/.exec(body.toString('utf8'))?.[1] ?? longName; continue; }
    if (type === 'L') { longName = body.toString('utf8').replace(/\0[\s\S]*$/, ''); continue; }
    const full = longName ?? (prefix ? `${prefix}/${name}` : name);
    longName = null;
    const rel = full.split('/').slice(1).join('/');
    if (!rel) continue;
    const target = path.resolve(root, rel);
    if (!target.startsWith(root + path.sep)) throw new Error(`The download has an unsafe path (${full}). Nothing was changed.`);
    if (type === '5') fs.mkdirSync(target, { recursive: true });
    else if (type === '0' || type === '\0' || type === '7') {
      fs.mkdirSync(path.dirname(target), { recursive: true });
      fs.writeFileSync(target, body, { mode: mode & 0o777 });
    }
  }
}
