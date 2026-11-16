// Push notifications: "Nova finished" and "Approval needed" reach a profile's browsers even when
// no Nova window is open. Each browser opts in from Settings and is tied to the sign-in that
// subscribed it, so only the profile signed in there is alerted, and signing out stops it.
// Nothing is pushed while one of the profile's windows is in front (the person is already
// looking). Each message is encrypted for its browser, so the browser maker's push service
// carries it without being able to read it. The encryption and signing are in webpush.js.
import fs from 'node:fs';
import path from 'node:path';
import { DATA_DIR } from '../core/config.js';
import { q } from '../core/db.js';
import { UserError } from '../core/errors.js';
import { hub } from '../core/hub.js';
import { generateVapidKeys, vapidPublicKey, validKeys, sendPush } from './webpush.js';

// Push services ask for a contact in the VAPID token; Apple refuses one that isn't a mailto: or
// https: address. Nova's project page says who runs the software without naming anyone.
const SUBJECT = 'https://github.com/karlfoster87/nova-app';

// Only the browsers' own push services. A subscription is a URL Nova will post to, so without
// this list a signed-in profile could point Nova at any address on its network.
const PUSH_HOSTS = [/\.notify\.windows\.com$/, /^web\.push\.apple\.com$/, /\.push\.apple\.com$/,
  /^fcm\.googleapis\.com$/, /^android\.googleapis\.com$/, /\.push\.services\.mozilla\.com$/];

// The VAPID key pair, made on first use and kept in the data folder. A new pair (a fresh data
// folder) makes every browser subscribe again; pwa.js does that by itself on its next start.
const KEY_FILE = path.join(DATA_DIR, 'push-keys.json');
let keys = null;
function vapid() {
  if (keys) return keys;
  try { keys = JSON.parse(fs.readFileSync(KEY_FILE, 'utf8')); } catch {}
  if (!keys?.jwk?.d) {
    keys = generateVapidKeys();
    fs.writeFileSync(KEY_FILE, JSON.stringify(keys), { mode: 0o600 });
  }
  return keys;
}
export const publicKey = () => vapidPublicKey(vapid().jwk);

function parseEndpoint(value) {
  let url;
  try { url = new URL(String(value || '')); } catch { url = null; }
  if (!url || url.protocol !== 'https:' || String(value).length > 2000 || !PUSH_HOSTS.some((re) => re.test(url.hostname))) {
    throw new UserError('That isn\'t a push address Nova recognises. Notifications work in Edge, Chrome, Firefox and Safari on iPhone and iPad.');
  }
  return url.href;
}

export function subscribe(profile, login, body) {
  const endpoint = parseEndpoint(body?.endpoint);
  const { p256dh, auth } = body?.keys || {};
  if (!validKeys(p256dh, auth)) throw new UserError('This browser sent a subscription Nova can\'t use. Turn notifications off and on again.');
  q.addPushSub.run(endpoint, profile, login, p256dh, auth, Date.now());
  console.log(`${profile} turned on push notifications in a browser.`);
}

export function unsubscribe(profile, endpoint) {
  q.deletePushSub.run(String(endpoint || ''), profile);
}

// Sends to one subscription and deals with the answer. True when the push service took it.
async function deliver(sub, payload, urgency) {
  try {
    const status = await sendPush(sub, payload, { jwk: vapid().jwk, subject: SUBJECT, urgency });
    if (status === 404 || status === 410) { q.dropPushSub.run(sub.endpoint); return false; }
    if (status >= 200 && status < 300) return true;
    console.error(`Push to ${new URL(sub.endpoint).hostname} was refused (${status}).`);
  } catch (err) {
    console.error(`Push to ${new URL(sub.endpoint).hostname} failed: ${err.message}`);
  }
  return false;
}

// "Send a test" from Settings, to the browser that asked.
export async function testPush(profile, endpoint) {
  const sub = q.pushSub.get(String(endpoint || ''), profile);
  if (!sub) throw new UserError('This browser isn\'t subscribed yet. Turn notifications off and on again.', 404);
  const ok = await deliver(sub, { title: 'Notifications are on', body: 'Nova will tell you here when it finishes or needs you.' }, 'normal');
  if (!ok) throw new UserError('The browser\'s push service didn\'t accept the test. Check that Nova\'s server can reach the internet, then try again.', 502);
}

const chatTitle = (chatId) => q.chat.get(chatId)?.title || 'New chat';

// ---- What a notification says ---------------------------------------------------------
// The title names the chat (the system already shows it's from Nova). The body is Nova's reply
// itself when it's short and plain enough to read on a lock screen, and otherwise a sentence
// saying what Nova is waiting for. Payloads are encrypted for the browser (webpush.js), so the
// push service can't read them; the lock screen can, which is why long replies aren't cut up.
const SHORT = 180; // about four lines on a phone's lock screen

// Markdown to one line of plain text. Null when it holds code or a table, which don't read as a
// notification, or when it's too long.
export function shortText(md) {
  const s = String(md || '');
  if (!s.trim() || /```|~~~|^\s*\|.*\|\s*$/m.test(s)) return null;
  const text = s
    .replace(/!\[[^\]]*\]\([^)]*\)/g, '')
    .replace(/\[([^\]]*)\]\([^)]*\)/g, '$1')
    .replace(/`([^`]*)`/g, '$1')
    .replace(/^\s{0,3}(#{1,6}\s+|>\s?|[-*+]\s+|\d+[.)]\s+)/gm, '')
    .replace(/(\*\*|~~)(\S(?:.*?\S)?)\1/g, '$2')
    .replace(/\s+/g, ' ').trim();
  return text && text.length <= SHORT ? text : null;
}

const base = (p) => String(p || '').split(/[\\/]/).pop();
const FILE_VERBS = { Read: 'read', Edit: 'edit', MultiEdit: 'edit', Write: 'write', NotebookEdit: 'edit' };

// What Nova wants to do, in words, for an approval. Nova's own tools describe themselves
// (chat/tools.js describeCall); a shell command or a file is named when it's short.
function approvalText(toolName, input = {}, described) {
  if (described) return `Nova needs your approval to ${described.charAt(0).toLowerCase()}${described.slice(1)}.`;
  const command = typeof input.command === 'string' ? input.command.replace(/\s+/g, ' ').trim() : '';
  if (toolName === 'Bash' && command && command.length <= 120) return `Nova needs your approval to run: ${command}`;
  const file = base(input.file_path || input.notebook_path);
  if (FILE_VERBS[toolName] && file) return `Nova needs your approval to ${FILE_VERBS[toolName]} ${file}.`;
  return `Nova needs your approval to use ${toolName.replace(/^mcp__[^_]+__/, '')}.`;
}

function questionText(input = {}) {
  const qs = Array.isArray(input.questions) ? input.questions : [];
  const one = qs.length === 1 && shortText(qs[0]?.question);
  if (one) return one;
  return qs.length > 1 ? `Nova is awaiting your response to ${qs.length} questions.` : 'Nova is awaiting your response to a question.';
}

// The body for each kind of event:
//   done     { text }                       the turn's final reply
//   stopped  { reason }                     the result's subtype, e.g. 'error max turns'
//   approval { toolName, input, described }
//   question { input }                      AskUserQuestion's input
export function pushBody(kind, info = {}) {
  const body = {
    done: () => shortText(info.text) || 'Nova has completed your request and is waiting on your response.',
    stopped: () => `Nova stopped before finishing${info.reason ? ` (${info.reason})` : ''}.`,
    approval: () => approvalText(info.toolName || 'a tool', info.input, info.described),
    question: () => questionText(info.input)
  }[kind]();
  return body.length > 240 ? `${body.slice(0, 239)}…` : body;
}

// An alert that isn't about one chat: a question or held-back action from an unattended Heartbeat
// run. route is the place in Nova a click opens ('thought'). Never throws, and like chat alerts it
// stays quiet while one of the profile's windows is in front, where the Core tab's count shows it.
export function pushNotice(profile, { title, body, route }) {
  try {
    if (hub.inFront(profile)) return;
    const subs = q.pushSubs.all(profile, Date.now());
    const text = String(body || '');
    for (const sub of subs) deliver(sub, { title, body: text.length > 240 ? `${text.slice(0, 239)}…` : text, route }, 'normal');
  } catch (err) {
    console.error('Push notification failed:', err.message);
  }
}

// Called by the chat runner. Never throws: an alert that can't go is only logged.
export function pushChatEvent(profile, chatId, kind, info = {}) {
  try {
    if (hub.inFront(profile)) return;
    const subs = q.pushSubs.all(profile, Date.now());
    if (!subs.length) return;
    const payload = { title: chatTitle(chatId), body: pushBody(kind, info), chatId };
    const urgency = kind === 'approval' || kind === 'question' ? 'high' : 'normal';
    for (const sub of subs) deliver(sub, payload, urgency);
  } catch (err) {
    console.error('Push notification failed:', err.message);
  }
}
