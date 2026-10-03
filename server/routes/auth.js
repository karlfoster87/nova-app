// Signing in and out, switching profile, and what the signed-in profile is.
import { config, profileDir, VERSION } from '../core/config.js';
import { q } from '../core/db.js';
import { UserError } from '../core/errors.js';
import { BOOT_ID } from '../core/restart.js';
import { send, readJson } from '../http/respond.js';
import { login, logout, cookieHeader, switchTo } from '../accounts/auth.js';
import { prefsFor, pictureStamp } from '../accounts/profiles.js';
import { VIEWS, accessFor } from '../accounts/access.js';
import { publicMeta } from '../claude/meta.js';
import { piperOn } from '../voice/piper.js';

export default function authRoutes(api, open) {
  // Polled by the restart screen. The boot ID is random per process, so a changed ID
  // means the restart has happened, however quickly.
  open.get('/api/health', ({ res }) => send(res, 200, { ok: true, boot: BOOT_ID }, { 'Cache-Control': 'no-store' }));

  open.post('/api/login', async ({ req, res }) => {
    const { name, password } = await readJson(req);
    const r = login(String(name || '').trim(), String(password || ''));
    if (r.error) throw new UserError(r.error, 401);
    send(res, 200, { ok: true }, { 'Set-Cookie': cookieHeader(r.token) });
  });

  api.post('/api/logout', ({ req, res }) => {
    logout(req);
    send(res, 200, { ok: true }, { 'Set-Cookie': cookieHeader('', true) });
  });

  // Everything the page needs at start: who's signed in, what it may use, Claude's state and limits.
  api.get('/api/me', ({ profile }) => {
    const row = q.profile.get(profile);
    return { profile, role: row.role, version: VERSION, hasPin: !!row.pin_hash, picture: pictureStamp(profile),
      contextDir: profileDir(profile), brainDir: config.paths.brainDir, meta: publicMeta(),
      views: VIEWS.map(({ id, label }) => ({ id, label })), access: accessFor(profile), prefs: prefsFor(row),
      uploads: { maxMB: config.uploads.maxMB, maxFiles: config.uploads.maxFiles, brainMaxMB: config.brain.maxUploadMB },
      voice: { piper: piperOn() } };
  });

  // Switching ends this session and starts one for the other profile in the same tab.
  api.post('/api/switch', async ({ req, res, profile }) => {
    const { name, pin, password } = await readJson(req);
    const target = String(name || '').trim();
    if (target.toLowerCase() === profile.toLowerCase()) return { ok: true };
    const r = switchTo(target, { pin, password });
    if (r.error) throw new UserError(r.error, 401);
    logout(req);
    send(res, 200, { ok: true }, { 'Set-Cookie': cookieHeader(r.token) });
  });
}
