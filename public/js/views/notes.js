// Notes view: sticky notes in a wrapping grid, in an order the user sets.
// Click a note to edit it in place; it saves as you type and when you leave it. Markdown in
// a note renders through the transcript's pipeline when it isn't being edited. Active notes
// come first and are counted; long-standing ones sit in their own section below, uncounted.
import { h, svgIcon } from '../lib/dom.js';
import { api } from '../lib/api.js';
import { store } from '../lib/store.js';
import { renderMarkdown } from '../lib/markdown.js';
import { openMenu } from '../lib/menu.js';
import { confirmDialog } from '../lib/dialog.js';
import { draggable } from '../lib/drag.js';
import { canDictate, toggleDictation, stopDictation } from '../lib/speech.js';

const COLORS = [['yellow', 'Yellow'], ['green', 'Green'], ['blue', 'Blue'], ['pink', 'Pink'], ['purple', 'Purple'], ['grey', 'Grey']];
const COLOR_NAME = Object.fromEntries(COLORS);
const ICONS = {
  menu: 'M4 6h16M4 12h16M4 18h16', earlier: 'm15 6-6 6 6 6', later: 'm9 6 6 6-6 6',
  trash: 'M4 7h16M10 11v6M14 11v6M6 7l1 13h10l1-13M9 7V4h6v3',
  shelve: 'M4 8h16v11H4zM3 4h18v4H3zM10 12h4',
  bold: 'M7 5h6a3.5 3.5 0 0 1 0 7H7zM7 12h7a3.5 3.5 0 0 1 0 7H7z', italic: 'M19 4h-9M14 20H5M15 4 9 20',
  list: 'M9 6h11M9 12h11M9 18h11M4.5 6h.01M4.5 12h.01M4.5 18h.01', mic: 'M12 3a3 3 0 0 0-3 3v6a3 3 0 0 0 6 0V6a3 3 0 0 0-3-3ZM19 11a7 7 0 0 1-14 0M12 18v3', cancel: 'M18 6 6 18M6 6l12 12', save: 'M20 6 9 17l-5-5', unshelve: 'M12 19V6m-6 6 6-6 6 6', palette: 'M12 3a9 9 0 1 0 0 18c1 0 1.5-.8 1.5-1.6 0-1.2-1-1.4-1-2.4 0-.8.7-1.5 1.5-1.5H16a5 5 0 0 0 5-5c0-4-4-7.5-9-7.5ZM7.5 11h.01M10 7.5h.01M14.5 7.5h.01'
};
const BULLET = /^(\s*)[-*+] /;

// Notes are typed like plain text, so they render closer to what was typed than chat
// markdown does: every line break shows (the breaks option), a plain line straight after a
// list item starts a new paragraph instead of joining that item, and extra blank lines keep
// their space. Fenced code blocks are left exactly as they are.
function noteMarkdown(text) {
  return text.replace(/\r\n?/g, '\n').split(/(^(?:```|~~~)[^\n]*\n[\s\S]*?^(?:```|~~~)[^\n]*$)/m)
    .map((part, i) => i % 2 ? part : part
      .replace(/^(\s*(?:[-*+]|\d+[.)]) .*)\n(?=\S)(?![-*+] |\d+[.)] )/gm, '$1\n\n')
      .replace(/\n{3,}/g, (m) => `\n\n${'&nbsp;\n\n'.repeat(m.length - 2)}`))
    .join('');
}

const icon = (name) => svgIcon(ICONS[name]);

export function init(ctx) {
  const { side, main } = ctx;
  const canEdit = () => ctx.access() === 'edit';
  let notes = [];
  let filter = store.get('notes.color', null); // a colour, or null for every note
  let editing = null;   // { id, input, timer, fresh } while a note is open for editing
  let dragging = null, stale = false, loaded = false;

  // ---- Layout -------------------------------------------------------------
  const count = h('span', { class: 'cat-count' });
  const newBtn = h('button', { type: 'button', class: 'send-btn' }, 'New note');
  const grid = h('div', { class: 'note-grid' });
  const longGrid = h('div', { class: 'note-grid' });
  const longSection = h('section', { class: 'note-long', 'aria-labelledby': 'notesLongTitle' },
    h('h3', { id: 'notesLongTitle' }, 'Long-standing ', h('span', { class: 'muted' }, 'not counted')), longGrid);
  const board = h('section', { class: 'note-board' }, grid, longSection);
  const status = h('p', { class: 'view-status', role: 'status' });
  main.append(h('header', { class: 'topbar notes-bar' },
    h('button', { type: 'button', class: 'icon-btn menu-btn', 'aria-label': 'Show the sidebar' }, icon('menu')),
    h('h2', { class: 'tasks-week' }, 'Notes'), count, h('span', { class: 'spacer' }), newBtn), board, status);
  newBtn.addEventListener('click', () => create());

  const colorList = h('nav', { class: 'task-days', 'aria-label': 'Filter notes by colour' });
  side.append(h('div', { class: 'brain-side-head' }, h('span', { class: 'cat-label' }, 'Colours')), colorList);

  let statusTimer;
  function setStatus(text, isError = false) {
    status.textContent = text;
    status.classList.toggle('error', isError);
    clearTimeout(statusTimer);
    if (text) statusTimer = setTimeout(() => { status.textContent = ''; }, isError ? 8000 : 3000);
  }

  // ---- Data ---------------------------------------------------------------
  async function load() {
    try { notes = await api('GET', '/api/notes'); loaded = true; render(); }
    catch (err) { setStatus(`Couldn't load notes: ${err.message}`, true); }
  }

  const replace = (n) => { notes = notes.map((x) => (x.id === n.id ? n : x)); };

  async function create() {
    if (!canEdit()) return;
    try {
      const n = await api('POST', '/api/notes', { color: filter || 'yellow' });
      notes = [n, ...notes];
      render();
      edit(n, true);
    } catch (err) { setStatus(err.message, true); }
  }

  async function update(n, body) {
    try { replace(await api('PATCH', `/api/notes/${n.id}`, body)); } catch (err) { setStatus(err.message, true); }
  }

  async function move(id, beforeId) {
    try { notes = await api('POST', `/api/notes/${id}/move`, { beforeId }); } catch (err) { setStatus(err.message, true); }
    render();
  }

  async function setActive(n, active) {
    await update(n, { active });
    setStatus(active ? 'Note is active again and counted.' : 'Note moved to long-standing. It isn\'t counted.');
    render();
  }

  async function remove(n, { quiet = false } = {}) {
    if (!quiet && !(await confirmDialog({ title: 'Delete this note?', message: 'This can\'t be undone.', danger: true, confirm: 'Delete note' }))) return;
    try {
      await api('DELETE', `/api/notes/${n.id}`);
      notes = notes.filter((x) => x.id !== n.id);
      if (!quiet) setStatus('Note deleted.');
    } catch (err) { setStatus(err.message, true); }
    render();
  }

  // ---- Rendering ----------------------------------------------------------
  function render() {
    if (editing || dragging) { stale = true; return; }
    stale = false;
    const list = filter ? notes.filter((n) => n.color === filter) : notes;
    const active = list.filter((n) => n.active), long = list.filter((n) => !n.active);
    const activeCount = notes.filter((n) => n.active).length;
    count.textContent = String(activeCount);
    count.title = `${activeCount} active ${activeCount === 1 ? 'note' : 'notes'}`;
    grid.replaceChildren(...active.map((n) => card(n, active)));
    longGrid.replaceChildren(...long.map((n) => card(n, long)));
    // An empty long-standing section only shows during a drag, as somewhere to drop.
    if (!long.length) longGrid.append(h('p', { class: 'note-drop-hint' }, 'Drop a note here to make it long-standing.'));
    longSection.hidden = !long.length;
    if (!active.length) {
      // With long-standing notes below, the notice stays small so they sit near the top.
      grid.append(h('div', { class: `empty note-empty${long.length ? ' compact' : ''}` },
        h('h2', {}, filter ? `No active ${COLOR_NAME[filter].toLowerCase()} notes` : long.length ? 'No active notes' : 'No notes yet'),
        h('p', {}, canEdit() ? 'Use New note to add one. Drag notes to put them in any order.' : 'Notes you add will show here.')));
    }
    newBtn.hidden = !canEdit();
    renderColors();
  }

  function renderColors() {
    const row = (value, label) => {
      const n = value ? notes.filter((x) => x.color === value).length : notes.length;
      const b = h('button', { type: 'button', class: 'task-day', 'aria-pressed': String(filter === value) },
        h('span', {}, value ? h('span', { class: `swatch note-${value}`, 'aria-hidden': 'true' }) : null, label), h('span', { class: 'cat-count' }, String(n)));
      b.addEventListener('click', () => { filter = value; store.set('notes.color', value); render(); ctx.closeSidebar(); });
      return b;
    };
    colorList.replaceChildren(row(null, 'All notes'), ...COLORS.map(([c, label]) => row(c, label)));
  }

  // section: the notes shown alongside this one (active or long-standing), for moving within it.
  function card(n, section) {
    const body = h('div', { class: 'note-body prose' });
    if (n.text.trim()) body.innerHTML = renderMarkdown(noteMarkdown(n.text), { breaks: true }); // marked, then DOMPurify
    else body.append(h('p', { class: 'note-placeholder' }, canEdit() ? 'Empty note. Click to write.' : 'Empty note.'));
    const el = h('article', { class: `note note-${n.color}${n.active ? '' : ' long'}`, 'data-id': n.id,
      'aria-label': `${COLOR_NAME[n.color]} ${n.active ? 'note' : 'long-standing note'}` }, body);
    if (!canEdit()) return el;

    body.tabIndex = 0;
    body.setAttribute('role', 'button');
    body.setAttribute('aria-label', 'Edit note');
    body.addEventListener('click', (e) => { if (!e.target.closest('a')) edit(n); });
    body.addEventListener('keydown', (e) => { if (e.key === 'Enter' && e.target === body) { e.preventDefault(); edit(n); } });

    const order = section.map((x) => x.id), i = order.indexOf(n.id);
    const tool = (name, label, action, disabled = false) => {
      const b = h('button', { type: 'button', class: 'icon-btn', title: label, 'aria-label': label, disabled }, icon(name));
      b.addEventListener('click', () => action(b));
      return b;
    };
    el.append(h('footer', { class: 'note-tools' },
      tool('palette', 'Change colour', (b) => openMenu(b, COLORS.map(([c, label]) => ({ label, swatch: c, disabled: c === n.color,
        action: async () => { await update(n, { color: c }); render(); } })))),
      tool('earlier', 'Move earlier', () => move(n.id, order[i - 1]), i <= 0),
      tool('later', 'Move later', () => move(n.id, order[i + 2] ?? null), i >= order.length - 1),
      n.active
        ? tool('shelve', 'Mark as long-standing (not counted)', () => setActive(n, false))
        : tool('unshelve', 'Mark as active', () => setActive(n, true)),
      h('span', { class: 'spacer' }),
      tool('trash', 'Delete note', () => remove(n))));
    el.append(h('footer', { class: 'note-tools note-edit-tools' },
      tool('bold', 'Bold (Ctrl+B)', () => wrap('**')),
      tool('italic', 'Italic (Ctrl+I)', () => wrap('*')),
      tool('list', 'Bullet list (Ctrl+Shift+8)', () => bullets()),
      canDictate ? tool('mic', 'Dictate', (b) => dictate(b)) : null,
      h('span', { class: 'spacer' }),
      tool('cancel', 'Cancel changes', () => finish(false)),
      tool('save', 'Save and close (Ctrl+Enter)', () => finish(true))));
    // The editing buttons mustn't take focus, or the text box would lose its selection.
    for (const b of el.querySelectorAll('.note-edit-tools button')) b.addEventListener('mousedown', (e) => e.preventDefault());
    dragNote(el, n);
    return el;
  }

  // ---- Editing ------------------------------------------------------------
  // While a note is open its toolbar swaps for the editing one: bold and italic, then cancel
  // and save. It still saves as you type; Cancel puts back the text it had when opened.
  // fresh: a note just made with New note. Left empty, or cancelled, it's removed again.
  function edit(n, fresh = false) {
    if (editing) return;
    const el = board.querySelector(`[data-id="${n.id}"]`);
    if (!el) return;
    const input = h('textarea', { class: 'note-input', maxlength: '10000', 'aria-label': 'Note text', placeholder: 'Write a note' });
    input.value = n.text;
    el.querySelector('.note-body').replaceWith(input);
    el.classList.add('editing');
    editing = { n, el, input, timer: null, fresh, saved: n.text, original: n.text };
    input.focus();
    input.setSelectionRange(input.value.length, input.value.length);

    input.addEventListener('input', () => {
      clearTimeout(editing.timer);
      editing.timer = setTimeout(saveDraft, 800);
    });
    input.addEventListener('keydown', (e) => {
      const mod = e.ctrlKey || e.metaKey;
      if (e.key === 'Escape') { e.preventDefault(); finish(true); }
      else if (mod && e.key === 'Enter') { e.preventDefault(); finish(true); }
      else if (mod && !e.shiftKey && !e.altKey && ['b', 'i'].includes(e.key.toLowerCase())) { e.preventDefault(); wrap(e.key.toLowerCase() === 'b' ? '**' : '*'); }
      else if (mod && e.shiftKey && e.code === 'Digit8') { e.preventDefault(); bullets(); }
      else if (e.key === 'Enter' && !mod && !e.shiftKey && !e.altKey && continueList()) e.preventDefault();
    });
    // Leaving the note (not just moving to its own buttons) saves and closes it.
    el.addEventListener('focusout', (e) => { if (editing?.el === el && !el.contains(e.relatedTarget)) finish(true, false); });
  }

  async function saveDraft() {
    const state = editing;
    if (!state || state.input.value === state.saved) return;
    const text = state.input.value;
    await update(state.n, { text });
    state.saved = text;
  }

  // keep: save what's there; otherwise put back the text the note had when it was opened.
  // refocus: put focus back on the note, unless focus has already gone somewhere else.
  async function finish(keep, refocus = true) {
    const state = editing;
    if (!state) return;
    clearTimeout(state.timer);
    stopDictation();
    editing = null;
    const text = keep ? state.input.value : state.original;
    if (state.fresh && !text.trim()) { await remove(state.n, { quiet: true }); return; }
    if (text !== state.saved) await update(state.n, { text });
    if (!keep) setStatus('Changes cancelled.');
    render();
    if (refocus) board.querySelector(`[data-id="${state.n.id}"] .note-body`)?.focus({ preventScroll: true });
  }

  // Wraps the selection in a markdown marker (** bold, * italic), or unwraps it if it's
  // already wrapped. With nothing selected it leaves the cursor between a new pair. It goes
  // through insertText where it can, so the browser's undo still works.
  function wrap(mark) {
    const input = editing?.input;
    if (!input) return;
    input.focus();
    const { selectionStart: a, selectionEnd: b, value: v } = input;
    const m = mark.length;
    // Italic mustn't mistake a bold pair for its own marker.
    const markedAt = (i) => v.slice(i, i + m) === mark && (m === 2 || (v[i - 1] !== '*' && v[i + 1] !== '*'));
    const wrapped = a >= m && markedAt(a - m) && markedAt(b);
    if (wrapped) {
      put(input, a - m, b + m, v.slice(a, b));
      input.setSelectionRange(a - m, b - m);
    } else {
      put(input, a, b, mark + v.slice(a, b) + mark);
      input.setSelectionRange(a + m, b + m);
    }
  }

  // Speech to text at the cursor (lib/speech.js). Typing, or closing the note, stops it.
  function dictate(button) {
    const input = editing?.input;
    if (!input) return;
    input.focus();
    toggleDictation(input, {
      onState({ listening, error }) {
        button.classList.toggle('listening', listening);
        button.setAttribute('aria-pressed', String(listening));
        if (error) setStatus(error, true);
        else setStatus(listening ? 'Listening. Speak now; press any key or the microphone to stop.' : '');
      }
    });
  }

  // Replaces a range of the text box. insertText keeps the browser's undo working and fires
  // input itself; the fallback has to fire it by hand. Removing text is a delete, because an
  // empty insertText leaves Chrome's cursor in the wrong place.
  function put(input, from, to, text) {
    input.setSelectionRange(from, to);
    if (document.execCommand(text ? 'insertText' : 'delete', false, text)) return;
    input.setRangeText(text, from, to, 'end');
    input.dispatchEvent(new Event('input'));
  }

  // Bullets every line the selection touches, one per line. If they all have one already,
  // they all lose it instead. Blank lines in a selection of several are left blank.
  function bullets() {
    const input = editing?.input;
    if (!input) return;
    input.focus();
    const { selectionStart: a, selectionEnd: b, value: v } = input;
    const start = v.lastIndexOf('\n', a - 1) + 1;
    // A selection ending just after a line break doesn't include the next line.
    let end = v.indexOf('\n', b > a && v[b - 1] === '\n' ? b - 1 : b);
    if (end < 0) end = v.length;
    const lines = v.slice(start, end).split('\n');
    const skip = (l) => lines.length > 1 && !l.trim();
    const off = lines.some((l) => BULLET.test(l)) && lines.every((l) => BULLET.test(l) || skip(l));
    const text = lines.map((l) => off ? l.replace(BULLET, '$1') : BULLET.test(l) || skip(l) ? l : `- ${l}`).join('\n');
    put(input, start, end, text);
    if (a === b) input.setSelectionRange(start + text.length, start + text.length);
    else input.setSelectionRange(start, start + text.length);
  }

  // Enter on a bulleted line starts the next bullet; Enter on an empty bullet ends the list.
  // Returns false when it isn't a bulleted line, so Enter works as normal.
  function continueList() {
    const input = editing?.input;
    const { selectionStart: a, selectionEnd: b, value: v } = input;
    if (a !== b) return false;
    const start = v.lastIndexOf('\n', a - 1) + 1;
    const m = v.slice(start, a).match(/^(\s*)([-*+]) (.*)$/);
    if (!m) return false;
    if (!m[3].trim() && !v.slice(a).split('\n')[0].trim()) put(input, start, a, '');
    else put(input, a, a, `\n${m[1]}${m[2]} `);
    return true;
  }

  // ---- Drag and drop ------------------------------------------------------
  // The whole note drags (lib/drag.js); a click without movement still opens it for editing.
  // Notes flow left to right, so the left half of a note means before it, the right half
  // after. In the gaps between notes the nearest note decides, so a drop there never jumps to
  // the end; below a section's last row (or in an empty section) it goes to the end of that
  // section, switching between active and long-standing if it came from the other one.
  const clearMarks = () => { for (const el of board.querySelectorAll('.drop-before, .drop-after, .drop-target')) el.classList.remove('drop-before', 'drop-after', 'drop-target'); };

  function dropAt(x, y, under) {
    const section = under?.closest('.note-grid, .note-long');
    if (!section || !board.contains(section)) return null;
    const gridEl = section.classList.contains('note-long') ? longGrid : section;
    const active = gridEl === grid;
    let el = under.closest('.note');
    if (!el || el.classList.contains('drag-source')) {
      const cards = [...gridEl.querySelectorAll(':scope > .note:not(.drag-source)')];
      const rects = cards.map((c) => c.getBoundingClientRect());
      // Under the last row: the end of this section.
      if (!cards.length || y > Math.max(...rects.map((r) => r.bottom))) return { el: active ? grid : longSection, active, where: 'end' };
      const gap = (r) => Math.hypot(Math.max(r.left - x, 0, x - r.right), Math.max(r.top - y, 0, y - r.bottom));
      el = cards[rects.reduce((best, r, i) => gap(r) < gap(rects[best]) ? i : best, 0)];
    }
    const n = notes.find((x) => x.id === el.dataset.id);
    if (!n || n.id === dragging) return null;
    const r = el.getBoundingClientRect();
    return { el, n, where: x - r.left < r.width / 2 ? 'before' : 'after' };
  }

  function dragNote(el, n) {
    draggable(el, {
      canStart: () => !editing,
      start() {
        dragging = n.id;
        el.classList.add('drag-source');
        board.classList.add('dragging');
        longSection.hidden = false; // somewhere to drop, even when it's empty
      },
      move(x, y, under) {
        const target = dropAt(x, y, under);
        clearMarks();
        if (target) target.el.classList.add(target.where === 'end' ? 'drop-target' : `drop-${target.where}`);
      },
      async drop(x, y, under) {
        const target = dropAt(x, y, under), id = dragging;
        const dragged = notes.find((x) => x.id === id);
        dragging = null;
        if (!target || !dragged) return render();
        const into = target.where === 'end' ? target.active : target.n.active;
        // Dropped among the other section's notes: it joins that section.
        if (dragged.active !== into) {
          await update(dragged, { active: into });
          setStatus(into ? 'Note is active again and counted.' : 'Note moved to long-standing. It isn\'t counted.');
        }
        // Sections share one order, so the very end is also the end of this section.
        if (target.where === 'end') return move(id, null);
        const order = notes.map((x) => x.id).filter((x) => x !== id);
        move(id, target.where === 'before' ? target.n.id : order[order.indexOf(target.n.id) + 1] ?? null);
      },
      end(dropped) {
        el.classList.remove('drag-source');
        board.classList.remove('dragging');
        clearMarks();
        if (!dropped) { dragging = null; render(); }
      }
    });
  }

  return {
    show() { ctx.setRoute(''); load(); },
    onServer(m) { if (m.t === 'notes_changed' && loaded) load(); },
    profileChanged() { if (loaded) render(); }
  };
}
