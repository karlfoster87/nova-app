// The WebSocket to the server: one per tab. It reconnects with backoff (1 s doubling to 15 s),
// shows the link state in the header, and after a long outage checks whether the session
// ended. Messages are handed to onMessage; onOpen(reconnected) runs on every (re)connect.
// A heartbeat keeps it open through proxies that close quiet sockets (Cloudflare Tunnel), and
// spots a socket that died without closing, as a phone's does after sleeping: the browser
// says it's open but nothing arrives. When the page comes back into view the link is checked
// at once rather than at the next beat.
import { state, els } from '../state.js';
import { log } from '../presence/log.js';

const BEAT = 20000;      // how often an open socket says ping
const SILENT = 45000;    // nothing heard for this long means the socket is dead
const PROBE = 5000;      // after coming back into view, how long a ping may take

let retry = 0;
let lostAt = 0; // when the connection dropped, so the log says it once per outage
let handlers = null;
let heardAt = 0;
let retryTimer = 0, probeTimer = 0;

function setLink(s) {
  els.link.dataset.state = s;
  els.link.lastChild.textContent = { online: 'Online', connecting: 'Connecting', offline: 'Offline' }[s];
}

function open() {
  clearTimeout(retryTimer);
  const ws = new WebSocket(`${location.protocol === 'https:' ? 'wss' : 'ws'}://${location.host}/ws`);
  state.ws = ws;
  ws.onopen = () => {
    retry = 0;
    heardAt = Date.now();
    setLink('online');
    log('system', lostAt ? 'Reconnected to Nova' : 'Connected to Nova');
    const reconnected = !!lostAt;
    lostAt = 0;
    handlers.onOpen(reconnected);
  };
  ws.onmessage = (e) => {
    heardAt = Date.now();
    const m = JSON.parse(e.data);
    if (m.t !== 'pong') handlers.onMessage(m);
  };
  ws.onclose = (e) => lost(ws, e.code);
}

// The socket closed, or was given up on: say so once, then try again after the backoff.
function lost(ws, code) {
  if (ws !== state.ws) return; // an old socket finishing its close after a newer one opened
  ws.onopen = ws.onmessage = ws.onclose = null;
  clearTimeout(probeTimer);
  probeTimer = 0;
  if (!lostAt) { lostAt = Date.now(); log('error', 'Lost the connection to Nova. Reconnecting.'); }
  setLink(retry > 2 ? 'offline' : 'connecting');
  if (code === 1006 && retry > 3) { fetch('/api/me').then((r) => { if (r.status === 401) location.href = '/login'; }).catch(() => {}); }
  clearTimeout(retryTimer);
  retryTimer = setTimeout(open, Math.min(1000 * 2 ** retry++, 15000));
}

// A dead socket can take minutes to report closing, so it's dropped straight away.
function drop() {
  const ws = state.ws;
  if (!ws) return;
  lost(ws, 1006);
  try { ws.close(); } catch {}
}

function ping() {
  if (state.ws?.readyState === 1) state.ws.send('{"t":"ping"}');
}

setInterval(() => {
  if (document.hidden || state.ws?.readyState !== 1) return;
  if (Date.now() - heardAt > SILENT) drop();
  else ping();
}, BEAT);

// Back in view, online again or refocused: reconnect now if the link is down, or make sure
// an open socket still answers. The composer asks too when a sent message doesn't echo.
export function probe() {
  if (document.hidden || !handlers) return;
  const ws = state.ws;
  if (!ws || ws.readyState > 1) { retry = 0; open(); return; }
  if (ws.readyState !== 1 || probeTimer) return;
  const asked = Date.now();
  ping();
  probeTimer = setTimeout(() => { probeTimer = 0; if (ws === state.ws && heardAt < asked) drop(); }, PROBE);
}
document.addEventListener('visibilitychange', probe);
window.addEventListener('pageshow', probe);
window.addEventListener('online', probe);
window.addEventListener('focus', probe);

export function connect({ onMessage, onOpen }) {
  handlers = { onMessage, onOpen };
  open();
}

// True when the message went out; false while the link is down.
export function send(payload) {
  if (state.ws?.readyState !== 1) return false;
  state.ws.send(JSON.stringify(payload));
  return true;
}
