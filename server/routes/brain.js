// The brain viewer. Every function it calls checks view access and confines the path to the
// brain (brain/resolve.js); these routes only unpack the request.
import { config } from '../core/config.js';
import { UserError } from '../core/errors.js';
import { readJson, sendStream } from '../http/respond.js';
import { listFolder, readFile, writeFile, deletePath, uploadFile, commitUpload } from '../brain/files.js';
import { download, image, video } from '../brain/downloads.js';
import { resolveLinks, findNames } from '../brain/links.js';
import { page, pageProfile } from '../brain/pages.js';

export default function brainRoutes(api, open) {
  const pathOf = (url) => url.searchParams.get('path');

  api.get('/api/brain/tree', ({ url, profile }) => listFolder(profile, pathOf(url)));
  api.get('/api/brain/file', ({ url, profile }) => readFile(profile, pathOf(url)));
  api.put('/api/brain/file', async ({ req, profile }) => {
    const { path: file, content, version } = await readJson(req, (config.brain.maxEditKB * 1024 + 4096) * 2);
    return writeFile(profile, file, content, version);
  });
  // Delete moves to the brain's trash.
  api.delete('/api/brain/file', ({ url, profile }) => deletePath(profile, pathOf(url)));

  // Upload: one raw file per request, then one commit for the batch.
  api.post('/api/brain/upload', ({ req, url, profile }) => {
    const sp = url.searchParams;
    return uploadFile(profile, req, sp.get('dir'), sp.get('path'), sp.get('overwrite') === '1');
  });
  api.post('/api/brain/upload/commit', async ({ req, profile }) => {
    const { paths, dir } = await readJson(req, 4e6);
    return commitUpload(profile, paths, dir);
  });

  // Where Obsidian-style [[links]] in a note point; POST so a long list of names fits.
  api.post('/api/brain/resolve', async ({ req, profile }) => {
    const { from, names } = await readJson(req);
    return resolveLinks(profile, from, names);
  });

  // The search box above the tree: files and folders by name.
  api.get('/api/brain/find', ({ url, profile }) => findNames(profile, url.searchParams.get('q'), url.searchParams.has('fresh')));

  // ?check: what a folder download would hold, so the browser can refuse before downloading.
  api.get('/api/brain/download', ({ res, url, profile }) => {
    if (url.searchParams.has('check')) return download(profile, pathOf(url), { check: true }).summary;
    return sendStream(res, download(profile, pathOf(url)), `Brain download of ${pathOf(url)}`);
  });
  api.get('/api/brain/image', ({ res, url, profile }) => sendStream(res, image(profile, pathOf(url)), `Brain download of ${pathOf(url)}`));
  // Players abort ranges they no longer need (seeking, pausing), so a stopped stream is normal.
  api.get('/api/brain/video', ({ req, res, url, profile }) => sendStream(res, video(profile, pathOf(url), req.headers.range)));

  // An HTML page for the viewer's sandboxed frame, and the files it refers to by relative
  // path. The frame's requests carry no cookie, so the token in the path names the profile
  // instead (brain/pages.js), and access is checked as for any brain route.
  open.get(/^\/api\/brain\/page\/([^/]*)\/(.+)$/, ({ res, params: [token, rest] }) => {
    let target;
    try { target = rest.split('/').map(decodeURIComponent).join('/'); } catch { throw new UserError('That path isn\'t valid.'); }
    return sendStream(res, page(pageProfile(token), target));
  });
}
