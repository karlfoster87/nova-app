// A small iCalendar (RFC 5545) reader for calendar subscription feeds: enough to list a calendar's
// events over a short window, written by hand so Nova keeps to its five dependencies. It reads
// VEVENTs (timed and all-day), their time zones (IANA names, Windows names as Outlook writes them,
// or the feed's own VTIMEZONE rules) and recurrence: RRULE, RDATE, EXDATE and edited or cancelled
// occurrences (RECURRENCE-ID). Recurrence is expanded only over the window asked for.
//
// Times are worked out as "wall" milliseconds (Date.UTC of the clock fields in the event's own
// zone), so a weekly 09:00 meeting stays at 09:00 across a clock change, and only then turned into
// real instants. Not supported, because subscription feeds almost never use them: BYHOUR,
// BYMINUTE, BYSECOND, BYWEEKNO, BYYEARDAY, and FREQ below DAILY (such rules give one occurrence a
// period, at the start's time).

const DAY = 86400000;
const WEEKDAYS = { SU: 0, MO: 1, TU: 2, WE: 3, TH: 4, FR: 5, SA: 6 };
const MAX_EVENTS = 20000;        // VEVENTs read from one feed
const MAX_PERIODS = 50000;       // recurrence periods walked for one event
export const MAX_OCCURRENCES = 3000; // occurrences returned for one window

// Outlook and Exchange write Windows zone names. The common ones, by their IANA name.
const WINDOWS_ZONES = {
  'Dateline Standard Time': 'Etc/GMT+12', 'Hawaiian Standard Time': 'Pacific/Honolulu', 'Alaskan Standard Time': 'America/Anchorage',
  'Pacific Standard Time': 'America/Los_Angeles', 'US Mountain Standard Time': 'America/Phoenix', 'Mountain Standard Time': 'America/Denver',
  'Central Standard Time': 'America/Chicago', 'Central America Standard Time': 'America/Guatemala', 'Canada Central Standard Time': 'America/Regina',
  'Mexico Standard Time': 'America/Mexico_City', 'Eastern Standard Time': 'America/New_York', 'US Eastern Standard Time': 'America/Indianapolis',
  'SA Pacific Standard Time': 'America/Bogota', 'Atlantic Standard Time': 'America/Halifax', 'Venezuela Standard Time': 'America/Caracas',
  'Pacific SA Standard Time': 'America/Santiago', 'Newfoundland Standard Time': 'America/St_Johns', 'E. South America Standard Time': 'America/Sao_Paulo',
  'Argentina Standard Time': 'America/Buenos_Aires', 'SA Eastern Standard Time': 'America/Cayenne', 'Azores Standard Time': 'Atlantic/Azores',
  'UTC': 'UTC', 'Coordinated Universal Time': 'UTC', 'GMT Standard Time': 'Europe/London', 'Greenwich Standard Time': 'Atlantic/Reykjavik',
  'W. Europe Standard Time': 'Europe/Berlin', 'Central Europe Standard Time': 'Europe/Budapest', 'Romance Standard Time': 'Europe/Paris',
  'Central European Standard Time': 'Europe/Warsaw', 'W. Central Africa Standard Time': 'Africa/Lagos', 'GTB Standard Time': 'Europe/Bucharest',
  'E. Europe Standard Time': 'Europe/Chisinau', 'FLE Standard Time': 'Europe/Kiev', 'Egypt Standard Time': 'Africa/Cairo',
  'South Africa Standard Time': 'Africa/Johannesburg', 'Israel Standard Time': 'Asia/Jerusalem', 'Turkey Standard Time': 'Europe/Istanbul',
  'Russian Standard Time': 'Europe/Moscow', 'Arabic Standard Time': 'Asia/Baghdad', 'Arab Standard Time': 'Asia/Riyadh',
  'Arabian Standard Time': 'Asia/Dubai', 'Iran Standard Time': 'Asia/Tehran', 'Pakistan Standard Time': 'Asia/Karachi',
  'India Standard Time': 'Asia/Calcutta', 'Nepal Standard Time': 'Asia/Katmandu', 'Bangladesh Standard Time': 'Asia/Dhaka',
  'SE Asia Standard Time': 'Asia/Bangkok', 'China Standard Time': 'Asia/Shanghai', 'Singapore Standard Time': 'Asia/Singapore',
  'Taipei Standard Time': 'Asia/Taipei', 'W. Australia Standard Time': 'Australia/Perth', 'Tokyo Standard Time': 'Asia/Tokyo',
  'Korea Standard Time': 'Asia/Seoul', 'Cen. Australia Standard Time': 'Australia/Adelaide', 'AUS Central Standard Time': 'Australia/Darwin',
  'E. Australia Standard Time': 'Australia/Brisbane', 'AUS Eastern Standard Time': 'Australia/Sydney', 'Tasmania Standard Time': 'Australia/Hobart',
  'New Zealand Standard Time': 'Pacific/Auckland', 'Fiji Standard Time': 'Pacific/Fiji'
};

// ---- Reading the text ---------------------------------------------------------------

const unescapeText = (s) => s.replace(/\\([\\;,nN])/g, (_, c) => (c === 'n' || c === 'N' ? '\n' : c));

// One content line: NAME;PARAM=a;PARAM="b:c":value. Parameter values may be quoted and hold : or ;.
function parseLine(line) {
  let i = 0;
  const name = [];
  while (i < line.length && line[i] !== ';' && line[i] !== ':') name.push(line[i++]);
  const params = {};
  while (line[i] === ';') {
    i++;
    let key = '';
    while (i < line.length && line[i] !== '=' && line[i] !== ':' && line[i] !== ';') key += line[i++];
    let value = '';
    if (line[i] === '=') {
      i++;
      if (line[i] === '"') { i++; while (i < line.length && line[i] !== '"') value += line[i++]; i++; }
      while (i < line.length && line[i] !== ';' && line[i] !== ':') value += line[i++]; // more values after a comma
    }
    params[key.toUpperCase()] = value;
  }
  if (line[i] !== ':') return null;
  return { name: name.join('').toUpperCase(), params, value: line.slice(i + 1) };
}

// The feed as nested components: { type, props: { NAME: [{ params, value }] }, children }.
function components(text) {
  const lines = String(text).replace(/\r\n?/g, '\n').replace(/\n[ \t]/g, '').split('\n');
  const root = { type: 'ROOT', props: {}, children: [] };
  const stack = [root];
  for (const raw of lines) {
    if (!raw) continue;
    const p = parseLine(raw);
    if (!p) continue;
    const top = stack[stack.length - 1];
    if (p.name === 'BEGIN') {
      const c = { type: p.value.trim().toUpperCase(), props: {}, children: [] };
      top.children.push(c);
      stack.push(c);
    } else if (p.name === 'END') {
      if (stack.length > 1) stack.pop();
    } else (top.props[p.name] ||= []).push({ params: p.params, value: p.value });
  }
  return root;
}

const prop = (c, name) => c.props[name]?.[0];
const text = (c, name) => { const p = prop(c, name); return p ? unescapeText(p.value).trim() : ''; };

// ---- Dates, times and zones -----------------------------------------------------------

// A DATE or DATE-TIME value: { wall, allDay, utc } where wall is Date.UTC of its clock fields.
function parseValue(value, params = {}) {
  const m = /^(\d{4})(\d{2})(\d{2})(?:T(\d{2})(\d{2})(\d{2})?(Z)?)?$/.exec(String(value).trim());
  if (!m) return null;
  const [, y, mo, d, hh, mm, ss, z] = m;
  const allDay = params.VALUE === 'DATE' || hh === undefined;
  return { wall: Date.UTC(+y, +mo - 1, +d, allDay ? 0 : +hh, allDay ? 0 : +mm, allDay ? 0 : +(ss || 0)), allDay, utc: !!z };
}

const formatters = new Map();
function zoneFormatter(id) {
  if (!formatters.has(id)) {
    formatters.set(id, new Intl.DateTimeFormat('en-US', { timeZone: id, hourCycle: 'h23', year: 'numeric', month: 'numeric', day: 'numeric',
      hour: 'numeric', minute: 'numeric', second: 'numeric' }));
  }
  return formatters.get(id);
}
export function validZone(id) {
  if (typeof id !== 'string' || !id || id.length > 64) return false;
  try { zoneFormatter(id); return true; } catch { return false; }
}

// How far an IANA zone's clock is ahead of UTC at an instant, in ms.
function ianaOffset(ms, id) {
  const parts = Object.fromEntries(zoneFormatter(id).formatToParts(new Date(ms)).map((p) => [p.type, p.value]));
  const wall = Date.UTC(+parts.year, +parts.month - 1, +parts.day, +parts.hour % 24, +parts.minute, +parts.second);
  return wall - Math.floor(ms / 1000) * 1000;
}

// Wall time in a zone → instant. Tries the offset at the guess, then corrects once, which settles
// every case but the hour a clock change skips (that time comes out an hour later, as calendars do).
export function wallToUtc(wall, zone) {
  if (!zone || zone.kind === 'utc') return wall;
  if (zone.kind === 'iana') {
    const first = wall - ianaOffset(wall, zone.id);
    const second = wall - ianaOffset(first, zone.id);
    return second === first ? first : wall - Math.max(ianaOffset(first, zone.id), ianaOffset(second, zone.id));
  }
  return wall - vtzOffset(zone.def, wall);
}
export function utcToWall(ms, zone) {
  if (!zone || zone.kind === 'utc') return ms;
  if (zone.kind === 'iana') return ms + ianaOffset(ms, zone.id);
  return ms + vtzOffset(zone.def, ms);
}

// "+0100" / "-0530" → ms.
function parseOffset(s) {
  const m = /^([+-])(\d{2})(\d{2})(\d{2})?$/.exec(String(s || '').trim());
  return m ? (m[1] === '-' ? -1 : 1) * ((+m[2] * 60 + +m[3]) * 60 + +(m[4] || 0)) * 1000 : 0;
}

// A feed's own VTIMEZONE: its STANDARD and DAYLIGHT observances, each starting at DTSTART and
// repeating by its RRULE. The offset at a wall time is that of the observance that began last.
function readVtimezone(c) {
  const obs = c.children.filter((x) => x.type === 'STANDARD' || x.type === 'DAYLIGHT').map((o) => {
    const start = parseValue(prop(o, 'DTSTART')?.value);
    return start && { start: start.wall, from: parseOffset(prop(o, 'TZOFFSETFROM')?.value), to: parseOffset(prop(o, 'TZOFFSETTO')?.value),
      rule: parseRule(prop(o, 'RRULE')?.value), rdates: (o.props.RDATE || []).flatMap((p) => p.value.split(',').map((v) => parseValue(v)?.wall).filter(Number.isFinite)) };
  }).filter(Boolean);
  return obs.length ? { obs, cache: new Map() } : null;
}
function vtzOffset(def, wall) {
  const year = new Date(wall).getUTCFullYear();
  if (!def.cache.has(year)) {
    // Every onset from the year before to this one, latest last.
    const from = Date.UTC(year - 1, 0, 1), to = Date.UTC(year + 1, 0, 1);
    const onsets = [];
    for (const o of def.obs) {
      const times = o.rule ? expandRule(o.start, o.rule, from, to, o.rule.until?.wall ?? null) : [o.start];
      for (const t of [...times, ...o.rdates]) onsets.push([t, o.to]);
    }
    onsets.sort((a, b) => a[0] - b[0]);
    def.cache.set(year, onsets);
  }
  const onsets = def.cache.get(year);
  let offset = null;
  for (const [t, to] of onsets) { if (t <= wall) offset = to; else break; }
  if (offset === null) offset = (def.obs.find((o) => o.start <= wall) || def.obs[0]).to; // before the first onset known
  return offset;
}

// The zone a TZID names: an IANA name, a Windows name, a path ending in an IANA name
// (/mozilla.org/…/Europe/London), or the feed's VTIMEZONE of that name. Otherwise the fallback.
function zoneFor(tzid, vtimezones, fallback) {
  if (!tzid) return fallback;
  const id = tzid.replace(/^"|"$/g, '').trim();
  if (/^(utc|gmt|z|etc\/utc|etc\/gmt)$/i.test(id)) return { kind: 'utc' };
  if (validZone(id)) return { kind: 'iana', id };
  if (WINDOWS_ZONES[id]) return { kind: 'iana', id: WINDOWS_ZONES[id] };
  const tail = /([A-Za-z_]+\/[A-Za-z_+\-0-9]+(?:\/[A-Za-z_]+)?)$/.exec(id)?.[1];
  if (tail && validZone(tail)) return { kind: 'iana', id: tail };
  const def = vtimezones.get(id);
  return def ? { kind: 'vtz', def } : fallback;
}

// DURATION: P1D, PT1H30M, -P1W.
function parseDuration(s) {
  const m = /^([+-])?P(?:(\d+)W)?(?:(\d+)D)?(?:T(?:(\d+)H)?(?:(\d+)M)?(?:(\d+)S)?)?$/.exec(String(s || '').trim());
  if (!m) return null;
  const ms = (+(m[2] || 0) * 7 + +(m[3] || 0)) * DAY + ((+(m[4] || 0) * 60 + +(m[5] || 0)) * 60 + +(m[6] || 0)) * 1000;
  return m[1] === '-' ? -ms : ms;
}

// ---- Recurrence ----------------------------------------------------------------------

function parseRule(value) {
  if (!value) return null;
  const r = Object.fromEntries(String(value).split(';').map((kv) => kv.split('=')).filter(([k, v]) => k && v !== undefined).map(([k, v]) => [k.toUpperCase(), v]));
  const freq = r.FREQ?.toUpperCase();
  if (!['SECONDLY', 'MINUTELY', 'HOURLY', 'DAILY', 'WEEKLY', 'MONTHLY', 'YEARLY'].includes(freq)) return null;
  const nums = (s) => (s ? s.split(',').map(Number).filter((n) => Number.isInteger(n) && n !== 0) : []);
  return {
    freq: ['SECONDLY', 'MINUTELY', 'HOURLY'].includes(freq) ? 'DAILY' : freq,
    interval: Math.max(1, parseInt(r.INTERVAL, 10) || 1),
    count: r.COUNT ? Math.max(0, parseInt(r.COUNT, 10) || 0) : null,
    until: r.UNTIL ? parseValue(r.UNTIL) : null,
    byday: (r.BYDAY || '').split(',').map((s) => /^([+-]?\d{1,2})?(SU|MO|TU|WE|TH|FR|SA)$/i.exec(s.trim())).filter(Boolean)
      .map((m) => ({ n: m[1] ? parseInt(m[1], 10) : 0, wd: WEEKDAYS[m[2].toUpperCase()] })),
    bymonthday: nums(r.BYMONTHDAY), bymonth: nums(r.BYMONTH).filter((n) => n >= 1 && n <= 12), bysetpos: nums(r.BYSETPOS),
    wkst: WEEKDAYS[(r.WKST || 'MO').toUpperCase()] ?? 1
  };
}

const daysIn = (y, m) => new Date(Date.UTC(y, m + 1, 0)).getUTCDate();
const dayMs = (y, m, d) => Date.UTC(y, m, d);

// Days of a month (0-based m) that match BYDAY, with ordinals counted within the month.
function monthByDay(y, m, byday) {
  const out = [], n = daysIn(y, m);
  for (const { n: ord, wd } of byday) {
    const hits = [];
    for (let d = 1; d <= n; d++) if (new Date(Date.UTC(y, m, d)).getUTCDay() === wd) hits.push(d);
    if (!ord) out.push(...hits);
    else { const d = ord > 0 ? hits[ord - 1] : hits[hits.length + ord]; if (d) out.push(d); }
  }
  return out;
}
function monthDays(y, m, list) {
  const n = daysIn(y, m);
  return list.map((d) => (d > 0 ? d : n + d + 1)).filter((d) => d >= 1 && d <= n);
}

// The days (as midnight ms) one period of the rule produces, before BYSETPOS.
function periodDays(rule, y, m, d, start) {
  const s = new Date(start);
  const wdOk = (ms) => !rule.byday.length || rule.byday.some((b) => b.wd === new Date(ms).getUTCDay());
  const monthOk = (ms) => !rule.bymonth.length || rule.bymonth.includes(new Date(ms).getUTCMonth() + 1);
  const inMonth = (yy, mm) => {
    let days;
    if (rule.bymonthday.length) {
      days = monthDays(yy, mm, rule.bymonthday);
      if (rule.byday.length) { const ok = new Set(monthByDay(yy, mm, rule.byday.map((b) => ({ ...b, n: 0 })))); days = days.filter((x) => ok.has(x)); }
    } else if (rule.byday.length) days = monthByDay(yy, mm, rule.byday);
    else days = s.getUTCDate() <= daysIn(yy, mm) ? [s.getUTCDate()] : [];
    return days.map((x) => dayMs(yy, mm, x));
  };
  switch (rule.freq) {
    case 'DAILY': {
      const ms = dayMs(y, m, d);
      const okDay = !rule.bymonthday.length || monthDays(y, m, rule.bymonthday).includes(d);
      return wdOk(ms) && monthOk(ms) && okDay ? [ms] : [];
    }
    case 'WEEKLY': {
      const first = dayMs(y, m, d); // the week's first day (WKST)
      const wds = rule.byday.length ? rule.byday.map((b) => b.wd) : [s.getUTCDay()];
      const out = [];
      for (let i = 0; i < 7; i++) { const ms = first + i * DAY; if (wds.includes(new Date(ms).getUTCDay()) && monthOk(ms)) out.push(ms); }
      return out;
    }
    case 'MONTHLY':
      return rule.bymonth.length && !rule.bymonth.includes(m + 1) ? [] : inMonth(y, m);
    case 'YEARLY': {
      if (rule.bymonth.length) return rule.bymonth.flatMap((mm) => inMonth(y, mm - 1));
      if (rule.byday.length && !rule.bymonthday.length) {
        // BYDAY across the whole year (e.g. the 20th Monday), rare but cheap to support.
        const out = [];
        for (const { n: ord, wd } of rule.byday) {
          const hits = [];
          for (let ms = Date.UTC(y, 0, 1); ms < Date.UTC(y + 1, 0, 1); ms += DAY) if (new Date(ms).getUTCDay() === wd) hits.push(ms);
          if (!ord) out.push(...hits); else { const x = ord > 0 ? hits[ord - 1] : hits[hits.length + ord]; if (x) out.push(x); }
        }
        return out;
      }
      if (rule.bymonthday.length) return monthDays(y, s.getUTCMonth(), rule.bymonthday).map((x) => dayMs(y, s.getUTCMonth(), x));
      return s.getUTCDate() <= daysIn(y, s.getUTCMonth()) ? [dayMs(y, s.getUTCMonth(), s.getUTCDate())] : [];
    }
  }
  return [];
}

// Occurrence wall times of a rule from start, those in [from, to) only. until: a wall time, or
// null. Walks period by period (day, week, month or year, every INTERVAL), skipping ahead to the
// window when no COUNT has to be kept.
export function expandRule(start, rule, from, to, until = null) {
  const out = [];
  const s = new Date(start), timeOfDay = start - dayMs(s.getUTCFullYear(), s.getUTCMonth(), s.getUTCDate());
  let y = s.getUTCFullYear(), m = s.getUTCMonth(), d = s.getUTCDate();
  if (rule.freq === 'WEEKLY') { const back = (s.getUTCDay() - rule.wkst + 7) % 7; const w = new Date(dayMs(y, m, d) - back * DAY); y = w.getUTCFullYear(); m = w.getUTCMonth(); d = w.getUTCDate(); }
  if (rule.freq === 'MONTHLY' || rule.freq === 'YEARLY') d = 1;
  if (rule.count === null && from > start) { // jump to just before the window
    const i = rule.interval;
    if (rule.freq === 'DAILY' || rule.freq === 'WEEKLY') {
      const len = (rule.freq === 'DAILY' ? 1 : 7) * DAY * i;
      const k = Math.max(0, Math.floor((from - dayMs(y, m, d)) / len) - 1);
      const t = new Date(dayMs(y, m, d) + k * len); y = t.getUTCFullYear(); m = t.getUTCMonth(); d = t.getUTCDate();
    } else if (rule.freq === 'MONTHLY') {
      const f = new Date(from), months = (f.getUTCFullYear() - y) * 12 + f.getUTCMonth() - m;
      const k = Math.max(0, Math.floor(months / i) - 1) * i; const t = new Date(Date.UTC(y, m + k, 1)); y = t.getUTCFullYear(); m = t.getUTCMonth();
    } else {
      const k = Math.max(0, Math.floor((new Date(from).getUTCFullYear() - y) / i) - 1) * i; y += k;
    }
  }
  let n = 0;
  for (let p = 0; p < MAX_PERIODS; p++) {
    let days = periodDays(rule, y, m, d, start).sort((a, b) => a - b);
    if (rule.bysetpos.length) days = rule.bysetpos.map((i) => (i > 0 ? days[i - 1] : days[days.length + i])).filter((x) => x !== undefined).sort((a, b) => a - b);
    for (const day of days) {
      const t = day + timeOfDay;
      if (t < start) continue;
      if (until !== null && t > until) return out;
      if (t >= to) return out;
      n++;
      if (t >= from) { out.push(t); if (out.length >= MAX_OCCURRENCES) return out; }
      if (rule.count !== null && n >= rule.count) return out;
    }
    // Next period.
    if (rule.freq === 'DAILY' || rule.freq === 'WEEKLY') {
      const t = new Date(dayMs(y, m, d) + (rule.freq === 'DAILY' ? 1 : 7) * rule.interval * DAY); y = t.getUTCFullYear(); m = t.getUTCMonth(); d = t.getUTCDate();
    } else if (rule.freq === 'MONTHLY') { const t = new Date(Date.UTC(y, m + rule.interval, 1)); y = t.getUTCFullYear(); m = t.getUTCMonth(); }
    else y += rule.interval;
    if (dayMs(y, rule.freq === 'YEARLY' ? 0 : m, rule.freq === 'MONTHLY' || rule.freq === 'YEARLY' ? 1 : d) >= to) return out; // the period starts after the window
  }
  return out;
}

// ---- The feed -----------------------------------------------------------------------

const day = (wall) => new Date(wall).toISOString().slice(0, 10);

/**
 * Reads a feed into its name and events, ready to expand. Throws if it isn't an iCalendar file.
 * fallbackZone: the zone for "floating" times that name none (an IANA id).
 */
export function parseCalendar(source, fallbackZone = 'UTC') {
  const root = components(source);
  const cal = root.children.find((c) => c.type === 'VCALENDAR');
  if (!cal) throw new Error('This isn\'t an iCalendar (.ics) file.');
  const vtimezones = new Map(cal.children.filter((c) => c.type === 'VTIMEZONE').map((c) => [text(c, 'TZID'), readVtimezone(c)]).filter(([k, v]) => k && v));
  const calZoneName = text(cal, 'X-WR-TIMEZONE');
  const floating = validZone(calZoneName) ? { kind: 'iana', id: calZoneName } : validZone(fallbackZone) ? { kind: 'iana', id: fallbackZone } : { kind: 'utc' };

  const events = [];
  for (const c of cal.children) {
    if (c.type !== 'VEVENT') continue;
    if (events.length >= MAX_EVENTS) break;
    const dtstart = prop(c, 'DTSTART');
    const start = dtstart && parseValue(dtstart.value, dtstart.params);
    if (!start) continue;
    const zone = start.utc ? { kind: 'utc' } : start.allDay ? null : zoneFor(dtstart.params.TZID, vtimezones, floating);
    const dtend = prop(c, 'DTEND'), endValue = dtend && parseValue(dtend.value, dtend.params);
    let length;
    if (endValue) {
      // An end in another zone (or UTC) is compared as an instant.
      const endZone = endValue.utc ? { kind: 'utc' } : endValue.allDay ? null : zoneFor(dtend.params.TZID, vtimezones, floating);
      length = start.allDay || !endZone ? endValue.wall - start.wall : wallToUtc(endValue.wall, endZone) - wallToUtc(start.wall, zone);
    } else length = parseDuration(prop(c, 'DURATION')?.value) ?? (start.allDay ? DAY : 0);
    if (!(length >= 0)) length = start.allDay ? DAY : 0;
    if (start.allDay) length = Math.max(DAY, Math.round(length / DAY) * DAY);

    // A date list's values, each read in its own TZID or the event's zone, as occurrence keys.
    const dates = (name) => (c.props[name] || []).flatMap((p) => p.value.split(',').map((v) => {
      const x = parseValue(v, p.params);
      if (!x) return null;
      if (start.allDay) return x.wall - (x.wall % DAY);
      const z = x.utc ? { kind: 'utc' } : zoneFor(p.params.TZID, vtimezones, zone);
      return utcToWall(wallToUtc(x.wall, z), zone);
    }).filter((x) => x !== null));
    const recurrenceId = prop(c, 'RECURRENCE-ID');
    let recurrenceKey = null;
    if (recurrenceId) {
      const r = parseValue(recurrenceId.value, recurrenceId.params);
      if (r) recurrenceKey = r.allDay || start.allDay ? day(r.wall) : wallToUtc(r.wall, r.utc ? { kind: 'utc' } : zoneFor(recurrenceId.params.TZID, vtimezones, zone));
    }
    const rule = parseRule(prop(c, 'RRULE')?.value);
    events.push({
      uid: text(c, 'UID') || `${start.wall}-${text(c, 'SUMMARY')}`,
      title: text(c, 'SUMMARY') || '(No title)',
      location: text(c, 'LOCATION'),
      description: text(c, 'DESCRIPTION').slice(0, 4000),
      url: text(c, 'URL'),
      cancelled: text(c, 'STATUS').toUpperCase() === 'CANCELLED',
      allDay: start.allDay, start: start.wall, length, zone,
      rule, until: rule?.until ? (rule.until.utc && zone ? utcToWall(rule.until.wall, zone) : rule.until.allDay ? rule.until.wall + DAY - 1 : rule.until.wall) : null,
      rdates: dates('RDATE'), exdates: new Set(dates('EXDATE')),
      recurrenceKey
    });
  }
  return { name: text(cal, 'X-WR-CALNAME').slice(0, 80), events };
}

/**
 * The occurrences of a parsed calendar's events that overlap [fromMs, toMs) and the days
 * [fromDay, toDay) for all-day ones. Each: { uid, key, title, allDay, start, end, location,
 * description, url, recurring }; timed start/end are instants (ms), all-day ones 'YYYY-MM-DD'
 * with an exclusive end.
 */
export function occurrences(parsed, { fromMs, toMs, fromDay, toDay }) {
  const out = [];
  const pad = 2 * DAY; // wall times are within a day of instants, whatever the zone
  const fromWall = Date.UTC(+fromDay.slice(0, 4), +fromDay.slice(5, 7) - 1, +fromDay.slice(8, 10));
  const toWall = Date.UTC(+toDay.slice(0, 4), +toDay.slice(5, 7) - 1, +toDay.slice(8, 10));
  // Edited occurrences replace the one they name; cancelled ones just remove it.
  const overrides = new Map();
  for (const e of parsed.events) if (e.recurrenceKey !== null) overrides.set(`${e.uid}\n${e.recurrenceKey}`, e);

  const emit = (e, wall, recurring) => {
    if (e.cancelled || out.length >= MAX_OCCURRENCES) return;
    if (e.allDay) {
      const s = day(wall), end = day(wall + e.length);
      if (s < toDay && end > fromDay) out.push({ uid: e.uid, key: s, title: e.title, allDay: true, start: s, end, location: e.location, description: e.description, url: e.url, recurring });
    } else {
      const s = wallToUtc(wall, e.zone), end = s + e.length;
      if (s < toMs && (end > fromMs || (e.length === 0 && s >= fromMs))) {
        out.push({ uid: e.uid, key: String(s), title: e.title, allDay: false, start: s, end, location: e.location, description: e.description, url: e.url, recurring });
      }
    }
  };
  for (const e of parsed.events) {
    if (e.recurrenceKey !== null) { emit(e, e.start, true); continue; }
    if (!e.rule && !e.rdates.length) { emit(e, e.start, false); continue; }
    const lo = (e.allDay ? fromWall : fromMs) - pad - e.length, hi = (e.allDay ? toWall : toMs) + pad;
    const times = new Set(e.rule ? expandRule(e.start, e.rule, lo, hi, e.until) : (e.start >= lo && e.start < hi ? [e.start] : []));
    for (const r of e.rdates) if (r >= lo && r < hi) times.add(r);
    for (const wall of [...times].sort((a, b) => a - b)) {
      if (e.exdates.has(wall)) continue;
      const key = e.allDay ? day(wall) : wallToUtc(wall, e.zone);
      if (overrides.has(`${e.uid}\n${key}`)) continue;
      emit(e, wall, true);
    }
  }
  return out.sort((a, b) => (a.allDay === b.allDay ? (a.start < b.start ? -1 : a.start > b.start ? 1 : 0) : a.allDay ? -1 : 1));
}
