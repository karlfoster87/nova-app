// Push notifications: "Nova finished" and "Approval needed" reach a profile's browsers even when
// no Nova window is open. Each browser opts in from Settings and is tied to the sign-in that
// subscribed it, so only the profile signed in there is alerted, and signing out stops it.
// Nothing is pushed while one of the profile's windows is in front (the person is already
// looking), and a message carries only a title and the chat's name, because it passes through
// the browser maker's push service. The encryption and signing are in webpush.js.
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

// Called by the chat runner. Never throws: an alert that can't go is only logged.
// kind: 'done' | 'stopped' | 'approval' | 'question'
export function pushChatEvent(profile, chatId, kind, detail = '') {
  if (hub.inFront(profile)) return;
  const subs = q.pushSubs.all(profile, Date.now());
  if (!subs.length) return;
  const name = chatTitle(chatId);
  const [title, body] = {
    done: ['Nova finished', name],
    stopped: ['Nova stopped', detail ? `${name} (${detail})` : name],
    approval: ['Approval needed', detail ? `${name}: ${detail}` : name],
    question: ['Nova has a question', name]
  }[kind];
  const payload = { title, body: body.length > 120 ? `${body.slice(0, 119)}…` : body, chatId };
  const urgency = kind === 'approval' || kind === 'question' ? 'high' : 'normal';
  for (const sub of subs) deliver(sub, payload, urgency);
}
