// Nova's service worker. It exists only for push notifications: it shows the alerts the server
// pushes while no Nova window is in front, and opens the chat when one is clicked. It has no
// fetch handler and caches nothing, so pages and app code always come straight from the server
// and updates stay instant. Served without a session (http/static.js), at the root for scope '/'.
self.addEventListener('install', () => self.skipWaiting());
self.addEventListener('activate', (e) => e.waitUntil(self.clients.claim()));

// Every push must show a notification: browsers (Safari above all) cancel the subscription of a
// site that receives pushes silently.
self.addEventListener('push', (e) => {
  let data = {};
  try { data = e.data?.json() || {}; } catch {}
  const chatId = typeof data.chatId === 'string' ? data.chatId : null;
  e.waitUntil(self.registration.showNotification(data.title || 'Nova', {
    body: data.body || '',
    // One per chat, as the page's own notifications do: a newer alert replaces the last.
    tag: chatId ? `nova-chat-${chatId}` : 'nova',
    icon: '/icons/icon-192.png',
    data: { chatId }
  }));
});

// Focus an open Nova window and ask it to open the chat; with none open, start one at the chat.
self.addEventListener('notificationclick', (e) => {
  e.notification.close();
  const chatId = e.notification.data?.chatId;
  e.waitUntil((async () => {
    const wins = await self.clients.matchAll({ type: 'window', includeUncontrolled: true });
    const win = wins.find((w) => new URL(w.url).origin === self.location.origin);
    if (win) {
      await win.focus().catch(() => {});
      if (chatId) win.postMessage({ t: 'open_chat', chatId });
      return;
    }
    await self.clients.openWindow(chatId ? `/#chats/${encodeURIComponent(chatId)}` : '/');
  })());
});
