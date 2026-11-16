// What the installed app adds beyond the page. Each part is skipped in a browser without it.
//   Launches: with launch_handler focus-existing (manifest), opening Nova or one of its
//     shortcuts while a window is open brings that window forward instead of opening another;
//     the address it was asked for arrives here and is routed like a #view link.
//   Notifications: "Nova finished" and "needs you". Opt-in per browser (Settings, Your profile).
//     Where the browser supports Web Push (Edge, Chrome, Firefox, Safari in an iPhone or iPad
//     home-screen app), the server sends them through the service worker (sw.js), so they arrive
//     with Nova closed too, and the page shows none of its own. Elsewhere the page shows them
//     while it's open but not in front. Each tab tells the server whether it's in front
//     ('front'), and nothing is pushed while one of the profile's windows is.
//   Badge: the number of chats waiting for you on the app's icon: an approval or question
//     to answer, or a reply you haven't opened yet.
// It learns about chats from chat/chats.js, which passes every server message to onServer().
import { api } from '../lib/api.js';

// ctx: { state, store, titleOf(chatId), goToChat(chatId), route(hash), send(payload) }
export function initPwa(ctx) {
  const asks = new Map();      // chatId -> Set of reqIds waiting for an answer
  const awayDone = new Set();  // chats that finished while Nova wasn't in front, the open one included
  const notified = new Set();  // events already notified, so replayed ones don't alert again

  // ---- Launches -------------------------------------------------------------
  // Called once the app is ready to route; the launch that opened this window arrives too.
  function listenForLaunches() {
    if (!('launchQueue' in window)) return;
    window.launchQueue.setConsumer((params) => {
      if (params.targetURL) ctx.route(new URL(params.targetURL).hash);
    });
  }

  // ---- Badge ----------------------------------------------------------------
  function paintBadge() {
    if (!('setAppBadge' in navigator)) return;
    const waiting = new Set([...ctx.state.unread, ...awayDone]);
    for (const [id, reqs] of asks) if (reqs.size) waiting.add(id);
    const n = [...waiting].filter((id) => ctx.state.chats.some((c) => c.id === id)).length;
    (n ? navigator.setAppBadge(n) : navigator.clearAppBadge()).catch(() => {});
  }

  const away = () => document.visibilityState === 'hidden' || !document.hasFocus();
  const back = () => { if (!away() && awayDone.size) { awayDone.clear(); paintBadge(); } };
  window.addEventListener('focus', back);
  document.addEventListener('visibilitychange', back);

  // Tell the server whether this tab is in front, when that changes and on every (re)connect.
  let front = null;
  function reportFront(force = false) {
    const on = !away();
    if (on === front && !force) return;
    if (ctx.send({ t: 'front', on })) front = on;
  }
  for (const ev of ['focus', 'blur']) window.addEventListener(ev, () => reportFront());
  document.addEventListener('visibilitychange', () => reportFront());

  // ---- Notifications --------------------------------------------------------
  const supported = 'Notification' in window;
  const canPush = supported && 'serviceWorker' in navigator && 'PushManager' in window;
  const form = document.getElementById('notifyForm');
  const wanted = () => supported && Notification.permission === 'granted' && ctx.store.get('notify', false) === true;
  let pushing = false; // this browser's alerts come from the server, so the page shows none itself
  const clip = (s, n = 120) => (s.length > n ? `${s.slice(0, n - 1)}…` : s);

  // One notification per chat at a time (tag): a newer one replaces the last.
  function show(title, body, chatId) {
    try {
      const n = new Notification(title, { body: clip(body), tag: `nova-chat-${chatId}`, icon: '/icons/icon-192.png' });
      n.onclick = () => { window.focus(); if (chatId) ctx.goToChat(chatId); n.close(); };
      return true;
    } catch { return false; } // only possible through a service worker in this browser
  }
  function notify(key, title, body, chatId) {
    if (pushing || !wanted() || !away() || notified.has(key)) return;
    notified.add(key);
    show(title, body, chatId);
  }

  function setStatus(text, isError = false) {
    const s = form.querySelector('.form-status');
    s.textContent = text;
    s.classList.toggle('error', isError);
  }
  function paintSwitch() { form.notify.checked = wanted(); }

  // ---- Push (service worker) ------------------------------------------------
  const b64u = (buf) => btoa(String.fromCharCode(...new Uint8Array(buf))).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
  const fromB64u = (s) => Uint8Array.from(atob(s.replace(/-/g, '+').replace(/_/g, '/')), (c) => c.charCodeAt(0));

  // Subscribes this browser (or reuses its subscription) and saves it under this sign-in. A
  // subscription made with an older server key is replaced.
  async function subscribePush() {
    const reg = await navigator.serviceWorker.register('/sw.js');
    await navigator.serviceWorker.ready;
    const { key } = await api('GET', '/api/push');
    let sub = await reg.pushManager.getSubscription();
    if (sub && sub.options?.applicationServerKey && b64u(sub.options.applicationServerKey) !== key) { await sub.unsubscribe(); sub = null; }
    sub ||= await reg.pushManager.subscribe({ userVisibleOnly: true, applicationServerKey: fromB64u(key) });
    await api('POST', '/api/push', sub.toJSON());
    pushing = true;
    return sub;
  }
  async function unsubscribePush() {
    pushing = false;
    const sub = await (await navigator.serviceWorker.getRegistration('/'))?.pushManager.getSubscription();
    if (!sub) return;
    await api('DELETE', '/api/push', { endpoint: sub.endpoint }).catch(() => {});
    await sub.unsubscribe().catch(() => {});
  }

  async function turnOn() {
    if (!canPush) {
      if (!show('Notifications are on', 'Nova will tell you when it finishes or needs you while it isn\'t in front.', null)) {
        form.notify.checked = false;
        setStatus('This browser only shows notifications through push, which it doesn\'t support for Nova.', true);
        return;
      }
      ctx.store.set('notify', true);
      setStatus('Notifications are on in this browser.');
      return;
    }
    setStatus('Turning on…');
    let sub;
    try { sub = await subscribePush(); }
    catch (err) {
      form.notify.checked = false;
      setStatus(`This browser couldn't subscribe to notifications: ${err.message}`, true);
      return;
    }
    ctx.store.set('notify', true);
    try {
      await api('POST', '/api/push/test', { endpoint: sub.endpoint });
      setStatus('Notifications are on in this browser. A test notification is on its way.');
    } catch (err) { setStatus(err.message, true); }
  }

  if (canPush) {
    // A click on a notification while a Nova window is open (sw.js asks that window).
    navigator.serviceWorker.addEventListener('message', (e) => {
      if (e.data?.t === 'open_chat') ctx.goToChat(e.data.chatId);
      else if (e.data?.t === 'open_route' && /^[a-z]+$/.test(e.data.route || '')) ctx.route(`#${e.data.route}`);
    });
    // Renew the subscription on every start: it ties this browser to whoever is signed in now,
    // and replaces one the browser or a new server key ended.
    if (wanted()) subscribePush().catch((err) => console.warn('Push notifications unavailable:', err.message));
  }

  // iPhone and iPad offer notifications only in the home-screen app, not in a Safari tab.
  const iosTab = !supported && (/iPhone|iPad|iPod/.test(navigator.userAgent) || (navigator.platform === 'MacIntel' && navigator.maxTouchPoints > 1));
  if (iosTab && form) {
    form.hidden = false;
    form.notify.disabled = true;
    form.querySelector('.muted').textContent = 'On iPhone and iPad, add Nova to your Home Screen (Share, then Add to Home Screen) and open it from there to turn notifications on.';
  }

  if (supported && form) {
    form.hidden = false;
    if (canPush) form.querySelector('.muted').textContent = 'Saved in this browser only. They arrive even when Nova is closed, but not while one of your Nova windows is in front.';
    form.addEventListener('submit', (e) => e.preventDefault());
    form.notify.addEventListener('change', async () => {
      if (!form.notify.checked) {
        ctx.store.set('notify', false);
        if (canPush) await unsubscribePush();
        setStatus('Notifications are off in this browser.');
        return;
      }
      let permission = Notification.permission;
      if (permission === 'default') permission = await Notification.requestPermission();
      if (permission !== 'granted') {
        form.notify.checked = false;
        setStatus('This browser is blocking notifications from Nova. Allow them in its site settings for Nova, then turn this on again.', true);
        return;
      }
      await turnOn();
    });
    paintSwitch();
    // The permission can change in the browser's own settings while Nova is open.
    navigator.permissions?.query({ name: 'notifications' }).then((p) => { p.onchange = paintSwitch; }).catch(() => {});
  }

  // ---- Server events --------------------------------------------------------
  function onServer(m) {
    switch (m.t) {
      case 'permission': {
        if (!asks.has(m.chatId)) asks.set(m.chatId, new Set());
        asks.get(m.chatId).add(m.reqId);
        const question = m.toolName === 'AskUserQuestion';
        notify(`ask:${m.reqId}`, question ? 'Nova has a question' : 'Approval needed',
          question ? ctx.titleOf(m.chatId) : `${ctx.titleOf(m.chatId)}: ${m.title || m.toolName}`, m.chatId);
        break;
      }
      case 'permission_resolved': case 'permission_cancelled':
        asks.get(m.chatId)?.delete(m.reqId);
        break;
      case 'state':
        if (m.state === 'closed') asks.delete(m.chatId); // its prompts went with the process
        break;
      case 'chats_changed':
        if (m.deleted) { asks.delete(m.deleted); awayDone.delete(m.deleted); }
        break;
      case 'sdk':
        if (m.msg.type === 'result' && !m.msg.parent_tool_use_id) {
          if (away()) awayDone.add(m.chatId);
          const ok = !m.msg.subtype || m.msg.subtype === 'success';
          notify(`done:${m.msg.uuid || `${m.chatId}:${Date.now()}`}`, ok ? 'Nova finished' : 'Nova stopped',
            ok ? ctx.titleOf(m.chatId) : `${ctx.titleOf(m.chatId)} (${m.msg.subtype.replace(/_/g, ' ')})`, m.chatId);
        }
        break;
    }
  }

  // The connection came back: prompts may have been answered or dropped meanwhile. The open
  // chat's prompts are sent again when it reopens; other chats' show again when opened.
  function reset() { asks.clear(); paintBadge(); }

  return { onServer, paintBadge, reset, listenForLaunches, reportFront };
}
