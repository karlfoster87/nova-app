import { Transcript, fileChip, toolSummary, AGENT_TOOLS, h, pictureUrl } from '/render.js';
import { initSettings, showRestarting } from '/settings.js';
import { initSidebar } from '/sidebar.js';
import { openLog, log } from '/log.js';
import '/presence.js'; // the avatar and logs panel; it listens for nova:presence and nova:log

const $ = (id) => document.getElementById(id);
const els = {
  profile: $('profileName'), chatList: $('chatList'), transcript: $('transcript'),
  model: $('modelSelect'), effort: $('effortSelect'), effortWrap: $('effortWrap'), mode: $('modeSelect'), usage: $('usage'),
  input: $('input'), composer: $('composer'), send: $('sendBtn'), stop: $('stopBtn'),
  attachList: $('attachList'), attachBtn: $('attachBtn'), fileInput: $('fileInput'),
  presence: $('presence'), sidebar: $('sidebar'),
  chatTitle: $('chatTitle'), chatWhere: $('chatWhere'), chatState: $('chatState'), link: $('linkState')
};

const store = {
  get: (k, d) => { try { return JSON.parse(localStorage.getItem(`nova.${k}`)) ?? d; } catch { return d; } },
  set: (k, v) => { try { localStorage.setItem(`nova.${k}`, JSON.stringify(v)); } catch {} }
};

// Theme: dark unless this browser picked light or the system's (Settings → Your profile).
// data-scheme is what's showing (system resolved), for CSS and the avatars to follow.
const THEMES = { dark: 'Dark', light: 'Light', system: 'Match the system' };
const systemLight = matchMedia('(prefers-color-scheme: light)');
function applyTheme(theme) {
  const t = THEMES[theme] ? theme : 'dark';
  document.documentElement.dataset.theme = t;
  document.documentElement.dataset.scheme = t === 'system' ? (systemLight.matches ? 'light' : 'dark') : t;
}
systemLight.addEventListener('change', () => applyTheme(document.documentElement.dataset.theme));
applyTheme(store.get('theme', 'dark'));
const themeForm = $('themeForm');
themeForm.theme.value = document.documentElement.dataset.theme;
themeForm.addEventListener('submit', (e) => e.preventDefault());
themeForm.theme.addEventListener('change', () => {
  store.set('theme', themeForm.theme.value);
  applyTheme(themeForm.theme.value);
  themeForm.querySelector('.form-status').textContent = `Theme set to ${THEMES[themeForm.theme.value].toLowerCase()} in this browser.`;
});

const state = {
  me: null,
  meta: null,
  chats: [],
  chatState: new Map(),   // chatId -> idle | running | closed
  unread: new Set(),
  transcripts: new Map(), // chatId -> Transcript
  current: null,          // chatId or null for an unsent new chat
  pending: null,          // { text, attachments } of a new chat's first message, waiting for its id
  attachments: [],        // files in the composer: { key, name, size, type, id?, progress?, error?, xhr? }
  draft: { categoryId: null }, // where the unsent new chat will be filed
  categories: [],
  ws: null
};

// ---- WebSocket ------------------------------------------------------------
let retry = 0;
let lostAt = 0; // when the connection dropped, so the log says it once per outage
function setLink(s) {
  els.link.dataset.state = s;
  els.link.lastChild.textContent = { online: 'Online', connecting: 'Connecting', offline: 'Offline' }[s];
}
function connect() {
  const ws = new WebSocket(`${location.protocol === 'https:' ? 'wss' : 'ws'}://${location.host}/ws`);
  state.ws = ws;
  ws.onopen = () => {
    retry = 0;
    setLink('online');
    log('system', lostAt ? 'Reconnected to Nova' : 'Connected to Nova');
    lostAt = 0;
    if (state.current) { state.transcripts.delete(state.current); openChat(state.current); }
  };
  ws.onmessage = (e) => onServer(JSON.parse(e.data));
  ws.onclose = (e) => {
    if (!lostAt) { lostAt = Date.now(); log('error', 'Lost the connection to Nova. Reconnecting.'); }
    setLink(retry > 2 ? 'offline' : 'connecting');
    if (e.code === 1006 && retry > 3) { fetch('/api/me').then((r) => { if (r.status === 401) location.href = '/login'; }); }
    setTimeout(connect, Math.min(1000 * 2 ** retry++, 15000));
  };
}
const send = (payload) => state.ws?.readyState === 1 && state.ws.send(JSON.stringify(payload));

function transcriptFor(chatId) {
  let t = state.transcripts.get(chatId);
  if (!t) {
    t = new Transcript(chatId, {
      onAnswer: (reqId, result) => send({ t: 'answer', chatId, reqId, result }),
      onChange: () => { if (chatId === state.current) { stickToBottom(); updatePresence(); } }
    });
    state.transcripts.set(chatId, t);
  }
  return t;
}

// ---- Activity log ---------------------------------------------------------
// Turns server events into log lines. Called before an event changes any state, so a
// state change can be compared with what it was. Replayed events (prompts re-sent on
// reconnect, task progress on open) are logged once.
const logged = new Set();
const once = (key) => !logged.has(key) && logged.add(key);
const toolNames = new Map();  // tool_use_id -> tool name, to name a failure
const agentNames = new Map(); // Agent tool_use_id or task id -> sub-agent type
const titleOf = (id) => state.chats.find((c) => c.id === id)?.title || 'New chat';
const withSummary = (name, input) => { const s = toolSummary(name, input); return s ? `${name}: ${s}` : name; };

function logEvent(m) {
  const where = m.chatId ? titleOf(m.chatId) : '';
  switch (m.t) {
    case 'state': {
      const before = state.chatState.get(m.chatId);
      if (m.state === 'running' && before !== 'running') log('chat', 'Claude started working', where);
      else if (m.state === 'closed' && before && before !== 'closed') log('system', 'Chat process closed', where);
      return;
    }
    case 'permission':
      if (once(`req:${m.reqId}`)) log('prompt', m.toolName === 'AskUserQuestion' ? 'Claude asked you a question' : `Approval needed: ${m.title || m.toolName}`, where);
      return;
    case 'permission_resolved': log('prompt', 'Prompt answered', where); return;
    case 'permission_cancelled': log('prompt', 'Prompt withdrawn', where); return;
    case 'error': log('error', m.message, where); return;
    case 'restarting': log('system', 'Nova is restarting'); return;
    case 'mode': {
      const chat = state.chats.find((c) => c.id === m.chatId);
      if (chat && chat.permission_mode !== m.mode) log('system', `Permissions set to ${[...els.mode.options].find((o) => o.value === m.mode)?.text || m.mode}`, where);
      return;
    }
    case 'sdk': break;
    default: return;
  }
  const msg = m.msg;
  if (msg.type === 'assistant') {
    for (const b of msg.message?.content || []) {
      if (b.type !== 'tool_use' || !once(`tool:${b.id}`)) continue;
      toolNames.set(b.id, b.name);
      if (msg.parent_tool_use_id) log('agent', `${agentNames.get(msg.parent_tool_use_id) || 'Sub-agent'} used ${withSummary(b.name, b.input)}`, where);
      else if (AGENT_TOOLS.has(b.name)) {
        const name = b.input?.subagent_type || 'a sub-agent';
        agentNames.set(b.id, b.input?.subagent_type || 'Sub-agent');
        log('agent', `Delegated to ${name}${b.input?.description ? `: ${b.input.description}` : ''}`, where);
      } else log('tool', withSummary(b.name, b.input), where);
    }
  } else if (msg.type === 'user' && Array.isArray(msg.message?.content)) {
    for (const b of msg.message.content) {
      if (b.type === 'tool_result' && b.is_error && once(`err:${b.tool_use_id}`)) log('error', `${toolNames.get(b.tool_use_id) || 'A tool'} returned an error`, where);
    }
  } else if (msg.type === 'result') {
    const secs = Math.round((msg.duration_ms || 0) / 1000);
    if (!msg.subtype || msg.subtype === 'success') log('chat', `Finished in ${secs}s${msg.num_turns > 1 ? `, ${msg.num_turns} steps` : ''}`, where);
    else log('error', `Turn ended: ${msg.subtype.replace(/_/g, ' ')}`, where);
  } else if (msg.type === 'system') {
    if (msg.subtype === 'task_started' && (msg.task_type === 'local_agent' || msg.subagent_type)) {
      agentNames.set(msg.task_id, msg.subagent_type || agentNames.get(msg.tool_use_id) || 'Sub-agent');
      if (msg.tool_use_id) agentNames.set(msg.tool_use_id, agentNames.get(msg.task_id));
    } else if (msg.subtype === 'task_notification' && agentNames.has(msg.task_id) && once(`end:${msg.task_id}`)) {
      log(msg.status === 'failed' ? 'error' : 'agent', `${agentNames.get(msg.task_id)} ${msg.status === 'completed' ? 'finished' : msg.status}`, where);
    } else if (msg.subtype === 'compact_boundary') log('system', 'Earlier context was summarised', where);
    else if (msg.subtype === 'init' && msg.model && once(`init:${m.chatId}:${msg.model}`)) log('system', `Session running on ${msg.model}`, where);
  }
}

function onServer(m) {
  try { logEvent(m); } catch (err) { console.error('Log entry failed', err); } // the log must never break the chat
  switch (m.t) {
    case 'meta': state.meta = m.meta; renderPickers(); renderUsage(); return;
    case 'created': {
      state.current = m.chatId;
      const t = transcriptFor(m.chatId);
      mountTranscript(t);
      if (state.pending) { send({ t: 'send', chatId: m.chatId, ...state.pending, ...picks() }); state.pending = null; }
      loadChats();
      return;
    }
    case 'history': {
      const t = transcriptFor(m.chatId);
      t.loadHistory(m.messages);
      state.chatState.set(m.chatId, m.state);
      if (m.chatId === state.current) { mountTranscript(t); stickToBottom(true); syncComposer(); }
      return;
    }
    case 'chats_changed':
      if (m.deleted && m.deleted === state.current) newChat(state.chats.find((c) => c.id === m.deleted)?.category_id);
      if (m.deleted) state.transcripts.delete(m.deleted);
      loadChats();
      return;
    // This profile was renamed or removed, or its role changed, possibly from another tab.
    case 'reload': location.reload(); return;
    case 'restarting': showRestarting(`${m.reason || ''} Nova is restarting; this page reloads by itself when it's back.`.trim(), m.boot); return;
    case 'profile_changed': refreshMe(); return;
    // Another tab of this profile changed tasks or notes.
    case 'tasks_changed': case 'notes_changed':
      refreshBadges(); // this tab's own changes move the counts too
      if (m.from !== TAB_ID) for (const v of views.values()) v.onServer?.(m);
      return;
    case 'mode': {
      const chat = state.chats.find((c) => c.id === m.chatId);
      if (chat) chat.permission_mode = m.mode;
      if (m.chatId === state.current) setMode(m.mode);
      return;
    }
  }

  const t = m.chatId && state.transcripts.get(m.chatId);
  if (m.chatId && m.chatId !== state.current && m.t === 'sdk' && m.msg.type === 'result') state.unread.add(m.chatId);

  switch (m.t) {
    case 'sdk': t?.handleSdk(m.msg); break;
    case 'user_echo': t?.addUser(m.text, m.attachments || []); break;
    case 'state':
      state.chatState.set(m.chatId, m.state);
      if (m.state === 'idle' || m.state === 'closed') t?.setActivity('idle');
      if (m.state === 'closed') t?.endTasks();
      break;
    case 'permission': t?.addPermission(m); break;
    case 'permission_resolved':
    case 'permission_cancelled': t?.resolveAsk(m.reqId); break;
    case 'error':
      if (t) t.addNotice(m.message, true);
      else if (state.current) transcriptFor(state.current).addNotice(m.message, true);
      break;
  }
  renderChatList();
  if (m.chatId === state.current) { syncComposer(); updatePresence(); }
}

// ---- Chats ----------------------------------------------------------------
const sidebar = initSidebar({ state, store, list: els.chatList, openChat, newChat });
const loadChats = () => sidebar.load().then(renderChatHead);
const renderChatList = () => { sidebar.render(); renderChatHead(); };

function openChat(id) {
  state.current = id;
  state.unread.delete(id);
  const chat = state.chats.find((c) => c.id === id);
  if (chat?.model) setPicks(chat.model, chat.effort);
  setMode(chat?.permission_mode || 'default');
  const existing = state.transcripts.get(id);
  if (existing) mountTranscript(existing);
  else { mountTranscript(transcriptFor(id)); send({ t: 'open', chatId: id }); }
  els.sidebar.classList.remove('open');
  renderChatList();
  syncComposer();
  updatePresence();
}

function newChat(categoryId = null) {
  state.current = null;
  state.draft = { categoryId: categoryId || null };
  setMode(store.get('mode', 'default'));
  const category = state.categories.find((c) => c.id === categoryId);
  mountTranscript(new Transcript(null, { where: category?.name }));
  renderChatList();
  syncComposer();
  updatePresence();
  els.sidebar.classList.remove('open');
  els.input.focus();
}

function mountTranscript(t) { els.transcript.replaceChildren(t.el); }

// The main column's heading: the chat's title and where it's filed.
function renderChatHead() {
  const chat = state.current && state.chats.find((c) => c.id === state.current);
  const catId = chat ? chat.category_id : state.draft.categoryId;
  els.chatTitle.textContent = chat?.title || 'New chat';
  els.chatTitle.title = chat?.title || '';
  els.chatWhere.textContent = state.categories.find((c) => c.id === catId)?.name || '';
}

function stickToBottom(force = false) {
  const el = els.transcript;
  const near = el.scrollHeight - el.scrollTop - el.clientHeight < 160;
  if (force || near) el.scrollTop = el.scrollHeight;
}

// ---- Composer -------------------------------------------------------------
function syncComposer() {
  const running = state.current && state.chatState.get(state.current) === 'running';
  const uploading = state.attachments.some((a) => a.xhr);
  els.stop.hidden = !running;
  els.send.disabled = running || uploading;
  els.send.title = uploading ? 'Wait for the files to finish uploading' : '';
}

function submit() {
  const text = els.input.value.trim();
  const attachments = state.attachments.filter((a) => a.id).map((a) => a.id);
  if ((!text && !attachments.length) || els.send.disabled) return;
  els.input.value = '';
  autoGrow();
  state.attachments = []; // ones that failed to upload are dropped with the rest
  renderAttachments();
  if (!state.current) { state.pending = { text, attachments }; send({ t: 'new', categoryId: state.draft.categoryId, ...picks() }); }
  else send({ t: 'send', chatId: state.current, text, attachments, ...picks() });
}

// ---- Attachments ----------------------------------------------------------
// Files upload as soon as they're added, so sending is instant; each shows as a capsule
// with its progress, and can be removed until the message goes.
const limits = () => state.me?.uploads || { maxMB: 25, maxFiles: 10 };

function addFiles(list) {
  const { maxMB, maxFiles } = limits();
  for (const file of list) {
    const item = { key: `${Date.now()}-${Math.random()}`, name: file.name || 'pasted file', size: file.size, type: file.type };
    const queued = state.attachments.filter((a) => !a.error).length;
    state.attachments.push(item);
    // Refusals show on the file's own capsule, so it's clear which file and why.
    if (queued >= maxFiles) item.error = `Not attached: ${maxFiles} files per message at most`;
    else if (file.size > maxMB * 1024 * 1024) item.error = `Not attached: over ${maxMB} MB`;
    else upload(item, file);
  }
  renderAttachments();
  syncComposer();
}

// XMLHttpRequest rather than fetch, for upload progress.
function upload(item, file) {
  const xhr = new XMLHttpRequest();
  item.xhr = xhr;
  item.progress = 0;
  xhr.open('POST', `/api/uploads?name=${encodeURIComponent(item.name)}`);
  xhr.upload.onprogress = (e) => { if (e.lengthComputable) { item.progress = e.loaded / e.total; renderAttachments(); } };
  const done = (error) => {
    item.xhr = null;
    item.progress = null;
    if (error) item.error = error;
    renderAttachments();
    syncComposer();
  };
  xhr.onload = () => {
    let data = {};
    try { data = JSON.parse(xhr.responseText); } catch {}
    if (xhr.status === 401) { location.href = '/login'; return; }
    if (xhr.status !== 200) return done(data.error || `Upload failed (${xhr.status}). Try again.`);
    Object.assign(item, { id: data.id, name: data.name, size: data.size, type: data.type });
    done();
  };
  xhr.onerror = () => done('Upload failed. Check the connection and try again.');
  xhr.onabort = () => { item.xhr = null; };
  xhr.send(file);
}

function removeAttachment(item) {
  item.xhr?.abort();
  state.attachments = state.attachments.filter((a) => a !== item);
  if (item.id) fetch(`/api/uploads/${item.id}`, { method: 'DELETE' }).catch(() => {}); // unsent files are swept anyway
  renderAttachments();
  syncComposer();
  els.input.focus();
}

function renderAttachments() {
  els.attachList.hidden = !state.attachments.length;
  els.attachList.replaceChildren(...state.attachments.map((a) =>
    fileChip(a, { href: a.id ? `/api/uploads/${a.id}` : null, progress: a.xhr ? a.progress : null, error: a.error, onRemove: () => removeAttachment(a) })));
}

els.attachBtn.addEventListener('click', () => els.fileInput.click());
els.fileInput.addEventListener('change', () => { addFiles(els.fileInput.files); els.fileInput.value = ''; });
// Pasted screenshots and files attach too; pasted text still goes into the box as usual.
els.input.addEventListener('paste', (e) => {
  const files = [...(e.clipboardData?.files || [])];
  if (!files.length) return;
  addFiles(files);
  if (!e.clipboardData.getData('text/plain')) e.preventDefault();
});

// Dropping files anywhere on the chat attaches them; the composer lights up while dragging.
// Dragging a chat in the sidebar carries no files, so it's left alone.
const carriesFiles = (e) => [...(e.dataTransfer?.types || [])].includes('Files');
let dragDepth = 0;
const chatView = document.querySelector('[data-view="chats"]');
chatView.addEventListener('dragenter', (e) => { if (!carriesFiles(e)) return; e.preventDefault(); dragDepth++; els.composer.classList.add('drop-files'); });
chatView.addEventListener('dragover', (e) => { if (!carriesFiles(e)) return; e.preventDefault(); e.dataTransfer.dropEffect = 'copy'; });
chatView.addEventListener('dragleave', (e) => { if (carriesFiles(e) && --dragDepth <= 0) { dragDepth = 0; els.composer.classList.remove('drop-files'); } });
chatView.addEventListener('drop', (e) => {
  if (!carriesFiles(e)) return;
  e.preventDefault();
  dragDepth = 0;
  els.composer.classList.remove('drop-files');
  addFiles(e.dataTransfer.files);
  els.input.focus();
});
// A file dropped anywhere else mustn't make the browser open it and leave Nova.
window.addEventListener('dragover', (e) => { if (carriesFiles(e)) e.preventDefault(); });
window.addEventListener('drop', (e) => { if (carriesFiles(e)) e.preventDefault(); });

function autoGrow() { els.input.style.height = 'auto'; els.input.style.height = `${els.input.scrollHeight}px`; }

els.composer.addEventListener('submit', (e) => { e.preventDefault(); submit(); });
els.input.addEventListener('keydown', (e) => {
  if (e.key === 'Enter' && !e.shiftKey && !e.isComposing) { e.preventDefault(); submit(); }
});
els.input.addEventListener('input', autoGrow);
els.stop.addEventListener('click', () => send({ t: 'interrupt', chatId: state.current }));
$('newCategoryBtn').addEventListener('click', () => sidebar.openNewCategory());
$('newChatBtn').addEventListener('click', async () => { await showView('chats'); if (view === 'chats') newChat(null); });

// Drawers on narrow screens: the sidebar (menu buttons) and the avatar panel (header button).
// A tap outside an open drawer closes it.
const presenceBtn = $('presenceBtn');
function setPresenceOpen(open) {
  els.presence.classList.toggle('open', open);
  presenceBtn.setAttribute('aria-expanded', String(open));
}
document.addEventListener('click', (e) => {
  if (e.target.closest('.menu-btn')) els.sidebar.classList.toggle('open');
  if (e.target.closest('#presenceBtn')) setPresenceOpen(!els.presence.classList.contains('open'));
});
document.addEventListener('pointerdown', (e) => {
  if (e.target.closest('.menu-btn, #presenceBtn, .menu, dialog')) return;
  if (els.sidebar.classList.contains('open') && !els.sidebar.contains(e.target)) els.sidebar.classList.remove('open');
  if (els.presence.classList.contains('open') && !els.presence.contains(e.target)) setPresenceOpen(false);
});

// ---- Header bar -------------------------------------------------------------
const clock = $('clock');
function tickClock() {
  const now = new Date();
  clock.textContent = now.toLocaleTimeString('en-GB', { hour12: false });
  clock.dateTime = now.toISOString();
}
tickClock();
setInterval(tickClock, 1000);

// ---- Model and effort -----------------------------------------------------
function picks() {
  return { model: els.model.value || undefined, effort: els.effortWrap.hidden ? undefined : els.effort.value, mode: els.mode.value };
}
function setPicks(model, effort) {
  if (model && [...els.model.options].some((o) => o.value === model)) els.model.value = model;
  renderEffort(effort);
}
function renderPickers() {
  const models = state.meta?.models || [];
  const current = els.model.value || store.get('model', state.meta?.defaultModel);
  els.model.replaceChildren(...models.map((m) => {
    const o = new Option(m.displayName || m.value, m.value);
    o.title = m.description || '';
    return o;
  }));
  if (!models.length) els.model.append(new Option('Default model', ''));
  if ([...els.model.options].some((o) => o.value === current)) els.model.value = current;
  renderEffort();
}
function renderEffort(wanted) {
  const m = state.meta?.models?.find((x) => x.value === els.model.value);
  const levels = m?.supportsEffort === false ? [] : (m?.supportedEffortLevels?.length ? m.supportedEffortLevels : ['low', 'medium', 'high']);
  els.effortWrap.hidden = !levels.length;
  const keep = wanted || els.effort.value || store.get('effort', state.meta?.defaultEffort);
  els.effort.replaceChildren(...levels.map((l) => new Option(`${l} effort`, l)));
  if (levels.includes(keep)) els.effort.value = keep;
  else if (levels.includes(state.meta?.defaultEffort)) els.effort.value = state.meta.defaultEffort;
}
els.model.addEventListener('change', () => { store.set('model', els.model.value); renderEffort(); });
els.effort.addEventListener('change', () => store.set('effort', els.effort.value));

// Permission mode applies to the open chat straight away, without restarting it.
function setMode(mode) {
  if (![...els.mode.options].some((o) => o.value === mode)) mode = 'default';
  els.mode.value = mode;
  els.mode.dataset.mode = mode;
}
els.mode.addEventListener('change', () => {
  setMode(els.mode.value);
  store.set('mode', els.mode.value);
  if (state.current) send({ t: 'mode', chatId: state.current, mode: els.mode.value });
});

// ---- Usage bars -----------------------------------------------------------
const WINDOWS = [['five_hour', 'Session'], ['seven_day', 'Week'], ['seven_day_opus', 'Opus week'], ['seven_day_sonnet', 'Sonnet week']];
// window -> 0, 75 or 90, so crossing a threshold is logged once. Kept for the tab like the
// log itself, so a reload doesn't log the same warning again.
const usageLevel = (() => { try { return new Map(Object.entries(JSON.parse(sessionStorage.getItem('nova.usageLevels')) || {})); } catch { return new Map(); } })();
function logUsage(key, label, pct, status) {
  const level = pct >= 90 || status === 'rejected' ? 90 : pct >= 75 || status === 'allowed_warning' ? 75 : 0;
  if (level > (usageLevel.get(key) || 0)) log(level === 90 ? 'error' : 'system', `${label} usage at ${Math.round(pct)}%`);
  usageLevel.set(key, level);
  try { sessionStorage.setItem('nova.usageLevels', JSON.stringify(Object.fromEntries(usageLevel))); } catch {}
}
function usageNote(text) {
  const note = document.createElement('span');
  note.className = 'usage-note';
  note.textContent = text;
  return note;
}

function renderUsage() {
  const signedIn = state.meta?.signedIn;
  // Signed out: say so where the bars go, with the way back in for admins.
  if (signedIn === false) {
    if (state.me?.role !== 'admin') { els.usage.replaceChildren(usageNote('Claude isn\'t connected. Ask an admin to sign in')); return; }
    const go = document.createElement('button');
    go.type = 'button';
    go.className = 'text-btn';
    go.textContent = 'Sign in';
    go.addEventListener('click', () => settings.openSettings('claude'));
    els.usage.replaceChildren(usageNote('Claude isn\'t connected.'), go);
    return;
  }
  const u = state.meta?.usage;
  if (!u) { els.usage.replaceChildren(); return; }
  if (u.available === false) {
    els.usage.replaceChildren(...(signedIn ? [usageNote('Plan limits aren\'t reported for Anthropic Console sign-ins')] : []));
    return;
  }
  els.usage.replaceChildren(...WINDOWS.filter(([k]) => u.windows?.[k]?.utilization != null).map(([k, label]) => {
    const w = u.windows[k];
    const pct = Math.max(0, Math.min(100, w.utilization));
    logUsage(k, label, pct, w.status);
    const div = document.createElement('div');
    div.className = `meter${pct >= 90 || w.status === 'rejected' ? ' bad' : pct >= 75 || w.status === 'allowed_warning' ? ' warn' : ''}`;
    div.innerHTML = '<span></span><div class="meter-track"><div class="meter-fill"></div></div>' +
      '<div class="meter-tip" role="tooltip"><strong></strong><span class="meter-reset"></span></div>';
    div.firstChild.textContent = label;
    div.querySelector('.meter-fill').style.width = `${pct}%`;
    div.querySelector('.meter-tip strong').textContent = `${label}: ${Math.round(pct)}% used`;
    div.dataset.label = label;
    div.dataset.pct = Math.round(pct);
    div.dataset.resets = w.resets_at || '';
    div.tabIndex = 0; // focus (or tap) shows the popover, not just hover
    div.setAttribute('role', 'meter'); div.setAttribute('aria-valuenow', Math.round(pct));
    div.setAttribute('aria-valuemin', 0); div.setAttribute('aria-valuemax', 100);
    return div;
  }));
  tickUsage();
}

// Reset times count down, so refresh their wording without rebuilding the meters (that would close an open popover).
function tickUsage() {
  for (const div of els.usage.querySelectorAll('.meter')) {
    const reset = resetText(div.dataset.resets);
    div.querySelector('.meter-reset').textContent = reset;
    div.setAttribute('aria-label', `${div.dataset.label}: ${div.dataset.pct}% used. ${reset}`);
  }
}
setInterval(tickUsage, 30 * 1000);

function resetText(iso) {
  if (!iso) return 'Reset time not reported';
  const at = new Date(iso);
  const left = at - Date.now();
  if (Number.isNaN(left)) return 'Reset time not reported';
  if (left <= 0) return 'Resetting now';
  const when = at.toLocaleString(undefined, { weekday: 'short', day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit' });
  return `Resets ${when} (in ${duration(left)})`;
}

function duration(ms) {
  const mins = Math.floor(ms / 60000);
  if (mins < 1) return 'under a minute';
  const d = Math.floor(mins / 1440), h = Math.floor((mins % 1440) / 60), m = mins % 60;
  if (d) return `${d}d ${h}h`;
  if (h) return `${h}h ${m}m`;
  return `${m}m`;
}

// ---- Presence (avatar hook) -----------------------------------------------
// Anything that wants to drive an avatar can listen for 'nova:presence' on window. The
// presence panel (presence.js) is itself only a listener.
let lastPresence = '';
function updatePresence() {
  renderChatHead();
  const t = state.current && state.transcripts.get(state.current);
  const running = state.current && state.chatState.get(state.current) === 'running';
  const agents = t?.runningAgents() || [];
  const recent = t?.recentAgents() || [];
  let s = 'idle', label = 'Ready';
  if (t?.waiting) { s = 'waiting'; label = 'Waiting for you'; }
  else if (running && t) {
    s = t.activity === 'idle' ? 'thinking' : t.activity;
    label = { thinking: 'Thinking', writing: 'Writing', tool: `Running ${t.activityLabel || 'a tool'}` }[s] || 'Working';
  } else if (agents.length) {
    s = 'tool';
    label = agents.length === 1 ? 'Waiting on 1 agent' : `Waiting on ${agents.length} agents`;
  }
  els.chatState.dataset.state = s;
  els.chatState.lastChild.textContent = label;
  // agents: running now, with state starting | working | tool. recent: finished in the
  // last half minute, with state done | failed | stopped. Times are epoch milliseconds.
  const detail = {
    state: s, label, chatId: state.current,
    agents: agents.map(({ id, name, task, detail: d, toolUses, startedAt, state: as }) => ({ id, name, task, detail: d, toolUses, startedAt, state: as })),
    recent: recent.map(({ id, name, task, toolUses, startedAt, endedAt, state: as }) => ({ id, name, task, toolUses, startedAt, endedAt, state: as }))
  };
  const key = JSON.stringify(detail);
  if (key !== lastPresence) {
    lastPresence = key;
    window.dispatchEvent(new CustomEvent('nova:presence', { detail }));
  }
}
// Agent states decay (a tool burst fades, finished agents drop off), so re-check while any show.
setInterval(() => { if (lastPresence.includes('"id"')) updatePresence(); }, 1000);

// ---- Views ----------------------------------------------------------------
// Chats is always there. Other views are listed by the server with this profile's access
// level, loaded on first use, and each owns a sidebar pane and a main pane. The server
// checks access on every route; this only decides what to show.
const VIEW_MODULES = { brain: '/brain.js', tasks: '/tasks.js', notes: '/notes.js' };
const VIEW_ICONS = {
  chats: ['M20 12a8 8 0 0 1-11.6 7.1L4 20l1-4.6A8 8 0 1 1 20 12Z', 'M8.5 12h.01M12 12h.01M15.5 12h.01'],
  brain: ['M9.5 3.5A3 3 0 0 0 6.6 6 3 3 0 0 0 4.5 11a3 3 0 0 0 1.2 4.7A3 3 0 0 0 9.5 20a2.5 2.5 0 0 0 2.5-2.5v-11a3 3 0 0 0-2.5-3Z',
    'M14.5 3.5A3 3 0 0 1 17.4 6a3 3 0 0 1 2.1 5 3 3 0 0 1-1.2 4.7 3 3 0 0 1-3.8 4.3A2.5 2.5 0 0 1 12 17.5', 'M8 9.5a2 2 0 0 1 2 1.5M16 9.5a2 2 0 0 0-2 1.5M9 15a2 2 0 0 1 3-1M15 15a2 2 0 0 0-3-1'],
  tasks: ['M4 4h16v16H4Z', 'm8 12 3 3 5-6'],
  notes: ['M6 3h9l4 4v14H6Z', 'M14 3v5h5M9 12h7M9 16h5']
};
function viewIcon(id) {
  const svg = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
  svg.setAttribute('viewBox', '0 0 24 24');
  svg.setAttribute('aria-hidden', 'true');
  for (const d of VIEW_ICONS[id] || VIEW_ICONS.notes) {
    const p = document.createElementNS('http://www.w3.org/2000/svg', 'path');
    p.setAttribute('d', d);
    svg.append(p);
  }
  return svg;
}
// Names this tab to the server, so a view can skip the echo of its own changes.
const TAB_ID = crypto.randomUUID?.() ?? `${Date.now()}-${Math.random().toString(36).slice(2)}`; // randomUUID needs a secure context
const views = new Map(); // id -> the view's controller once loaded
let view = 'chats';

function allowedViews() {
  const access = state.me?.access || {};
  return [{ id: 'chats', label: 'Chats' }, ...(state.me?.views || []).filter((v) => VIEW_MODULES[v.id] && access[v.id] && access[v.id] !== 'none')];
}

function renderViewTabs() {
  const list = allowedViews();
  const tabs = $('viewTabs');
  tabs.hidden = list.length < 2;
  tabs.replaceChildren(...list.map((v) => {
    const b = document.createElement('button');
    b.type = 'button';
    b.setAttribute('role', 'tab');
    b.setAttribute('aria-selected', String(v.id === view));
    b.tabIndex = v.id === view ? 0 : -1;
    b.dataset.tab = v.id;
    b.dataset.label = v.label;
    b.append(viewIcon(v.id), Object.assign(document.createElement('span'), { textContent: v.label }),
      Object.assign(document.createElement('span'), { className: 'tab-badge', hidden: true }));
    b.addEventListener('click', () => showView(v.id));
    return b;
  }));
  if (!list.some((v) => v.id === view)) showView('chats', { force: true }); // access was taken away
  paintBadges();
}

// Counts on the view tabs: today's unfinished tasks and active notes. The server counts,
// so they're right before a view has ever been opened; today is this device's date.
let badges = {};
const BADGE_TEXT = { tasks: (n) => `${n} ${n === 1 ? 'task' : 'tasks'} left today`, notes: (n) => `${n} active ${n === 1 ? 'note' : 'notes'}` };
const localDay = () => { const d = new Date(); return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`; };
async function refreshBadges() {
  try {
    const res = await fetch(`/api/badges?today=${localDay()}`);
    if (res.ok) { badges = await res.json(); paintBadges(); }
  } catch {} // counts are a convenience; the next change or minute tries again
}
function paintBadges() {
  for (const b of $('viewTabs').children) {
    const n = badges[b.dataset.tab], badge = b.querySelector('.tab-badge');
    if (!badge) continue;
    badge.hidden = !n;
    badge.textContent = n > 99 ? '99+' : String(n || '');
    if (n) b.title = BADGE_TEXT[b.dataset.tab](n); else b.removeAttribute('title');
    b.setAttribute('aria-label', n ? `${b.dataset.label}, ${BADGE_TEXT[b.dataset.tab](n)}` : b.dataset.label);
  }
}
let badgeDay = localDay();
setInterval(() => { if (localDay() !== badgeDay) { badgeDay = localDay(); refreshBadges(); } }, 60 * 1000);
$('viewTabs').addEventListener('keydown', (e) => {
  if (e.key !== 'ArrowRight' && e.key !== 'ArrowLeft') return;
  const tabs = [...$('viewTabs').children];
  const next = tabs[(tabs.indexOf(document.activeElement) + (e.key === 'ArrowRight' ? 1 : tabs.length - 1)) % tabs.length];
  next?.focus();
  next?.click();
});

function paneFor(kind, id) {
  let el = document.querySelector(`[data-${kind}="${id}"]`);
  if (!el) {
    el = document.createElement('div');
    el.className = kind === 'side' ? 'side-pane' : `view view-${id}`;
    el.dataset[kind] = id;
    el.hidden = true;
    (kind === 'side' ? els.sidebar : $('main')).append(el);
  }
  return el;
}

// arg is view-specific: for the brain, a file path to open.
async function showView(id, { arg, force = false } = {}) {
  if (id !== view && !force && views.get(view)?.canLeave?.() === false) return;
  if (id !== 'chats' && !views.has(id)) {
    try {
      const mod = await import(VIEW_MODULES[id]);
      views.set(id, mod.init({
        side: paneFor('side', id), main: paneFor('view', id), store,
        access: () => state.me?.access?.[id] || 'none', me: () => state.me, tabId: TAB_ID,
        setRoute: (route) => history.replaceState(null, '', route ? `#${id}/${route}` : `#${id}`),
        closeSidebar: () => els.sidebar.classList.remove('open')
      }));
    } catch (err) {
      console.error(err);
      sidebar.notify?.(`Couldn't open that view: ${err.message}`);
      return;
    }
  }
  const leaving = view;
  view = id;
  for (const el of document.querySelectorAll('[data-side], [data-view]')) {
    el.hidden = (el.dataset.side || el.dataset.view) !== id;
  }
  for (const b of $('viewTabs').children) {
    b.setAttribute('aria-selected', String(b.dataset.tab === id));
    b.tabIndex = b.dataset.tab === id ? 0 : -1;
  }
  if (leaving !== id) views.get(leaving)?.hide?.();
  views.get(id)?.show?.(arg);
  if (id === 'chats') history.replaceState(null, '', location.pathname);
  store.set('view', id);
}

// A route like #brain/folder/file.md reopens that view and file after a reload.
function routeFromHash() {
  const m = /^#([a-z]+)(?:\/(.*))?$/.exec(location.hash);
  if (!m) return null;
  let arg = m[2] || undefined;
  try { if (arg) arg = decodeURIComponent(arg); } catch { arg = undefined; }
  return { id: m[1], arg };
}

// ---- Settings and profiles ------------------------------------------------
async function refreshMe() {
  const res = await fetch('/api/me');
  if (res.status === 401) { location.href = '/login'; return; }
  const me = await res.json();
  state.me = me;
  els.profile.textContent = me.profile;
  $('brandProfile').textContent = me.profile;
  // The profile's picture stands in for the person icon when it has one.
  const icon = document.querySelector('.who-icon');
  icon.querySelector('img')?.remove();
  icon.querySelector('svg').toggleAttribute('hidden', !!me.picture);
  if (me.picture) icon.prepend(h('img', { class: 'picture', src: pictureUrl(me.profile, me.picture), alt: '' }));
  $('version').textContent = me.version ? `v${me.version}` : '';
  renderViewTabs();
  refreshBadges();
  for (const v of views.values()) v.profileChanged?.();
}
const settings = initSettings({ me: () => state.me, refreshMe });
$('settingsBtn').addEventListener('click', () => settings.openSettings());
$('profileBtn').addEventListener('click', () => settings.openSwitcher());

// ---- Boot -----------------------------------------------------------------
(async function boot() {
  await refreshMe();
  if (!state.me) return;
  openLog(state.me.profile);
  state.meta = state.me.meta;
  renderPickers();
  renderUsage();
  await loadChats();
  newChat();
  connect();
  const route = routeFromHash();
  if (route && allowedViews().some((v) => v.id === route.id) && route.id !== 'chats') showView(route.id, { arg: route.arg });
})();
