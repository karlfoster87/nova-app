// The Apps view's list: every folder in the apps folder is an app, named by its slug (the
// folder name, which is also its address, /apps/<slug>). Apps are shared by every profile,
// like the brain: Apps access decides who may run them (read) and change them (edit). The
// database adds what a folder can't say: its category and whether an admin let its backend
// run. Rows follow the folders, so an app Nova writes in a chat appears on the next listing.
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { config } from '../core/config.js';
import { q, transaction, reorder } from '../core/db.js';
import { hub } from '../core/hub.js';
import { UserError } from '../core/errors.js';
import { readJsonFile, isLocked } from '../core/files.js';
import { renamePath } from '../core/paths.js';
import { requireView } from '../accounts/access.js';
import { isAdmin } from '../accounts/profiles.js';

// Lower-case letters, digits and single hyphens, as the address needs. Up to 64 characters.
export const SLUG_RE = /^[a-z0-9](?:[a-z0-9]|-(?=[a-z0-9])){0,63}$/;
const TRASH = '.trash';

export function appsRoot() {
  const dir = config.paths.appsDir;
  fs.mkdirSync(dir, { recursive: true });
  return dir;
}

// An existing app's folder, or a 404 that says so.
export function appDir(slug) {
  slug = String(slug || '');
  if (!SLUG_RE.test(slug)) throw new UserError('That app isn\'t in the apps folder.', 404);
  const dir = path.join(appsRoot(), slug);
  let st;
  try { st = fs.lstatSync(dir); } catch { st = null; }
  if (!st?.isDirectory()) throw new UserError('That app isn\'t in the apps folder.', 404);
  return dir;
}

// What app.json says about an app: its title, a description and whether it has a backend.
export const manifestOf = (dir) => readJsonFile(path.join(dir, 'app.json')) || {};
export const hasBackend = (dir) => fs.existsSync(path.join(dir, 'backend.js'));

const changed = () => hub.toAll({ t: 'apps_changed' });

// Windows briefly locks files that were just written or are being scanned, which makes a folder
// rename fail, so it's tried a few times before giving up with a message that says why.
export async function moveFolder(from, to, what) {
  for (let attempt = 0; ; attempt++) {
    try { return renamePath(from, to); } catch (err) {
      if (attempt < 6 && isLocked(err)) { await new Promise((r) => setTimeout(r, 250)); continue; }
      if (isLocked(err)) throw new UserError(`Couldn't ${what}: a file in it is open in another program. Close it and try again.`, 409);
      throw err;
    }
  }
}

// Folders whose names can't be an address (spaces, capitals) still list, so they can be renamed.
function folders() {
  return fs.readdirSync(appsRoot(), { withFileTypes: true })
    .filter((d) => d.isDirectory() && !d.name.startsWith('.'))
    .map((d) => d.name);
}

export function listApps(profile) {
  requireView(profile, 'apps', 'read');
  const names = folders();
  const rows = new Map(q.apps.all().map((r) => [r.slug.toLowerCase(), r]));
  const now = Date.now();
  const out = [];
  for (const name of names) {
    const dir = path.join(appsRoot(), name);
    const valid = SLUG_RE.test(name);
    let row = valid ? rows.get(name) : null;
    if (valid && !row) { q.addApp.run(name, null, now); row = { slug: name, category_id: null, backend: 0 }; }
    const m = manifestOf(dir);
    let updatedAt = 0;
    try { updatedAt = fs.statSync(dir).mtimeMs; } catch {}
    out.push({
      slug: name, valid, title: typeof m.name === 'string' ? m.name.slice(0, 80) : '',
      description: typeof m.description === 'string' ? m.description.slice(0, 300) : '',
      categoryId: row?.category_id || null, hasBackend: hasBackend(dir), backend: !!row?.backend, updatedAt
    });
  }
  // Rows whose folder has gone (deleted outside Nova) are dropped.
  const present = new Set(names.map((n) => n.toLowerCase()));
  for (const key of rows.keys()) if (!present.has(key)) q.deleteApp.run(key);
  out.sort((a, b) => a.slug.localeCompare(b.slug));
  return { apps: out, categories: q.appCategories.all(), canEdit: can(profile, 'edit'), isAdmin: isAdmin(profile) };
}

function can(profile, level) {
  try { requireView(profile, 'apps', level); return true; } catch { return false; }
}

// A new app from a name: "Budget Planner" becomes budget-planner, with a starting page.
export function slugFrom(name) {
  return String(name || '').toLowerCase().normalize('NFKD').replace(/[̀-ͯ]/g, '')
    .replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 64).replace(/-+$/, '');
}

function cleanSlug(input) {
  const slug = String(input || '').trim();
  if (!slug) throw new UserError('Give the app a name.');
  if (!SLUG_RE.test(slug)) throw new UserError('Use lower-case letters, numbers and single hyphens, like budget-planner. The name is the app\'s address.');
  return slug;
}

function taken(slug) {
  return folders().some((n) => n.toLowerCase() === slug.toLowerCase());
}

const STARTER = (title) => `<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <title>${title.replace(/[<&]/g, '')}</title>
  <link rel="stylesheet" href="style.css">
</head>
<body>
  <main>
    <h1>${title.replace(/[<&]/g, '')}</h1>
    <p>A new app. Ask Nova to build it, or edit these files.</p>
  </main>
  <script src="app.js"></script>
</body>
</html>
`;

export function createApp(profile, { name, categoryId = null } = {}) {
  requireView(profile, 'apps', 'edit');
  const title = String(name || '').replace(/\s+/g, ' ').trim().slice(0, 80);
  const slug = cleanSlug(SLUG_RE.test(title) ? title : slugFrom(title));
  if (taken(slug)) throw new UserError(`There's already an app called ${slug}.`, 409);
  const category = appCategoryId(categoryId);
  const dir = path.join(appsRoot(), slug);
  fs.mkdirSync(dir);
  fs.writeFileSync(path.join(dir, 'app.json'), `${JSON.stringify({ name: title || slug, description: '' }, null, 2)}\n`);
  fs.writeFileSync(path.join(dir, 'index.html'), STARTER(title || slug));
  fs.writeFileSync(path.join(dir, 'style.css'), 'body { font-family: system-ui, sans-serif; margin: 2rem; }\n');
  fs.writeFileSync(path.join(dir, 'app.js'), '// The app\'s script.\n');
  q.addApp.run(slug, category, Date.now());
  console.log(`${profile} created the app ${slug}.`);
  changed();
  return { slug };
}

// Renames the folder, which changes the app's address. A folder whose name isn't a valid
// address can be renamed to one.
export async function renameApp(profile, from, to) {
  requireView(profile, 'apps', 'edit');
  from = String(from || '');
  const dir = path.join(appsRoot(), from);
  if (from.startsWith('.') || from.includes('/') || from.includes('\\') || !folders().includes(from)) throw new UserError('That app isn\'t in the apps folder.', 404);
  const slug = cleanSlug(to);
  if (slug === from) return { slug };
  if (slug.toLowerCase() !== from.toLowerCase() && taken(slug)) throw new UserError(`There's already an app called ${slug}.`, 409);
  await moveFolder(dir, path.join(appsRoot(), slug), 'rename the app');
  transaction(() => {
    if (q.app.get(from)) q.renameApp.run(slug, from); else q.addApp.run(slug, null, Date.now());
  });
  console.log(`${profile} renamed the app ${from} to ${slug}.`);
  changed();
  return { slug };
}

// Deleting moves the folder to the apps folder's .trash, where it can be restored by hand.
export async function deleteApp(profile, slug) {
  requireView(profile, 'apps', 'edit');
  slug = String(slug || '');
  if (slug.startsWith('.') || !folders().includes(slug)) throw new UserError('That app isn\'t in the apps folder.', 404);
  const trash = path.join(appsRoot(), TRASH);
  fs.mkdirSync(trash, { recursive: true });
  const stamp = new Date().toISOString().replace(/[:.]/g, '-');
  await moveFolder(path.join(appsRoot(), slug), path.join(trash, `${slug}-${stamp}`), 'delete the app');
  q.deleteApp.run(slug);
  console.log(`${profile} deleted the app ${slug}.`);
  changed();
  return { trashedTo: `${TRASH}/${slug}-${stamp}` };
}

export function moveApp(profile, slug, categoryId) {
  requireView(profile, 'apps', 'edit');
  appDir(slug);
  const category = appCategoryId(categoryId);
  q.addApp.run(slug, null, Date.now());
  q.setAppCategory.run(category, slug);
  changed();
  return { slug, categoryId: category };
}

// Only an admin may let an app's backend run: it's a program on the server, written by whoever
// can edit the app, Nova included.
export function setBackend(profile, slug, on) {
  requireView(profile, 'apps', 'read');
  if (!isAdmin(profile)) throw new UserError('Only an admin can turn an app\'s backend on or off.', 403);
  appDir(slug);
  q.addApp.run(slug, null, Date.now());
  q.setAppBackend.run(on ? 1 : 0, slug);
  console.log(`${profile} turned the backend of ${slug} ${on ? 'on' : 'off'}.`);
  changed();
  return { slug, backend: !!on };
}

export const backendAllowed = (slug) => !!q.app.get(slug)?.backend;

// ---- Categories -------------------------------------------------------------------
// One shared set, ordered by hand; deleting one leaves its apps uncategorised.

function appCategoryId(id) {
  if (id == null || id === '') return null;
  if (!q.appCategory.get(String(id))) throw new UserError('Category not found.', 404);
  return String(id);
}

function cleanCategoryName(name, exceptId = null) {
  name = String(name || '').replace(/\s+/g, ' ').trim();
  if (!name) throw new UserError('Give the category a name.');
  if (name.length > 60) throw new UserError('Keep category names to 60 characters or fewer.');
  const clash = q.appCategoryByName.get(name);
  if (clash && clash.id !== exceptId) throw new UserError(`There's already a category called "${clash.name}".`, 409);
  return name;
}

export function createAppCategory(profile, name) {
  requireView(profile, 'apps', 'edit');
  name = cleanCategoryName(name);
  const id = crypto.randomUUID();
  q.addAppCategory.run(id, name, q.nextAppCategoryPosition.get().n, Date.now());
  changed();
  return { id, name };
}

export function renameAppCategory(profile, id, name) {
  requireView(profile, 'apps', 'edit');
  if (!q.appCategory.get(String(id))) throw new UserError('Category not found.', 404);
  name = cleanCategoryName(name, id);
  q.renameAppCategory.run(name, id);
  changed();
  return { id, name };
}

export function moveAppCategory(profile, id, { beforeId = null } = {}) {
  requireView(profile, 'apps', 'edit');
  if (!q.appCategory.get(String(id))) throw new UserError('Category not found.', 404);
  if (beforeId != null && (beforeId === id || !q.appCategory.get(String(beforeId)))) throw new UserError('Category not found.', 404);
  transaction(() => reorder(q.appCategories.all().map((c) => c.id), id, beforeId, (i, c) => q.setAppCategoryPosition.run(i, c)));
  changed();
  return q.appCategories.all();
}

export function deleteAppCategory(profile, id) {
  requireView(profile, 'apps', 'edit');
  if (!q.appCategory.get(String(id))) throw new UserError('Category not found.', 404);
  transaction(() => { q.uncategoriseApps.run(id); q.deleteAppCategory.run(id); });
  changed();
}
