// Activity log for this tab: what Claude, its tools and sub-agents did, prompts, errors and
// connection changes. app.js writes entries from the events this profile's tabs receive;
// the presence panel shows them (mini log and the Logs tab) via the 'nova:log' event.
// Kept in sessionStorage, so it survives a reload but not closing the tab, and each tab
// keeps its own copy rather than several tabs overwriting one list.

const KEY = 'nova.log';
const MAX = 400;
export const KINDS = { chat: 'Chats', tool: 'Tools', agent: 'Agents', prompt: 'Prompts', error: 'Errors', system: 'System' };

let owner = null;
let entries = [];
let saveTimer = null;

// Starts the log for a profile; another profile's entries (after a switch) are dropped.
export function openLog(profile) {
  owner = profile;
  try {
    const saved = JSON.parse(sessionStorage.getItem(KEY));
    entries = saved?.profile === profile && Array.isArray(saved.entries) ? saved.entries.slice(-MAX) : [];
  } catch { entries = []; }
  window.dispatchEvent(new CustomEvent('nova:log', { detail: { reset: true } }));
}

function save() {
  clearTimeout(saveTimer);
  saveTimer = setTimeout(() => {
    try { sessionStorage.setItem(KEY, JSON.stringify({ profile: owner, entries })); } catch {} // a full or blocked store only loses history
  }, 400);
}

/** kind: one of KINDS. where: the chat title it concerns, if any. */
export function log(kind, text, where = '') {
  const entry = { at: Date.now(), kind: KINDS[kind] ? kind : 'system', text: String(text), where };
  entries.push(entry);
  if (entries.length > MAX) entries.splice(0, entries.length - MAX);
  save();
  window.dispatchEvent(new CustomEvent('nova:log', { detail: { entry } }));
}

export const logEntries = () => entries;

export function clearLog() {
  entries = [];
  save();
  window.dispatchEvent(new CustomEvent('nova:log', { detail: { cleared: true } }));
}

export const clockTime = (at) => new Date(at).toLocaleTimeString('en-GB', { hour12: false });
