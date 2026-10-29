// The composer: the message box, Send and Stop, attached files and slash-command suggestions.
// Files upload as soon as they're added, so sending is instant; each shows as a capsule with
// its progress, and can be removed until the message goes. A message to a chat that doesn't
// exist yet asks the server for one first (chats.js sends it once 'created' arrives).
// Voice: the microphone dictates into the box, and the speaker turns on spoken replies, which
// also asks Claude for short answers (the server adds a note to each message sent that way).
// Nothing typed is lost to a dropped connection: the box is kept in this browser's storage
// (a phone can reload an installed app at any time), a message isn't taken from the box while
// the link is down, and one sent just as the link died comes back if the server never got it.
// Each chat keeps its own draft, so a half-written message stays put while you look at others.
// While Nova is replying, Send interjects: Nova reads the message at its next step, between tool
// calls, as Claude Code's own terminal does. Stop & send (Ctrl+Enter) stops the step it's on and
// reads the message at once.
import { $ } from '../lib/dom.js';
import { fileChip } from '../lib/widgets.js';
import { store } from '../lib/store.js';
import { choiceDialog } from '../lib/dialog.js';
import { canDictate, canSpeakReplies, toggleDictation, stopDictation, stopSpeaking, unlockSpeech, onSpeaking, onVoiceChange, isSpeaking } from '../lib/speech.js';
import { state, els } from '../state.js';
import { send, probe } from './socket.js';
import { picks } from './pickers.js';
import { initCommands } from './commands.js';

const isRunning = () => !!state.current && state.chatState.get(state.current) === 'running';
const hasMessage = () => !!els.input.value.trim() || state.attachments.some((a) => a.id);

export function syncComposer() {
  const running = isRunning();
  const uploading = state.attachments.some((a) => a.xhr);
  els.stop.hidden = !running;
  els.now.hidden = !running || !hasMessage();
  els.now.disabled = uploading;
  els.send.disabled = uploading;
  els.send.title = uploading ? 'Wait for the files to finish uploading' : running ? 'Send: Nova reads it at its next step' : '';
  els.input.placeholder = running ? 'Add to what Nova is doing' : 'Message Nova';
  if (hint.textContent === HINT || hint.textContent === RUNNING_HINT) showHint(); // leaves a passing message alone
}

function autoGrow() { els.input.style.height = 'auto'; els.input.style.height = `${els.input.scrollHeight}px`; }

// ---- Drafts -------------------------------------------------------------------
// The box's text is kept per chat in this browser's storage, under the chat's id or 'new' for
// the unsent new chat. Files attached but not yet sent stay with their chat too, though only
// until the page closes (unsent uploads are swept by the server anyway).
const keyOf = (chatId) => chatId || 'new';
const drafts = store.get('drafts', null) ?? (store.get('draft', '') ? { new: store.get('draft', '') } : {}); // 'draft' held the one box before v0.9.1
const setAside = new Map(); // key → attachments of a chat that isn't open
let draftKey = 'new';

function saveDraft() {
  if (els.input.value) drafts[draftKey] = els.input.value; else delete drafts[draftKey];
  store.set('drafts', drafts);
}

// Puts the open chat's draft in the box, after putting the last chat's away.
export function switchDraft() {
  const key = keyOf(state.current);
  if (key === draftKey) return;
  stopDictation(); // or it would carry on typing into the next chat's draft
  saveDraft();
  if (state.attachments.length) setAside.set(draftKey, state.attachments);
  draftKey = key;
  els.input.value = drafts[key] || '';
  state.attachments = setAside.get(key) || [];
  setAside.delete(key);
  commands.close();
  autoGrow();
  renderAttachments();
  syncComposer();
}

// The new chat has its id: whatever was typed since its first message went stays with it.
export function draftCreated() {
  if (draftKey !== 'new') { switchDraft(); return; }
  delete drafts.new;
  draftKey = keyOf(state.current);
  saveDraft();
}

// A deleted chat's draft goes with it. Called once the box has moved to another chat.
export function dropDraft(chatId) {
  const key = keyOf(chatId);
  for (const a of setAside.get(key) || []) a.xhr?.abort();
  setAside.delete(key);
  if (key in drafts && key !== draftKey) { delete drafts[key]; store.set('drafts', drafts); }
}

// Drafts of chats that no longer exist (deleted elsewhere while this browser was away).
export function pruneDrafts() {
  const ids = new Set(state.chats.map((c) => c.id));
  const gone = Object.keys(drafts).filter((k) => k !== 'new' && k !== draftKey && !ids.has(k));
  if (!gone.length) return;
  for (const k of gone) delete drafts[k];
  store.set('drafts', drafts);
}

// Text that comes back to a chat's box (a message Nova never read), ahead of anything typed since.
function putBack(key, text) {
  const typed = (key === draftKey ? els.input.value : drafts[key] || '').trim();
  const value = typed ? `${text}\n\n${typed}` : text;
  if (key !== draftKey) { drafts[key] = value; store.set('drafts', drafts); return; }
  els.input.value = value;
  saveDraft();
  autoGrow();
}

// Slash command suggestions: / as the first character lists the commands a chat can run.
const commands = initCommands({ input: els.input, menu: $('cmdMenu'), currentChat: () => state.current, onFill: autoGrow });

// A long chat whose cached history has expired: with the setting on 'ask', the user chooses how
// it carries on before the message leaves the box. undefined: don't ask, the server decides;
// null: cancelled. The server checks again either way (chat/handoff.js startsFresh).
async function askResume(text) {
  const chat = state.current && state.chats.find((c) => c.id === state.current);
  if (state.meta?.coldResume !== 'ask' || !chat?.fresh_after || Date.now() < chat.fresh_after || text.startsWith('/') || isRunning()) return undefined;
  return choiceDialog({ title: 'Carry on from a summary?',
    message: 'This is a long chat and it has been idle for over an hour, so Nova no longer has it cached. Carrying on from a ' +
      'summary in a fresh session uses far less of your plan than reading the full history again. Everything said so far stays here to scroll back through.',
    choices: [{ label: 'Continue from summary', value: 'fresh' }, { label: 'Load full history', value: 'full' }] });
}

let asking = false;
// interject: 'now' stops what Nova is doing to read the message (Stop & send); otherwise a
// message sent mid-reply waits for Nova's next step. The server decides whether it's mid-reply.
async function submit(interject = 'next') {
  const text = els.input.value.trim();
  const items = state.attachments.filter((a) => a.id);
  const attachments = items.map((a) => a.id);
  if ((!text && !attachments.length) || els.send.disabled || asking) return;
  if (state.ws?.readyState !== 1) {
    probe();
    showHint('Not connected to Nova just now. Your message is still here; send it again once the link shows Online.', true, 6000);
    return;
  }
  if (isRunning() && text.startsWith('/')) {
    showHint('Commands can\'t be sent while Nova is replying. Wait for it to finish, or press Stop first.', true, 6000);
    return;
  }
  asking = true;
  let resume;
  try { resume = await askResume(text); } finally { asking = false; }
  if (resume === null) return;
  stopDictation();
  stopSpeaking();
  if (voiceOn()) unlockSpeech(); // this tap or key lets a phone play the reply when it comes
  els.input.value = '';
  saveDraft();
  commands.close();
  autoGrow();
  state.attachments = []; // ones that failed to upload are dropped with the rest
  renderAttachments();
  const voice = voiceOn();
  const clientId = crypto.randomUUID?.() || `${Date.now()}-${Math.random()}`; // randomUUID needs https or localhost
  watchUnsent({ clientId, text, items });
  if (!state.current) { state.pending = { text, attachments, voice, clientId }; send({ t: 'new', categoryId: state.draft.categoryId, ...picks() }); return; }
  state.speakFor[voice ? 'add' : 'delete'](state.current);
  mine.add(clientId);
  send({ t: 'send', chatId: state.current, text, attachments, voice, clientId, resume, interject, ...picks() });
  syncComposer();
}

// ---- Messages sent mid-reply that Nova never read -----------------------------
// Stop drops messages still waiting for Nova's next step (and so does a chat's process ending).
// The tab that sent one puts its text back in the box; its files were used up, so they're named.
const mine = new Set(); // clientIds this tab sent

export function restoreDropped({ chatId, from, text, files }) {
  if (!from || !mine.has(from)) return;
  mine.delete(from);
  const here = keyOf(chatId) === draftKey;
  if (text) putBack(keyOf(chatId), text);
  syncComposer();
  showHint(`Nova stopped before reading your last message${here ? '' : ' in another chat'}, so ${text ? `it's back in ${here ? 'the' : 'that chat\'s'} box` : 'it wasn\'t sent'}.` +
    (files ? ' Attach its files again to send them.' : ''), true, 8000);
}

// ---- Messages that may not have arrived -------------------------------------
// The last message sent waits here until its echo comes back. If none comes soon the link is
// checked, and a dead one is dropped and reopened; the reopened chat's history then lists the
// clientIds the server received (settleUnsent), and a missing one goes back in the box.
let unsent = null;
let unsentTimer = 0;

function watchUnsent(message) {
  unsent = message;
  clearTimeout(unsentTimer);
  unsentTimer = setTimeout(() => { if (unsent === message) probe(); }, 4000);
}

export function sentArrived(clientId) {
  if (clientId && unsent?.clientId === clientId) { unsent = null; clearTimeout(unsentTimer); }
}

// A chat's history arrived with the clientIds it was sent (chatId null: a new chat that never
// started), so a message still waiting either arrived or didn't.
export function settleUnsent(chatId, delivered) {
  if (!unsent || chatId !== state.current) return;
  if (delivered.includes(unsent.clientId)) { sentArrived(unsent.clientId); return; }
  const { text, items } = unsent;
  sentArrived(unsent.clientId);
  putBack(draftKey, text);
  state.attachments = [...items, ...state.attachments];
  renderAttachments();
  syncComposer();
  showHint('Your last message didn\'t reach Nova, so it\'s back in the box. Send it again when you\'re ready.', true, 8000);
}

els.composer.addEventListener('submit', (e) => { e.preventDefault(); submit(); });
els.input.addEventListener('keydown', (e) => {
  if (commands.onKeydown(e)) return; // the command list has the arrow keys, Enter, Tab and Esc while it's open
  if (e.key === 'Enter' && !e.shiftKey && !e.isComposing) { e.preventDefault(); submit((e.ctrlKey || e.metaKey) && isRunning() ? 'now' : 'next'); }
});
els.input.addEventListener('input', () => { autoGrow(); saveDraft(); if (isRunning()) syncComposer(); });
// What was in the new chat's box when the page last closed, unless something else filled it first.
if (!els.input.value) { els.input.value = drafts.new || ''; autoGrow(); }
els.stop.addEventListener('click', () => { stopSpeaking(); send({ t: 'interrupt', chatId: state.current }); });
els.now.addEventListener('click', () => submit('now'));

// ---- Voice ----------------------------------------------------------------------
// Spoken replies are a per-browser switch, so a phone in the car can talk while the desktop
// stays quiet. The speaker button only shows once Settings has a voice engine for this browser.
// While a reply is being read, the button stops it instead of switching.

const hint = $('hint'), HINT = hint.textContent;
const RUNNING_HINT = 'Nova is replying: Enter adds your message at its next step, Ctrl+Enter stops it and sends now.';
const usualHint = () => (isRunning() ? RUNNING_HINT : HINT);
export const voiceOn = () => canSpeakReplies() && store.get('voiceReplies', false) === true;

// A message in the hint line; with ms, it goes back to the usual hint after that long.
let hintTimer;
function showHint(text = usualHint(), bad = false, ms = 0) {
  clearTimeout(hintTimer);
  if (ms) hintTimer = setTimeout(() => showHint(), ms);
  const usual = text === usualHint();
  hint.textContent = text;
  hint.classList.toggle('bad', bad);
  hint.classList.toggle('live', !usual);
  hint.title = usual ? '' : text;
}

els.mic.hidden = !canDictate;
els.mic.addEventListener('mousedown', (e) => e.preventDefault()); // keep the cursor in the box
els.mic.addEventListener('click', () => {
  stopSpeaking();
  els.input.focus();
  toggleDictation(els.input, {
    onState({ listening, error }) {
      els.mic.setAttribute('aria-pressed', String(listening));
      els.mic.classList.toggle('listening', listening);
      showHint(error || (listening ? 'Listening. Speak now; press any key or the microphone to stop.' : HINT), !!error);
    }
  });
});

function syncSpeak() {
  const on = voiceOn(), talking = isSpeaking();
  els.speak.hidden = !canSpeakReplies();
  els.speak.setAttribute('aria-pressed', String(on));
  els.speak.classList.toggle('speaking', talking);
  const label = talking ? 'Stop reading this reply' : on ? 'Spoken replies are on: Nova keeps replies short and reads them aloud. Click to turn off.' : 'Speak replies: Nova keeps replies short and reads them aloud';
  els.speak.title = label;
  els.speak.setAttribute('aria-label', talking ? 'Stop reading' : 'Speak replies');
}
els.speak.addEventListener('click', () => {
  if (isSpeaking()) { stopSpeaking(); return; }
  const on = !voiceOn();
  store.set('voiceReplies', on);
  if (on) unlockSpeech();
  syncSpeak();
  showHint(on ? 'Spoken replies on: replies to your next messages are short and read aloud.' : 'Spoken replies off.', false, 4000);
});
onSpeaking(syncSpeak);
onVoiceChange(syncSpeak);
syncSpeak();

// ---- Attachments ----------------------------------------------------------

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

// Puts text in the box for the user to check and send, e.g. a task handed to Nova.
export function setDraft(text) {
  els.input.value = text;
  saveDraft();
  autoGrow();
  els.input.focus();
  els.input.setSelectionRange(text.length, text.length);
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
