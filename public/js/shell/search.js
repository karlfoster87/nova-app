// The search palette: Ctrl+K (Cmd+K on a Mac), or the search button in the header bar on any
// screen. One box finds chats by title, brain files by name and by their text, tasks, sticky
// notes and skills, grouped, and opens the one picked in its own view. Chats and skills are
// searched here, from what the page already has; the rest comes from /api/search, which only
// answers for views this profile can read (server routes/search.js).
import { $, h, svgIcon } from '../lib/dom.js';
import { api } from '../lib/api.js';
import { localDay } from '../lib/format.js';
import { state } from '../state.js';
import { goTo, goToChat, startChat } from './views.js';

const ICONS = {
  chat: 'M20 12a8 8 0 0 1-11.6 7.1L4 20l1-4.6A8 8 0 1 1 20 12Z',
  file: 'M6 3h8l4 4v14H6ZM14 3v4h4',
  text: 'M6 3h8l4 4v14H6ZM14 3v4h4M9 12h6M9 16h6',
  task: 'M4 4h16v16H4ZM8 12l3 3 5-6',
  note: 'M6 3h9l4 4v14H6ZM14 3v5h5M9 12h7M9 16h5',
  skill: 'M7 4 3 12l4 8M17 4l4 8-4 8M14 4l-4 16',
  search: 'M16 16l4 4M18 11a7 7 0 1 1-14 0 7 7 0 0 1 14 0'
};
const MAC = /Mac|iPhone|iPad/.test(navigator.platform || navigator.userAgent);
const STATE_WORDS = { waiting: 'Waiting', in_progress: 'In progress', complete: 'Complete' };
const SKILLS_FRESH = 60 * 1000;

const btn = $('searchBtn');
btn.title = `Search chats, the brain, tasks, notes and skills (${MAC ? '⌘K' : 'Ctrl+K'})`;

let dialog = null;      // the open palette
let skills = null, skillsAt = 0, skillsLoading = null;

// Skills and commands, as the composer's / menu lists them. Fetched when the palette opens,
// kept for a minute; the first fetch can take a few seconds while Claude Code starts.
function loadSkills() {
  if (skills && Date.now() - skillsAt < SKILLS_FRESH) return Promise.resolve(skills);
  skillsLoading ??= api('GET', '/api/commands')
    .then((list) => { skills = list; skillsAt = Date.now(); return list; })
    .catch(() => skills || [])
    .finally(() => { skillsLoading = null; });
  return skillsLoading;
}

const wordsOf = (q) => q.toLowerCase().split(/\s+/).filter(Boolean);
const hasAll = (text, words) => { const t = String(text || '').toLowerCase(); return words.every((w) => t.includes(w)); };
const firstLine = (text) => String(text || '').split('\n').map((l) => l.replace(/^[\s#>*\-+]+|[*_`]+/g, '').trim()).find(Boolean) || '';

// Text with every typed word marked, built as nodes (never as HTML).
function marked(text, words) {
  const s = String(text || '');
  if (!words.length) return [s];
  const re = new RegExp(`(${words.map((w) => w.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')).join('|')})`, 'gi');
  return s.split(re).map((part, i) => (i % 2 ? h('mark', {}, part) : part)).filter((p) => p !== ''); // odd pieces are the matches
}

export function openSearch() {
  if (dialog) { dialog.querySelector('input').select(); return; }
  const back = document.activeElement;
  const input = h('input', { type: 'search', class: 'search-input', placeholder: 'Search chats, brain, tasks, notes and skills',
    'aria-label': 'Search', autocomplete: 'off', spellcheck: 'false', maxlength: '200', role: 'combobox', 'aria-expanded': 'true',
    'aria-controls': 'searchResults', 'aria-autocomplete': 'list' });
  const list = h('div', { class: 'search-results', id: 'searchResults', role: 'listbox', 'aria-label': 'Results' });
  const hint = h('p', { class: 'search-hint' }, h('span', {}, h('kbd', {}, '↑'), h('kbd', {}, '↓'), ' to move'),
    h('span', {}, h('kbd', {}, 'Enter'), ' to open'), h('span', {}, h('kbd', {}, 'Esc'), ' to close'));
  const close = h('button', { type: 'button', class: 'text-btn search-close' }, 'Close');
  dialog = h('dialog', { class: 'search-dialog', 'aria-label': 'Search' },
    h('div', { class: 'search-box search-field' }, svgIcon(ICONS.search), input, close), list, hint);

  let items = [], active = 0, seq = 0, timer, server = null, serverQ = null;

  function shut() {
    if (!dialog) return;
    clearTimeout(timer);
    const d = dialog;
    dialog = null;
    if (d.open) d.close();
    d.remove();
    if (back?.isConnected) back.focus({ preventScroll: true });
  }
  dialog.addEventListener('cancel', (e) => { e.preventDefault(); shut(); });
  dialog.addEventListener('click', (e) => { if (e.target === dialog) shut(); }); // the backdrop
  close.addEventListener('click', shut);

  // Picking a result closes the palette first, so the view it opens gets the focus.
  const open = (item) => { shut(); item.run(); };

  // ---- Results ----------------------------------------------------------
  function groups(q) {
    const words = wordsOf(q);
    const out = [];
    const chats = (words.length ? state.chats.filter((c) => c.title && hasAll(c.title, words)) : state.chats.filter((c) => c.title).slice(0, 6)).slice(0, 8);
    const catName = (id) => state.categories.find((c) => c.id === id)?.name || '';
    if (chats.length) {
      out.push({ label: words.length ? 'Chats' : 'Recent chats', items: chats.map((c) => ({ icon: 'chat', title: c.title, detail: catName(c.category_id), run: () => goToChat(c.id) })) });
    }
    if (!words.length) return out;
    const s = server && serverQ === q ? server : null;
    if (s?.files?.length) {
      out.push({ label: 'Brain files', items: s.files.map((f) => ({ icon: 'file', title: f.name, detail: f.path.includes('/') ? f.path.slice(0, f.path.lastIndexOf('/')) : 'Brain folder',
        run: () => goTo({ id: 'brain', arg: f.path }) })) });
    }
    if (s?.text?.length) {
      out.push({ label: 'In brain files', items: s.text.map((f) => ({ icon: 'text', title: f.name, detail: f.path, snippet: f.snippet,
        run: () => goTo({ id: 'brain', arg: f.path }) })) });
    }
    if (s?.tasks?.length) {
      out.push({ label: 'Tasks', items: s.tasks.map((t) => ({ icon: 'task', title: t.title,
        detail: [STATE_WORDS[t.state], t.day ? new Date(`${t.day}T12:00`).toLocaleDateString(undefined, { weekday: 'short', day: 'numeric', month: 'short' }) : 'Unscheduled', t.parent ? `in ${t.parent}` : ''].filter(Boolean).join(' · '),
        snippet: t.note && hasAll(t.note, words) ? firstLine(t.note) : '', run: () => goTo({ id: 'tasks', arg: t.id }) })) });
    }
    if (s?.notes?.length) {
      out.push({ label: 'Sticky notes', items: s.notes.map((n) => {
        const lines = n.text.split('\n').filter((l) => l.trim());
        const hit = lines.find((l) => words.some((w) => l.toLowerCase().includes(w))) || '';
        return { icon: 'note', title: firstLine(n.text) || 'Empty note', detail: n.shared ? (n.mine ? 'Shown to everyone' : `Shared by ${n.owner}`) : '',
          snippet: hit && firstLine(hit) !== firstLine(n.text) ? hit.replace(/^[\s>*\-+]+/, '') : '', color: n.color, run: () => goTo({ id: 'notes', arg: n.id }) };
      }) });
    }
    const sk = (skills || []).filter((c) => hasAll(`${c.name} ${c.description}`, words)).slice(0, 6);
    if (sk.length) {
      out.push({ label: 'Skills and commands', items: sk.map((c) => ({ icon: 'skill', title: `/${c.name}`, detail: c.source === 'brain' ? 'In this brain' : 'Built in',
        snippet: c.description, run: () => startChat(`/${c.name} `) })) });
    }
    return out;
  }

  function render() {
    const q = input.value.replace(/\s+/g, ' ').trim();
    const words = wordsOf(q);
    const gs = groups(q);
    items = gs.flatMap((g) => g.items);
    active = Math.min(active, Math.max(items.length - 1, 0));
    let i = 0;
    const rows = gs.map((g) => h('div', { class: 'search-group', role: 'group', 'aria-label': g.label },
      h('p', { class: 'search-group-label', 'aria-hidden': 'true' }, g.label),
      ...g.items.map((item) => {
        const n = i++;
        const el = h('div', { class: `search-item${n === active ? ' active' : ''}`, role: 'option', id: `search-opt-${n}`, 'aria-selected': String(n === active) },
          h('span', { class: `search-icon${item.color ? ` note-${item.color}` : ''}` }, svgIcon(ICONS[item.icon])),
          h('span', { class: 'search-text' },
            h('span', { class: 'search-title' }, ...marked(item.title, words), item.detail ? h('span', { class: 'search-detail' }, item.detail) : null),
            item.snippet ? h('span', { class: 'search-snippet' }, ...marked(item.snippet, words)) : null));
        el.addEventListener('click', () => open(item));
        el.addEventListener('mousemove', () => { if (active !== n) { active = n; paintActive(); } });
        return el;
      })));
    const waiting = words.length && serverQ !== q;
    if (!items.length) rows.push(h('p', { class: 'search-empty' }, waiting ? 'Searching…' : words.length ? 'Nothing matches. Try fewer or shorter words.' : 'Type to search.'));
    else if (waiting) rows.push(h('p', { class: 'search-empty small' }, 'Searching the brain, tasks and notes…'));
    list.replaceChildren(...rows);
    paintActive();
  }

  function paintActive() {
    for (const el of list.querySelectorAll('.search-item')) {
      const on = el.id === `search-opt-${active}`;
      el.classList.toggle('active', on);
      el.setAttribute('aria-selected', String(on));
      if (on) el.scrollIntoView({ block: 'nearest' });
    }
    if (items.length) input.setAttribute('aria-activedescendant', `search-opt-${active}`); else input.removeAttribute('aria-activedescendant');
  }

  async function fetchServer() {
    const q = input.value.replace(/\s+/g, ' ').trim();
    const n = ++seq;
    if (!q) { server = null; serverQ = null; render(); return; }
    try {
      const r = await api('GET', `/api/search?q=${encodeURIComponent(q)}&today=${localDay()}`);
      if (n !== seq) return;
      server = r;
    } catch {
      if (n !== seq) return;
      server = {};
    }
    serverQ = q;
    render();
  }

  input.addEventListener('input', () => {
    active = 0;
    render();
    clearTimeout(timer);
    timer = setTimeout(fetchServer, 150);
  });
  input.addEventListener('keydown', (e) => {
    if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
      e.preventDefault();
      if (!items.length) return;
      active = (active + (e.key === 'ArrowDown' ? 1 : -1) + items.length) % items.length;
      paintActive();
    } else if (e.key === 'Enter') {
      e.preventDefault();
      if (items[active]) open(items[active]);
    } else if (e.key === 'Escape') {
      e.preventDefault(); // a search box would only clear itself; Escape closes the palette
      shut();
    }
  });

  document.body.append(dialog);
  dialog.showModal();
  input.focus();
  render();
  loadSkills().then(() => { if (dialog) render(); });
}

// Ctrl+K or Cmd+K from anywhere, even while typing; again closes it.
document.addEventListener('keydown', (e) => {
  if (e.key?.toLowerCase() !== 'k' || !(MAC ? e.metaKey : e.ctrlKey) || e.altKey || e.shiftKey) return;
  e.preventDefault();
  if (dialog) dialog.dispatchEvent(new Event('cancel')); else openSearch();
});
btn.addEventListener('click', () => openSearch());
