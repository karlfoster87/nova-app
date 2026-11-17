// The calendar page: the profile's linked calendars as a month, a week or an agenda. It isn't a
// tab and nothing else in Nova links to it: the Home card's "Open calendar" opens it, and Back
// returns to Home. Like Home it lives in the sidebar stretched over the main column (home.css,
// body.at-home), so the profile row and the view tabs stay where they are.
// Route: #calendar, #calendar/<month|week|agenda>/<YYYY-MM-DD>.
//
// Events come from /api/calendar/events for the days on screen, in this device's time zone; the
// server reads its cached copy of each feed, so this never waits on a calendar provider. The
// legend shows or hides a calendar for this profile everywhere (Home too). An event opens its
// details, with Discuss with Nova.
import { h, svgIcon } from '../lib/dom.js';
import { api } from '../lib/api.js';
import { store } from '../lib/store.js';
import { localDay } from '../lib/format.js';
import { goTo } from '../shell/views.js';
import { openSettings } from '../settings/dialog.js';
import { browserZone, dateOf, addDays, dayName, daysOf, timeOnDay, dot, openEvent } from '../calendar/shared.js';

const MODES = [['month', 'Month'], ['week', 'Week'], ['agenda', 'Agenda']];
const WEEKDAYS = ['Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat', 'Sun'];
const AGENDA_DAYS = 30;
const CHIPS = 3; // events shown in a month cell before "+n more"
const ICONS = { back: ['M15 5 8 12l7 7'], prev: ['M15 5 8 12l7 7'], next: ['m9 5 7 7-7 7'], refresh: ['M20 11a8 8 0 1 0-2.3 5.7', 'M20 4v7h-7'] };
const phone = () => matchMedia('(max-width: 760px)').matches;

// Monday of the week a day is in (weeks start on Monday, as in the UK).
const monday = (day) => addDays(day, -((dateOf(day).getDay() + 6) % 7));
const monthStart = (day) => `${day.slice(0, 7)}-01`;
const shiftMonth = (day, n) => { const d = dateOf(monthStart(day)); d.setMonth(d.getMonth() + n); return localDay(d); };

export function init(ctx) {
  const { side } = ctx;
  let mode = store.get('calendar.mode', phone() ? 'agenda' : 'month');
  if (!MODES.some(([m]) => m === mode)) mode = 'month';
  let anchor = localDay(), selected = localDay(), data = null, shown = false, loading = 0, timer = 0;

  // ---- Layout ------------------------------------------------------------------
  const title = h('h1', { class: 'cal-title' });
  const modeButtons = MODES.map(([m, label]) => h('button', { type: 'button', role: 'tab', 'data-mode': m, onclick: () => setMode(m) }, label));
  const head = h('div', { class: 'cal-head' },
    h('button', { type: 'button', class: 'text-btn cal-back', onclick: () => goTo({ id: 'home' }) }, svgIcon(ICONS.back), h('span', {}, 'Home')),
    title,
    h('div', { class: 'cal-nav' },
      h('button', { type: 'button', class: 'icon-btn', 'aria-label': 'Earlier', title: 'Earlier', onclick: () => step(-1) }, svgIcon(ICONS.prev)),
      h('button', { type: 'button', class: 'text-btn', onclick: () => { anchor = selected = localDay(); go(); } }, 'Today'),
      h('button', { type: 'button', class: 'icon-btn', 'aria-label': 'Later', title: 'Later', onclick: () => step(1) }, svgIcon(ICONS.next))),
    h('div', { class: 'cal-modes', role: 'tablist', 'aria-label': 'Calendar layout' }, ...modeButtons));
  const legend = h('div', { class: 'cal-legend' });
  const body = h('div', { class: 'cal-body' });
  const dayPanel = h('section', { class: 'cal-day', 'aria-live': 'polite' });
  const status = h('div', { class: 'brain-status', role: 'status' });
  side.classList.add('home-pane', 'cal-pane');
  side.append(h('section', { class: 'cal-doc' }, head, legend, body, dayPanel), status);

  function setStatus(text = '', isError = false) {
    status.replaceChildren(...(text ? [h('span', {}, text)] : []));
    status.classList.toggle('error', isError);
  }

  // The days on screen: [from, to).
  function range() {
    if (mode === 'month') { const from = monday(monthStart(anchor)); const end = monday(addDays(shiftMonth(anchor, 1), 6)); return [from, end]; }
    if (mode === 'week') { const from = monday(anchor); return [from, addDays(from, 7)]; }
    return [anchor, addDays(anchor, AGENDA_DAYS)];
  }

  function step(n) {
    if (mode === 'month') anchor = shiftMonth(anchor, n);
    else anchor = addDays(anchor, n * (mode === 'week' ? 7 : AGENDA_DAYS));
    if (mode !== 'agenda') selected = mode === 'month' && monthStart(localDay()) === monthStart(anchor) ? localDay() : mode === 'month' ? monthStart(anchor) : monday(anchor);
    go();
  }
  function setMode(m) { mode = m; store.set('calendar.mode', m); if (m === 'agenda') anchor = selected; go(); }
  function go() { ctx.setRoute(`${mode}/${anchor}`); load(); }

  // ---- Loading -----------------------------------------------------------------
  async function load() {
    const [from, to] = range(), mine = ++loading;
    paintHead();
    try {
      const res = await api('GET', `/api/calendar/events?from=${from}&to=${to}&tz=${encodeURIComponent(browserZone())}`);
      if (mine !== loading) return;
      data = { ...res, from, to };
      render();
      setStatus('');
    } catch (err) { if (mine === loading) setStatus(err.message, true); }
  }
  const soon = () => { clearTimeout(timer); timer = setTimeout(() => { if (shown) load(); }, 400); };

  function paintHead() {
    const [from, to] = range();
    title.textContent = mode === 'month' ? dateOf(anchor).toLocaleDateString('en-GB', { month: 'long', year: 'numeric' })
      : `${dayName(from, { day: 'numeric', month: 'short' })} – ${dayName(addDays(to, -1), { day: 'numeric', month: 'short', year: 'numeric' })}`;
    for (const b of modeButtons) { const on = b.dataset.mode === mode; b.setAttribute('aria-selected', String(on)); b.tabIndex = on ? 0 : -1; }
  }

  // ---- Drawing -----------------------------------------------------------------
  const calOf = (id) => data?.calendars.find((c) => c.id === id);

  // Events by the local day they appear on, within the range.
  function byDay() {
    const map = new Map();
    for (const e of data.events) for (const d of daysOf(e)) {
      if (d < data.from || d >= data.to) continue;
      if (!map.has(d)) map.set(d, []);
      map.get(d).push(e);
    }
    // On each day: all-day events first, then those carried over from the day before, then by start.
    const rank = (e, d) => (e.allDay ? 0 : localDay(new Date(e.start)) < d ? 1 : 2);
    for (const [d, list] of map) list.sort((a, b) => rank(a, d) - rank(b, d) || (a.allDay ? 0 : a.start - b.start) || a.title.localeCompare(b.title));
    return map;
  }

  function render() {
    paintHead();
    renderLegend();
    if (!data.calendars.length) {
      body.replaceChildren(h('div', { class: 'cal-empty' }, h('p', {}, 'No calendars are linked yet. Add one by its ICS address, from Google, Outlook, iCloud or any calendar that publishes one.'),
        h('button', { type: 'button', class: 'send-btn', onclick: () => openSettings('calendars') }, 'Add a calendar')));
      dayPanel.replaceChildren();
      return;
    }
    const days = byDay();
    if (mode === 'month') renderMonth(days);
    else if (mode === 'week') renderWeek(days);
    else renderAgenda(days);
    if (mode === 'month') renderDay(days); else dayPanel.replaceChildren();
  }

  function renderLegend() {
    const cals = data.calendars;
    const chips = cals.map((c) => h('button', {
      type: 'button', class: `cal-chip${c.shown ? '' : ' off'}${c.error ? ' stale' : ''}`, 'aria-pressed': String(c.shown),
      title: c.error ? `${c.name}: couldn't update. ${c.error}` : c.shown ? `Hide ${c.name}` : `Show ${c.name}`,
      onclick: () => toggle(c)
    }, dot(c), h('span', {}, c.name), c.error ? h('span', { class: 'cal-warn', 'aria-label': 'out of date' }, '!') : null));
    legend.replaceChildren(...chips,
      cals.length ? h('button', { type: 'button', class: 'icon-btn cal-refresh', title: 'Update calendars now', 'aria-label': 'Update calendars now', onclick: refreshAll }, svgIcon(ICONS.refresh)) : null,
      h('button', { type: 'button', class: 'link-btn', onclick: () => openSettings('calendars') }, cals.length ? 'Manage calendars' : 'Add a calendar'));
  }

  async function toggle(c) {
    try { await api('PATCH', `/api/calendars/${c.id}`, { shown: !c.shown }); await load(); } catch (err) { setStatus(err.message, true); }
  }
  async function refreshAll() {
    setStatus('Updating calendars…');
    try {
      const list = await api('POST', '/api/calendars/refresh');
      const failed = list.filter((c) => c.error);
      await load();
      setStatus(failed.length ? `Couldn't update ${failed.map((c) => c.name).join(', ')}. ${failed[0].error}` : 'Calendars are up to date.', !!failed.length);
    } catch (err) { setStatus(err.message, true); }
  }

  // One event as a line: the calendar's colour, its time on this day and its title.
  const eventRow = (e, day, cls = 'cal-ev') => h('button', {
    type: 'button', class: `${cls} cal-c-${calOf(e.calendarId)?.color || 'cyan'}${e.allDay ? ' all-day' : ''}`,
    title: `${timeOnDay(e, day)} · ${e.title}`, onclick: (ev) => { ev.stopPropagation(); openEvent(e, calOf(e.calendarId)); }
  }, h('span', { class: 'cal-ev-time' }, timeOnDay(e, day)), h('span', { class: 'cal-ev-title' }, e.title));

  function renderMonth(days) {
    const today = localDay(), month = anchor.slice(0, 7);
    const cells = [];
    for (let d = data.from; d < data.to; d = addDays(d, 1)) {
      const list = days.get(d) || [];
      const more = list.length - CHIPS;
      const cell = h('div', {
        class: `cal-cell${d.slice(0, 7) !== month ? ' other' : ''}${d === today ? ' today' : ''}${d === selected ? ' selected' : ''}`,
        role: 'gridcell', tabindex: d === selected ? 0 : -1, 'aria-selected': String(d === selected),
        'aria-label': `${dayName(d)}${list.length ? `, ${list.length} ${list.length === 1 ? 'event' : 'events'}` : ''}`, 'data-day': d,
        onclick: () => select(d), onkeydown: (e) => cellKey(e, d)
      }, h('span', { class: 'cal-num' }, String(+d.slice(8))),
      h('div', { class: 'cal-chips' }, ...list.slice(0, CHIPS).map((e) => eventRow(e, d, 'cal-ev cal-ev-chip')),
        more > 0 ? h('span', { class: 'cal-more' }, `+${more} more`) : null),
      list.length ? h('span', { class: 'cal-dots', 'aria-hidden': 'true' }, ...list.slice(0, 4).map((e) => dot(calOf(e.calendarId)))) : null);
      cells.push(cell);
    }
    const weeks = [];
    for (let i = 0; i < cells.length; i += 7) weeks.push(h('div', { class: 'cal-week', role: 'row' }, ...cells.slice(i, i + 7)));
    body.replaceChildren(h('div', { class: 'cal-month', role: 'grid', 'aria-label': title.textContent },
      h('div', { class: 'cal-week cal-weekdays', role: 'row' }, ...WEEKDAYS.map((w) => h('span', { role: 'columnheader' }, w))), ...weeks));
  }

  function select(d) {
    selected = d;
    if (d.slice(0, 7) !== anchor.slice(0, 7)) { anchor = d; go(); return; }
    for (const c of body.querySelectorAll('.cal-cell')) {
      const on = c.dataset.day === d;
      c.classList.toggle('selected', on); c.setAttribute('aria-selected', String(on)); c.tabIndex = on ? 0 : -1;
    }
    renderDay(byDay());
  }
  function cellKey(e, d) {
    const move = { ArrowLeft: -1, ArrowRight: 1, ArrowUp: -7, ArrowDown: 7 }[e.key];
    if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); select(d); dayPanel.querySelector('button')?.focus(); return; }
    if (!move) return;
    e.preventDefault();
    const next = addDays(d, move);
    select(next);
    body.querySelector(`[data-day="${next}"]`)?.focus();
  }

  // The selected day's events in full, under the month.
  function renderDay(days) {
    const list = days.get(selected) || [];
    dayPanel.replaceChildren(h('h2', { class: 'cal-day-title' }, dayName(selected)),
      list.length ? h('ul', { class: 'cal-list' }, ...list.map((e) => h('li', {}, eventRow(e, selected, 'cal-ev cal-ev-line'))))
        : h('p', { class: 'home-empty' }, 'Nothing on this day.'));
  }

  function renderWeek(days) {
    const today = localDay(), cols = [];
    for (let d = data.from; d < data.to; d = addDays(d, 1)) {
      const list = days.get(d) || [];
      cols.push(h('section', { class: `cal-wday${d === today ? ' today' : ''}` },
        h('h2', {}, h('span', {}, dayName(d, { weekday: 'short' })), h('strong', {}, String(+d.slice(8)))),
        list.length ? h('ul', { class: 'cal-list' }, ...list.map((e) => h('li', {}, eventRow(e, d, 'cal-ev cal-ev-line')))) : h('p', { class: 'home-empty' }, 'Free')));
    }
    body.replaceChildren(h('div', { class: 'cal-weekview' }, ...cols));
  }

  function renderAgenda(days) {
    const today = localDay(), groups = [];
    for (let d = data.from; d < data.to; d = addDays(d, 1)) {
      const list = days.get(d);
      if (!list) continue;
      groups.push(h('section', { class: `cal-agenda-day${d === today ? ' today' : ''}` },
        h('h2', {}, dayName(d, { weekday: 'long', day: 'numeric', month: 'long' }), d === today ? h('span', { class: 'cal-today-tag' }, 'Today') : null),
        h('ul', { class: 'cal-list' }, ...list.map((e) => h('li', {}, eventRow(e, d, 'cal-ev cal-ev-line'))))));
    }
    body.replaceChildren(groups.length ? h('div', { class: 'cal-agenda' }, ...groups) : h('p', { class: 'home-empty cal-empty' }, `Nothing in the ${AGENDA_DAYS} days from ${dayName(data.from, { day: 'numeric', month: 'long' })}.`));
  }

  // The page follows the clock: today moves on at midnight.
  setInterval(() => { if (shown && data) render(); }, 60 * 1000);

  return {
    show(arg) {
      shown = true;
      const [m, day] = String(arg || '').split('/');
      if (MODES.some(([x]) => x === m)) mode = m;
      if (/^\d{4}-\d{2}-\d{2}$/.test(day || '')) anchor = selected = day;
      go();
    },
    hide() { shown = false; },
    watch(m) { if (shown && (m.t === 'calendars_changed' || m.t === 'profile_changed')) soon(); },
    profileChanged() { if (shown) load(); }
  };
}
