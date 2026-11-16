// Heartbeat schedules (heartbeat/schedules.js, runs.js) and the Train of Thought
// (thought/thoughts.js), the Core tab's last two panes. Everything checks the Core tab's access
// ('brain'): read to see, edit to change schedules. Schedules and runs are the profile's own;
// the timeline is shared, with each entry's detail and links kept to the profile it came from.
import { readJson } from '../http/respond.js';
import { UserError } from '../core/errors.js';
import { requireView } from '../accounts/access.js';
import { ownedChat } from '../chat/chats.js';
import { sessionMessages } from '../chat/handoff.js';
import { listSchedules, createSchedule, updateSchedule, deleteSchedule } from '../heartbeat/schedules.js';
import { runNow, stopRun, isRunChat } from '../heartbeat/runs.js';
import { listThoughts, resolveThought } from '../thought/thoughts.js';

const UUID = '([0-9a-f-]{36})';
const SCHEDULE = new RegExp(`^/api/heartbeats/${UUID}$`);
const SCHEDULE_RUN = new RegExp(`^/api/heartbeats/${UUID}/run$`);
const SCHEDULE_STOP = new RegExp(`^/api/heartbeats/${UUID}/stop$`);
const RUN = new RegExp(`^/api/heartbeat-runs/${UUID}$`);
const THOUGHT = new RegExp(`^/api/thoughts/${UUID}$`);

// A behind-the-scenes run's transcript, for the Heartbeat pane. Only the profile's own runs.
async function runTranscript(profile, id) {
  requireView(profile, 'brain', 'read');
  const row = ownedChat(profile, id);
  if (!row || row.origin !== 'heartbeat') throw new UserError('That run isn\'t kept any more.', 404);
  return { id: row.id, title: row.title, at: row.created_at, scheduleId: row.origin_id, running: isRunChat(row.id),
    messages: await sessionMessages(row.id) };
}

export default function heartbeatRoutes(api) {
  api.get('/api/heartbeats', ({ profile }) => listSchedules(profile));
  api.post('/api/heartbeats', async ({ req, profile }) => createSchedule(profile, await readJson(req), { by: 'you' }));
  api.patch(SCHEDULE, async ({ req, profile, params: [id] }) => updateSchedule(profile, id, await readJson(req)));
  api.delete(SCHEDULE, ({ profile, params: [id] }) => deleteSchedule(profile, id));
  api.post(SCHEDULE_RUN, ({ profile, params: [id] }) => runNow(profile, id));
  api.post(SCHEDULE_STOP, ({ profile, params: [id] }) => stopRun(profile, id));
  api.get(RUN, ({ profile, params: [id] }) => runTranscript(profile, id));

  api.get('/api/thoughts', ({ url, profile }) => listThoughts(profile, {
    before: url.searchParams.get('before'), filter: url.searchParams.get('filter') || 'all', scheduleId: url.searchParams.get('schedule')
  }));
  api.patch(THOUGHT, async ({ req, profile, params: [id] }) => resolveThought(profile, id, (await readJson(req)).status));
}
