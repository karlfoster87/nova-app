// Global settings: models and chats, the brain folder, and Claude sign-in. Everything under
// /api/settings is admin-only; index.js refuses other profiles before any route here runs.
import fs from 'node:fs';
import path from 'node:path';
import { config, saveConfig, brainKey, BRAIN, CLAUDE_DIR } from '../core/config.js';
import { UserError } from '../core/errors.js';
import { SUPERVISED, BOOT_ID, restart } from '../core/restart.js';
import { readJson, send } from '../http/respond.js';
import { busyError, refreshAllRunners, EFFORTS } from '../chat/runner.js';
import { meta, publicMeta } from '../claude/meta.js';
import { signinStatus, startSignin, submitCode, cancelSignin, signOut } from '../claude/signin.js';

// A new brain folder must be a full path to an existing folder the service account can use.
// Returns the folder's real spelling with forward slashes (config.json stays readable on Windows).
function checkBrainDir(input) {
  const raw = String(input || '').trim();
  if (!raw) throw new UserError('Enter the full path of your brain folder.');
  if (!path.isAbsolute(raw)) throw new UserError('Use a full path, starting from the drive or root, e.g. C:\\Notes\\Brain.');
  const dir = path.resolve(raw);
  let stat;
  try { stat = fs.statSync(dir); } catch { throw new UserError(`${dir} doesn't exist. Create the folder first or check the path.`); }
  if (!stat.isDirectory()) throw new UserError(`${dir} is a file, not a folder.`);
  try { fs.accessSync(dir, fs.constants.R_OK | fs.constants.W_OK); }
  catch { throw new UserError(`Nova can't read and write ${dir}. Check the folder's permissions for the account running Nova.`); }
  // Claude Code finds transcripts by the working folder's path, so "c:\brain" typed for
  // "C:\Brain" must not look like a different folder.
  const real = fs.realpathSync.native(dir);
  if (brainKey(real) === BRAIN) throw new UserError('That\'s already the brain folder.');
  return real.split(path.sep).join('/');
}

export default function settingsRoutes(api) {
  api.get('/api/settings', () => ({ ...publicMeta(), idleMinutes: config.chats.idleMinutes, showThinking: config.models.showThinking,
    brainDir: config.paths.brainDir, canRestart: SUPERVISED, claudeDir: CLAUDE_DIR, signin: signinStatus() }));

  // Models, effort, thinking and the idle timeout. Anything invalid is left as it was.
  api.post('/api/settings', async ({ req }) => {
    const body = await readJson(req);
    const models = {};
    if (Array.isArray(body.hiddenModels)) models.hidden = body.hiddenModels.map(String);
    if (EFFORTS.includes(body.defaultEffort)) models.defaultEffort = body.defaultEffort;
    if (typeof body.defaultModel === 'string' || body.defaultModel === null) models.defaultModel = body.defaultModel;
    const thinkingChanged = typeof body.showThinking === 'boolean' && body.showThinking !== config.models.showThinking;
    if (thinkingChanged) models.showThinking = body.showThinking;
    if (Object.keys(models).length) saveConfig('models', models);
    if (thinkingChanged) refreshAllRunners(); // chats pick it up when their process next starts
    const idle = Number(body.idleMinutes);
    if (Number.isInteger(idle) && idle >= 5 && idle <= 24 * 60) saveConfig('chats', { idleMinutes: idle });
    meta.broadcast();
    return { ok: true };
  });

  // A new brain folder means a new process: chats, categories and Claude Code all key on it.
  api.post('/api/settings/brain', async ({ req, res, profile }) => {
    const dir = checkBrainDir((await readJson(req)).brainDir);
    if (!SUPERVISED) {
      throw new UserError('Nova can only restart itself when started with npm start (or the service set up in the README). ' +
        'Nothing was saved. Change paths.brainDir in data/config.json and restart Nova by hand instead.', 409);
    }
    const busy = busyError('change the brain folder');
    if (busy) throw busy;
    saveConfig('paths', { brainDir: dir });
    console.log(`Brain folder changed to ${dir} by ${profile}; restarting.`);
    send(res, 200, { ok: true, restarting: true, boot: BOOT_ID });
    restart('The brain folder changed.');
  });

  // Claude sign-in through the bundled Claude Code. Nova relays a link and a code, never a token.
  api.post('/api/settings/signin', async ({ req, profile }) => {
    const r = await startSignin(String((await readJson(req)).method || ''));
    console.log(`Claude sign-in (${r.method}) started by ${profile}.`);
    return r;
  });
  api.delete('/api/settings/signin', () => { cancelSignin(); return { ok: true }; });
  api.post('/api/settings/signin/code', async ({ req, profile }) => {
    await submitCode((await readJson(req)).code);
    console.log(`Claude sign-in finished by ${profile}.`);
    await meta.restart();
    refreshAllRunners(); // chats started under the old sign-in pick up the new one when quiet
    return publicMeta();
  });
  api.post('/api/settings/signout', async ({ profile }) => {
    await signOut();
    console.log(`Claude signed out by ${profile}.`);
    await meta.restart();
    refreshAllRunners();
    return publicMeta();
  });
}
