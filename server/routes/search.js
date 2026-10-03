// The search palette (Ctrl+K): brain files by name and by their text, tasks and sticky notes,
// in one request. Each group comes only from a view this profile can read, through that view's
// own functions, so the usual access and visibility rules apply. Chats (their titles) and
// skills are searched in the browser, which already has them.
import { UserError } from '../core/errors.js';
import { can } from '../accounts/access.js';
import { findNames } from '../brain/links.js';
import { searchBrainText } from '../brain/search.js';
import { searchTasks } from '../views/tasks.js';
import { searchNotes } from '../views/notes.js';

export default function searchRoutes(api) {
  // today: the browser's date, as for the Tasks board.
  api.get('/api/search', ({ url, profile }) => {
    const q = String(url.searchParams.get('q') || '').replace(/\s+/g, ' ').trim();
    if (q.length > 200) throw new UserError('Search for something shorter.');
    const words = q.toLowerCase().split(' ').filter(Boolean);
    if (!words.length) return {};
    const out = {};
    if (can(profile, 'brain', 'read')) {
      out.files = findNames(profile, q).results.filter((r) => r.type === 'file').slice(0, 8);
      const named = new Set(out.files.map((f) => f.path));
      out.text = searchBrainText(profile, q).filter((r) => !named.has(r.path)).slice(0, 10);
    }
    if (can(profile, 'tasks', 'read')) out.tasks = searchTasks(profile, words, url.searchParams.get('today'));
    if (can(profile, 'notes', 'read')) out.notes = searchNotes(profile, words);
    return out;
  });
}
