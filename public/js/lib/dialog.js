// Nova's own confirmation and input dialogs, instead of the browser's confirm() and
// prompt(): styled like the rest of the app, with buttons that say what they do. Both are
// native <dialog> modals, so Esc cancels and focus is trapped; focus returns to wherever it
// was when the dialog closes. Built without render.js's h(), which imports this module.

function el(tag, props = {}, ...children) {
  const node = Object.assign(document.createElement(tag), props);
  for (const c of children.flat()) if (c != null) node.append(c);
  return node;
}

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
  const yes = el('button', { type: 'button', className: danger ? 'danger-btn' : 'send-btn', textContent: confirm });
  const no = el('button', { type: 'button', className: 'text-btn', textContent: cancel });
  const heading = el('h2', { textContent: title });
  heading.id = `confirm-${Math.random().toString(36).slice(2)}`;
  const dialog = el('dialog', { className: 'settings small-dialog confirm-dialog' },
    el('div', { className: 'stack' }, heading,
      message ? el('p', { className: 'confirm-message', textContent: message }) : null,
      el('div', { className: 'row' }, el('span', { className: 'spacer' }), no, yes)));
  dialog.setAttribute('aria-labelledby', heading.id);
  dialog.setAttribute('role', 'alertdialog');
  yes.addEventListener('click', () => dialog.finish(true));
  no.addEventListener('click', () => dialog.finish(false));
  return (await show(dialog, danger ? no : yes)) === true;
}

/**
 * Asks for one value. Resolves with it, or null if cancelled.
 * @param {{ title: string, label: string, value?: string, type?: string, multiline?: boolean,
 *           submit?: string, maxLength?: number }} o
 */
export function promptDialog({ title, label, value = '', type = 'text', multiline = false, submit = 'Save', maxLength = 4000 }) {
  const field = multiline ? el('textarea', { rows: 6, maxLength }) : el('input', { type, required: type === 'date' });
  field.value = value;
  const heading = el('h2', { textContent: title });
  const form = el('form', { className: 'stack' }, heading, el('label', {}, `${label} `, field),
    el('div', { className: 'row' }, el('span', { className: 'spacer' }),
      el('button', { type: 'button', className: 'text-btn', textContent: 'Cancel', onclick: () => dialog.finish(null) }),
      el('button', { type: 'submit', className: 'send-btn', textContent: submit })));
  const dialog = el('dialog', { className: 'settings small-dialog' }, form);
  form.addEventListener('submit', (e) => { e.preventDefault(); dialog.finish(field.value); });
  return show(dialog, field, () => { if (!multiline && type === 'text') field.select(); });
}
