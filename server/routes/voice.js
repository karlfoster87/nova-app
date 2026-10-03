// Voice: speech from a Piper server for anyone signed in, and its address for admins (anything
// under /api/settings is admin-only; index.js refuses other profiles first).
import { config, saveConfig } from '../core/config.js';
import { hub } from '../core/hub.js';
import { readJson, send } from '../http/respond.js';
import { synthesize, checkPiperUrl, checkPiperVoice } from '../voice/piper.js';

export default function voiceRoutes(api) {
  api.post('/api/voice/speak', async ({ req, res }) => {
    const audio = await synthesize((await readJson(req, 10000)).text);
    send(res, 200, audio, { 'Content-Type': 'audio/wav', 'Cache-Control': 'no-store' });
  });

  api.get('/api/settings/voice', () => ({ piperUrl: config.voice.piperUrl, piperVoice: config.voice.piperVoice }));

  // A new address is tried before it's saved, so a typo can't leave every device silent.
  api.post('/api/settings/voice', async ({ req, profile }) => {
    const body = await readJson(req);
    const url = checkPiperUrl(body.piperUrl), voice = checkPiperVoice(body.piperVoice);
    if (url) await synthesize('Testing.', { url, voice });
    saveConfig('voice', { piperUrl: url, piperVoice: voice });
    hub.toAll({ t: 'profile_changed' }); // every open tab refetches /api/me, so it knows whether Piper is there
    console.log(url ? `Piper voice set to ${url}${voice ? ` (${voice})` : ''} by ${profile}.` : `Piper voice turned off by ${profile}.`);
    return { piperUrl: url, piperVoice: voice };
  });
}
