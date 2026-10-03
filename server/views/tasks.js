// Tasks view: per-profile tasks on days, with a state and nesting. Only
// top-level tasks carry a day (or none, for Unscheduled); a child task goes wherever its
// parent goes. Overdue is worked out in the browser from its own date, so the server never
// has to guess the user's time zone.
import crypto from 'node:crypto';
import { q, transaction, reorder } from '../core/db.js';
import { UserError } from '../core/errors.js';
import { requireView } from '../accounts/access.js';

const STATES = ['waiting', 'in_progress', 'complete'];
const DAY_RE = /^\d{4}-\d{2}-\d{2}$/;

function ownedTask(profile, id) {
  const row = id ? q.task.get(String(id)) : null;
  if (!row || row.profile !== profile) throw new UserError('That task doesn\'t exist any more.', 404);
  return row;
}

// 'YYYY-MM-DD' that is a real date, or null for Unscheduled.
function checkDay(day) {
  if (day == null || day === '') return null;
  const s = String(day);
  const d = new Date(`${s}T00:00:00Z`);
  if (!DAY_RE.test(s) || Number.isNaN(d.getTime()) || d.toISOString().slice(0, 10) !== s) throw new UserError('Pick a valid date.');
  return s;
}

function checkTitle(title) {
  const t = String(title ?? '').replace(/\s+/g, ' ').trim();
  if (!t) throw new UserError('Give the task a name.');
  if (t.length > 200) throw new UserError('Keep task names to 200 characters or fewer.');
  return t;
}

function checkNote(note) {
  const n = String(note ?? '').replace(/\r\n?/g, '\n').trim();
  if (n.length > 4000) throw new UserError('Keep task notes to 4,000 characters or fewer.');
  return n;
}

const shape = (r) => ({ id: r.id, parentId: r.parent_id, day: r.day, title: r.title, note: r.note, state: r.state,
  position: r.position, createdAt: r.created_at, updatedAt: r.updated_at, completedAt: r.completed_at });

// Everything the board needs, given the browser's today: tasks from today on, Unscheduled,
// and unfinished tasks from earlier days, all with their children.
export function listTasks(profile, today) {
  requireView(profile, 'tasks', 'read');
  today = checkDay(today);
  if (!today) throw new UserError('Send today\'s date to list tasks.');
  return { tasks: q.tasksFrom.all(profile, today).map(shape) };
}

// Tasks on the board (the listTasks rule) whose title or note holds every word, for the search
// palette. Each says the day its top-level task is on, so the board can open there.
export function searchTasks(profile, words, today) {
  const all = listTasks(profile, today).tasks;
  const byId = new Map(all.map((t) => [t.id, t]));
  const out = [];
  for (const t of all) {
    const hay = `${t.title}\n${t.note}`.toLowerCase();
    if (!words.every((w) => hay.includes(w))) continue;
    let top = t;
    while (top.parentId && byId.has(top.parentId)) top = byId.get(top.parentId);
    out.push({ id: t.id, title: t.title, note: t.note, state: t.state, day: top.day, parent: t.parentId ? byId.get(t.parentId)?.title || null : null });
    if (out.length >= 10) break;
  }
  return out;
}

// Today's remaining work for the Tasks badge: unfinished bottom-level tasks under today's tasks.
export function tasksLeftToday(profile, today) {
  today = checkDay(today);
  return today ? Number(q.tasksLeft.get(profile, today).n) : 0;
}

export function createTask(profile, { title, day, parentId, note }) {
  requireView(profile, 'tasks', 'edit');
  title = checkTitle(title);
  const parent = parentId ? ownedTask(profile, parentId) : null;
  day = parent ? null : checkDay(day);
  const id = crypto.randomUUID(), now = Date.now();
  const position = q.nextTaskPosition.get(profile, parent?.id ?? null, day).n;
  q.addTask.run(id, profile, parent?.id ?? null, day, title, checkNote(note), 'waiting', position, now, now);
  return shape(q.task.get(id));
}

export function updateTask(profile, id, body) {
  requireView(profile, 'tasks', 'edit');
  const row = ownedTask(profile, id);
  const title = 'title' in body ? checkTitle(body.title) : row.title;
  const note = 'note' in body ? checkNote(body.note) : row.note;
  let state = row.state;
  if ('state' in body) {
    if (!STATES.includes(body.state)) throw new UserError('A task is waiting, in progress or complete.');
    state = body.state;
  }
  const now = Date.now();
  const completedAt = state === 'complete' ? (row.state === 'complete' ? row.completed_at : now) : null;
  transaction(() => {
    q.updateTask.run(title, note, state, completedAt, now, row.id, profile);
    if (state !== row.state) rollUp(profile, row.parent_id, now);
  });
  return shape(q.task.get(row.id));
}

// A subtask's new state carries up the parent chain: a parent is complete when all its
// subtasks are, waiting when all are, and in progress for any mix. It stops at the first
// parent that doesn't change, since nothing above it can change either. Setting a parent's
// own state directly still works; nothing is pushed down to its subtasks.
function rollUp(profile, parentId, now) {
  for (let id = parentId; id;) {
    const p = q.task.get(id);
    const states = q.taskChildStates.all(p.id, profile).map((c) => c.state);
    const next = states.every((s) => s === 'complete') ? 'complete' : states.every((s) => s === 'waiting') ? 'waiting' : 'in_progress';
    if (next === p.state) return;
    q.updateTask.run(p.title, p.note, next, next === 'complete' ? now : null, now, p.id, profile);
    id = p.parent_id;
  }
}

// Moves a task, with its children, under another task (parentId) or to the top level of
// a day (day, or null for Unscheduled), before beforeId or at the end. Siblings are
// renumbered so positions stay small and gap-free.
export function moveTask(profile, id, { parentId = null, day = null, beforeId = null }) {
  requireView(profile, 'tasks', 'edit');
  const row = ownedTask(profile, id);
  const parent = parentId ? ownedTask(profile, parentId) : null;
  if (parent) {
    // Walk up from the new parent: meeting the task itself would make a loop.
    for (let p = parent; p; p = p.parent_id ? q.task.get(p.parent_id) : null) {
      if (p.id === row.id) throw new UserError('A task can\'t go inside itself or one of its own subtasks.');
    }
  }
  const newParent = parent?.id ?? null;
  const newDay = parent ? null : checkDay(day);
  const now = Date.now();
  transaction(() => reorder(q.taskSiblings.all(profile, newParent, newDay).map((s) => s.id), row.id, beforeId, (i, s) => {
    if (s === row.id) q.placeTask.run(newParent, newDay, i, now, row.id, profile);
    else q.setTaskPosition.run(i, s, profile);
  }));
  return shape(q.task.get(row.id));
}

// Deletes a task and everything under it. Returns how many went.
export function deleteTask(profile, id) {
  requireView(profile, 'tasks', 'edit');
  const row = ownedTask(profile, id);
  return { deleted: Number(q.deleteTaskTree.run(row.id, profile).changes) };
}
