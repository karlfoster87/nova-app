// Settings → Updates: the Agent SDK from npm and Nova itself from GitHub. Both check on one
// timer and install only when an admin asks; installing restarts Nova. Admin-only, like
// everything under /api/settings.
import { UserError } from '../core/errors.js';
import { saveConfig } from '../core/config.js';
import { SUPERVISED, BOOT_ID, restart } from '../core/restart.js';
import { readJson, send } from '../http/respond.js';
import { updateStatus, checkLatest, scheduleChecks, startUpdate } from '../updates/sdk.js';
import { appStatus, checkApp, scheduleAppChecks, startAppUpdate } from '../updates/app.js';

export default function updateRoutes(api) {
  const sdk = () => ({ ...updateStatus(), canRestart: SUPERVISED });
  const app = async () => ({ ...(await appStatus()), canRestart: SUPERVISED });

  api.get('/api/settings/sdk', sdk);
  // How often both updaters check. 0 turns checking off.
  api.post('/api/settings/sdk', async ({ req }) => {
    const hours = Number((await readJson(req)).checkHours);
    if (!Number.isInteger(hours) || hours < 0 || hours > 24 * 30) throw new UserError('Check every 1 to 720 hours, or 0 to stop checking.');
    saveConfig('updates', { checkHours: hours });
    scheduleChecks();
    scheduleAppChecks();
    return sdk();
  });
  api.post('/api/settings/sdk/check', async () => { await checkLatest(); return sdk(); });
  api.post('/api/settings/sdk/update', async ({ req, res, profile }) => {
    if (!SUPERVISED) {
      throw new UserError('Nova can only update the SDK when started with npm start (or the service set up in the README), ' +
        'because it has to restart. Stop Nova, run npm install @anthropic-ai/claude-agent-sdk@<version> --save-exact, and start it again.', 409);
    }
    startUpdate(profile, String((await readJson(req)).version || ''), (version) => {
      console.log(`Restarting to install Agent SDK ${version}.`);
      restart(`Updating the Claude Agent SDK to ${version}.`);
    });
    send(res, 202, { ...sdk(), boot: BOOT_ID });
  });

  api.get('/api/settings/app', app);
  api.post('/api/settings/app/check', async () => { await checkApp(); return app(); });
  api.post('/api/settings/app/update', async ({ req, res, profile }) => {
    if (!SUPERVISED) {
      throw new UserError('Nova can only update itself when started with npm start, the Windows task or the systemd service, ' +
        'because it has to restart. Update it by hand as the README describes.', 409);
    }
    startAppUpdate(profile, String((await readJson(req)).commit || ''), (target) => {
      console.log(`Restarting to update Nova to ${target.version} (${target.commit.slice(0, 7)}).`);
      restart(`Updating Nova to ${target.version}.`);
    });
    send(res, 202, { ...(await app()), boot: BOOT_ID });
  });
}
