// Settings → Your profile: picture, name, password, PIN and personal preferences. (The theme
// and notifications on the same tab belong to this browser: shell/theme.js and shell/pwa.js.)
import { $ } from '../lib/dom.js';
import { api } from '../lib/api.js';
import { state } from '../state.js';
import { refreshMe } from '../shell/profile.js';
import { run, setStatus, roleName, LEVEL_NAMES } from './forms.js';
import { pictureControls } from './picture.js';

const nameForm = $('nameForm'), passwordForm = $('passwordForm'), pinForm = $('pinForm'), prefsForm = $('prefsForm');
const me = () => state.me;
const saveMe = (body) => api('PATCH', `/api/profiles/${me().profile}`, body);

// Fills the tab from the latest profile, clearing any typed secrets and old messages.
export function fillProfile() {
  drawPicture();
  const access = (me().views || []).map((v) => `${v.label}: ${LEVEL_NAMES[me().access?.[v.id] || 'none'].toLowerCase()}`);
  $('profileSummary').textContent = `Role: ${roleName(me().role)}. ${access.length ? `${access.join('. ')}. ` : ''}Notes folder: ${me().contextDir}`;
  nameForm.name.value = me().profile;
  $('pinHelp').textContent = me().hasPin
    ? 'A PIN is set. From any signed-in profile you can switch into this one with it.'
    : 'No PIN set, so switching into this profile asks for its password. Set a PIN to make switching quicker.';
  $('removePin').hidden = !me().hasPin;
  prefsForm.hidden = !me().access?.tasks || me().access.tasks === 'none';
  prefsForm.hideWeekends.checked = !!me().prefs?.hideWeekends;
  passwordForm.reset();
  pinForm.reset();
  for (const s of document.querySelectorAll('[data-panel=profile] .form-status')) setStatus(s, '');
}

function drawPicture() {
  $('pictureBox').replaceChildren(pictureControls(me().profile, me().picture, $('pictureForm'), async (_, message) => {
    await refreshMe(); // redraws the sidebar picture too
    drawPicture();
    return message;
  }));
}
$('pictureForm').addEventListener('submit', (e) => e.preventDefault());

// Preferences save as soon as they change; the server tells this profile's other tabs.
prefsForm.addEventListener('submit', (e) => e.preventDefault());
prefsForm.hideWeekends.addEventListener('change', () => {
  const on = prefsForm.hideWeekends.checked;
  run(prefsForm, async () => {
    try { await saveMe({ prefs: { hideWeekends: on } }); }
    catch (err) { prefsForm.hideWeekends.checked = !on; throw err; }
    await refreshMe();
    return on ? 'Weekends are hidden on the task board.' : 'Weekends show on the task board.';
  });
});

nameForm.addEventListener('submit', (e) => {
  e.preventDefault();
  run(nameForm, async () => {
    const name = nameForm.name.value.trim();
    if (name === me().profile) return 'That\'s already the name of this profile.';
    await saveMe({ name });
    location.reload(); // the server also tells other tabs to reload
  });
});

passwordForm.addEventListener('submit', (e) => {
  e.preventDefault();
  run(passwordForm, async () => {
    const f = passwordForm;
    if (f.password.value !== f.confirm.value) throw new Error('The new passwords don\'t match.');
    await saveMe({ currentPassword: f.currentPassword.value, password: f.password.value });
    f.reset();
    return 'Password changed.';
  });
});

pinForm.addEventListener('submit', (e) => {
  e.preventDefault();
  run(pinForm, async () => {
    if (!/^\d{4}$/.test(pinForm.pin.value)) throw new Error('Enter a PIN of exactly 4 digits.');
    await saveMe({ currentPassword: pinForm.currentPassword.value, pin: pinForm.pin.value });
    await refreshMe();
    fillProfile();
    return 'PIN saved.';
  });
});

$('removePin').addEventListener('click', () => {
  run(pinForm, async () => {
    if (!pinForm.currentPassword.value) throw new Error('Enter your current password to remove the PIN.');
    await saveMe({ currentPassword: pinForm.currentPassword.value, pin: null });
    await refreshMe();
    fillProfile();
    return 'PIN removed.';
  });
});
