// Push notifications for this browser: the server's public key to subscribe with, saving and
// removing this browser's subscription, and a test push. push/notify.js does the work.
import { readJson } from '../http/respond.js';
import { tokenFrom } from '../accounts/auth.js';
import { publicKey, subscribe, unsubscribe, testPush } from '../push/notify.js';

export default function pushRoutes(api) {
  api.get('/api/push', () => ({ key: publicKey() }));
  api.post('/api/push', async ({ req, profile }) => { subscribe(profile, tokenFrom(req), await readJson(req)); return { ok: true }; });
  api.delete('/api/push', async ({ req, profile }) => { unsubscribe(profile, (await readJson(req)).endpoint); return { ok: true }; });
  api.post('/api/push/test', async ({ req, profile }) => { await testPush(profile, (await readJson(req)).endpoint); return { ok: true }; });
}
