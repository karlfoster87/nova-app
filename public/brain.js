// Brain view: the brain folder as a tree in the sidebar, and the chosen
// file in the main column, rendered with the transcript's markdown pipeline or edited as
// plain text. The server decides what this profile may see and change; this mirrors it.
import { h, renderMarkdown, fileSize } from '/render.js';
import { openMenu } from '/menu.js';
import { confirmDialog } from '/dialog.js';

const ICONS = {
  chevron: 'm9 6 6 6-6 6',
  refresh: 'M20 11a8 8 0 1 0-2.3 5.7M20 4v7h-7',
  download: 'M12 4v11m-5-5 5 5 5-5M5 20h14',
  upload: 'M12 20V9m-5 5 5-5 5 5M5 4h14',
  more: 'M5 12h.01M12 12h.01M19 12h.01',
  menu: 'M4 6h16M4 12h16M4 18h16'
};
// Operating-system clutter a folder upload shouldn't carry into the brain.
const JUNK = new Set(['.ds_store', 'thumbs.db', 'desktop.ini']);
function icon(name) {
  const svg = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
  svg.setAttribute('viewBox', '0 0 24 24');
  svg.setAttribute('aria-hidden', 'true');
  const p = document.createElementNS('http://www.w3.org/2000/svg', 'path');
  p.setAttribute('d', ICONS[name]);
  svg.append(p);
  return svg;
}

async function api(method, url, body) {
  const res = await fetch(url, {
    method, headers: body ? { 'Content-Type': 'application/json' } : {}, body: body ? JSON.stringify(body) : undefined
  });
  if (res.status === 401) { location.href = '/login'; throw new Error('Signed out.'); }
  const data = await res.json().catch(() => ({}));
  if (!res.ok) {
    const err = new Error(data.error || `Request failed (${res.status}). Try again.`);
    err.status = res.status;
    throw err;
  }
  return data;
}

const query = (p) => `path=${encodeURIComponent(p)}`;
// The page route is path-shaped so an HTML file's relative links and images find its neighbours.
// The token stands in for the session cookie, which the sandboxed frame's requests don't carry.
const pageUrl = (token, p) => `/api/brain/page/${token}/${p.split('/').map(encodeURIComponent).join('/')}`;
const isText = (kind) => kind === 'markdown' || kind === 'text' || kind === 'html';
const parentOf = (p) => (p.includes('/') ? p.slice(0, p.lastIndexOf('/')) : '');
const lf = (text) => text.replace(/\r\n?/g, '\n'); // a textarea only ever gives back \n
function sizeText(bytes) {
  if (bytes < 1024) return `${bytes} bytes`;
  if (bytes < 1024 * 1024) return `${Math.round(bytes / 1024)} KB`;
  return `${(bytes / 1024 / 1024).toFixed(1)} MB`;
}

// A link's target inside the brain: relative to the file's folder, or to the brain root
// when it starts with /. null if it climbs above the root.
function joinPath(dir, href) {
  const parts = href.startsWith('/') || !dir ? [] : dir.split('/');
  for (const seg of href.split('/')) {
    if (!seg || seg === '.') continue;
    if (seg === '..') { if (!parts.length) return null; parts.pop(); } else parts.push(seg);
  }
  return parts.join('/');
}

// YAML front matter (common in Obsidian-style brains) shows as a collapsed block, not as prose.
function splitFrontMatter(text) {
  const m = /^---\r?\n([\s\S]*?)\r?\n(?:---|\.\.\.)[ \t]*(?:\r?\n|$)/.exec(text);
  return m ? { meta: m[1], body: text.slice(m[0].length) } : { meta: null, body: text };
}

// Files from a drop, walking into dropped folders so their structure is kept. The entries
// have to be taken from the event before anything awaits, or the browser drops them.
async function filesFromDrop(dt) {
  const entries = [...(dt.items || [])].map((i) => i.webkitGetAsEntry?.()).filter(Boolean);
  if (!entries.length) return [...(dt.files || [])].map((f) => ({ file: f, path: f.name }));
  const out = [];
  const walk = async (entry, prefix) => {
    if (entry.isFile) {
      const f = await new Promise((resolve, reject) => entry.file(resolve, reject));
      out.push({ file: f, path: prefix + f.name });
    } else if (entry.isDirectory) {
      const reader = entry.createReader();
      for (;;) { // readEntries hands folders over in batches
        const batch = await new Promise((resolve, reject) => reader.readEntries(resolve, reject));
        if (!batch.length) break;
        for (const e of batch) await walk(e, `${prefix}${entry.name}/`);
      }
    }
  };
  for (const e of entries) await walk(e, '');
  return out;
}

const READ_ONLY = {
  access: 'View only. An admin can give this profile edit access in Settings, under Profiles.',
  admin: 'View only: only admins can change this file, because it steers every chat.',
  size: 'View only: this file is too large to edit in Nova.'
};

/**
 * @param {{ side: HTMLElement, main: HTMLElement, store: any, access: () => string,
 *           setRoute: (route: string) => void, closeSidebar: () => void }} ctx
 */
export function init(ctx) {
  const { side, main, store } = ctx;
  const expanded = new Set(store.get('brain.expanded', []));
  const dirs = new Map(); // folder path -> entries, for every folder loaded so far
  let file = null;        // the open file as the server described it, plus lf (its text as edited)
  let editor = null;      // the textarea while editing
  let saving = false;
  let opening = null;     // the path being fetched, so a slow response can't replace a newer pick
  let started = false;
  let rootCanUpload = false; // may this profile upload into the brain folder's top level
  let htmlSource = store.get('brain.htmlSource', false); // HTML files show as source, not rendered

  // ---- Layout -------------------------------------------------------------
  const tree = h('div', { class: 'brain-tree', role: 'tree', 'aria-label': 'Brain files' });
  const refreshBtn = h('button', { type: 'button', class: 'icon-btn', title: 'Refresh the file list', 'aria-label': 'Refresh the file list' }, icon('refresh'));
  const zipBtn = h('button', { type: 'button', class: 'icon-btn', title: 'Download the whole brain as a zip', 'aria-label': 'Download the whole brain as a zip' }, icon('download'));
  const uploadBtn = h('button', { type: 'button', class: 'icon-btn', title: 'Upload files or folders', 'aria-label': 'Upload files or folders', hidden: ctx.access() !== 'edit' }, icon('upload'));
  const toast = h('p', { class: 'sidebar-toast', role: 'alert', hidden: true });
  side.append(h('div', { class: 'brain-side-head' }, h('span', { class: 'cat-label' }, 'Brain folder'), uploadBtn, refreshBtn, zipBtn), tree, toast);
  uploadBtn.addEventListener('click', () => openUpload(file ? parentOf(file.path) : ''));

  const crumbs = h('p', { class: 'brain-crumbs' });
  const actions = h('div', { class: 'brain-actions' });
  const doc = h('section', { class: 'brain-doc' });
  const status = h('div', { class: 'brain-status', role: 'status' });
  main.append(
    h('header', { class: 'topbar brain-bar' },
      h('button', { type: 'button', class: 'icon-btn menu-btn', 'aria-label': 'Show the sidebar' }, icon('menu')), crumbs, actions),
    doc, status);

  let toastTimer;
  function notify(message) {
    toast.textContent = message;
    toast.hidden = false;
    clearTimeout(toastTimer);
    toastTimer = setTimeout(() => { toast.hidden = true; }, 6000);
  }

  // One line under the document. action: { label, run } adds a button, e.g. to reload.
  function setStatus(text = '', isError = false, action = null) {
    const kids = text ? [h('span', {}, text)] : [];
    if (action) kids.push(h('button', { type: 'button', class: 'text-btn', onclick: action.run }, action.label));
    status.replaceChildren(...kids);
    status.classList.toggle('error', isError);
  }

  // ---- Tree ---------------------------------------------------------------
  async function loadDir(p) {
    try {
      const r = await api('GET', `/api/brain/tree?${query(p)}`);
      dirs.set(p, r.entries);
      if (p === '') rootCanUpload = !!r.canUpload;
    } catch (err) {
      dirs.delete(p);
      if (expanded.delete(p)) store.set('brain.expanded', [...expanded]);
      if (err.status !== 404 || p === '') throw err; // a folder that went away just closes
    }
  }

  // Reloads the root and every open folder, then redraws. Files change on disk as Claude works.
  async function refreshTree() {
    try {
      await loadDir('');
      await Promise.all([...expanded].filter((p) => dirs.has(parentOf(p))).map((p) => loadDir(p).catch(() => {})));
    } catch (err) { notify(`Couldn't list the brain folder: ${err.message}`); }
    renderTree();
  }

  function row(entry, depth) {
    const isDir = entry.type === 'dir';
    const open = isDir && expanded.has(entry.path);
    const item = h('button', {
      type: 'button', class: `tree-item ${isDir ? 'dir' : 'file'}`, role: 'treeitem', 'aria-level': String(depth + 1),
      'aria-expanded': isDir ? String(open) : null, 'aria-current': !isDir && file?.path === entry.path ? 'true' : null,
      title: isDir ? entry.path : `${entry.path} · ${sizeText(entry.size)}`, 'data-path': entry.path, 'data-type': entry.type
    }, isDir ? icon('chevron') : h('span', { class: 'tree-spacer' }), h('span', { class: 'tree-name' }, entry.name));
    item.addEventListener('click', () => (isDir ? toggleDir(entry.path) : openFile(entry.path)));
    const r = h('div', { class: `tree-row${open ? ' open' : ''}` }, item);
    r.style.setProperty('--depth', depth);
    // One menu per row for download, upload and delete; each shows only what this profile may do.
    const more = h('button', { type: 'button', class: 'icon-btn tree-more', 'aria-haspopup': 'menu', title: 'Options', 'aria-label': `Options for ${entry.name}` }, icon('more'));
    more.addEventListener('click', () => openMenu(more, [
      { label: 'Upload here…', hidden: !entry.canUpload, action: () => openUpload(entry.path) },
      { label: isDir ? 'Download as a zip' : 'Download', action: () => (isDir ? downloadFolder(entry.path) : downloadFile(entry)) },
      { label: isDir ? 'Delete folder' : 'Delete file', danger: true, hidden: !entry.canDelete, action: () => remove(entry.path, isDir) }
    ]));
    r.append(more);
    return r;
  }

  function downloadFile(entry) {
    const a = h('a', { href: `/api/brain/download?${query(entry.path)}`, download: entry.name, hidden: true });
    document.body.append(a);
    a.click();
    a.remove();
  }

  // Deleting moves the item to the brain's trash folder; the server refuses profile folders.
  async function remove(p, isDir) {
    const name = p.split('/').pop();
    const open = file && (file.path === p || file.path.startsWith(`${p}/`));
    if (open && !(await confirmDiscard())) return;
    if (!(await confirmDialog({ title: `Delete ${isDir ? 'the folder ' : ''}"${name}"?`, danger: true, confirm: isDir ? 'Delete folder' : 'Delete file',
      message: `${isDir ? 'Everything in it goes too. ' : ''}It moves to the brain's .trash folder, where it can be restored.` }))) return;
    try {
      const r = await api('DELETE', `/api/brain/file?${query(p)}`);
      if (open) { file = null; editor = null; ctx.setRoute(''); renderFile(); }
      for (const key of [...expanded]) if (key === p || key.startsWith(`${p}/`)) expanded.delete(key);
      store.set('brain.expanded', [...expanded]);
      await refreshTree();
      setStatus(r.commitError || `Deleted ${name}. It's in ${r.trashedTo}${r.committed ? ', and the deletion is committed to git' : ''}.`, !!r.commitError);
    } catch (err) { notify(err.message); }
  }

  function renderTree() {
    const focused = tree.contains(document.activeElement) ? document.activeElement.dataset.path : null;
    const rows = [];
    const walk = (p, depth) => {
      const entries = dirs.get(p);
      if (!entries) return;
      if (!entries.length) {
        const empty = h('p', { class: 'tree-empty' }, p ? 'Empty folder' : 'The brain folder is empty.');
        empty.style.setProperty('--depth', depth);
        rows.push(empty);
      }
      for (const e of entries) {
        rows.push(row(e, depth));
        if (e.type === 'dir' && expanded.has(e.path)) walk(e.path, depth + 1);
      }
    };
    walk('', 0);
    tree.replaceChildren(...rows);
    if (focused != null) tree.querySelector(`[data-path="${CSS.escape(focused)}"]`)?.focus();
  }

  async function toggleDir(p, open = !expanded.has(p)) {
    if (open) {
      expanded.add(p);
      if (!dirs.has(p)) {
        try { await loadDir(p); } catch (err) { notify(`Couldn't open that folder: ${err.message}`); }
      }
    } else expanded.delete(p);
    store.set('brain.expanded', [...expanded]);
    renderTree();
  }

  // Opens every folder above a path so its row is visible, then scrolls to it.
  async function reveal(p) {
    const parts = p.split('/');
    for (let i = 1; i < parts.length; i++) {
      const dir = parts.slice(0, i).join('/');
      expanded.add(dir);
      if (!dirs.has(dir)) await loadDir(dir).catch(() => {});
    }
    store.set('brain.expanded', [...expanded]);
    renderTree();
    tree.querySelector(`[data-path="${CSS.escape(p)}"]`)?.scrollIntoView({ block: 'nearest' });
  }

  // Up and down move between rows; right opens a folder, left closes it or goes to its parent.
  tree.addEventListener('keydown', (e) => {
    const items = [...tree.querySelectorAll('.tree-item')];
    const i = items.indexOf(document.activeElement);
    if (i < 0) return;
    const el = items[i], p = el.dataset.path, isDir = el.dataset.type === 'dir';
    if (e.key === 'ArrowDown') items[i + 1]?.focus();
    else if (e.key === 'ArrowUp') items[i - 1]?.focus();
    else if (e.key === 'ArrowRight' && isDir && !expanded.has(p)) toggleDir(p, true);
    else if (e.key === 'ArrowLeft' && isDir && expanded.has(p)) toggleDir(p, false);
    else if (e.key === 'ArrowLeft' && parentOf(p) !== p) tree.querySelector(`[data-path="${CSS.escape(parentOf(p))}"]`)?.focus();
    else return;
    e.preventDefault();
  });

  async function downloadFolder(p) {
    try {
      const s = await api('GET', `/api/brain/download?${query(p)}&check=1`);
      if (!s.files) { notify('That folder has no files to download.'); return; }
      if (s.bytes > 50 * 1024 * 1024 && !(await confirmDialog({ title: `Download ${s.name}?`, confirm: 'Download zip',
        message: `It holds ${s.files} files, ${sizeText(s.bytes)} before compression, so it may take a while.` }))) return;
      const a = h('a', { href: `/api/brain/download?${query(p)}`, download: s.name, hidden: true });
      document.body.append(a);
      a.click();
      a.remove();
    } catch (err) { notify(err.message); }
  }

  refreshBtn.addEventListener('click', async () => {
    await refreshTree();
    if (file && !editor) openFile(file.path, { quiet: true });
  });
  zipBtn.addEventListener('click', () => downloadFolder(''));

  // ---- Upload -------------------------------------------------------------
  // One dialog: pick the folder, add files or whole folders (drop, or the two buttons),
  // then upload. Three at a time, each with its progress. Files that already exist are
  // collected and replaced only after one confirmation. The batch is one git commit.
  async function openUpload(startDir = '') {
    if (ctx.access() !== 'edit') return;
    const maxMB = ctx.me()?.uploads?.brainMaxMB || 100;
    let target = startDir;
    let items = []; // { file, path, status: waiting | sending | done | exists | error, progress, error, saved }
    let busy = false;
    const pickOpen = new Set(['']);
    for (let p = startDir; p; p = parentOf(p)) pickOpen.add(p);
    await Promise.all([...pickOpen].map((p) => (dirs.has(p) ? null : loadDir(p).catch(() => {}))));

    const targetLabel = h('strong', {});
    const picker = h('div', { class: 'upload-folders', role: 'listbox', 'aria-label': 'Folder to upload into' });
    const list = h('ul', { class: 'upload-list', 'aria-label': 'Files to upload' });
    const status = h('p', { class: 'form-status', role: 'status' });
    const filesInput = h('input', { type: 'file', multiple: true, hidden: true });
    const folderInput = h('input', { type: 'file', multiple: true, hidden: true, webkitdirectory: true });
    const drop = h('div', { class: 'upload-drop' },
      h('p', {}, 'Drop files or folders here'),
      h('div', { class: 'row' },
        h('button', { type: 'button', class: 'text-btn', onclick: () => filesInput.click() }, 'Choose files'),
        h('button', { type: 'button', class: 'text-btn', onclick: () => folderInput.click() }, 'Choose a folder')),
      filesInput, folderInput);
    const go = h('button', { type: 'submit', class: 'send-btn', disabled: true }, 'Upload');
    const close = h('button', { type: 'button', class: 'text-btn' }, 'Cancel');
    const form = h('form', { class: 'stack' },
      h('h2', {}, 'Upload to the brain'),
      h('p', { class: 'muted upload-target' }, 'Upload into ', targetLabel),
      picker, drop, list, status,
      h('div', { class: 'row' }, h('span', { class: 'spacer' }), close, go));
    const dlg = h('dialog', { class: 'settings upload-dialog', 'aria-label': 'Upload to the brain' }, form);

    function renderPicker() {
      const rows = [folderRow('', 'Brain folder', 0, rootCanUpload)];
      const walk = (p, depth) => {
        for (const e of (dirs.get(p) || []).filter((x) => x.type === 'dir')) {
          rows.push(folderRow(e.path, e.name, depth, e.canUpload));
          if (pickOpen.has(e.path)) walk(e.path, depth + 1);
        }
      };
      walk('', 1);
      picker.replaceChildren(...rows);
      targetLabel.textContent = target || 'the brain folder';
      picker.querySelector('[aria-selected="true"]')?.scrollIntoView({ block: 'nearest' });
    }
    // A folder this profile can't upload into (such as profiles) still opens, so the folders
    // inside it (such as the profile's own) can be reached; it just can't be picked.
    function folderRow(p, name, depth, allowed) {
      const b = h('button', { type: 'button', class: 'upload-folder', role: 'option', 'aria-selected': String(p === target),
        'aria-disabled': allowed ? null : 'true', disabled: busy,
        title: allowed ? (p || 'The brain folder') : 'This profile can\'t upload here, but can open it' }, name);
      b.style.setProperty('--depth', depth);
      b.addEventListener('click', async () => {
        if (allowed) target = p;
        if (p && (!pickOpen.has(p) || allowed)) {
          if (!allowed && pickOpen.has(p)) pickOpen.delete(p);
          else { pickOpen.add(p); if (!dirs.has(p)) await loadDir(p).catch(() => {}); }
        } else if (p && !allowed) pickOpen.delete(p);
        renderPicker();
      });
      return b;
    }

    const STATUS = { waiting: 'Ready', done: 'Uploaded', exists: 'Already exists' };
    function renderList() {
      list.replaceChildren(...items.map((it) => {
        const detail = it.status === 'sending' ? `${Math.round((it.progress || 0) * 100)}%` : it.status === 'error' ? it.error : STATUS[it.status];
        const x = busy || it.status === 'done' ? null : h('button', { type: 'button', class: 'file-remove', title: 'Remove', 'aria-label': `Remove ${it.path}` }, '×');
        x?.addEventListener('click', () => { items = items.filter((i) => i !== it); renderList(); });
        const li = h('li', { class: `upload-item ${it.status}` }, h('span', { class: 'upload-path', title: it.path }, it.path),
          h('span', { class: 'upload-size' }, fileSize(it.file.size)), h('span', { class: 'upload-state' }, detail), x);
        if (it.status === 'sending') li.style.setProperty('--progress', `${Math.round((it.progress || 0) * 100)}%`);
        return li;
      }));
      const ready = items.filter((i) => i.status === 'waiting' || i.status === 'error').length;
      go.disabled = busy || !ready;
      go.textContent = busy ? 'Uploading…' : ready ? `Upload ${ready === 1 ? '1 file' : `${ready} files`}` : 'Upload';
    }

    function add(found) {
      for (const e of found) {
        if (JUNK.has(e.file.name.toLowerCase())) continue;
        items = items.filter((i) => i.path !== e.path);
        const item = { ...e, status: 'waiting' };
        if (e.file.size > maxMB * 1024 * 1024) Object.assign(item, { status: 'error', error: `Over ${maxMB} MB` });
        items.push(item);
      }
      status.textContent = '';
      renderList();
    }
    filesInput.addEventListener('change', () => { add([...filesInput.files].map((f) => ({ file: f, path: f.name }))); filesInput.value = ''; });
    folderInput.addEventListener('change', () => { add([...folderInput.files].map((f) => ({ file: f, path: f.webkitRelativePath || f.name }))); folderInput.value = ''; });
    const hasFiles = (e) => [...(e.dataTransfer?.types || [])].includes('Files');
    dlg.addEventListener('dragover', (e) => { if (hasFiles(e)) { e.preventDefault(); drop.classList.add('over'); } });
    dlg.addEventListener('dragleave', (e) => { if (!dlg.contains(e.relatedTarget)) drop.classList.remove('over'); });
    dlg.addEventListener('drop', (e) => {
      if (!hasFiles(e)) return;
      e.preventDefault();
      drop.classList.remove('over');
      filesFromDrop(e.dataTransfer).then(add, () => { status.textContent = 'Couldn\'t read what was dropped. Try Choose files instead.'; });
    });

    // Sends one file; resolves when it's in, exists, or failed.
    const send = (it, overwrite) => new Promise((resolve) => {
      const xhr = new XMLHttpRequest();
      it.status = 'sending';
      it.progress = 0;
      xhr.open('POST', `/api/brain/upload?dir=${encodeURIComponent(target)}&path=${encodeURIComponent(it.path)}${overwrite ? '&overwrite=1' : ''}`);
      xhr.upload.onprogress = (e) => { if (e.lengthComputable) { it.progress = e.loaded / e.total; renderList(); } };
      xhr.onload = () => {
        let data = {};
        try { data = JSON.parse(xhr.responseText); } catch {}
        if (xhr.status === 401) { location.href = '/login'; return; }
        if (xhr.status === 200) Object.assign(it, { status: 'done', saved: data.path });
        else if (xhr.status === 409 && !overwrite && /already exists/.test(data.error || '')) it.status = 'exists';
        else Object.assign(it, { status: 'error', error: data.error || `Upload failed (${xhr.status})` });
        renderList();
        resolve();
      };
      xhr.onerror = () => { Object.assign(it, { status: 'error', error: 'Upload failed. Check the connection.' }); renderList(); resolve(); };
      xhr.send(it.file);
    });
    async function batch(queue, overwrite) {
      let next = 0;
      const worker = async () => { while (next < queue.length) await send(queue[next++], overwrite); };
      await Promise.all([worker(), worker(), worker()]);
    }

    form.addEventListener('submit', async (e) => {
      e.preventDefault();
      if (busy) return;
      const queue = items.filter((i) => i.status === 'waiting' || i.status === 'error');
      if (!queue.length) return;
      busy = true;
      close.disabled = true;
      renderPicker();
      renderList();
      await batch(queue, false);
      const clashes = items.filter((i) => i.status === 'exists');
      const where = target || 'the brain folder';
      if (clashes.length && await confirmDialog({
        title: clashes.length === 1 ? `Replace ${clashes[0].path}?` : `Replace ${clashes.length} files?`,
        message: clashes.length === 1 ? `It already exists in ${where}.`
          : `These already exist in ${where}:\n${clashes.slice(0, 8).map((c) => `• ${c.path}`).join('\n')}${clashes.length > 8 ? `\n…and ${clashes.length - 8} more` : ''}`,
        confirm: clashes.length === 1 ? 'Replace file' : 'Replace files', cancel: 'Keep existing', danger: true })) {
        await batch(clashes, true);
      }
      const saved = items.filter((i) => i.status === 'done' && i.saved && !i.committed);
      let note = '';
      if (saved.length) {
        try {
          const r = await api('POST', '/api/brain/upload/commit', { paths: saved.map((i) => i.saved), dir: target });
          saved.forEach((i) => { i.committed = true; });
          note = r.commitError ? ` ${r.commitError}` : r.committed ? ' Committed to git.' : '';
        } catch (err) { note = ` ${err.message}`; }
      }
      const failed = items.filter((i) => i.status === 'error').length, kept = items.filter((i) => i.status === 'exists').length;
      status.textContent = `Uploaded ${saved.length === 1 ? '1 file' : `${saved.length} files`} to ${target || 'the brain folder'}.` +
        (kept ? ` ${kept} left as they were.` : '') + (failed ? ` ${failed} failed; see the list.` : '') + note;
      busy = false;
      close.disabled = false;
      close.textContent = 'Done';
      renderPicker();
      renderList();
      // Show what arrived: open the folder in the tree, and re-read the open file if it was replaced.
      if (target) expanded.add(target);
      store.set('brain.expanded', [...expanded]);
      await refreshTree();
      if (file && !editor && saved.some((i) => i.saved === file.path)) openFile(file.path, { quiet: true });
    });
    close.addEventListener('click', () => dlg.close());
    dlg.addEventListener('cancel', (e) => { if (busy) e.preventDefault(); });
    dlg.addEventListener('close', () => dlg.remove());
    document.body.append(dlg);
    renderPicker();
    renderList();
    dlg.showModal();
  }

  // ---- The open file ------------------------------------------------------
  const dirty = () => !!editor && editor.value !== file.lf;

  async function confirmDiscard() {
    if (!dirty()) return true;
    return confirmDialog({ title: `Discard your changes to ${file.name}?`, message: 'Your edits haven\'t been saved.',
      confirm: 'Discard changes', cancel: 'Keep editing', danger: true });
  }

  // heading: scroll to it once the file shows (from a [[Note#Heading]] link).
  async function openFile(p, { force = false, quiet = false, heading = '' } = {}) {
    if (!force && !quiet && file?.path !== p && !(await confirmDiscard())) return;
    if (!force && !quiet && file?.path === p && editor) return; // already editing it
    opening = p;
    if (!quiet) setStatus('Opening…');
    let f;
    try { f = await api('GET', `/api/brain/file?${query(p)}`); }
    catch (err) {
      if (opening !== p) return;
      opening = null;
      setStatus(err.status === 404 ? `${p} isn't in the brain folder any more.` : err.message, true);
      if (err.status === 404 && !quiet) refreshTree();
      return;
    }
    if (opening !== p) return; // another file was picked meanwhile
    opening = null;
    if (quiet && editor) return;
    file = { ...f, lf: f.content != null ? lf(f.content) : null };
    editor = null;
    if (!quiet) setStatus('');
    renderFile();
    ctx.setRoute(encodeURI(file.path));
    if (!quiet) { await reveal(file.path); ctx.closeSidebar(); } else renderTree();
    if (heading) scrollToHeading(heading);
  }

  function renderCrumbs() {
    if (!file) { crumbs.replaceChildren(h('span', {}, 'Brain')); crumbs.title = ''; return; }
    const parts = file.path.split('/');
    crumbs.replaceChildren(...parts.flatMap((part, i) => [
      i ? h('span', { class: 'crumb-sep', 'aria-hidden': 'true' }, '/') : null,
      h('span', { class: i === parts.length - 1 ? 'crumb-file' : 'crumb' }, part)
    ]).filter(Boolean));
    crumbs.title = file.path;
  }

  function renderActions() {
    const kids = [];
    if (editor) {
      kids.push(h('span', { class: 'brain-dirty' }, dirty() ? 'Unsaved changes' : ''));
      kids.push(h('button', { type: 'button', class: 'text-btn', onclick: cancelEdit }, 'Cancel'));
      kids.push(h('button', { type: 'button', class: 'send-btn', disabled: !dirty() || saving, onclick: save }, saving ? 'Saving…' : 'Save'));
    } else if (file) {
      const editable = isText(file.kind) && !file.readOnly;
      if (file.kind === 'html') {
        kids.push(h('button', { type: 'button', class: 'text-btn', 'aria-pressed': String(htmlSource),
          title: htmlSource ? 'Show the page as a browser would' : 'Show the HTML source', onclick: toggleSource }, htmlSource ? 'Rendered' : 'Source'));
      }
      if (editable) kids.push(h('button', { type: 'button', class: 'text-btn', onclick: startEdit }, 'Edit'));
      kids.push(h('a', { class: 'text-btn', href: `/api/brain/download?${query(file.path)}`, download: file.name }, 'Download'));
      if (file.canDelete) kids.push(h('button', { type: 'button', class: 'stop-btn', onclick: () => remove(file.path, false) }, 'Delete'));
    }
    actions.replaceChildren(...kids);
  }

  function renderFile() {
    renderCrumbs();
    renderActions();
    doc.classList.toggle('editing', !!editor);
    doc.classList.toggle('framed', !editor && file?.kind === 'html' && !htmlSource);
    if (!file) {
      doc.replaceChildren(h('div', { class: 'empty' }, h('h2', {}, 'Your brain folder'),
        h('p', {}, ctx.access() === 'edit' ? 'Pick a file from the list to read it. Markdown, text and HTML files can be edited here.' : 'Pick a file from the list to read it.')));
      return;
    }
    if (editor) { doc.replaceChildren(editor); return; }
    const note = file.readOnly && isText(file.kind) ? h('p', { class: 'brain-readonly' }, READ_ONLY[file.readOnly]) : null;
    if (file.kind === 'markdown') {
      const { meta, body } = splitFrontMatter(file.content);
      // Parsed in an inert template first, so relative images and videos don't start loading
      // from the wrong address before wireLinks points them at the brain routes.
      const tpl = document.createElement('template');
      tpl.innerHTML = renderMarkdown(body, { wiki: true }); // marked (with [[links]]), then DOMPurify
      wireLinks(tpl.content);
      const prose = h('div', { class: 'prose' }, tpl.content);
      wireWikiLinks(prose, file.path);
      doc.replaceChildren(h('article', { class: 'brain-article' }, note,
        meta ? h('details', { class: 'front-matter' }, h('summary', {}, 'Properties'), h('pre', {}, meta)) : null, prose));
    } else if (file.kind === 'html' && !htmlSource) {
      // Sandboxed twice over: here, and by the route's CSP, which also covers the page opened on its own.
      doc.replaceChildren(h('iframe', { class: 'brain-page', src: pageUrl(file.pageToken, file.path), title: file.name,
        sandbox: 'allow-popups allow-popups-to-escape-sandbox', referrerpolicy: 'no-referrer' }));
    } else if (file.kind === 'text' || file.kind === 'html') {
      doc.replaceChildren(h('article', { class: 'brain-article wide' }, note, h('pre', { class: 'brain-text' }, file.content)));
    } else if (file.kind === 'image') {
      doc.replaceChildren(h('article', { class: 'brain-article' }, h('img', { class: 'brain-image', src: `/api/brain/image?${query(file.path)}`, alt: file.name })));
    } else if (file.kind === 'video') {
      doc.replaceChildren(h('article', { class: 'brain-article wide' }, videoPlayer(file.path, file.name, 'brain-video')));
    } else {
      const why = file.kind === 'large'
        ? `This file is ${sizeText(file.size)}, too large to show here. Download it to open it.`
        : 'Nova shows text files, images and videos. Download this file to open it in another program.';
      doc.replaceChildren(h('div', { class: 'empty' }, h('h2', {}, file.name), h('p', {}, why)));
    }
    doc.scrollTop = 0;
  }

  // A player for a video in the brain, streamed from the video route. If this browser can't
  // play it (an HEVC .mov, say), it says so and offers the download instead. That includes a
  // file whose sound plays but whose picture can't be decoded, such as Theora .ogv in current
  // Chromium browsers, which would otherwise be a black box with audio.
  const VIDEO_EXT = /\.(mp4|m4v|webm|ogv|mov)$/i;
  function videoPlayer(p, label, cls) {
    const v = h('video', { class: cls, src: `/api/brain/video?${query(p)}`, controls: true, preload: 'metadata', playsinline: true, title: label });
    const cantPlay = () => {
      v.removeAttribute('src');
      v.load(); // stops any further fetching
      v.replaceWith(h('p', { class: 'brain-readonly' }, `This browser can't play ${label}. `,
        h('a', { href: `/api/brain/download?${query(p)}` }, 'Download it'), ' to watch it in another player.'));
    };
    v.addEventListener('error', cantPlay, { once: true });
    v.addEventListener('loadedmetadata', () => { if (!v.videoWidth && !v.videoHeight) cantPlay(); }, { once: true });
    return v;
  }

  // Relative links open in the viewer; relative images load through the image route, and
  // an image pointing at a video (![clip](clip.mp4)) becomes a player.
  // Anything with a scheme stays external (DOMPurify already set it to open in a new tab).
  function wireLinks(prose) {
    const dir = parentOf(file.path);
    const target = (href) => {
      if (!href || href.startsWith('#') || /^[a-z][a-z0-9+.-]*:/i.test(href) || href.startsWith('//')) return null;
      try { return joinPath(dir, decodeURIComponent(href.split('#')[0].split('?')[0])); } catch { return null; }
    };
    for (const a of prose.querySelectorAll('a[href]')) {
      const href = a.getAttribute('href');
      if (href.startsWith('#')) { a.removeAttribute('target'); continue; }
      const p = target(href);
      if (p == null) continue;
      a.removeAttribute('target');
      a.setAttribute('href', `#brain/${encodeURI(p)}`);
      a.addEventListener('click', (e) => {
        e.preventDefault();
        const known = dirs.get(parentOf(p))?.find((x) => x.path === p);
        if (known?.type === 'dir') reveal(p).then(() => toggleDir(p, true));
        else openFile(p);
      });
    }
    for (const img of prose.querySelectorAll('img[src]')) {
      const p = target(img.getAttribute('src'));
      if (p && VIDEO_EXT.test(p)) img.replaceWith(videoPlayer(p, img.getAttribute('alt') || p, 'wiki-embed brain-video'));
      else if (p) img.setAttribute('src', `/api/brain/image?${query(p)}`);
    }
  }

  // Obsidian-style [[links]]: the server finds each target by name anywhere in the brain.
  // Found links open in the viewer (scrolling to a #heading); ![[image]] embeds show the
  // image and ![[video]] embeds a player; an embedded note shows as a link; targets that
  // don't exist are marked, not dead.
  const IMAGE_EXT = /\.(png|jpe?g|gif|webp|avif)$/i;
  async function wireWikiLinks(prose, from) {
    const links = [...prose.querySelectorAll('a.wiki-link')];
    if (!links.length) return;
    const names = [...new Set(links.map((a) => a.dataset.wiki))];
    let found;
    try { found = await api('POST', '/api/brain/resolve', { from, names }); }
    catch { for (const a of links) a.title = 'Couldn\'t look up this link. Refresh to try again.'; return; }
    if (file?.path !== from || !prose.isConnected) return; // another file opened meanwhile
    for (const a of links) {
      const target = a.dataset.wiki;
      const heading = target.includes('#') ? target.slice(target.indexOf('#') + 1).replace(/^\^.*/, '') : '';
      const p = found[target];
      a.removeAttribute('target');
      if (!p) {
        a.classList.add('unresolved');
        a.removeAttribute('href');
        a.title = `There's no "${target.split('#')[0]}" in the brain folder.`;
        continue;
      }
      if (a.dataset.embed && IMAGE_EXT.test(p)) {
        a.replaceWith(h('img', { class: 'wiki-embed', src: `/api/brain/image?${query(p)}`, alt: a.textContent, title: p }));
        continue;
      }
      if (a.dataset.embed && VIDEO_EXT.test(p)) {
        a.replaceWith(videoPlayer(p, a.textContent, 'wiki-embed brain-video'));
        continue;
      }
      a.setAttribute('href', `#brain/${encodeURI(p)}`);
      a.title = heading ? `${p} › ${heading}` : p;
      if (a.dataset.embed) a.classList.add('embed');
      a.addEventListener('click', (e) => {
        e.preventDefault();
        if (p === file?.path) scrollToHeading(heading);
        else openFile(p, { heading });
      });
    }
  }

  // Headings get no ids from marked, so match on their text, ignoring case and spacing.
  function scrollToHeading(heading) {
    if (!heading) return;
    const norm = (s) => s.toLowerCase().replace(/\s+/g, ' ').trim();
    const el = [...doc.querySelectorAll('h1, h2, h3, h4, h5, h6')].find((x) => norm(x.textContent) === norm(heading));
    if (!el) { setStatus(`There's no "${heading}" heading in ${file.name}.`); return; }
    el.scrollIntoView({ block: 'start', behavior: 'smooth' });
    el.classList.add('flash');
    setTimeout(() => el.classList.remove('flash'), 1200);
  }

  // ---- Editing ------------------------------------------------------------
  function toggleSource() {
    htmlSource = !htmlSource;
    store.set('brain.htmlSource', htmlSource);
    renderFile();
  }

  function startEdit() {
    editor = h('textarea', { class: 'brain-editor', spellcheck: 'true', 'aria-label': `Edit ${file.name}` });
    editor.value = file.lf;
    editor.addEventListener('input', renderActions);
    editor.addEventListener('keydown', (e) => {
      if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 's') { e.preventDefault(); save(); }
    });
    setStatus('');
    renderFile();
    editor.focus();
  }

  async function cancelEdit() {
    if (!(await confirmDiscard())) return;
    editor = null;
    setStatus('');
    renderFile();
  }

  async function save() {
    if (!dirty() || saving) return;
    saving = true;
    renderActions();
    setStatus('Saving…');
    const content = editor.value;
    try {
      const r = await api('PUT', '/api/brain/file', { path: file.path, content, version: file.version });
      file = { ...file, content, lf: content, version: r.version, size: r.size ?? file.size };
      editor = null;
      renderFile();
      setStatus(r.unchanged ? 'No changes to save.' : r.committed ? 'Saved and committed to git.' : r.commitError || 'Saved.', !!r.commitError);
    } catch (err) {
      setStatus(err.message, true, err.status === 409 && editor ? {
        label: 'Reload from disk',
        run: async () => {
          if (!(await confirmDialog({ title: `Reload ${file.name} from disk?`, message: 'Your unsaved edits are lost. Copy anything you want to keep first.',
            confirm: 'Reload and lose edits', cancel: 'Keep editing', danger: true }))) return;
          editor = null;
          openFile(file.path, { force: true });
        }
      } : null);
    } finally {
      saving = false;
      renderActions();
    }
  }

  window.addEventListener('beforeunload', (e) => { if (dirty()) { e.preventDefault(); e.returnValue = ''; } });

  // ---- View lifecycle -----------------------------------------------------
  return {
    // Edits survive switching to another view and back, so leaving is always allowed.
    async show(path) {
      if (!started) {
        started = true;
        renderFile();
        await refreshTree();
      } else if (!path) refreshTree();
      if (path && path !== file?.path) openFile(path);
      else if (file) ctx.setRoute(encodeURI(file.path));
    },
    // Access changed (an admin edited this profile): re-read the file so edit rights match.
    // Access may have changed: the Upload button, each row's options and the file's edit rights follow.
    profileChanged() {
      uploadBtn.hidden = ctx.access() !== 'edit';
      if (!started) return;
      refreshTree();
      if (file && !editor) openFile(file.path, { quiet: true });
    }
  };
}
