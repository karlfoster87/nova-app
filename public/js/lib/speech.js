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
// and tables are mentioned rather than read out. Text goes to the browser a sentence or so at
// a time, because Chrome cuts off a single long utterance after about 15 seconds.

let queued = []; // utterances not finished, kept referenced (Chrome drops events of collected ones)
const listeners = new Set();
const tell = () => { for (const fn of listeners) fn(queued.length > 0); };
export const onSpeaking = (fn) => listeners.add(fn);
export const isSpeaking = () => queued.length > 0;

// The voice and speed picked in Settings (this browser only), else the best voice for the
// browser's language: Edge's "Natural" and Chrome's "Google" voices sound far better than the
// system defaults.
export function voices() {
  if (!canSpeak) return [];
  const all = speechSynthesis.getVoices();
  const l = lang().toLowerCase(), base = l.split('-')[0];
  const rank = (v) => {
    const vl = v.lang.toLowerCase().replace('_', '-');
    return (vl === l ? 0 : vl.startsWith(base) ? 2 : 4) + (/natural|online|google/i.test(v.name) ? 0 : 1);
  };
  return all.filter((v) => v.lang.toLowerCase().startsWith(base)).sort((a, b) => rank(a) - rank(b) || a.name.localeCompare(b.name))
    .concat(all.filter((v) => !v.lang.toLowerCase().startsWith(base)));
}
const pickVoice = () => { const list = voices(); return list.find((v) => v.name === store.get('voice.name', '')) || list[0] || null; };
export const voiceRate = () => Number(store.get('voice.rate', 1)) || 1;

export function stopSpeaking() {
  if (!canSpeak) return;
  queued = [];
  speechSynthesis.cancel();
  tell();
}

export function speak(markdown) {
  if (!canSpeak) return;
  const voice = pickVoice(), rate = voiceRate();
  for (const part of chunks(speakable(markdown))) {
    const u = new SpeechSynthesisUtterance(part);
    if (voice) { u.voice = voice; u.lang = voice.lang; } else u.lang = lang();
    u.rate = rate;
    u.onend = u.onerror = () => { queued = queued.filter((x) => x !== u); tell(); };
    queued.push(u);
    speechSynthesis.speak(u);
  }
  tell();
}

// Mobile browsers only speak after a tap has spoken once. Called from the tap that turns
// spoken replies on, so replies arriving later are heard.
export function unlockSpeech() {
  if (!canSpeak) return;
  const u = new SpeechSynthesisUtterance('');
  u.volume = 0;
  speechSynthesis.speak(u);
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
