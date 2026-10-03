// Nova server: the browser app, a JSON API and one WebSocket per browser tab. This file only
// wires the parts together. The API's routes are listed by area in routes/, the WebSocket
// protocol is in ws.js, and each area's logic has its own folder: accounts, chat, claude,
// brain, views and updates, on top of core (config, database, shared helpers) and http.
// server/launcher.js runs this file; keep its path.
import http from 'node:http';
import { config } from './core/config.js';
import { UserError } from './core/errors.js';
import { beforeRestart } from './core/restart.js';
import { send, sameOrigin } from './http/respond.js';
import { servePublic, serveApp } from './http/static.js';
import { createRouter } from './http/router.js';
import { attachSockets } from './ws.js';
import { profileFrom } from './accounts/auth.js';
import { isAdmin } from './accounts/profiles.js';
import { closeAllRunners } from './chat/runner.js';
import { adoptTranscripts } from './chat/chats.js';
import { sweepUploads } from './chat/uploads.js';
import { meta } from './claude/meta.js';
import { scheduleChecks } from './updates/sdk.js';
import { scheduleAppChecks } from './updates/app.js';
import authRoutes from './routes/auth.js';
import profileRoutes from './routes/profiles.js';
import chatRoutes from './routes/chats.js';
import permissionRoutes from './routes/permissions.js';
import brainRoutes from './routes/brain.js';
import viewRoutes from './routes/views.js';
import settingsRoutes from './routes/settings.js';
import updateRoutes from './routes/updates.js';
import voiceRoutes from './routes/voice.js';
import searchRoutes from './routes/search.js';

const open = createRouter(); // routes that need no session: health, sign-in, brain pages (own token)
const api = createRouter();  // everything else, for a signed-in profile
for (const register of [authRoutes, profileRoutes, chatRoutes, permissionRoutes, brainRoutes, viewRoutes, settingsRoutes, updateRoutes, voiceRoutes, searchRoutes]) {
  register(api, open);
}

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, 'http://x');
  const p = url.pathname;
  const profile = profileFrom(req);
  try {
    if (req.method !== 'GET' && !sameOrigin(req)) return send(res, 403, { error: 'Cross-origin request refused.' });
    if (servePublic(res, p) || await open.handle({ req, res, url, profile })) return;
    if (!profile) {
      if (p.startsWith('/api/')) return send(res, 401, { error: 'Sign in first.' });
      res.writeHead(302, { Location: '/login' });
      return res.end();
    }
    if (serveApp(res, p)) return;
    // Global settings are admin-only, whichever route it is.
    if (p.startsWith('/api/settings') && !isAdmin(profile)) return send(res, 403, { error: 'Only an admin can change global settings.' });
    if (!(await api.handle({ req, res, url, profile }))) send(res, 404, { error: 'Not found.' });
  } catch (err) {
    if (res.headersSent) return res.destroy();
    if (err instanceof UserError) return send(res, err.status, { error: err.message });
    console.error(err);
    send(res, 500, { error: err.message });
  }
});

const wss = attachSockets(server);

// A restart (core/restart.js) stops these first, in this order.
beforeRestart(closeAllRunners);
beforeRestart(() => meta.stop());
beforeRestart(() => { for (const ws of wss.clients) ws.close(1012, 'Restarting'); }); // 1012 = service restart
beforeRestart(() => server.close());

server.listen(config.server.port, config.server.host, () => {
  console.log(`Nova (${config.server.mode}) on http://${config.server.host}:${config.server.port}`);
  console.log(`Brain: ${config.paths.brainDir}`);
  adoptTranscripts();
  meta.start().catch((err) => console.error('Meta session failed to start:', err.message));
  sweepUploads();
  scheduleChecks();
  scheduleAppChecks();
});
