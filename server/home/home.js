// The Home dashboard's summary: one call that gathers every card a profile may see, so the page
// opens in one round trip and refreshes the same way. Each card is built with the functions the
// views' own routes use, so access (requireView) and (id, profile) lookups apply as everywhere
// else, and a card the profile can't use is simply left out. The browser decides only layout.
//
// Cards: waiting (chats with an approval or question open, from this profile's own live runners,
// and what waits in the Train of Thought), today (tasks and active sticky notes),
// activity (recent thoughts, the next Heartbeat runs), status (what's running) and, since v0.14, calendar
// (today's and the coming week's events from the profile's linked feeds) and, since v0.15, email (the inbox
// and flagged items, for admins once Settings → Email turns it on; email/email.js).
import { can } from '../accounts/access.js';
import { q } from '../core/db.js';
import { runnersOf } from '../chat/runner.js';
import { ownedChat } from '../chat/chats.js';
import { listTasks } from '../views/tasks.js';
import { listNotes } from '../views/notes.js';
import { listThoughts } from '../thought/thoughts.js';
import { listSchedules } from '../heartbeat/schedules.js';
import { calendarSummary } from '../calendar/calendars.js';
import { emailSummary } from '../email/email.js';

// Cards that depend on a feature. Email also needs to be turned on, and is for admins only, so
// homeSummary says per profile whether it shows.
export const CARDS = { email: true, calendar: true };

const title = (profile, id) => ownedChat(profile, id)?.title || 'New chat';

// Chats of this profile that wait on the user right now, and those Nova is working in. Heartbeat
// runs behind the scenes never ask, and show under activity instead.
function chatsNow(profile) {
  const waiting = [], running = [];
  for (const r of runnersOf(profile)) {
    if (r.background) continue;
    const asks = [...r.pendingInfo.values()];
    if (asks.length) waiting.push({ chatId: r.id, title: title(profile, r.id), kind: asks.some((p) => p.toolName === 'AskUserQuestion') ? 'question' : 'approval' });
    else if (r.state === 'running') running.push({ chatId: r.id, title: title(profile, r.id) });
  }
  return { waiting, running };
}

// What's left today: unfinished bottom-level tasks under today's tasks (what the Tasks badge
// counts), each with the task it sits under, and how many were finished.
function today(profile, day) {
  const all = listTasks(profile, day).tasks;
  const byId = new Map(all.map((t) => [t.id, t]));
  // The board's order (views/tasks.js in the browser): by position, then age, each task followed
  // by its subtasks, so Home lists today's tasks as they appear on the board.
  const kids = new Map();
  for (const t of [...all].sort((a, b) => a.position - b.position || a.createdAt - b.createdAt)) {
    const key = t.parentId && byId.has(t.parentId) ? t.parentId : t.parentId ? null : `day:${t.day ?? ''}`;
    if (key) { if (!kids.has(key)) kids.set(key, []); kids.get(key).push(t); }
  }
  const leaves = [];
  const walk = (t) => { const sub = kids.get(t.id); if (sub) sub.forEach(walk); else leaves.push(t); };
  (kids.get(`day:${day}`) || []).forEach(walk);
  const left = leaves.filter((t) => t.state !== 'complete');
  return {
    left: left.length, done: leaves.length - left.length,
    items: left.slice(0, 12).map((t) => ({ id: t.id, title: t.title, state: t.state, under: t.parentId ? byId.get(t.parentId)?.title || null : null })),
    canEdit: can(profile, 'tasks', 'edit')
  };
}

const activeNotes = (profile) => listNotes(profile).filter((n) => n.active).slice(0, 8)
  .map(({ id, text, color, shared, owner, mine }) => ({ id, text: text.slice(0, 280), color, shared, owner, mine }));

function thoughtCards(profile) {
  const open = listThoughts(profile, { filter: 'open', limit: 50 }).thoughts;
  return {
    questions: open.filter((t) => t.kind === 'thought' && t.question).slice(0, 5),
    held: open.filter((t) => t.kind === 'held' && t.mine).slice(0, 5),
    recent: listThoughts(profile, { limit: 5 }).thoughts
  };
}

// day and tz: the browser's date and time zone, so "today" is the user's.
export function homeSummary(profile, day, tz) {
  const out = { cards: { ...CARDS }, ...chatsNow(profile) };
  const email = CARDS.email ? emailSummary(profile) : null; // null unless turned on and an admin
  if (email) out.email = email;
  out.cards.email = !!email;
  if (CARDS.calendar) out.calendar = calendarSummary(profile, day, tz); // every profile's own calendars, no view access needed
  if (can(profile, 'tasks', 'read') && /^\d{4}-\d{2}-\d{2}$/.test(String(day || ''))) out.today = today(profile, day); // the browser's date
  if (can(profile, 'notes', 'read')) out.notes = activeNotes(profile);
  if (can(profile, 'brain', 'read')) {
    const schedules = listSchedules(profile);
    out.thought = thoughtCards(profile);
    out.schedules = {
      next: schedules.filter((s) => s.enabled && s.nextRun).sort((a, b) => a.nextRun - b.nextRun).slice(0, 4)
        .map(({ id, name, cadence, nextRun, lastStatus, running }) => ({ id, name, cadence, nextRun, lastStatus, running })),
      running: schedules.filter((s) => s.running).map(({ id, name }) => ({ id, name })),
      canEdit: can(profile, 'brain', 'edit')
    };
  }
  return out;
}
