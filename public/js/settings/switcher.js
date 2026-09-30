// The profile switcher (the profile button in the sidebar). Two steps: pick a profile's
// circle, then give its password, or its PIN in four boxes that move along as you type and
// try the switch once all four are filled. Also Sign out.
import { $, h } from '../lib/dom.js';
import { api } from '../lib/api.js';
import { profileCircle, fillCircle } from '../lib/widgets.js';
import { state } from '../state.js';
import { setStatus, isAdmin } from './forms.js';

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

export async function openSwitcher() {
  target = null;
  $('switchCurrent').textContent = state.me.profile;
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
