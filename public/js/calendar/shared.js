// What the Home card and the calendar page share: the colours, times written for this device, and
// an event's details in a dialog, with Discuss with Nova (a new chat with the event in its box,
// sent only when the user presses Send). Event text comes from outside calendars, so it is only
// ever put in as text.
import { h, svgIcon } from '../lib/dom.js';
import { localDay } from '../lib/format.js';
import { startChat } from '../shell/views.js';
import { dot } from './colors.js';

export { dot };

// This device's time zone, so the server works out "today" and all-day events as the user sees them.
export const browserZone = () => { try { return Intl.DateTimeFormat().resolvedOptions().timeZone || ''; } catch { return ''; } };

// 'YYYY-MM-DD' ↔ a local Date at midnight.
export const dateOf = (day) => new Date(+day.slice(0, 4), +day.slice(5, 7) - 1, +day.slice(8, 10));
export const addDays = (day, n) => { const d = dateOf(day); d.setDate(d.getDate() + n); return localDay(d); };
export const clock = (ms) => new Date(ms).toLocaleTimeString('en-GB', { hour: '2-digit', minute: '2-digit' });
export const dayName = (day, opts = { weekday: 'long', day: 'numeric', month: 'long' }) => dateOf(day).toLocaleDateString('en-GB', opts);

// The local days an event covers: all-day ones up to their (exclusive) end, timed ones from the
// day they start to the day they finish (an event ending at midnight doesn't reach the next day).
export function daysOf(e) {
  const out = [];
  if (e.allDay) { for (let d = e.start; d < e.end && out.length < 60; d = addDays(d, 1)) out.push(d); return out.length ? out : [e.start]; }
  const last = localDay(new Date(Math.max(e.start, e.end - 1)));
  for (let d = localDay(new Date(e.start)); d <= last && out.length < 60; d = addDays(d, 1)) out.push(d);
  return out;
}

// How an event reads on one of its days: "09:00", "All day", "until 11:00", "Continues".
export function timeOnDay(e, day) {
  if (e.allDay) return 'All day';
  const startDay = localDay(new Date(e.start)), endDay = localDay(new Date(Math.max(e.start, e.end - 1)));
  if (startDay === day) return clock(e.start);
  if (endDay === day) return `until ${clock(e.end)}`;
  return 'All day';
}

// The whole of an event's time, written out: "Tuesday 18 November, 09:00 to 09:15".
export function whenText(e) {
  if (e.allDay) {
    const last = addDays(e.end, -1);
    return last === e.start ? `${dayName(e.start)}, all day` : `${dayName(e.start)} to ${dayName(last)}, all day`;
  }
  const sDay = localDay(new Date(e.start)), eDay = localDay(new Date(Math.max(e.start, e.end - 1)));
  if (e.end <= e.start) return `${dayName(sDay)}, ${clock(e.start)}`;
  return sDay === eDay ? `${dayName(sDay)}, ${clock(e.start)} to ${clock(e.end)}` : `${dayName(sDay)} ${clock(e.start)} to ${dayName(eDay)} ${clock(e.end)}`;
}

// A short form for the chat draft: "Tue 18 Nov, 09:00 to 09:15".
function shortWhen(e) {
  const d = (day) => dayName(day, { weekday: 'short', day: 'numeric', month: 'short' });
  if (e.allDay) { const last = addDays(e.end, -1); return last === e.start ? `${d(e.start)}, all day` : `${d(e.start)} to ${d(last)}`; }
  const sDay = localDay(new Date(e.start)), eDay = localDay(new Date(Math.max(e.start, e.end - 1)));
  return sDay === eDay ? `${d(sDay)}, ${clock(e.start)} to ${clock(e.end)}` : `${d(sDay)} ${clock(e.start)} to ${d(eDay)} ${clock(e.end)}`;
}

// A new chat about the event, ready in the box. The title leads, so it names the chat; the
// details are quoted as the calendar's, since they come from outside.
export function discussEvent(e, cal) {
  const lines = [`Help me with my calendar event "${e.title}" (${shortWhen(e)}${cal ? `, ${cal.name}` : ''}).`];
  if (e.location) lines.push(`Location: ${e.location}`);
  if (e.description) lines.push('', 'Details from the calendar:', e.description.slice(0, 2000));
  return startChat(`${lines.join('\n')}\n\n`);
}

// An event's details. Esc or Close shuts it; Discuss with Nova opens the chat.
export function openEvent(e, cal) {
  const back = document.activeElement;
  const close = () => { if (dialog.open) dialog.close(); };
  const heading = h('h2', { id: `cal-ev-${Math.random().toString(36).slice(2)}` }, e.title);
  const facts = [
    ['When', whenText(e) + (e.recurring ? ' (repeats)' : '')],
    e.location ? ['Where', e.location] : null,
    cal ? ['Calendar', h('span', { class: 'cal-fact-cal' }, dot(cal), cal.name)] : null
  ].filter(Boolean);
  const discuss = h('button', { type: 'button', class: 'send-btn', onclick: async () => { close(); await discussEvent(e, cal); } }, 'Discuss with Nova');
  const dialog = h('dialog', { class: 'settings small-dialog cal-event-dialog', 'aria-labelledby': heading.id },
    h('div', { class: 'stack' },
      h('div', { class: 'settings-head' }, heading,
        h('button', { type: 'button', class: 'icon-btn', 'aria-label': 'Close', onclick: close }, svgIcon(['M6 6l12 12M18 6 6 18']))),
      h('dl', { class: 'facts cal-facts' }, ...facts.flatMap(([k, v]) => [h('dt', {}, k), h('dd', {}, v)])),
      e.description ? h('div', { class: 'cal-desc' }, e.description) : null,
      e.url ? h('p', {}, h('a', { href: e.url, target: '_blank', rel: 'noopener noreferrer' }, 'Open the event\'s link')) : null,
      h('div', { class: 'row' }, h('span', { class: 'spacer' }), h('button', { type: 'button', class: 'text-btn', onclick: close }, 'Close'), discuss)));
  dialog.addEventListener('close', () => { dialog.remove(); if (back?.isConnected) back.focus(); });
  document.body.append(dialog);
  dialog.showModal();
  discuss.focus();
}
