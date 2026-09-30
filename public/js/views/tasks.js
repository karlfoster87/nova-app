// Tasks view: a board of day columns. It shows earlier days only while
// they still hold unfinished tasks (overdue), today and the next three days always, later
// days only when a task is on them, and Unscheduled only when asked for from the sidebar.
// The board is a window of one or two whole days that steps a day at a time (arrows, Today,
// sidebar days, a swipe, or holding a dragged task over an edge), never free scrolling.
// Tasks nest; only top-level tasks have a day. Drag a card onto another card's middle to
// nest it, near its top or bottom edge to place it before or after, or onto a column to put
// it at the end of that day. Every move also has a menu equivalent for keyboard and touch.
import { h, svgIcon } from '../lib/dom.js';
import { api } from '../lib/api.js';
import { store } from '../lib/store.js';
import { localDay as iso } from '../lib/format.js';
import { openMenu } from '../lib/menu.js';
import { confirmDialog, promptDialog } from '../lib/dialog.js';

const STATES = [['waiting', 'Waiting'], ['in_progress', 'In progress'], ['complete', 'Complete']];
const STATE_NAME = Object.fromEntries(STATES);
const NEXT_STATE = { waiting: 'in_progress', in_progress: 'complete', complete: 'waiting' };
const ICONS = { more: 'M5 12h.01M12 12h.01M19 12h.01', menu: 'M4 6h16M4 12h16M4 18h16', prev: 'M15 18l-6-6 6-6', next: 'M9 18l6-6-6-6' };
const AHEAD = 3; // days after today that always show, even when empty
const icon = (name) => svgIcon(ICONS[name]);

// Dates are local calendar days as 'YYYY-MM-DD', so "today" and "overdue" follow this device's clock.
const parseDay = (s) => { const [y, m, d] = s.split('-').map(Number); return new Date(y, m - 1, d); };
const addDays = (d, n) => new Date(d.getFullYear(), d.getMonth(), d.getDate() + n);
const todayIso = () => iso(new Date());
const dayName = (s, opts = { weekday: 'short', day: 'numeric', month: 'short' }) => parseDay(s).toLocaleDateString(undefined, opts);

export function init(ctx) {
  const { side, main } = ctx;
  const canEdit = () => ctx.access() === 'edit';
  let tasks = new Map();       // id -> task
  let kids = new Map();        // parentId, or 'day:<day>' for top-level tasks -> [task] in order
  let showUnscheduled = false; // Unscheduled only shows after it's picked in the sidebar
  let shown = new Set(store.get('tasks.states', STATES.map(([s]) => s)));
  let editing = false, stale = false, dragging = null, loaded = false;
  let refocus = null;          // a column's add box to focus again after a redraw
  let first = null;            // the day at the left of the window (or the next one shown after it)
  const added = new Set();     // later days brought in by stepping past the last column

  // ---- Layout -------------------------------------------------------------
  const todayBtn = h('button', { type: 'button', class: 'text-btn' }, 'Today');
  const prevBtn = h('button', { type: 'button', class: 'icon-btn task-step', 'aria-label': 'Show the day before' }, icon('prev'));
  const nextBtn = h('button', { type: 'button', class: 'icon-btn task-step', 'aria-label': 'Show the next day', title: 'Next day' }, icon('next'));
  const board = h('div', { class: 'task-board' });
  const hotPrev = h('div', { class: 'task-hot prev', 'aria-hidden': 'true' }, icon('prev'));
  const hotNext = h('div', { class: 'task-hot next', 'aria-hidden': 'true' }, icon('next'));
  const stage = h('div', { class: 'task-stage' }, board, hotPrev, hotNext);
  const status = h('p', { class: 'view-status', role: 'status' });
  main.append(h('header', { class: 'topbar tasks-bar' },
    h('button', { type: 'button', class: 'icon-btn menu-btn', 'aria-label': 'Show the sidebar' }, icon('menu')),
    h('h2', { class: 'tasks-week' }, 'Tasks'), h('span', { class: 'spacer' }),
    h('div', { class: 'task-nav' }, prevBtn, todayBtn, nextBtn)), stage, status);
  todayBtn.addEventListener('click', () => showDays(todayIso()));
  prevBtn.addEventListener('click', () => step(-1));
  nextBtn.addEventListener('click', () => step(1));

  // Leaves Unscheduled mode if it's on, then scrolls to a day.
  function showDays(day) {
    if (showUnscheduled) { showUnscheduled = false; render(); }
    scrollTo(day);
  }

  const filters = h('fieldset', { class: 'task-filter' }, h('legend', {}, 'Show'),
    ...STATES.map(([s, label]) => {
      const box = h('input', { type: 'checkbox', value: s });
      box.checked = shown.has(s);
      box.addEventListener('change', () => {
        if (box.checked) shown.add(s); else shown.delete(s);
        store.set('tasks.states', [...shown]);
        render();
      });
      return h('label', {}, box, ` ${label}`);
    }));
  const unscheduledBtn = h('button', { type: 'button', class: 'task-day', 'aria-pressed': 'false' });
  unscheduledBtn.addEventListener('click', () => {
    showUnscheduled = !showUnscheduled;
    render();
    if (!showUnscheduled) scrollTo(todayIso());
    ctx.closeSidebar();
  });
  const dayList = h('nav', { class: 'task-days', 'aria-label': 'Days with open tasks' });
  side.append(h('div', { class: 'brain-side-head' }, h('span', { class: 'cat-label' }, 'Open tasks by day')), dayList,
    unscheduledBtn, filters);

  let statusTimer;
  function setStatus(text, isError = false) {
    status.textContent = text;
    status.classList.toggle('error', isError);
    clearTimeout(statusTimer);
    if (text) statusTimer = setTimeout(() => { status.textContent = ''; }, isError ? 8000 : 3000);
  }

  // ---- Data ---------------------------------------------------------------
  async function load() {
    try {
      const r = await api('GET', `/api/tasks?today=${todayIso()}`);
      tasks = new Map(r.tasks.map((t) => [t.id, t]));
      kids = new Map();
      for (const t of [...tasks.values()].sort((a, b) => a.position - b.position || a.createdAt - b.createdAt)) {
        const key = t.parentId || `day:${t.day ?? ''}`;
        if (!kids.has(key)) kids.set(key, []);
        kids.get(key).push(t);
      }
      loaded = true;
      render();
    } catch (err) { setStatus(`Couldn't load tasks: ${err.message}`, true); }
  }

  // Runs a change, then reloads so every column shows the server's order.
  async function change(action, done) {
    try { await action(); if (done) setStatus(done); } catch (err) { setStatus(err.message, true); }
    await load();
  }
  const move = (id, where, done) => change(() => api('POST', `/api/tasks/${id}/move`, where), done);
  const patch = (id, body) => change(() => api('PATCH', `/api/tasks/${id}`, body));

  // ---- The window of days -------------------------------------------------
  // CSS sets --cols (two days above 1440px wide, one below), so the breakpoint lives in one place.
  const perView = () => showUnscheduled ? 1 : Number(getComputedStyle(board).getPropertyValue('--cols')) || 1;
  const columns = () => [...board.querySelectorAll('.task-col')];
  const reduced = matchMedia('(prefers-reduced-motion: reduce)');
  let target = 0;  // where the window should sit, so a scroll from anything else can be put right
  let steered = 0; // when the view last scrolled the board itself
  let settle;

  // The first column in view: `first`, or the next day shown after it (a hidden weekend
  // falls through), held back so the window never shows a gap at the end.
  function startIndex() {
    const cols = columns();
    if (showUnscheduled) return 0;
    let i = first ? cols.findIndex((c) => c.dataset.day >= first) : 0;
    if (i < 0) i = cols.length;
    return Math.max(0, Math.min(i, cols.length - perView()));
  }
  function align(smooth = false) {
    const cols = columns(), i = startIndex();
    if (cols.length) {
      target = cols[i].offsetLeft - cols[0].offsetLeft;
      steered = performance.now();
      clearTimeout(settle);
      board.scrollTo({ left: target, behavior: smooth && !reduced.matches ? 'smooth' : 'instant' });
    }
    updateNav(cols, i);
  }
  function updateNav(cols, i) {
    const behind = cols.slice(0, i).filter((c) => c.classList.contains('overdue-col')).length;
    prevBtn.disabled = showUnscheduled || i === 0;
    nextBtn.disabled = showUnscheduled;
    prevBtn.classList.toggle('overdue', behind > 0);
    prevBtn.title = behind ? `Day before (${behind === 1 ? 'an overdue day' : `${behind} overdue days`} this way)` : 'Day before';
    hotPrev.classList.toggle('off', prevBtn.disabled);
    hotNext.classList.toggle('off', nextBtn.disabled);
  }
  // Moves the window a day. Past the last column the next day (skipping hidden weekends) is
  // brought in, so there's always somewhere to go. It's added in place rather than redrawn,
  // because a redraw mid-drag would remove the card being dragged.
  function step(dir) {
    if (showUnscheduled) return;
    let cols = columns();
    const i = startIndex() + dir;
    if (i < 0 || !cols.length) return;
    if (i + perView() > cols.length) {
      let d = cols[cols.length - 1].dataset.day;
      do d = iso(addDays(parseDay(d), 1)); while (skip(d));
      added.add(d);
      board.append(dayColumn(d));
      cols = columns();
    }
    first = cols[i].dataset.day;
    align(true);
  }
  // A day that isn't shown (a hidden weekend) falls through to the next day that is.
  function scrollTo(key) {
    first = key;
    align(true);
    const col = columns().find((c) => c.dataset.day >= key);
    if (!col) return;
    col.classList.add('flash');
    setTimeout(() => col.classList.remove('flash'), 900);
  }
  // Nothing scrolls the board by hand (overflow is hidden), but focus moving into a column
  // out of view, or find in page, still can. Once that settles, the nearest column becomes
  // the start and the window lines up on it again. A smooth scroll the view started itself
  // can pause between frames, so leave it a second to finish first.
  board.addEventListener('scroll', () => {
    clearTimeout(settle);
    settle = setTimeout(function check() {
      const wait = steered + 1000 - performance.now();
      if (wait > 0) { settle = setTimeout(check, wait); return; }
      if (showUnscheduled || Math.abs(board.scrollLeft - target) < 2) return;
      const cols = columns(), x = board.scrollLeft + cols[0].offsetLeft;
      first = cols.reduce((a, c) => Math.abs(c.offsetLeft - x) < Math.abs(a.offsetLeft - x) ? c : a).dataset.day;
      align(true);
    }, 150);
  });
  new ResizeObserver(() => align()).observe(board);
  matchMedia('(min-width: 1441px)').addEventListener('change', () => align());

  // Touch: a sideways swipe steps a day, since the board doesn't scroll.
  let touch = null;
  board.addEventListener('touchstart', (e) => { touch = e.touches.length === 1 ? { x: e.touches[0].clientX, y: e.touches[0].clientY } : null; }, { passive: true });
  board.addEventListener('touchend', (e) => {
    if (!touch) return;
    const t = e.changedTouches[0], dx = t.clientX - touch.x, dy = t.clientY - touch.y;
    touch = null;
    if (Math.abs(dx) > 60 && Math.abs(dx) > 2 * Math.abs(dy)) step(dx < 0 ? 1 : -1);
  }, { passive: true });

  // While a task is dragged, holding it over either edge of the board steps a day, and keeps
  // stepping while it stays there. The edges aren't drop targets.
  function hotspot(el, dir) {
    let timer = null;
    const stop = () => { clearTimeout(timer); timer = null; el.classList.remove('hot'); };
    const tick = (wait) => { timer = setTimeout(() => { step(dir); tick(700); }, wait); };
    el.addEventListener('dragenter', () => {
      if (!dragging || timer) return;
      clearMarks();
      el.classList.add('hot');
      tick(450);
    });
    el.addEventListener('dragleave', stop);
    return stop;
  }
  const stopHot = [hotspot(hotPrev, -1), hotspot(hotNext, 1)];

  const childrenOf = (t) => kids.get(t.id) || [];
  const isOverdue = (t) => !t.parentId && t.day && t.day < todayIso() && t.state !== 'complete';
  // A task shows if its state is ticked in the filter, or any task under it shows.
  const visible = (t) => shown.has(t.state) || childrenOf(t).some(visible);
  function descendants(t) { return childrenOf(t).flatMap((c) => [c, ...descendants(c)]); }
  function siblingsOf(t) { return kids.get(t.parentId || `day:${t.day ?? ''}`) || []; }

  // ---- Rendering ----------------------------------------------------------
  // Unfinished bottom-level tasks in these stacks: what's actually left to do.
  const left = (list) => list.reduce((n, t) => {
    const below = childrenOf(t);
    return n + (below.length ? left(below) : t.state !== 'complete' ? 1 : 0);
  }, 0);

  // The days the board shows: earlier days only while they hold unfinished work, today and
  // the next AHEAD days always, and later days only when a task is on them. With the
  // profile's hideWeekends preference, Saturdays and Sundays are skipped when counting ahead
  // (so it's the next AHEAD weekdays) and show only when a task is on them, today included.
  const weekend = (d) => [0, 6].includes(parseDay(d).getDay());
  const skip = (d) => ctx.me()?.prefs?.hideWeekends && weekend(d);
  function boardDays() {
    const today = todayIso(), out = new Set();
    if (!skip(today)) out.add(today);
    for (let d = today, n = 0; n < AHEAD;) {
      d = iso(addDays(parseDay(d), 1));
      if (!skip(d)) { out.add(d); n++; }
    }
    for (const [k, list] of kids) {
      if (!k.startsWith('day:') || k === 'day:') continue;
      const d = k.slice(4);
      if (d >= today || list.some((t) => left([t]) > 0 || t.state !== 'complete')) out.add(d);
    }
    for (const d of added) if (d > today && !skip(d)) out.add(d);
    return [...out].sort();
  }

  function render() {
    if (editing || dragging) { stale = true; return; }
    stale = false;
    // Unscheduled is its own mode: picking it in the sidebar swaps the days out for it.
    const cols = showUnscheduled
      ? [column({ key: 'none', day: null, title: 'Unscheduled', sub: 'No day yet', list: kids.get('day:') || [] })]
      : boardDays().map(dayColumn);
    board.classList.toggle('single', showUnscheduled);
    board.replaceChildren(...cols);
    align();
    renderDays();
    if (refocus) { board.querySelector(`[data-day="${refocus}"] .task-add input`)?.focus(); refocus = null; }
  }

  function dayColumn(d) {
    const today = todayIso();
    return column({
      key: d, day: d, past: d < today, title: dayName(d, { weekday: 'long' }),
      sub: dayName(d, { day: 'numeric', month: 'short', year: d.slice(0, 4) === today.slice(0, 4) ? undefined : 'numeric' }),
      list: kids.get(`day:${d}`) || []
    });
  }

  // past: an earlier day kept only for its unfinished tasks. Nothing new is added or
  // dropped there; tasks leave it by being finished or moved.
  function column({ key, day = null, title, sub, list, past = false }) {
    const isToday = day === todayIso();
    const drop = !past;
    const shownList = list.filter(visible);
    const body = h('div', { class: 'task-list' }, ...shownList.map((t) => card(t)));
    if (!shownList.length) body.append(h('p', { class: 'task-empty' }, list.length ? 'Nothing matches the filter.' : canEdit() ? 'No tasks. Add one below or drag one here.' : 'No tasks.'));
    const open = left(list);
    const col = h('section', { class: `task-col${isToday ? ' today' : ''}${past ? ' overdue-col' : ''}`, 'data-day': key, 'aria-label': `${title}, ${sub}${past ? ', overdue' : ''}` },
      h('header', { class: 'task-col-head' },
        h('div', {}, h('strong', {}, title), isToday ? h('span', { class: 'badge' }, 'Today') : null,
          h('small', {}, past ? `${sub} · overdue` : sub)),
        h('span', { class: 'cat-count', title: `${open} left to do` }, String(open))),
      body);
    if (drop && canEdit()) {
      col.append(addBox(day, key));
      dropColumn(body, day);
    }
    return col;
  }

  function addBox(day, key) {
    const input = h('input', { type: 'text', placeholder: 'Add a task', 'aria-label': `Add a task to ${key === 'none' ? 'Unscheduled' : dayName(day, { weekday: 'long', day: 'numeric', month: 'long' })}`, maxlength: '200' });
    const form = h('form', { class: 'task-add' }, input);
    form.addEventListener('submit', (e) => {
      e.preventDefault();
      const title = input.value.trim();
      if (!title) return;
      input.value = '';
      refocus = key;
      change(() => api('POST', '/api/tasks', { title, day }));
    });
    return form;
  }

  function card(t) {
    const children = childrenOf(t).filter(visible);
    const all = descendants(t), done = all.filter((c) => c.state === 'complete').length;
    const stateBtn = h('button', { type: 'button', class: `task-state ${t.state}`, disabled: !canEdit(),
      title: canEdit() ? `${STATE_NAME[t.state]}. Click for ${STATE_NAME[NEXT_STATE[t.state]].toLowerCase()}` : STATE_NAME[t.state],
      'aria-label': `${STATE_NAME[t.state]}. Change to ${STATE_NAME[NEXT_STATE[t.state]].toLowerCase()}` });
    stateBtn.addEventListener('click', () => patch(t.id, { state: NEXT_STATE[t.state] }));
    const title = canEdit()
      ? h('button', { type: 'button', class: 'task-title', title: 'Rename' }, t.title)
      : h('span', { class: 'task-title' }, t.title);
    if (canEdit()) title.addEventListener('click', () => rename(t, title));
    const more = canEdit() ? h('button', { type: 'button', class: 'icon-btn task-more', 'aria-haspopup': 'menu', 'aria-label': `Options for ${t.title}` }, icon('more')) : null;
    more?.addEventListener('click', () => openMenu(more, taskMenu(t)));
    const overdue = isOverdue(t);
    const meta = [
      overdue ? h('span', { class: 'task-due overdue' }, 'Overdue') : null,
      all.length ? h('span', { class: 'task-progress', title: `${done} of ${all.length} subtasks complete` }, `${done}/${all.length}`) : null
    ].filter(Boolean);
    const el = h('div', { class: `task ${t.state}${overdue ? ' overdue' : ''}`, 'data-id': t.id },
      h('div', { class: 'task-row' }, stateBtn, title, more),
      meta.length ? h('div', { class: 'task-meta' }, ...meta) : null,
      t.note ? h('p', { class: 'task-note' }, t.note) : null,
      children.length ? h('div', { class: 'task-children' }, ...children.map((c) => card(c))) : null);
    if (canEdit()) dragCard(el, t);
    return el;
  }

  // Sidebar: every day on the board with work left, then the Unscheduled toggle.
  function renderDays() {
    const today = todayIso();
    const rows = boardDays().map((day) => [day, left(kids.get(`day:${day}`) || [])]).filter(([, n]) => n).map(([day, n]) => {
      const b = h('button', { type: 'button', class: `task-day${day < today ? ' overdue' : ''}${day === today ? ' today' : ''}` },
        h('span', {}, day === today ? `Today, ${dayName(day)}` : dayName(day, { weekday: 'short', day: 'numeric', month: 'short', year: day.slice(0, 4) === today.slice(0, 4) ? undefined : 'numeric' })),
        h('span', { class: 'cat-count' }, String(n)));
      b.addEventListener('click', () => { showDays(day); ctx.closeSidebar(); });
      return b;
    });
    dayList.replaceChildren(...(rows.length ? rows : [h('p', { class: 'cat-hint' }, 'Nothing left to do on any day.')]));
    const n = left(kids.get('day:') || []);
    unscheduledBtn.replaceChildren(h('span', {}, showUnscheduled ? 'Back to days' : 'Show unscheduled'), h('span', { class: 'cat-count' }, String(n)));
    unscheduledBtn.setAttribute('aria-pressed', String(showUnscheduled));
  }

  // ---- Editing ------------------------------------------------------------
  // Swaps the title for a text box. Enter or leaving it saves; Esc cancels.
  function rename(t, target) {
    editing = true;
    const input = h('input', { type: 'text', class: 'inline-edit', maxlength: '200', 'aria-label': 'Task name' });
    input.value = t.title;
    target.replaceWith(input);
    input.closest('.task')?.setAttribute('draggable', 'false');
    input.focus();
    input.select();
    let finished = false;
    const finish = async (keep) => {
      if (finished) return;
      finished = true;
      editing = false;
      const next = input.value.replace(/\s+/g, ' ').trim();
      if (keep && next && next !== t.title) await patch(t.id, { title: next });
      else render();
    };
    input.addEventListener('keydown', (e) => {
      if (e.key === 'Enter') { e.preventDefault(); finish(true); }
      if (e.key === 'Escape') { e.preventDefault(); finish(false); }
    });
    input.addEventListener('blur', () => finish(true));
  }

  function taskMenu(t) {
    const sibs = siblingsOf(t), i = sibs.indexOf(t), above = sibs[i - 1];
    const parent = t.parentId ? tasks.get(t.parentId) : null;
    const today = todayIso(), tomorrow = iso(addDays(new Date(), 1));
    // Options that don't apply are hidden rather than greyed out, to keep the menu short.
    // State isn't here: the round button on the card sets it.
    const toDay = (day, label) => ({ label, indent: true, hidden: !t.parentId && (t.day ?? null) === day, action: () => move(t.id, { day }, `Moved to ${label.toLowerCase()}.`) });
    const items = [
      { label: 'Rename', action: () => { const el = board.querySelector(`[data-id="${t.id}"] .task-title`); if (el) rename(t, el); } },
      { label: t.note ? 'Edit note' : 'Add a note', action: async () => {
        const note = await promptDialog({ title: 'Task note', label: t.title, value: t.note, multiline: true, submit: 'Save note' });
        if (note !== null) patch(t.id, { note });
      } },
      { label: 'Add a subtask', action: async () => {
        const title = await promptDialog({ title: 'New subtask', label: `Under "${t.title}"`, submit: 'Add subtask', maxLength: 200 });
        if (title?.trim()) change(() => api('POST', '/api/tasks', { title, parentId: t.id }));
      } },
      { heading: 'Move to' },
      toDay(today, 'Today'), toDay(tomorrow, 'Tomorrow'), toDay(null, 'Unscheduled'),
      { label: 'Pick a date…', indent: true, action: async () => {
        const day = await promptDialog({ title: 'Move to a day', label: 'Date', type: 'date', value: t.day || today, submit: 'Move task' });
        if (day) move(t.id, { day }, `Moved to ${dayName(day)}.`);
      } },
      { heading: 'Arrange' },
      { label: 'Move up', indent: true, hidden: i <= 0, action: () => move(t.id, { parentId: t.parentId, day: t.day, beforeId: sibs[i - 1]?.id }) },
      { label: 'Move down', indent: true, hidden: i >= sibs.length - 1, action: () => move(t.id, { parentId: t.parentId, day: t.day, beforeId: sibs[i + 2]?.id ?? null }) },
      { label: above ? `Make a subtask of "${above.title}"` : 'Make a subtask of the task above', indent: true, hidden: !above,
        action: () => move(t.id, { parentId: above.id }) },
      { label: parent ? `Move out of "${parent.title}"` : 'Move out of its parent', indent: true, hidden: !parent,
        action: () => { const ps = siblingsOf(parent); move(t.id, { parentId: parent.parentId, day: parent.day, beforeId: ps[ps.indexOf(parent) + 1]?.id ?? null }); } },
      { label: 'Delete', danger: true, action: async () => {
        const n = descendants(t).length;
        if (await confirmDialog({ title: `Delete "${t.title}"?`, danger: true, confirm: n ? 'Delete task and subtasks' : 'Delete task',
          message: `${n ? `Its ${n === 1 ? 'subtask goes' : `${n} subtasks go`} too. ` : ''}This can't be undone.` })) {
          change(() => api('DELETE', `/api/tasks/${t.id}`), 'Task deleted.');
        }
      } }
    ];
    return items;
  }

  // ---- Drag and drop ------------------------------------------------------
  // Where a drop on a card lands: near the top edge before it, near the bottom after it,
  // in the middle inside it as a subtask.
  function zone(e, row) {
    const r = row.getBoundingClientRect();
    const y = (e.clientY - r.top) / r.height;
    return y < 0.3 ? 'before' : y > 0.7 ? 'after' : 'inside';
  }
  function clearMarks() {
    for (const el of board.querySelectorAll('.drop-before, .drop-after, .drop-inside, .drop-target')) el.classList.remove('drop-before', 'drop-after', 'drop-inside', 'drop-target');
  }
  // True if dropping the dragged task on this one would put it inside itself.
  const ownBranch = (t) => !dragging || t.id === dragging || descendants(tasks.get(dragging)).includes(t);

  function dragCard(el, t) {
    el.draggable = true;
    const row = el.querySelector('.task-row');
    el.addEventListener('dragstart', (e) => {
      e.stopPropagation(); // a subtask drags alone, not its parent
      dragging = t.id;
      e.dataTransfer.effectAllowed = 'move';
      e.dataTransfer.setData('text/plain', t.id);
      requestAnimationFrame(() => { el.classList.add('drag-source'); stage.classList.add('dragging'); });
    });
    el.addEventListener('dragend', () => {
      el.classList.remove('drag-source');
      stage.classList.remove('dragging');
      stopHot.forEach((stop) => stop());
      dragging = null;
      clearMarks();
      if (stale) render();
    });
    row.addEventListener('dragover', (e) => {
      if (ownBranch(t)) return;
      e.preventDefault();
      e.stopPropagation();
      clearMarks();
      el.classList.add(`drop-${zone(e, row)}`);
    });
    row.addEventListener('dragleave', (e) => { if (!row.contains(e.relatedTarget)) el.classList.remove('drop-before', 'drop-after', 'drop-inside'); });
    row.addEventListener('drop', (e) => {
      if (ownBranch(t)) return;
      e.preventDefault();
      e.stopPropagation();
      const id = dragging, where = zone(e, row);
      dragging = null;
      clearMarks();
      if (where === 'inside') return move(id, { parentId: t.id }, `Now a subtask of "${t.title}".`);
      const sibs = siblingsOf(t).filter((s) => s.id !== id);
      const beforeId = where === 'before' ? t.id : sibs[sibs.indexOf(t) + 1]?.id ?? null;
      move(id, { parentId: t.parentId, day: t.parentId ? null : t.day, beforeId });
    });
  }

  function dropColumn(body, day) {
    body.addEventListener('dragover', (e) => {
      if (!dragging) return;
      e.preventDefault();
      clearMarks();
      body.classList.add('drop-target');
    });
    body.addEventListener('dragleave', (e) => { if (!body.contains(e.relatedTarget)) body.classList.remove('drop-target'); });
    body.addEventListener('drop', (e) => {
      if (!dragging) return;
      e.preventDefault();
      const id = dragging;
      dragging = null;
      clearMarks();
      move(id, { day }, day ? `Moved to ${dayName(day)}.` : 'Moved to Unscheduled.');
    });
  }

  // Past midnight the board's days change, so fetch again for the new today.
  let lastDay = todayIso();
  setInterval(() => { if (todayIso() !== lastDay) { lastDay = todayIso(); if (loaded) load(); } }, 60 * 1000);

  return {
    // Opens on today at the left; overdue days sit behind it, and the back arrow turns red.
    show() {
      ctx.setRoute('');
      first = todayIso();
      load().then(() => align());
    },
    onServer(m) { if (m.t === 'tasks_changed' && loaded) load(); },
    profileChanged() { if (loaded) render(); }
  };
}
