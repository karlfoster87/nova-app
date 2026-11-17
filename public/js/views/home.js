// Home: Nova's start page, one glance at what needs the user, the day, Nova's own work and the
// plan, with quick actions. It isn't a tab: the home button beside the profile name and the Nova
// logo open it. It lives in the sidebar, which widens over the main column while Home is open
// (home.css): the profile row stays exactly where it always is, the view tabs move to the end of
// that row, and the cards fill the space below. On a phone the drawer becomes the page. Route: #home.
//
// Everything comes from one call, /api/home (server/home/home.js), which leaves out cards the
// profile can't use; quick actions use the views' own routes. Home hears every server message
// (watch) and reloads, debounced, when one could change a card. The Email card (v0.15) shows for
// admins once Settings → Email turns it on. The Calendar card (v0.14) is the only way into the
// full calendar page (views/calendar.js).
import { h, svgIcon } from '../lib/dom.js';
import { api } from '../lib/api.js';
import { localDay } from '../lib/format.js';
import { state } from '../state.js';
import { goTo, goToChat, startChat, askNova } from '../shell/views.js';
import { WINDOWS, resetText } from '../shell/header.js';
import { openSettings } from '../settings/dialog.js';
import { browserZone, dayName, timeOnDay, dot, openEvent } from '../calendar/shared.js';

const ICONS = {
  waiting: ['M12 3a9 9 0 1 0 0 18 9 9 0 1 0 0-18Z', 'M12 7v5l3 2'],
  today: ['M4 4h16v16H4Z', 'm8 12 3 3 5-6'],
  activity: ['M4 6h16M4 12h16M4 18h10'],
  status: ['M4 20V10M10 20V4M16 20v-7M22 20H2'],
  email: ['M3 5h18v14H3Z', 'm3 6 9 7 9-7'],
  calendar: ['M4 5h16v15H4Z', 'M4 10h16M9 3v4M15 3v4'],
  send: ['M4 12 20 4l-6 16-3-7Z'],
  discuss: ['M4 5h16v11H9l-5 4Z'],
  reply: ['M9 7 4 12l5 5', 'M4 12h11a5 5 0 0 1 5 5v2']
};
// Waiting changes the most and comes first; the reserved slots sit beside what they belong with.
const TASK_STATE = { waiting: 'Waiting', in_progress: 'In progress', complete: 'Complete' };
const ORDER = ['waiting', 'email', 'calendar', 'today', 'activity', 'status'];
const TITLES = { waiting: 'Waiting on you', email: 'Email', calendar: 'Calendar', today: 'Today', activity: 'Nova\'s activity', status: 'Plan & status' };
// Server messages after which a card may read differently.
const WATCH = new Set(['permission', 'permission_resolved', 'permission_cancelled', 'state', 'chats_changed', 'tasks_changed',
  'notes_changed', 'thought_changed', 'heartbeat_changed', 'profile_changed', 'calendars_changed', 'email_changed']);

const clock = (ms) => new Date(ms).toLocaleTimeString('en-GB', { hour: '2-digit', minute: '2-digit' });
function when(ms) {
  const d = new Date(ms), now = new Date();
  if (d.toDateString() === now.toDateString()) return clock(ms);
  const yesterday = new Date(now); yesterday.setDate(now.getDate() - 1);
  if (d.toDateString() === yesterday.toDateString()) return `Yesterday ${clock(ms)}`;
  return d.toLocaleDateString('en-GB', { day: 'numeric', month: 'short' }) + ` ${clock(ms)}`;
}
function until(ms) {
  const min = Math.round((ms - Date.now()) / 60000);
  if (min <= 0) return 'due now';
  if (min < 60) return `in ${min} min`;
  if (min < 24 * 60) return `in ${Math.round(min / 60)} h`;
  return `in ${Math.round(min / 1440)} d`;
}
function greeting() {
  const hr = new Date().getHours();
  return hr < 5 ? 'Good evening' : hr < 12 ? 'Good morning' : hr < 18 ? 'Good afternoon' : 'Good evening';
}

export function init(ctx) {
  const { side } = ctx;
  let data = null, loading = null, timer = 0, shown = false;

  // ---- Layout ----------------------------------------------------------------
  const hello = h('h1', { class: 'home-hello' });
  const today = h('p', { class: 'home-date' });
  const ask = h('input', { type: 'text', class: 'home-ask-input', placeholder: 'Ask Nova anything…', 'aria-label': 'Ask Nova', maxlength: 4000, autocomplete: 'off' });
  const askForm = h('form', { class: 'home-ask', onsubmit: (e) => { e.preventDefault(); submitAsk(); } }, ask,
    h('button', { type: 'submit', class: 'send-btn', 'aria-label': 'Send to Nova' }, svgIcon(ICONS.send), h('span', {}, 'Ask')));
  const grid = h('div', { class: 'home-grid' });
  const status = h('div', { class: 'brain-status', role: 'status' });
  side.classList.add('home-pane');
  side.append(h('section', { class: 'home-doc' }, h('div', { class: 'home-head' }, h('div', {}, hello, today), askForm), grid), status);

  function setStatus(text = '', isError = false) {
    status.replaceChildren(...(text ? [h('span', {}, text)] : []));
    status.classList.toggle('error', isError);
  }

  function renderHead() {
    hello.textContent = `${greeting()}, ${state.me?.profile || ''}`;
    today.textContent = new Date().toLocaleDateString('en-GB', { weekday: 'long', day: 'numeric', month: 'long', year: 'numeric' });
  }

  // "Ask Nova": a new chat with the message sent at once, as if typed there.
  async function submitAsk() {
    const text = ask.value.trim();
    if (!text) return;
    if (await askNova(text)) ask.value = '';
  }

  // ---- Loading ----------------------------------------------------------------
  async function load() {
    if (loading) return loading;
    loading = (async () => {
      try {
        data = await api('GET', `/api/home?today=${localDay()}&tz=${encodeURIComponent(browserZone())}`);
        render();
        setStatus('');
      } catch (err) { setStatus(err.message, true); } finally { loading = null; }
    })();
    return loading;
  }
  const soon = () => { clearTimeout(timer); timer = setTimeout(() => { if (shown) load(); }, 400); };

  async function act(fn, done = 'Done.') {
    try { await fn(); setStatus(done); await load(); } catch (err) { setStatus(err.message, true); }
  }

  // ---- Cards ------------------------------------------------------------------
  function render() {
    renderHead();
    if (!data) return;
    const cards = ORDER.map((id) => {
      const body = BUILD[id]();
      return body && h('article', { class: `home-card home-${id}`, 'aria-labelledby': `home-${id}-title` },
        h('h2', { class: 'home-card-title', id: `home-${id}-title` }, svgIcon(ICONS[id]), h('span', {}, TITLES[id]), ...(body.extra || [])),
        ...body.kids);
    }).filter(Boolean);
    placed = cards;
    lay(true);
  }

  // Masonry: as many columns as fit at MIN_COL wide, each card added to the shortest column in
  // turn, so the most urgent stay top left and no column runs much longer than another. Laid out
  // again when the width changes how many columns fit.
  const MIN_COL = 330, GAP = 14;
  let placed = [], columns = 0;
  function lay(force = false) {
    const width = grid.clientWidth;
    if (!width) return;
    const n = Math.max(1, Math.min(placed.length || 1, Math.floor((width + GAP) / (MIN_COL + GAP))));
    if (!force && n === columns) return;
    columns = n;
    const cols = Array.from({ length: n }, () => h('div', { class: 'home-col' }));
    grid.replaceChildren(...cols);
    for (const card of placed) cols.reduce((a, b) => (b.offsetHeight < a.offsetHeight ? b : a)).append(card);
  }
  new ResizeObserver(() => lay()).observe(grid);

  const link = (label, onclick) => h('button', { type: 'button', class: 'link-btn', onclick }, label);
  const empty = (text) => h('p', { class: 'home-empty' }, text);
  const count = (n) => (n ? [h('span', { class: 'home-count' }, String(n))] : []);
  const row = (kids, kind = '') => h('li', { class: kind ? `home-row home-row-${kind}` : 'home-row' }, ...kids);

  const BUILD = {
    waiting() {
      const items = [];
      const known = new Set(data.waiting.map((w) => w.chatId));
      for (const w of data.waiting) {
        items.push(row([h('button', { type: 'button', class: 'home-item', onclick: () => goToChat(w.chatId) },
          h('strong', {}, w.title), h('span', { class: 'muted' }, w.kind === 'question' ? 'Nova asked you something' : 'Nova needs your approval'))], 'hot'));
      }
      for (const id of state.unread) {
        const chat = state.chats.find((c) => c.id === id);
        if (!chat || known.has(id)) continue;
        items.push(row([h('button', { type: 'button', class: 'home-item', onclick: () => goToChat(id) },
          h('strong', {}, chat.title || 'New chat'), h('span', { class: 'muted' }, 'Nova replied'))]));
      }
      for (const t of data.thought?.questions || []) {
        items.push(row([h('p', { class: 'home-q' }, h('strong', {}, 'Nova asks: '), t.question),
          h('div', { class: 'home-actions' },
            h('button', { type: 'button', class: 'text-btn', onclick: () => discuss(t) }, 'Discuss'),
            link('Answered', () => act(() => api('PATCH', `/api/thoughts/${t.id}`, { status: 'answered' }), 'Marked answered.')),
            link('Dismiss', () => act(() => api('PATCH', `/api/thoughts/${t.id}`, { status: 'dismissed' }), 'Dismissed.')))], 'question'));
      }
      for (const t of data.thought?.held || []) {
        items.push(row([h('p', { class: 'home-q' }, t.summary),
          h('div', { class: 'home-actions' },
            t.chatId ? link('Open run', () => goTo({ id: 'heartbeat', arg: `run/${t.chatId}` })) : null,
            link('Mark reviewed', () => act(() => api('PATCH', `/api/thoughts/${t.id}`, { status: 'reviewed' }), 'Marked reviewed.')))], 'held'));
      }
      return { extra: count(items.length), kids: [items.length ? h('ul', { class: 'home-list' }, ...items) : empty('Nothing needs you.')] };
    },

    // The inbox's newest mail, then what's flagged or to do, for admins once Settings → Email turns
    // it on (the server leaves it out otherwise). Each item can start a chat about it, or one that
    // drafts a reply straight away. Mail text comes from outside, so it's only put in as text.
    email() {
      const e = data.cards?.email && data.email;
      if (!e) return null;
      const extra = e.unread ? [h('span', { class: 'home-mail-unread' }, `${e.unread} unread`)] : [];
      if (!e.at) {
        return { extra, kids: e.error ? [h('p', { class: 'home-warn' }, e.error), h('div', { class: 'home-actions' }, link('Try again', refreshMail))] : [empty(`Reading ${e.provider}…`)] };
      }
      const item = (x) => {
        const time = x.kind === 'task' || (x.flagged && x.due) ? (x.due ? `due ${dayName(localDay(new Date(x.due)), { day: 'numeric', month: 'short' })}` : '') : x.received ? when(x.received) : '';
        const who = x.kind === 'task' ? 'Task' : x.from || 'Unknown sender';
        const btn = (mode, label, icon) => h('button', { type: 'button', class: 'icon-btn', title: label, 'aria-label': `${label}: ${x.subject || '(no subject)'}`, onclick: () => handoff(x, mode) }, svgIcon(icon));
        return row([
          h('div', { class: 'home-mail', title: x.preview || '' },
            h('div', { class: 'home-mail-head' }, h('strong', {}, who), time ? h('time', {}, time) : null),
            h('span', { class: 'home-mail-subject' }, x.subject || '(no subject)')),
          h('div', { class: 'home-mail-btns' },
            btn('discuss', 'Discuss with Nova', ICONS.discuss),
            x.kind === 'task' ? null : btn('reply', 'Draft a reply', ICONS.reply))], `mail${x.unread ? ' unread' : ''}`);
      };
      const kids = [e.inbox.length ? h('ul', { class: 'home-list' }, ...e.inbox.slice(0, 6).map(item)) : empty('Your inbox is empty.')];
      if (e.todo.length) kids.push(h('h3', { class: 'home-h3' }, 'Flagged'), h('ul', { class: 'home-list' }, ...e.todo.slice(0, 6).map(item)));
      if (e.error) kids.push(h('p', { class: 'home-warn home-small' }, `Couldn't update: ${e.error}`));
      kids.push(h('div', { class: 'home-actions' }, h('span', { class: 'muted home-small' }, `Updated ${clock(e.at)}`), link('Refresh', refreshMail)));
      return { extra, kids };
    },

    // Today's events, then the coming week's, from the calendars this profile shows. An event opens
    // its details (with Discuss with Nova); Open calendar is the only way to the full page.
    calendar() {
      const c = data.cards?.calendar && data.calendar;
      if (!c) return null;
      if (!c.linked) {
        return { kids: [empty('No calendars are linked yet. Add one by its ICS address to see your day here.'),
          h('div', { class: 'home-actions' }, h('button', { type: 'button', class: 'text-btn', onclick: () => openSettings('calendars') }, 'Add a calendar'))] };
      }
      const cal = (id) => c.calendars.find((x) => x.id === id);
      const day = localDay();
      const line = (e, on, label) => row([h('button', { type: 'button', class: 'home-item home-event', onclick: () => openEvent(e, cal(e.calendarId)) },
        h('strong', {}, dot(cal(e.calendarId)), h('span', {}, e.title)), h('span', { class: 'muted' }, label || timeOnDay(e, on)))], 'event');
      const kids = [c.today.length ? h('ul', { class: 'home-list' }, ...c.today.map((e) => line(e, day)))
        : empty(c.calendars.some((x) => x.shown) ? 'Nothing on today.' : 'Every calendar is hidden. Show one on the calendar page.')];
      if (c.upcoming.length) {
        kids.push(h('h3', { class: 'home-h3' }, 'Coming up'), h('ul', { class: 'home-list' }, ...c.upcoming.map((e) => {
          const on = e.allDay ? e.start : localDay(new Date(e.start));
          return line(e, on, `${dayName(on, { weekday: 'short', day: 'numeric', month: 'short' })} · ${timeOnDay(e, on)}`);
        })));
      }
      const stale = c.calendars.filter((x) => x.error);
      if (stale.length) kids.push(h('p', { class: 'home-warn home-small' }, `Couldn't update ${stale.map((x) => x.name).join(', ')}, so it may be out of date.`));
      kids.push(h('div', { class: 'home-actions' }, link('Open calendar', () => goTo({ id: 'calendar' }))));
      return { kids };
    },

    today() {
      const t = data.today, notes = data.notes;
      if (!t && !notes) return null;
      const kids = [];
      if (t) {
        kids.push(h('p', { class: 'home-sub' }, t.left ? `${t.left} left${t.done ? `, ${t.done} done` : ''}` : t.done ? `All ${t.done} done` : 'Nothing planned for today'));
        if (t.items.length) {
          // The task board's square (tasks.css .task-state): empty, half filled in progress, full when
          // complete; a click moves it on, as on the board. A finished task leaves the list.
          kids.push(h('ul', { class: 'home-list' }, ...t.items.map((x) => {
            const name = TASK_STATE[x.state] || TASK_STATE.waiting, next = x.state === 'in_progress' ? 'complete' : 'in_progress';
            return row([
              h('button', { type: 'button', class: `task-state ${x.state}`, disabled: !t.canEdit,
                title: t.canEdit ? `${name}. Click for ${TASK_STATE[next].toLowerCase()}` : name,
                'aria-label': `${x.title}: ${name.toLowerCase()}${t.canEdit ? `. Change to ${TASK_STATE[next].toLowerCase()}` : ''}`,
                onclick: () => act(() => api('PATCH', `/api/tasks/${x.id}`, { state: next }), next === 'complete' ? 'Task done.' : 'Task started.') }),
              h('span', { class: 'home-task' }, x.title, x.under ? h('span', { class: 'muted' }, ` · ${x.under}`) : null)], 'task');
          })));
        }
        kids.push(h('div', { class: 'home-actions' }, link('Open Tasks', () => goTo({ id: 'tasks' }))));
      }
      if (notes?.length) {
        kids.push(h('div', { class: 'home-notes' }, ...notes.map((n) => h('button', {
          type: 'button', class: `home-note note-${n.color}`, onclick: () => goTo({ id: 'notes', arg: n.id }), title: n.shared && !n.mine ? `Shared by ${n.owner}` : ''
        }, n.text))));
      }
      return { kids };
    },

    activity() {
      if (!data.thought) return null;
      const s = data.schedules, recent = data.thought.recent;
      return {
        kids: [
          recent.length ? h('ul', { class: 'home-list' }, ...recent.map((t) => row([h('time', {}, when(t.at)),
            h('span', {}, t.summary, t.mine ? null : h('span', { class: 'muted' }, ` · from ${t.profile}`))], 'thought'))) : empty('Nothing recorded yet.'),
          h('h3', { class: 'home-h3' }, 'Next on the schedule'),
          s.next.length ? h('ul', { class: 'home-list' }, ...s.next.map((x) => row([
            h('button', { type: 'button', class: 'home-item', onclick: () => goTo({ id: 'heartbeat', arg: x.id }) },
              h('strong', {}, x.name), h('span', { class: 'muted' }, x.running ? 'Running now' : `${until(x.nextRun)} · ${x.cadence}`)),
            s.canEdit && !x.running ? link('Run now', () => act(() => api('POST', `/api/heartbeats/${x.id}/run`), 'Started.')) : null]))) : empty('No active schedules.'),
          h('div', { class: 'home-actions' }, link('Open Thought', () => goTo({ id: 'thought' })), link('Open Heartbeat', () => goTo({ id: 'heartbeat' })))]
      };
    },

    status() {
      const kids = [], meta = state.meta;
      if (meta?.signedIn === false) {
        kids.push(h('p', { class: 'home-warn' }, 'Claude isn\'t connected, so Nova can\'t reply.'),
          state.me?.role === 'admin' ? h('button', { type: 'button', class: 'text-btn', onclick: () => openSettings('claude') }, 'Sign in') : empty('Ask an admin to sign in.'));
      } else {
        const u = meta?.usage;
        // The fixed windows, then any per-model ones Claude reports (model_scoped, such as a
        // temporary allowance for one model), which come and go by themselves. Home only: the
        // header keeps to the fixed windows.
        const shown = WINDOWS.filter(([k]) => u?.windows?.[k]?.utilization != null).map(([k, label]) => [label, u.windows[k]]);
        const taken = new Set(shown.map(([label]) => label.split(' ')[0].toLowerCase()));
        const scoped = (Array.isArray(u?.windows?.model_scoped) ? u.windows.model_scoped : [])
          .filter((w) => w?.display_name && w.utilization != null && !taken.has(String(w.display_name).toLowerCase()))
          .map((w) => [String(w.display_name), w]);
        const bars = u?.available === false ? [] : [...shown, ...scoped].map(([label, w]) => {
          const pct = Math.max(0, Math.min(100, w.utilization));
          const fill = h('div', { class: 'meter-fill' });
          fill.style.width = `${pct}%`;
          return h('div', { class: `home-meter${pct >= 90 || w.status === 'rejected' ? ' bad' : pct >= 75 || w.status === 'allowed_warning' ? ' warn' : ''}` },
            h('span', {}, label), h('div', { class: 'meter-track' }, fill), h('strong', {}, `${Math.round(pct)}%`), h('span', { class: 'muted home-reset' }, resetText(w.resets_at)));
        });
        kids.push(...(bars.length ? bars : [empty(u?.available === false ? 'Plan limits aren\'t reported for Anthropic Console sign-ins.' : 'Usage isn\'t reported yet.')]));
      }
      const busy = [...data.running.map((r) => h('button', { type: 'button', class: 'home-item', onclick: () => goToChat(r.chatId) }, h('strong', {}, r.title), h('span', { class: 'muted' }, 'Nova is working'))),
        ...(data.schedules?.running || []).map((r) => h('button', { type: 'button', class: 'home-item', onclick: () => goTo({ id: 'heartbeat', arg: r.id }) },
          h('strong', {}, r.name), h('span', { class: 'muted' }, 'Scheduled run going')))];
      kids.push(h('h3', { class: 'home-h3' }, 'Running now'), busy.length ? h('div', { class: 'home-busy' }, ...busy) : empty('Nothing is running.'));
      return { kids };
    }
  };

  // An email to a new chat. Discuss puts the email in the message box for the user to add what they
  // want; Draft a reply sends at once, so Nova starts writing it. The server reads the email (by
  // the ref it listed) and writes the message, so the browser never handles Outlook's ids.
  async function handoff(x, mode) {
    setStatus(mode === 'reply' ? 'Reading the email for Nova…' : 'Reading the email…');
    try {
      const { text } = await api('POST', `/api/email/${x.ref}/handoff`, { mode });
      setStatus('');
      await (mode === 'reply' ? askNova(text) : startChat(text));
    } catch (err) { setStatus(err.message, true); }
  }
  const refreshMail = () => act(() => api('POST', '/api/email/refresh'), 'Email is up to date.');

  function discuss(t) {
    const from = t.scheduleName ? ` during the scheduled run "${t.scheduleName}"` : '';
    startChat(`Earlier${from}, you noted: ${t.summary}\n\nYou asked: ${t.question}\n\n`);
  }

  // Relative times and the greeting move on by themselves.
  setInterval(() => { if (shown) { renderHead(); if (data) load(); } }, 60 * 1000);

  return {
    show() { shown = true; ctx.setRoute(''); renderHead(); load(); },
    hide() { shown = false; },
    // Every server message: reload when one could change a card, and redraw the plan card
    // straight away when the usage meters move.
    watch(m) {
      if (!shown) return;
      // Home hears each message before chats.js stores it, so the redraw waits until state.meta is the new one.
      if (m.t === 'meta') { if (data) queueMicrotask(render); return; }
      if (WATCH.has(m.t) || (m.t === 'sdk' && m.msg?.type === 'result')) soon();
    },
    profileChanged() { if (shown) load(); }
  };
}
