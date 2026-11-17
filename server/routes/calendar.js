// Linked calendars (calendar/calendars.js): Settings → Calendars manages them, and the Home card
// and the full calendar page read their events. Every profile has its own; there's no view access
// level, and every lookup is by (id, profile). Feed addresses never come back to the browser.
import { readJson } from '../http/respond.js';
import { listCalendars, addCalendar, updateCalendar, deleteCalendar, refreshCalendars, eventsFor } from '../calendar/calendars.js';

const ONE = /^\/api\/calendars\/([0-9a-f-]{36})$/;
const REFRESH_ONE = /^\/api\/calendars\/([0-9a-f-]{36})\/refresh$/;

export default function calendarRoutes(api) {
  api.get('/api/calendars', ({ profile }) => listCalendars(profile));
  api.post('/api/calendars', async ({ req, profile }) => addCalendar(profile, await readJson(req)));
  api.post('/api/calendars/refresh', ({ profile }) => refreshCalendars(profile));
  api.patch(ONE, async ({ req, profile, params: [id] }) => updateCalendar(profile, id, await readJson(req)));
  api.delete(ONE, ({ profile, params: [id] }) => deleteCalendar(profile, id));
  api.post(REFRESH_ONE, ({ profile, params: [id] }) => refreshCalendars(profile, id));
  api.get('/api/calendar/events', ({ url, profile }) => eventsFor(profile, {
    from: url.searchParams.get('from'), to: url.searchParams.get('to'), tz: url.searchParams.get('tz')
  }));
}
