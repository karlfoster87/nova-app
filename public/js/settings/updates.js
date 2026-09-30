// Settings → Updates (admin): Nova itself from GitHub and the Claude Agent SDK from npm. Both
// work the same way: check, then Update and restart, which stages and tests the new version
// on the server first. While an update runs, its panel polls for progress.
import { $ } from '../lib/dom.js';
import { api } from '../lib/api.js';
import { confirmDialog } from '../lib/dialog.js';
import { showRestarting } from '../shell/restart.js';
import { run, setStatus } from './forms.js';

const dlg = $('settings');
const when = (ms) => new Date(ms).toLocaleString(undefined, { dateStyle: 'medium', timeStyle: 'short' });
const sha7 = (sha) => (sha ? sha.slice(0, 7) : '');
const count = (n, one) => `${n} ${n === 1 ? one : `${one}s`}`;
const busyText = (n) => `${n === 1 ? 'A chat is' : `${n} chats are`} working or waiting for an answer. Updating waits until they're finished.`;

export function loadUpdates() { loadApp(); loadSdk(); }

// The status line both panels show, most important first.
function showState(status, s, { steps, cantRestart, busy, idle }) {
  if (s.step) setStatus(status, steps[s.step] || 'Working…');
  else if (s.error) setStatus(status, s.error, true);
  else if (s.checkError) setStatus(status, s.checkError, true);
  else if (s.available && !s.canRestart) setStatus(status, cantRestart, true);
  else if (s.available && s.busyChats) setStatus(status, busy);
  else setStatus(status, idle);
}

// While an update runs: poll every 2 s while Settings is open, or show the restart screen
// once it's restarting. boot: the server's boot ID when the update started.
function follower(load) {
  let timer = null;
  return (s, restartMessage, boot) => {
    clearTimeout(timer);
    if (s.step === 'restarting') showRestarting(restartMessage, boot);
    else if (s.step && dlg.open) timer = setTimeout(load, 2000);
  };
}

// ---- Nova ---------------------------------------------------------------------------

const appForm = $('appForm');
const APP_STEPS = { downloading: 'Downloading the new version from GitHub…', installing: 'Installing its packages in the staging folder…',
  testing: 'Testing the new version. This takes about a minute…', restarting: 'Tests passed. Restarting to install it…' };
let app = null, appBoot = null;
const followApp = follower(() => loadApp());

// What the last check found, in words. A copy with work GitHub doesn't have is never updated.
function appRelation(s) {
  const l = s.local || {};
  switch (s.relation) {
    case 'current': return 'Nova is up to date.';
    case 'behind': return s.behind ? `GitHub has ${count(s.behind, 'new commit')}.` : `GitHub has a newer version (${s.remote?.version}).`;
    case 'ahead': return s.ahead ? `This copy is ${count(s.ahead, 'commit')} ahead of GitHub, so there's nothing to update.`
      : 'This copy has commits GitHub doesn\'t have yet, so there\'s nothing to update.';
    case 'modified': return `This copy has ${count(l.changes, 'changed file')} not committed yet, so it won't update from GitHub. Commit and push them, or discard them.`;
    case 'diverged': return `This copy and GitHub have both moved on (${s.ahead} ahead, ${s.behind} behind), so Nova won't update it. Update it with git.`;
    case 'unknown': return `This copy doesn't know which commit it is, and GitHub's version (${s.remote?.version || 'unknown'}) isn't newer than ${l.version}, so there's nothing to update.`;
    case 'stale': return 'This copy changed since the last check. Check again.';
    default: return s.checkedAt ? '' : 'Not checked yet.';
  }
}

function renderApp(s) {
  app = s;
  appForm.hidden = !s.enabled;
  if (!s.enabled) return;
  $('appRepoLink').href = `https://github.com/${s.repo}`;
  $('appRepoLink').textContent = `github.com/${s.repo}`;
  const l = s.local || {}, r = s.remote;
  $('appLocal').textContent = [l.version, l.commit ? sha7(l.commit) : 'commit unknown', l.mode === 'git' ? 'git checkout' : null].filter(Boolean).join(' · ');
  $('appRemote').textContent = r ? `${r.version || 'unknown'} · ${sha7(r.commit)}${r.date ? ` · ${when(Date.parse(r.date))}` : ''}${r.message ? `: ${r.message}` : ''}`
    : s.checkError ? 'Couldn\'t check' : 'Not checked yet';
  const last = s.last;
  $('appLast').textContent = !last ? ''
    : last.ok ? `Last update: ${last.fromVersion} (${sha7(last.from) || 'commit unknown'}) to ${last.version} (${sha7(last.commit)}) by ${last.by}, ${when(last.at)}.`
    : `The last update, to ${last.version} (${sha7(last.commit)}) on ${when(last.at)}, didn't go through, so Nova stayed on ${last.fromVersion}. ${last.error || ''}` +
      (last.restoreError ? ` Putting it back also failed: ${last.restoreError}` : '');
  const update = $('appUpdate');
  update.hidden = !s.available;
  update.textContent = s.available ? `Update to ${r.version} (${sha7(r.commit)}) and restart` : 'Update and restart';
  update.disabled = !!s.step || !s.canRestart;
  $('appCheck').disabled = !!s.step;
  showState(appForm.querySelector('.form-status'), s, { steps: APP_STEPS,
    cantRestart: 'Nova wasn\'t started with npm start or its service, so it can\'t restart itself to update. Update it by hand as the README describes.',
    busy: `${appRelation(s)} ${busyText(s.busyChats)}`, idle: appRelation(s) });
  followApp(s, `Installing Nova ${r?.version || ''}. This page reloads by itself when Nova is back.`, appBoot);
}

async function loadApp() {
  try { renderApp(await api('GET', '/api/settings/app')); }
  catch (err) { setStatus(appForm.querySelector('.form-status'), err.message, true); }
}

appForm.addEventListener('submit', async (e) => {
  e.preventDefault();
  if (!app?.available) return;
  const l = app.local, r = app.remote;
  if (!(await confirmDialog({ title: `Update Nova to ${r.version}?`, confirm: 'Update and restart',
    message: `From ${l.version} (${sha7(l.commit) || 'commit unknown'}) to ${r.version} (${sha7(r.commit)}): ${r.message}\n\nNova tests the new version first, then restarts, which closes open chats.` }))) return;
  run(appForm, async () => {
    const res = await api('POST', '/api/settings/app/update', { commit: r.commit });
    appBoot = res.boot;
    renderApp(res);
    return '';
  });
});
$('appCheck').addEventListener('click', () => run(appForm, async () => { renderApp(await api('POST', '/api/settings/app/check')); return ''; }));

// ---- Agent SDK ------------------------------------------------------------------------

const sdkForm = $('sdkForm'), sdkCheckForm = $('sdkCheckForm');
const SDK_STEPS = { installing: 'Downloading the new version into a staging folder…', testing: 'Testing the new version…',
  restarting: 'Test passed. Restarting to install it…' };
let sdk = null, sdkBoot = null;
const followSdk = follower(() => loadSdk());

function renderSdk(s) {
  sdk = s;
  $('sdkInstalled').textContent = s.installed || 'Not found';
  $('sdkLatest').textContent = s.checkError ? 'Couldn\'t check'
    : s.latest ? `${s.latest}${s.checkedAt ? ` (checked ${when(s.checkedAt)})` : ''}` : 'Not checked yet';
  const l = s.last;
  $('sdkLast').textContent = !l ? ''
    : l.ok ? `Last update: ${l.from} to ${l.version} by ${l.by}, ${when(l.at)}.`
    : `The last update, to ${l.version} on ${when(l.at)}, failed while installing, so Nova went back to ${l.from}. ${l.error}` +
      (l.restoreError ? ` Putting ${l.from} back also failed: run npm install in the Nova folder, then restart it.` : '');
  const update = $('sdkUpdate');
  update.hidden = !s.available;
  update.textContent = s.available ? `Update to ${s.latest} and restart` : 'Update and restart';
  update.disabled = !!s.step || !s.canRestart;
  $('sdkCheck').disabled = !!s.step;
  showState(sdkForm.querySelector('.form-status'), s, { steps: SDK_STEPS,
    cantRestart: 'Nova wasn\'t started with npm start, so it can\'t restart itself to update. Update by hand as the README describes.',
    busy: busyText(s.busyChats), idle: s.latest && !s.available ? 'Nova is on the latest version.' : '' });
  if (document.activeElement !== sdkCheckForm.checkHours) sdkCheckForm.checkHours.value = s.checkHours;
  followSdk(s, `Installing the Claude Agent SDK ${s.latest || ''}. This page reloads by itself when Nova is back.`, sdkBoot);
}

async function loadSdk() {
  try { renderSdk(await api('GET', '/api/settings/sdk')); }
  catch (err) { setStatus(sdkForm.querySelector('.form-status'), err.message, true); }
}

sdkForm.addEventListener('submit', async (e) => {
  e.preventDefault();
  if (!sdk?.available) return;
  if (!(await confirmDialog({ title: `Update the Claude Agent SDK to ${sdk.latest}?`, confirm: 'Update and restart',
    message: `Nova is on ${sdk.installed}. It tests the new version first, then restarts, which closes open chats.` }))) return;
  run(sdkForm, async () => {
    const r = await api('POST', '/api/settings/sdk/update', { version: sdk.latest });
    sdkBoot = r.boot;
    renderSdk(r);
    return '';
  });
});
$('sdkCheck').addEventListener('click', () => run(sdkForm, async () => { renderSdk(await api('POST', '/api/settings/sdk/check')); return ''; }));

// How often both check; saved with its own button.
sdkCheckForm.addEventListener('submit', (e) => {
  e.preventDefault();
  run(sdkCheckForm, async () => {
    renderSdk(await api('POST', '/api/settings/sdk', { checkHours: Number(sdkCheckForm.checkHours.value) }));
    return sdk.checkHours ? `Nova checks every ${sdk.checkHours} ${sdk.checkHours === 1 ? 'hour' : 'hours'}.` : 'Automatic checks are off.';
  });
});
