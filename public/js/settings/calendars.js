// Settings → Calendars: this profile's linked ICS feeds. Add one by its address, then rename it,
// recolour it, show or hide it, give it a new address, fetch it now, or remove it. The server
// never sends a feed's address back (it can hold a secret), only its host and a hint, so changing
// the address means pasting the new one.
import { $, h } from '../lib/dom.js';
import { api } from '../lib/api.js';
import { confirmDialog } from '../lib/dialog.js';
import { COLORS, dot } from '../calendar/colors.js';
import { run, setStatus } from './forms.js';

const form = $('calendarForm'), rows = $('calendarRows');
const listStatus = $('calendarBox').querySelector('.form-status');
const colorOptions = (selected) => COLORS.map(([value, label]) => h('option', { value, selected: value === selected }, label));
$('calendarColor').replaceChildren(...colorOptions('cyan'));

export function loadCalendars() {
  setStatus(listStatus, '');
  api('GET', '/api/calendars').then(render, (err) => setStatus(listStatus, err.message, true));
}

const when = (ms) => new Date(ms).toLocaleString('en-GB', { day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit' });
function stateText(c) {
  if (c.error) return `Couldn't update${c.okAt ? ` since ${when(c.okAt)}` : ''}: ${c.error}`;
  if (c.okAt) return `${c.events ?? 0} ${c.events === 1 ? 'event' : 'events'} · updated ${when(c.okAt)}`;
  return 'Not fetched yet';
}

function render(list) {
  rows.replaceChildren(...(list.length ? list.map(card) : [h('p', { class: 'muted' }, 'No calendars yet. Add one below.')]));
}

function card(c) {
  const shownBox = h('input', { type: 'checkbox', checked: c.shown });
  shownBox.addEventListener('change', () => save({ shown: shownBox.checked }, shownBox.checked ? `${c.name} is shown.` : `${c.name} is hidden.`));
  const edit = h('button', { type: 'button', class: 'text-btn', 'aria-expanded': 'false' }, 'Edit');
  const update = h('button', { type: 'button', class: 'text-btn' }, 'Update');
  const remove = h('button', { type: 'button', class: 'text-btn' }, 'Remove');

  // The edit form: name, colour, and a new address only if one is pasted.
  const name = h('input', { type: 'text', maxlength: 80, value: c.name });
  const color = h('select', {}, ...colorOptions(c.color));
  const url = h('input', { type: 'text', inputmode: 'url', autocomplete: 'off', spellcheck: 'false', placeholder: 'Leave empty to keep the current one' });
  const editForm = h('form', { class: 'stack profile-edit', hidden: true },
    h('div', { class: 'grid-2' }, h('label', {}, 'Name ', name), h('label', {}, 'Colour ', color)),
    h('label', {}, 'New ICS address ', h('span', { class: 'muted' }, `(now ${c.hint})`), url),
    h('div', { class: 'row' }, h('button', { type: 'submit', class: 'send-btn' }, 'Save'), h('button', { type: 'button', class: 'text-btn', onclick: () => toggleEdit(false) }, 'Cancel')),
    h('p', { class: 'form-status', role: 'status' }));
  const toggleEdit = (open) => { editForm.hidden = !open; edit.setAttribute('aria-expanded', String(open)); if (open) name.focus(); };
  edit.addEventListener('click', () => toggleEdit(editForm.hidden));
  editForm.addEventListener('submit', (e) => {
    e.preventDefault();
    run(editForm, async () => {
      const body = { name: name.value, color: color.value };
      if (url.value.trim()) body.url = url.value.trim();
      await api('PATCH', `/api/calendars/${c.id}`, body);
      loadCalendars();
      return '';
    }).then(() => setStatus(listStatus, `Saved ${name.value.trim() || c.name}.`));
  });

  async function save(body, message) {
    try { await api('PATCH', `/api/calendars/${c.id}`, body); setStatus(listStatus, message); loadCalendars(); } catch (err) { setStatus(listStatus, err.message, true); }
  }
  update.addEventListener('click', async () => {
    update.disabled = true;
    setStatus(listStatus, `Updating ${c.name}…`);
    try {
      const list = await api('POST', `/api/calendars/${c.id}/refresh`);
      const now = list.find((x) => x.id === c.id);
      render(list);
      setStatus(listStatus, now?.error ? `Couldn't update ${c.name}: ${now.error}` : `${c.name} is up to date.`, !!now?.error);
    } catch (err) { setStatus(listStatus, err.message, true); update.disabled = false; }
  });
  remove.addEventListener('click', async () => {
    if (!(await confirmDialog({ title: `Remove ${c.name}?`, message: 'It disappears from Home and the calendar page, and Nova can no longer read it. The calendar itself isn\'t changed.',
      confirm: 'Remove calendar', danger: true }))) return;
    try { await api('DELETE', `/api/calendars/${c.id}`); setStatus(listStatus, `Removed ${c.name}.`); loadCalendars(); } catch (err) { setStatus(listStatus, err.message, true); }
  });

  return h('div', { class: `profile-row cal-row${c.error ? ' stale' : ''}` },
    h('div', { class: 'profile-main' },
      h('span', { class: 'cal-row-name' }, dot(c), h('strong', {}, c.name)),
      h('span', { class: 'muted' }, c.host),
      h('span', { class: c.error ? 'cal-row-error' : 'muted' }, stateText(c))),
    h('div', { class: 'row' }, h('label', { class: 'check cal-shown' }, shownBox, 'Show'), edit, update, remove),
    editForm);
}

form.addEventListener('submit', (e) => {
  e.preventDefault();
  run(form, async () => {
    const status = form.querySelector('.form-status');
    setStatus(status, 'Fetching the calendar…');
    const c = await api('POST', '/api/calendars', { url: form.url.value.trim(), name: form.name.value, color: form.color.value });
    form.reset();
    $('calendarColor').replaceChildren(...colorOptions(COLORS[(COLORS.findIndex(([v]) => v === c.color) + 1) % COLORS.length][0]));
    loadCalendars();
    return `Linked ${c.name}, with ${c.events ?? 0} ${c.events === 1 ? 'event' : 'events'}.`;
  });
});
