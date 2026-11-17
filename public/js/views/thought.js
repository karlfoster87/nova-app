// Thought view: the Train of Thought, Nova's timeline of what it has done, when and why, shared
// by every profile with Core access. It isn't a chat: each entry is a line or two with where it
// came from. Questions Nova wants to put to the user wait here until someone discusses them with
// Nova (a new chat with the question ready in the box), marks them answered, or dismisses them;
// actions an unattended Heartbeat run held back wait for their profile to review. An entry's
// detail and its links to a chat or run show only for the profile it came from; the server
// leaves them out for everyone else (thought/thoughts.js). Route: #thought, or #thought/<filter>.
import { h, svgIcon } from '../lib/dom.js';
import { api } from '../lib/api.js';
import { startChat, goToChat, goTo } from '../shell/views.js';
import { state } from '../state.js';

const FILTERS = [['all', 'Everything'], ['open', 'Waiting for you'], ['questions', 'Questions']];
const SOURCE = {
  heartbeat: ['Heartbeat', ['M3 12h4l2-6 4 12 2-6h6']],
  chat: ['Chat', ['M20 12a8 8 0 0 1-11.6 7.1L4 20l1-4.6A8 8 0 1 1 20 12Z']],
  task: ['Task', ['M4 4h16v16H4Z', 'm8 12 3 3 5-6']],
  commit: ['Commit', ['M12 8a4 4 0 1 0 0 8 4 4 0 1 0 0-8Z', 'M2 12h6M16 12h6']]
};
const STATUS_TEXT = { answered: 'Answered', dismissed: 'Dismissed', reviewed: 'Reviewed' };

const time = (ms) => new Date(ms).toLocaleTimeString('en-GB', { hour: '2-digit', minute: '2-digit' });
const full = (ms) => new Date(ms).toLocaleString('en-GB', { day: 'numeric', month: 'short', year: 'numeric', hour: '2-digit', minute: '2-digit' });
function dayLabel(ms) {
  const d = new Date(ms), today = new Date();
  const days = Math.round((new Date(today.getFullYear(), today.getMonth(), today.getDate()) - new Date(d.getFullYear(), d.getMonth(), d.getDate())) / 86400000);
  return days === 0 ? 'Today' : days === 1 ? 'Yesterday' : d.toLocaleDateString('en-GB', { weekday: 'long', day: 'numeric', month: 'long', ...(days > 300 ? { year: 'numeric' } : {}) });
}

export function init(ctx) {
  const { side, main } = ctx;
  let filter = 'all';
  let entries = [], more = false, counts = null;

  // ---- Layout -------------------------------------------------------------
  const filterEl = h('div', { class: 'chat-list th-filters', role: 'list' });
  side.append(h('div', { class: 'brain-side-head' }, h('span', { class: 'cat-label' }, 'Thought')), filterEl,
    h('div', { class: 'soul-about' },
      h('p', {}, 'What Nova has done, when and why: finished tasks, commits and its own scheduled work, a line or two each.'),
      h('p', { class: 'muted' }, 'Everyone with access to Core sees this timeline. Details and links show only for the profile they came from.')));

  const crumbs = h('p', { class: 'brain-crumbs' });
  const doc = h('section', { class: 'brain-doc th-doc' });
  const status = h('div', { class: 'brain-status', role: 'status' });
  main.append(h('header', { class: 'topbar brain-bar' },
    h('button', { type: 'button', class: 'icon-btn menu-btn', 'aria-label': 'Show the sidebar' }, svgIcon('M4 6h16M4 12h16M4 18h16')),
    crumbs), doc, status);

  function setStatus(text = '', isError = false) {
    status.replaceChildren(...(text ? [h('span', {}, text)] : []));
    status.classList.toggle('error', isError);
  }

  // ---- Loading ------------------------------------------------------------
  async function load({ append = false } = {}) {
    try {
      const before = append && entries.length ? `&before=${entries.at(-1).at}` : '';
      const page = await api('GET', `/api/thoughts?filter=${filter}${before}`);
      entries = append ? [...entries, ...page.thoughts] : page.thoughts;
      more = page.more;
      render();
    } catch (err) { setStatus(err.message, true); }
  }

  async function loadCount() {
    try { counts = (await api('GET', '/api/thoughts?filter=open')).thoughts.length; } catch { counts = null; }
    renderFilters();
  }

  function renderFilters() {
    filterEl.replaceChildren(...FILTERS.map(([id, label]) => h('button', {
      type: 'button', role: 'listitem', class: 'chat-item th-filter', 'aria-current': String(id === filter),
      onclick: () => { filter = id; ctx.setRoute(id === 'all' ? '' : id); renderFilters(); load(); ctx.closeSidebar(); }
    }, svgIcon(id === 'held' ? ['M12 3 3 20h18Z', 'M12 10v4M12 17h.01'] : id === 'questions' ? ['M9 9a3 3 0 1 1 4 2.8c-.6.3-1 .9-1 1.6V14', 'M12 17h.01']
      : id === 'open' ? ['M12 3a9 9 0 1 0 0 18 9 9 0 1 0 0-18Z', 'M12 7v5l3 2'] : ['M4 6h16M4 12h16M4 18h10']),
    h('span', {}, label), id === 'open' && counts ? h('time', { class: 'th-count' }, String(counts)) : h('time'))));
  }

  // ---- Timeline -----------------------------------------------------------
  function render() {
    crumbs.replaceChildren(h('span', { class: 'crumb-file' }, 'Thought'),
      ...(filter === 'all' ? [] : [h('span', { class: 'crumb-sep' }, '›'), h('span', { class: 'crumb-file' }, FILTERS.find(([id]) => id === filter)[1])]));
    if (!entries.length) {
      doc.replaceChildren(h('div', { class: 'empty' }, h('h2', {}, filter === 'all' ? 'Nothing yet' : 'Nothing here'),
        h('p', {}, filter === 'all' ? 'Nova adds a line here when it finishes a task you confirm, commits a project, or runs a Heartbeat schedule.'
          : filter === 'open' ? 'No questions are waiting for you.' : 'Nothing matches this filter.')));
      return;
    }
    const kids = [];
    let day = null;
    for (const t of entries) {
      const label = dayLabel(t.at);
      if (label !== day) { day = label; kids.push(h('h3', { class: 'th-day' }, label)); }
      kids.push(entry(t));
    }
    if (more) kids.push(h('p', { class: 'th-more' }, h('button', { type: 'button', class: 'text-btn', onclick: () => load({ append: true }) }, 'Show older')));
    doc.replaceChildren(h('div', { class: 'th-line' }, ...kids));
  }

  function entry(t) {
    const [srcLabel, icon] = SOURCE[t.source] || ['Nova', SOURCE.chat[1]];
    const source = t.scheduleName ? `${srcLabel} · ${t.scheduleName}` : srcLabel;
    const links = [];
    if (t.mine && t.chatId && t.source === 'heartbeat') links.push(link('Open run', () => goTo({ id: 'heartbeat', arg: `run/${t.chatId}` })));
    else if (t.mine && t.chatId) links.push(link('Open chat', () => goToChat(t.chatId)));
    if (t.mine && t.scheduleId && t.scheduleName) links.push(link('Schedule', () => goTo({ id: 'heartbeat', arg: t.scheduleId })));
    return h('article', { class: `th-entry ${t.kind}${t.status ? ` ${t.status}` : ''}` },
      h('div', { class: 'th-meta' },
        h('time', { title: full(t.at) }, time(t.at)),
        h('span', { class: 'th-source' }, svgIcon(icon), source),
        t.mine ? null : h('span', { class: 'th-from' }, `from ${t.profile}`),
        h('span', { class: 'spacer' }), ...links),
      h('p', { class: 'th-summary' }, t.summary),
      t.question ? questionBlock(t) : null,
      t.kind === 'held' ? heldBlock(t) : null,
      t.kind !== 'held' && t.mine && t.detail ? h('details', { class: 'th-detail' }, h('summary', {}, 'Nova\'s last reply'), h('pre', {}, t.detail)) : null);
  }

  const link = (label, onclick) => h('button', { type: 'button', class: 'link-btn', onclick }, label);
  const resolvedLine = (t) => h('p', { class: 'th-resolved' }, `${STATUS_TEXT[t.status]} by ${t.resolvedBy || 'someone'}, ${full(t.resolvedAt)}.`,
    ' ', link(t.kind === 'held' ? 'Open again' : 'Reopen', () => resolve(t, 'open')));

  function questionBlock(t) {
    const open = t.status === 'open';
    return h('div', { class: 'th-question' },
      h('p', {}, h('strong', {}, 'Nova asks: '), t.question),
      open ? h('div', { class: 'row' },
        h('button', { type: 'button', class: 'send-btn', onclick: () => discuss(t) }, 'Discuss with Nova'),
        h('button', { type: 'button', class: 'text-btn', onclick: () => resolve(t, 'answered') }, 'Mark answered'),
        h('button', { type: 'button', class: 'text-btn', onclick: () => resolve(t, 'dismissed') }, 'Dismiss')) : resolvedLine(t));
  }

  function heldBlock(t) {
    const mayReview = t.mine || state.me?.role === 'admin';
    return h('div', { class: 'th-held' },
      t.mine && t.detail ? h('pre', {}, t.detail) : null,
      t.status === 'open' ? (mayReview ? h('div', { class: 'row' },
        h('button', { type: 'button', class: 'text-btn', onclick: () => resolve(t, 'reviewed') }, 'Mark reviewed'),
        t.mine && t.chatId ? h('span', { class: 'muted' }, 'Open the run to see why Nova wanted to.') : null) : null) : resolvedLine(t));
  }

  // A new chat with the question ready in the box, like Hand to Nova for a task. Nothing is sent
  // until the user presses Send. Nova finds the entry with its thought tool and marks it answered.
  function discuss(t) {
    const from = t.scheduleName ? ` during the scheduled run "${t.scheduleName}"` : '';
    startChat(`Earlier${from} (${full(t.at)}), you noted: ${t.summary}\n\nYou asked: ${t.question}\n\n`);
  }

  async function resolve(t, statusValue) {
    try {
      const out = await api('PATCH', `/api/thoughts/${t.id}`, { status: statusValue });
      entries = entries.map((e) => (e.id === t.id ? out : e)).filter((e) => filter !== 'open' || e.status === 'open');
      render();
      loadCount();
      setStatus('');
    } catch (err) { setStatus(err.message, true); }
  }

  // ---- View lifecycle -------------------------------------------------------
  let started = false;
  return {
    show(arg) {
      if (arg && FILTERS.some(([id]) => id === arg)) filter = arg;
      ctx.setRoute(filter === 'all' ? '' : filter);
      started = true;
      renderFilters();
      load();
      loadCount();
    },
    onServer(m) { if (started && m.t === 'thought_changed' && !side.hidden) { load(); loadCount(); } },
    profileChanged() { if (started) { load(); loadCount(); } }
  };
}
