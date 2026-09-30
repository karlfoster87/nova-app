// The composer's pickers: model, effort and permission mode. Model and effort go with each
// message (a change restarts the chat's process on the same session); the mode applies to the
// open chat straight away. This browser remembers the last picks.
import { state, els } from '../state.js';
import { store } from '../lib/store.js';
import { send } from './socket.js';

// What goes with a message.
export function picks() {
  return { model: els.model.value || undefined, effort: els.effortWrap.hidden ? undefined : els.effort.value, mode: els.mode.value };
}

// Shows a chat's own model and effort when it's opened.
export function setPicks(model, effort) {
  if (model && [...els.model.options].some((o) => o.value === model)) els.model.value = model;
  renderEffort(effort);
}

// The models Claude offers (minus any an admin hid), after each 'meta' message.
export function renderPickers() {
  const models = state.meta?.models || [];
  const current = els.model.value || store.get('model', state.meta?.defaultModel);
  els.model.replaceChildren(...models.map((m) => {
    const o = new Option(m.displayName || m.value, m.value);
    o.title = m.description || '';
    return o;
  }));
  if (!models.length) els.model.append(new Option('Default model', ''));
  if ([...els.model.options].some((o) => o.value === current)) els.model.value = current;
  renderEffort();
}

// Effort levels the chosen model supports; hidden for a model without effort.
function renderEffort(wanted) {
  const m = state.meta?.models?.find((x) => x.value === els.model.value);
  const levels = m?.supportsEffort === false ? [] : (m?.supportedEffortLevels?.length ? m.supportedEffortLevels : ['low', 'medium', 'high']);
  els.effortWrap.hidden = !levels.length;
  const keep = wanted || els.effort.value || store.get('effort', state.meta?.defaultEffort);
  els.effort.replaceChildren(...levels.map((l) => new Option(`${l} effort`, l)));
  if (levels.includes(keep)) els.effort.value = keep;
  else if (levels.includes(state.meta?.defaultEffort)) els.effort.value = state.meta.defaultEffort;
}

export function setMode(mode) {
  if (![...els.mode.options].some((o) => o.value === mode)) mode = 'default';
  els.mode.value = mode;
  els.mode.dataset.mode = mode;
}

// A mode's name as the picker shows it.
export const modeName = (mode) => [...els.mode.options].find((o) => o.value === mode)?.text || mode;

els.model.addEventListener('change', () => { store.set('model', els.model.value); renderEffort(); });
els.effort.addEventListener('change', () => store.set('effort', els.effort.value));
els.mode.addEventListener('change', () => {
  setMode(els.mode.value);
  store.set('mode', els.mode.value);
  if (state.current) send({ t: 'mode', chatId: state.current, mode: els.mode.value });
});
