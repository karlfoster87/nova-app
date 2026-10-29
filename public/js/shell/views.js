// Views: Chats is always there. Tasks, Notes, Apps and Core (the brain and Nova's own settings) are listed by the server with this
// profile's access level, loaded on first use from views/, and each owns a sidebar pane and a
// main pane. The server checks access on every route; this only decides what to show.
// Also the counts on the view tabs, and routes like #brain/folder/file.md, which reopen a view
// after a reload and are how the installed app's shortcuts open one.
import { $, h, svgIcon } from '../lib/dom.js';
import { store } from '../lib/store.js';
import { openMenu } from '../lib/menu.js';
import { localDay } from '../lib/format.js';
import { state, els } from '../state.js';
import { openChat, newChat, sidebar } from '../chat/chats.js';
import { setDraft } from '../chat/composer.js';

// A new view adds its module here (and its entry in server/accounts/access.js VIEWS).
const VIEW_MODULES = {
  brain: '../views/brain.js', tasks: '../views/tasks.js', notes: '../views/notes.js', apps: '../views/apps.js',
  soul: '../views/soul.js', heartbeat: '../views/soon.js', thought: '../views/soon.js'
};
// Views that share a tab: the Core tab holds the brain and the Soul, Heartbeat and Thought,
// switched at the top of the sidebar. They follow the tab's access level and aren't listed by
// the server as views of their own. The tab reopens whichever member was used last.
const GROUPS = { brain: [['brain', 'Brain'], ['soul', 'Soul'], ['heartbeat', 'Heartbeat'], ['thought', 'Thought']] };
const TAB_OF = Object.fromEntries(Object.entries(GROUPS).flatMap(([tab, members]) => members.map(([id]) => [id, tab])));
const tabOf = (id) => TAB_OF[id] || id;
const VIEW_ICONS = {
  chats: ['M20 12a8 8 0 0 1-11.6 7.1L4 20l1-4.6A8 8 0 1 1 20 12Z', 'M8.5 12h.01M12 12h.01M15.5 12h.01'],
  brain: ['M12 3.5a8.5 8.5 0 1 0 0 17 8.5 8.5 0 1 0 0-17Z', 'M12 7.5a4.5 4.5 0 1 0 0 9 4.5 4.5 0 1 0 0-9Z', 'M12 11a1 1 0 1 0 0 2 1 1 0 1 0 0-2Z'], // the Core tab
  tasks: ['M4 4h16v16H4Z', 'm8 12 3 3 5-6'],
  notes: ['M6 3h9l4 4v14H6Z', 'M14 3v5h5M9 12h7M9 16h5'],
  apps: ['M4 4h7v7H4Z', 'M13 4h7v7h-7Z', 'M4 13h7v7H4Z', 'M16.5 13v7M13 16.5h7'],
  more: ['M5 12h.01M12 12h.01M19 12h.01']
};
// The narrowest a tab may be before the row runs out of room. Tabs that don't fit go into a
// More tab at the end (the open view always keeps a place), so adding views never squeezes
// the labels or the content below.
const TAB_MIN = 46;

export const views = new Map(); // id -> the view's controller once loaded
let view = 'chats';
const tabs = $('viewTabs');

function allowedViews() {
  const access = state.me?.access || {};
  return [{ id: 'chats', label: 'Chats' }, ...(state.me?.views || []).filter((v) => VIEW_MODULES[v.id] && access[v.id] && access[v.id] !== 'none')];
}
const canOpen = (id) => allowedViews().some((v) => v.id === tabOf(id));

let tabList = [];
const moreTab = h('button', { type: 'button', class: 'more-tab', 'aria-haspopup': 'menu', 'data-label': 'More', title: 'More views', onclick: () => openMore() },
  svgIcon(VIEW_ICONS.more), h('span', {}, 'More'), h('span', { class: 'tab-badge', hidden: true }));

export function renderViewTabs() {
  tabList = allowedViews();
  tabs.hidden = tabList.length < 2;
  tabs.replaceChildren(...tabList.map((v) => h('button', {
    type: 'button', role: 'tab', 'aria-selected': String(v.id === view), tabindex: v.id === view ? 0 : -1,
    'data-tab': v.id, 'data-label': v.label, onclick: () => showView(GROUPS[v.id] && tabOf(view) !== v.id ? store.get(`view.${v.id}`, v.id) : v.id)
  }, svgIcon(VIEW_ICONS[v.id] || VIEW_ICONS.notes), h('span', {}, v.label), h('span', { class: 'tab-badge', hidden: true }))), moreTab);
  if (!tabList.some((v) => v.id === tabOf(view))) showView('chats', { force: true }); // access was taken away
  fitTabs();
  paintBadges();
}

// Shows as many tabs as fit at TAB_MIN, and the rest under More.
function fitTabs() {
  const width = tabs.clientWidth;
  if (!width) return; // hidden (a closed drawer); the observer fits them once there's room
  const gap = parseFloat(getComputedStyle(tabs).columnGap) || 0;
  const room = Math.max(1, Math.floor((width + gap) / (TAB_MIN + gap)));
  const buttons = [...tabs.querySelectorAll('[data-tab]')];
  let shown = buttons.length <= room ? buttons : buttons.slice(0, room - 1);
  const active = buttons.find((b) => b.dataset.tab === tabOf(view));
  if (active && !shown.includes(active)) shown = [...shown.slice(0, -1), active];
  for (const b of buttons) b.hidden = !shown.includes(b);
  moreTab.hidden = shown.length === buttons.length;
  moreTab.setAttribute('aria-selected', 'false');
}
new ResizeObserver(() => fitTabs()).observe(tabs);

function openMore() {
  const hiddenTabs = [...tabs.querySelectorAll('[data-tab][hidden]')];
  openMenu(moreTab, hiddenTabs.map((b) => {
    const n = badges[b.dataset.tab];
    return { label: n ? `${b.dataset.label} (${n})` : b.dataset.label, action: () => showView(b.dataset.tab) };
  }));
}

tabs.addEventListener('keydown', (e) => {
  if (e.key !== 'ArrowRight' && e.key !== 'ArrowLeft') return;
  const all = [...tabs.children].filter((b) => !b.hidden);
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
  const tucked = [...tabs.querySelectorAll('[data-tab][hidden]')].reduce((n, b) => n + (badges[b.dataset.tab] || 0), 0);
  const more = moreTab.querySelector('.tab-badge');
  more.hidden = !tucked;
  more.textContent = tucked > 99 ? '99+' : String(tucked || '');
  for (const b of tabs.querySelectorAll('[data-tab]')) {
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
      const side = paneFor('side', id);
      if (GROUPS[tabOf(id)]) side.append(groupSwitch(id));
      views.set(id, mod.init({
        id, side, main: paneFor('view', id),
        access: () => state.me?.access?.[tabOf(id)] || 'none', me: () => state.me,
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
  for (const b of tabs.querySelectorAll('[data-tab]')) {
    b.setAttribute('aria-selected', String(b.dataset.tab === tabOf(id)));
    b.tabIndex = b.dataset.tab === tabOf(id) ? 0 : -1;
  }
  fitTabs();
  paintBadges();
  if (leaving !== id) views.get(leaving)?.hide?.();
  views.get(id)?.show?.(arg);
  if (id === 'chats') history.replaceState(null, '', location.pathname);
  store.set('view', id);
  if (GROUPS[tabOf(id)]) store.set(`view.${tabOf(id)}`, id);
}

// The switch at the top of a grouped view's sidebar: Brain · Soul · Heartbeat · Thought.
function groupSwitch(id) {
  const el = h('div', { class: 'view-switch', role: 'tablist', 'aria-label': 'Core views' },
    ...GROUPS[tabOf(id)].map(([m, label]) => h('button', {
      type: 'button', role: 'tab', 'aria-selected': String(m === id), tabindex: m === id ? 0 : -1, onclick: () => showView(m)
    }, label)));
  el.addEventListener('keydown', (e) => {
    if (e.key !== 'ArrowRight' && e.key !== 'ArrowLeft') return;
    const all = [...el.children], at = all.findIndex((b) => b.getAttribute('aria-selected') === 'true');
    all[(at + (e.key === 'ArrowRight' ? 1 : all.length - 1)) % all.length].click();
    e.preventDefault();
  });
  return el;
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
  if (canOpen(route.id)) showView(route.id, { arg: route.arg });
}

// A new chat with text ready in the box, from another view (a task handed to Nova).
// Nothing is sent until the user presses Send. False if the current view won't let go.
export async function startChat(text) {
  await showView('chats');
  if (view !== 'chats') return false;
  newChat(null);
  setDraft(text);
  return true;
}

// Opens a chat from anywhere, e.g. a notification: Chats first, unless the view won't let go.
export async function goToChat(id) {
  await showView('chats');
  if (view === 'chats' && state.chats.some((c) => c.id === id)) openChat(id);
}

// Links to a place in Nova, such as nova://apps/<name> in a chat reply or a brain note
// (lib/markdown.js turns those into #apps/<name>/run with data-route), open it here rather
// than reloading the page. A modified click still opens a new tab.
document.addEventListener('click', (e) => {
  const a = e.target.closest?.('a[data-route]');
  if (!a || e.button !== 0 || e.ctrlKey || e.metaKey || e.shiftKey || e.altKey) return;
  const route = routeFromHash(a.getAttribute('href'));
  if (!route) return;
  e.preventDefault();
  e.stopPropagation();
  if (!canOpen(route.id)) { sidebar?.notify?.(`This profile can't open ${route.id === 'apps' ? 'apps' : 'that'}. An admin can give it access in Settings, under Profiles.`); return; }
  goTo(route);
}, true);

// The Nova mark in the header goes back to Chats from any view, keeping the open chat.
$('brandBtn').addEventListener('click', () => showView('chats'));

// New chat, from the sidebar's button in any view.
$('newChatBtn').addEventListener('click', async () => { await showView('chats'); if (view === 'chats') newChat(null); });
