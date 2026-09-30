// The right-hand panel: the avatar, Claude's status, sub-agents with their link
// activity, a mini log, and the full log in its own tab. It learns about the app only from
// the 'nova:presence' and 'nova:log' window events, and never reaches into the transcript.
import { $, h, svgIcon } from '../lib/dom.js';
import { store } from '../lib/store.js';
import { AVATARS, mountAvatar } from './avatars.js';
import { log, logEntries, clearLog, clockTime, KINDS } from './log.js';

const panel = $('presence');
const stage = $('avatarStage');
const picker = $('avatarSelect');
const agentsEl = $('agents');
const logList = $('logList');
const badge = $('logBadge');

let now = { state: 'idle', label: 'Ready', agents: [], recent: [] };

// ---- Avatar -----------------------------------------------------------------
let avatar = null;
picker.append(...AVATARS.map((a) => new Option(a.label, a.id)));
function useAvatar(id, announce = false) {
  if (!AVATARS.some((a) => a.id === id)) id = AVATARS[0].id;
  avatar?.destroy();
  picker.value = id;
  stage.dataset.avatar = id;
  avatar = mountAvatar(id, stage);
  avatar.set(now.state, { agents: now.agents.length });
  store.set('avatar', id);
  if (announce) log('system', `Avatar switched to ${AVATARS.find((a) => a.id === id).label}`);
}
picker.addEventListener('change', () => useAvatar(picker.value, true));
useAvatar(store.get('avatar', 'ripple'));

// ---- Tabs -------------------------------------------------------------------
const tabs = [...panel.querySelectorAll('[data-ptab]')];
let tab = 'avatar';
function showTab(name) {
  tab = name;
  for (const t of tabs) {
    const on = t.dataset.ptab === name;
    t.setAttribute('aria-selected', String(on));
    t.tabIndex = on ? 0 : -1;
  }
  for (const p of panel.querySelectorAll('[data-ppane]')) p.hidden = p.dataset.ppane !== name;
  if (name === 'logs') { unseen = 0; paintBadge(); renderLogList(); }
  store.set('presenceTab', name);
}
for (const t of tabs) t.addEventListener('click', () => showTab(t.dataset.ptab));
panel.querySelector('.ptabs').addEventListener('keydown', (e) => {
  if (e.key !== 'ArrowRight' && e.key !== 'ArrowLeft') return;
  const next = tabs[(tabs.indexOf(document.activeElement) + 1) % tabs.length];
  next.focus();
  showTab(next.dataset.ptab);
});

// ---- Status -----------------------------------------------------------------
window.addEventListener('nova:presence', (e) => {
  now = { agents: [], recent: [], ...e.detail };
  panel.dataset.state = now.state;
  $('presenceLabel').textContent = now.label;
  avatar?.set(now.state, { agents: now.agents.length });
  renderAgents();
});

// ---- Sub-agents ---------------------------------------------------------------
// One row per agent, reused by id so its animations don't restart on every update.
// Running agents first, then ones that finished in the last half minute.
const AGENT_ICONS = [
  [/explore|search|find|research/i, 'M11 18a7 7 0 1 0 0-14 7 7 0 0 0 0 14ZM20 20l-4-4'],
  [/plan|architect|design/i, 'M4 6.5 9 4l6 2.5L20 4v13.5L15 20l-6-2.5L4 20ZM9 4v13.5M15 6.5V20'],
  [/review|test|check|verify|audit/i, 'M4 4h16v16H4ZM8 12l3 3 5-6'],
  [/write|doc|edit|creative/i, 'M4 20h4L19 9l-4-4L4 16ZM13.5 6.5l4 4'],
  [/data|analy|stat/i, 'M5 20V10M12 20V4M19 20v-7'],
  [/.*/, 'M12 2.5 20.2 7.2v9.6L12 21.5l-8.2-4.7V7.2ZM12 8.5a3.5 3.5 0 1 0 0 7 3.5 3.5 0 0 0 0-7Z']
];
const STATE_TEXT = { starting: 'Starting', working: 'Working', tool: 'Using a tool', done: 'Finished', failed: 'Failed', stopped: 'Stopped' };
const el = (tag, cls, ...kids) => h(tag, { class: cls }, ...kids);

function elapsed(ms) {
  const s = Math.max(0, Math.floor(ms / 1000));
  return s < 60 ? `${s}s` : `${Math.floor(s / 60)}m ${String(s % 60).padStart(2, '0')}s`;
}

function agentRow(a) {
  const li = el('li', 'agent');
  li.dataset.id = a.id;
  const ring = el('span', 'agent-ring', svgIcon(AGENT_ICONS.find(([re]) => re.test(a.name))[1]));
  ring.setAttribute('aria-hidden', 'true');
  const name = el('span', 'agent-name', el('i'), el('span'));
  const wave = el('span', 'wave', ...Array.from({ length: 9 }, () => el('i')));
  wave.setAttribute('aria-hidden', 'true');
  li.append(ring, el('div', 'agent-text', name, el('span', 'agent-task'), el('small', 'agent-detail')), wave);
  return li;
}

function paintAgent(li, a) {
  li.dataset.state = a.state || 'working';
  li.querySelector('.agent-name span').textContent = a.name;
  li.querySelector('.agent-task').textContent = a.task || STATE_TEXT[li.dataset.state];
  const ended = a.endedAt != null;
  const time = a.startedAt ? elapsed((ended ? a.endedAt : Date.now()) - a.startedAt) : '';
  const bits = [ended || !a.detail ? STATE_TEXT[li.dataset.state] : a.detail,
    a.toolUses ? `${a.toolUses} tool ${a.toolUses === 1 ? 'call' : 'calls'}` : '', time].filter(Boolean);
  li.querySelector('.agent-detail').textContent = bits.join(' · ');
  li.setAttribute('aria-label', `${a.name}: ${STATE_TEXT[li.dataset.state]}. ${a.task || ''}`);
}

function renderAgents() {
  const list = [...now.agents, ...now.recent.filter((r) => !now.agents.some((a) => a.id === r.id))];
  const existing = new Map([...agentsEl.querySelectorAll('.agent')].map((li) => [li.dataset.id, li]));
  const rows = list.map((a) => { const li = existing.get(a.id) || agentRow(a); paintAgent(li, a); return li; });
  if (!rows.length) {
    if (!agentsEl.querySelector('.agents-empty')) {
      agentsEl.replaceChildren(el('li', 'agents-empty', 'No sub-agents running. When Claude hands work to one, it shows here with its link activity.'));
    }
  } else {
    agentsEl.querySelector('.agents-empty')?.remove();
    rows.forEach((li, i) => { if (agentsEl.children[i] !== li) agentsEl.insertBefore(li, agentsEl.children[i] || null); });
    while (agentsEl.children.length > rows.length) agentsEl.lastElementChild.remove();
  }
  const running = now.agents.length;
  agentsEl.classList.toggle('active', running > 0);
  agentsEl.classList.toggle('none', !rows.length);
  const count = $('agentCount');
  count.textContent = running ? `${running} running` : rows.length ? 'All finished' : 'None running';
  count.classList.toggle('live', running > 0);
}
// Elapsed times tick while an agent runs.
setInterval(() => { if (now.agents.length) for (const a of now.agents) { const li = agentsEl.querySelector(`[data-id="${CSS.escape(a.id)}"]`); if (li) paintAgent(li, a); } }, 1000);
renderAgents();

// ---- Log ----------------------------------------------------------------------
const MINI = 5;
const KIND_TAGS = { chat: 'Chat', tool: 'Tool', agent: 'Agent', prompt: 'Prompt', error: 'Error', system: 'System' };
let filter = store.get('logFilter', 'all');
let unseen = 0; // prompts and errors that arrived while the Logs tab was closed

const filterButtons = [['all', 'All'], ...Object.entries(KINDS)].map(([id, label]) => {
  const b = el('button', null, label);
  b.type = 'button';
  b.dataset.kind = id;
  b.addEventListener('click', () => { filter = id; store.set('logFilter', id); paintFilters(); renderLogList(); });
  return b;
});
$('logFilters').append(...filterButtons);
function paintFilters() { for (const b of filterButtons) b.setAttribute('aria-pressed', String(b.dataset.kind === filter)); }
paintFilters();
$('logClear').addEventListener('click', () => clearLog());

function paintBadge() {
  badge.hidden = !unseen;
  badge.textContent = unseen > 99 ? '99+' : String(unseen);
  tabs[1].setAttribute('aria-label', unseen ? `Logs, ${unseen} new ${unseen === 1 ? 'alert' : 'alerts'}` : 'Logs');
}

function miniRow(e) {
  return el('li', null, el('span', 'log-time', `[${clockTime(e.at)}]`), el('span', `k-${e.kind}`, e.text));
}
function logRow(e) {
  const text = el('span', 'log-text', e.text);
  if (e.where) text.append(' ', el('span', 'log-where', `in ${e.where}`));
  return el('li', null, el('span', 'log-time', clockTime(e.at)), el('span', `log-kind k-${e.kind}`, KIND_TAGS[e.kind] || e.kind), text);
}
const shown = (e) => filter === 'all' || e.kind === filter;

function renderMini() {
  const last = logEntries().slice(-MINI);
  $('miniLog').replaceChildren(...(last.length ? last.map(miniRow) : [el('li', 'k-system', 'Nothing logged yet.')]));
}
function renderLogList() {
  if (tab !== 'logs') return;
  const rows = logEntries().filter(shown).map(logRow);
  logList.replaceChildren(...(rows.length ? rows : [el('li', 'log-empty', filter === 'all' ? 'Nothing logged yet.' : 'Nothing of this kind logged yet.')]));
  logList.scrollTop = logList.scrollHeight;
}

window.addEventListener('nova:log', (e) => {
  const { entry } = e.detail;
  renderMini();
  if (!entry) { renderLogList(); return; } // cleared, or a fresh log after sign-in
  if (tab === 'logs') {
    if (!shown(entry)) return;
    const atEnd = logList.scrollHeight - logList.scrollTop - logList.clientHeight < 40;
    logList.querySelector('.log-empty')?.remove();
    logList.append(logRow(entry));
    while (logList.children.length > 400) logList.firstElementChild.remove();
    if (atEnd) logList.scrollTop = logList.scrollHeight;
  } else if (entry.kind === 'error' || entry.kind === 'prompt') {
    unseen++;
    paintBadge();
  }
});
renderMini();
showTab(store.get('presenceTab', 'avatar') === 'logs' ? 'logs' : 'avatar');
