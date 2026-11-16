// The Train of Thought: one shared timeline of what Nova has done, when and why, and the questions
// it wants to put to the user later. It is not a chat. Entries are written by Nova itself, through
// its record_thought tool (chat/tools.js), and by the Heartbeat runner (heartbeat/runs.js) for its
// unattended runs. They are never written from the browser, which can only mark a question
// answered or dismissed, or an action that was held back as reviewed.
//
// The timeline is shared by every profile with brain (Core) access, a deliberate exception to
// "nothing crosses profiles" (see the wiki's security-invariants page). So the summary and the
// question are what everyone sees, and Nova is told to keep them generic; the detail (a held-back
// command, a run's final reply) and the link to the source chat are shown only to the profile the
// entry came from, and the chat itself still opens only for its owner.
import crypto from 'node:crypto';
import { config } from '../core/config.js';
import { q } from '../core/db.js';
import { hub } from '../core/hub.js';
import { UserError } from '../core/errors.js';
import { requireView, can } from '../accounts/access.js';
import { isAdmin } from '../accounts/profiles.js';

const SOURCES = new Set(['heartbeat', 'chat', 'task', 'commit']);
const MAX_SUMMARY = 240, MAX_QUESTION = 600, MAX_DETAIL = 4000;
const oneLine = (s, max) => String(s ?? '').replace(/\s+/g, ' ').trim().slice(0, max);
const text = (s, max) => String(s ?? '').replace(/\r\n?/g, '\n').trim().slice(0, max);

// Entries are paged by time, so no two may share a millisecond.
let lastAt = 0;
const stamp = () => (lastAt = Math.max(Date.now(), lastAt + 1));

// An entry as a profile sees it. Only the entry's own profile gets the detail, the source chat and
// the schedule's name.
function shape(viewer, r) {
  const mine = r.profile === viewer;
  const schedule = mine && r.source === 'heartbeat' && r.source_id ? q.heartbeat.get(r.source_id) : null;
  return {
    id: r.id, at: r.at, profile: r.profile, mine, kind: r.kind, source: r.source,
    summary: r.summary, question: r.question, status: r.status, resolvedAt: r.resolved_at, resolvedBy: r.resolved_by,
    ...(mine ? { detail: r.detail, chatId: r.chat_id, scheduleId: r.source === 'heartbeat' ? r.source_id : null,
      scheduleName: schedule?.profile === viewer ? schedule.name : null } : {})
  };
}

const changed = () => hub.toAll({ t: 'thought_changed' }); // a reload signal only; the list route checks access

// Writes an entry. kind: 'thought' (something done or noticed, perhaps with a question) or 'held'
// (actions an unattended run wasn't allowed to take). An entry with a question, or a held one,
// starts out open until someone deals with it.
export function recordThought(profile, { kind = 'thought', source, sourceId = null, chatId = null, summary, question = null, detail = null }) {
  const line = oneLine(summary, MAX_SUMMARY);
  if (!line) throw new UserError('Give the thought a one-line summary.');
  if (!SOURCES.has(source)) throw new UserError('That isn\'t a source the Train of Thought knows.');
  if (kind !== 'thought' && kind !== 'held') throw new UserError('That isn\'t a kind of thought.');
  const ask = question ? text(question, MAX_QUESTION) || null : null;
  const id = crypto.randomUUID();
  q.addThought.run(id, stamp(), profile, kind, source, sourceId, chatId, line, ask, detail ? text(detail, MAX_DETAIL) : null,
    kind === 'held' || ask ? 'open' : null);
  changed();
  return shape(profile, q.thought.get(id));
}

// A page of the timeline, newest first. filter: 'all', 'open' (questions and held actions still to
// deal with), 'questions' or 'held'. before: an entry's time, for the next page.
export function listThoughts(profile, { before, filter = 'all', scheduleId = null, limit = 50 } = {}) {
  requireView(profile, 'brain', 'read');
  const until = Number(before) > 0 ? Number(before) : Date.now() + 1000;
  const n = Math.min(Math.max(Number(limit) || 50, 1), 100);
  const rows = q.thoughts.all(until, filter === 'open' ? 'open' : null, filter === 'held' ? 'held' : filter === 'questions' ? 'thought' : null,
    scheduleId ? String(scheduleId) : null, null, filter === 'questions' ? 1 : 0, n + 1);
  return { thoughts: rows.slice(0, n).map((r) => shape(profile, r)), more: rows.length > n };
}

// What Nova reads through its thought tool: short entries, optionally since a time, from one
// schedule, or only the ones still open.
export function thoughtsForNova(profile, { since = null, scheduleId = null, openOnly = false, limit = 20 } = {}) {
  requireView(profile, 'brain', 'read');
  const from = since ? Date.parse(since) : NaN;
  const n = Math.min(Math.max(Number(limit) || 20, 1), 50);
  return q.thoughts.all(Date.now() + 1000, openOnly ? 'open' : null, null, scheduleId || null, Number.isNaN(from) ? null : from, 0, n)
    .map((r) => {
      const t = shape(profile, r);
      return {
        id: t.id, when: new Date(t.at).toISOString(), profile: t.profile, kind: t.kind, source: t.source,
        ...(t.scheduleName ? { schedule: t.scheduleName, scheduleId: t.scheduleId } : {}),
        summary: t.summary, ...(t.question ? { question: t.question } : {}), ...(t.status ? { status: t.status } : {}),
        ...(t.mine && t.detail ? { detail: t.detail } : {})
      };
    });
}

// Marks a question answered, dismissed or open again, or a held entry reviewed or open again.
// Questions are put to everyone, so anyone who can read the timeline may answer one; what a
// profile's own run held back is that profile's (or an admin's) to review.
const STATUSES = { thought: ['open', 'answered', 'dismissed'], held: ['open', 'reviewed'] };
export function resolveThought(profile, id, status) {
  requireView(profile, 'brain', 'read');
  const row = q.thought.get(String(id || ''));
  if (!row || (!row.question && row.kind !== 'held')) throw new UserError('That entry isn\'t in the Train of Thought, or has nothing to answer.', 404);
  if (row.kind === 'held' && row.profile !== profile && !isAdmin(profile)) {
    throw new UserError('Only the profile whose run held this back, or an admin, can review it.', 403);
  }
  if (!STATUSES[row.kind].includes(status)) throw new UserError(row.kind === 'held' ? 'Mark it reviewed, or open again.' : 'Mark it answered, dismissed, or open again.');
  q.resolveThought.run(status, status === 'open' ? null : Date.now(), status === 'open' ? null : profile, row.id);
  changed();
  return shape(profile, q.thought.get(row.id));
}

// For the Core tab's count: questions still open, and this profile's own held actions.
export const openThoughtCount = (profile) => (can(profile, 'brain', 'read') ? q.openThoughts.get(profile).n : 0);

// Old entries go, so the timeline stays short enough to be useful. Questions still open stay.
export function pruneThoughts() {
  const days = Number(config.thought.keepDays);
  if (!(days > 0)) return;
  const gone = q.pruneThoughts.run(Date.now() - days * 24 * 60 * 60 * 1000).changes;
  if (gone) { console.log(`Removed ${gone} Train of Thought entr${gone === 1 ? 'y' : 'ies'} older than ${days} days.`); changed(); }
}
