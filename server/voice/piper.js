// Piper text to speech, so spoken replies sound the same on every device instead of depending
// on each browser's voices. Nova doesn't run or bundle Piper: an admin points it at a Piper
// that's already running somewhere, either Piper's own HTTP server (http://host:5000) or a
// Wyoming server such as Home Assistant's Piper add-on (tcp://host:10200). Browsers ask Nova
// for a sentence or so at a time and get a WAV back; they never talk to Piper themselves, so
// there's no CORS to set up and no plain-http audio on an https page.
import net from 'node:net';
import { config } from '../core/config.js';
import { UserError } from '../core/errors.js';

const TIMEOUT_MS = 20000;
export const MAX_TEXT = 1000; // characters per request; the browser sends a sentence or two
export const piperOn = () => !!config.voice.piperUrl;

// The address an admin typed, tidied, or '' to turn Piper off. Throws if it can't be one.
export function checkPiperUrl(input) {
  const raw = String(input || '').trim();
  if (!raw) return '';
  let url;
  try { url = new URL(raw.includes('://') ? raw : `http://${raw}`); }
  catch { throw new UserError('That isn\'t a valid address. Use http://host:port for Piper\'s HTTP server or tcp://host:port for Wyoming.'); }
  if (!['http:', 'https:', 'tcp:'].includes(url.protocol)) throw new UserError('Use an http://, https:// or tcp:// address.');
  if (!url.hostname) throw new UserError('The address needs a host name or IP address.');
  if (url.protocol === 'tcp:' && !url.port) throw new UserError('A Wyoming address needs its port, usually tcp://host:10200.');
  if (url.username || url.password) throw new UserError('Leave the user name and password out of the address.');
  return url.protocol === 'tcp:' ? `tcp://${url.host}` : url.href.replace(/\/$/, '');
}

export function checkPiperVoice(input) {
  const voice = String(input || '').trim();
  if (voice && !/^[\w.@+-]{1,100}$/.test(voice)) throw new UserError('A voice name is letters, digits, dots, hyphens and underscores, like en_GB-alba-medium.');
  return voice;
}

// One WAV for the text. The address and voice default to the saved ones; Settings passes new
// ones to try them before they're saved.
export async function synthesize(text, { url = config.voice.piperUrl, voice = config.voice.piperVoice } = {}) {
  text = String(text || '').replace(/\s+/g, ' ').trim();
  if (!url) throw new UserError('Piper isn\'t set up. An admin can add it in Settings, under Voice.', 409);
  if (!text) throw new UserError('There\'s nothing to read aloud.');
  if (text.length > MAX_TEXT) throw new UserError(`Send at most ${MAX_TEXT} characters at a time.`, 413);
  try {
    const audio = url.startsWith('tcp://') ? await overWyoming(url, text, voice) : await overHttp(url, text, voice);
    if (audio.length < 44 || audio.toString('latin1', 0, 4) !== 'RIFF') throw new Error('the answer wasn\'t a WAV file');
    return audio;
  } catch (err) {
    if (err instanceof UserError) throw err;
    throw new UserError(`Piper didn't answer at ${url} (${err.cause?.code || err.message}). Check it's running and that Nova's machine can reach it.`, 502);
  }
}

// ---- Piper's HTTP server ---------------------------------------------------------
// The older server (rhasspy/piper) reads ?text= on a GET; the current one (piper1-gpl) only
// takes a POST of JSON and answers a GET with 405. Nova tries the GET first and remembers
// which kind each address is, because posting JSON to the old one would read the JSON aloud.
const httpKind = new Map(); // url -> 'get' | 'post'

async function overHttp(url, text, voice) {
  const signal = AbortSignal.timeout(TIMEOUT_MS);
  if (httpKind.get(url) !== 'post') {
    const res = await fetch(`${url}/?${new URLSearchParams({ text, ...(voice ? { voice } : {}) })}`, { signal });
    if (res.ok) { httpKind.set(url, 'get'); return Buffer.from(await res.arrayBuffer()); }
    if (res.status !== 405) throw new Error(`HTTP ${res.status}`);
  }
  const res = await fetch(`${url}/`, { method: 'POST', signal, headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ text, ...(voice ? { voice } : {}) }) });
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  httpKind.set(url, 'post');
  return Buffer.from(await res.arrayBuffer());
}

// ---- Wyoming ---------------------------------------------------------------------
// Events are a JSON header line, then data_length bytes of more JSON, then payload_length
// bytes of payload. A synthesize event is answered with audio-start, audio-chunks of raw PCM
// and audio-stop, which Nova wraps in a WAV header.
function overWyoming(url, text, voice) {
  const { hostname, port } = new URL(url);
  return new Promise((resolve, reject) => {
    const sock = net.connect({ host: hostname.replace(/^\[|\]$/g, ''), port: Number(port) });
    const fail = (err) => { sock.destroy(); reject(err); };
    sock.setTimeout(TIMEOUT_MS, () => fail(new Error('timed out')));
    sock.on('error', fail);
    sock.on('close', () => reject(new Error('it closed the connection before the audio finished'))); // no-op once resolved
    sock.on('connect', () => sock.write(`${JSON.stringify({ type: 'synthesize', data: { text, ...(voice ? { voice: { name: voice } } : {}) } })}\n`));

    let buf = Buffer.alloc(0), event = null, format = null;
    const pcm = [];
    sock.on('data', (chunk) => {
      try {
        buf = Buffer.concat([buf, chunk]);
        for (;;) {
          if (!event) {
            const nl = buf.indexOf(10);
            if (nl < 0) return;
            event = JSON.parse(buf.toString('utf8', 0, nl));
            buf = buf.subarray(nl + 1);
          }
          const dataLen = event.data_length || 0, payloadLen = event.payload_length || 0;
          if (buf.length < dataLen + payloadLen) return;
          const data = { ...event.data, ...(dataLen ? JSON.parse(buf.toString('utf8', 0, dataLen)) : {}) };
          const payload = Buffer.from(buf.subarray(dataLen, dataLen + payloadLen));
          const type = event.type;
          buf = buf.subarray(dataLen + payloadLen);
          event = null;
          if ((type === 'audio-start' || type === 'audio-chunk') && data.rate) format ??= data;
          if (type === 'audio-chunk') pcm.push(payload);
          else if (type === 'error') return fail(new Error(data.text || 'it reported an error'));
          else if (type === 'audio-stop') { resolve(wav(Buffer.concat(pcm), format || {})); sock.end(); return; }
        }
      } catch (err) { fail(err); }
    });
  });
}

function wav(pcm, { rate = 22050, width = 2, channels = 1 }) {
  const head = Buffer.alloc(44);
  head.write('RIFF', 0, 'latin1');
  head.writeUInt32LE(36 + pcm.length, 4);
  head.write('WAVEfmt ', 8, 'latin1');
  head.writeUInt32LE(16, 16);
  head.writeUInt16LE(1, 20); // PCM
  head.writeUInt16LE(channels, 22);
  head.writeUInt32LE(rate, 24);
  head.writeUInt32LE(rate * channels * width, 28);
  head.writeUInt16LE(channels * width, 32);
  head.writeUInt16LE(width * 8, 34);
  head.write('data', 36, 'latin1');
  head.writeUInt32LE(pcm.length, 40);
  return Buffer.concat([head, pcm]);
}
