// Nova's own confirmation and input dialogs, instead of the browser's confirm() and
// prompt(): styled like the rest of the app, with buttons that say what they do. Both are
// native <dialog> modals, so Esc cancels and focus is trapped; focus returns to wherever it
// was when the dialog closes. The restart screen and the settings dialog are fixed in index.html.
import { h } from './dom.js';

// Shows a dialog and resolves with the value given to dialog.finish(). The buttons finish
// it directly rather than waiting for the dialog's close event, which the browser delivers
// later (and not at all in some cases). Esc arrives as a cancel event, straight away; close
// stays as a backstop for a dialog shut by other code, such as the restart screen.
function show(dialog, focus, onOpen) {
  const back = document.activeElement;
  return new Promise((resolve) => {
    let done = false;
    dialog.finish = (value) => {
      if (done) return;
      done = true;
      if (dialog.open) dialog.close();
      dialog.remove();
      if (back?.isConnected) back.focus();
      resolve(value);
    };
    dialog.addEventListener('cancel', (e) => { e.preventDefault(); dialog.finish(null); });
    dialog.addEventListener('close', () => dialog.finish(null));
    document.body.append(dialog);
    dialog.showModal();
    focus?.focus();
    onOpen?.();
  });
}

/**
 * Asks the user to confirm an action. Resolves true if they did.
 * @param {{ title: string, message?: string, confirm: string, cancel?: string, danger?: boolean }} o
 * danger: the confirm button is red and Cancel has the focus, so a stray Enter doesn't
 * delete anything. Otherwise the confirm button has the focus.
 */
export async function confirmDialog({ title, message = '', confirm, cancel = 'Cancel', danger = false }) {
  const yes = h('button', { type: 'button', class: danger ? 'danger-btn' : 'send-btn', onclick: () => dialog.finish(true) }, confirm);
  const no = h('button', { type: 'button', class: 'text-btn', onclick: () => dialog.finish(false) }, cancel);
  const heading = h('h2', { id: `confirm-${Math.random().toString(36).slice(2)}` }, title);
  const dialog = h('dialog', { class: 'settings small-dialog confirm-dialog', role: 'alertdialog', 'aria-labelledby': heading.id },
    h('div', { class: 'stack' }, heading,
      message ? h('p', { class: 'confirm-message' }, message) : null,
      h('div', { class: 'row' }, h('span', { class: 'spacer' }), no, yes)));
  return (await show(dialog, danger ? no : yes)) === true;
}

/**
 * Asks for one value. Resolves with it, or null if cancelled.
 * @param {{ title: string, label: string, value?: string, type?: string, multiline?: boolean,
 *           submit?: string, maxLength?: number }} o
 */
export function promptDialog({ title, label, value = '', type = 'text', multiline = false, submit = 'Save', maxLength = 4000 }) {
  const field = multiline ? h('textarea', { rows: 6, maxlength: maxLength }) : h('input', { type, required: type === 'date' });
  field.value = value;
  const form = h('form', { class: 'stack' }, h('h2', {}, title), h('label', {}, `${label} `, field),
    h('div', { class: 'row' }, h('span', { class: 'spacer' }),
      h('button', { type: 'button', class: 'text-btn', onclick: () => dialog.finish(null) }, 'Cancel'),
      h('button', { type: 'submit', class: 'send-btn' }, submit)));
  const dialog = h('dialog', { class: 'settings small-dialog' }, form);
  form.addEventListener('submit', (e) => { e.preventDefault(); dialog.finish(field.value); });
  return show(dialog, field, () => { if (!multiline && type === 'text') field.select(); });
}
