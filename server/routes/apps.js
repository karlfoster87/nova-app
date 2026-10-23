// The Apps view: the list and its categories, each app's files, and running an app. The
// /api/apps routes are for Nova's own page (signed in); /apps/<slug> starts an app, and the
// token routes under it serve the running app, which carries no cookie (apps/serve.js).
import { readJson, sendStream } from '../http/respond.js';
import { config } from '../core/config.js';
import { UserError } from '../core/errors.js';
import { listApps, createApp, renameApp, deleteApp, moveApp, setBackend, createAppCategory, renameAppCategory,
  moveAppCategory, deleteAppCategory, SLUG_RE } from '../apps/catalog.js';
import { tree, readFile, writeFile, deleteFile } from '../apps/files.js';
import { runUrl, tokenProfile, appFile } from '../apps/serve.js';
import { runBackend } from '../apps/backend.js';
import { appBrain, grantSummary, setBrainGrants } from '../apps/brain.js';
import path from 'node:path';

const SLUG = '([a-z0-9-]+)';

export default function appRoutes(api, open) {
  const pathOf = (url) => url.searchParams.get('path');

  // Each app also says which brain paths it asks for and which an admin allowed (apps/brain.js).
  api.get('/api/apps', ({ profile }) => {
    const out = listApps(profile);
    for (const a of out.apps) if (a.valid) a.brain = grantSummary(a.slug, path.join(config.paths.appsDir, a.slug));
    return out;
  });
  api.post('/api/apps', async ({ req, profile }) => createApp(profile, await readJson(req)));
  // Rename, move to a category, or (admins) let its backend run or let it use brain files.
  api.patch(new RegExp(`^/api/apps/([^/]+)$`), async ({ req, profile, params: [slug] }) => {
    const body = await readJson(req);
    slug = decodeURIComponent(slug);
    if ('backend' in body) return setBackend(profile, slug, body.backend === true);
    if ('brain' in body) return setBrainGrants(profile, slug, body.brain === true);
    if ('categoryId' in body) return moveApp(profile, slug, body.categoryId);
    if ('slug' in body) return renameApp(profile, slug, body.slug);
    throw new UserError('Nothing to change.');
  });
  api.delete(new RegExp(`^/api/apps/([^/]+)$`), ({ profile, params: [slug] }) => deleteApp(profile, decodeURIComponent(slug)));

  api.get(new RegExp(`^/api/apps/${SLUG}/tree$`), ({ profile, params: [slug] }) => tree(profile, slug));
  api.get(new RegExp(`^/api/apps/${SLUG}/file$`), ({ url, profile, params: [slug] }) => readFile(profile, slug, pathOf(url)));
  api.put(new RegExp(`^/api/apps/${SLUG}/file$`), async ({ req, profile, params: [slug] }) => {
    const { path: file, content, version } = await readJson(req, (config.brain.maxEditKB * 1024 + 4096) * 2);
    return writeFile(profile, slug, file, content, version ?? null);
  });
  api.delete(new RegExp(`^/api/apps/${SLUG}/file$`), ({ url, profile, params: [slug] }) => deleteFile(profile, slug, pathOf(url)));

  api.post('/api/app-categories', async ({ req, profile }) => createAppCategory(profile, (await readJson(req)).name));
  api.patch(/^\/api\/app-categories\/([^/]+)$/, async ({ req, profile, params: [id] }) => renameAppCategory(profile, id, (await readJson(req)).name));
  api.post(/^\/api\/app-categories\/([^/]+)\/move$/, async ({ req, profile, params: [id] }) => moveAppCategory(profile, id, await readJson(req)));
  api.delete(/^\/api\/app-categories\/([^/]+)$/, ({ profile, params: [id] }) => { deleteAppCategory(profile, id); return { ok: true }; });

  // /apps/<slug>: signed in, so the cookie says who; on to the app's own address.
  api.get(new RegExp(`^/apps/${SLUG}/?$`), ({ res, profile, params: [slug] }) => {
    res.writeHead(302, { Location: runUrl(profile, slug), 'Cache-Control': 'no-store' });
    res.end();
  });

  // The running app: its files, and its backend under api/. Any method, since forms and
  // fetches from the app reach the backend; the token, not a cookie, is the credential.
  // The sandbox gives the app an opaque origin, so to the browser even its own fetch('api/x')
  // is cross-origin: every answer, errors included, allows any origin to read it (no
  // credentials are involved, and the token is the secret), and preflights are answered.
  const appRoute = new RegExp(`^/apps/${SLUG}/@([0-9a-f]{48})/(.*)$`);
  open.options(appRoute, ({ req, res }) => {
    res.writeHead(204, { 'Access-Control-Allow-Origin': '*', 'Access-Control-Allow-Methods': 'GET, POST, PUT, PATCH, DELETE',
      'Access-Control-Allow-Headers': req.headers['access-control-request-headers'] || 'content-type', 'Access-Control-Max-Age': '600' });
    res.end();
  });
  for (const method of ['get', 'post', 'put', 'patch', 'delete']) {
    open[method](appRoute, async ({ req, res, url, params: [slug, token, rest] }) => {
      res.setHeader('Access-Control-Allow-Origin', '*');
      if (!SLUG_RE.test(slug)) throw new UserError('That app isn\'t in the apps folder.', 404);
      const profile = tokenProfile(token, slug);
      let rel;
      try { rel = rest.split('/').map(decodeURIComponent).join('/'); } catch { throw new UserError('That path isn\'t valid.'); }
      if (rel === 'api' || rel.startsWith('api/')) return runBackend(profile, slug, { req, res, url, rest: rel.slice(4) });
      if (rel.startsWith('brain/')) return appBrain(profile, slug, { req, res, rel: rel.slice(6) });
      if (method !== 'get') throw new UserError('Only the app\'s backend (api/) and brain files (brain/) take requests other than GET.', 405);
      return sendStream(res, appFile(slug, rel));
    });
  }
}
