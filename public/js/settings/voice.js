// Settings → Your profile → Voice. First how this browser reads replies aloud (none, its own
// voices, or Piper), then that engine's settings: the browser voice, or the Piper server (whose
// address only admins set, for everyone). None is the default, and hides the speaker button.
// The choice and speed are kept in this browser only. Speaking and dictation themselves are
// lib/speech.js; the Piper relay is server/voice/piper.js.
import { $, h } from '../lib/dom.js';
import { api } from '../lib/api.js';
import { store } from '../lib/store.js';
import { canDictate, canSpeak, canSpeakReplies, hasPiper, engine, setEngine, voices, voiceRate, speak, stopSpeaking } from '../lib/speech.js';
import { refreshMe } from '../shell/profile.js';
import { run, isAdmin, setStatus } from './forms.js';

const form = $('voiceForm'), status = form.querySelector('.form-status');

// loadServer: also fetch the Piper address (admins), which clears the form's message.
export function fillVoice(loadServer = true) {
  const opt = (value) => form.engine.querySelector(`option[value="${value}"]`);
  opt('browser').disabled = !canSpeak;
  opt('browser').textContent = canSpeak ? 'This browser\'s voices' : 'This browser\'s voices (not available here)';
  opt('piper').disabled = !hasPiper() && !isAdmin();
  opt('piper').textContent = hasPiper() || isAdmin() ? 'Piper' : 'Piper (not set up)';
  form.engine.value = engine();
  const rate = String(voiceRate());
  form.rate.value = [...form.rate.options].some((o) => o.value === rate) ? rate : '1';
  showEngine();
  if (loadServer && isAdmin()) loadPiper();
}

function showEngine() {
  const e = engine();
  $('browserVoice').hidden = e !== 'browser';
  $('piperVoice').hidden = e !== 'piper';
  $('piperAdmin').hidden = !isAdmin();
  $('voicePlayback').hidden = !canSpeakReplies();
  if (e === 'browser') fillVoiceList();
  $('piperState').textContent = hasPiper()
    ? (isAdmin() ? 'Nova reads replies through this Piper server, for everyone who picks Piper. Clear the address to turn it off.'
      : 'Replies are read by the Piper server an admin has set up, so they sound the same on every device.')
    : (isAdmin() ? 'Where Piper runs: http://host:5000 for its HTTP server, or tcp://host:10200 for Wyoming (such as Home Assistant\'s Piper add-on, with its port published in the add-on\'s Network settings). The machine running Nova must be able to reach it.'
      : 'Piper isn\'t set up yet. Ask an admin to add it here.');
  $('voiceHelp').textContent = [
    e === 'none' ? 'Pick how replies are read aloud in this browser. The speaker button beside Send appears once you do.' : 'Saved in this browser only. Turn spoken replies on with the speaker button beside Send.',
    canDictate ? 'Dictation uses the browser\'s own speech recognition: Edge and Chrome send the audio to Microsoft or Google to turn it into text.'
      : 'This browser can\'t take dictation here. Edge or Chrome can, over https or on this computer.'
  ].join(' ');
}

// The browser's voices as it lists them. Safari often lists none at first and may not say when
// they arrive, so an empty list is asked for again a few times, and again when the picker opens.
let retries = 0;
function fillVoiceList() {
  const list = voices(), picked = store.get('voice.name', '');
  form.voice.replaceChildren(h('option', { value: '' }, 'Browser default'),
    ...list.map((v) => h('option', { value: v.name, selected: v.name === picked }, `${v.name} (${v.lang})`)));
  if (canSpeak && !list.length && retries++ < 10) setTimeout(() => { if ($('settings').open && engine() === 'browser') fillVoiceList(); }, 400);
  else if (list.length) retries = 0;
}
form.voice.addEventListener('focus', () => { if (!voices().length) fillVoiceList(); });
if (canSpeak) {
  const refill = () => { if ($('settings').open && engine() === 'browser' && document.activeElement !== form.voice) fillVoiceList(); };
  if (speechSynthesis.addEventListener) speechSynthesis.addEventListener('voiceschanged', refill);
  else speechSynthesis.onvoiceschanged = refill;
}

form.addEventListener('submit', (e) => e.preventDefault());
form.engine.addEventListener('change', () => {
  stopSpeaking();
  setEngine(form.engine.value);
  setStatus(status, '');
  showEngine();
});
form.voice.addEventListener('change', () => store.set('voice.name', form.voice.value));
form.rate.addEventListener('change', () => store.set('voice.rate', Number(form.rate.value)));
$('testVoice').addEventListener('click', () => { stopSpeaking(); speak('Hello, this is how replies will sound when spoken replies are on.'); });

// ---- Piper server (admins) --------------------------------------------------------

async function loadPiper() {
  try {
    const s = await api('GET', '/api/settings/voice');
    form.piperUrl.value = s.piperUrl;
    form.piperVoice.value = s.piperVoice;
    setStatus(status, '');
  } catch (err) { setStatus(status, err.message, true); }
}

$('savePiper').addEventListener('click', () => run(form, async () => {
  const s = await api('POST', '/api/settings/voice', { piperUrl: form.piperUrl.value, piperVoice: form.piperVoice.value });
  form.piperUrl.value = s.piperUrl;
  await refreshMe(); // tells lib/speech.js whether Piper is there; the server tells other tabs
  fillVoice(false);
  return s.piperUrl ? 'Piper answered and is saved. Anyone who picks Piper now hears it.' : 'Piper is off. Browsers set to Piper read nothing until it\'s back.';
}));
