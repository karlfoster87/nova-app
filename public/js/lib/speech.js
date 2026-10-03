// Voice, using only what the browser has: dictation into a text box (SpeechRecognition) and
// reading Claude's replies aloud (speechSynthesis). Nothing is added to the server and no
// dependency is needed. Support varies: Chrome and Edge do both (their recognition sends the
// audio to Google or Microsoft), Safari mostly, Firefox only speaks. Callers hide the buttons
// when canDictate / canSpeak are false. Recognition also needs a secure context (https or
// localhost), so a plain-http LAN address gets no microphone button.
import { renderMarkdown } from './markdown.js';
import { store } from './store.js';

const Recognition = window.SpeechRecognition || window.webkitSpeechRecognition;
export const canDictate = !!Recognition && window.isSecureContext;
export const canSpeak = 'speechSynthesis' in window && typeof SpeechSynthesisUtterance === 'function';
const lang = () => navigator.language || 'en-GB';

// ---- Dictation ------------------------------------------------------------------
// One text box listens at a time. Words go in at the cursor: interim words show straight away
// and are replaced as the recogniser settles on them. Typing, or any key but a modifier, stops
// listening, so dictation never fights the keyboard. Each change fires 'input', so the box's
// own handlers (autogrow, save as you type) run as if typed.

const ERRORS = {
  'not-allowed': 'Microphone access is blocked. Allow it for this site in the browser\'s settings, then try again.',
  'service-not-allowed': 'This browser won\'t run dictation here. Try Edge or Chrome.',
  'audio-capture': 'No microphone was found. Connect one and try again.',
  network: 'Dictation needs an internet connection: the browser sends the audio to its speech service.',
  'language-not-supported': `Dictation doesn't support your browser's language (${lang()}).`
};

let session = null; // { rec, input, onState, at, interim }

export const dictating = (input) => !!session && (!input || session.input === input);

export function stopDictation() {
  if (!session) return;
  const s = session;
  session = null;
  s.input.removeEventListener('keydown', s.onKey);
  try { s.rec.abort(); } catch {}
  s.onState?.({ listening: false });
}

// onState({ listening, error? }) follows the session, for the button's look and any message.
export function startDictation(input, { onState } = {}) {
  stopDictation();
  if (!canDictate) return;
  const rec = new Recognition();
  rec.lang = lang();
  // Android's recogniser repeats earlier words in continuous mode, so there it takes one
  // phrase per tap and stops at the pause.
  rec.continuous = !/Android/i.test(navigator.userAgent);
  rec.interimResults = true;
  const s = { rec, input, onState, at: input.selectionEnd, interim: 0 };
  s.onKey = (e) => { if (!['Shift', 'Control', 'Alt', 'Meta', 'CapsLock'].includes(e.key)) stopDictation(); };
  input.addEventListener('keydown', s.onKey);
  session = s;

  rec.onresult = (e) => {
    if (session !== s) return;
    let done = '', interim = '';
    for (let i = e.resultIndex; i < e.results.length; i++) {
      if (e.results[i].isFinal) done += e.results[i][0].transcript;
      else interim += e.results[i][0].transcript;
    }
    // Last time's interim words are replaced by this time's settled and interim ones.
    const before = input.value.slice(0, s.at);
    const settled = done ? fitText(before, done) : '';
    const shown = interim ? fitText(before + settled, interim) : '';
    input.setRangeText(settled + shown, s.at, s.at + s.interim, 'end');
    s.at += settled.length;
    s.interim = shown.length;
    input.dispatchEvent(new Event('input'));
  };
  rec.onerror = (e) => {
    if (session !== s || e.error === 'no-speech' || e.error === 'aborted') return;
    session = null;
    input.removeEventListener('keydown', s.onKey);
    onState?.({ listening: false, error: ERRORS[e.error] || `Dictation stopped (${e.error}).` });
  };
  // The browser ends a session by itself after a pause; that's the natural stop.
  rec.onend = () => { if (session === s) stopDictation(); };
  try { rec.start(); } catch (err) { session = null; onState?.({ listening: false, error: `Dictation didn't start: ${err.message}` }); return; }
  onState?.({ listening: true });
}

export function toggleDictation(input, opts) {
  if (dictating(input)) stopDictation();
  else startDictation(input, opts);
}

// Spaces and capitals the way they'd be typed: a space after the existing text, a capital
// letter to start the box or a sentence.
function fitText(before, words) {
  let text = words.trim();
  if (!text) return '';
  if (!before.trim() || /[.!?]\s*$|\n\s*$/.test(before)) text = text[0].toUpperCase() + text.slice(1);
  return before && !/\s$/.test(before) ? ` ${text}` : text;
}

// ---- Speaking -------------------------------------------------------------------
// Replies arrive as markdown. They're rendered as usual, then read as plain sentences: code
// and tables are mentioned rather than read out. Text goes out a sentence or so at a time,
// because Chrome cuts off a single long utterance after about 15 seconds, and so Piper's first
// sentence plays while the next is being made.
//
// The engine is picked per browser in Settings (nova.voice.engine): 'none', the default, means
// no spoken replies and no speaker button; 'browser' uses speechSynthesis with a voice from the
// browser's own list; 'piper' goes through Nova's server to a Piper an admin has set up
// (server/voice/piper.js), so every device sounds the same. A sentence Piper can't make is read
// by the browser instead.

export const ENGINES = ['none', 'browser', 'piper'];
let piper = false;
const changeListeners = new Set();
const changed = () => { for (const fn of changeListeners) fn(); };
export const onVoiceChange = (fn) => changeListeners.add(fn);
export const setPiper = (on) => { piper = !!on; changed(); };
export const hasPiper = () => piper;
export function engine() { const e = store.get('voice.engine', 'none'); return ENGINES.includes(e) ? e : 'none'; }
export function setEngine(e) { store.set('voice.engine', ENGINES.includes(e) ? e : 'none'); changed(); }
// Whether replies can be spoken here: an engine is picked and can run in this browser.
export const canSpeakReplies = () => (engine() === 'browser' ? canSpeak : engine() === 'piper' ? piper : false);

let queued = []; // utterances not finished, kept referenced (Chrome drops events of collected ones)
let pending = 0; // Piper sentences not yet played
const listeners = new Set();
export const isSpeaking = () => queued.length > 0 || pending > 0;
const tell = () => { for (const fn of listeners) fn(isSpeaking()); };
export const onSpeaking = (fn) => listeners.add(fn);

// The browser's voices exactly as it lists them. Some browsers (Safari especially) list none
// until a moment after the page loads; Settings asks again. '' is the browser's default voice
// for the page's language.
export const voices = () => (canSpeak ? speechSynthesis.getVoices() : []);
const pickVoice = () => { const name = store.get('voice.name', ''); return (name && voices().find((v) => v.name === name)) || null; };
export const voiceRate = () => Number(store.get('voice.rate', 1)) || 1;

export function stopSpeaking() {
  gen++;
  pending = 0;
  if (player) { player.pause(); endPlay?.(); }
  queued = [];
  if (canSpeak) speechSynthesis.cancel();
  tell();
}

export function speak(markdown) {
  const parts = chunks(speakable(markdown));
  if (!parts.length) return;
  if (engine() === 'piper' && piper) speakPiper(parts);
  else if (engine() === 'browser') speakBrowser(parts);
}

function speakBrowser(parts) {
  if (!canSpeak) return;
  const voice = pickVoice(), rate = voiceRate();
  for (const part of parts) {
    const u = new SpeechSynthesisUtterance(part);
    if (voice) { u.voice = voice; u.lang = voice.lang; } else u.lang = lang();
    u.rate = rate;
    u.onend = u.onerror = () => { queued = queued.filter((x) => x !== u); tell(); };
    queued.push(u);
    speechSynthesis.speak(u);
  }
  tell();
}

// Piper: sentences are fetched one after another (so the server isn't asked for a whole reply
// at once) and played in order through one <audio>, which iOS only lets play after a tap has
// started it once (unlockSpeech). gen moves on when speech is stopped, so late answers are
// dropped. The speed setting becomes the playback rate, which keeps the pitch.
let player = null, endPlay = null, gen = 0;
let fetching = Promise.resolve(), playing = Promise.resolve();
const getPlayer = () => (player ??= new Audio());

async function piperAudio(text) {
  const res = await fetch('/api/voice/speak', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ text }) });
  if (!res.ok) throw new Error((await res.json().catch(() => ({}))).error || `Piper failed (${res.status})`);
  return URL.createObjectURL(await res.blob());
}

function speakPiper(parts) {
  const my = gen;
  for (const text of parts) {
    pending++;
    const audio = fetching = fetching.then(() => (my === gen ? piperAudio(text) : null)).catch((err) => ({ err, text }));
    playing = playing.then(async () => {
      const got = await audio;
      if (my !== gen) { if (typeof got === 'string') URL.revokeObjectURL(got); return; }
      try {
        if (typeof got === 'string') await play(got);
        else if (got?.err) { console.warn('Piper failed, so the browser\'s voice reads this part:', got.err.message); speakBrowser([got.text]); }
      } catch (err) { console.error('Couldn\'t read this part aloud:', err); }
      if (my !== gen) return; // stopped while it played
      pending--;
      tell();
    });
  }
  tell();
}

function play(url) {
  const p = getPlayer();
  return new Promise((resolve) => {
    const done = () => { p.onended = p.onerror = null; endPlay = null; URL.revokeObjectURL(url); resolve(); };
    endPlay = done;
    p.onended = p.onerror = done;
    p.src = url;
    p.defaultPlaybackRate = p.playbackRate = voiceRate();
    p.play().catch(done); // refused (no tap yet on iOS): skip rather than hang the queue
  });
}

// Mobile browsers only speak after a tap has started speech once. Called from taps (turning
// spoken replies on, sending), so replies arriving later are heard.
export function unlockSpeech() {
  if (canSpeak) {
    const u = new SpeechSynthesisUtterance('');
    u.volume = 0;
    speechSynthesis.speak(u);
  }
  if (engine() === 'piper' && piper && !isSpeaking()) {
    const p = getPlayer();
    p.src = URL.createObjectURL(new Blob([silentWav()], { type: 'audio/wav' }));
    p.play().catch(() => {});
  }
}

// A tenth of a second of silence, to start the player from a tap.
function silentWav() {
  const rate = 8000, n = rate / 10, b = new DataView(new ArrayBuffer(44 + n * 2));
  const text = (at, s) => { for (let i = 0; i < s.length; i++) b.setUint8(at + i, s.charCodeAt(i)); };
  text(0, 'RIFF'); b.setUint32(4, 36 + n * 2, true); text(8, 'WAVEfmt '); b.setUint32(16, 16, true);
  b.setUint16(20, 1, true); b.setUint16(22, 1, true); b.setUint32(24, rate, true); b.setUint32(28, rate * 2, true);
  b.setUint16(32, 2, true); b.setUint16(34, 16, true); text(36, 'data'); b.setUint32(40, n * 2, true);
  return b.buffer;
}

// Markdown to plain sentences: each block on its own, ending in a full stop if it had none.
export function speakable(markdown) {
  const tpl = document.createElement('template');
  tpl.innerHTML = renderMarkdown(markdown); // sanitised, and a template never runs or loads anything
  const root = tpl.content;
  for (const el of root.querySelectorAll('pre')) el.replaceWith('There\'s some code on screen.');
  for (const el of root.querySelectorAll('table')) el.replaceWith('There\'s a table on screen.');
  for (const el of root.querySelectorAll('img, svg, hr')) el.remove();
  for (const el of root.querySelectorAll('p, li, h1, h2, h3, h4, h5, h6, blockquote, td, th, br')) el.append('\n');
  return root.textContent.split('\n').map((l) => l.replace(/\s+/g, ' ').trim()).filter(Boolean)
    .map((l) => /[.!?:;…]$/.test(l) ? l : `${l}.`).join(' ');
}

function chunks(text, max = 220) {
  const out = [];
  // Split after a sentence's end and a space, so "3.5" stays whole.
  for (const s of text.split(/(?<=[.!?…]["')\]]*)\s+/)) {
    if (!s) continue;
    if (out.length && (out.at(-1).length + s.length + 1) <= max) out[out.length - 1] += ` ${s}`;
    else out.push(s);
  }
  return out;
}
