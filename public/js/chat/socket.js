// The WebSocket to the server: one per tab. It reconnects with backoff (1 s doubling to 15 s),
// shows the link state in the header, and after a long outage checks whether the session
// ended. Messages are handed to onMessage; onOpen(reconnected) runs on every (re)connect.
import { state, els } from '../state.js';
import { log } from '../presence/log.js';

let retry = 0;
let lostAt = 0; // when the connection dropped, so the log says it once per outage
let handlers = null;

function setLink(s) {
  els.link.dataset.state = s;
  els.link.lastChild.textContent = { online: 'Online', connecting: 'Connecting', offline: 'Offline' }[s];
}

function open() {
  const ws = new WebSocket(`${location.protocol === 'https:' ? 'wss' : 'ws'}://${location.host}/ws`);
  state.ws = ws;
  ws.onopen = () => {
    retry = 0;
    setLink('online');
    log('system', lostAt ? 'Reconnected to Nova' : 'Connected to Nova');
    const reconnected = !!lostAt;
    lostAt = 0;
    handlers.onOpen(reconnected);
  };
  ws.onmessage = (e) => handlers.onMessage(JSON.parse(e.data));
  ws.onclose = (e) => {
    if (!lostAt) { lostAt = Date.now(); log('error', 'Lost the connection to Nova. Reconnecting.'); }
    setLink(retry > 2 ? 'offline' : 'connecting');
    if (e.code === 1006 && retry > 3) { fetch('/api/me').then((r) => { if (r.status === 401) location.href = '/login'; }); }
    setTimeout(open, Math.min(1000 * 2 ** retry++, 15000));
  };
}

export function connect({ onMessage, onOpen }) {
  handlers = { onMessage, onOpen };
  open();
}

export const send = (payload) => state.ws?.readyState === 1 && state.ws.send(JSON.stringify(payload));
