// The Chats view's controller: routes every server message to the right transcript and the
// chat list, opens and starts chats, and tells the presence panel what Claude is doing.
// Other views and the installed app reach chats through openChat and newChat.
import { $, h } from '../lib/dom.js';
import { slide, stopSlide } from '../lib/slide.js';
import { store } from '../lib/store.js';
import { TAB_ID } from '../lib/api.js';
import { confirmDialog } from '../lib/dialog.js';
import { state, els, titleOf } from '../state.js';
import { Transcript } from './transcript.js';
import { connect, send } from './socket.js';
import { logEvent } from './activity.js';
import { picks, setPicks, renderPickers, setMode } from './pickers.js';
import { syncComposer, voiceOn, sentArrived, settleUnsent, restoreDropped, switchDraft, draftCreated, dropDraft, pruneDrafts } from './composer.js';
import { mounted, spot, stick } from './scroll.js';
import { speak, stopSpeaking, unlockSpeech } from '../lib/speech.js';
import { initSidebar } from './sidebar.js';
import { initPwa } from '../shell/pwa.js';
import { renderUsage } from '../shell/header.js';
import { views, refreshBadges, goTo, goToChat, routeFromHash } from '../shell/views.js';
import { refreshMe } from '../shell/profile.js';
import { showRestarting } from '../shell/restart.js';

export let sidebar = null; // the chat list (sidebar.js)
export let pwa = null;     // launches, notifications and the app badge (shell/pwa.js)

const loadChats = () => sidebar.load().then((loaded) => { if (loaded) pruneDrafts(); renderChatHead(); pwa.paintBadge(); });
const renderChatList = () => { sidebar.render(); renderChatHead(); pwa.paintBadge(); };

// Sets up the chat list and the installed-app hooks, then loads the chats and connects.
export async function startChats() {
  sidebar = initSidebar({ state, store, list: els.chatList, openChat, newChat });
  pwa = initPwa({ state, store, titleOf, goToChat, route: (hash) => goTo(routeFromHash(hash)) });
  $('newCategoryBtn').addEventListener('click', () => sidebar.openNewCategory());
  renderPickers();
  renderUsage();
  await loadChats();
  newChat();
  connect({
    onMessage: onServer,
    // After an outage, notifications start afresh and the open chat reloads what it missed, in
    // place: the old copy stays on screen until the new one replaces it at the same spot. Other
    // chats reload when next opened. A first message whose chat never came back returns to the box.
    onOpen(reconnected) {
      if (reconnected) pwa.reset();
      for (const id of state.transcripts.keys()) if (id !== state.current) state.transcripts.delete(id);
      if (state.current) send({ t: 'open', chatId: state.current });
      else if (state.pending) { state.pending = null; settleUnsent(null, []); }
    }
  });
}

// Only the copy on screen follows the end and drives presence; one being filled from history
// isn't mounted yet.
function makeTranscript(chatId, loading = false) {
  const t = new Transcript(chatId, {
    loading,
    onAnswer: (reqId, result) => send({ t: 'answer', chatId, reqId, result }),
    onEdit: (uuid, text) => editMessage(chatId, uuid, text),
    onLoadFull: () => loadFullHistory(chatId),
    onChange: () => { if (chatId === state.current && t.el.isConnected) { stick(); updatePresence(); } }
  });
  return t;
}

function transcriptFor(chatId, loading = false) {
  let t = state.transcripts.get(chatId);
  if (!t) { t = makeTranscript(chatId, loading); state.transcripts.set(chatId, t); }
  return t;
}

// ---- Server messages ----------------------------------------------------------

function onServer(m) {
  try { logEvent(m); } catch (err) { console.error('Log entry failed', err); } // the log must never break the chat
  try { pwa.onServer(m); } catch (err) { console.error('App notification failed', err); } // nor must notifications
  switch (m.t) {
    case 'meta': state.meta = m.meta; renderPickers(); renderUsage(); return;
    case 'created': {
      state.current = m.chatId;
      draftCreated();
      mountTranscript(transcriptFor(m.chatId));
      if (state.pending) {
        if (state.pending.voice) state.speakFor.add(m.chatId);
        send({ t: 'send', chatId: m.chatId, ...state.pending, ...picks() });
        state.pending = null;
      }
      loadChats();
      return;
    }
    // Built off screen and swapped in whole, so a reload doesn't flash or lose the reader's place.
    case 'history': {
      const old = state.transcripts.get(m.chatId);
      const t = makeTranscript(m.chatId);
      t.loadHistory(m.messages);
      t.setBusy(m.state === 'running');
      state.transcripts.set(m.chatId, t);
      state.chatState.set(m.chatId, m.state);
      if (m.chatId === state.current) {
        mountTranscript(t, old?.el.isConnected && !old.empty ? spot() : null);
        syncComposer();
        updatePresence();
      }
      settleUnsent(m.chatId, m.delivered || []);
      return;
    }
    case 'chats_changed':
      if (m.deleted && m.deleted === state.current) newChat(state.chats.find((c) => c.id === m.deleted)?.category_id);
      if (m.deleted) { state.transcripts.delete(m.deleted); dropDraft(m.deleted); }
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
    // An app was added, changed or removed (here, in another tab, or by Nova's tools).
    case 'apps_changed': for (const v of views.values()) v.onServer?.(m); return;
    case 'mode': {
      const chat = state.chats.find((c) => c.id === m.chatId);
      if (chat) chat.permission_mode = m.mode;
      if (m.chatId === state.current) setMode(m.mode);
      return;
    }
  }

  // Everything else belongs to one chat's transcript.
  const t = m.chatId && state.transcripts.get(m.chatId);
  if (m.chatId && m.chatId !== state.current && m.t === 'sdk' && m.msg.type === 'result') state.unread.add(m.chatId);
  switch (m.t) {
    case 'sdk':
      t?.handleSdk(m.msg);
      speakReply(m);
      // A finished turn may have written app files, which the Apps view can't hear about otherwise.
      if (m.msg.type === 'result') for (const v of views.values()) v.onServer?.({ t: 'apps_changed' });
      break;
    case 'user_echo':
      sentArrived(m.from);
      if (m.continued) t?.addContinued(true); // it starts a fresh session from Nova's summary
      t?.addUser(m.text, m.attachments || [], Date.now(), m.uuid, m.queued || null); // queued: sent mid-reply
      break;
    // A message sent mid-reply: Nova read it (it moves to that point), or never will (Stop).
    case 'interjected': t?.placeQueued(m.uuid); break;
    case 'interjection_dropped': t?.dropQueued(m.uuid); restoreDropped(m); break;
    case 'notice': t?.addNotice(m.message); break;
    case 'rewound': t?.rewind(m.uuid); break;
    case 'state':
      state.chatState.set(m.chatId, m.state);
      t?.setBusy(m.state === 'running');
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

// Replies to a message this tab sent with spoken replies on are read aloud as each part of the
// answer arrives (sub-agents' messages aren't). Only this tab speaks, not every open device.
function speakReply(m) {
  if (m.msg.type !== 'assistant' || m.msg.parent_tool_use_id || !state.speakFor.has(m.chatId) || !voiceOn()) return;
  const text = (m.msg.message?.content || []).filter((b) => b.type === 'text').map((b) => b.text).join('\n\n').trim();
  if (text) speak(text);
}

// Sends an edited message again (transcript.js editUser). The server rewinds the chat to just
// before it and every tab drops that turn onwards (rewound) before the new version echoes.
function editMessage(chatId, uuid, text) {
  stopSpeaking();
  const voice = voiceOn();
  if (voice) unlockSpeech();
  state.speakFor[voice ? 'add' : 'delete'](chatId);
  send({ t: 'edit', chatId, uuid, text, voice, ...picks() });
}

// The chat carried on from Nova's summary, and the user wants the whole earlier conversation back
// (transcript.js addContinued). The server sends the first message since the summary again on the
// old session; every tab drops it onwards (rewound) before it echoes.
async function loadFullHistory(chatId) {
  if (state.chatState.get(chatId) === 'running') return;
  const ok = await confirmDialog({ title: 'Load the full history?', confirm: 'Load full history',
    message: 'Nova sends your first message since the summary again, with the whole earlier conversation instead of the summary. ' +
      'That reads the full history afresh, so it uses much more of your plan. Any replies since the summary leave the chat.' });
  if (!ok) return;
  stopSpeaking();
  const voice = voiceOn();
  if (voice) unlockSpeech();
  state.speakFor[voice ? 'add' : 'delete'](chatId);
  send({ t: 'full_history', chatId, voice, ...picks() });
}

// ---- Opening and starting chats -----------------------------------------------

export function openChat(id) {
  state.current = id;
  state.unread.delete(id);
  switchDraft();
  const chat = state.chats.find((c) => c.id === id);
  if (chat?.model) setPicks(chat.model, chat.effort);
  setMode(chat?.permission_mode || 'default');
  const existing = state.transcripts.get(id);
  if (existing) mountTranscript(existing);
  else { mountTranscript(transcriptFor(id, true)); send({ t: 'open', chatId: id }); }
  els.sidebar.classList.remove('open');
  renderChatList();
  syncComposer();
  updatePresence();
}

// An empty, unsent chat, filed under categoryId once it's sent.
export function newChat(categoryId = null) {
  state.current = null;
  state.draft = { categoryId: categoryId || null };
  switchDraft();
  setMode(store.get('mode', 'default'));
  const category = state.categories.find((c) => c.id === categoryId);
  mountTranscript(new Transcript(null, { where: category?.name }));
  renderChatList();
  syncComposer();
  updatePresence();
  els.sidebar.classList.remove('open');
  els.input.focus();
}

function mountTranscript(t, keep = null) {
  els.transcript.replaceChildren(t.el);
  mounted(t.el, keep);
}

// The main column's heading: the chat's title and where it's filed.
function renderChatHead() {
  const chat = state.current && state.chats.find((c) => c.id === state.current);
  const catId = chat ? chat.category_id : state.draft.categoryId;
  const title = chat?.title || 'New chat';
  if (els.chatTitle.textContent !== title) {
    els.chatTitle.replaceChildren(h('span', {}, title));
    // A title too long for the heading slides once to show its end; hover or a tap shows it again.
    requestAnimationFrame(() => slide(els.chatTitle, true));
  }
  els.chatTitle.title = chat?.title || '';
  els.chatWhere.textContent = state.categories.find((c) => c.id === catId)?.name || '';
}

els.chatTitle.addEventListener('pointerenter', (e) => { if (e.pointerType === 'mouse') slide(els.chatTitle); });
els.chatTitle.addEventListener('pointerleave', (e) => { if (e.pointerType === 'mouse') stopSlide(els.chatTitle); });
els.chatTitle.addEventListener('click', () => slide(els.chatTitle, true));

// ---- Presence -------------------------------------------------------------------
// Anything that wants to drive an avatar can listen for 'nova:presence' on window. The
// presence panel (presence/panel.js) is itself only a listener.
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
