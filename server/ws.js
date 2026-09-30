// The WebSocket: one per browser tab, signed in with the same cookie as the HTTP API and
// origin-checked to stop cross-site hijacking. Browsers send chat actions here (new, open,
// send, answer, mode, interrupt); the server pushes chat events, meta and notices to every
// tab of the profile through hub.js. See the wiki's websocket-protocol page for each message.
import { WebSocketServer } from 'ws';
import { UserError } from './core/errors.js';
import { hub } from './core/hub.js';
import { sameOrigin } from './http/respond.js';
import { profileFrom } from './accounts/auth.js';
import { publicMeta } from './claude/meta.js';
import { existingRunner, PERMISSION_MODES, EFFORTS } from './chat/runner.js';
import { ownedChat, createChat, sendMessage, changeMode, openChat } from './chat/chats.js';

export function attachSockets(server) {
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
  return wss;
}

async function handle(profile, ws, raw) {
  const m = JSON.parse(raw);
  const reply = (payload) => ws.send(JSON.stringify(payload));
  const effort = EFFORTS.includes(m.effort) ? m.effort : undefined;
  const model = typeof m.model === 'string' && m.model ? m.model : undefined;
  const mode = PERMISSION_MODES.includes(m.mode) ? m.mode : undefined;
  // A refusal about a chat shows in that chat's transcript.
  const refuse = (message) => reply({ t: 'error', chatId: m.chatId, message });

  switch (m.t) {
    case 'new':
      return reply({ t: 'created', chatId: createChat(profile, { model, effort, categoryId: m.categoryId }) });
    case 'open': {
      const chat = await openChat(profile, m.chatId);
      if (!chat) return reply({ t: 'error', message: 'Chat not found.' });
      reply({ t: 'history', chatId: m.chatId, messages: chat.messages, state: chat.state });
      for (const p of chat.replay) reply(p);
      return;
    }
    case 'send': {
      const row = ownedChat(profile, m.chatId);
      if (!row) return reply({ t: 'error', message: 'Chat not found.' });
      try {
        await sendMessage(profile, row, { text: String(m.text || '').trim(), attachments: m.attachments, model, effort, mode, clientId: m.clientId });
      } catch (err) {
        if (!(err instanceof UserError)) throw err;
        refuse(err.message);
      }
      return;
    }
    case 'answer':
      existingRunner(profile, m.chatId)?.answer(m.reqId, m.result || { behavior: 'deny' });
      return;
    case 'mode': {
      const row = ownedChat(profile, m.chatId);
      if (!row) return reply({ t: 'error', message: 'Chat not found.' });
      if (!mode) return refuse('That permission mode isn\'t available in Nova.');
      return changeMode(profile, row, mode);
    }
    case 'interrupt':
      await existingRunner(profile, m.chatId)?.interrupt();
  }
}
