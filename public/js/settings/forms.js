// Helpers shared by the settings tabs and the switcher: each form has a .form-status line that
// says how its last action went.
import { state } from '../state.js';

export const isAdmin = () => state.me?.role === 'admin';

export function setStatus(el, text, isError = false) {
  el.textContent = text;
  el.classList.toggle('error', isError);
}

// Runs a form's action with its buttons disabled, and shows the outcome in its status line:
// the message the action returns, or the error it throws.
export async function run(form, action) {
  const status = form.querySelector('.form-status');
  setStatus(status, '');
  const buttons = [...form.querySelectorAll('button')];
  buttons.forEach((b) => { b.disabled = true; });
  try {
    const message = await action();
    if (message && status.isConnected) setStatus(status, message);
  } catch (err) {
    if (status.isConnected) setStatus(status, err.message, true);
  } finally {
    buttons.forEach((b) => { b.disabled = false; });
  }
}

export const roleName = (role) => (role === 'admin' ? 'Admin' : 'User');
export const LEVEL_NAMES = { none: 'No access', read: 'View', edit: 'View and edit' };
