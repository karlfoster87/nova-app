// Settings → Your profile → Voice: the voice and speed for spoken replies, kept in this browser
// only (each device has its own voices). Speaking and dictation themselves are lib/speech.js.
import { $, h } from '../lib/dom.js';
import { store } from '../lib/store.js';
import { canDictate, canSpeak, voices, voiceRate, speak, stopSpeaking } from '../lib/speech.js';

const form = $('voiceForm');

export function fillVoice() {
  form.hidden = !canSpeak && !canDictate;
  form.voice.closest('label').hidden = form.rate.closest('label').hidden = $('testVoice').hidden = !canSpeak;
  $('voiceHelp').textContent = [
    canSpeak ? 'Saved in this browser only. Turn spoken replies on with the speaker button beside Send.' : 'This browser can\'t read replies aloud.',
    canDictate ? 'Dictation uses the browser\'s own speech recognition: Edge and Chrome send the audio to Microsoft or Google to turn it into text.'
      : 'This browser can\'t take dictation here. Edge or Chrome can, over https or on this computer.'
  ].join(' ');
  if (!canSpeak) return;
  const list = voices(), picked = store.get('voice.name', '');
  form.voice.replaceChildren(h('option', { value: '' }, `Automatic${list[0] ? ` (${list[0].name})` : ''}`),
    ...list.map((v) => h('option', { value: v.name, selected: v.name === picked }, `${v.name} (${v.lang})`)));
  const rate = String(voiceRate());
  form.rate.value = [...form.rate.options].some((o) => o.value === rate) ? rate : '1';
}

// Voices often arrive after the page loads.
if (canSpeak) speechSynthesis.addEventListener?.('voiceschanged', () => { if (!form.hidden && $('settings').open) fillVoice(); });

form.addEventListener('submit', (e) => e.preventDefault());
form.voice.addEventListener('change', () => store.set('voice.name', form.voice.value));
form.rate.addEventListener('change', () => store.set('voice.rate', Number(form.rate.value)));
$('testVoice').addEventListener('click', () => { stopSpeaking(); speak('Hello, this is how replies will sound when spoken replies are on.'); });
