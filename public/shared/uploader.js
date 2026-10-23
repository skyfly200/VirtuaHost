// Uploading audio for the sound library: a background (music bed), an intro, an outro or a sound effect.
// The file is decoded in the browser and sent as a mono 32 kHz WAV, so any format the browser plays (mp3, m4a, ogg, wav, flac) works and the site
// can mix it on the server too (it has no MP3 decoder). Long files are shortened to fit the upload limit (about 5 MB).
import { h, toast } from './kit.js';
import { toWav } from '../generate/mixer.js';

export const UPLOAD_RATE = 32000;
export const MAX_SECONDS = { sfx: 30, music: 80, intro: 60, outro: 60 };
export const KIND_LABELS = { music: 'Background music', intro: 'Intro', outro: 'Outro', sfx: 'Sound effect' };

// File -> { wav: Uint8Array, seconds, trimmed }. Throws a plain message when the browser cannot read the file.
export async function convertForUpload(file, kind = 'music') {
  const limit = MAX_SECONDS[kind] || 60;
  let buffer;
  try {
    buffer = await new OfflineAudioContext(1, 1, UPLOAD_RATE).decodeAudioData(await file.arrayBuffer());   // decoding also resamples to the context's rate
  } catch {
    throw new Error(`"${file.name}" is not audio this browser can read. Try an mp3, wav, m4a or ogg file.`);
  }
  const mono = new Float32Array(buffer.length);
  for (let c = 0; c < buffer.numberOfChannels; c++) { const data = buffer.getChannelData(c); for (let i = 0; i < data.length; i++) mono[i] += data[i] / buffer.numberOfChannels; }
  const keep = Math.min(mono.length, Math.round(limit * UPLOAD_RATE));
  const samples = mono.subarray(0, keep);
  return { wav: toWav(samples, UPLOAD_RATE), seconds: keep / UPLOAD_RATE, trimmed: keep < mono.length };
}

export async function uploadAudio(api, file, { kind, name } = {}) {
  const { wav, seconds, trimmed } = await convertForUpload(file, kind);
  const meta = { kind, file: file.name.replace(/\.[^.]+$/, '') + '.wav', seconds, ...(name ? { name } : {}) };
  const saved = await api.request('POST', '/uploads', { raw: new Blob([wav], { type: 'audio/wav' }), contentType: 'audio/wav', headers: { 'x-upload-meta': encodeURIComponent(JSON.stringify(meta)) } });
  if (trimmed) toast(`"${saved.name}" was longer than ${MAX_SECONDS[kind] || 60} seconds, so only the start was kept.`, 'info');
  return saved;
}

// A button that opens the file picker and uploads the choice. onUploaded(saved) runs after a successful upload.
export function uploadButton(api, { kind, label = 'Upload a file', onUploaded = () => {}, className = '' } = {}) {
  const input = h('input', { type: 'file', accept: 'audio/*', hidden: true });
  const button = h('button', { type: 'button', class: className, onclick: () => input.click() }, label);
  input.addEventListener('change', async () => {
    const file = input.files && input.files[0];
    input.value = '';
    if (!file) return;
    button.disabled = true; const was = button.textContent; button.textContent = 'Uploading...';
    try { const saved = await uploadAudio(api, file, { kind }); toast(`Uploaded as "${saved.name}"`, 'info'); await onUploaded(saved); } catch (err) { toast(err.message, 'error'); } finally { button.disabled = false; button.textContent = was; }
  });
  return h('span', {}, button, input);
}
