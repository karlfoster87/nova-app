// The Soul (soul/soul.js): everyone with brain access reads it; saving checks for an admin.
import { hub } from '../core/hub.js';
import { readJson } from '../http/respond.js';
import { refreshAllRunners } from '../chat/runner.js';
import { getSoul, saveSoul } from '../soul/soul.js';

export default function soulRoutes(api) {
  api.get('/api/soul', ({ profile }) => getSoul(profile));
  api.put('/api/soul', async ({ req, profile }) => {
    const { text, version } = await readJson(req, 64 * 1024);
    const { changed, ...out } = await saveSoul(profile, text, version);
    if (changed) {
      // Claude Code reads the system prompt at process start, so open chats restart when they're
      // quiet; every profile's open Soul pane reloads.
      refreshAllRunners();
      hub.toAll({ t: 'soul_changed' });
    }
    return out;
  });
}
