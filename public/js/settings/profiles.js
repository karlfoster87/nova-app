// Settings → Profiles (admin): every profile with its role, PIN and chat count, an editor for
// each (name, role, password, PIN, picture, and what a user profile may use), and Add a profile.
import { $, h } from '../lib/dom.js';
import { api } from '../lib/api.js';
import { profileCircle } from '../lib/widgets.js';
import { confirmDialog } from '../lib/dialog.js';
import { state } from '../state.js';
import { refreshMe } from '../shell/profile.js';
import { run, setStatus, isAdmin, roleName, LEVEL_NAMES } from './forms.js';
import { pictureControls } from './picture.js';
import { applyRole, showTab } from './dialog.js';

const rows = $('profileRows');
const listStatus = h('p', { class: 'form-status', role: 'status' });

export async function loadProfiles(message = '') {
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
  const pickers = (state.me.views || []).map((v) => {
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
    if (p.current) await refreshMe();
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
        await refreshMe();
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
