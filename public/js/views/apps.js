// Apps view: web apps Nova builds, one folder each in Nova's apps folder. The sidebar lists
// them (apps/sidebar.js); the main column shows the chosen app either as its files (a list
// and an editor with syntax colouring, apps/editor.js) or running, in a frame that's a plain
// browser window: no scanline or HUD corners over it, so the page looks as its author made it.
// The frame loads /apps/<slug>/, which the server sends on to the app's sandboxed address
// (server/apps/serve.js). Routes: #apps/<slug>, #apps/<slug>/run, #apps/<slug>/files/<path>;
// nova://apps/<slug> links in chats and notes open #apps/<slug>/run.
import { h, svgIcon, copyText, COPY_ICON, COPIED_ICON } from '../lib/dom.js';
import { api } from '../lib/api.js';
import { store } from '../lib/store.js';
import { fileSize } from '../lib/format.js';
import { confirmDialog, promptDialog } from '../lib/dialog.js';
import { initAppList, appAddress } from '../apps/sidebar.js';
import { codeEditor } from '../apps/editor.js';

const ICONS = {
  menu: 'M4 6h16M4 12h16M4 18h16',
  files: ['M3 6.5h6.5l2 2H21V19H3Z'],
  run: 'M7 4.5v15l12-7.5Z',
  refresh: 'M20 11a8 8 0 1 0-2.3 5.7M20 4v7h-7',
  plus: 'M12 5v14M5 12h14',
  back: 'm15 6-6 6 6 6',
  chevron: 'm9 6 6 6-6 6'
};
const icon = (name) => svgIcon(ICONS[name]);
const lf = (text) => text.replace(/\r\n?/g, '\n');
const enc = (p) => p.split('/').map(encodeURIComponent).join('/');

/**
 * @param {{ side: HTMLElement, main: HTMLElement, access: () => string, me: () => any,
 *           setRoute: (route: string) => void, closeSidebar: () => void }} ctx
 */
export function init(ctx) {
  const { side, main } = ctx;
  let data = { apps: [], categories: [], canEdit: false, isAdmin: false };
  let slug = null;            // the app on show
  let mode = 'files';         // files | run
  let entries = [];           // the app's files, flat with depth
  let file = null;            // the open file as the server described it
  let editor = null;          // codeEditor while a text file is open
  let saving = false;
  let visible = false;
  let started = false;
  const expanded = new Set(store.get('apps.expanded', []));

  const list = initAppList({
    pane: side, open: (s) => openApp(s), reload: () => load(), current: () => slug,
    renamed: (from, to) => { if (slug === from) { slug = to; file = null; editor = null; openApp(to, { force: true }); } },
    removed: (s) => { if (slug === s) { slug = null; file = null; editor = null; render(); ctx.setRoute(''); } },
    backendSwitch
  });

  // ---- Layout -------------------------------------------------------------
  const title = h('div', { class: 'app-heading' });
  const filesBtn = h('button', { type: 'button', role: 'tab', class: 'mode-btn', 'aria-selected': 'true', onclick: () => setMode('files') }, icon('files'), h('span', {}, 'Files'));
  const runBtn = h('button', { type: 'button', role: 'tab', class: 'mode-btn', 'aria-selected': 'false', onclick: () => setMode('run') }, icon('run'), h('span', {}, 'Run app'));
  const modes = h('div', { class: 'mode-switch', role: 'tablist', 'aria-label': 'Show the app as' }, filesBtn, runBtn);
  const actions = h('div', { class: 'app-actions' });
  const body = h('section', { class: 'app-body' });
  const status = h('div', { class: 'brain-status', role: 'status' });
  const notice = h('div', { class: 'app-notice', role: 'status', hidden: true });
  main.append(h('header', { class: 'topbar app-bar' },
    h('button', { type: 'button', class: 'icon-btn menu-btn', 'aria-label': 'Show the sidebar' }, icon('menu')), title, modes, actions), notice, body, status);

  function setStatus(text = '', isError = false) {
    status.replaceChildren(...(text ? [h('span', {}, text)] : []));
    status.classList.toggle('error', isError);
  }

  // Run mode shows a page as its author made it: Nova's scanline and panel corners stand down.
  function paintChrome() { document.body.classList.toggle('app-running', visible && !!slug && mode === 'run'); }

  // ---- Loading ------------------------------------------------------------
  async function load() {
    try { data = await api('GET', '/api/apps'); }
    catch (err) { list.notify(`Couldn't list the apps: ${err.message}`); return; }
    list.set(data);
    if (slug && !data.apps.some((a) => a.slug === slug)) { slug = null; file = null; editor = null; ctx.setRoute(''); render(); }
    else renderHead();
  }
  const appOf = (s = slug) => data.apps.find((a) => a.slug === s);

  async function loadTree() {
    if (!slug) return;
    const at = slug;
    try {
      const r = await api('GET', `/api/apps/${at}/tree`);
      if (at !== slug) return;
      entries = r.entries;
    } catch (err) { if (at === slug) { entries = []; setStatus(err.message, true); } }
    if (mode === 'files') renderFiles();
  }

  // ---- Switching apps and modes --------------------------------------------
  const dirty = () => !!editor && !file?.readOnly && editor.value() !== file.lf;
  async function confirmDiscard() {
    if (!dirty()) return true;
    return confirmDialog({ title: `Discard your changes to ${file.name}?`, message: 'Your edits haven\'t been saved.',
      confirm: 'Discard changes', cancel: 'Keep editing', danger: true });
  }

  async function openApp(s, { run = null, path = null, force = false } = {}) {
    const app = appOf(s);
    if (s !== slug || force) {
      if (!force && !(await confirmDiscard())) return;
      slug = s;
      file = null; editor = null; entries = [];
      mode = app?.valid === false ? 'files' : run === true ? 'run' : run === false ? 'files' : store.get('apps.mode', 'files');
      setStatus('');
      render();
      list.render();
      await loadTree();
    } else if (run != null) setMode(run ? 'run' : 'files');
    if (path) openFile(path);
    route();
    ctx.closeSidebar();
  }

  function setMode(next) {
    if (!slug || next === mode) return;
    if (next === 'run' && appOf()?.valid === false) { setStatus('This folder\'s name can\'t be an address. Rename it from its menu to run the app.', true); return; }
    mode = next;
    store.set('apps.mode', mode);
    setStatus('');
    render();
    route();
  }

  function route() {
    if (!slug) return ctx.setRoute('');
    ctx.setRoute(mode === 'run' ? `${slug}/run` : file ? `${slug}/files/${enc(file.path)}` : slug);
  }

  // ---- Rendering ----------------------------------------------------------
  function renderHead() {
    const app = appOf();
    title.replaceChildren(slug
      ? h('div', {}, h('h1', { class: 'app-title' }, slug), app?.title && app.title !== slug ? h('span', { class: 'chat-where' }, app.title) : null)
      : h('h1', { class: 'app-title' }, 'Apps'));
    modes.hidden = !slug;
    filesBtn.setAttribute('aria-selected', String(mode === 'files'));
    runBtn.setAttribute('aria-selected', String(mode === 'run'));
    const kids = [];
    if (slug && app?.hasBackend) {
      kids.push(h('span', { class: `app-backend${app.backend ? ' on' : ''}`, title: app.backend ? 'The backend (backend.js) runs.' : 'The backend (backend.js) is off. An admin can turn it on from the app\'s menu.' }, app.backend ? 'Backend on' : 'Backend off'));
    }
    const allowed = app?.brain?.allowed || [];
    if (slug && allowed.length) {
      kids.push(h('span', { class: 'app-backend on', title: `This app may use, in the brain:\n${allowed.map(describeGrant).join('\n')}` }, 'Brain'));
    }
    if (slug && mode === 'run') {
      kids.push(h('button', { type: 'button', class: 'icon-btn', title: 'Reload the app', 'aria-label': 'Reload the app', onclick: reloadFrame }, icon('refresh')));
      kids.push(copyAddressButton(slug));
    }
    actions.replaceChildren(...kids);
    renderNotice(app);
  }

  // Copies the app's address, to open it in a browser of its own. An installed Nova would catch
  // a link to its own site and open it inside itself, so a link can't do this. The address is
  // /apps/<name>/, which asks whoever opens it to sign in, never the token the frame uses.
  function copyAddressButton(s) {
    const label = 'Copy the app\'s address, to open it in a browser';
    const btn = h('button', { type: 'button', class: 'icon-btn copy-address', title: label, 'aria-label': label }, svgIcon(COPY_ICON));
    btn.addEventListener('click', async () => {
      let ok = true;
      try { await copyText(appAddress(s)); } catch { ok = false; }
      btn.replaceChildren(svgIcon(ok ? COPIED_ICON : COPY_ICON));
      btn.classList.toggle('copied', ok);
      setStatus(ok ? `Copied ${appAddress(s)}. Paste it into a browser where you're signed in to Nova.` : `Couldn't copy. The address is ${appAddress(s)}`, !ok);
      clearTimeout(btn.timer);
      btn.timer = setTimeout(() => { btn.replaceChildren(svgIcon(COPY_ICON)); btn.classList.remove('copied'); }, 1500);
    });
    return btn;
  }

  // Brain paths the app's app.json asks for that an admin hasn't allowed yet. Until then the
  // app gets a 403 for them; an admin allows them here in one go.
  const describeGrant = (g) => `${g.path}${g.access === 'write' ? ' (read and change)' : ' (read)'}`;
  function renderNotice(app) {
    const pending = slug ? app?.brain?.pending || [] : [];
    notice.hidden = !pending.length;
    if (!pending.length) return notice.replaceChildren();
    notice.replaceChildren(
      h('p', {}, h('strong', {}, 'This app asks to use files in the brain: '), pending.map(describeGrant).join(', '), '. ',
        data.isAdmin ? 'It works with them as whoever is using it, within their own brain access.' : 'An admin needs to allow this before the app can use them.'),
      data.isAdmin ? h('button', { type: 'button', class: 'send-btn', onclick: () => allowBrain(app) }, 'Allow') : null);
  }

  async function allowBrain(app) {
    if (!(await confirmDialog({ title: `Let ${app.slug} use these brain files?`, confirm: 'Allow',
      message: `${app.brain.declared.map(describeGrant).join(', ')}. Anyone using the app can then read${app.brain.declared.some((g) => g.access === 'write') ? ', change and delete' : ''} ` +
        'these through it, as far as their own brain access allows. If app.json asks for more later, it waits for you again.' }))) return;
    try { await api('PATCH', `/api/apps/${app.slug}`, { brain: true }); } catch (err) { setStatus(err.message, true); }
    await load();
    if (mode === 'run' && slug === app.slug) reloadFrame(); // the app can use them straight away
  }

  function render() {
    renderHead();
    paintChrome();
    body.className = `app-body ${slug ? `mode-${mode}` : 'mode-none'}`;
    if (!slug) {
      body.replaceChildren(h('div', { class: 'empty' }, h('h2', {}, 'Please select an app'),
        h('p', {}, data.canEdit ? 'Pick one from the list, make a new one, or ask Nova in a chat to build one for you.' : 'Pick one from the list to run it or look at its files.')));
      return;
    }
    if (mode === 'run') {
      const frame = h('iframe', { class: 'app-frame', src: `/apps/${slug}/`, title: `${slug} (running)`,
        sandbox: 'allow-scripts allow-forms allow-modals allow-popups allow-popups-to-escape-sandbox allow-downloads', referrerpolicy: 'no-referrer' });
      body.replaceChildren(frame);
      return;
    }
    renderFiles();
  }

  function reloadFrame() {
    const frame = body.querySelector('.app-frame');
    if (frame) frame.src = `/apps/${slug}/`;
  }

  // Files mode: the list on the left, the open file on the right. On a phone the list and
  // the file take turns, with a Files button to go back.
  const tree = h('div', { class: 'app-tree', role: 'tree', 'aria-label': 'App files' });
  const fileBar = h('div', { class: 'app-file-bar' });
  const fileBox = h('div', { class: 'app-file' });
  const filesPane = h('div', { class: 'app-files' },
    h('div', { class: 'app-tree-box' }, h('div', { class: 'brain-side-head' }, h('span', { class: 'cat-label' }, 'Files'),
      h('button', { type: 'button', class: 'icon-btn new-file', title: 'New file', 'aria-label': 'New file', onclick: newFile }, icon('plus')),
      h('button', { type: 'button', class: 'icon-btn', title: 'Refresh the file list', 'aria-label': 'Refresh the file list', onclick: () => loadTree() }, icon('refresh'))), tree),
    h('div', { class: 'app-file-box' }, fileBar, fileBox));

  function renderFiles() {
    if (mode !== 'files' || !slug) return;
    if (!body.contains(filesPane)) body.replaceChildren(filesPane);
    filesPane.classList.toggle('has-file', !!file);
    filesPane.querySelector('.new-file').hidden = !data.canEdit;
    renderTree();
    renderFile();
  }

  function renderTree() {
    const focused = tree.contains(document.activeElement) ? document.activeElement.dataset.path : null;
    const rows = [];
    const hiddenUnder = (p) => { for (let i = p.lastIndexOf('/'); i > 0; i = p.lastIndexOf('/', i - 1)) if (!expanded.has(`${slug}:${p.slice(0, i)}`)) return true; return false; };
    for (const e of entries) {
      if (hiddenUnder(e.path)) continue;
      const isDir = e.type === 'dir';
      const open = isDir && expanded.has(`${slug}:${e.path}`);
      const item = h('button', { type: 'button', class: `tree-item ${isDir ? 'dir' : 'file'}`, role: 'treeitem', 'aria-level': String(e.depth + 1),
        'aria-expanded': isDir ? String(open) : null, 'aria-current': !isDir && file?.path === e.path ? 'true' : null,
        title: isDir ? e.path : `${e.path} · ${fileSize(e.size)}`, 'data-path': e.path },
      isDir ? icon('chevron') : h('span', { class: 'tree-spacer' }), h('span', { class: 'tree-name' }, e.name));
      item.addEventListener('click', () => {
        if (!isDir) { openFile(e.path); return; }
        const key = `${slug}:${e.path}`;
        if (expanded.has(key)) expanded.delete(key); else expanded.add(key);
        store.set('apps.expanded', [...expanded].slice(-200));
        renderTree();
      });
      const row = h('div', { class: `tree-row${open ? ' open' : ''}` }, item);
      row.style.setProperty('--depth', e.depth);
      rows.push(row);
    }
    if (!entries.length) rows.push(h('p', { class: 'tree-empty' }, 'No files.'));
    tree.replaceChildren(...rows);
    if (focused != null) tree.querySelector(`[data-path="${CSS.escape(focused)}"]`)?.focus();
  }

  function renderFile() {
    const kids = [];
    if (file) {
      kids.push(h('button', { type: 'button', class: 'text-btn files-back', onclick: closeFile }, icon('back'), 'Files'));
      kids.push(h('span', { class: 'app-file-path', title: file.path }, file.path));
      if (editor && !file.readOnly && data.canEdit) {
        kids.push(h('span', { class: 'brain-dirty' }, dirty() ? 'Unsaved changes' : ''));
        kids.push(h('button', { type: 'button', class: 'text-btn', disabled: !dirty(), onclick: revert }, 'Revert'));
        kids.push(h('button', { type: 'button', class: 'send-btn', disabled: !dirty() || saving, onclick: save }, saving ? 'Saving…' : 'Save'));
      }
      if (data.canEdit) kids.push(h('button', { type: 'button', class: 'stop-btn', onclick: removeFile }, 'Delete'));
    }
    fileBar.replaceChildren(...kids);
    fileBar.hidden = !file;
    if (!file) {
      fileBox.replaceChildren(h('div', { class: 'empty' }, h('h2', {}, 'Pick a file'),
        h('p', {}, data.canEdit ? 'Choose a file from the list to read or edit it. Switch to Run app to try the app.' : 'Choose a file from the list to read it. Switch to Run app to try the app.')));
      return;
    }
    if (editor) { if (!fileBox.contains(editor.el)) fileBox.replaceChildren(editor.el); return; }
    if (file.kind === 'image') {
      fileBox.replaceChildren(h('div', { class: 'empty' }, h('h2', {}, file.name), h('p', {}, `An image, ${fileSize(file.size)}. Run the app to see it in place.`)));
    } else {
      fileBox.replaceChildren(h('div', { class: 'empty' }, h('h2', {}, file.name),
        h('p', {}, file.kind === 'large' ? `This file is ${fileSize(file.size)}, too large to show here.` : 'This isn\'t a text file, so it can\'t be shown here.')));
    }
  }

  // ---- Files --------------------------------------------------------------
  async function openFile(p, { quiet = false } = {}) {
    if (!quiet && file?.path !== p && !(await confirmDiscard())) return;
    const at = slug;
    let f;
    try { f = await api('GET', `/api/apps/${at}/file?path=${encodeURIComponent(p)}`); }
    catch (err) { if (!quiet) setStatus(err.status === 404 ? `${p} isn't in the app any more.` : err.message, true); if (err.status === 404) loadTree(); return; }
    if (at !== slug) return;
    if (quiet && dirty()) return; // never replace unsaved work
    if (quiet && file?.path === p && f.version && f.version === file.version) return; // unchanged: keep the cursor where it is
    file = { ...f, lf: f.content != null ? lf(f.content) : null };
    editor = f.kind === 'text' ? codeEditor({ name: f.name, text: file.lf, readOnly: f.readOnly || !data.canEdit, onInput: renderFile, onSave: save }) : null;
    if (!quiet) setStatus(f.readOnly ? 'View only: this file is too large to edit in Nova.' : data.canEdit ? '' : 'View only. An admin can give this profile edit access to apps in Settings, under Profiles.');
    // Show the folders above it.
    const parts = p.split('/');
    for (let i = 1; i < parts.length; i++) expanded.add(`${slug}:${parts.slice(0, i).join('/')}`);
    renderFiles();
    route();
  }

  async function closeFile() {
    if (!(await confirmDiscard())) return;
    file = null; editor = null;
    renderFiles();
    route();
  }

  async function revert() {
    if (!(await confirmDiscard())) return;
    const p = file.path;
    file = null; editor = null;
    await openFile(p, { quiet: true });
  }

  async function save() {
    if (!dirty() || saving) return;
    saving = true;
    renderFile();
    setStatus('Saving…');
    const content = editor.value();
    try {
      const r = await api('PUT', `/api/apps/${slug}/file`, { path: file.path, content, version: file.version });
      file = { ...file, content, lf: content, version: r.version, size: r.size };
      setStatus(r.unchanged ? 'No changes to save.' : 'Saved.');
    } catch (err) {
      setStatus(err.status === 409 ? `${err.message} Use Revert to load the version on disk.` : err.message, true);
    } finally {
      saving = false;
      renderFile();
    }
  }

  async function newFile() {
    const dir = file?.path.includes('/') ? `${file.path.slice(0, file.path.lastIndexOf('/'))}/` : '';
    const p = await promptDialog({ title: 'New file', label: 'Path in the app (folders are made as needed)', value: dir, submit: 'Create' });
    if (!p?.trim()) return;
    try {
      const r = await api('PUT', `/api/apps/${slug}/file`, { path: p.trim(), content: '', version: null });
      await loadTree();
      openFile(r.path);
    } catch (err) { setStatus(err.message, true); }
  }

  async function removeFile() {
    if (!(await confirmDialog({ title: `Delete ${file.name}?`, danger: true, confirm: 'Delete file',
      message: 'It moves to the apps folder\'s .trash, where it can be restored by hand.' }))) return;
    try {
      await api('DELETE', `/api/apps/${slug}/file?path=${encodeURIComponent(file.path)}`);
      setStatus(`Deleted ${file.name}.`);
      file = null; editor = null;
      await loadTree();
      route();
    } catch (err) { setStatus(err.message, true); }
  }

  // ---- Backend (admins) ---------------------------------------------------
  async function backendSwitch(app) {
    if (app.backend) {
      try { await api('PATCH', `/api/apps/${app.slug}`, { backend: false }); } catch (err) { list.notify(err.message); }
      return load();
    }
    if (!(await confirmDialog({ title: `Turn on ${app.slug}'s backend?`, confirm: 'Turn it on',
      message: 'backend.js will run on the server whenever the app calls its api/ address, including after anyone with edit access, or Nova, changes it. ' +
        'It runs in its own Node process that may read only the app\'s folder, write only to its data folder and can\'t start other programs, ' +
        'with a time limit. It can reach the internet. Only turn it on for code you trust.' }))) return;
    try { await api('PATCH', `/api/apps/${app.slug}`, { backend: true }); } catch (err) { list.notify(err.message); }
    load();
  }

  // ---- Keeping up with changes --------------------------------------------
  // Nova writes apps from chats, so the list and the open app's files refresh when the view is
  // shown, when the window comes back into focus, and when the server says an app changed.
  let refreshTimer = 0;
  function refreshSoon() {
    clearTimeout(refreshTimer);
    refreshTimer = setTimeout(async () => {
      if (!visible) return;
      await load();
      if (slug && mode === 'files') {
        await loadTree();
        if (file && !dirty()) openFile(file.path, { quiet: true });
      }
    }, 250);
  }
  window.addEventListener('focus', refreshSoon);

  window.addEventListener('beforeunload', (e) => { if (dirty()) { e.preventDefault(); e.returnValue = ''; } });

  // arg: <slug>, <slug>/run or <slug>/files/<path>.
  function parseArg(arg) {
    const m = /^([^/]+)(?:\/(run|files)(?:\/(.*))?)?$/.exec(arg || '');
    return m ? { s: m[1], run: m[2] === 'run' ? true : m[2] === 'files' ? false : null, path: m[3] || null } : null;
  }

  return {
    async show(arg) {
      visible = true;
      if (!started) { started = true; render(); }
      await load();
      const target = parseArg(arg);
      if (target && appOf(target.s)) await openApp(target.s, { run: target.run, path: target.path });
      else if (target) { setStatus(`There's no app called ${target.s}.`, true); route(); }
      else { route(); if (slug && mode === 'files') loadTree(); }
      paintChrome();
    },
    hide() { visible = false; paintChrome(); },
    onServer(m) { if (m.t === 'apps_changed' && visible) refreshSoon(); },
    profileChanged() { if (started) refreshSoon(); }
  };
}
