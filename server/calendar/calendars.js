// Linked calendars: each profile's own ICS subscription feeds (Google, Outlook, iCloud and others
// all publish one), fetched by the server on a timer and kept as a cache, so a page never waits on
// a calendar provider and a slow or failing feed only marks that calendar as out of date. The last
// good copy of each feed is kept in data/calendars/<id>.ics, so it survives a restart.
//
// Calendars aren't a view with an access level: like push subscriptions they belong to the profile
// that linked them, and every lookup is by (id, profile). A feed's address is a credential (a
// private ICS link gives read access to the whole calendar), so it never leaves the server: the
// browser sees the host and a hint, and nothing here logs it.
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { q } from '../core/db.js';
import { hub } from '../core/hub.js';
import { config, DATA_DIR } from '../core/config.js';
import { UserError } from '../core/errors.js';
import { replaceFile } from '../core/files.js';
import { fetchFeed, normaliseUrl, addressHint } from './fetch.js';
import { parseCalendar, occurrences, validZone, wallToUtc, MAX_OCCURRENCES } from './ics.js';

export const COLORS = ['cyan', 'pink', 'violet', 'amber', 'green', 'red'];
const DAY = 86400000;
const CACHE_DIR = path.join(DATA_DIR, 'calendars');
fs.mkdirSync(CACHE_DIR, { recursive: true });
const cacheFile = (id) => path.join(CACHE_DIR, `${id}.ics`);

const parsed = new Map();   // calendar id -> its parsed feed
const inflight = new Map(); // calendar id -> the refresh under way

// The zone for Nova's calendar tool and for feeds' floating times: config, else this machine's.
export const homeZone = () => (validZone(config.calendar.timeZone) ? config.calendar.timeZone
  : Intl.DateTimeFormat().resolvedOptions().timeZone || 'UTC');
const isAdminName = (profile) => q.profile.get(profile)?.role === 'admin'; // (not accounts/profiles.js: it would make an import cycle with the chat tools)

const changed = (profile) => hub.toProfile(profile, { t: 'calendars_changed' });

function shape(row) {
  const { host, hint } = addressHint(row.url);
  return { id: row.id, name: row.name, color: row.color, shown: !!row.shown, host, hint,
    fetchedAt: row.fetched_at, okAt: row.ok_at, error: row.error, events: row.events };
}

export const listCalendars = (profile) => q.calendars.all(profile).map(shape);

function owned(profile, id) {
  const row = q.calendar.get(String(id || ''), profile);
  if (!row) throw new UserError('That calendar isn\'t linked any more.', 404);
  return row;
}

function cleanName(value) {
  const name = String(value ?? '').replace(/\s+/g, ' ').trim();
  if (name.length > 80) throw new UserError('Keep the calendar\'s name to 80 characters.');
  return name;
}
function cleanColor(value, fallback) {
  if (value === undefined || value === null || value === '') return fallback;
  if (!COLORS.includes(value)) throw new UserError('Choose one of the calendar colours.');
  return value;
}

// Fetches and reads a feed. Throws a UserError that is safe to show when it isn't a calendar.
async function download(url, { admin, etag = null, modified = null } = {}) {
  const r = await fetchFeed(url, { admin, etag, modified });
  if (r.status === 304) return r;
  try { return { ...r, feed: parseCalendar(r.text, homeZone()) }; } catch {
    throw new UserError('That address didn\'t return a calendar. Use the calendar\'s ICS or iCal address (it often ends in .ics), not the page you view it on.');
  }
}

// The parsed feed of a calendar: from memory, else from its cached copy on disk, else null.
function feedOf(row) {
  if (parsed.has(row.id)) return parsed.get(row.id);
  try {
    const feed = parseCalendar(fs.readFileSync(cacheFile(row.id), 'utf8'), homeZone());
    parsed.set(row.id, feed);
    return feed;
  } catch { return null; }
}

async function keep(row, r, now = Date.now()) {
  await replaceFile(cacheFile(row.id), r.text);
  parsed.set(row.id, r.feed);
  q.setCalendarFetch.run(now, now, null, r.etag, r.modified, r.feed.events.length, row.id, row.profile);
}

// Fetches one calendar again. A 304 keeps the copy there is; a failure keeps it too and records
// the reason. Resolves true when what the calendar shows may have changed.
function refresh(row, { force = false } = {}) {
  if (inflight.has(row.id)) return inflight.get(row.id);
  const job = (async () => {
    const now = Date.now();
    const cached = feedOf(row);
    try {
      const r = await download(row.url, { admin: isAdminName(row.profile), etag: force || !cached ? null : row.etag, modified: force || !cached ? null : row.modified });
      if (!q.calendar.get(row.id, row.profile)) return false; // removed meanwhile
      if (r.status === 304) {
        q.setCalendarFetch.run(now, now, null, row.etag, row.modified, row.events, row.id, row.profile);
        return !!row.error;
      }
      await keep(row, r, now);
      return true;
    } catch (err) {
      if (!q.calendar.get(row.id, row.profile)) return false;
      const message = err instanceof UserError ? err.message : 'Nova couldn\'t update this calendar.';
      if (!(err instanceof UserError)) console.error(`A calendar of ${row.profile} failed to update:`, err.message);
      q.setCalendarFetch.run(now, row.ok_at, message, row.etag, row.modified, row.events, row.id, row.profile);
      return row.error !== message;
    }
  })().finally(() => inflight.delete(row.id));
  inflight.set(row.id, job);
  return job;
}

// ---- Settings → Calendars -----------------------------------------------------------

export async function addCalendar(profile, body = {}) {
  const admin = isAdminName(profile);
  const url = normaliseUrl(body.url, { admin }).href;
  const name = cleanName(body.name), color = cleanColor(body.color, COLORS[q.calendars.all(profile).length % COLORS.length]);
  const rows = q.calendars.all(profile);
  if (rows.length >= (config.calendar.maxPerProfile || 20)) throw new UserError(`A profile can link up to ${config.calendar.maxPerProfile || 20} calendars. Remove one first.`);
  if (rows.some((r) => r.url === url)) throw new UserError('That calendar is already linked.');
  const r = await download(url, { admin });
  const id = crypto.randomUUID(), now = Date.now();
  const { host } = addressHint(url);
  q.addCalendar.run(id, profile, name || r.feed.name || host || 'Calendar', url, color, q.nextCalendarPosition.get(profile).n, now, now);
  await keep(q.calendar.get(id, profile), r, now);
  console.log(`${profile} linked a calendar from ${host}.`);
  changed(profile);
  return shape(q.calendar.get(id, profile));
}

// Name, colour, shown, or a new address (checked by fetching it before anything changes).
export async function updateCalendar(profile, id, body = {}) {
  const row = owned(profile, id);
  const name = body.name !== undefined ? cleanName(body.name) || row.name : row.name;
  const color = cleanColor(body.color, row.color);
  const shown = body.shown !== undefined ? (body.shown ? 1 : 0) : row.shown;
  let url = row.url, fresh = null;
  if (body.url !== undefined && String(body.url).trim()) {
    const admin = isAdminName(profile);
    url = normaliseUrl(body.url, { admin }).href;
    if (url !== row.url) {
      if (q.calendars.all(profile).some((r) => r.url === url && r.id !== row.id)) throw new UserError('That calendar is already linked.');
      fresh = await download(url, { admin });
    }
  }
  q.updateCalendar.run(name, color, shown, url, Date.now(), row.id, profile);
  if (fresh) await keep(q.calendar.get(row.id, profile), fresh);
  changed(profile);
  return shape(q.calendar.get(row.id, profile));
}

export function deleteCalendar(profile, id) {
  const row = owned(profile, id);
  q.deleteCalendar.run(row.id, profile);
  parsed.delete(row.id);
  fs.rm(cacheFile(row.id), { force: true }, () => {});
  console.log(`${profile} removed a calendar.`);
  changed(profile);
  return { deleted: true };
}

// Fetch now: one calendar, or all of this profile's. Resolves with the list as it is afterwards.
export async function refreshCalendars(profile, id = null) {
  const rows = id ? [owned(profile, id)] : q.calendars.all(profile);
  await Promise.all(rows.map((row) => refresh(row, { force: true })));
  changed(profile);
  return listCalendars(profile);
}

// ---- Events -------------------------------------------------------------------------

const DAY_RE = /^\d{4}-\d{2}-\d{2}$/;
const dayWall = (d) => Date.UTC(+d.slice(0, 4), +d.slice(5, 7) - 1, +d.slice(8, 10));
export const addDays = (d, n) => new Date(dayWall(d) + n * DAY).toISOString().slice(0, 10);
const eventId = (calId, uid, key) => crypto.createHash('sha1').update(`${calId}\n${uid}\n${key}`).digest('base64url').slice(0, 18);

/**
 * This profile's events over the days [from, to) in the time zone tz (the browser's), from the
 * calendars it shows (or every one with all). Timed events come as instants, all-day ones as days.
 */
export function eventsFor(profile, { from, to, tz, all = false, maxDays = 100 } = {}) {
  if (!DAY_RE.test(String(from || '')) || !DAY_RE.test(String(to || '')) || to <= from) throw new UserError('Ask for a range of days as YYYY-MM-DD, the end after the start.');
  if ((dayWall(to) - dayWall(from)) / DAY > maxDays) throw new UserError(`Ask for at most ${maxDays} days at a time.`);
  const zone = { kind: 'iana', id: validZone(tz) ? tz : homeZone() };
  const window = { fromDay: from, toDay: to, fromMs: wallToUtc(dayWall(from), zone), toMs: wallToUtc(dayWall(to), zone) };
  const calendars = listCalendars(profile);
  const events = [];
  for (const row of q.calendars.all(profile)) {
    if (!all && !row.shown) continue;
    const feed = feedOf(row);
    if (!feed) continue;
    for (const o of occurrences(feed, window)) {
      events.push({ id: eventId(row.id, o.uid, o.key), series: eventId(row.id, o.uid, ''), calendarId: row.id, title: o.title.slice(0, 300), allDay: o.allDay, start: o.start, end: o.end,
        location: o.location.slice(0, 300), description: o.description, url: /^https?:\/\//i.test(o.url) ? o.url.slice(0, 1000) : '', recurring: o.recurring });
      if (events.length >= MAX_OCCURRENCES) break;
    }
  }
  // All-day events first on their day, then by start time; an all-day day string is midnight in tz.
  const at = (e) => (e.allDay ? wallToUtc(dayWall(e.start), zone) - 1 : e.start);
  events.sort((a, b) => at(a) - at(b) || a.title.localeCompare(b.title));
  return { tz: zone.id, calendars, events };
}

// The Home card: today's events and what comes in the next week, with the calendars' colours.
export function calendarSummary(profile, day, tz) {
  const calendars = listCalendars(profile);
  const out = { linked: calendars.length, calendars: calendars.map(({ id, name, color, shown, error }) => ({ id, name, color, shown, error })), today: [], upcoming: [] };
  if (!calendars.length || !DAY_RE.test(String(day || ''))) return out;
  const { events } = eventsFor(profile, { from: day, to: addDays(day, 8), tz });
  const zone = { kind: 'iana', id: validZone(tz) ? tz : homeZone() };
  const tomorrow = wallToUtc(dayWall(addDays(day, 1)), zone);
  const coming = new Set(); // a repeating event shows once under Coming up, at its next time
  for (const e of events) {
    const isToday = e.allDay ? e.start <= day && e.end > day : e.start < tomorrow;
    // Details stay (trimmed), since an event opened from the card shows them and Discuss with Nova quotes them.
    const item = { ...e, description: e.description.slice(0, 2000) };
    if (isToday) { if (out.today.length < 12) out.today.push(item); continue; }
    if (out.upcoming.length < 8 && !coming.has(e.series) && !out.today.some((t) => t.series === e.series)) {
      coming.add(e.series);
      out.upcoming.push(item);
    }
  }
  return out;
}

// ---- Nova's calendar tool -------------------------------------------------------------

// Events as Nova reads them: times written out in the home zone, so no arithmetic is needed.
export function eventsForNova(profile, { from, days = 7, query = '' } = {}) {
  const tz = homeZone();
  const start = DAY_RE.test(String(from || '')) ? from : new Intl.DateTimeFormat('en-CA', { timeZone: tz }).format(new Date());
  const span = Math.max(1, Math.min(62, Math.round(Number(days) || 7)));
  const rows = q.calendars.all(profile);
  if (!rows.length) return 'No calendars are linked to this profile. They can be added in Settings, under Calendars.';
  const { calendars, events } = eventsFor(profile, { from: start, to: addDays(start, span), tz, all: true });
  const names = new Map(calendars.map((c) => [c.id, c.name]));
  const fmt = new Intl.DateTimeFormat('en-GB', { timeZone: tz, weekday: 'short', day: 'numeric', month: 'short', year: 'numeric', hour: '2-digit', minute: '2-digit' });
  const timeFmt = new Intl.DateTimeFormat('en-GB', { timeZone: tz, hour: '2-digit', minute: '2-digit' });
  const dayOf = new Intl.DateTimeFormat('en-CA', { timeZone: tz });
  const span2 = (s, e) => (dayOf.format(new Date(s)) === dayOf.format(new Date(e)) ? `${fmt.format(new Date(s))} to ${timeFmt.format(new Date(e))}`
    : `${fmt.format(new Date(s))} to ${fmt.format(new Date(e))}`);
  const dayFmt = (d) => new Date(dayWall(d)).toLocaleDateString('en-GB', { timeZone: 'UTC', weekday: 'short', day: 'numeric', month: 'short', year: 'numeric' });
  const words = String(query || '').toLowerCase().split(/\s+/).filter(Boolean);
  const list = events.filter((e) => words.every((w) => `${e.title} ${e.location} ${e.description}`.toLowerCase().includes(w))).slice(0, 300).map((e) => ({
    title: e.title, calendar: names.get(e.calendarId),
    when: e.allDay ? (addDays(e.start, 1) === e.end ? `${dayFmt(e.start)}, all day` : `${dayFmt(e.start)} to ${dayFmt(addDays(e.end, -1))}, all day`)
      : span2(e.start, e.end),
    ...(e.location ? { location: e.location } : {}), ...(e.description ? { details: e.description.slice(0, 600) } : {}),
    ...(e.recurring ? { repeats: true } : {})
  }));
  const stale = calendars.filter((c) => c.error).map((c) => `${c.name}: ${c.error}`);
  return { timeZone: tz, from: start, to: addDays(start, span - 1), events: list, ...(stale.length ? { outOfDate: stale } : {}),
    ...(list.length ? {} : { note: words.length ? 'No events match.' : 'No events in this range.' }) };
}

// ---- Refreshing ---------------------------------------------------------------------

// Every few minutes, each feed that is older than refreshMinutes is fetched again, one at a time.
// Cached copies of calendars that were removed (with their profile, say) are deleted on start.
async function tick() {
  const due = Date.now() - Math.max(5, config.calendar.refreshMinutes || 30) * 60000;
  for (const row of q.allCalendars.all()) {
    if (row.fetched_at && row.fetched_at > due) continue;
    if (await refresh(row)) changed(row.profile);
  }
}
export function startCalendars() {
  const ids = new Set(q.calendarIds.all().map((r) => r.id));
  for (const f of fs.readdirSync(CACHE_DIR)) {
    if (f.endsWith('.ics') && !ids.has(f.slice(0, -4))) fs.rm(path.join(CACHE_DIR, f), { force: true }, () => {});
  }
  const run = () => tick().catch((err) => console.error('Calendar refresh failed:', err.message));
  setTimeout(run, 15000).unref();
  setInterval(run, 5 * 60000).unref();
}
