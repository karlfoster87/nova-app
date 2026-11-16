// Heartbeat schedules: work Nova does without being asked, on a timetable. Each profile has its
// own, made in the Heartbeat pane or by Nova in a chat (its add_heartbeat tool, chat/tools.js),
// and every one can be paused, changed or deleted from the pane without asking Nova. A schedule
// either repeats every so many minutes or runs at a time of day, on chosen weekdays, in the
// server's time zone. It runs behind the scenes (a fresh hidden chat each time) or in a chat the
// profile names. Running them is runs.js; this file only stores them and works out when they are due.
// Seeing them needs read access to the Core tab ('brain'), making or changing them edit access.
import crypto from 'node:crypto';
import { config } from '../core/config.js';
import { q } from '../core/db.js';
import { hub } from '../core/hub.js';
import { UserError } from '../core/errors.js';
import { requireView } from '../accounts/access.js';
import { ownedChat } from '../chat/chats.js';
import { EFFORTS } from '../chat/runner.js';
import { isRunning } from './runs.js';

const MAX_PER_PROFILE = 50;
const WEEK = 7 * 24 * 60;
export const DAYS = ['sun', 'mon', 'tue', 'wed', 'thu', 'fri', 'sat'];
const DAY_LABELS = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];

// ---- When ------------------------------------------------------------------------

const daysOf = (row) => (row.days ? row.days.split(',').map(Number) : []);

// The next time a schedule is due after from (epoch ms). An interval counts from from; a time of
// day is the next such time, in the server's local time, on one of its weekdays.
export function nextRun(row, from = Date.now()) {
  if (row.every_min) return from + row.every_min * 60 * 1000;
  const [hh, mm] = String(row.at_time || '00:00').split(':').map(Number);
  const days = daysOf(row);
  const d = new Date(from);
  for (let i = 0; i <= 7; i++) {
    const at = new Date(d.getFullYear(), d.getMonth(), d.getDate() + i, hh, mm, 0, 0);
    if (at.getTime() > from && (!days.length || days.includes(at.getDay()))) return at.getTime();
  }
  return from + 24 * 60 * 60 * 1000; // unreachable with valid days; never leave it without a time
}

// "Every hour", "Every 30 minutes", "Weekdays at 08:00", "Mon, Thu at 18:30".
export function cadenceText(row) {
  if (row.every_min) {
    const m = row.every_min;
    if (m % 1440 === 0) return m === 1440 ? 'Every day' : `Every ${m / 1440} days`;
    if (m % 60 === 0) return m === 60 ? 'Every hour' : `Every ${m / 60} hours`;
    return `Every ${m} minutes`;
  }
  const days = daysOf(row).sort();
  const when = !days.length || days.length === 7 ? 'Every day'
    : days.join() === '1,2,3,4,5' ? 'Weekdays' : days.join() === '0,6' ? 'Weekends' : days.map((d) => DAY_LABELS[d]).join(', ');
  return `${when} at ${row.at_time}`;
}

// ---- Checking what's sent -----------------------------------------------------------

const clip = (s, max) => String(s ?? '').replace(/\r\n?/g, '\n').trim().slice(0, max);

// A cadence from the pane or Nova's tool: { everyMinutes } or { at: 'HH:MM', days: ['mon', …] }.
// Days may also be numbers, 0 for Sunday; none means every day.
function checkCadence({ everyMinutes, at, days }) {
  const hasEvery = everyMinutes != null && everyMinutes !== '';
  const hasAt = at != null && at !== '';
  if (hasEvery === hasAt) throw new UserError('Choose either how often it repeats, or a time of day.');
  if (hasEvery) {
    const m = Number(everyMinutes), min = Math.max(1, Number(config.heartbeat.minMinutes) || 5);
    if (!Number.isInteger(m) || m < min || m > WEEK) throw new UserError(`It can repeat every ${min} minutes at most, and at least once a week.`);
    return { every_min: m, at_time: null, days: null };
  }
  if (!/^([01]\d|2[0-3]):[0-5]\d$/.test(String(at))) throw new UserError('Give the time of day as HH:MM, like 08:30.');
  const list = Array.isArray(days) ? days : days == null || days === '' ? [] : null;
  if (!list) throw new UserError('Give the days as a list, like ["mon", "wed"].');
  const nums = [...new Set(list.map((d) => (typeof d === 'number' ? d : DAYS.indexOf(String(d).toLowerCase().slice(0, 3)))))];
  if (nums.some((n) => !Number.isInteger(n) || n < 0 || n > 6)) throw new UserError('Days are mon, tue, wed, thu, fri, sat and sun.');
  return { every_min: null, at_time: String(at), days: nums.length && nums.length < 7 ? nums.sort().join(',') : null };
}

// The chat a schedule sends to: one of this profile's own chats (not another run).
function checkTarget(profile, id) {
  if (!id) return null;
  const chat = ownedChat(profile, String(id));
  if (!chat || chat.origin) throw new UserError('That chat isn\'t one of yours any more. Choose another, or run it behind the scenes.', 404);
  if (chat.title === null) throw new UserError('Send something in that chat first, then a schedule can use it.');
  return chat.id;
}

function checkModel(model) {
  if (model == null || model === '') return null;
  if (typeof model !== 'string' || model.length > 100 || !/^[\w.:[\]-]+$/.test(model)) throw new UserError('That isn\'t a model Nova knows.');
  return model;
}
function checkEffort(effort) {
  if (effort == null || effort === '') return null;
  if (!EFFORTS.includes(effort)) throw new UserError('Choose an effort of low, medium, high, xhigh or max.');
  return effort;
}

// ---- Reading -----------------------------------------------------------------------

function ownSchedule(profile, id) {
  const row = q.heartbeat.get(String(id || ''));
  if (!row || row.profile !== profile) throw new UserError('That schedule doesn\'t exist any more.', 404);
  return row;
}

const chatRef = (profile, id) => {
  const c = id ? ownedChat(profile, id) : null;
  return c ? { id: c.id, title: c.title || 'New chat' } : null;
};

export function shapeSchedule(row) {
  return {
    id: row.id, name: row.name, prompt: row.prompt, cadence: cadenceText(row),
    everyMinutes: row.every_min, at: row.at_time, days: daysOf(row).map((d) => DAYS[d]),
    targetChat: chatRef(row.profile, row.target_chat), model: row.model, effort: row.effort,
    enabled: !!row.enabled, nextRun: row.enabled ? row.next_run : null, running: isRunning(row.id),
    lastRun: row.last_run, lastStatus: row.last_status, lastChat: row.last_chat, runs: row.runs,
    createdBy: row.created_by, createdChat: chatRef(row.profile, row.created_chat), createdAt: row.created_at, updatedAt: row.updated_at
  };
}

export function listSchedules(profile) {
  requireView(profile, 'brain', 'read');
  return q.heartbeats.all(profile).map(shapeSchedule);
}

export function getSchedule(profile, id) {
  requireView(profile, 'brain', 'read');
  return ownSchedule(profile, id);
}

// ---- Changing ----------------------------------------------------------------------

export const heartbeatChanged = (profile) => hub.toProfile(profile, { t: 'heartbeat_changed' });

// by: 'you' from the pane, 'nova' from a chat (chatId: the chat that made it).
export function createSchedule(profile, body = {}, { by = 'you', chatId = null } = {}) {
  requireView(profile, 'brain', 'edit');
  const name = clip(body.name, 80).replace(/\s+/g, ' ');
  const prompt = clip(body.prompt, 4000);
  if (!name) throw new UserError('Give the schedule a name.');
  if (!prompt) throw new UserError('Say what Nova should do each time it runs.');
  const cadence = checkCadence(body);
  const target = checkTarget(profile, body.targetChatId);
  const model = checkModel(body.model), effort = checkEffort(body.effort);
  if (q.heartbeats.all(profile).length >= MAX_PER_PROFILE) throw new UserError(`A profile can have up to ${MAX_PER_PROFILE} schedules. Delete one first.`);
  const id = crypto.randomUUID(), now = Date.now();
  const enabled = body.enabled === false ? 0 : 1;
  const row = { ...cadence };
  q.addHeartbeat.run(id, profile, name, prompt, cadence.every_min, cadence.at_time, cadence.days, target, model, effort,
    enabled, enabled ? nextRun(row, now) : null, by === 'nova' ? 'nova' : 'you', chatId, now, now);
  console.log(`${profile} ${by === 'nova' ? 'had Nova schedule' : 'scheduled'} "${name}" (${cadenceText(row)}).`);
  heartbeatChanged(profile);
  return shapeSchedule(q.heartbeat.get(id));
}

// patch: any of name, prompt, the cadence (everyMinutes, or at with days), targetChatId (null to
// run behind the scenes), model, effort, enabled. A new cadence, or turning it back on, counts
// the next run from now.
export function updateSchedule(profile, id, patch = {}) {
  requireView(profile, 'brain', 'edit');
  const row = ownSchedule(profile, id);
  const name = 'name' in patch ? clip(patch.name, 80).replace(/\s+/g, ' ') : row.name;
  const prompt = 'prompt' in patch ? clip(patch.prompt, 4000) : row.prompt;
  if (!name) throw new UserError('Give the schedule a name.');
  if (!prompt) throw new UserError('Say what Nova should do each time it runs.');
  const newCadence = 'everyMinutes' in patch || 'at' in patch || 'days' in patch;
  const cadence = newCadence ? checkCadence({
    everyMinutes: 'everyMinutes' in patch ? patch.everyMinutes : 'at' in patch ? null : row.every_min,
    at: 'at' in patch ? patch.at : 'everyMinutes' in patch ? null : row.at_time,
    days: 'days' in patch ? patch.days : daysOf(row)
  }) : { every_min: row.every_min, at_time: row.at_time, days: row.days };
  const target = 'targetChatId' in patch ? checkTarget(profile, patch.targetChatId) : row.target_chat;
  const model = 'model' in patch ? checkModel(patch.model) : row.model;
  const effort = 'effort' in patch ? checkEffort(patch.effort) : row.effort;
  const enabled = 'enabled' in patch ? (patch.enabled ? 1 : 0) : row.enabled;
  const next = !enabled ? null : newCadence || !row.enabled || row.next_run == null ? nextRun(cadence) : row.next_run;
  q.updateHeartbeat.run(name, prompt, cadence.every_min, cadence.at_time, cadence.days, target, model, effort, enabled, next, Date.now(), row.id, profile);
  if (enabled !== row.enabled) console.log(`${profile} ${enabled ? 'resumed' : 'paused'} the schedule "${name}".`);
  heartbeatChanged(profile);
  return shapeSchedule(q.heartbeat.get(row.id));
}

// Past runs' Thought entries stay: they are the record of what was done.
export function deleteSchedule(profile, id) {
  requireView(profile, 'brain', 'edit');
  const row = ownSchedule(profile, id);
  q.deleteHeartbeat.run(row.id, profile);
  console.log(`${profile} deleted the schedule "${row.name}".`);
  heartbeatChanged(profile);
  return { deleted: row.id };
}

// On start, every schedule counts its next run from now: runs missed while Nova was stopped are
// skipped rather than caught up, so a restart can't flood the queue.
export function resetSchedules(now = Date.now()) {
  for (const row of q.allHeartbeats.all()) q.setHeartbeatNext.run(nextRun(row, now), row.id);
}
