// Settings → Claude (admin): signing Nova in to Claude, models and chat defaults, and the brain
// folder. Sign-in runs Claude Code's own login on the server, which relays its link and the
// code pasted here; nothing secret comes back to the page.
import { $, h } from '../lib/dom.js';
import { api } from '../lib/api.js';
import { confirmDialog } from '../lib/dialog.js';
import { showRestarting } from '../shell/restart.js';
import { run, setStatus } from './forms.js';

const claudeForm = $('settingsForm'), brainForm = $('brainForm'), signinForm = $('signinForm');
let lastMeta = {}; // the latest account state from the server, redrawn around a sign-in

export async function loadClaude() {
  const status = claudeForm.querySelector('.form-status');
  let s;
  try { s = await api('GET', '/api/settings'); } catch (err) { setStatus(status, err.message, true); return; }
  setStatus(status, '');
  lastMeta = s;
  renderSignin(s);
  claudeForm.defaultEffort.value = s.defaultEffort;
  claudeForm.idleMinutes.value = s.idleMinutes;
  claudeForm.showThinking.checked = s.showThinking !== false;
  brainForm.brainDir.value = s.brainDir;
  brainForm.querySelector('button').disabled = !s.canRestart;
  setStatus(brainForm.querySelector('.form-status'), s.canRestart ? ''
    : 'Nova wasn\'t started with npm start, so it can\'t restart itself. Change paths.brainDir in data/config.json instead.', !s.canRestart);
  $('modelToggles').replaceChildren(...(s.allModels || []).map((m) => {
    const box = h('input', { type: 'checkbox', name: 'model', value: m.value });
    box.checked = !s.hiddenModels.includes(m.value);
    return h('label', {}, box, h('span', {}, m.displayName || m.value), h('small', {}, m.description || ''));
  }));
}

// ---- Sign-in ----------------------------------------------------------------------

function renderSignin(s) {
  const a = s.account;
  $('accountLine').textContent = s.signedIn
    ? `Signed in as ${a.email || 'an Anthropic Console account'}${a.subscriptionType ? ` (${a.subscriptionType})` : ''}`
    : s.signedIn === false ? 'Not signed in. Chats can\'t reach Claude until an admin signs in.'
    : s.authError ? `Couldn't check the sign-in: ${s.authError}` : 'Checking sign-in…';
  const waiting = !!s.signin;
  $('signinStart').hidden = waiting;
  $('signinSteps').hidden = !waiting;
  $('signOut').hidden = !s.signedIn;
  signinForm.querySelector('[data-method=claudeai]').textContent = s.signedIn ? 'Sign in again with Claude' : 'Sign in with Claude';
  if (waiting) $('signinLink').href = s.signin.url;
  signinForm.code.value = '';
}

signinForm.addEventListener('click', (e) => {
  const method = e.target.closest('button[data-method]')?.dataset.method;
  if (!method) return;
  run(signinForm, async () => {
    const r = await api('POST', '/api/settings/signin', { method });
    renderSignin({ ...lastMeta, signin: r });
    signinForm.code.focus();
    return 'Waiting for the code from the sign-in page.';
  });
});
signinForm.addEventListener('submit', (e) => {
  e.preventDefault();
  run(signinForm, async () => {
    const m = await api('POST', '/api/settings/signin/code', { code: signinForm.code.value });
    lastMeta = m;
    renderSignin({ ...m, signin: null });
    return m.signedIn ? 'Signed in. Open chats switch over once they finish what they\'re doing.' : 'Claude Code accepted the code, but Nova still can\'t see a sign-in. Reopen Settings in a moment.';
  });
});
$('signinCancel').addEventListener('click', () => {
  run(signinForm, async () => {
    await api('DELETE', '/api/settings/signin');
    renderSignin({ ...lastMeta, signin: null });
    return 'Sign-in cancelled.';
  });
});
$('signOut').addEventListener('click', async () => {
  if (!(await confirmDialog({ title: 'Sign Nova out of Claude?', confirm: 'Sign out', danger: true,
    message: 'Chats can\'t reach Claude until an admin signs in again. Open chats stop once they finish what they\'re doing.' }))) return;
  run(signinForm, async () => {
    const m = await api('POST', '/api/settings/signout');
    lastMeta = m;
    renderSignin({ ...m, signin: null });
    return 'Signed out.';
  });
});

// ---- Models and chats ---------------------------------------------------------------

claudeForm.addEventListener('submit', (e) => {
  e.preventDefault();
  run(claudeForm, async () => {
    const f = claudeForm;
    const all = [...f.querySelectorAll('input[name=model]')];
    await api('POST', '/api/settings', {
      defaultEffort: f.defaultEffort.value,
      idleMinutes: Number(f.idleMinutes.value),
      showThinking: f.showThinking.checked,
      hiddenModels: all.filter((i) => !i.checked).map((i) => i.value)
    });
    await loadClaude();
    return 'Settings saved.';
  });
});

// ---- Brain folder ---------------------------------------------------------------------

brainForm.addEventListener('submit', (e) => {
  e.preventDefault();
  run(brainForm, async () => {
    const brainDir = brainForm.brainDir.value.trim();
    if (!(await confirmDialog({ title: 'Change the brain folder and restart Nova?', confirm: 'Change and restart',
      message: `${brainDir}\n\nOpen chats will close. Chats and categories belong to the folder they were made in.` }))) return '';
    const r = await api('POST', '/api/settings/brain', { brainDir });
    showRestarting('Applying the new brain folder. This page reloads by itself when Nova is back.', r.boot);
    return '';
  });
});
