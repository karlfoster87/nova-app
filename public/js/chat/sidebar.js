// Sidebar chat list: chats grouped by category, with inline rename, delete, a "Move to"
// menu, drag and drop between categories, categories reordered by dragging their heading
// (or Move up / Move down in their menu), and a title search. Uncategorised chats get
// their own group, which also appears as a drop target while dragging. A Recent section
// pinned under the list shows the latest few chats wherever they're filed.
import { h, svgIcon } from '../lib/dom.js';
import { api } from '../lib/api.js';
import { openMenu } from '../lib/menu.js';
import { confirmDialog } from '../lib/dialog.js';
import { slideOnHover } from '../lib/slide.js';

const ICONS = {
  more: 'M5 12h.01M12 12h.01M19 12h.01',
  plus: 'M12 5v14M5 12h14',
  chevron: 'm9 6 6 6-6 6',
  folder: 'M3 6.5h6.5l2 2H21V19H3Z',
  chat: 'M20 12a8 8 0 0 1-11.6 7.1L4 20l1-4.6A8 8 0 1 1 20 12Z'
};
const RECENT = 3;
const icon = (name) => svgIcon(ICONS[name], { class: name === 'folder' ? 'folder' : null });

// How long ago, compactly: now, 5m, 3h, 2d, then the date.
function ago(ms) {
  const mins = Math.floor((Date.now() - ms) / 60000);
  if (mins < 1) return 'now';
  if (mins < 60) return `${mins}m`;
  if (mins < 1440) return `${Math.floor(mins / 60)}h`;
  if (mins < 10080) return `${Math.floor(mins / 1440)}d`;
  return new Date(ms).toLocaleDateString('en-GB', { day: 'numeric', month: 'short' });
}
const timeTag = (ms) => (ms ? h('time', { datetime: new Date(ms).toISOString(), title: new Date(ms).toLocaleString() }, ago(ms)) : null);

/**
 * @param {{ state: any, store: any, list: HTMLElement, openChat: (id: string) => void,
 *           newChat: (categoryId?: string|null) => void }} ctx
 */
export function initSidebar(ctx) {
  const { state, store, list } = ctx;
  state.categories = [];
  let collapsed = new Set(store.get('collapsed', []));
  let editing = false;      // an inline rename is open
  let dragging = null;      // chat id being dragged
  let draggingCat = null;   // category id being dragged
  let pending = false;      // a render was skipped while editing or dragging
  let lastKey = '';

  // Long chat titles slide to show their end while the row is hovered or focused.
  const slideTitle = (title) => h('span', { class: 'slide' }, h('span', {}, title));
  slideOnHover(list, '.chat-row');
  slideOnHover(document.getElementById('recentList'), '.chat-row');

  const toast = h('p', { class: 'sidebar-toast', role: 'alert', hidden: true });
  list.after(toast);
  let toastTimer;
  function notify(message) {
    toast.textContent = message;
    toast.hidden = false;
    clearTimeout(toastTimer);
    toastTimer = setTimeout(() => { toast.hidden = true; }, 6000);
  }

  async function load() {
    try {
      const [chats, categories] = await Promise.all([api('GET', '/api/chats'), api('GET', '/api/categories')]);
      state.chats = chats;
      state.categories = categories;
      for (const c of chats) if (!state.chatState.has(c.id)) state.chatState.set(c.id, c.state);
      render(true);
    } catch (err) { notify(`Couldn't load your chats: ${err.message}`); }
  }

  function dotFor(c) {
    const s = state.chatState.get(c.id);
    const t = state.transcripts.get(c.id);
    return t?.waiting ? 'waiting' : s === 'running' || t?.tasks.size ? 'running' : state.unread.has(c.id) ? 'unread' : '';
  }

  // ---- Rendering ----------------------------------------------------------
  // Called after every server message, so it skips work when nothing visible changed,
  // and never rebuilds under an open rename box or a drag.
  function render(force = false) {
    if (editing || dragging || draggingCat) { pending = true; return; }
    const query = searchQuery();
    const key = JSON.stringify([state.categories, state.chats.map((c) => [c.id, c.title, c.category_id, dotFor(c)]),
      state.current, state.draft, [...collapsed], query, Math.floor(Date.now() / 60000)]); // the minute keeps times fresh
    if (!force && key === lastKey) return;
    lastKey = key;
    pending = false;

    const known = new Set(state.categories.map((c) => c.id));
    const groups = new Map(state.categories.map((c) => [c.id, []]));
    const loose = [];
    for (const chat of state.chats) {
      if (query && !(chat.title || 'New chat').toLowerCase().includes(query)) continue;
      if (chat.category_id && known.has(chat.category_id)) groups.get(chat.category_id).push(chat);
      else loose.push(chat);
    }

    // While searching, show only groups with a match, expanded, and no draft row or hints.
    if (query) {
      const sections = state.categories.filter((cat) => groups.get(cat.id).length)
        .map((cat) => categorySection(cat, groups.get(cat.id), true));
      if (loose.length) sections.push(looseSection(loose, true));
      if (!sections.length) sections.push(h('p', { class: 'cat-hint' }, 'No chat titles match your search.'));
      replaceKeepingFocus(sections);
      recentBox.hidden = true;
      return;
    }

    const sections = [h('div', { class: 'side-head' }, h('span', { class: 'cat-label' }, 'Conversations'),
      h('small', {}, state.chats.length === 1 ? '1 chat' : `${state.chats.length} chats`))];
    sections.push(...state.categories.map((cat) => categorySection(cat, groups.get(cat.id))));
    sections.push(looseSection(loose));
    if (!state.categories.length && !state.chats.length) {
      sections.push(h('p', { class: 'cat-hint' }, 'Create a category to organise your chats, then use its + to start one.'));
    }
    replaceKeepingFocus(sections);
    const recent = state.chats.filter((c) => c.title).slice(0, RECENT); // the server sends them newest first
    recentBox.hidden = !recent.length;
    recentBox.replaceChildren(...(recent.length ? [recentSection(recent)] : []));
  }
  setInterval(() => render(), 60 * 1000);

  // Rebuilds the list, putting keyboard focus back on the same control of the same chat or
  // category. The list redraws whenever this profile's chats change (from any tab), and
  // without this a keyboard user would be dropped back to the top of the page.
  function replaceKeepingFocus(sections) {
    const f = document.activeElement;
    const owner = list.contains(f) ? f.closest('[data-chat], [data-cat]') : null;
    const cls = owner && ['chat-item', 'chat-more', 'cat-toggle', 'cat-add', 'cat-more'].find((c) => f.classList.contains(c));
    list.replaceChildren(...sections);
    if (!cls) return;
    const key = owner.dataset.chat ? `[data-chat="${owner.dataset.chat}"]` : `[data-cat="${owner.dataset.cat}"]`;
    list.querySelector(`${key} .${cls}`)?.focus();
  }

  // The latest chats wherever they're filed, in their own box pinned under the scrolling list.
  // Plain links: menus and dragging stay on the rows above.
  const recentBox = document.getElementById('recentList');
  function recentSection(chats) {
    return h('section', { class: 'cat recent', 'aria-label': 'Recent chats' },
      h('div', { class: 'cat-head' }, h('span', { class: 'cat-label' }, 'Recent')),
      h('div', { class: 'cat-chats' }, chats.map((chat) => {
        const item = h('button', { type: 'button', class: 'chat-item', 'aria-current': String(chat.id === state.current), title: chat.title },
          icon('chat'), slideTitle(chat.title), timeTag(chat.updated_at), h('i', { class: `dot ${dotFor(chat)}` }));
        item.addEventListener('click', () => ctx.openChat(chat.id));
        return h('div', { class: 'chat-row' }, item);
      })));
  }

  // ---- Search -------------------------------------------------------------
  const search = document.getElementById('chatSearch');
  const searchQuery = () => search.value.replace(/\s+/g, ' ').trim().toLowerCase();
  search.addEventListener('input', () => render());
  search.addEventListener('keydown', (e) => {
    if (e.key === 'Escape' && search.value) { e.preventDefault(); search.value = ''; render(); }
  });

  function categorySection(cat, chats, searching = false) {
    const isCollapsed = !searching && collapsed.has(cat.id);
    const toggle = h('button', { type: 'button', class: 'cat-toggle', 'aria-expanded': String(!isCollapsed) },
      icon('chevron'), icon('folder'), h('span', { class: 'cat-name' }, cat.name), h('span', { class: 'cat-count' }, String(chats.length)));
    toggle.addEventListener('click', () => {
      if (collapsed.has(cat.id)) collapsed.delete(cat.id); else collapsed.add(cat.id);
      store.set('collapsed', [...collapsed]);
      render(true);
    });
    const add = h('button', { type: 'button', class: 'icon-btn cat-add', title: `New chat in ${cat.name}`, 'aria-label': `New chat in ${cat.name}` }, icon('plus'));
    add.addEventListener('click', () => {
      if (collapsed.delete(cat.id)) store.set('collapsed', [...collapsed]);
      ctx.newChat(cat.id);
    });
    const more = h('button', { type: 'button', class: 'icon-btn cat-more', 'aria-haspopup': 'menu', 'aria-label': `Options for ${cat.name}` }, icon('more'));
    const index = state.categories.findIndex((c) => c.id === cat.id);
    more.addEventListener('click', () => openMenu(more, [
      { label: 'Rename category', action: () => inlineEdit(toggle, cat.name, 60, (name) => api('PATCH', `/api/categories/${cat.id}`, { name })) },
      // The keyboard and touch equivalent of dragging the heading
      { label: 'Move up', hidden: searching || index <= 0, action: () => moveCategory(cat.id, state.categories[index - 1].id, true) },
      { label: 'Move down', hidden: searching || index === state.categories.length - 1, action: () => moveCategory(cat.id, state.categories[index + 2]?.id ?? null, true) },
      { label: 'Delete category', danger: true, action: () => removeCategory(cat, chats.length) }
    ]));

    const body = h('div', { class: 'cat-chats', hidden: isCollapsed });
    if (!searching && state.current === null && state.draft?.categoryId === cat.id) body.append(draftRow());
    for (const chat of chats) body.append(chatRow(chat));
    if (!chats.length && !(state.current === null && state.draft?.categoryId === cat.id)) {
      body.append(h('p', { class: 'cat-empty' }, 'No chats yet. Use + or drag one here.'));
    }
    const head = h('div', { class: 'cat-head', draggable: searching ? null : 'true' }, toggle, add, more);
    const section = h('section', { class: 'cat', 'aria-label': cat.name, 'data-cat': cat.id }, head, body);
    dropTarget(section, cat.id);
    if (!searching) { categoryDrag(head, section, cat); categoryDrop(section, cat.id); }
    return section;
  }

  function looseSection(chats, searching = false) {
    const title = state.categories.length ? 'Uncategorised' : 'Chats';
    const body = h('div', { class: 'cat-chats' });
    if (!searching && state.current === null && state.draft && !state.draft.categoryId) body.append(draftRow());
    for (const chat of chats) body.append(chatRow(chat));
    const hasContent = body.children.length > 0;
    const section = h('section', { class: `cat loose${hasContent ? '' : ' empty'}`, 'aria-label': title },
      h('div', { class: 'cat-head' }, h('span', { class: 'cat-label' }, title)),
      hasContent ? body : h('p', { class: 'cat-empty' }, 'Drop here to remove a chat from its category.'));
    dropTarget(section, null);
    categoryDrop(section, null);
    return section;
  }

  // The unsent chat the user is writing, shown where it will be filed.
  function draftRow() {
    return h('div', { class: 'chat-row' },
      h('button', { type: 'button', class: 'chat-item', 'aria-current': 'true' }, icon('chat'), h('span', {}, 'New chat'), null, h('i', { class: 'dot' })));
  }

  function chatRow(chat) {
    const title = chat.title || 'New chat';
    const item = h('button', { type: 'button', class: 'chat-item', 'aria-current': String(chat.id === state.current), title },
      icon('chat'), slideTitle(title), timeTag(chat.title ? chat.updated_at : null), h('i', { class: `dot ${dotFor(chat)}` }));
    item.addEventListener('click', () => ctx.openChat(chat.id));
    const more = h('button', { type: 'button', class: 'icon-btn chat-more', 'aria-haspopup': 'menu', 'aria-label': `Options for ${title}` }, icon('more'));
    const row = h('div', { class: 'chat-row', draggable: 'true', 'data-chat': chat.id }, item, more);
    more.addEventListener('click', () => openMenu(more, chatMenu(chat, item)));

    row.addEventListener('dragstart', (e) => {
      dragging = chat.id;
      e.dataTransfer.effectAllowed = 'move';
      e.dataTransfer.setData('text/plain', chat.id);
      row.classList.add('drag-source');
      list.classList.add('dragging');
    });
    row.addEventListener('dragend', () => {
      dragging = null;
      list.classList.remove('dragging');
      for (const el of list.querySelectorAll('.drop-target, .drag-source')) el.classList.remove('drop-target', 'drag-source');
      if (pending) render(true);
    });
    return row;
  }

  function chatMenu(chat, item) {
    const items = [
      { label: 'Rename', disabled: !chat.title, action: () => inlineEdit(item, chat.title, 120, (title) => api('PATCH', `/api/chats/${chat.id}`, { title })) }
    ];
    const targets = state.categories.filter((c) => c.id !== chat.category_id);
    if (targets.length || chat.category_id) items.push({ heading: 'Move to' });
    for (const c of targets) items.push({ label: c.name, indent: true, action: () => move(chat.id, c.id) });
    if (chat.category_id) items.push({ label: 'Uncategorised', indent: true, action: () => move(chat.id, null) });
    items.push({ label: 'Delete chat', danger: true, action: () => removeChat(chat) });
    return items;
  }

  // ---- Drag and drop ------------------------------------------------------
  function dropTarget(section, categoryId) {
    section.addEventListener('dragover', (e) => {
      if (!dragging) return;
      e.preventDefault();
      e.dataTransfer.dropEffect = 'move';
      section.classList.add('drop-target');
    });
    section.addEventListener('dragleave', (e) => {
      if (!section.contains(e.relatedTarget)) section.classList.remove('drop-target');
    });
    section.addEventListener('drop', (e) => {
      if (draggingCat) return; // a category being reordered, handled by categoryDrop
      e.preventDefault();
      const id = dragging || e.dataTransfer.getData('text/plain');
      section.classList.remove('drop-target');
      if (id) move(id, categoryId);
    });
  }

  async function move(chatId, categoryId) {
    const chat = state.chats.find((c) => c.id === chatId);
    if (!chat || (chat.category_id || null) === categoryId) return;
    const before = chat.category_id;
    chat.category_id = categoryId; // show the move straight away
    if (categoryId && collapsed.delete(categoryId)) store.set('collapsed', [...collapsed]);
    render(true);
    try { await api('PATCH', `/api/chats/${chatId}`, { categoryId }); }
    catch (err) { chat.category_id = before; render(true); notify(`Couldn't move that chat: ${err.message}`); }
  }

  // ---- Reordering categories ----------------------------------------------
  // A category is dragged by its heading. Every category folds up while it's dragged, so
  // the list is short; a line shows where it will land, above or below the one under the
  // pointer. Uncategorised always stays last, so dropping on it moves a category to the end.
  function categoryDrag(head, section, cat) {
    head.addEventListener('dragstart', (e) => {
      draggingCat = cat.id;
      e.dataTransfer.effectAllowed = 'move';
      e.dataTransfer.setData('text/plain', cat.name);
      section.classList.add('drag-source');
      requestAnimationFrame(() => list.classList.add('dragging-cat')); // after the drag starts, or the browser cancels it
    });
    head.addEventListener('dragend', () => {
      draggingCat = null;
      list.classList.remove('dragging-cat');
      for (const el of list.querySelectorAll('.drag-source, .cat-drop-before, .cat-drop-after')) el.classList.remove('drag-source', 'cat-drop-before', 'cat-drop-after');
      if (pending) render(true);
    });
  }

  function categoryDrop(section, catId) {
    const mark = (after) => {
      for (const el of list.querySelectorAll('.cat-drop-before, .cat-drop-after')) if (el !== section) el.classList.remove('cat-drop-before', 'cat-drop-after');
      section.classList.toggle('cat-drop-after', after);
      section.classList.toggle('cat-drop-before', !after);
    };
    section.addEventListener('dragover', (e) => {
      if (!draggingCat) return;
      e.preventDefault();
      e.dataTransfer.dropEffect = 'move';
      const r = section.getBoundingClientRect();
      mark(catId !== null && e.clientY > r.top + r.height / 2);
    });
    section.addEventListener('dragleave', (e) => {
      if (draggingCat && !section.contains(e.relatedTarget)) section.classList.remove('cat-drop-before', 'cat-drop-after');
    });
    section.addEventListener('drop', (e) => {
      if (!draggingCat) return;
      e.preventDefault();
      const ids = state.categories.map((c) => c.id);
      const beforeId = catId === null ? null : section.classList.contains('cat-drop-after') ? ids[ids.indexOf(catId) + 1] ?? null : catId;
      moveCategory(draggingCat, beforeId);
    });
  }

  // Moves a category before beforeId (null: to the end), showing it straight away.
  async function moveCategory(id, beforeId, refocus = false) {
    const before = state.categories;
    const moving = before.find((c) => c.id === id);
    if (!moving || beforeId === id) return;
    const next = before.filter((c) => c !== moving);
    const at = beforeId ? next.findIndex((c) => c.id === beforeId) : -1;
    next.splice(at < 0 ? next.length : at, 0, moving);
    if (next.every((c, i) => c === before[i])) return;
    state.categories = next;
    render(true);
    // Keep keyboard focus on the moved category's menu button, so it can be moved again.
    if (refocus) list.querySelector(`[data-cat="${id}"] .cat-more`)?.focus();
    try { state.categories = await api('POST', `/api/categories/${id}/move`, { beforeId }); render(true); }
    catch (err) { state.categories = before; render(true); notify(`Couldn't move that category: ${err.message}`); }
    if (refocus) list.querySelector(`[data-cat="${id}"] .cat-more`)?.focus();
  }

  // ---- Rename and delete --------------------------------------------------
  // Swaps an element for a text box. Enter or leaving the box saves; Esc cancels. The box
  // wraps and grows with the name, so a long one can be read whole while it's edited.
  function inlineEdit(target, value, maxLength, save) {
    editing = true;
    const input = h('textarea', { class: 'inline-edit wrap', rows: '1', maxlength: String(maxLength), 'aria-label': 'New name' });
    input.value = value;
    const fit = () => { input.style.height = 'auto'; input.style.height = `${input.scrollHeight + 2}px`; };
    input.addEventListener('input', fit);
    const row = target.closest('[draggable]');
    if (row) row.draggable = false;
    target.replaceWith(input);
    fit();
    input.focus();
    input.select();
    let done = false;
    const finish = async (keep) => {
      if (done) return;
      done = true;
      const next = input.value.replace(/\s+/g, ' ').trim();
      if (keep && next && next !== value) {
        try { await save(next); } catch (err) { notify(err.message); }
      }
      editing = false;
      await load(); // the server's version, including any change it refused
    };
    input.addEventListener('keydown', (e) => {
      if (e.key === 'Enter') { e.preventDefault(); finish(true); }
      if (e.key === 'Escape') { e.preventDefault(); finish(false); }
    });
    input.addEventListener('blur', () => finish(true));
  }

  async function removeChat(chat) {
    if (!(await confirmDialog({ title: `Delete "${chat.title || 'New chat'}"?`, danger: true, confirm: 'Delete chat',
      message: 'It\'s removed from your chat list. The transcript stays on disk.' }))) return;
    try {
      await api('DELETE', `/api/chats/${chat.id}`);
      if (state.current === chat.id) ctx.newChat(chat.category_id);
      state.transcripts.delete(chat.id);
      await load();
    } catch (err) { notify(`Couldn't delete that chat: ${err.message}`); }
  }

  async function removeCategory(cat, count) {
    const message = count ? `Its ${count === 1 ? 'chat moves' : `${count} chats move`} to Uncategorised. No chats are deleted.` : 'It has no chats.';
    if (!(await confirmDialog({ title: `Delete the "${cat.name}" category?`, message, danger: true, confirm: 'Delete category' }))) return;
    try {
      await api('DELETE', `/api/categories/${cat.id}`);
      if (state.draft?.categoryId === cat.id) state.draft.categoryId = null;
      await load();
    } catch (err) { notify(`Couldn't delete that category: ${err.message}`); }
  }

  // ---- New category -------------------------------------------------------
  const dialog = document.getElementById('categoryDialog');
  const form = document.getElementById('categoryForm');
  function openNewCategory() {
    form.reset();
    form.querySelector('.form-status').textContent = '';
    dialog.showModal();
    form.name.focus();
  }
  form.addEventListener('submit', async (e) => {
    e.preventDefault();
    const button = form.querySelector('[type=submit]');
    button.disabled = true;
    try {
      await api('POST', '/api/categories', { name: form.name.value });
      dialog.close();
      await load();
    } catch (err) {
      form.querySelector('.form-status').textContent = err.message;
    } finally { button.disabled = false; }
  });

  return { load, render, openNewCategory, notify };
}
