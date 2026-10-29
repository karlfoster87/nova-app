// Soul view: the behavioural prompt every chat gets, setting Nova's character, style, tone and
// friendliness. Everyone with brain access reads it here; only an admin sees Edit. The server
// checks both, and restarts quiet chats after a save so they pick it up.
import { h, svgIcon } from '../lib/dom.js';
import { api } from '../lib/api.js';
import { renderMarkdown } from '../lib/markdown.js';
import { confirmDialog } from '../lib/dialog.js';

const lf = (text) => text.replace(/\r\n?/g, '\n').replace(/\s+$/, '');
const when = (ms) => new Date(ms).toLocaleString('en-GB', { day: 'numeric', month: 'short', year: 'numeric', hour: '2-digit', minute: '2-digit' });

export function init(ctx) {
  const { side, main } = ctx;
  let soul = null;     // { text, version, updatedAt, canEdit, maxChars } as the server sent it
  let editor = null;   // the textarea while editing
  let saving = false, stale = false;

  // ---- Layout -------------------------------------------------------------
  const changed = h('p', { class: 'soul-meta muted' });
  side.append(h('div', { class: 'brain-side-head' }, h('span', { class: 'cat-label' }, 'Soul')),
    h('div', { class: 'soul-about' },
      h('p', {}, 'How Nova comes across in every chat, for every profile: its character, style, tone and friendliness.'),
      h('p', { class: 'muted' }, 'It applies to new chats straight away, and to open chats when they next go quiet. Only an admin can change it.'),
      changed));

  const actions = h('div', { class: 'brain-actions' });
  const doc = h('section', { class: 'brain-doc' });
  const status = h('div', { class: 'brain-status', role: 'status' });
  main.append(h('header', { class: 'topbar brain-bar' },
    h('button', { type: 'button', class: 'icon-btn menu-btn', 'aria-label': 'Show the sidebar' }, svgIcon('M4 6h16M4 12h16M4 18h16')),
    h('p', { class: 'brain-crumbs' }, h('span', { class: 'crumb-file' }, 'Soul')), actions), doc, status);

  function setStatus(text = '', isError = false, action = null) {
    const kids = text ? [h('span', {}, text)] : [];
    if (action) kids.push(h('button', { type: 'button', class: 'text-btn', onclick: action.run }, action.label));
    status.replaceChildren(...kids);
    status.classList.toggle('error', isError);
  }

  async function load() {
    try {
      soul = await api('GET', '/api/soul');
      stale = false;
      render();
    } catch (err) { setStatus(err.message, true); }
  }

  const dirty = () => !!editor && lf(editor.value) !== lf(soul.text);
  const count = () => h('span', { class: `soul-count${editor.value.length > soul.maxChars ? ' over' : ''}` },
    `${editor.value.length.toLocaleString('en-GB')} / ${soul.maxChars.toLocaleString('en-GB')}`);

  function renderActions() {
    const kids = [];
    if (editor) {
      kids.push(count());
      kids.push(h('button', { type: 'button', class: 'text-btn', onclick: cancelEdit }, 'Cancel'));
      kids.push(h('button', { type: 'button', class: 'send-btn', disabled: !dirty() || saving || editor.value.length > soul.maxChars, onclick: save },
        saving ? 'Saving…' : 'Save'));
    } else if (soul?.canEdit) {
      kids.push(h('button', { type: 'button', class: 'text-btn', onclick: startEdit }, 'Edit'));
    }
    actions.replaceChildren(...kids);
  }

  function render() {
    renderActions();
    changed.textContent = soul?.updatedAt ? `Last changed ${when(soul.updatedAt)}.` : '';
    doc.classList.toggle('editing', !!editor);
    if (editor) { doc.replaceChildren(editor); return; }
    if (!soul) return;
    if (!soul.text.trim()) {
      doc.replaceChildren(h('div', { class: 'empty' }, h('h2', {}, 'No Soul yet'),
        h('p', {}, soul.canEdit ? 'Nova uses its default manner. Press Edit to describe how it should come across.'
          : 'Nova uses its default manner. An admin can describe how it should come across.')));
      return;
    }
    const note = soul.canEdit ? null : h('p', { class: 'brain-readonly' }, 'View only: only an admin can change the Soul.');
    const tpl = document.createElement('template');
    tpl.innerHTML = renderMarkdown(soul.text);
    doc.replaceChildren(h('article', { class: 'brain-article' }, note, h('div', { class: 'prose' }, tpl.content)));
  }

  function startEdit() {
    editor = h('textarea', { class: 'brain-editor', spellcheck: 'true', 'aria-label': 'Edit the Soul',
      placeholder: 'For example: Warm and plain-spoken. Short answers first, detail when asked. British English. A light touch of humour with the family; crisp and formal for work.' });
    editor.value = lf(soul.text);
    editor.addEventListener('input', renderActions);
    editor.addEventListener('keydown', (e) => {
      if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 's') { e.preventDefault(); save(); }
    });
    setStatus('');
    render();
    editor.focus();
  }

  async function cancelEdit() {
    if (dirty() && !(await confirmDialog({ title: 'Discard your changes to the Soul?', message: 'Your edits haven\'t been saved.',
      confirm: 'Discard changes', cancel: 'Keep editing', danger: true }))) return;
    editor = null;
    setStatus('');
    if (stale) load(); else render();
  }

  async function save() {
    if (!dirty() || saving) return;
    saving = true;
    renderActions();
    setStatus('Saving…');
    try {
      soul = await api('PUT', '/api/soul', { text: editor.value, version: soul.version });
      editor = null;
      stale = false;
      render();
      setStatus('Saved. New chats use it now; open chats pick it up when they next go quiet.');
    } catch (err) {
      setStatus(err.message, true, err.status === 409 ? {
        label: 'Reload',
        run: async () => {
          if (!(await confirmDialog({ title: 'Reload the Soul?', message: 'Your unsaved edits are lost. Copy anything you want to keep first.',
            confirm: 'Reload and lose edits', cancel: 'Keep editing', danger: true }))) return;
          editor = null;
          setStatus('');
          load();
        }
      } : null);
    } finally {
      saving = false;
      renderActions();
    }
  }

  window.addEventListener('beforeunload', (e) => { if (dirty()) { e.preventDefault(); e.returnValue = ''; } });

  // ---- View lifecycle -----------------------------------------------------
  let started = false;
  return {
    // Edits survive switching to another view and back, as in the brain.
    show() {
      ctx.setRoute('');
      if (!started) { started = true; load(); } else if (!editor) load();
    },
    // An admin saved the Soul, here or in another tab. An open editor keeps its text and is told.
    onServer(m) {
      if (m.t !== 'soul_changed' || !started) return;
      if (!editor) load();
      else if (!saving) { stale = true; setStatus('An admin has just changed the Soul. Your save will be refused until you reload it.', true); }
    },
    profileChanged() { if (started && !editor) load(); }
  };
}
