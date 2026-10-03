// Settings → Your profile → Voice: the voice and speed for spoken replies, kept in this browser
// only (each device has its own voices), and for admins the Piper server everyone can use.
// Speaking and dictation themselves are lib/speech.js; the Piper relay is server/voice/piper.js.
import { $, h } from '../lib/dom.js';
import { api } from '../lib/api.js';
import { store } from '../lib/store.js';
import { canDictate, canSpeak, canSpeakAny, hasPiper, PIPER, SYSTEM, voices, voiceRate, speak, stopSpeaking, appleVoices } from '../lib/speech.js';
import { refreshMe } from '../shell/profile.js';
import { run, isAdmin, setStatus } from './forms.js';

const form = $('voiceForm'), piperForm = $('piperForm');

// loadServer: also fetch the Piper settings (admins), which clears that form's message.
export function fillVoice(loadServer = true) {
  form.hidden = !canSpeakAny() && !canDictate;
  form.voice.closest('label').hidden = form.rate.closest('label').hidden = $('testVoice').hidden = !canSpeakAny();
  $('voiceHelp').textContent = [
    canSpeakAny() ? 'Saved in this browser only. Turn spoken replies on with the speaker button beside Send.' : 'This browser can\'t read replies aloud.',
    hasPiper() ? 'Automatic uses Nova\'s Piper voice, the same on every device.' : '',
    appleVoices() && !hasPiper() ? 'Safari doesn\'t show web pages the Premium voices you download. To try one anyway, make it the default for your language in Settings, Accessibility, Spoken Content, Voices, then pick Device default voice here.' : '',
    canDictate ? 'Dictation uses the browser\'s own speech recognition: Edge and Chrome send the audio to Microsoft or Google to turn it into text.'
      : 'This browser can\'t take dictation here. Edge or Chrome can, over https or on this computer.'
  ].filter(Boolean).join(' ');
  fillVoiceList();
  const rate = String(voiceRate());
  form.rate.value = [...form.rate.options].some((o) => o.value === rate) ? rate : '1';
  if (loadServer && isAdmin()) loadPiper();
}

// Safari often lists no voices at first and may not say when they arrive, so an empty list
// is asked for again a few times, and again whenever the picker is opened.
let retries = 0;
function fillVoiceList() {
  const list = voices(), picked = store.get('voice.name', '');
  const auto = hasPiper() ? 'Piper' : list[0]?.name;
  form.voice.replaceChildren(h('option', { value: '' }, `Automatic${auto ? ` (${auto})` : ''}`),
    hasPiper() ? h('option', { value: PIPER, selected: picked === PIPER }, 'Piper (Nova\'s voice server)') : null,
    canSpeak ? h('option', { value: SYSTEM, selected: picked === SYSTEM }, 'Device default voice') : null,
    ...list.map((v) => h('option', { value: v.name, selected: v.name === picked }, `${v.name} (${v.lang})`)));
  if (canSpeak && !list.length && retries++ < 10) setTimeout(() => { if ($('settings').open) fillVoiceList(); }, 400);
  else if (list.length) retries = 0;
}
form.voice.addEventListener('focus', () => { if (!voices().length) fillVoiceList(); });

// Voices often arrive after the page loads.
if (canSpeak) {
  const refill = () => { if ($('settings').open && document.activeElement !== form.voice) fillVoiceList(); };
  if (speechSynthesis.addEventListener) speechSynthesis.addEventListener('voiceschanged', refill);
  else speechSynthesis.onvoiceschanged = refill;
}

form.addEventListener('submit', (e) => e.preventDefault());
form.voice.addEventListener('change', () => store.set('voice.name', form.voice.value));
form.rate.addEventListener('change', () => store.set('voice.rate', Number(form.rate.value)));
$('testVoice').addEventListener('click', () => { stopSpeaking(); speak('Hello, this is how replies will sound when spoken replies are on.'); });

// ---- Piper server (admins) --------------------------------------------------------

async function loadPiper() {
  try {
    const s = await api('GET', '/api/settings/voice');
    piperForm.piperUrl.value = s.piperUrl;
    piperForm.piperVoice.value = s.piperVoice;
    setStatus(piperForm.querySelector('.form-status'), '');
  } catch (err) { setStatus(piperForm.querySelector('.form-status'), err.message, true); }
}

piperForm.addEventListener('submit', (e) => {
  e.preventDefault();
  run(piperForm, async () => {
    const s = await api('POST', '/api/settings/voice', { piperUrl: piperForm.piperUrl.value, piperVoice: piperForm.piperVoice.value });
    piperForm.piperUrl.value = s.piperUrl;
    await refreshMe(); // this tab now knows whether Piper is there; others on their next load
    fillVoice(false);
    return s.piperUrl ? 'Piper answered and is saved. Automatic now uses it on every device after a reload.' : 'Piper is off. Each browser uses its own voices.';
  });
});
