// Nova server: static UI, a small JSON API, and one WebSocket per browser tab.
import http from 'node:http';
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { WebSocketServer } from 'ws';
import { config, saveConfig, profileDir, brainKey, BRAIN, CLAUDE_DIR } from './config.js';
import { q } from './db.js';
import { login, logout, profileFrom, cookieHeader, switchTo } from './auth.js';
import { listProfiles, createProfile, updateProfile, deleteProfile, isAdmin, prefsFor, setPicture, removePicture, readPicture, pictureStamp } from './profiles.js';
import { listCategories, createCategory, renameCategory, moveCategory, deleteCategory, categoryIdFor } from './categories.js';
import { UserError } from './errors.js';
import { hub } from './hub.js';
import { meta, publicMeta, signedIn } from './meta.js';
import { signinStatus, startSignin, submitCode, cancelSignin, signOut } from './signin.js';
import { updateStatus, checkLatest, scheduleChecks, startUpdate } from './updates.js';
import { createChat, runnerFor, existingRunner, ownedChat, history, stateOf, PERMISSION_MODES, busyRunners, closeAllRunners, refreshRunners, refreshAllRunners, adoptTranscripts } from './chat.js';
import { listApprovals, forgetApproval, shareApproval, listFolders, addFolder, removeFolder } from './permissions.js';
import { VIEWS, accessFor, can } from './access.js';
import { listFolder, readFile, writeFile, download, image, video, resolveLinks, deletePath, uploadFile, commitUpload } from './brain.js';
import { listTasks, tasksLeftToday, createTask, updateTask, moveTask, deleteTask } from './tasks.js';
import { listNotes, activeNoteCount, createNote, updateNote, moveNote, deleteNote } from './notes.js';
import { saveUpload, discardUpload, openUpload, claimUploads, messageContent, sweepUploads } from './uploads.js';

const root = path.dirname(fileURLToPath(import.meta.url));
const PUBLIC = path.join(root, '..', 'public');
const NODE_MODULES = path.join(root, '..', 'node_modules');
const VENDOR = {
  '/vendor/marked.js': path.join(NODE_MODULES, 'marked', 'lib', 'marked.esm.js'),
  '/vendor/purify.js': path.join(NODE_MODULES, 'dompurify', 'dist', 'purify.es.mjs')
};
const TYPES = { '.html': 'text/html', '.js': 'text/javascript', '.mjs': 'text/javascript', '.css': 'text/css',
  '.json': 'application/json', '.webmanifest': 'application/manifest+json', '.svg': 'image/svg+xml' };
const EFFORTS = ['low', 'medium', 'high', 'xhigh', 'max'];
const VERSION = JSON.parse(fs.readFileSync(path.join(root, '..', 'package.json'), 'utf8')).version; // shown in the header

const securityHeaders = {
  'Content-Security-Policy': "default-src 'self'; style-src 'self' https://fonts.googleapis.com; " +
    "font-src https://fonts.gstatic.com; img-src 'self' data:; connect-src 'self'; frame-ancestors 'none'",
  'X-Content-Type-Options': 'nosniff',
  'Referrer-Policy': 'no-referrer'
};

function send(res, status, body, headers = {}) {
  const isJson = typeof body !== 'string' && !Buffer.isBuffer(body);
  res.writeHead(status, { ...securityHeaders,
    'Content-Type': isJson ? 'application/json' : headers['Content-Type'] || 'text/plain', ...headers });
  res.end(isJson ? JSON.stringify(body) : body);
}

function serveFile(res, file) {
  fs.readFile(file, (err, data) => {
    if (err) return send(res, 404, 'Not found');
    send(res, 200, data, { 'Content-Type': TYPES[path.extname(file)] || 'application/octet-stream',
      'Cache-Control': 'no-cache' });
  });
}

// Refusing on Content-Length before reading leaves the body unread, which Node discards while
// keeping the connection alive. Stopping partway through a read destroys the socket, and the
// client's next request on it fails, so the in-loop checks only catch bodies with no length.
const tooLong = (req, max) => Number(req.headers['content-length']) > max;

async function readJson(req, max = 1e6) {
  const tooMuch = () => new UserError('That\'s too much to send in one request.', 413);
  if (tooLong(req, max)) throw tooMuch();
  let raw = '';
  for await (const chunk of req) { raw += chunk; if (raw.length > max) throw tooMuch(); }
  return raw ? JSON.parse(raw) : {};
}

async function readRaw(req, max) {
  if (tooLong(req, max)) throw new UserError('That file is too big.', 413);
  const chunks = [];
  let size = 0;
  for await (const chunk of req) {
    size += chunk.length;
    if (size > max) throw new UserError('That file is too big.', 413);
    chunks.push(chunk);
  }
  return Buffer.concat(chunks);
}

// server/launcher.js starts this process with NOVA_SUPERVISED=1 and starts it again when
// it exits with RESTART_CODE. Run bare (node server/index.js) there is nothing to restart it.
const SUPERVISED = process.env.NOVA_SUPERVISED === '1';
const RESTART_CODE = 75; // must match server/launcher.js
const BOOT_ID = crypto.randomUUID();

function restartSoon() {
  setTimeout(() => {
    closeAllRunners();
    meta.stop();
    for (const ws of wss.clients) ws.close(1012, 'Restarting'); // 1012 = service restart
    server.close();
    process.exit(RESTART_CODE);
  }, 300); // long enough for the HTTP response to leave
}

// A new brain folder must be a full path to an existing folder the service account can use.
function checkBrainDir(input) {
  const raw = String(input || '').trim();
  if (!raw) return { error: 'Enter the full path of your brain folder.' };
  if (!path.isAbsolute(raw)) return { error: 'Use a full path, starting from the drive or root, e.g. C:\\Notes\\Brain.' };
  const dir = path.resolve(raw);
  let stat;
  try { stat = fs.statSync(dir); } catch { return { error: `${dir} doesn't exist. Create the folder first or check the path.` }; }
  if (!stat.isDirectory()) return { error: `${dir} is a file, not a folder.` };
  try { fs.accessSync(dir, fs.constants.R_OK | fs.constants.W_OK); }
  catch { return { error: `Nova can't read and write ${dir}. Check the folder's permissions for the account running Nova.` }; }
  // Use the folder's real spelling on disk: Claude Code finds transcripts by the working
  // folder's path, so "c:\brain" typed for "C:\Brain" must not look like a different folder.
  const real = fs.realpathSync.native(dir);
  if (brainKey(real) === BRAIN) return { error: 'That\'s already the brain folder.' };
  return { dir: real.split(path.sep).join('/') }; // forward slashes keep config.json readable on Windows
}

// Reject cross-site requests that could ride on the session cookie.
function sameOrigin(req) {
  const origin = req.headers.origin;
  if (!origin) return true;
  try { return new URL(origin).host === req.headers.host; } catch { return false; }
}

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, 'http://x');
  const p = url.pathname;
  const profile = profileFrom(req);

  try {
    if (req.method !== 'GET' && !sameOrigin(req)) return send(res, 403, { error: 'Cross-origin request refused.' });

    // Public routes
    if (p === '/login' || p === '/login.html') return serveFile(res, path.join(PUBLIC, 'login.html'));
    if (VENDOR[p]) return serveFile(res, VENDOR[p]);
    if (['/app.css', '/login.js', '/manifest.webmanifest', '/icon.svg'].includes(p)) return serveFile(res, path.join(PUBLIC, p));
    // Polled by the restart screen. The boot ID is random per process, so a changed ID
    // means the restart has happened, however quickly.
    if (p === '/api/health') return send(res, 200, { ok: true, boot: BOOT_ID }, { 'Cache-Control': 'no-store' });
    if (p === '/api/login' && req.method === 'POST') {
      const { name, password } = await readJson(req);
      const r = login(String(name || '').trim(), String(password || ''));
      if (r.error) return send(res, 401, { error: r.error });
      return send(res, 200, { ok: true }, { 'Set-Cookie': cookieHeader(r.token) });
    }

    // Everything below needs a profile
    if (!profile) {
      if (p.startsWith('/api/')) return send(res, 401, { error: 'Sign in first.' });
      res.writeHead(302, { Location: '/login' });
      return res.end();
    }

    if (p === '/' || p === '/index.html') return serveFile(res, path.join(PUBLIC, 'index.html'));
    if (/^\/(app|render|settings|sidebar|menu|dialog|brain|tasks|notes|presence|avatars|log)\.js$/.test(p)) return serveFile(res, path.join(PUBLIC, p));

    if (p === '/api/logout' && req.method === 'POST') {
      logout(req);
      return send(res, 200, { ok: true }, { 'Set-Cookie': cookieHeader('', true) });
    }
    if (p === '/api/me') {
      const row = q.profile.get(profile);
      return send(res, 200, { profile, role: row.role, version: VERSION, hasPin: !!row.pin_hash, picture: pictureStamp(profile),
        contextDir: profileDir(profile), brainDir: config.paths.brainDir, meta: publicMeta(),
        views: VIEWS.map(({ id, label }) => ({ id, label })), access: accessFor(profile), prefs: prefsFor(row),
        uploads: { maxMB: config.uploads.maxMB, maxFiles: config.uploads.maxFiles, brainMaxMB: config.brain.maxUploadMB } });
    }

    // Profiles: everyone can list (to switch) and edit themselves; admins manage all.
    if (p === '/api/profiles' && req.method === 'GET') return send(res, 200, listProfiles(profile));
    if (p === '/api/profiles' && req.method === 'POST') {
      if (!isAdmin(profile)) return send(res, 403, { error: 'Only an admin can add profiles.' });
      const name = createProfile(await readJson(req));
      return send(res, 200, { ok: true, name });
    }
    const profileMatch = p.match(/^\/api\/profiles\/([A-Za-z0-9-]{2,32})$/);
    if (profileMatch && req.method === 'PATCH') {
      const name = updateProfile(profile, profileMatch[1], await readJson(req));
      return send(res, 200, { ok: true, name });
    }
    if (profileMatch && req.method === 'DELETE') {
      deleteProfile(profile, profileMatch[1]);
      return send(res, 200, { ok: true });
    }
    // Profile pictures: every signed-in profile sees them (the switcher shows everyone), and
    // only the profile itself or an admin changes one. URLs carry ?v=updated_at, so cache long.
    const pictureMatch = p.match(/^\/api\/profiles\/([A-Za-z0-9-]{2,32})\/picture$/);
    if (pictureMatch && req.method === 'GET') {
      const pic = readPicture(pictureMatch[1]);
      if (!pic) return send(res, 404, { error: 'This profile has no picture.' });
      return send(res, 200, Buffer.from(pic.data), { 'Content-Type': pic.type, 'Cache-Control': 'private, max-age=31536000, immutable' });
    }
    if (pictureMatch && req.method === 'POST') {
      return send(res, 200, { picture: setPicture(profile, pictureMatch[1], await readRaw(req, 512 * 1024 + 1)) });
    }
    if (pictureMatch && req.method === 'DELETE') {
      removePicture(profile, pictureMatch[1]);
      return send(res, 200, { picture: null });
    }
    if (p === '/api/switch' && req.method === 'POST') {
      const { name, pin, password } = await readJson(req);
      const target = String(name || '').trim();
      if (target.toLowerCase() === profile.toLowerCase()) return send(res, 200, { ok: true });
      const r = switchTo(target, { pin, password });
      if (r.error) return send(res, 401, { error: r.error });
      logout(req); // the old session ends; this tab now belongs to the new profile
      return send(res, 200, { ok: true }, { 'Set-Cookie': cookieHeader(r.token) });
    }
    if (p === '/api/chats' && req.method === 'GET') {
      return send(res, 200, q.chats.all(profile).map((c) => ({ ...c, state: stateOf(c.id) })));
    }
    const chatMatch = p.match(/^\/api\/chats\/([0-9a-f-]{36})$/);
    if (chatMatch) {
      const id = chatMatch[1];
      const chat = ownedChat(profile, id);
      if (!chat) return send(res, 404, { error: 'Chat not found.' });
      if (req.method === 'PATCH') {
        const body = await readJson(req);
        // Validate both before changing either.
        let title = null;
        if ('title' in body) {
          title = String(body.title || '').replace(/\s+/g, ' ').trim().slice(0, 120);
          if (!title) return send(res, 400, { error: 'Give the chat a name.' });
          // A null title marks a chat that has never been sent to, so it can't be renamed yet.
          if (chat.title === null) return send(res, 409, { error: 'Send a message in this chat first, then rename it.' });
        }
        const categoryId = 'categoryId' in body ? categoryIdFor(profile, body.categoryId) : undefined;
        if (title) q.renameChat.run(title, id, profile);
        if (categoryId !== undefined) q.setChatCategory.run(categoryId, id, profile);
        hub.toProfile(profile, { t: 'chats_changed' });
        return send(res, 200, { ok: true });
      }
      if (req.method === 'DELETE') {
        existingRunner(profile, id)?.close();
        q.deleteChat.run(id, profile); // transcript file stays on disk, just unlisted
        hub.toProfile(profile, { t: 'chats_changed', deleted: id });
        return send(res, 200, { ok: true });
      }
    }

    // Categories belong to the signed-in profile only.
    if (p === '/api/categories' && req.method === 'GET') return send(res, 200, listCategories(profile));
    if (p === '/api/categories' && req.method === 'POST') {
      const category = createCategory(profile, (await readJson(req)).name);
      hub.toProfile(profile, { t: 'chats_changed' });
      return send(res, 200, category);
    }
    const categoryMatch = p.match(/^\/api\/categories\/([0-9a-f-]{36})$/);
    if (categoryMatch && req.method === 'PATCH') {
      const category = renameCategory(profile, categoryMatch[1], (await readJson(req)).name);
      hub.toProfile(profile, { t: 'chats_changed' });
      return send(res, 200, category);
    }
    const categoryMove = p.match(/^\/api\/categories\/([0-9a-f-]{36})\/move$/);
    if (categoryMove && req.method === 'POST') {
      const list = moveCategory(profile, categoryMove[1], { beforeId: (await readJson(req)).beforeId ?? null });
      hub.toProfile(profile, { t: 'chats_changed' });
      return send(res, 200, list);
    }
    if (categoryMatch && req.method === 'DELETE') {
      deleteCategory(profile, categoryMatch[1]);
      hub.toProfile(profile, { t: 'chats_changed' });
      return send(res, 200, { ok: true });
    }
    // Chat attachments: the body is the raw file, the name is in the query.
    if (p === '/api/uploads' && req.method === 'POST') return send(res, 200, await saveUpload(profile, req, url.searchParams.get('name')));
    const uploadMatch = p.match(/^\/api\/uploads\/([0-9a-f-]{36})$/);
    if (uploadMatch && req.method === 'DELETE') { discardUpload(profile, uploadMatch[1]); return send(res, 200, { ok: true }); }
    if (uploadMatch && req.method === 'GET') {
      const out = openUpload(profile, uploadMatch[1]);
      res.writeHead(200, { ...securityHeaders, ...out.headers });
      try { await out.write(res); } catch (err) { console.error('Attachment download stopped:', err.message); res.destroy(); }
      return;
    }

    // Brain viewer. Each function checks view access and confines the path.
    if (p === '/api/brain/tree' && req.method === 'GET') return send(res, 200, listFolder(profile, url.searchParams.get('path')));
    if (p === '/api/brain/file' && req.method === 'GET') return send(res, 200, readFile(profile, url.searchParams.get('path')));
    // Delete (to the brain's trash) and upload. Upload's body is the raw file.
    if (p === '/api/brain/file' && req.method === 'DELETE') return send(res, 200, await deletePath(profile, url.searchParams.get('path')));
    if (p === '/api/brain/upload' && req.method === 'POST') {
      const sp = url.searchParams;
      return send(res, 200, await uploadFile(profile, req, sp.get('dir'), sp.get('path'), sp.get('overwrite') === '1'));
    }
    if (p === '/api/brain/upload/commit' && req.method === 'POST') {
      const { paths, dir } = await readJson(req, 4e6);
      return send(res, 200, await commitUpload(profile, paths, dir));
    }
    // Where Obsidian-style [[links]] in a note point; POST so a long list of names fits.
    if (p === '/api/brain/resolve' && req.method === 'POST') {
      const { from, names } = await readJson(req);
      return send(res, 200, resolveLinks(profile, from, names));
    }
    if (p === '/api/brain/file' && req.method === 'PUT') {
      const { path: file, content, version } = await readJson(req, (config.brain.maxEditKB * 1024 + 4096) * 2);
      return send(res, 200, await writeFile(profile, file, content, version));
    }
    if ((p === '/api/brain/download' || p === '/api/brain/image') && req.method === 'GET') {
      const target = url.searchParams.get('path');
      if (p === '/api/brain/download' && url.searchParams.has('check')) return send(res, 200, download(profile, target, { check: true }).summary);
      const out = p === '/api/brain/image' ? image(profile, target) : download(profile, target);
      res.writeHead(200, { ...securityHeaders, ...out.headers });
      try { await out.write(res); } catch (err) { console.error(`Brain download of ${target} stopped:`, err.message); res.destroy(); }
      return;
    }
    if (p === '/api/brain/video' && req.method === 'GET') {
      const target = url.searchParams.get('path');
      const out = video(profile, target, req.headers.range);
      res.writeHead(out.status, { ...securityHeaders, ...out.headers });
      // Players abort ranges they no longer need (seeking, pausing), so a stopped stream is normal.
      try { await out.write(res); } catch { res.destroy(); }
      return;
    }

    // Tasks and notes. Each function checks view access and that
    // the row belongs to this profile. Changes tell the profile's other tabs to refresh;
    // X-Nova-Tab names the tab that made the change so it can skip its own echo.
    const tab = String(req.headers['x-nova-tab'] || '').slice(0, 64);
    const changed = (t) => hub.toProfile(profile, { t, from: tab });
    if (p === '/api/tasks' && req.method === 'GET') return send(res, 200, listTasks(profile, url.searchParams.get('today')));
    // Counts for the view tabs, only for views this profile can read. today is the browser's date.
    if (p === '/api/badges' && req.method === 'GET') {
      const out = {};
      if (can(profile, 'tasks', 'read')) out.tasks = tasksLeftToday(profile, url.searchParams.get('today'));
      if (can(profile, 'notes', 'read')) out.notes = activeNoteCount(profile);
      return send(res, 200, out);
    }
    if (p === '/api/tasks' && req.method === 'POST') {
      const task = createTask(profile, await readJson(req));
      changed('tasks_changed');
      return send(res, 200, task);
    }
    const taskMatch = p.match(/^\/api\/tasks\/([0-9a-f-]{36})(\/move)?$/);
    if (taskMatch) {
      const [, id, move] = taskMatch;
      let out;
      if (move && req.method === 'POST') out = moveTask(profile, id, await readJson(req));
      else if (!move && req.method === 'PATCH') out = updateTask(profile, id, await readJson(req));
      else if (!move && req.method === 'DELETE') out = deleteTask(profile, id);
      if (out) { changed('tasks_changed'); return send(res, 200, out); }
    }
    if (p === '/api/notes' && req.method === 'GET') return send(res, 200, listNotes(profile));
    if (p === '/api/notes' && req.method === 'POST') {
      const note = createNote(profile, await readJson(req));
      changed('notes_changed');
      return send(res, 200, note);
    }
    const noteMatch = p.match(/^\/api\/notes\/([0-9a-f-]{36})(\/move)?$/);
    if (noteMatch) {
      const [, id, move] = noteMatch;
      let out;
      if (move && req.method === 'POST') out = moveNote(profile, id, await readJson(req));
      else if (!move && req.method === 'PATCH') out = updateNote(profile, id, await readJson(req));
      else if (!move && req.method === 'DELETE') { deleteNote(profile, id); out = { ok: true }; }
      if (out) { changed('notes_changed'); return send(res, 200, out); }
    }

    // Remembered approvals and extra folders: each profile manages only its own.
    if (p === '/api/approvals' && req.method === 'GET') return send(res, 200, listApprovals(profile));
    if (p === '/api/approvals' && req.method === 'DELETE') {
      const { tool, rule } = await readJson(req);
      forgetApproval(profile, tool, rule);
      refreshRunners(profile); // chats that already added the rule to their session drop it
      return send(res, 200, listApprovals(profile));
    }
    if (p === '/api/approvals/share' && req.method === 'POST') {
      // The shared settings file applies to every profile, so this is a global setting.
      if (!isAdmin(profile)) return send(res, 403, { error: 'Only an admin can share a rule with every profile.' });
      const { tool, rule } = await readJson(req);
      const shared = shareApproval(profile, tool, rule);
      return send(res, 200, { ...shared, approvals: listApprovals(profile) });
    }
    if (p === '/api/folders' && req.method === 'GET') return send(res, 200, listFolders(profile));
    if (p === '/api/folders' && req.method === 'POST') {
      const dir = addFolder(profile, (await readJson(req)).path);
      refreshRunners(profile);
      return send(res, 200, { path: dir, folders: listFolders(profile) });
    }
    if (p === '/api/folders' && req.method === 'DELETE') {
      removeFolder(profile, (await readJson(req)).path);
      refreshRunners(profile);
      return send(res, 200, listFolders(profile));
    }

    // Global settings are admin-only.
    if (p.startsWith('/api/settings') && !isAdmin(profile)) return send(res, 403, { error: 'Only an admin can change global settings.' });
    if (p === '/api/settings/brain' && req.method === 'POST') {
      const { brainDir } = await readJson(req);
      const checked = checkBrainDir(brainDir);
      if (checked.error) return send(res, 400, { error: checked.error });
      if (!SUPERVISED) {
        return send(res, 409, { error: 'Nova can only restart itself when started with npm start (or the service set up in the README). ' +
          'Nothing was saved. Change paths.brainDir in data/config.json and restart Nova by hand instead.' });
      }
      const busy = busyRunners().length;
      if (busy) {
        return send(res, 409, { error: `${busy === 1 ? 'A chat is' : `${busy} chats are`} still working or waiting for an answer. ` +
          'Stop them or let them finish, then change the brain folder.' });
      }
      saveConfig('paths', { brainDir: checked.dir });
      console.log(`Brain folder changed to ${checked.dir} by ${profile}; restarting.`);
      send(res, 200, { ok: true, restarting: true, boot: BOOT_ID });
      hub.toAll({ t: 'restarting', reason: 'The brain folder changed.', boot: BOOT_ID });
      restartSoon();
      return;
    }
    // Agent SDK updates: checked on a timer, installed only when an admin asks.
    if (p === '/api/settings/sdk' && req.method === 'GET') return send(res, 200, { ...updateStatus(), canRestart: SUPERVISED });
    if (p === '/api/settings/sdk' && req.method === 'POST') {
      const hours = Number((await readJson(req)).checkHours);
      if (!Number.isInteger(hours) || hours < 0 || hours > 24 * 30) return send(res, 400, { error: 'Check every 1 to 720 hours, or 0 to stop checking.' });
      saveConfig('updates', { checkHours: hours });
      scheduleChecks();
      return send(res, 200, { ...updateStatus(), canRestart: SUPERVISED });
    }
    if (p === '/api/settings/sdk/check' && req.method === 'POST') {
      await checkLatest();
      return send(res, 200, { ...updateStatus(), canRestart: SUPERVISED });
    }
    if (p === '/api/settings/sdk/update' && req.method === 'POST') {
      if (!SUPERVISED) {
        return send(res, 409, { error: 'Nova can only update the SDK when started with npm start (or the service set up in the README), ' +
          'because it has to restart. Stop Nova, run npm install @anthropic-ai/claude-agent-sdk@<version> --save-exact, and start it again.' });
      }
      startUpdate(profile, String((await readJson(req)).version || ''), (version) => {
        console.log(`Restarting to install Agent SDK ${version}.`);
        hub.toAll({ t: 'restarting', reason: `Updating the Claude Agent SDK to ${version}.`, boot: BOOT_ID });
        restartSoon();
      });
      return send(res, 202, { ...updateStatus(), canRestart: SUPERVISED, boot: BOOT_ID });
    }
    if (p === '/api/settings' && req.method === 'POST') {
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
      return send(res, 200, { ok: true });
    }
    if (p === '/api/settings' && req.method === 'GET') {
      return send(res, 200, { ...publicMeta(), idleMinutes: config.chats.idleMinutes, showThinking: config.models.showThinking,
        brainDir: config.paths.brainDir, canRestart: SUPERVISED, claudeDir: CLAUDE_DIR, signin: signinStatus() });
    }
    // Claude sign-in through the bundled Claude Code. Nova relays a link and a code, never a token.
    if (p === '/api/settings/signin' && req.method === 'POST') {
      const r = await startSignin(String((await readJson(req)).method || ''));
      console.log(`Claude sign-in (${r.method}) started by ${profile}.`);
      return send(res, 200, r);
    }
    if (p === '/api/settings/signin' && req.method === 'DELETE') { cancelSignin(); return send(res, 200, { ok: true }); }
    if (p === '/api/settings/signin/code' && req.method === 'POST') {
      await submitCode((await readJson(req)).code);
      console.log(`Claude sign-in finished by ${profile}.`);
      await meta.restart();
      refreshAllRunners(); // chats started under the old sign-in pick up the new one when quiet
      return send(res, 200, publicMeta());
    }
    if (p === '/api/settings/signout' && req.method === 'POST') {
      await signOut();
      console.log(`Claude signed out by ${profile}.`);
      await meta.restart();
      refreshAllRunners();
      return send(res, 200, publicMeta());
    }
    return send(res, 404, { error: 'Not found.' });
  } catch (err) {
    if (err instanceof UserError) return send(res, err.status, { error: err.message });
    console.error(err);
    return send(res, 500, { error: err.message });
  }
});

// WebSocket: authenticated by the same cookie, origin-checked to stop cross-site hijacking.
const wss = new WebSocketServer({ noServer: true, maxPayload: 2 * 1024 * 1024 });
server.on('upgrade', (req, socket, head) => {
  const profile = profileFrom(req);
  if (!profile || !sameOrigin(req) || new URL(req.url, 'http://x').pathname !== '/ws') {
    socket.write('HTTP/1.1 401 Unauthorized\r\n\r\n');
    return socket.destroy();
  }
  wss.handleUpgrade(req, socket, head, (ws) => {
    hub.add(profile, ws);
    ws.send(JSON.stringify({ t: 'meta', meta: publicMeta() }));
    ws.on('message', (raw) => handle(profile, ws, raw).catch((err) =>
      ws.send(JSON.stringify({ t: 'error', message: err.message }))));
  });
});

async function handle(profile, ws, raw) {
  const m = JSON.parse(raw);
  const reply = (payload) => ws.send(JSON.stringify(payload));
  const effort = EFFORTS.includes(m.effort) ? m.effort : undefined;
  const model = typeof m.model === 'string' && m.model ? m.model : undefined;
  const mode = PERMISSION_MODES.includes(m.mode) ? m.mode : undefined;

  switch (m.t) {
    case 'new': {
      const id = createChat(profile, { model, effort, categoryId: categoryIdFor(profile, m.categoryId) });
      return reply({ t: 'created', chatId: id });
    }
    case 'open': {
      const msgs = await history(profile, m.chatId);
      if (msgs === null) return reply({ t: 'error', message: 'Chat not found.' });
      reply({ t: 'history', chatId: m.chatId, messages: msgs, state: stateOf(m.chatId) });
      const runner = existingRunner(profile, m.chatId);
      for (const p of runner?.pendingRequests() || []) reply(p);
      for (const t of runner?.runningTasks() || []) reply(t);
      return;
    }
    case 'send': {
      const text = String(m.text || '').trim();
      const row = ownedChat(profile, m.chatId);
      if (!row) return reply({ t: 'error', message: 'Chat not found.' });
      let files;
      try { files = claimUploads(profile, m.attachments); }
      catch (err) { return reply({ t: 'error', chatId: m.chatId, message: err.message }); }
      if (!text && !files.length) return;
      if (signedIn() === false) {
        return reply({ t: 'error', chatId: m.chatId, message: isAdmin(profile)
          ? 'Nova isn\'t signed in to Claude. Sign in from Settings, Claude, then send again.'
          : 'Nova isn\'t signed in to Claude. Ask an admin to sign in from Settings, then send again.' });
      }
      const runner = runnerFor(profile, m.chatId, { model, effort, mode });
      if (runner.state === 'running') return reply({ t: 'error', chatId: m.chatId, message: 'Claude is still responding. Stop it or wait before sending.' });
      if (mode && runner.mode !== mode) await runner.setMode(mode);
      else if (mode && row.permission_mode !== mode) q.setChatMode.run(mode, m.chatId, profile);
      runner.send(messageContent(profile, m.chatId, text, files));
      if (!row.title) {
        const title = text || `Files: ${files.map((f) => f.name).join(', ')}`;
        q.renameChat.run(title.replace(/\s+/g, ' ').slice(0, 80), m.chatId, profile);
        hub.toProfile(profile, { t: 'chats_changed' });
      }
      hub.toProfile(profile, { t: 'user_echo', chatId: m.chatId, text, attachments: files.map(({ id, name, size, type }) => ({ id, name, size, type })), from: m.clientId });
      return;
    }
    case 'answer': {
      existingRunner(profile, m.chatId)?.answer(m.reqId, m.result || { behavior: 'deny' });
      return;
    }
    case 'mode': {
      if (!ownedChat(profile, m.chatId)) return reply({ t: 'error', message: 'Chat not found.' });
      if (!mode) return reply({ t: 'error', chatId: m.chatId, message: 'That permission mode isn\'t available in Nova.' });
      const runner = existingRunner(profile, m.chatId);
      if (runner && runner.state !== 'closed') return runner.setMode(mode);
      q.setChatMode.run(mode, m.chatId, profile); // applied when the chat next starts
      hub.toProfile(profile, { t: 'mode', chatId: m.chatId, mode });
      return;
    }
    case 'interrupt': {
      await existingRunner(profile, m.chatId)?.interrupt();
      return;
    }
  }
}

server.listen(config.server.port, config.server.host, () => {
  console.log(`Nova (${config.server.mode}) on http://${config.server.host}:${config.server.port}`);
  console.log(`Brain: ${config.paths.brainDir}`);
  adoptTranscripts();
  meta.start().catch((err) => console.error('Meta session failed to start:', err.message));
  sweepUploads();
  scheduleChecks();
});
