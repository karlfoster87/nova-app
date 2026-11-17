// Email (email/email.js): Settings → Email picks the provider and turns it on (under /api/settings,
// so admin-only before this runs), and the Home card lists, refreshes and hands items to chats.
// Email reads the mailbox of the account Nova runs as, so every route here is for admins only;
// email.js checks that again on each call.
import { readJson } from '../http/respond.js';
import { refreshAllRunners } from '../chat/runner.js';
import { emailSettings, saveEmailSettings, emailList, emailHandoff } from '../email/email.js';

const HANDOFF = /^\/api\/email\/([0-9a-f]{12})\/handoff$/;

export default function emailRoutes(api) {
  api.get('/api/settings/email', () => emailSettings());
  // Turning email on or off adds or removes Nova's email tools, which chats get when their process starts.
  api.post('/api/settings/email', async ({ req, profile }) => {
    const out = await saveEmailSettings(profile, await readJson(req));
    if (out.changed) refreshAllRunners();
    return out;
  });
  api.post('/api/email/refresh', ({ profile }) => emailList(profile));
  api.post(HANDOFF, async ({ req, profile, params: [ref] }) => emailHandoff(profile, ref, (await readJson(req)).mode));
}
