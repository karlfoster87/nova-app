// The Apps view's sidebar: every app folder, grouped by category like the chat list (and
// drawn with the same parts), with a name search. Apps are dragged onto a category to file
// them, categories are reordered by dragging their heading or with Move up / Move down, and
// each row's menu renames, files, deletes and (for admins) turns the app's backend on or off.
// Apps sort by name within a group. The server checks every change; this mirrors it.
import { h, svgIcon, copyText } from '../lib/dom.js';
import { api } from '../lib/api.js';
import { store } from '../lib/store.js';
import { openMenu } from '../lib/menu.js';
import { confirmDialog, promptDialog } from '../lib/dialog.js';

const ICONS = {
  more: 'M5 12h.01M12 12h.01M19 12h.01',
  chevron: 'm9 6 6 6-6 6',
  folder: 'M3 6.5h6.5l2 2H21V19H3Z',
  app: ['M4 5h16v14H4Z', 'M4 9h16M7 7h.01M10 7h.01'],
  search: 'M16 16l4 4M18 11a7 7 0 1 1-14 0 7 7 0 0 1 14 0',
  plus: 'M12 5v14M5 12h14',
  refresh: 'M20 11a8 8 0 1 0-2.3 5.7M20 4v7h-7'
};
const icon = (name) => svgIcon(ICONS[name], { class: name === 'folder' ? 'folder' : null });

// An app's address, to open in a browser of its own. Whoever opens it signs in to Nova there.
export const appAddress = (slug) => `${location.origin}/apps/${slug}/`;

/**
 * @param {{ pane: HTMLElement, open: (slug: string) => void, reload: () => Promise<void>,
 *           current: () => string|null, renamed: (from: string, to: string) => void,
 *           removed: (slug: string) => void, backendSwitch: (app: any) => void }} ctx
 */
export function initAppList(ctx) {
  let data = { apps: [], categories: [], canEdit: false, isAdmin: false };
  const collapsed = new Set(store.get('apps.collapsed', []));
  let draggingApp = null, draggingCat = null;

  const search = h('input', { class: 'chat-search', type: 'search', placeholder: 'Search apps', 'aria-label': 'Search apps by name', autocomplete: 'off', maxlength: '80' });
  const list = h('nav', { class: 'chat-list app-list', 'aria-label': 'Apps' });
  const toast = h('p', { class: 'sidebar-toast', role: 'alert', hidden: true });
  const newApp = h('button', { class: 'foot-btn', type: 'button' }, icon('plus'), 'New app');
  const newCat = h('button', { class: 'foot-btn', type: 'button' }, icon('plus'), 'New category');
  const foot = h('div', { class: 'side-foot' }, newCat, newApp);
  ctx.pane.append(h('label', { class: 'search-box' }, icon('search'), search), list, toast, foot);
  search.addEventListener('input', () => render());
  search.addEventListener('keydown', (e) => { if (e.key === 'Escape' && search.value) { e.preventDefault(); search.value = ''; render(); } });

  let toastTimer;
  function notify(message) {
    toast.textContent = message;
    toast.hidden = false;
    clearTimeout(toastTimer);
    toastTimer = setTimeout(() => { toast.hidden = true; }, 6000);
  }

  // Runs a change, then reloads the list (the server's version, including anything it refused).
  async function act(run, failure) {
    try { const out = await run(); await ctx.reload(); return out; }
    catch (err) { notify(`${failure}: ${err.message}`); await ctx.reload(); return null; }
  }

  // ---- Rendering ------------------------------------------------------------
  function set(next) { data = next; render(); }

  function render() {
    if (draggingApp || draggingCat) return;
    foot.hidden = !data.canEdit;
    const query = search.value.trim().toLowerCase();
    const match = (a) => !query || a.slug.includes(query) || a.title.toLowerCase().includes(query);
    const known = new Set(data.categories.map((c) => c.id));
    const groups = new Map(data.categories.map((c) => [c.id, []]));
    const loose = [];
    for (const app of data.apps.filter(match)) (known.has(app.categoryId) ? groups.get(app.categoryId) : loose).push(app);

    const f = document.activeElement;
    const focusKey = list.contains(f) ? f.closest('[data-app], [data-cat]')?.dataset : null;
    const focusCls = focusKey && ['chat-item', 'chat-more', 'cat-toggle', 'cat-more'].find((c) => f.classList.contains(c));

    const sections = [h('div', { class: 'side-head' }, h('span', { class: 'cat-label' }, 'Apps'),
      h('small', {}, data.apps.length === 1 ? '1 app' : `${data.apps.length} apps`))];
    for (const cat of data.categories) {
      if (query && !groups.get(cat.id).length) continue;
      sections.push(categorySection(cat, groups.get(cat.id), !!query));
    }
    if (!query || loose.length) sections.push(looseSection(loose, !!query));
    if (query && sections.length === 1) sections.push(h('p', { class: 'cat-hint' }, 'No app names match your search.'));
    if (!data.apps.length && !query) {
      sections.push(h('p', { class: 'cat-hint' }, data.canEdit
        ? 'No apps yet. Use New app, or ask Nova in a chat to build one.'
        : 'No apps yet. Someone with edit access can make one, or ask Nova to.'));
    }
    list.replaceChildren(...sections);
    if (focusCls) {
      const key = focusKey.app ? `[data-app="${CSS.escape(focusKey.app)}"]` : `[data-cat="${CSS.escape(focusKey.cat)}"]`;
      list.querySelector(`${key} .${focusCls}`)?.focus();
    }
  }

  function categorySection(cat, apps, searching) {
    const isCollapsed = !searching && collapsed.has(cat.id);
    const toggle = h('button', { type: 'button', class: 'cat-toggle', 'aria-expanded': String(!isCollapsed) },
      icon('chevron'), icon('folder'), h('span', { class: 'cat-name' }, cat.name), h('span', { class: 'cat-count' }, String(apps.length)));
    toggle.addEventListener('click', () => {
      if (collapsed.has(cat.id)) collapsed.delete(cat.id); else collapsed.add(cat.id);
      store.set('apps.collapsed', [...collapsed]);
      render();
    });
    const index = data.categories.findIndex((c) => c.id === cat.id);
    const more = h('button', { type: 'button', class: 'icon-btn cat-more', 'aria-haspopup': 'menu', 'aria-label': `Options for ${cat.name}`, hidden: !data.canEdit }, icon('more'));
    more.addEventListener('click', () => openMenu(more, [
      { label: 'Rename category', action: () => renameCategory(cat) },
      { label: 'Move up', hidden: searching || index <= 0, action: () => moveCategory(cat.id, data.categories[index - 1].id) },
      { label: 'Move down', hidden: searching || index === data.categories.length - 1, action: () => moveCategory(cat.id, data.categories[index + 2]?.id ?? null) },
      { label: 'Delete category', danger: true, action: () => removeCategory(cat, apps.length) }
    ]));
    const body = h('div', { class: 'cat-chats', hidden: isCollapsed }, apps.map(appRow));
    if (!apps.length) body.append(h('p', { class: 'cat-empty' }, data.canEdit ? 'No apps here yet. Drag one in.' : 'No apps here yet.'));
    const head = h('div', { class: 'cat-head', draggable: searching || !data.canEdit ? null : 'true' }, toggle, more);
    const section = h('section', { class: 'cat', 'aria-label': cat.name, 'data-cat': cat.id }, head, body);
    dropApps(section, cat.id);
    if (!searching && data.canEdit) { dragCategory(head, section, cat); dropCategory(section, cat.id); }
    return section;
  }

  function looseSection(apps, searching) {
    const title = data.categories.length ? 'Uncategorised' : 'All apps';
    const section = h('section', { class: `cat loose${apps.length ? '' : ' empty'}`, 'aria-label': title },
      h('div', { class: 'cat-head' }, h('span', { class: 'cat-label' }, title)),
      apps.length ? h('div', { class: 'cat-chats' }, apps.map(appRow)) : h('p', { class: 'cat-empty' }, 'Drop here to take an app out of its category.'));
    dropApps(section, null);
    if (!searching) dropCategory(section, null);
    return section;
  }

  function appRow(app) {
    const label = app.slug;
    const item = h('button', { type: 'button', class: `chat-item${app.valid ? '' : ' invalid'}`, 'aria-current': String(app.slug === ctx.current()),
      title: [app.title && app.title !== app.slug ? app.title : '', app.description, app.valid ? '' : 'This folder name can\'t be an address. Rename it to run the app.'].filter(Boolean).join('\n') || label },
    icon('app'), h('span', { class: 'slide' }, h('span', {}, label)), app.hasBackend ? h('span', { class: `app-backend${app.backend ? ' on' : ''}`, title: app.backend ? 'Backend on' : 'Backend off' }, 'api') : null);
    item.addEventListener('click', () => ctx.open(app.slug));
    const more = h('button', { type: 'button', class: 'icon-btn chat-more', 'aria-haspopup': 'menu', 'aria-label': `Options for ${label}` }, icon('more'));
    more.addEventListener('click', () => openMenu(more, appMenu(app)));
    const row = h('div', { class: 'chat-row', draggable: data.canEdit && app.valid ? 'true' : null, 'data-app': app.slug }, item, more);
    row.addEventListener('dragstart', (e) => {
      draggingApp = app.slug;
      e.dataTransfer.effectAllowed = 'move';
      e.dataTransfer.setData('text/plain', app.slug);
      row.classList.add('drag-source');
      list.classList.add('dragging');
    });
    row.addEventListener('dragend', () => {
      draggingApp = null;
      list.classList.remove('dragging');
      for (const el of list.querySelectorAll('.drop-target, .drag-source')) el.classList.remove('drop-target', 'drag-source');
      render();
    });
    return row;
  }

  function appMenu(app) {
    const items = [
      { label: 'Copy address', hidden: !app.valid, action: () => copyText(appAddress(app.slug))
        .then(() => notify(`Copied ${appAddress(app.slug)}. Paste it into a browser where you're signed in to Nova.`), () => notify(`Couldn't copy. The address is ${appAddress(app.slug)}`)) },
      { label: 'Rename', hidden: !data.canEdit, action: () => renameApp(app) }
    ];
    const targets = data.canEdit && app.valid ? data.categories.filter((c) => c.id !== app.categoryId) : [];
    if (targets.length || (data.canEdit && app.categoryId)) items.push({ heading: 'Move to' });
    for (const c of targets) items.push({ label: c.name, indent: true, action: () => move(app.slug, c.id) });
    if (data.canEdit && app.categoryId) items.push({ label: 'Uncategorised', indent: true, action: () => move(app.slug, null) });
    if (data.isAdmin && app.hasBackend && app.valid) items.push({ label: app.backend ? 'Turn the backend off' : 'Turn the backend on…', action: () => ctx.backendSwitch(app) });
    if (data.isAdmin && app.brain?.allowed.length) {
      items.push({ label: 'Take away brain access', action: () => act(() => api('PATCH', `/api/apps/${encodeURIComponent(app.slug)}`, { brain: false }), 'Couldn\'t change that') });
    }
    items.push({ label: 'Delete app', danger: true, hidden: !data.canEdit, action: () => removeApp(app) });
    return items;
  }

  // ---- Changes --------------------------------------------------------------------
  async function renameApp(app) {
    const next = await promptDialog({ title: `Rename ${app.slug}`, label: 'New name (its address: lower-case letters, numbers and hyphens)', value: app.slug, submit: 'Rename' });
    if (next == null || next.trim() === app.slug) return;
    const out = await act(() => api('PATCH', `/api/apps/${encodeURIComponent(app.slug)}`, { slug: next.trim() }), 'Couldn\'t rename that app');
    if (out) ctx.renamed(app.slug, out.slug);
  }

  async function removeApp(app) {
    if (!(await confirmDialog({ title: `Delete ${app.slug}?`, danger: true, confirm: 'Delete app',
      message: 'Its folder moves to the apps folder\'s .trash, where it can be restored by hand.' }))) return;
    const out = await act(() => api('DELETE', `/api/apps/${encodeURIComponent(app.slug)}`), 'Couldn\'t delete that app');
    if (out) ctx.removed(app.slug);
  }

  const move = (slug, categoryId) => {
    const app = data.apps.find((a) => a.slug === slug);
    if (!app || (app.categoryId || null) === categoryId) return;
    app.categoryId = categoryId; // show it straight away
    if (categoryId && collapsed.delete(categoryId)) store.set('apps.collapsed', [...collapsed]);
    render();
    return act(() => api('PATCH', `/api/apps/${encodeURIComponent(slug)}`, { categoryId }), 'Couldn\'t move that app');
  };

  async function newCategory() {
    const name = await promptDialog({ title: 'New category', label: 'Name', submit: 'Create' });
    if (name?.trim()) await act(() => api('POST', '/api/app-categories', { name }), 'Couldn\'t create that category');
  }
  async function renameCategory(cat) {
    const name = await promptDialog({ title: 'Rename category', label: 'Name', value: cat.name, submit: 'Rename' });
    if (name?.trim() && name.trim() !== cat.name) await act(() => api('PATCH', `/api/app-categories/${cat.id}`, { name }), 'Couldn\'t rename that category');
  }
  async function removeCategory(cat, count) {
    const message = count ? `Its ${count === 1 ? 'app moves' : `${count} apps move`} to Uncategorised. No apps are deleted.` : 'It has no apps.';
    if (await confirmDialog({ title: `Delete the "${cat.name}" category?`, message, danger: true, confirm: 'Delete category' })) {
      await act(() => api('DELETE', `/api/app-categories/${cat.id}`), 'Couldn\'t delete that category');
    }
  }
  function moveCategory(id, beforeId) {
    const before = data.categories;
    const moving = before.find((c) => c.id === id);
    const next = before.filter((c) => c !== moving);
    const at = beforeId ? next.findIndex((c) => c.id === beforeId) : -1;
    next.splice(at < 0 ? next.length : at, 0, moving);
    data.categories = next;
    render();
    return act(() => api('POST', `/api/app-categories/${id}/move`, { beforeId }), 'Couldn\'t move that category');
  }

  async function createApp() {
    const name = await promptDialog({ title: 'New app', label: 'Name (like Budget planner; its address is made from it)', submit: 'Create' });
    if (!name?.trim()) return;
    const out = await act(() => api('POST', '/api/apps', { name }), 'Couldn\'t create that app');
    if (out) ctx.open(out.slug);
  }
  newApp.addEventListener('click', createApp);
  newCat.addEventListener('click', newCategory);

  // ---- Drag and drop (the chat list's way: native drag, headings reorder) ----------
  function dropApps(section, categoryId) {
    section.addEventListener('dragover', (e) => {
      if (!draggingApp) return;
      e.preventDefault();
      e.dataTransfer.dropEffect = 'move';
      section.classList.add('drop-target');
    });
    section.addEventListener('dragleave', (e) => { if (!section.contains(e.relatedTarget)) section.classList.remove('drop-target'); });
    section.addEventListener('drop', (e) => {
      if (!draggingApp) return;
      e.preventDefault();
      const slug = draggingApp;
      draggingApp = null;
      section.classList.remove('drop-target');
      move(slug, categoryId);
    });
  }

  function dragCategory(head, section, cat) {
    head.addEventListener('dragstart', (e) => {
      draggingCat = cat.id;
      e.dataTransfer.effectAllowed = 'move';
      e.dataTransfer.setData('text/plain', cat.name);
      section.classList.add('drag-source');
      requestAnimationFrame(() => list.classList.add('dragging-cat'));
    });
    head.addEventListener('dragend', () => {
      draggingCat = null;
      list.classList.remove('dragging-cat');
      for (const el of list.querySelectorAll('.drag-source, .cat-drop-before, .cat-drop-after')) el.classList.remove('drag-source', 'cat-drop-before', 'cat-drop-after');
      render();
    });
  }

  function dropCategory(section, catId) {
    const mark = (after) => {
      for (const el of list.querySelectorAll('.cat-drop-before, .cat-drop-after')) if (el !== section) el.classList.remove('cat-drop-before', 'cat-drop-after');
      section.classList.toggle('cat-drop-after', after);
      section.classList.toggle('cat-drop-before', !after);
    };
    section.addEventListener('dragover', (e) => {
      if (!draggingCat) return;
      e.preventDefault();
      const r = section.getBoundingClientRect();
      mark(catId !== null && e.clientY > r.top + r.height / 2);
    });
    section.addEventListener('dragleave', (e) => { if (draggingCat && !section.contains(e.relatedTarget)) section.classList.remove('cat-drop-before', 'cat-drop-after'); });
    section.addEventListener('drop', (e) => {
      if (!draggingCat) return;
      e.preventDefault();
      const id = draggingCat;
      const ids = data.categories.map((c) => c.id);
      const beforeId = catId === null ? null : section.classList.contains('cat-drop-after') ? ids[ids.indexOf(catId) + 1] ?? null : catId;
      draggingCat = null;
      if (beforeId !== id) moveCategory(id, beforeId);
    });
  }

  return { set, render, notify };
}
