// A code editor for the Apps view: a plain textarea over a coloured copy of its text
// (lib/highlight.js), with line numbers. The textarea does all the editing, so undo, selection,
// copy and paste, the phone keyboard and dictation work as anywhere else; its own text is
// transparent and the layer under it shows the colours. Both use the same font and never wrap,
// so the letters line up. Tab indents by two spaces (Shift+Tab outdents); Esc, then Tab, leaves
// the box, so keyboard users aren't trapped. Ctrl+S (⌘S) saves.
import { h } from '../lib/dom.js';
import { highlight } from '../lib/highlight.js';

const INDENT = '  ';

/**
 * @param {{ name: string, text: string, readOnly?: boolean, onInput?: () => void, onSave?: () => void }} o
 * Returns { el, value(), focus() }.
 */
export function codeEditor({ name, text, readOnly = false, onInput, onSave }) {
  const input = h('textarea', { class: 'code-input', spellcheck: 'false', autocapitalize: 'off', autocomplete: 'off',
    wrap: 'off', 'aria-label': `Edit ${name}`, readonly: readOnly || null });
  input.value = text;
  const layer = h('pre', { class: 'code-layer', 'aria-hidden': 'true' });
  const lines = h('div', { class: 'code-lines', 'aria-hidden': 'true' });
  const el = h('div', { class: 'code-editor' }, lines, h('div', { class: 'code-body' }, layer, input));

  let frame = 0, lineCount = 0;
  function paint() {
    frame = 0;
    // A trailing newline needs something after it, or the layer is a line short of the textarea.
    layer.replaceChildren(highlight(input.value, name), '\n');
    const n = input.value.split('\n').length;
    if (n !== lineCount) {
      lineCount = n;
      lines.textContent = Array.from({ length: n }, (_, i) => i + 1).join('\n');
    }
    sync();
  }
  const later = () => { if (!frame) frame = requestAnimationFrame(paint); };
  function sync() {
    layer.style.transform = `translate(${-input.scrollLeft}px, ${-input.scrollTop}px)`;
    lines.style.transform = `translateY(${-input.scrollTop}px)`;
  }

  let escaped = false; // Esc was pressed, so the next Tab moves focus as usual
  input.addEventListener('input', () => { later(); onInput?.(); });
  input.addEventListener('scroll', sync, { passive: true });
  input.addEventListener('keydown', (e) => {
    if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 's') { e.preventDefault(); onSave?.(); return; }
    if (e.key === 'Escape') { escaped = true; return; }
    if (e.key !== 'Tab' || readOnly || escaped || e.ctrlKey || e.altKey || e.metaKey) { escaped = false; return; }
    e.preventDefault();
    indent(e.shiftKey);
  });

  // Indents (or outdents) the selected lines, or inserts two spaces at the cursor. Done
  // through execCommand where it exists, so the browser's undo still covers it.
  function indent(out) {
    const { selectionStart: s, selectionEnd: end, value } = input;
    const lineStart = value.lastIndexOf('\n', s - 1) + 1;
    if (s === end && !out) { replace(s, end, INDENT, s + INDENT.length, s + INDENT.length); return; }
    const block = value.slice(lineStart, end);
    const changed = out ? block.replace(/^ {1,2}/gm, '') : block.replace(/^/gm, INDENT);
    const first = out ? -(block.length - block.replace(/^ {1,2}/, '').length) : INDENT.length;
    replace(lineStart, end, changed, Math.max(lineStart, s + first), end + changed.length - block.length);
  }
  function replace(from, to, text, selStart, selEnd) {
    input.setSelectionRange(from, to);
    if (!document.execCommand?.('insertText', false, text)) input.setRangeText(text, from, to, 'end');
    input.setSelectionRange(selStart, selEnd);
    later();
    onInput?.();
  }

  paint();
  return { el, value: () => input.value, focus: () => input.focus({ preventScroll: true }) };
}
