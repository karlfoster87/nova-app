// Settings dialog (your profile, permissions, profiles, Claude, updates) and the profile switcher.
// Admin-only sections are hidden for users, and the server refuses them regardless.
import { h, profileCircle, fillCircle } from '/render.js';
import { confirmDialog } from '/dialog.js';

const $ = (id) => document.getElementById(id);

async function api(method, url, body) {
  const res = await fetch(url, {
    method, headers: body ? { 'Content-Type': 'application/json' } : {}, body: body ? JSON.stringify(body) : undefined
  });
  if (res.status === 401 && url !== '/api/switch') { location.href = '/login'; throw new Error('Signed out.'); }
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(data.error || `Request failed (${res.status}). Try again.`);
  return data;
}

function setStatus(el, text, isError = false) {
  el.textContent = text;
  el.classList.toggle('error', isError);
}

// Runs a form's action with its buttons disabled, and shows the outcome in its status line.
async function run(form, action) {
  const status = form.querySelector('.form-status');
  setStatus(status, '');
  const buttons = [...form.querySelectorAll('button')];
  buttons.forEach((b) => { b.disabled = true; });
  try {
    const message = await action();
    if (message && status.isConnected) setStatus(status, message);
  } catch (err) {
    if (status.isConnected) setStatus(status, err.message, true);
  } finally {
    buttons.forEach((b) => { b.disabled = false; });
  }
}

// Profile pictures are cropped to a centred square and scaled to 256px here, so uploads stay
// small and any photo works; the server still checks what arrives. WebP where the
// browser can make it, PNG otherwise.
async function squarePicture(file) {
  let bmp;
  try { bmp = await createImageBitmap(file); } catch { throw new Error('Nova can\'t read that picture. Use a PNG, JPEG, WebP or GIF.'); }
  const side = Math.min(bmp.width, bmp.height), size = Math.min(256, side);
  const canvas = document.createElement('canvas');
  canvas.width = canvas.height = size;
  canvas.getContext('2d').drawImage(bmp, (bmp.width - side) / 2, (bmp.height - side) / 2, side, side, 0, 0, size, size);
  bmp.close?.();
  const blob = await new Promise((resolve) => canvas.toBlob(resolve, 'image/webp', 0.9));
  if (!blob) throw new Error('Nova couldn\'t prepare that picture. Try another one.');
  return blob;
}

async function uploadPicture(name, file) {
  const blob = await squarePicture(file);
  const res = await fetch(`/api/profiles/${encodeURIComponent(name)}/picture`, { method: 'POST', headers: { 'Content-Type': blob.type }, body: blob });
  if (res.status === 401) { location.href = '/login'; throw new Error('Signed out.'); }
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(data.error || `The picture didn't upload (${res.status}). Try again.`);
  return data.picture;
}

// A profile's circle with Choose a picture and Remove picture. The outcome shows in `form`'s
// status line; `after(stamp)` redraws whatever shows the picture.
function pictureControls(name, stamp, form, after) {
  const file = h('input', { type: 'file', accept: 'image/png,image/jpeg,image/webp,image/gif', hidden: true });
  const choose = h('button', { type: 'button', class: 'text-btn' }, stamp ? 'Change picture' : 'Choose a picture');
  const remove = stamp ? h('button', { type: 'button', class: 'text-btn' }, 'Remove picture') : null;
  choose.addEventListener('click', () => file.click());
  file.addEventListener('change', () => {
    const picked = file.files[0];
    file.value = '';
    if (picked) run(form, async () => after(await uploadPicture(name, picked), 'Picture saved.'));
  });
  remove?.addEventListener('click', () => run(form, async () => {
    await api('DELETE', `/api/profiles/${encodeURIComponent(name)}/picture`);
    return after(null, 'Picture removed.');
  }));
  return h('div', { class: 'picture-row' }, profileCircle(name, stamp), choose, remove, file);
}

const roleName = (role) => (role === 'admin' ? 'Admin' : 'User');
const LEVEL_NAMES = { none: 'No access', read: 'View', edit: 'View and edit' };

// Full-screen notice while the server restarts. Polls /api/health and reloads once a new
// process answers (its boot ID differs from oldBoot); after a minute it offers a manual reload.
export function showRestarting(message = 'Nova is restarting. This page reloads by itself when it\'s back.', oldBoot = null) {
  const dlg = $('restarting');
  if (dlg.open) return;
  for (const d of document.querySelectorAll('dialog[open]')) d.close();
  $('restartText').textContent = message;
  $('restartActions').hidden = true;
  dlg.addEventListener('cancel', (e) => e.preventDefault()); // Esc can't dismiss it
  $('restartReload').onclick = () => location.reload();
  dlg.showModal();

  const started = Date.now();
  let wentDown = false;
  const poll = async () => {
    let up = false, boot = null;
    try {
      const res = await fetch('/api/health', { cache: 'no-store' });
      up = res.ok;
      boot = up ? (await res.json()).boot : null;
    } catch { up = false; }
    if (!up) wentDown = true;
    const restarted = oldBoot ? boot && boot !== oldBoot : wentDown;
    const elapsed = Date.now() - started;
    // Show the notice for at least 3 seconds so it can be read.
    if (up && elapsed >= 3000 && (restarted || elapsed >= 15000)) { location.reload(); return; }
    if (elapsed > 60000) {
      $('restartText').textContent = 'Nova hasn\'t come back after a minute. Check the terminal or service it runs under, then reload.';
      $('restartActions').hidden = false;
      return;
    }
    setTimeout(poll, 1000);
  };
  setTimeout(poll, 1000);
}

/**
 * @param {{ me: () => any, refreshMe: () => Promise<void> }} ctx
 */
export function initSettings(ctx) {
  const dlg = $('settings');
  const isAdmin = () => ctx.me().role === 'admin';

  // ---- Tabs ---------------------------------------------------------------
  function showTab(name) {
    if (!isAdmin() && !['profile', 'permissions'].includes(name)) name = 'profile';
    for (const t of dlg.querySelectorAll('[role=tab]')) t.setAttribute('aria-selected', String(t.dataset.tab === name));
    for (const p of dlg.querySelectorAll('[data-panel]')) p.hidden = p.dataset.panel !== name;
    if (name === 'permissions') loadPermissions();
    if (name === 'profiles') loadProfiles();
    if (name === 'claude') loadClaude();
    if (name === 'updates') { loadApp(); loadUpdates(); }
  }
  function applyRole() {
    for (const el of dlg.querySelectorAll('[data-admin]')) el.hidden = !isAdmin();
  }
  for (const t of dlg.querySelectorAll('[role=tab]')) t.addEventListener('click', () => showTab(t.dataset.tab));
  for (const b of document.querySelectorAll('dialog [data-close]')) b.addEventListener('click', () => b.closest('dialog').close());

  function openSettings(tab = 'profile') {
    applyRole();
    fillProfile();
    showTab(tab);
    if (!dlg.open) dlg.showModal();
  }

  // ---- Your profile -------------------------------------------------------
  const nameForm = $('nameForm'), passwordForm = $('passwordForm'), pinForm = $('pinForm'), prefsForm = $('prefsForm');

  // Preferences save as soon as they change; the server tells this profile's other tabs.
  prefsForm.addEventListener('submit', (e) => e.preventDefault());
  prefsForm.hideWeekends.addEventListener('change', () => {
    const on = prefsForm.hideWeekends.checked;
    run(prefsForm, async () => {
      try { await api('PATCH', `/api/profiles/${ctx.me().profile}`, { prefs: { hideWeekends: on } }); }
      catch (err) { prefsForm.hideWeekends.checked = !on; throw err; }
      await ctx.refreshMe();
      return on ? 'Weekends are hidden on the task board.' : 'Weekends show on the task board.';
    });
  });

  function drawPicture() {
    const me = ctx.me();
    $('pictureBox').replaceChildren(pictureControls(me.profile, me.picture, $('pictureForm'), async (_, message) => {
      await ctx.refreshMe(); // redraws the sidebar picture too
      drawPicture();
      return message;
    }));
  }
  $('pictureForm').addEventListener('submit', (e) => e.preventDefault());

  function fillProfile() {
    const me = ctx.me();
    drawPicture();
    const access = (me.views || []).map((v) => `${v.label}: ${LEVEL_NAMES[me.access?.[v.id] || 'none'].toLowerCase()}`);
    $('profileSummary').textContent = `Role: ${roleName(me.role)}. ${access.length ? `${access.join('. ')}. ` : ''}Notes folder: ${me.contextDir}`;
    nameForm.name.value = me.profile;
    $('pinHelp').textContent = me.hasPin
      ? 'A PIN is set. From any signed-in profile you can switch into this one with it.'
      : 'No PIN set, so switching into this profile asks for its password. Set a PIN to make switching quicker.';
    $('removePin').hidden = !me.hasPin;
    prefsForm.hidden = !me.access?.tasks || me.access.tasks === 'none';
    prefsForm.hideWeekends.checked = !!me.prefs?.hideWeekends;
    passwordForm.reset();
    pinForm.reset();
    for (const s of dlg.querySelectorAll('[data-panel=profile] .form-status')) setStatus(s, '');
  }

  nameForm.addEventListener('submit', (e) => {
    e.preventDefault();
    run(nameForm, async () => {
      const name = nameForm.name.value.trim();
      if (name === ctx.me().profile) return 'That\'s already the name of this profile.';
      await api('PATCH', `/api/profiles/${ctx.me().profile}`, { name });
      location.reload(); // the server also tells other tabs to reload
    });
  });

  passwordForm.addEventListener('submit', (e) => {
    e.preventDefault();
    run(passwordForm, async () => {
      const f = passwordForm;
      if (f.password.value !== f.confirm.value) throw new Error('The new passwords don\'t match.');
      await api('PATCH', `/api/profiles/${ctx.me().profile}`, { currentPassword: f.currentPassword.value, password: f.password.value });
      f.reset();
      return 'Password changed.';
    });
  });

  pinForm.addEventListener('submit', (e) => {
    e.preventDefault();
    run(pinForm, async () => {
      if (!/^\d{4}$/.test(pinForm.pin.value)) throw new Error('Enter a PIN of exactly 4 digits.');
      await api('PATCH', `/api/profiles/${ctx.me().profile}`, { currentPassword: pinForm.currentPassword.value, pin: pinForm.pin.value });
      await ctx.refreshMe();
      fillProfile();
      return 'PIN saved.';
    });
  });

  $('removePin').addEventListener('click', () => {
    run(pinForm, async () => {
      if (!pinForm.currentPassword.value) throw new Error('Enter your current password to remove the PIN.');
      await api('PATCH', `/api/profiles/${ctx.me().profile}`, { currentPassword: pinForm.currentPassword.value, pin: null });
      await ctx.refreshMe();
      fillProfile();
      return 'PIN removed.';
    });
  });

  // ---- Permissions: extra folders and remembered approvals (own profile) ---
  const folderForm = $('folderForm'), folderRows = $('folderRows');
  const approvalRows = $('approvalRows'), approvalStatus = $('approvalBox').querySelector('.form-status');
  const folderStatus = folderForm.querySelector('.form-status');

  function loadPermissions() {
    setStatus(folderStatus, '');
    setStatus(approvalStatus, '');
    api('GET', '/api/folders').then(renderFolders, (err) => setStatus(folderStatus, err.message, true));
    api('GET', '/api/approvals').then(renderApprovals, (err) => setStatus(approvalStatus, err.message, true));
  }

  function renderFolders(list) {
    folderRows.replaceChildren(...(list.length ? list.map((f) => {
      const remove = h('button', { type: 'button', class: 'text-btn' }, 'Remove');
      remove.addEventListener('click', async () => {
        if (!(await confirmDialog({ title: 'Remove this folder?', message: `Claude will no longer be able to use ${f.path} in your chats.`,
          confirm: 'Remove folder', danger: true }))) return;
        try { renderFolders(await api('DELETE', '/api/folders', { path: f.path })); setStatus(folderStatus, `Removed ${f.path}.`); }
        catch (err) { setStatus(folderStatus, err.message, true); }
      });
      return h('div', { class: 'profile-row' }, h('div', { class: 'profile-main' }, h('code', {}, f.path)), remove);
    }) : [h('p', { class: 'muted' }, 'No extra folders. Chats can use the brain folder and your notes folder.')]));
  }

  folderForm.addEventListener('submit', (e) => {
    e.preventDefault();
    run(folderForm, async () => {
      const path = folderForm.path.value.trim();
      if (!(await confirmDialog({ title: 'Let Claude use this folder in all your chats?', confirm: 'Add folder',
        message: `${path}\n\nClaude can read files there, and change them when you allow it.` }))) return '';
      const r = await api('POST', '/api/folders', { path });
      folderForm.reset();
      renderFolders(r.folders);
      return `Added ${r.path}.`;
    });
  });

  // Rules are often long commands, so shorten them in dialogs and status lines.
  const short = (s, n = 120) => (s.length > n ? `${s.slice(0, n - 1)}…` : s);

  function renderApprovals(list) {
    approvalRows.replaceChildren(...(list.length ? list.map(ruleCard)
      : [h('p', { class: 'muted' }, 'Nothing yet. Use Always allow on a permission prompt to add a rule.')]));
  }

  // One rule: tool name, then the rule itself clamped to a few lines, then its actions.
  function ruleCard(a) {
    const text = h('pre', { class: 'rule-text' }, a.rule || 'Any use of this tool');
    const more = h('button', { type: 'button', class: 'text-btn', hidden: true, 'aria-expanded': 'false' }, 'Show all');
    more.addEventListener('click', () => {
      const open = text.classList.toggle('open');
      more.textContent = open ? 'Show less' : 'Show all';
      more.setAttribute('aria-expanded', String(open));
    });
    requestAnimationFrame(() => { more.hidden = text.scrollHeight <= text.clientHeight + 1; }); // only when clamped

    const remove = h('button', { type: 'button', class: 'text-btn' }, 'Remove');
    remove.addEventListener('click', async () => {
      try { renderApprovals(await api('DELETE', '/api/approvals', { tool: a.tool, rule: a.rule })); setStatus(approvalStatus, `Removed ${short(a.text)}.`); }
      catch (err) { setStatus(approvalStatus, err.message, true); }
    });
    const share = isAdmin() ? h('button', { type: 'button', class: 'text-btn' }, 'Share with all profiles') : null;
    share?.addEventListener('click', async () => {
      if (!(await confirmDialog({ title: 'Allow this rule for every profile?', confirm: 'Share rule',
        message: `${short(a.text, 300)}\n\nNova adds it to the brain's .claude/settings.local.json and removes it from this list. To undo, remove it from that file.` }))) return;
      try {
        const r = await api('POST', '/api/approvals/share', { tool: a.tool, rule: a.rule });
        renderApprovals(r.approvals);
        setStatus(approvalStatus, `${short(r.text)} is now allowed for every profile, in ${r.file}.`);
      } catch (err) { setStatus(approvalStatus, err.message, true); }
    });
    const added = new Date(a.createdAt).toLocaleDateString(undefined, { dateStyle: 'medium' });
    return h('div', { class: 'rule' },
      h('div', { class: 'rule-head' }, h('strong', {}, a.tool), h('span', { class: 'muted' }, `Added ${added}`)),
      text,
      h('div', { class: 'row' }, more, h('span', { class: 'spacer' }), share, remove));
  }

  // ---- Profiles (admin) ---------------------------------------------------
  const rows = $('profileRows');
  const listStatus = h('p', { class: 'form-status', role: 'status' });

  async function loadProfiles(message = '') {
    let list;
    try { list = await api('GET', '/api/profiles'); } catch (err) { setStatus(listStatus, err.message, true); rows.replaceChildren(listStatus); return; }
    setStatus(listStatus, message);
    rows.replaceChildren(listStatus, ...list.map(profileRow));
  }

  function profileRow(p) {
    const summary = `${roleName(p.role)} · ${p.hasPin ? 'PIN set' : 'No PIN'} · ${p.chatCount} ${p.chatCount === 1 ? 'chat' : 'chats'}`;
    const edit = profileEditor(p);
    const toggle = h('button', { type: 'button', class: 'text-btn', 'aria-expanded': 'false' }, 'Edit');
    toggle.addEventListener('click', () => {
      edit.hidden = !edit.hidden;
      toggle.setAttribute('aria-expanded', String(!edit.hidden));
      toggle.textContent = edit.hidden ? 'Edit' : 'Close';
    });
    return h('div', { class: 'profile-row has-circle' },
      profileCircle(p.name, p.picture),
      h('div', { class: 'profile-main' },
        h('strong', {}, p.name, p.current ? h('span', { class: 'badge' }, 'You') : null),
        h('span', { class: 'muted' }, summary)),
      toggle, edit);
  }

  function profileEditor(p) {
    const name = h('input', { name: 'name', value: p.name, autocomplete: 'off', autocapitalize: 'none', required: true, pattern: '[A-Za-z0-9\\-]{2,32}' });
    const role = h('select', { name: 'role' }, h('option', { value: 'user' }, 'User'), h('option', { value: 'admin' }, 'Admin'));
    role.value = p.role;
    const password = p.current ? null : h('input', { name: 'password', type: 'password', autocomplete: 'new-password', minlength: '12', placeholder: 'Leave blank to keep' });
    const pin = p.current ? null : h('input', { name: 'pin', type: 'password', inputmode: 'numeric', autocomplete: 'off', pattern: '\\d{4}', maxlength: '4', placeholder: p.hasPin ? 'Leave blank to keep' : '4 digits' });
    const clearPin = !p.current && p.hasPin ? h('input', { type: 'checkbox', name: 'clearPin' }) : null;
    // One access picker per view. Admins always have full access, so the pickers only
    // apply while the role is User.
    const views = ctx.me().views || [];
    const pickers = views.map((v) => {
      const s = h('select', { name: `access-${v.id}` }, ...Object.entries(LEVEL_NAMES).map(([value, label]) => h('option', { value }, label)));
      s.value = p.access?.[v.id] || 'none';
      return { view: v, select: s, initial: s.value };
    });
    const accessNote = h('p', { class: 'muted' });
    const syncAccess = () => {
      const admin = role.value === 'admin';
      for (const { select } of pickers) select.disabled = admin;
      accessNote.textContent = admin ? 'Admins can use every view in full.' : '';
    };
    role.addEventListener('change', syncAccess);
    syncAccess();

    const form = h('form', { class: 'stack profile-edit', hidden: true },
      h('div', { class: 'grid-2' },
        h('label', {}, 'Name ', name),
        h('label', {}, 'Role ', role),
        password ? h('label', {}, 'New password ', password) : null,
        pin ? h('label', {}, 'New PIN ', pin) : null,
        pickers.map(({ view, select }) => h('label', {}, `${view.label} `, select))),
      pickers.length ? accessNote : null,
      clearPin ? h('label', { class: 'check' }, clearPin, ' Remove this profile\'s PIN') : null,
      p.current ? h('p', { class: 'muted' }, 'Change your own password and PIN under Your profile.') : null,
      h('div', { class: 'row' },
        h('button', { type: 'submit', class: 'send-btn' }, 'Save changes'),
        p.current ? null : h('button', { type: 'button', class: 'stop-btn', onclick: () => remove(p, form) }, 'Remove profile')),
      h('p', { class: 'form-status', role: 'status' }));
    // The picture saves straight away, apart from Save changes.
    form.prepend(pictureControls(p.name, p.picture, form, async (_, message) => {
      if (p.current) await ctx.refreshMe();
      await loadProfiles(message.replace(/\.$/, ` for "${p.name}".`));
      return '';
    }));

    form.addEventListener('submit', (e) => {
      e.preventDefault();
      run(form, async () => {
        const body = {};
        const newName = name.value.trim();
        if (newName !== p.name) body.name = newName;
        if (role.value !== p.role) body.role = role.value;
        if (password?.value) body.password = password.value;
        if (clearPin?.checked) body.pin = null;
        else if (pin?.value) body.pin = pin.value;
        const access = Object.fromEntries(pickers.filter((x) => !x.select.disabled && x.select.value !== x.initial).map((x) => [x.view.id, x.select.value]));
        if (Object.keys(access).length) body.access = access;
        if (!Object.keys(body).length) return 'Nothing to change.';
        if (body.role === 'user' && p.current && !(await confirmDialog({ title: 'Remove admin from your own profile?', danger: true,
          message: 'You\'ll lose access to profiles and global settings. Another admin would have to give it back.', confirm: 'Remove my admin role' }))) return '';
        await api('PATCH', `/api/profiles/${p.name}`, body);
        if (p.current && body.name) { location.reload(); return ''; }
        if (p.current) {
          await ctx.refreshMe();
          applyRole();
          if (!isAdmin()) { showTab('profile'); return ''; }
        }
        await loadProfiles(`Saved changes to "${body.name || p.name}".`);
        return '';
      });
    });
    return form;
  }

  async function remove(p, form) {
    const ok = await confirmDialog({ title: `Remove the "${p.name}" profile?`, danger: true, confirm: 'Remove profile',
      message: 'Its sign-ins, chat list, tasks and notes are removed. Chat transcripts and its notes folder stay on disk.' });
    if (!ok) return;
    run(form, async () => {
      await api('DELETE', `/api/profiles/${p.name}`);
      await loadProfiles(`Removed "${p.name}".`);
      return '';
    });
  }

  const addForm = $('addProfileForm');
  addForm.addEventListener('submit', (e) => {
    e.preventDefault();
    run(addForm, async () => {
      const f = addForm;
      const body = { name: f.name.value.trim(), role: f.role.value, password: f.password.value };
      if (f.pin.value) body.pin = f.pin.value;
      const r = await api('POST', '/api/profiles', body);
      f.reset();
      await loadProfiles();
      return `Added "${r.name}". Its notes folder is ready.`;
    });
  });

  // ---- Claude (admin) -----------------------------------------------------
  const claudeForm = $('settingsForm');
  const brainForm = $('brainForm');

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

  // Claude sign-in: the server runs Claude Code's own login and relays its link
  // and the code pasted here. Nothing secret comes back to the page.
  const signinForm = $('signinForm');
  let lastMeta = {}; // the latest account state from the server, redrawn around a sign-in
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

  async function loadClaude() {
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
    if (!s.canRestart) {
      setStatus(brainForm.querySelector('.form-status'),
        'Nova wasn\'t started with npm start, so it can\'t restart itself. Change paths.brainDir in data/config.json instead.', true);
    } else setStatus(brainForm.querySelector('.form-status'), '');
    $('modelToggles').replaceChildren(...(s.allModels || []).map((m) => {
      const box = h('input', { type: 'checkbox', name: 'model', value: m.value });
      box.checked = !s.hiddenModels.includes(m.value);
      return h('label', {}, box, h('span', {}, m.displayName || m.value), h('small', {}, m.description || ''));
    }));
  }

  claudeForm.addEventListener('submit', (e) => {
    e.preventDefault();
    run(claudeForm, async () => {
      const f = claudeForm;
      const all = [...f.querySelectorAll('input[name=model]')];
      const body = {
        defaultEffort: f.defaultEffort.value,
        idleMinutes: Number(f.idleMinutes.value),
        showThinking: f.showThinking.checked,
        hiddenModels: all.filter((i) => !i.checked).map((i) => i.value)
      };
      await api('POST', '/api/settings', body);
      await loadClaude();
      return 'Settings saved.';
    });
  });

  // ---- Updates (admin) ----------------------------------------------------
  const sdkForm = $('sdkForm'), sdkCheckForm = $('sdkCheckForm');
  const STEPS = { installing: 'Downloading the new version into a staging folder…', testing: 'Testing the new version…',
    restarting: 'Test passed. Restarting to install it…' };
  let sdk = null, sdkPoll = null, sdkBoot = null;
  const when = (ms) => new Date(ms).toLocaleString(undefined, { dateStyle: 'medium', timeStyle: 'short' });

  // Nova's own updates from GitHub. Same flow as the SDK below.
  const appForm = $('appForm');
  const APP_STEPS = { downloading: 'Downloading the new version from GitHub…', installing: 'Installing its packages in the staging folder…',
    testing: 'Testing the new version. This takes about a minute…', restarting: 'Tests passed. Restarting to install it…' };
  let app = null, appPoll = null, appBoot = null;
  const sha7 = (sha) => (sha ? sha.slice(0, 7) : '');
  const count = (n, one) => `${n} ${n === 1 ? one : `${one}s`}`;

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
    const status = appForm.querySelector('.form-status');
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
    if (s.step) setStatus(status, APP_STEPS[s.step] || 'Working…');
    else if (s.error) setStatus(status, s.error, true);
    else if (s.checkError) setStatus(status, s.checkError, true);
    else if (s.available && !s.canRestart) setStatus(status, 'Nova wasn\'t started with npm start or its service, so it can\'t restart itself to update. Update it by hand as the README describes.', true);
    else if (s.available && s.busyChats) setStatus(status, `${appRelation(s)} ${s.busyChats === 1 ? 'A chat is' : `${s.busyChats} chats are`} working or waiting for an answer. Updating waits until they're finished.`);
    else setStatus(status, appRelation(s));
    clearTimeout(appPoll);
    if (s.step === 'restarting') showRestarting(`Installing Nova ${r?.version || ''}. This page reloads by itself when Nova is back.`, appBoot);
    else if (s.step && dlg.open) appPoll = setTimeout(() => loadApp(), 2000);
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

  $('appCheck').addEventListener('click', () => {
    run(appForm, async () => { renderApp(await api('POST', '/api/settings/app/check')); return ''; });
  });

  function renderSdk(s) {
    sdk = s;
    const status = sdkForm.querySelector('.form-status');
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
    if (s.step) setStatus(status, STEPS[s.step] || 'Working…');
    else if (s.error) setStatus(status, s.error, true);
    else if (s.checkError) setStatus(status, s.checkError, true);
    else if (!s.canRestart && s.available) setStatus(status, 'Nova wasn\'t started with npm start, so it can\'t restart itself to update. Update by hand as the README describes.', true);
    else if (s.available && s.busyChats) setStatus(status, `${s.busyChats === 1 ? 'A chat is' : `${s.busyChats} chats are`} working or waiting for an answer. Updating waits until they're finished.`);
    else setStatus(status, s.latest && !s.available ? 'Nova is on the latest version.' : '');
    if (document.activeElement !== sdkCheckForm.checkHours) sdkCheckForm.checkHours.value = s.checkHours;

    clearTimeout(sdkPoll);
    if (s.step === 'restarting') showRestarting(`Installing the Claude Agent SDK ${s.latest || ''}. This page reloads by itself when Nova is back.`, sdkBoot);
    else if (s.step && dlg.open) sdkPoll = setTimeout(() => loadUpdates(), 2000);
  }

  async function loadUpdates() {
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

  $('sdkCheck').addEventListener('click', () => {
    run(sdkForm, async () => { renderSdk(await api('POST', '/api/settings/sdk/check')); return ''; });
  });

  sdkCheckForm.addEventListener('submit', (e) => {
    e.preventDefault();
    run(sdkCheckForm, async () => {
      renderSdk(await api('POST', '/api/settings/sdk', { checkHours: Number(sdkCheckForm.checkHours.value) }));
      return sdk.checkHours ? `Nova checks every ${sdk.checkHours} ${sdk.checkHours === 1 ? 'hour' : 'hours'}.` : 'Automatic checks are off.';
    });
  });

  // ---- Profile switcher ---------------------------------------------------
  // Two steps: pick a profile's circle, then give its password, or its PIN in
  // four boxes that move along as you type and try the switch once all four are filled.
  const sw = $('switcher'), swForm = $('switchForm'), secret = $('switchSecret'), swError = $('switchError');
  const pinBoxes = [...$('switchPin').querySelectorAll('input')];
  let target = null, targetButton = null, switching = false;

  function showStep(auth) {
    $('switchList').hidden = auth;
    $('switchPickActions').hidden = auth;
    $('switchAuth').hidden = !auth;
    $('switchAuthActions').hidden = !auth;
    setStatus(swError, '', true);
  }

  async function openSwitcher() {
    target = null;
    $('switchCurrent').textContent = ctx.me().profile;
    showStep(false);
    $('switchList').replaceChildren();
    sw.showModal();
    let list;
    try { list = await api('GET', '/api/profiles'); } catch (err) { setStatus(swError, err.message, true); return; }
    const others = list.filter((p) => !p.current);
    $('switchList').replaceChildren(...(others.length ? others.map((p) => {
      const b = h('button', { type: 'button', class: 'profile-pick', 'aria-label': `Switch to ${p.name}`, title: p.name }, // long names are cut short
        profileCircle(p.name, p.picture), h('span', { class: 'profile-pick-name' }, p.name));
      b.addEventListener('click', () => choose(p, b));
      return h('li', {}, b);
    }) : [h('li', { class: 'muted' }, isAdmin() ? 'No other profiles yet. Add one in Settings, Profiles.' : 'No other profiles yet. An admin can add one.')]));
    $('switchList').querySelector('button')?.focus();
  }

  function choose(p, button) {
    target = p;
    targetButton = button;
    fillCircle($('switchCircle'), p.name, p.picture);
    $('switchName').textContent = p.name;
    $('switchPassword').hidden = p.hasPin;
    $('switchPin').hidden = !p.hasPin;
    $('switchGo').hidden = p.hasPin; // a PIN goes as soon as its fourth digit is in
    secret.value = '';
    for (const b of pinBoxes) b.value = '';
    showStep(true);
    (p.hasPin ? pinBoxes[0] : secret).focus();
  }

  $('switchBack').addEventListener('click', () => {
    target = null;
    showStep(false);
    targetButton?.focus();
  });

  async function trySwitch(credential) {
    if (!target || switching) return;
    switching = true;
    $('switchGo').disabled = true;
    for (const b of pinBoxes) b.disabled = true;
    try {
      await api('POST', '/api/switch', { name: target.name, ...credential });
      location.href = '/'; // fresh page: new cookie, new socket, new chat list
    } catch (err) {
      switching = false;
      $('switchGo').disabled = false;
      for (const b of pinBoxes) b.disabled = false;
      setStatus(swError, err.message, true);
      if (!target?.hasPin) secret.select();
      else { for (const b of pinBoxes) b.value = ''; pinBoxes[0].focus(); }
    }
  }

  swForm.addEventListener('submit', (e) => {
    e.preventDefault();
    if (!target) return;
    if (target.hasPin) {
      const pin = pinBoxes.map((b) => b.value).join('');
      if (/^\d{4}$/.test(pin)) trySwitch({ pin });
      return;
    }
    if (!secret.value) { setStatus(swError, `Enter the password for ${target.name}.`, true); secret.focus(); return; }
    trySwitch({ password: secret.value });
  });

  // Each box keeps one digit: typing replaces it and moves on. Several digits at once (a
  // paste, or a keyboard's suggestion) fill the boxes from this one.
  pinBoxes.forEach((box, i) => {
    box.addEventListener('focus', () => box.select());
    box.addEventListener('input', (e) => {
      const digits = box.value.replace(/\D/g, '');
      const many = e.inputType === 'insertFromPaste' || e.inputType === 'insertReplacementText' || e.inputType === undefined;
      box.value = '';
      if (!digits) return;
      [...(many ? digits : digits.slice(-1))].slice(0, pinBoxes.length - i).forEach((d, k) => { pinBoxes[i + k].value = d; });
      setStatus(swError, '', true);
      const next = pinBoxes.slice(i + 1).find((b) => !b.value) || pinBoxes.find((b) => !b.value);
      if (next) next.focus();
      else swForm.requestSubmit();
    });
    box.addEventListener('keydown', (e) => {
      if (e.key === 'Backspace' && !box.value && i > 0) { e.preventDefault(); pinBoxes[i - 1].value = ''; pinBoxes[i - 1].focus(); }
      else if (e.key === 'ArrowLeft' && i > 0) { e.preventDefault(); pinBoxes[i - 1].focus(); }
      else if (e.key === 'ArrowRight' && i < pinBoxes.length - 1) { e.preventDefault(); pinBoxes[i + 1].focus(); }
    });
  });

  $('switchSignOut').addEventListener('click', async () => {
    await fetch('/api/logout', { method: 'POST' });
    location.href = '/login';
  });

  return { openSettings, openSwitcher, applyRole };
}
