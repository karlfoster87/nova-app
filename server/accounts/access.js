// Views beside chats, and how much of each a profile may use. Chats are always
// available. Every view's routes call requireView on the server; the UI only mirrors it.
import { q } from '../core/db.js';
import { config } from '../core/config.js';
import { UserError } from '../core/errors.js';

const LEVELS = ['none', 'read', 'edit'];
const RANK = { none: 0, read: 1, edit: 2 };

// The views Nova has built, in sidebar order. A new view adds an entry here, a browser
// module in public/js/views/ (listed in public/js/shell/views.js), and routes guarded by requireView.
export const VIEWS = [
  { id: 'brain', label: 'Brain', noun: 'brain' },
  { id: 'tasks', label: 'Tasks', noun: 'task list' },
  { id: 'notes', label: 'Notes', noun: 'notes' }
];
const byId = new Map(VIEWS.map((v) => [v.id, v]));

function stored(row) {
  try { return JSON.parse(row.access || '{}') || {}; } catch { return {}; }
}

// { viewId: level } for a profile. Admins have edit everywhere; users get what an admin
// set, else config.views.userDefaults, else none. asUser: what would apply with the user
// role, which the profile editor shows so demoting an admin holds no surprises.
export function accessFor(name, { asUser = false } = {}) {
  const row = q.profile.get(name);
  if (!row) return Object.fromEntries(VIEWS.map((v) => [v.id, 'none']));
  if (row.role === 'admin' && !asUser) return Object.fromEntries(VIEWS.map((v) => [v.id, 'edit']));
  const set = stored(row), defaults = config.views.userDefaults || {};
  return Object.fromEntries(VIEWS.map((v) => [v.id,
    LEVELS.includes(set[v.id]) ? set[v.id] : LEVELS.includes(defaults[v.id]) ? defaults[v.id] : 'none']));
}

export const can = (profile, view, level) => RANK[accessFor(profile)[view] || 'none'] >= RANK[level];

export function requireView(profile, view, level) {
  if (can(profile, view, level)) return;
  const noun = byId.get(view)?.noun || view;
  throw new UserError(level === 'edit' && can(profile, view, 'read')
    ? `This profile can view the ${noun} but not change it. An admin can give it edit access in Settings, under Profiles.`
    : `This profile doesn't have access to the ${noun}. An admin can turn it on in Settings, under Profiles.`, 403);
}

// Merges an admin's { viewId: level } patch into a profile's stored access. Returns the
// JSON to store, or throws on an unknown view or level.
export function mergeAccess(row, patch) {
  if (!patch || typeof patch !== 'object' || Array.isArray(patch)) throw new UserError('Send access as { view: level }.');
  const next = stored(row);
  for (const [view, level] of Object.entries(patch)) {
    if (!byId.has(view)) throw new UserError(`There's no "${view}" view.`);
    if (!LEVELS.includes(level)) throw new UserError('Choose no access, view, or view and edit.');
    next[view] = level;
  }
  return JSON.stringify(next);
}
