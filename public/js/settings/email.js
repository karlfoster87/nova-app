// Settings → Email (admins): the provider, from a list that has only Outlook on this computer (COM)
// so far, and whether email is on. Saving with it on reads the mailbox once, so the status line says
// straight away whether Outlook answered; Check connection reads it again.
import { $, h } from '../lib/dom.js';
import { api } from '../lib/api.js';
import { run, setStatus } from './forms.js';

const form = $('emailForm'), select = $('emailProvider'), note = $('emailProviderNote');
const status = form.querySelector('.form-status');
let providers = [];

const when = (ms) => new Date(ms).toLocaleTimeString('en-GB', { hour: '2-digit', minute: '2-digit' });
function statusText(s) {
  if (!s.enabled) return 'Email is off.';
  const st = s.status;
  if (!st) return '';
  if (st.error) return `Couldn't read your mail: ${st.error}`;
  if (!st.at) return 'On. Not read yet.';
  return `Connected at ${when(st.at)}: ${st.total} in the inbox (${st.unread} unread), ${st.todo} flagged or to do.`;
}

function fill(s) {
  providers = s.providers;
  select.replaceChildren(...providers.map((p) => h('option', { value: p.id, selected: p.id === s.provider }, p.label)));
  form.enabled.checked = s.enabled;
  showNote();
  setStatus(status, statusText(s), !!s.status?.error);
}

function showNote() {
  const p = providers.find((x) => x.id === select.value);
  note.textContent = p?.available === false ? p.unavailable
    : 'Reads classic Outlook while it\'s open on this computer: no sign-in, and listing mail uses none of your plan. The new Outlook app isn\'t supported.';
}
select.addEventListener('change', showNote);

export function loadEmail() {
  setStatus(status, '');
  api('GET', '/api/settings/email').then(fill, (err) => setStatus(status, err.message, true));
}

form.addEventListener('submit', (e) => {
  e.preventDefault();
  run(form, async () => {
    if (form.enabled.checked) setStatus(status, 'Reading Outlook…');
    const s = await api('POST', '/api/settings/email', { provider: select.value, enabled: form.enabled.checked });
    fill(s);
    return s.status?.error ? '' : `Saved. ${statusText(s)}`;
  });
});

$('emailCheck').addEventListener('click', () => run(form, async () => {
  if (!form.enabled.checked) throw new Error('Turn email on and save first.');
  setStatus(status, 'Reading Outlook…');
  try { await api('POST', '/api/email/refresh'); } catch (err) { setStatus(status, err.message, true); return ''; }
  fill(await api('GET', '/api/settings/email'));
  return '';
}));
