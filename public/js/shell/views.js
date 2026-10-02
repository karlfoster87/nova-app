// Views: Chats is always there. Brain, Tasks and Notes are listed by the server with this
// profile's access level, loaded on first use from views/, and each owns a sidebar pane and a
// main pane. The server checks access on every route; this only decides what to show.
// Also the counts on the view tabs, and routes like #brain/folder/file.md, which reopen a view
// after a reload and are how the installed app's shortcuts open one.
import { $, h, svgIcon } from '../lib/dom.js';
import { store } from '../lib/store.js';
import { localDay } from '../lib/format.js';
import { state, els } from '../state.js';
import { openChat, newChat, sidebar } from '../chat/chats.js';

// A new view adds its module here (and its entry in server/accounts/access.js VIEWS).
const VIEW_MODULES = { brain: '../views/brain.js', tasks: '../views/tasks.js', notes: '../views/notes.js' };
const VIEW_ICONS = {
  chats: ['M20 12a8 8 0 0 1-11.6 7.1L4 20l1-4.6A8 8 0 1 1 20 12Z', 'M8.5 12h.01M12 12h.01M15.5 12h.01'],
  brain: ['M9.5 3.5A3 3 0 0 0 6.6 6 3 3 0 0 0 4.5 11a3 3 0 0 0 1.2 4.7A3 3 0 0 0 9.5 20a2.5 2.5 0 0 0 2.5-2.5v-11a3 3 0 0 0-2.5-3Z',
    'M14.5 3.5A3 3 0 0 1 17.4 6a3 3 0 0 1 2.1 5 3 3 0 0 1-1.2 4.7 3 3 0 0 1-3.8 4.3A2.5 2.5 0 0 1 12 17.5', 'M8 9.5a2 2 0 0 1 2 1.5M16 9.5a2 2 0 0 0-2 1.5M9 15a2 2 0 0 1 3-1M15 15a2 2 0 0 0-3-1'],
  tasks: ['M4 4h16v16H4Z', 'm8 12 3 3 5-6'],
  notes: ['M6 3h9l4 4v14H6Z', 'M14 3v5h5M9 12h7M9 16h5']
};

export const views = new Map(); // id -> the view's controller once loaded
let view = 'chats';
const tabs = $('viewTabs');

function allowedViews() {
  const access = state.me?.access || {};
  return [{ id: 'chats', label: 'Chats' }, ...(state.me?.views || []).filter((v) => VIEW_MODULES[v.id] && access[v.id] && access[v.id] !== 'none')];
}

export function renderViewTabs() {
  const list = allowedViews();
  tabs.hidden = list.length < 2;
  tabs.replaceChildren(...list.map((v) => h('button', {
    type: 'button', role: 'tab', 'aria-selected': String(v.id === view), tabindex: v.id === view ? 0 : -1,
    'data-tab': v.id, 'data-label': v.label, onclick: () => showView(v.id)
  }, svgIcon(VIEW_ICONS[v.id] || VIEW_ICONS.notes), h('span', {}, v.label), h('span', { class: 'tab-badge', hidden: true }))));
  if (!list.some((v) => v.id === view)) showView('chats', { force: true }); // access was taken away
  paintBadges();
}

tabs.addEventListener('keydown', (e) => {
  if (e.key !== 'ArrowRight' && e.key !== 'ArrowLeft') return;
  const all = [...tabs.children];
  const next = all[(all.indexOf(document.activeElement) + (e.key === 'ArrowRight' ? 1 : all.length - 1)) % all.length];
  next?.focus();
  next?.click();
});

// ---- Badges ---------------------------------------------------------------------
// Today's unfinished tasks and active notes. The server counts, so they're right before a
// view has ever been opened; today is this device's date.
let badges = {};
const BADGE_TEXT = { tasks: (n) => `${n} ${n === 1 ? 'task' : 'tasks'} left today`, notes: (n) => `${n} active ${n === 1 ? 'note' : 'notes'}` };

export async function refreshBadges() {
  try {
    const res = await fetch(`/api/badges?today=${localDay()}`);
    if (res.ok) { badges = await res.json(); paintBadges(); }
  } catch {} // counts are a convenience; the next change or minute tries again
}

function paintBadges() {
  for (const b of tabs.children) {
    const n = badges[b.dataset.tab], badge = b.querySelector('.tab-badge');
    if (!badge) continue;
    badge.hidden = !n;
    badge.textContent = n > 99 ? '99+' : String(n || '');
    if (n) b.title = BADGE_TEXT[b.dataset.tab](n); else b.removeAttribute('title');
    b.setAttribute('aria-label', n ? `${b.dataset.label}, ${BADGE_TEXT[b.dataset.tab](n)}` : b.dataset.label);
  }
}
let badgeDay = localDay();
setInterval(() => { if (localDay() !== badgeDay) { badgeDay = localDay(); refreshBadges(); } }, 60 * 1000);

// ---- Switching views ----------------------------------------------------------------

function paneFor(kind, id) {
  let el = document.querySelector(`[data-${kind}="${id}"]`);
  if (!el) {
    el = h('div', { class: kind === 'side' ? 'side-pane' : `view view-${id}`, [`data-${kind}`]: id, hidden: true });
    (kind === 'side' ? els.sidebar : $('main')).append(el);
  }
  return el;
}

// arg is view-specific: for the brain, a file path to open.
async function showView(id, { arg, force = false } = {}) {
  if (id !== view && !force && views.get(view)?.canLeave?.() === false) return;
  if (id !== 'chats' && !views.has(id)) {
    try {
      const mod = await import(VIEW_MODULES[id]);
      views.set(id, mod.init({
        side: paneFor('side', id), main: paneFor('view', id),
        access: () => state.me?.access?.[id] || 'none', me: () => state.me,
        setRoute: (route) => history.replaceState(null, '', route ? `#${id}/${route}` : `#${id}`),
        closeSidebar: () => els.sidebar.classList.remove('open')
      }));
    } catch (err) {
      console.error(err);
      sidebar?.notify?.(`Couldn't open that view: ${err.message}`);
      return;
    }
  }
  const leaving = view;
  view = id;
  for (const el of document.querySelectorAll('[data-side], [data-view]')) {
    el.hidden = (el.dataset.side || el.dataset.view) !== id;
  }
  for (const b of tabs.children) {
    b.setAttribute('aria-selected', String(b.dataset.tab === id));
    b.tabIndex = b.dataset.tab === id ? 0 : -1;
  }
  if (leaving !== id) views.get(leaving)?.hide?.();
  views.get(id)?.show?.(arg);
  if (id === 'chats') history.replaceState(null, '', location.pathname);
  store.set('view', id);
}

// ---- Routes -----------------------------------------------------------------------

// #view or #view/arg, e.g. #brain/folder/file.md, #tasks, or #chats/new for a new chat.
export function routeFromHash(hash = location.hash) {
  const m = /^#([a-z]+)(?:\/(.*))?$/.exec(hash);
  if (!m) return null;
  let arg = m[2] || undefined;
  try { if (arg) arg = decodeURIComponent(arg); } catch { arg = undefined; }
  return { id: m[1], arg };
}

// Follows a route, from the address bar or a launch of the app. Views this profile can't use
// are ignored, so a shortcut to one just opens Nova.
export async function goTo(route) {
  if (!route) return;
  if (route.id === 'chats') {
    await showView('chats');
    if (view === 'chats' && route.arg === 'new') newChat(null);
    return;
  }
  if (allowedViews().some((v) => v.id === route.id)) showView(route.id, { arg: route.arg });
}

// Opens a chat from anywhere, e.g. a notification: Chats first, unless the view won't let go.
export async function goToChat(id) {
  await showView('chats');
  if (view === 'chats' && state.chats.some((c) => c.id === id)) openChat(id);
}

// The Nova mark in the header goes back to Chats from any view, keeping the open chat.
$('brandBtn').addEventListener('click', () => showView('chats'));

// New chat, from the sidebar's button in any view.
$('newChatBtn').addEventListener('click', async () => { await showView('chats'); if (view === 'chats') newChat(null); });
