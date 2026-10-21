// "Download" for any generated audio: the file as it is, or converted to WAV or MP3. Conversion happens in the browser (the audio
// is decoded with Web Audio, then written as 16-bit WAV or encoded with lamejs, which is loaded from a CDN the first time MP3 is
// chosen). `load` returns a Blob or an object URL and is called each time, so it always gets the current audio.
import { h, toast } from './kit.js';

const LAME = 'https://cdnjs.cloudflare.com/ajax/libs/lamejs/1.2.1/lame.min.js';
const EXT = { 'audio/wav': 'wav', 'audio/x-wav': 'wav', 'audio/wave': 'wav', 'audio/mpeg': 'mp3', 'audio/mp3': 'mp3' };
const kind = (blob) => EXT[(blob.type || '').split(';')[0].toLowerCase()] || 'wav';
const slug = (s) => String(s || 'clip').toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 50) || 'clip';

const toBlob = async (loaded) => (typeof loaded === 'string' ? (await fetch(loaded)).blob() : loaded);

async function decode(blob) {
  const Ctx = window.AudioContext || window.webkitAudioContext;
  const ctx = new Ctx();
  try { return await ctx.decodeAudioData(await blob.arrayBuffer()); } finally { if (ctx.close) ctx.close(); }
}

const pcm16 = (channel) => {
  const out = new Int16Array(channel.length);
  for (let i = 0; i < channel.length; i += 1) { const v = Math.max(-1, Math.min(1, channel[i])); out[i] = v < 0 ? v * 0x8000 : v * 0x7fff; }
  return out;
};

export function encodeWav(buffer) {
  const channels = Math.min(2, buffer.numberOfChannels);
  const frames = buffer.length;
  const data = new DataView(new ArrayBuffer(44 + frames * channels * 2));
  const str = (o, s) => { for (let i = 0; i < s.length; i += 1) data.setUint8(o + i, s.charCodeAt(i)); };
  str(0, 'RIFF'); data.setUint32(4, 36 + frames * channels * 2, true); str(8, 'WAVE'); str(12, 'fmt ');
  data.setUint32(16, 16, true); data.setUint16(20, 1, true); data.setUint16(22, channels, true);
  data.setUint32(24, buffer.sampleRate, true); data.setUint32(28, buffer.sampleRate * channels * 2, true); data.setUint16(32, channels * 2, true); data.setUint16(34, 16, true);
  str(36, 'data'); data.setUint32(40, frames * channels * 2, true);
  const chans = Array.from({ length: channels }, (_, c) => buffer.getChannelData(c));
  let o = 44;
  for (let i = 0; i < frames; i += 1) for (let c = 0; c < channels; c += 1) { const v = Math.max(-1, Math.min(1, chans[c][i])); data.setInt16(o, v < 0 ? v * 0x8000 : v * 0x7fff, true); o += 2; }
  return new Blob([data], { type: 'audio/wav' });
}

let lamePromise;
const lame = () => (window.lamejs ? Promise.resolve(window.lamejs) : (lamePromise ||= new Promise((resolve, reject) => {
  const s = document.createElement('script');
  s.src = LAME; s.onload = () => resolve(window.lamejs); s.onerror = () => { lamePromise = null; reject(new Error('Could not load the MP3 encoder. Check your connection, or download the WAV instead.')); };
  document.head.append(s);
})));

async function encodeMp3(buffer) {
  const { Mp3Encoder } = await lame();
  const channels = Math.min(2, buffer.numberOfChannels);
  const enc = new Mp3Encoder(channels, buffer.sampleRate, 128);
  const left = pcm16(buffer.getChannelData(0));
  const right = channels === 2 ? pcm16(buffer.getChannelData(1)) : null;
  const parts = [];
  for (let i = 0; i < left.length; i += 1152) {
    const chunk = right ? enc.encodeBuffer(left.subarray(i, i + 1152), right.subarray(i, i + 1152)) : enc.encodeBuffer(left.subarray(i, i + 1152));
    if (chunk.length) parts.push(chunk);
  }
  const end = enc.flush();
  if (end.length) parts.push(end);
  return new Blob(parts, { type: 'audio/mpeg' });
}

export function saveBlob(blob, filename) {
  const url = URL.createObjectURL(blob);
  const a = h('a', { href: url, download: filename });
  document.body.append(a); a.click(); a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 10_000);
}

/** format: 'original' | 'wav' | 'mp3'. Returns the Blob to save, converting only when needed. */
export async function convert(blob, format) {
  if (format === 'original' || kind(blob) === format) return blob;
  const decoded = await decode(blob);
  return format === 'mp3' ? encodeMp3(decoded) : encodeWav(decoded);
}

export function downloadMenu({ load, name }) {
  const menu = h('details', { class: 'dl', style: 'display:inline-block;position:relative' });
  const go = (format) => async (e) => {
    const button = e.currentTarget;
    button.disabled = true;
    try {
      const source = await toBlob(await load());
      const out = await convert(source, format);
      saveBlob(out, `${slug(typeof name === 'function' ? name() : name)}.${kind(out)}`);
      menu.open = false;
    } catch (err) { toast(err.message || 'Could not prepare the download.', 'error'); } finally { button.disabled = false; }
  };
  menu.append(
    h('summary', { class: 'button', title: 'Download this audio', style: 'cursor:pointer' }, '⬇ Download'),
    h('div', { class: 'card', style: 'position:absolute;z-index:5;padding:6px;display:grid;gap:4px;min-width:150px' },
      h('button', { type: 'button', onclick: go('original') }, 'As saved'),
      h('button', { type: 'button', onclick: go('wav') }, 'WAV'),
      h('button', { type: 'button', onclick: go('mp3') }, 'MP3')));
  return menu;
}
