// What the installed app adds beyond the page. Each part is skipped in a browser without it.
//   Launches: with launch_handler focus-existing (manifest), opening Nova or one of its
//     shortcuts while a window is open brings that window forward instead of opening another;
//     the address it was asked for arrives here and is routed like a #view link.
//   Notifications: "Nova finished" and "needs you" while this window or tab is open but not
//     in front. Opt-in per browser (Settings, Your profile). Browsers that only show
//     notifications through a service worker (Android) can't use them yet.
//   Badge: the number of chats waiting for you on the app's icon: an approval or question
//     to answer, or a reply you haven't opened yet.
// It learns about chats from chat/chats.js, which passes every server message to onServer().

// ctx: { state, store, titleOf(chatId), goToChat(chatId), route(hash) }
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

  // ---- Notifications --------------------------------------------------------
  const supported = 'Notification' in window;
  const form = document.getElementById('notifyForm');
  const wanted = () => supported && Notification.permission === 'granted' && ctx.store.get('notify', false) === true;
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
    if (!wanted() || !away() || notified.has(key)) return;
    notified.add(key);
    show(title, body, chatId);
  }

  function setStatus(text, isError = false) {
    const s = form.querySelector('.form-status');
    s.textContent = text;
    s.classList.toggle('error', isError);
  }
  function paintSwitch() { form.notify.checked = wanted(); }

  if (supported && form) {
    form.hidden = false;
    form.addEventListener('submit', (e) => e.preventDefault());
    form.notify.addEventListener('change', async () => {
      if (!form.notify.checked) {
        ctx.store.set('notify', false);
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
      if (!show('Notifications are on', 'Nova will tell you when it finishes or needs you while it isn\'t in front.', null)) {
        form.notify.checked = false;
        setStatus('This browser only shows notifications from apps that run a service worker, which Nova doesn\'t use yet.', true);
        return;
      }
      ctx.store.set('notify', true);
      setStatus('Notifications are on in this browser.');
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

  return { onServer, paintBadge, reset, listenForLaunches };
}
