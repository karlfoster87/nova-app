// The composer: the message box, Send and Stop, attached files and slash-command suggestions.
// Files upload as soon as they're added, so sending is instant; each shows as a capsule with
// its progress, and can be removed until the message goes. A message to a chat that doesn't
// exist yet asks the server for one first (chats.js sends it once 'created' arrives).
// Voice: the microphone dictates into the box, and the speaker turns on spoken replies, which
// also asks Claude for short answers (the server adds a note to each message sent that way).
import { $ } from '../lib/dom.js';
import { fileChip } from '../lib/widgets.js';
import { store } from '../lib/store.js';
import { canDictate, canSpeakAny, toggleDictation, stopDictation, stopSpeaking, unlockSpeech, onSpeaking, isSpeaking } from '../lib/speech.js';
import { state, els } from '../state.js';
import { send } from './socket.js';
import { picks } from './pickers.js';
import { initCommands } from './commands.js';

export function syncComposer() {
  const running = state.current && state.chatState.get(state.current) === 'running';
  const uploading = state.attachments.some((a) => a.xhr);
  els.stop.hidden = !running;
  els.send.disabled = running || uploading;
  els.send.title = uploading ? 'Wait for the files to finish uploading' : '';
}

function autoGrow() { els.input.style.height = 'auto'; els.input.style.height = `${els.input.scrollHeight}px`; }

// Slash command suggestions: / as the first character lists the commands a chat can run.
const commands = initCommands({ input: els.input, menu: $('cmdMenu'), currentChat: () => state.current, onFill: autoGrow });

function submit() {
  const text = els.input.value.trim();
  const attachments = state.attachments.filter((a) => a.id).map((a) => a.id);
  if ((!text && !attachments.length) || els.send.disabled) return;
  stopDictation();
  stopSpeaking();
  if (voiceOn()) unlockSpeech(); // this tap or key lets a phone play the reply when it comes
  els.input.value = '';
  commands.close();
  autoGrow();
  state.attachments = []; // ones that failed to upload are dropped with the rest
  renderAttachments();
  const voice = voiceOn();
  if (!state.current) { state.pending = { text, attachments, voice }; send({ t: 'new', categoryId: state.draft.categoryId, ...picks() }); return; }
  state.speakFor[voice ? 'add' : 'delete'](state.current);
  send({ t: 'send', chatId: state.current, text, attachments, voice, ...picks() });
}

els.composer.addEventListener('submit', (e) => { e.preventDefault(); submit(); });
els.input.addEventListener('keydown', (e) => {
  if (commands.onKeydown(e)) return; // the command list has the arrow keys, Enter, Tab and Esc while it's open
  if (e.key === 'Enter' && !e.shiftKey && !e.isComposing) { e.preventDefault(); submit(); }
});
els.input.addEventListener('input', autoGrow);
els.stop.addEventListener('click', () => { stopSpeaking(); send({ t: 'interrupt', chatId: state.current }); });

// ---- Voice ----------------------------------------------------------------------
// Spoken replies are a per-browser switch, so a phone in the car can talk while the desktop
// stays quiet. While a reply is being read, the speaker button stops it instead of switching.

const hint = $('hint'), HINT = hint.textContent;
export const voiceOn = () => canSpeakAny() && store.get('voiceReplies', false) === true;

// A message in the hint line; with ms, it goes back to the usual hint after that long.
let hintTimer;
function showHint(text = HINT, bad = false, ms = 0) {
  clearTimeout(hintTimer);
  if (ms) hintTimer = setTimeout(() => showHint(), ms);
  hint.textContent = text;
  hint.classList.toggle('bad', bad);
  hint.classList.toggle('live', text !== HINT);
  hint.title = text === HINT ? '' : text;
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
  els.speak.setAttribute('aria-pressed', String(on));
  els.speak.classList.toggle('speaking', talking);
  const label = talking ? 'Stop reading this reply' : on ? 'Spoken replies are on: Claude keeps replies short and reads them aloud. Click to turn off.' : 'Speak replies: Claude keeps replies short and reads them aloud';
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
