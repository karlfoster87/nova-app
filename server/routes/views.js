// The Tasks and Notes views, and the counts on the view tabs. Each function checks view access
// and that the row belongs to this profile. A change tells the profile's other tabs to
// refresh; X-Nova-Tab names the tab that made it, so that tab can skip its own echo.
import { hub } from '../core/hub.js';
import { readJson } from '../http/respond.js';
import { can } from '../accounts/access.js';
import { listTasks, tasksLeftToday, createTask, updateTask, moveTask, deleteTask } from '../views/tasks.js';
import { listNotes, activeNoteCount, createNote, updateNote, moveNote, deleteNote, isSharedNote } from '../views/notes.js';

const UUID = '([0-9a-f-]{36})';
const TASK = new RegExp(`^/api/tasks/${UUID}$`);
const TASK_MOVE = new RegExp(`^/api/tasks/${UUID}/move$`);
const NOTE = new RegExp(`^/api/notes/${UUID}$`);
const NOTE_MOVE = new RegExp(`^/api/notes/${UUID}/move$`);

export default function viewRoutes(api) {
  const changed = (t) => ({ req, profile }, out) => {
    hub.toProfile(profile, { t, from: String(req.headers['x-nova-tab'] || '').slice(0, 64) });
    return out;
  };
  const tasksChanged = changed('tasks_changed');
  // A change to a shared note (or one that was shared until now) reaches every profile's tabs.
  const notesChanged = ({ req, profile }, out, wide = false) => {
    const msg = { t: 'notes_changed', from: String(req.headers['x-nova-tab'] || '').slice(0, 64) };
    if (wide || out?.shared) hub.toAll(msg); else hub.toProfile(profile, msg);
    return out;
  };

  // Counts for the view tabs, only for views this profile can read. today is the browser's date.
  api.get('/api/badges', ({ url, profile }) => {
    const out = {};
    if (can(profile, 'tasks', 'read')) out.tasks = tasksLeftToday(profile, url.searchParams.get('today'));
    if (can(profile, 'notes', 'read')) out.notes = activeNoteCount(profile);
    return out;
  });

  api.get('/api/tasks', ({ url, profile }) => listTasks(profile, url.searchParams.get('today')));
  api.post('/api/tasks', async (c) => tasksChanged(c, createTask(c.profile, await readJson(c.req))));
  api.patch(TASK, async (c) => tasksChanged(c, updateTask(c.profile, c.params[0], await readJson(c.req))));
  api.post(TASK_MOVE, async (c) => tasksChanged(c, moveTask(c.profile, c.params[0], await readJson(c.req))));
  api.delete(TASK, (c) => tasksChanged(c, deleteTask(c.profile, c.params[0])));

  api.get('/api/notes', ({ profile }) => listNotes(profile));
  api.post('/api/notes', async (c) => notesChanged(c, createNote(c.profile, await readJson(c.req))));
  api.patch(NOTE, async (c) => { const wide = isSharedNote(c.params[0]); return notesChanged(c, updateNote(c.profile, c.params[0], await readJson(c.req)), wide); });
  api.post(NOTE_MOVE, async (c) => notesChanged(c, moveNote(c.profile, c.params[0], await readJson(c.req)), isSharedNote(c.params[0])));
  api.delete(NOTE, (c) => { const wide = isSharedNote(c.params[0]); deleteNote(c.profile, c.params[0]); return notesChanged(c, { ok: true }, wide); });
}
