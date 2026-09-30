// The chat list, its categories, composer attachments and the slash-command list. Chat
// messages themselves go over the WebSocket (ws.js). Everything here is the signed-in
// profile's own; other profiles' ids answer 404.
import { hub } from '../core/hub.js';
import { UserError } from '../core/errors.js';
import { readJson, sendStream } from '../http/respond.js';
import { listChats, updateChat, deleteChat } from '../chat/chats.js';
import { listCategories, createCategory, renameCategory, moveCategory, deleteCategory } from '../chat/categories.js';
import { saveUpload, discardUpload, openUpload } from '../chat/uploads.js';
import { commandsFor } from '../chat/commands.js';

const UUID = '([0-9a-f-]{36})';
const CHAT = new RegExp(`^/api/chats/${UUID}$`);
const CATEGORY = new RegExp(`^/api/categories/${UUID}$`);
const CATEGORY_MOVE = new RegExp(`^/api/categories/${UUID}/move$`);
const UPLOAD = new RegExp(`^/api/uploads/${UUID}$`);

export default function chatRoutes(api) {
  api.get('/api/chats', ({ profile }) => listChats(profile));
  api.patch(CHAT, async ({ req, profile, params: [id] }) => { updateChat(profile, id, await readJson(req)); return { ok: true }; });
  api.delete(CHAT, ({ profile, params: [id] }) => { deleteChat(profile, id); return { ok: true }; });

  // Slash commands for the composer's suggestions, from the open chat when chatId names one.
  api.get('/api/commands', async ({ url, profile }) => {
    try { return await commandsFor(profile, url.searchParams.get('chatId')); }
    catch (err) {
      console.error('Listing slash commands failed:', err.message);
      throw new UserError('Couldn\'t load the commands from Claude Code. Try again in a moment.', 502);
    }
  });

  // Categories. A change tells the profile's tabs to reload their chat list.
  const changed = (profile, out) => { hub.toProfile(profile, { t: 'chats_changed' }); return out; };
  api.get('/api/categories', ({ profile }) => listCategories(profile));
  api.post('/api/categories', async ({ req, profile }) => changed(profile, createCategory(profile, (await readJson(req)).name)));
  api.patch(CATEGORY, async ({ req, profile, params: [id] }) => changed(profile, renameCategory(profile, id, (await readJson(req)).name)));
  api.post(CATEGORY_MOVE, async ({ req, profile, params: [id] }) =>
    changed(profile, moveCategory(profile, id, { beforeId: (await readJson(req)).beforeId ?? null })));
  api.delete(CATEGORY, ({ profile, params: [id] }) => { deleteCategory(profile, id); return changed(profile, { ok: true }); });

  // Composer attachments: the body is the raw file, its name is in the query.
  api.post('/api/uploads', ({ req, url, profile }) => saveUpload(profile, req, url.searchParams.get('name')));
  api.delete(UPLOAD, ({ profile, params: [id] }) => { discardUpload(profile, id); return { ok: true }; });
  api.get(UPLOAD, ({ res, profile, params: [id] }) => sendStream(res, openUpload(profile, id), 'Attachment download'));
}
