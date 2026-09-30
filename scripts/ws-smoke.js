// Usage: npm run smoke
// WebSocket and HTTP smoke test. Starts its own Nova on a spare port with a
// throwaway data folder and two throwaway profiles, so it never touches data/ or a running
// Nova. It sends no prompt, so it uses no quota. It checks sign-in, the same-origin rules,
// that one profile can't see or act on another profile's chat, folders or approvals, and
// the brain viewer's access levels, path confinement, saving and downloads.
import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import net from 'node:net';
import path from 'node:path';
import { spawn, execFileSync } from 'node:child_process';
import WebSocket from 'ws';

const PASSWORD = 'smoke-test-password';
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'nova-smoke-'));
const port = await new Promise((resolve) => {
  const s = net.createServer().listen(0, '127.0.0.1', () => { const p = s.address().port; s.close(() => resolve(p)); });
});
const base = `http://127.0.0.1:${port}`;
fs.writeFileSync(path.join(tmp, 'config.json'), JSON.stringify({
  server: { mode: 'local', port }, paths: { brainDir: path.join(tmp, 'brain') }, updates: { checkHours: 0 }, uploads: { maxMB: 1 }
}));

// Profiles go straight into the throwaway database. db.js reads NOVA_DATA_DIR on import.
process.env.NOVA_DATA_DIR = tmp;
const { q, db } = await import('../server/db.js');
const { hashSecret } = await import('../server/auth.js');
q.addProfile.run('smoke-a', hashSecret(PASSWORD), Date.now(), 'admin', null);
q.addProfile.run('smoke-b', hashSecret(PASSWORD), Date.now(), 'user', null);
q.addProfile.run('smoke-c', hashSecret(PASSWORD), Date.now(), 'user', null);
// A remembered approval, as if smoke-a had pressed Always allow (that needs a real prompt).
q.addApproval.run('smoke-a', 'Bash', 'npm test:*', Date.now());
q.addApproval.run('smoke-c', 'Bash', 'ls:*', Date.now());
q.setAccess.run(JSON.stringify({ brain: 'none' }), 'smoke-c'); // smoke-b keeps the default, read
// A chat from before Nova had its own Claude folder, in another brain so it stays
// out of the lists checked below. Its transcript sits in an "old" Claude folder beside an
// unrelated one, which must not be copied.
const OLD_CHAT = crypto.randomUUID(), STRANGER = crypto.randomUUID();
db.prepare("INSERT INTO chats (id, profile, title, created_at, updated_at, brain) VALUES (?, 'smoke-a', 'old', 0, 0, 'smoke-other-brain')").run(OLD_CHAT);
db.close();
const oldClaude = path.join(tmp, 'old-claude');
const oldProject = path.join(oldClaude, 'projects', 'C--old-brain');
fs.mkdirSync(path.join(oldProject, OLD_CHAT, 'subagents'), { recursive: true });
fs.writeFileSync(path.join(oldProject, `${OLD_CHAT}.jsonl`), '{}\n');
fs.writeFileSync(path.join(oldProject, OLD_CHAT, 'subagents', 'agent-1.jsonl'), '{}\n');
fs.writeFileSync(path.join(oldProject, `${STRANGER}.jsonl`), '{}\n');
const extra = path.join(tmp, 'extra');
fs.mkdirSync(extra);
fs.writeFileSync(path.join(extra, 'outside.md'), 'outside the brain\n');

// A small brain with the cases the viewer must handle.
const brainDir = path.join(tmp, 'brain');
const put = (rel, data) => { fs.mkdirSync(path.dirname(path.join(brainDir, rel)), { recursive: true }); fs.writeFileSync(path.join(brainDir, rel), data); };
put('notes/a.md', '# Hello\n\nFirst version.\n');
put('notes/crlf.md', 'line one\r\nline two\r\n');
put('.claude/settings.json', '{}\n');
put('node_modules/pkg/readme.md', 'hidden\n');
put('.obsidian/app.json', '{}\n');
put('profiles/smoke-a/mine.md', 'a\n');
put('profiles/smoke-b/mine.md', 'b\n');
put('bin/data.bin', Buffer.from([0, 1, 2, 3]));
// For [[link]] resolution: two notes with the same name, and an image.
put('Clients/Acme/brief.md', '# Acme\n');
put('Other/brief.md', '# Other\n');
put('img/logo.png', Buffer.from([0x89, 0x50, 0x4e, 0x47]));
put('media/clip.mp4', '0123456789'); // ten bytes, enough to check byte ranges
put('node_modules/pkg/clip.webm', 'hidden');
// An HTML page with its stylesheet, for the rendered-page route.
put('site/report.html', '<!doctype html><link rel=stylesheet href=style.css><img src=../img/logo.png><p>Réport</p>');
put('site/style.css', 'p { color: teal; }');
let linked = true; // a link that leads out of the brain; junctions need no special rights on Windows
try { fs.symlinkSync(extra, path.join(brainDir, 'outside-link'), 'junction'); } catch { linked = false; }
let hasGit = true;
try {
  const env = { ...process.env, GIT_COMMITTER_NAME: 'smoke', GIT_COMMITTER_EMAIL: 'smoke@localhost', GIT_AUTHOR_NAME: 'smoke', GIT_AUTHOR_EMAIL: 'smoke@localhost' };
  const quiet = { cwd: brainDir, env, stdio: 'ignore' };
  execFileSync('git', ['init', '-q'], quiet);
  execFileSync('git', ['config', 'core.autocrlf', 'false'], quiet);
  execFileSync('git', ['add', '-A'], quiet);
  execFileSync('git', ['commit', '-q', '-m', 'start'], quiet);
} catch { hasGit = false; }

const server = spawn(process.execPath, ['--disable-warning=ExperimentalWarning', 'server/index.js'],
  { env: { ...process.env, NOVA_DATA_DIR: tmp, CLAUDE_CONFIG_DIR: oldClaude }, stdio: ['ignore', 'pipe', 'pipe'] });
let serverLog = '';
server.stdout.on('data', (d) => { serverLog += d; });
server.stderr.on('data', (d) => { serverLog += d; });

let failures = 0;
function check(ok, label) {
  console.log(`${ok ? 'pass' : 'FAIL'}  ${label}`);
  if (!ok) failures++;
}

async function http(method, url, { cookie, origin, body, tab } = {}) {
  const headers = {};
  if (tab) headers['X-Nova-Tab'] = tab;
  if (cookie) headers.Cookie = cookie;
  if (origin) headers.Origin = origin;
  if (body) headers['Content-Type'] = 'application/json';
  const res = await fetch(base + url, { method, headers, body: body ? JSON.stringify(body) : undefined, redirect: 'manual' });
  return { status: res.status, headers: res.headers, data: await res.json().catch(() => null) };
}

async function signIn(name) {
  const r = await http('POST', '/api/login', { body: { name, password: PASSWORD } });
  if (r.status !== 200) throw new Error(`Couldn't sign in as ${name} (${r.status}).`);
  return r.headers.get('set-cookie').split(';')[0];
}

// Resolves with an open socket that records every message, or rejects if the upgrade is refused.
function connect({ cookie, origin = base } = {}) {
  return new Promise((resolve, reject) => {
    const headers = { Origin: origin };
    if (cookie) headers.Cookie = cookie;
    const ws = new WebSocket(`ws://127.0.0.1:${port}/ws`, { headers });
    ws.received = [];
    ws.waiters = [];
    ws.on('message', (raw) => {
      const m = JSON.parse(raw);
      ws.received.push(m);
      for (const w of [...ws.waiters]) if (w.match(m)) { ws.waiters.splice(ws.waiters.indexOf(w), 1); w.resolve(m); }
    });
    ws.on('open', () => resolve(ws));
    ws.on('unexpected-response', (req, res) => reject(new Error(`refused with ${res.statusCode}`)));
    ws.on('error', reject);
  });
}

// The next message matching `match`, sent after this call or already received.
function next(ws, match, ms = 5000) {
  const seen = ws.received.find(match);
  if (seen) { ws.received.splice(ws.received.indexOf(seen), 1); return Promise.resolve(seen); }
  return new Promise((resolve, reject) => {
    const w = { match, resolve: (m) => { clearTimeout(timer); ws.received.splice(ws.received.indexOf(m), 1); resolve(m); } };
    const timer = setTimeout(() => { ws.waiters.splice(ws.waiters.indexOf(w), 1); reject(new Error('timed out')); }, ms);
    ws.waiters.push(w);
  });
}

const refused = (p) => p.then((ws) => { ws.close(); return false; }, () => true);

async function waitForServer() {
  for (let i = 0; i < 100; i++) {
    if (server.exitCode !== null) throw new Error('Nova exited during startup.');
    try { if ((await fetch(`${base}/api/health`)).ok) return; } catch {}
    await new Promise((r) => setTimeout(r, 200));
  }
  throw new Error('Nova didn\'t answer /api/health within 20 seconds.');
}

async function run() {
  await waitForServer();
  const evil = 'http://evil.example';

  // HTTP: sign-in and origin rules
  check((await http('GET', '/api/chats')).status === 401, 'HTTP without a session is refused');
  check((await http('POST', '/api/login', { origin: evil, body: { name: 'smoke-a', password: PASSWORD } })).status === 403,
    'cross-origin POST is refused');
  check((await http('POST', '/api/login', { body: { name: 'smoke-a', password: 'wrong-password-here' } })).status === 401,
    'wrong password is refused');
  const a = await signIn('smoke-a');
  const b = await signIn('smoke-b');

  // The presence panel's and installed app's modules are app code: served to a session only.
  for (const mod of ['/presence.js', '/avatars.js', '/log.js', '/pwa.js', '/commands.js']) {
    check((await http('GET', mod)).status === 302, `${mod} redirects without a session`);
    check((await http('GET', mod, { cookie: a })).status === 200, `${mod} is served to a session`);
  }

  // Browsers fetch the manifest and its icons without cookies, so they must be public.
  const manifest = await (await fetch(`${base}/manifest.webmanifest`)).json().catch(() => null);
  const iconPaths = [...(manifest?.icons || []), ...(manifest?.shortcuts || []).flatMap((s) => s.icons || [])].map((i) => i.src);
  check(iconPaths.length > 0 && manifest?.launch_handler?.client_mode === 'focus-existing', 'the manifest lists its icons and focuses an open window');
  let iconsOk = true;
  for (const src of new Set(iconPaths)) {
    const r = await fetch(`${base}${src}`);
    if (r.status !== 200 || !/^image\//.test(r.headers.get('content-type') || '')) iconsOk = false;
  }
  check(iconsOk, 'every manifest icon is served as an image without a session');
  check((await http('GET', '/icons/..%2Fapp.js')).status === 302 && (await http('GET', '/icons/nothing.png')).status === 404,
    'the icons route serves only icon files that exist');
  check(typeof (await http('GET', '/api/me', { cookie: a })).data?.version === 'string', '/api/me reports the app version');

  // WebSocket: upgrade rules
  check(await refused(connect()), 'WebSocket without a session is refused');
  check(await refused(connect({ cookie: a, origin: evil })), 'cross-origin WebSocket upgrade is refused');
  const wsA = await connect({ cookie: a });
  const wsB = await connect({ cookie: b });
  check(!!(await next(wsA, (m) => m.t === 'meta').catch(() => null)), 'signed-in WebSocket opens and gets meta');

  // Profile A creates a chat (no prompt sent)
  wsA.send(JSON.stringify({ t: 'new' }));
  const created = await next(wsA, (m) => m.t === 'created').catch(() => null);
  check(!!created?.chatId, 'new chat is created over WebSocket');
  if (!created?.chatId) return;
  const id = created.chatId;
  check((await http('GET', '/api/chats', { cookie: a })).data?.some((c) => c.id === id), 'owner sees the chat in its list');
  wsA.send(JSON.stringify({ t: 'open', chatId: id }));
  const hist = await next(wsA, (m) => m.t === 'history' && m.chatId === id).catch(() => null);
  check(Array.isArray(hist?.messages), 'owner can open the chat');

  // Categories reorder per profile
  const cats = [];
  for (const name of ['Smoke one', 'Smoke two', 'Smoke three']) cats.push((await http('POST', '/api/categories', { cookie: a, body: { name } })).data?.id);
  const names = (list) => (list || []).map((c) => c.name).join(',');
  let moved = await http('POST', `/api/categories/${cats[2]}/move`, { cookie: a, body: { beforeId: cats[0] } });
  check(moved.status === 200 && names(moved.data) === 'Smoke three,Smoke one,Smoke two', 'a category moves before another');
  moved = await http('POST', `/api/categories/${cats[2]}/move`, { cookie: a, body: {} });
  check(names(moved.data) === 'Smoke one,Smoke two,Smoke three', 'a category moves to the end');
  check(names((await http('GET', '/api/categories', { cookie: a })).data) === 'Smoke one,Smoke two,Smoke three', 'the new order is stored');
  check((await http('POST', `/api/categories/${cats[0]}/move`, { cookie: b, body: {} })).status === 404, 'other profile can\'t move a category');
  const otherCat = (await http('POST', '/api/categories', { cookie: b, body: { name: 'Smoke other' } })).data?.id;
  check((await http('POST', `/api/categories/${cats[0]}/move`, { cookie: a, body: { beforeId: otherCat } })).status === 404,
    'a category can\'t be placed before another profile\'s');
  check((await http('POST', `/api/categories/${cats[0]}/move`, { cookie: a, origin: evil, body: {} })).status === 403, 'cross-origin category move is refused');
  for (const c of [...cats]) await http('DELETE', `/api/categories/${c}`, { cookie: a });
  await http('DELETE', `/api/categories/${otherCat}`, { cookie: b });

  // Profile B must not see or touch it
  check(!(await http('GET', '/api/chats', { cookie: b })).data?.some((c) => c.id === id), 'other profile doesn\'t see the chat');
  check((await http('PATCH', `/api/chats/${id}`, { cookie: b, body: { categoryId: null } })).status === 404, 'other profile can\'t change the chat');
  check((await http('DELETE', `/api/chats/${id}`, { cookie: b })).status === 404, 'other profile can\'t delete the chat');
  for (const [t, extra] of [['open', {}], ['send', { text: 'smoke test, should never be sent' }], ['mode', { mode: 'plan' }]]) {
    wsB.send(JSON.stringify({ t, chatId: id, ...extra }));
    const r = await next(wsB, (m) => m.t === 'error').catch(() => null);
    check(r?.message === 'Chat not found.', `other profile's WebSocket "${t}" is refused`);
  }
  wsB.send(JSON.stringify({ t: 'interrupt', chatId: id }));
  wsB.send(JSON.stringify({ t: 'answer', chatId: id, reqId: 'x', result: { behavior: 'allow' } }));
  await new Promise((r) => setTimeout(r, 300));
  check((await http('GET', '/api/chats', { cookie: a })).data?.some((c) => c.id === id), 'chat is still there for its owner');
  check(!wsB.received.some((m) => JSON.stringify(m).includes(id) && m.t !== 'error'), 'other profile\'s socket received nothing about the chat');

  wsA.close();
  wsB.close();
  await permissions(a, b, await signIn('smoke-c'));
}

// Extra folders and remembered approvals are per profile.
async function permissions(a, b, c) {
  check((await http('GET', '/api/folders')).status === 401, 'folders need a session');
  check((await http('POST', '/api/folders', { cookie: a, body: { path: 'relative/folder' } })).status === 400, 'relative folder path is refused');
  check((await http('POST', '/api/folders', { cookie: a, body: { path: path.join(tmp, 'missing') } })).status === 400, 'missing folder is refused');
  check((await http('POST', '/api/folders', { cookie: a, body: { path: path.join(tmp, 'brain') } })).status === 400, 'brain folder is refused as an extra folder');
  const added = await http('POST', '/api/folders', { cookie: a, body: { path: extra } });
  check(added.status === 200 && added.data?.folders?.length === 1, 'owner adds a folder');
  check((await http('POST', '/api/folders', { cookie: a, body: { path: extra } })).status === 400, 'the same folder twice is refused');
  check((await http('GET', '/api/folders', { cookie: b })).data?.length === 0, 'other profile doesn\'t see the folder');
  check((await http('DELETE', '/api/folders', { cookie: b, body: { path: added.data?.path } })).status === 404, 'other profile can\'t remove the folder');
  check((await http('GET', '/api/folders', { cookie: a })).data?.length === 1, 'folder is still there for its owner');
  check((await http('DELETE', '/api/folders', { cookie: a, origin: 'http://evil.example', body: { path: added.data?.path } })).status === 403,
    'cross-origin folder removal is refused');
  check((await http('DELETE', '/api/folders', { cookie: a, body: { path: added.data?.path } })).data?.length === 0, 'owner removes the folder');

  const mine = (await http('GET', '/api/approvals', { cookie: a })).data;
  check(mine?.length === 1 && mine[0].text === 'Bash(npm test:*)', 'owner sees its approval');
  check((await http('GET', '/api/approvals', { cookie: b })).data?.length === 0, 'other profile doesn\'t see the approval');
  check((await http('DELETE', '/api/approvals', { cookie: b, body: { tool: 'Bash', rule: 'npm test:*' } })).status === 404, 'other profile can\'t remove the approval');
  check((await http('POST', '/api/approvals/share', { cookie: c, body: { tool: 'Bash', rule: 'ls:*' } })).status === 403, 'a user can\'t share a rule with every profile');
  check((await http('POST', '/api/approvals/share', { cookie: a, body: { tool: 'Bash', rule: 'ls:*' } })).status === 404, 'an admin can\'t share another profile\'s rule');
  const shared = await http('POST', '/api/approvals/share', { cookie: a, body: { tool: 'Bash', rule: 'npm test:*' } });
  const file = path.join(tmp, 'brain', '.claude', 'settings.local.json');
  const allow = fs.existsSync(file) ? JSON.parse(fs.readFileSync(file, 'utf8')).permissions?.allow : null;
  check(shared.status === 200 && allow?.includes('Bash(npm test:*)') && shared.data.approvals.length === 0,
    'admin shares its rule into settings.local.json');
  await brain(a, b, c);
}

// Brain viewer: access levels, confinement, hidden paths, saving, downloads.
async function brain(a, b, c) {
  const tree = async (cookie, p = '') => http('GET', `/api/brain/tree?path=${encodeURIComponent(p)}`, { cookie });
  const file = async (cookie, p) => http('GET', `/api/brain/file?path=${encodeURIComponent(p)}`, { cookie });
  const save = (cookie, p, content, version, origin) => http('PUT', '/api/brain/file', { cookie, origin, body: { path: p, content, version } });

  check((await http('GET', '/api/me', { cookie: b })).data?.access?.brain === 'read', 'a user profile defaults to view-only brain access');
  check((await tree(c)).status === 403 && (await http('POST', '/api/brain/resolve', { cookie: c, body: { names: ['a'] } })).status === 403,
    'a profile without brain access is refused');
  const root = (await tree(a)).data?.entries?.map((e) => e.name) || [];
  check(root.includes('notes') && root.includes('.claude') && root.includes('profiles'), 'the tree lists the brain root');
  check(!root.some((n) => ['node_modules', '.obsidian', '.git', 'outside-link'].includes(n)), 'hidden folders and outward links are left out');
  check(JSON.stringify((await tree(b, 'profiles')).data?.entries?.map((e) => e.name)) === '["smoke-b"]', 'a profile sees only its own notes folder');
  check((await file(b, 'profiles/smoke-a/mine.md')).status === 404, 'another profile\'s notes folder can\'t be read');
  check((await file(a, 'node_modules/pkg/readme.md')).status === 404, 'a hidden path can\'t be read directly');
  check((await file(a, '../extra/outside.md')).status === 403, 'climbing out of the brain is refused');
  check((await file(a, extra.replace(/\\/g, '/') + '/outside.md')).status === 403, 'an absolute path is refused');
  if (linked) check((await file(a, 'outside-link/outside.md')).status === 403, 'a link leading out of the brain is refused');
  check((await file(a, 'bin/data.bin')).data?.kind === 'binary', 'a binary file is reported, not shown');

  const note = (await file(b, 'notes/a.md')).data;
  check(note?.kind === 'markdown' && note.readOnly === 'access', 'a view-only profile reads markdown, marked read-only');
  check((await save(b, 'notes/a.md', 'changed\n', note?.version)).status === 403, 'a view-only profile can\'t save');
  check((await save(a, 'notes/a.md', 'changed\n', 'stale')).status === 409, 'a save against a stale version is refused');
  check((await save(a, 'notes/a.md', 'changed\n', note?.version, 'http://evil.example')).status === 403, 'a cross-origin save is refused');
  const saved = await save(a, 'notes/a.md', '# Hello\n\nSecond version.\n', note?.version);
  check(saved.status === 200 && fs.readFileSync(path.join(brainDir, 'notes/a.md'), 'utf8').includes('Second version'), 'an editor saves the file');
  if (hasGit) {
    const author = execFileSync('git', ['log', '-1', '--format=%an|%s'], { cwd: brainDir }).toString().trim();
    check(saved.data?.committed === true && author === 'smoke-a|Edit notes/a.md in Nova', 'the save is committed with the profile as author');
  }
  const crlf = (await file(a, 'notes/crlf.md')).data;
  await save(a, 'notes/crlf.md', 'line one\nline two\nline three\n', crlf?.version);
  check(fs.readFileSync(path.join(brainDir, 'notes/crlf.md'), 'utf8') === 'line one\r\nline two\r\nline three\r\n', 'a CRLF file keeps its line endings');

  // Give smoke-b edit access through the admin route, then check .claude stays admin-only.
  check((await http('PATCH', '/api/profiles/smoke-b', { cookie: b, body: { access: { brain: 'edit' } } })).status === 403, 'a user can\'t change its own access');
  check((await http('PATCH', '/api/profiles/smoke-b', { cookie: a, body: { access: { brain: 'edit' } } })).status === 200, 'an admin grants edit access');
  const settings = (await file(b, '.claude/settings.json')).data;
  check(settings?.readOnly === 'admin' && (await save(b, '.claude/settings.json', '{ "x": 1 }\n', settings?.version)).status === 403,
    'only admins can edit .claude');
  const again = (await file(b, 'notes/a.md')).data;
  check((await save(b, 'notes/a.md', '# Hello\n\nThird version.\n', again?.version)).status === 200, 'a user with edit access saves');

  const dl = await fetch(`${base}/api/brain/download?path=notes%2Fa.md`, { headers: { Cookie: a } });
  check(dl.status === 200 && /attachment/.test(dl.headers.get('content-disposition') || '') && (await dl.text()).includes('Third version'), 'a file downloads');
  const summary = (await http('GET', '/api/brain/download?path=notes&check=1', { cookie: a })).data;
  const zip = Buffer.from(await (await fetch(`${base}/api/brain/download?path=notes`, { headers: { Cookie: a } })).arrayBuffer());
  const eocd = zip.lastIndexOf(Buffer.from([0x50, 0x4b, 0x05, 0x06]));
  check(summary?.files === 2 && zip.subarray(0, 2).toString() === 'PK' && eocd > 0 && zip.readUInt16LE(eocd + 10) === 2, 'a folder downloads as a zip');
  const whole = (await http('GET', '/api/brain/download?path=&check=1', { cookie: b })).data;
  // notes/a.md, notes/crlf.md, bin/data.bin, .claude/settings.json, .claude/settings.local.json
  // (from the share check above), profiles/smoke-b/mine.md, the three link-test files and
  // media/clip.mp4 and site/report.html with site/style.css (node_modules/pkg/clip.webm stays hidden).
  check(whole?.files === 12, 'a whole-brain zip leaves out hidden paths and other profiles\' folders');

  // Obsidian-style [[links]] resolve by name, the way Obsidian does.
  const names = ['a', 'brief', 'Acme/brief', 'Clients/Acme/brief.md', '#Top', 'a#Heading', 'logo.png', 'mine', 'missing', 'node_modules/pkg/readme'];
  const links = (await http('POST', '/api/brain/resolve', { cookie: b, body: { from: 'notes/a.md', names } })).data || {};
  check(links.a === 'notes/a.md' && links['a#Heading'] === 'notes/a.md', 'a [[link]] finds a note by name, with or without a heading');
  check(links.brief === 'Other/brief.md', 'with two notes of one name, the shorter path wins');
  check(links['Acme/brief'] === 'Clients/Acme/brief.md' && links['Clients/Acme/brief.md'] === 'Clients/Acme/brief.md', 'a [[folder/note]] link narrows the match');
  check(links['#Top'] === 'notes/a.md', 'a [[#heading]] link points at the same note');
  check(links['logo.png'] === 'img/logo.png', 'a link with an extension finds that file');
  check(links.mine === 'profiles/smoke-b/mine.md', 'a link never resolves to another profile\'s notes');
  check(links.missing === null && links['node_modules/pkg/readme'] === null, 'missing and hidden targets resolve to nothing');
  const near = (await http('POST', '/api/brain/resolve', { cookie: b, body: { from: 'Clients/Acme/overview.md', names: ['brief'] } })).data;
  check(near?.brief === 'Clients/Acme/brief.md', 'a note in the linking note\'s own folder wins');
  check((await http('GET', '/api/brain/image?path=notes%2Fa.md', { cookie: a })).status === 415, 'only raster images are served inline');
  await brainVideo(a, c);
  await brainPages(a, b, c);
  await brainFiles(b, c);
  await tasksAndNotes(a, b, c);
}

// Brain video: streamed in byte ranges for the viewer's player. smoke-c has no brain access.
async function brainVideo(a, c) {
  const get = async (p, { cookie = a, range } = {}) => {
    const headers = { Cookie: cookie };
    if (range) headers.Range = range;
    const res = await fetch(`${base}/api/brain/video?path=${encodeURIComponent(p)}`, { headers, redirect: 'manual' });
    return { status: res.status, headers: res.headers, body: Buffer.from(await res.arrayBuffer()).toString() };
  };
  check((await http('GET', '/api/brain/file?path=media%2Fclip.mp4', { cookie: a })).data?.kind === 'video', 'an MP4 in the brain opens as a video');
  const whole = await get('media/clip.mp4');
  check(whole.status === 200 && whole.body === '0123456789' && whole.headers.get('accept-ranges') === 'bytes'
    && whole.headers.get('content-type') === 'video/mp4', 'a video streams whole, saying it takes byte ranges');
  const part = await get('media/clip.mp4', { range: 'bytes=2-5' });
  check(part.status === 206 && part.body === '2345' && part.headers.get('content-range') === 'bytes 2-5/10', 'a byte range comes back as 206 with just those bytes');
  const open = await get('media/clip.mp4', { range: 'bytes=7-' });
  check(open.status === 206 && open.body === '789', 'an open-ended range runs to the end');
  const tail = await get('media/clip.mp4', { range: 'bytes=-3' });
  check(tail.status === 206 && tail.body === '789', 'a suffix range gives the last bytes');
  const over = await get('media/clip.mp4', { range: 'bytes=50-60' });
  check(over.status === 416 && over.headers.get('content-range') === 'bytes */10', 'a range past the end is refused with 416');
  check((await get('media/clip.mp4', { range: 'bytes=0-1,4-5' })).status === 416, 'several ranges at once are refused');
  check((await get('notes/a.md')).status === 415, 'only video files stream as video');
  check((await get('node_modules/pkg/clip.webm')).status === 404, 'a hidden video isn\'t served');
  check((await get('../outside.mp4')).status === 403, 'a video path can\'t climb out of the brain');
  check((await get('media/clip.mp4', { cookie: c })).status === 403, 'a profile without brain access can\'t stream video');
  const signedOut = await fetch(`${base}/api/brain/video?path=media%2Fclip.mp4`, { redirect: 'manual' });
  check(signedOut.status === 401, 'video needs a session');
}

// Rendered HTML pages: served path-style so relative links work, sandboxed by CSP, scripts off.
// The frame's requests carry no cookie, so a token from opening the file stands in for it.
async function brainPages(a, b, c) {
  const open = async (cookie) => (await http('GET', '/api/brain/file?path=site%2Freport.html', { cookie })).data;
  const f = await open(a);
  const get = async (p, token = f?.pageToken) => {
    const res = await fetch(`${base}/api/brain/page/${token}/${p}`, { redirect: 'manual' });
    return { status: res.status, type: res.headers.get('content-type') || '', csp: res.headers.get('content-security-policy') || '', body: await res.text() };
  };
  check(f?.kind === 'html' && f.content.includes('Réport') && !f.readOnly && /^[0-9a-f]{48}$/.test(f.pageToken), 'an HTML file opens as an editable page with a page token');
  check((await http('GET', '/api/brain/file?path=notes%2Fa.md', { cookie: a })).data?.pageToken === undefined, 'only HTML files get a page token');
  const pg = await get('site/report.html');
  check(pg.status === 200 && pg.type === 'text/html; charset=utf-8' && pg.body.includes('Réport'), 'an HTML page is served as UTF-8 HTML');
  check(/^sandbox /.test(pg.csp) && /default-src 'none'/.test(pg.csp) && !/script-src/.test(pg.csp) && /frame-ancestors 'self'/.test(pg.csp),
    'a page is sandboxed with no scripts and can only be framed by Nova');
  const css = await get('site/style.css');
  check(css.status === 200 && css.type.startsWith('text/css') && /^sandbox /.test(css.csp), 'a page\'s stylesheet loads beside it');
  check((await get('img/logo.png')).type === 'image/png', 'a page\'s relative image loads');
  check((await get('site/Report%20copy.html')).status === 404, 'a missing page is 404');
  check((await get('notes/a.md')).status === 415 && (await get('bin/data.bin')).status === 415, 'only pages, stylesheets and images are served as page parts');
  check((await get('node_modules/pkg/readme.md')).status === 404, 'a hidden file isn\'t served as a page part');
  check((await get('..%2Fextra%2Foutside.md')).status === 403, 'a page path can\'t climb out of the brain');
  check((await get('%E0%A4%A')).status === 400, 'a badly encoded page path is refused');
  check((await http('GET', '/api/brain/file?path=site%2Freport.html', { cookie: c })).status === 403, 'a profile without brain access gets no page token');
  check((await get('site/report.html', 'f'.repeat(48))).status === 401 && (await get('site/report.html', 'x')).status === 401, 'pages need a real token');
  // The token names the profile; its access is checked on every request, so taking it away works at once.
  const tokenB = (await open(b))?.pageToken;
  check((await http('PATCH', '/api/profiles/smoke-b', { cookie: a, body: { access: { brain: 'none' } } })).status === 200
    && (await get('site/report.html', tokenB)).status === 403, 'a page token stops working when brain access is taken away');
  await http('PATCH', '/api/profiles/smoke-b', { cookie: a, body: { access: { brain: 'edit' } } });
}

// Brain upload and delete. smoke-b has edit access by now; smoke-c has no brain access.
async function brainFiles(b, c) {
  const up = (cookie, dir, file, body, { overwrite = false, origin } = {}) => fetch(
    `${base}/api/brain/upload?dir=${encodeURIComponent(dir)}&path=${encodeURIComponent(file)}${overwrite ? '&overwrite=1' : ''}`,
    { method: 'POST', headers: { Cookie: cookie, ...(origin ? { Origin: origin } : {}) }, body });
  const del = (cookie, p, origin) => http('DELETE', `/api/brain/file?path=${encodeURIComponent(p)}`, { cookie, origin });
  const on = (p) => fs.existsSync(path.join(brainDir, p));
  const gitLog = () => hasGit ? execFileSync('git', ['log', '-1', '--format=%an|%s'], { cwd: brainDir }).toString().trim() : '';

  // What the tree tells the browser this profile may do.
  const rootList = (await http('GET', '/api/brain/tree?path=', { cookie: b })).data;
  const entry = (list, name) => list?.entries?.find((e) => e.name === name);
  const own = entry((await http('GET', '/api/brain/tree?path=profiles', { cookie: b })).data, 'smoke-b');
  check(rootList?.canUpload === true && entry(rootList, 'notes')?.canDelete === true, 'the tree says an editor may upload and delete');
  check(entry(rootList, 'profiles')?.canDelete === false && entry(rootList, 'profiles')?.canUpload === false
    && own?.canDelete === false && own?.canUpload === true, 'the tree marks profile folders as not deletable');
  check(entry(rootList, '.claude')?.canDelete === false, 'the tree marks .claude as admin-only');

  // Uploading.
  check((await up(b, 'notes', 'new.md', '# New\n')).status === 200 && on('notes/new.md'), 'a file uploads into a folder');
  check((await up(b, 'notes', 'new.md', '# Again\n')).status === 409, 'an existing file isn\'t replaced without asking');
  check((await up(b, 'notes', 'new.md', '# Replaced\n', { overwrite: true })).status === 200
    && fs.readFileSync(path.join(brainDir, 'notes/new.md'), 'utf8') === '# Replaced\n', 'it is replaced once confirmed');
  check((await up(b, 'notes', 'sub/deep/x.md', 'x')).status === 200 && on('notes/sub/deep/x.md'), 'a folder upload creates its folders');
  check((await up(b, 'notes', '../escape.md', 'x')).status === 400 && !on('escape.md'), 'an upload can\'t climb out of its folder');
  check((await up(b, 'profiles/smoke-a', 'x.md', 'x')).status === 404, 'nothing uploads into another profile\'s folder');
  check((await up(b, 'profiles', 'x.md', 'x')).status === 403, 'nothing uploads loose into the profiles folder');
  check((await up(b, 'profiles/smoke-b', 'x.md', 'x')).status === 200, 'a profile uploads into its own folder');
  check((await up(b, '.claude', 'x.md', 'x')).status === 403, 'only admins upload into .claude');
  check((await up(b, 'notes', '.DS_Store', 'x')).status === 403, 'a file Nova would hide isn\'t uploaded');
  check((await up(c, 'notes', 'y.md', 'x')).status === 403, 'a profile without brain access can\'t upload');
  check((await up(b, 'notes', 'z.md', 'x', { origin: 'http://evil.example' })).status === 403, 'a cross-origin upload is refused');
  const committed = (await http('POST', '/api/brain/upload/commit', { cookie: b, body: { dir: 'notes', paths: ['notes/new.md', 'notes/sub/deep/x.md'] } })).data;
  if (hasGit) check(committed?.committed === true && gitLog() === 'smoke-b|Upload 2 files to notes in Nova', 'an upload batch is one commit, by the profile');

  // Deleting.
  check((await del(b, 'notes/new.md')).status === 200 && !on('notes/new.md'), 'a file is deleted');
  const trashed = fs.readdirSync(path.join(brainDir, '.trash'));
  check(trashed.length === 1 && on(`.trash/${trashed[0]}/notes/new.md`), 'a deleted file goes to the brain\'s .trash folder');
  check(!(await http('GET', '/api/brain/tree?path=', { cookie: b })).data?.entries?.some((e) => e.name === '.trash'), 'the trash is hidden in the tree');
  if (hasGit) check(gitLog() === 'smoke-b|Delete notes/new.md in Nova', 'the deletion is committed, by the profile');
  check((await del(b, 'profiles/smoke-b')).status === 403 && (await del(b, 'profiles')).status === 403 && (await del(b, '')).status === 403,
    'profile folders, the profiles folder and the brain itself can\'t be deleted');
  check((await del(b, 'profiles/smoke-b/x.md')).status === 200, 'a file in a profile\'s own folder can be deleted');
  check((await del(b, '.claude/settings.json')).status === 403 && on('.claude/settings.json'), 'only admins delete in .claude');
  put('Other/node_modules/pkg/index.js', '');
  check((await del(b, 'Other')).status === 409 && on('Other/brief.md'), 'a folder holding hidden things isn\'t deleted');
  check((await del(b, 'notes/sub', 'http://evil.example')).status === 403 && on('notes/sub'), 'a cross-origin delete is refused');
  check((await del(b, 'notes/sub')).status === 200 && !on('notes/sub'), 'a folder is deleted with everything in it');
  check((await del(c, 'notes/a.md')).status === 403, 'a profile without brain access can\'t delete');
}

// Tasks and notes: per profile, nesting rules, overdue, order, live updates.
async function tasksAndNotes(a, b, c) {
  // The board asks with the browser's date; 2026-09-21 stands in for today here.
  const list = async (cookie) => (await http('GET', '/api/tasks?today=2026-09-21', { cookie })).data?.tasks || [];
  const add = async (cookie, body) => (await http('POST', '/api/tasks', { cookie, body })).data;

  // Live updates reach the profile's own sockets, tagged with the tab that made the change.
  const wsA = await connect({ cookie: a });
  const wsB = await connect({ cookie: b });
  const parent = await add(a, { title: 'Write report', day: '2026-09-22' });
  check(parent?.state === 'waiting' && parent.day === '2026-09-22', 'a task is created on a day');
  await http('PATCH', `/api/tasks/${parent.id}`, { cookie: a, tab: 'tab-1', body: { state: 'in_progress' } });
  const echo = await next(wsA, (m) => m.t === 'tasks_changed' && m.from === 'tab-1').catch(() => null);
  check(!!echo, 'a change is broadcast to the profile, naming the tab that made it');
  await new Promise((r) => setTimeout(r, 200));
  check(!wsB.received.some((m) => m.t === 'tasks_changed'), 'other profiles hear nothing about it');
  wsA.close();
  wsB.close();

  const child = await add(a, { title: 'Draft section', parentId: parent.id, day: '2026-09-25' });
  check(child?.parentId === parent.id && child.day === null, 'a subtask follows its parent, not its own day');
  check((await http('POST', `/api/tasks/${parent.id}/move`, { cookie: a, body: { parentId: child.id } })).status === 400, 'a task can\'t move inside its own subtask');
  check((await http('POST', '/api/tasks', { cookie: a, body: { title: 'Bad', day: '2026-02-30' } })).status === 400, 'an impossible date is refused');
  check((await http('PATCH', `/api/tasks/${parent.id}`, { cookie: a, body: { state: 'done' } })).status === 400, 'an unknown state is refused');
  const old = await add(a, { title: 'Old open task', day: '2000-01-03' });
  const oldDone = await add(a, { title: 'Old finished task', day: '2000-01-04' });
  await http('PATCH', `/api/tasks/${oldDone.id}`, { cookie: a, body: { state: 'complete' } });
  let mine = await list(a);
  check(mine.some((t) => t.id === old.id) && !mine.some((t) => t.id === oldDone.id), 'open tasks from earlier days come back as overdue; finished ones don\'t');
  check(mine.some((t) => t.id === child.id), 'subtasks come with their parent');

  const second = await add(a, { title: 'Second', day: '2026-09-22' });
  await http('POST', `/api/tasks/${second.id}/move`, { cookie: a, body: { day: '2026-09-22', beforeId: parent.id } });
  mine = await list(a);
  const order = mine.filter((t) => t.day === '2026-09-22').sort((x, y) => x.position - y.position).map((t) => t.id);
  check(JSON.stringify(order) === JSON.stringify([second.id, parent.id]), 'a task moves before another on its day');
  await http('POST', `/api/tasks/${child.id}/move`, { cookie: a, body: { day: null } });
  mine = await list(a);
  check(mine.find((t) => t.id === child.id)?.parentId === null && mine.find((t) => t.id === child.id)?.day === null, 'a subtask moves out to Unscheduled');
  await http('POST', `/api/tasks/${child.id}/move`, { cookie: a, body: { parentId: parent.id } });

  check((await list(b)).length === 0, 'another profile doesn\'t see the tasks');
  check((await http('PATCH', `/api/tasks/${parent.id}`, { cookie: b, body: { title: 'x' } })).status === 404, 'another profile can\'t change a task');
  check((await http('POST', `/api/tasks/${parent.id}/move`, { cookie: b, body: { day: null } })).status === 404, 'another profile can\'t move a task');
  check((await http('POST', '/api/tasks', { cookie: b, body: { title: 'Sneaky', parentId: parent.id } })).status === 404, 'another profile can\'t add under a task');
  check((await http('DELETE', `/api/tasks/${parent.id}`, { cookie: b })).status === 404, 'another profile can\'t delete a task');
  check((await http('POST', '/api/tasks', { cookie: a, origin: 'http://evil.example', body: { title: 'x' } })).status === 403, 'a cross-origin task change is refused');
  check((await http('DELETE', `/api/tasks/${parent.id}`, { cookie: a })).data?.deleted === 2, 'deleting a task deletes its subtasks');
  check((await add(c, { title: 'User task', day: '2026-09-23' }))?.title === 'User task', 'a user profile can keep tasks by default');
  await http('PATCH', '/api/profiles/smoke-c', { cookie: a, body: { access: { tasks: 'read' } } });
  check((await http('POST', '/api/tasks', { cookie: c, body: { title: 'x' } })).status === 403 && (await list(c)).length === 1,
    'view-only task access can read but not change');

  // A subtask's state rolls up the parent chain. Top -> Mid -> (X, Y), and Top -> Z.
  const top = await add(a, { title: 'Top', day: '2026-09-24' });
  const mid = await add(a, { title: 'Mid', parentId: top.id });
  const [x, y] = [await add(a, { title: 'X', parentId: mid.id }), await add(a, { title: 'Y', parentId: mid.id })];
  const z = await add(a, { title: 'Z', parentId: top.id });
  const mark = (t, state) => http('PATCH', `/api/tasks/${t.id}`, { cookie: a, body: { state } });
  const states = async () => { const all = await list(a); return [top, mid].map((t) => all.find((r) => r.id === t.id)?.state).join(); };
  await mark(x, 'in_progress');
  check(await states() === 'in_progress,in_progress', 'marking a subtask in progress puts every parent above it in progress');
  await mark(x, 'complete');
  await mark(y, 'complete');
  check(await states() === 'in_progress,complete', 'a parent completes when all its subtasks do; its parent stays in progress for a mix');
  await mark(z, 'complete');
  const done = (await list(a)).find((t) => t.id === top.id);
  check(done?.state === 'complete' && done.completedAt > 0, 'completion carries all the way up, with a completion time');
  await mark(x, 'waiting');
  await mark(y, 'waiting');
  check(await states() === 'in_progress,waiting', 'a parent goes back to waiting when all its subtasks are waiting');
  await mark(z, 'waiting');
  check(await states() === 'waiting,waiting' && !(await list(a)).find((t) => t.id === top.id).completedAt, 'all waiting all the way up clears the completion');
  await mark(top, 'complete');
  check((await list(a)).find((t) => t.id === x.id)?.state === 'waiting', 'setting a parent directly leaves its subtasks alone');
  await http('DELETE', `/api/tasks/${top.id}`, { cookie: a });

  const n1 = (await http('POST', '/api/notes', { cookie: a, body: { text: 'first' } })).data;
  const n2 = (await http('POST', '/api/notes', { cookie: a, body: { text: 'second', color: 'blue' } })).data;
  const notes = (await http('GET', '/api/notes', { cookie: a })).data;
  check(notes?.[0]?.id === n2.id && notes[1]?.id === n1.id && n1.color === 'yellow', 'new notes go first, yellow by default');
  const moved = (await http('POST', `/api/notes/${n2.id}/move`, { cookie: a, body: { beforeId: null } })).data;
  check(moved?.map((n) => n.id).join() === [n1.id, n2.id].join(), 'a note moves to the end');
  check((await http('PATCH', `/api/notes/${n1.id}`, { cookie: a, body: { color: 'orange' } })).status === 400, 'an unknown colour is refused');
  check((await http('PATCH', `/api/notes/${n1.id}`, { cookie: a, body: { text: 'edited', color: 'pink' } })).data?.color === 'pink', 'a note\'s text and colour change');
  check((await http('GET', '/api/notes', { cookie: b })).data?.length === 0, 'another profile doesn\'t see the notes');
  check((await http('PATCH', `/api/notes/${n1.id}`, { cookie: b, body: { text: 'x' } })).status === 404, 'another profile can\'t change a note');
  check((await http('DELETE', `/api/notes/${n1.id}`, { cookie: b })).status === 404, 'another profile can\'t delete a note');
  check((await http('DELETE', `/api/notes/${n1.id}`, { cookie: a })).status === 200 && (await http('GET', '/api/notes', { cookie: a })).data?.length === 1, 'the owner deletes a note');

  // Tab badges: today's unfinished bottom-level tasks, and active notes.
  const today = '2026-09-30';
  const badges = async (cookie) => (await http('GET', `/api/badges?today=${today}`, { cookie })).data;
  const stack = await add(a, { title: 'Stack', day: today });
  const leafA = await add(a, { title: 'Leaf A', parentId: stack.id });
  await add(a, { title: 'Leaf B', parentId: stack.id });
  const deep = await add(a, { title: 'Leaf C parent', parentId: leafA.id });
  await http('PATCH', `/api/tasks/${deep.id}`, { cookie: a, body: { state: 'complete' } });
  await add(a, { title: 'Single', day: today });
  await add(a, { title: 'Tomorrow', day: '2026-10-01' });
  // Stack -> Leaf A -> Leaf C parent (complete), Leaf B (open); Single (open). Bottom level open: Leaf B, Single.
  check((await badges(a))?.tasks === 2, 'the tasks badge counts today\'s unfinished bottom-level tasks');
  const n3 = (await http('POST', '/api/notes', { cookie: a, body: { text: 'kept for reference' } })).data;
  check((await badges(a))?.notes === 2, 'the notes badge counts active notes');
  const shelved = (await http('PATCH', `/api/notes/${n3.id}`, { cookie: a, body: { active: false } })).data;
  check(shelved?.active === false && (await badges(a))?.notes === 1, 'a long-standing note leaves the count');
  check((await http('PATCH', `/api/notes/${n3.id}`, { cookie: a, body: { active: 'no' } })).status === 400, 'active must be true or false');
  await http('PATCH', '/api/profiles/smoke-c', { cookie: a, body: { access: { notes: 'none' } } });
  const cBadges = await badges(c);
  check(cBadges && !('notes' in cBadges) && 'tasks' in cBadges, 'badges leave out views a profile can\'t read');
  check((await badges(b))?.tasks === 0 && (await badges(b))?.notes === 0, 'badges count only the profile\'s own tasks and notes');

  // Personal preferences: each profile sets its own.
  check((await http('GET', '/api/me', { cookie: b })).data?.prefs?.hideWeekends === false, 'hide weekends is off by default');
  check((await http('PATCH', '/api/profiles/smoke-b', { cookie: b, body: { prefs: { hideWeekends: true } } })).status === 200
    && (await http('GET', '/api/me', { cookie: b })).data?.prefs?.hideWeekends === true, 'a user turns on hide weekends for itself');
  check((await http('PATCH', '/api/profiles/smoke-b', { cookie: b, body: { prefs: { hideWeekends: 'yes' } } })).status === 400, 'a preference of the wrong type is refused');
  check((await http('PATCH', '/api/profiles/smoke-b', { cookie: b, body: { prefs: { theme: 'dark' } } })).status === 400, 'an unknown preference is refused');
  check((await http('PATCH', '/api/profiles/smoke-c', { cookie: b, body: { prefs: { hideWeekends: true } } })).status === 403
    && (await http('GET', '/api/me', { cookie: c })).data?.prefs?.hideWeekends === false, 'a user can\'t change another profile\'s preferences');
  await attachments(a, b);

  // Show thinking is a global setting: admins only.
  check((await http('GET', '/api/settings', { cookie: a })).data?.showThinking === true, 'showing Claude\'s thinking is on by default');
  check((await http('POST', '/api/settings', { cookie: b, body: { showThinking: false } })).status === 403, 'a user can\'t change whether thinking shows');
  await http('POST', '/api/settings', { cookie: a, body: { showThinking: false } });
  check((await http('GET', '/api/settings', { cookie: a })).data?.showThinking === false, 'an admin turns showing thinking off');
  await claudeSignin(a, b);
  await pins(a);
  await pictures(a, b);
  await slashCommands(a);

  // Nova's own updates. Checks are off here (checkHours 0), so nothing asks GitHub.
  const app = await http('GET', '/api/settings/app', { cookie: a });
  // Before any check the relation is unknown, unless this checkout has uncommitted changes,
  // which show at once (they rule out updating whatever GitHub has).
  check(app.status === 200 && app.data?.local?.version && ['git', 'files'].includes(app.data.local.mode) && app.data.checkedAt === null
    && (app.data.local.changes ? app.data.relation === 'modified' : app.data.relation === null), 'an admin sees which version of Nova is running');
  check((await http('GET', '/api/settings/app', { cookie: b })).status === 403 && (await http('POST', '/api/settings/app/check', { cookie: b })).status === 403,
    'a user can\'t see or check Nova\'s updates');
  check((await http('POST', '/api/settings/app/update', { cookie: a, body: { commit: 'f'.repeat(40) } })).status === 409,
    'nothing is installed without a check that found an update');
}

// Slash commands for the composer: the brain's own skills and Claude Code's, from an idle session
// that's never prompted. The skill exists only for this check, so the brain's file counts above hold.
async function slashCommands(a) {
  put('.claude/skills/smoke-skill/SKILL.md', '---\nname: smoke-skill\ndescription: A skill made by the smoke test\n---\nDo nothing.\n');
  try {
    check((await http('GET', '/api/commands')).status === 401, 'commands need a session');
    const r = await http('GET', '/api/commands', { cookie: a });
    const list = Array.isArray(r.data) ? r.data : [];
    const mine = list.find((c) => c.name === 'smoke-skill');
    check(r.status === 200 && mine?.source === 'brain' && mine.description === 'A skill made by the smoke test', 'the brain\'s own skill is listed as the brain\'s');
    check(list.some((c) => c.source === 'claude') && list.findIndex((c) => c.source === 'claude') > list.findIndex((c) => c.source === 'brain'),
      'Claude Code\'s commands are listed after the brain\'s');
    check(!list.some((c) => c.name === 'clear' || c.name.startsWith('_')), 'commands that would work against Nova are left out');
  } finally {
    fs.rmSync(path.join(brainDir, '.claude', 'skills'), { recursive: true, force: true });
  }
}

// Profile pictures: self or admin to change, any session to see, sniffed type.
async function pictures(a, b) {
  const PNG = Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), Buffer.alloc(32)]);
  const WEBP = Buffer.concat([Buffer.from('RIFF'), Buffer.alloc(4), Buffer.from('WEBPVP8 '), Buffer.alloc(16)]);
  const post = (cookie, name, body, { type = 'image/png', origin } = {}) => fetch(`${base}/api/profiles/${name}/picture`,
    { method: 'POST', headers: { Cookie: cookie, 'Content-Type': type, ...(origin ? { Origin: origin } : {}) }, body });
  const get = (cookie, name) => fetch(`${base}/api/profiles/${name}/picture`, { headers: cookie ? { Cookie: cookie } : {} });

  const own = await post(b, 'smoke-b', PNG);
  const stamp = (await own.json().catch(() => null))?.picture;
  check(own.status === 200 && Number.isInteger(stamp), 'a profile sets its own picture');
  check((await http('GET', '/api/me', { cookie: b })).data?.picture === stamp
    && (await http('GET', '/api/profiles', { cookie: a })).data?.find((p) => p.name === 'smoke-b')?.picture === stamp, 'the picture\'s stamp shows in /api/me and the profile list');
  check((await post(b, 'smoke-c', PNG)).status === 403, 'a user can\'t set another profile\'s picture');
  check((await post(a, 'smoke-c', WEBP, { type: 'image/png' })).status === 200, 'an admin sets another profile\'s picture');
  const seen = await get(b, 'smoke-c');
  check(seen.status === 200 && seen.headers.get('content-type') === 'image/webp' && /immutable/.test(seen.headers.get('cache-control') || ''),
    'any profile sees it, typed by its bytes, not the declared type');
  check((await get(null, 'smoke-c')).status === 401, 'pictures need a session');
  check((await post(b, 'smoke-b', Buffer.from('<svg onload="alert(1)"/>'), { type: 'image/png' })).status === 415, 'something that isn\'t a picture is refused');
  check((await post(b, 'smoke-b', Buffer.concat([PNG, Buffer.alloc(600 * 1024)]))).status === 413, 'a picture over 512 KB is refused');
  check((await post(b, 'smoke-b', PNG, { origin: 'http://evil.example' })).status === 403, 'a cross-origin picture upload is refused');
  check((await http('DELETE', '/api/profiles/smoke-c/picture', { cookie: b })).status === 403, 'a user can\'t remove another profile\'s picture');
  check((await http('DELETE', '/api/profiles/smoke-b/picture', { cookie: b })).status === 200 && (await get(b, 'smoke-b')).status === 404,
    'a profile removes its own picture');

  // Rename carries the picture; removing the profile drops it.
  await http('POST', '/api/profiles', { cookie: a, body: { name: 'smoke-pic', password: PASSWORD, role: 'user' } });
  await post(a, 'smoke-pic', PNG);
  await http('PATCH', '/api/profiles/smoke-pic', { cookie: a, body: { name: 'smoke-pic2' } });
  check((await get(a, 'smoke-pic2')).status === 200, 'renaming a profile keeps its picture');
  await http('DELETE', '/api/profiles/smoke-pic2', { cookie: a });
  await http('POST', '/api/profiles', { cookie: a, body: { name: 'smoke-pic2', password: PASSWORD, role: 'user' } });
  check((await get(a, 'smoke-pic2')).status === 404, 'removing a profile removes its picture');
}

// Quick-switch PINs are exactly 4 digits. Switching ends the session it came
// from, so it uses a fresh one.
async function pins(a) {
  const setPin = (pin) => http('PATCH', '/api/profiles/smoke-c', { cookie: a, body: { pin } });
  check((await setPin('12345')).status === 400 && (await setPin('123')).status === 400 && (await setPin('12a4')).status === 400,
    'a PIN must be exactly 4 digits');
  check((await http('POST', '/api/profiles', { cookie: a, body: { name: 'smoke-d', password: PASSWORD, pin: '123456' } })).status === 400,
    'a new profile\'s PIN must be 4 digits too');
  check((await setPin('4821')).status === 200
    && (await http('GET', '/api/profiles', { cookie: a })).data?.find((p) => p.name === 'smoke-c')?.hasPin === true, 'an admin sets a 4-digit PIN');
  const from = await signIn('smoke-b');
  const wrong = await http('POST', '/api/switch', { cookie: from, body: { name: 'smoke-c', pin: '0000' } });
  check(wrong.status === 401 && /PIN is incorrect/.test(wrong.data?.error || ''), 'a wrong PIN is refused');
  const ok = await http('POST', '/api/switch', { cookie: from, body: { name: 'smoke-c', pin: '4821' } });
  const cookie = ok.headers.get('set-cookie')?.split(';')[0];
  check(ok.status === 200 && (await http('GET', '/api/me', { cookie })).data?.profile === 'smoke-c', 'the right PIN switches profile');
  check((await http('GET', '/api/me', { cookie: from })).status === 401, 'the session it switched from has ended');
}

// Claude sign-in. The throwaway data folder has no sign-in, and no code is ever
// sent to Claude Code, so nothing here calls Anthropic.
async function claudeSignin(a, b) {
  const copied = path.join(tmp, 'claude', 'projects', 'C--old-brain');
  check(fs.existsSync(path.join(copied, `${OLD_CHAT}.jsonl`)) && fs.existsSync(path.join(copied, OLD_CHAT, 'subagents', 'agent-1.jsonl'))
    && fs.existsSync(path.join(oldProject, `${OLD_CHAT}.jsonl`)), 'an older chat\'s transcript is copied into Nova\'s Claude folder, and the original stays');
  check(!fs.existsSync(path.join(copied, `${STRANGER}.jsonl`)), 'transcripts that aren\'t Nova\'s chats are left alone');

  const settings = (await http('GET', '/api/settings', { cookie: a })).data;
  check(settings?.claudeDir === path.join(tmp, 'claude') && settings.signin === null && !('hasOauthToken' in settings),
    'settings name Nova\'s own Claude folder and hold no token');
  let signedIn;
  for (let i = 0; i < 150 && signedIn == null; i++) {
    signedIn = (await http('GET', '/api/me', { cookie: a })).data?.meta?.signedIn;
    if (signedIn == null) await new Promise((r) => setTimeout(r, 200));
  }
  check(signedIn === false, 'a new data folder isn\'t signed in to Claude, whatever the host\'s Claude Code uses');

  for (const [method, url, body] of [['POST', '/api/settings/signin', { method: 'claudeai' }], ['POST', '/api/settings/signin/code', { code: 'x' }],
    ['DELETE', '/api/settings/signin'], ['POST', '/api/settings/signout']]) {
    check((await http(method, url, { cookie: b, body })).status === 403, `a user can't ${method} ${url}`);
  }
  check((await http('POST', '/api/settings/signin/code', { cookie: a, body: { code: 'x' } })).status === 409, 'a code with no sign-in waiting is refused');
  check((await http('POST', '/api/settings/signin', { cookie: a, body: { method: 'password' } })).status === 400, 'an unknown sign-in method is refused');
  const started = await http('POST', '/api/settings/signin', { cookie: a, body: { method: 'claudeai' } });
  let host = null;
  try { host = new URL(started.data?.url).hostname; } catch {}
  check(started.status === 200 && /(^|\.)(claude\.com|claude\.ai|anthropic\.com)$/.test(host || ''), 'starting a sign-in returns Claude\'s sign-in link');
  check((await http('GET', '/api/settings', { cookie: a })).data?.signin?.url === started.data?.url, 'reopened settings show the waiting sign-in');
  check((await http('POST', '/api/settings/signin/code', { cookie: a, body: { code: 'two words' } })).status === 400
    && (await http('GET', '/api/settings', { cookie: a })).data?.signin, 'a malformed code is refused and the sign-in keeps waiting');
  check((await http('DELETE', '/api/settings/signin', { cookie: a })).status === 200
    && (await http('GET', '/api/settings', { cookie: a })).data?.signin === null, 'an admin cancels the sign-in');

  // Sending while signed out is refused before any Claude Code process starts.
  if (signedIn !== false) return;
  const ws = await connect({ cookie: b });
  ws.send(JSON.stringify({ t: 'new' }));
  const created = await next(ws, (m) => m.t === 'created').catch(() => null);
  ws.send(JSON.stringify({ t: 'send', chatId: created?.chatId, text: 'hello' }));
  const refused = await next(ws, (m) => m.t === 'error').catch(() => null);
  check(/isn't signed in to Claude. Ask an admin/.test(refused?.message || ''), 'sending while Nova is signed out is refused with what to do');
  ws.close();
}

// Chat attachments. Nothing here sends a message to Claude.
async function attachments(a, b) {
  const up = (cookie, name, body, origin) => fetch(`${base}/api/uploads?name=${encodeURIComponent(name)}`, {
    method: 'POST', headers: { Cookie: cookie, ...(origin ? { Origin: origin } : {}) }, body });
  const r = await up(a, '../../evil:name?.txt', 'hello attachment');
  const file = await r.json().catch(() => null);
  check(r.status === 200 && file?.name === 'evil_name_.txt' && file.size === 16 && file.type === 'text/plain', 'a file uploads, with a safe name');
  check(fs.existsSync(path.join(tmp, 'uploads', 'smoke-a', file.id, 'evil_name_.txt')), 'it\'s stored in the profile\'s uploads folder, outside the brain');
  check((await up(a, 'big.bin', Buffer.alloc(1024 * 1024 + 10))).status === 413, 'a file over the size limit is refused');
  check((await up(a, 'x.txt', 'x', 'http://evil.example')).status === 403, 'a cross-origin upload is refused');
  check((await fetch(`${base}/api/uploads`, { method: 'POST', body: 'x' })).status === 401, 'an upload needs a session');
  const got = await fetch(`${base}/api/uploads/${file.id}`, { headers: { Cookie: a } });
  check(got.status === 200 && /attachment/.test(got.headers.get('content-disposition')) && (await got.text()) === 'hello attachment', 'the owner downloads the file');
  check((await fetch(`${base}/api/uploads/${file.id}`, { headers: { Cookie: b } })).status === 404, 'another profile can\'t download it');
  check((await http('DELETE', `/api/uploads/${file.id}`, { cookie: b })).status === 404, 'another profile can\'t remove it');

  // Sending another profile's upload is refused before anything reaches Claude.
  const wsB = await connect({ cookie: b });
  wsB.send(JSON.stringify({ t: 'new' }));
  const created = await next(wsB, (m) => m.t === 'created').catch(() => null);
  wsB.send(JSON.stringify({ t: 'send', chatId: created?.chatId, text: '', attachments: [file.id] }));
  const refused = await next(wsB, (m) => m.t === 'error').catch(() => null);
  check(/doesn't exist/.test(refused?.message || ''), 'a message can\'t attach another profile\'s file');
  wsB.close();
  check((await http('DELETE', `/api/uploads/${file.id}`, { cookie: a })).status === 200 && !fs.existsSync(path.join(tmp, 'uploads', 'smoke-a', file.id)),
    'the owner removes an unsent file');
}

try {
  await run();
} catch (err) {
  failures++;
  console.log(`FAIL  ${err.message}`);
} finally {
  server.kill();
  await new Promise((r) => server.exitCode !== null ? r() : server.once('exit', r));
  try { fs.rmSync(tmp, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 }); }
  catch { console.log(`Couldn't remove ${tmp}; delete it by hand.`); }
}
if (failures) {
  console.log(`\n${failures} check${failures === 1 ? '' : 's'} failed. Server output:\n${serverLog}`);
  process.exit(1);
}
console.log('\nAll smoke checks passed.');
