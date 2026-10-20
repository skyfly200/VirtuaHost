// Speaks a script through the site and mixes it in the browser: each stretch of text goes to /api/generate (preview, nothing
// stored), [sfx:...] and [music:...] tags are mixed in (built-in effects, the cloud library, a music bed), an optional audio
// treatment is applied, and one playable file comes back. Shared by the Generate tab, Voice Lab and the persona explorer.
import { parseTags, mix, toWav, effectNames, RATE } from '../generate/mixer.js';
import { applyFx } from '../generate/fx.js';
import { stationId } from './station.js';

export const bytesOf = (b64) => Uint8Array.from(atob(b64), (c) => c.charCodeAt(0));

// The active station's defaults (persona, voice, model) apply to anything the request leaves out.
const withStation = (base) => (base.station || !stationId() ? base : { ...base, station: stationId() });

export function createSpeaker(api, features) {
  const library = { sfx: [], music: [] };
  const cache = new Map();

  async function loadLibrary() {
    const f = features && features.library;
    if (!f || !(f.sfx || f.music)) return library;
    try { for (const item of (await api.get('/library')).items) (library[item.kind] || []).push(item); } catch { /* built-in effects still work */ }
    return library;
  }
  const item = (kind, name) => library[kind].find((i) => i.name === name);
  const soundNames = () => [...effectNames(), ...library.sfx.map((i) => i.name)];

  async function decode(bytes) {
    const buffer = await new OfflineAudioContext(1, 1, RATE).decodeAudioData(bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength));
    return buffer.getChannelData(0);
  }
  async function librarySamples(kind, name) {
    const key = `${kind}/${name}`;
    if (!cache.has(key)) {
      const found = item(kind, name);
      const blob = await api.get(`/library/${encodeURIComponent(found.source)}/${kind}/${encodeURIComponent(found.name)}`, { blob: true });
      cache.set(key, await decode(new Uint8Array(await blob.arrayBuffer())));
    }
    return cache.get(key);
  }

  function check(pieces) {
    for (const p of pieces) {
      if (p.type === 'sfx' && !effectNames().includes(p.name) && !item('sfx', p.name)) throw new Error(`Unknown sound effect "${p.name}". Available: ${soundNames().join(', ')}`);
      if (p.type === 'music' && !item('music', p.name)) throw new Error(library.music.length ? `Unknown music "${p.name}". Available: ${library.music.map((i) => i.name).join(', ')}` : 'No music library is connected (see docs/LIBRARY.md).');
    }
  }

  async function toItems(results) {
    const items = [];
    for (const r of results) {
      if (r.type === 'speech') items.push({ kind: 'speech', samples: await decode(bytesOf(r.data.audio)) });
      else if (r.type === 'silence') items.push({ kind: 'speech', samples: new Float32Array(Math.round(r.seconds * RATE)) });
      else if (r.type === 'music') items.push({ kind: 'music', vol: r.vol, samples: await librarySamples('music', r.name) });
      else items.push({ kind: 'sfx', name: r.name, vol: r.vol, over: r.over, wait: r.wait, ...(effectNames().includes(r.name) ? {} : { samples: await librarySamples('sfx', r.name) }) });
    }
    return items;
  }

  const tagText = (r) => `[${r.type}:${r.name}${r.over ? ' over' : ''}${r.vol !== (r.type === 'music' ? 0.25 : 1) ? ` vol=${r.vol}` : ''}${r.wait ? ` wait=${r.wait}` : ''}]`;

  // One script, one voice. `base` is the /api/generate body without the text (persona, voice, speechModel, tone, ...).
  async function render(text, base, { fx = '', onProgress = () => {} } = {}) {
    const pieces = parseTags(text);
    const tagged = pieces.filter((p) => p.type !== 'speech');
    check(pieces);
    if (!pieces.some((p) => p.type === 'speech')) throw new Error('Add some words to speak as well as the sound effects.');

    const results = [];
    const total = pieces.filter((p) => p.type === 'speech').length;
    const steps = total + (tagged.length || fx ? 1 : 0);     // each stretch of speech, then the mix
    for (const piece of pieces) {
      if (piece.type !== 'speech') { results.push(piece); continue; }
      const n = results.filter((r) => r.type === 'speech').length + 1;
      onProgress(`Generating speech${total > 1 ? ` (${n} of ${total})` : ''}`, { step: n, total: steps });
      results.push({ type: 'speech', data: await api.post('/generate', { ...withStation(base), mode: 'say', preview: true, text: piece.text }) });
    }
    const first = results.find((r) => r.type === 'speech').data;
    let blob;
    if (!tagged.length && !fx) {
      blob = new Blob([bytesOf(first.audio)], { type: first.mimeType });
    } else {
      onProgress(tagged.length ? 'Mixing in the effects' : 'Applying the effect', { step: steps, total: steps });
      blob = new Blob([toWav(applyFx(mix(await toItems(results)), fx))], { type: 'audio/wav' });
    }
    const scriptText = tagged.length ? results.map((r) => (r.type === 'speech' ? r.data.scriptText : tagText(r))).join(' ') : first.scriptText;
    return { blob, scriptText, first, effects: tagged.map((p) => p.name) };
  }

  // A conversation: lines = [{ speaker, text, base }], each spoken with its own voice settings and joined with a short gap.
  async function renderDialogue(lines, { gap = 0.3, fx = '', onProgress = () => {} } = {}) {
    const results = [];
    const names = [];
    let beds = 0;
    for (const [n, line] of lines.entries()) {
      const pieces = parseTags(line.text);
      check(pieces);
      if (!pieces.some((p) => p.type === 'speech')) continue;
      onProgress(`Line ${n + 1} of ${lines.length} (${line.speaker})`, { step: n + 1, total: lines.length + 1 });
      for (const piece of pieces) {
        if (piece.type === 'music') { if (++beds > 1) throw new Error('Use only one [music:...] bed per conversation.'); results.unshift(piece); names.push(piece.name); continue; }
        if (piece.type === 'sfx') { results.push(piece); names.push(piece.name); continue; }
        results.push({ type: 'speech', data: await api.post('/generate', { ...withStation(line.base), mode: 'say', preview: true, text: piece.text }) });
      }
      if (n < lines.length - 1) results.push({ type: 'silence', seconds: gap });
    }
    const first = results.find((r) => r.type === 'speech');
    if (!first) throw new Error('There is nothing to say yet.');
    onProgress('Mixing the conversation', { step: lines.length + 1, total: lines.length + 1 });
    const blob = new Blob([toWav(applyFx(mix(await toItems(results)), fx))], { type: 'audio/wav' });
    return { blob, scriptText: lines.map((l) => `${l.speaker}: ${l.text}`).join('\n'), first: first.data, effects: names };
  }

  return { library, loadLibrary, render, renderDialogue, soundNames };
}

// "Name: line" per line (a bracketed note after the name is ignored): [{ speaker, text }]. Lines without a name continue the previous one.
export function parseDialogue(text) {
  const lines = [];
  for (const raw of text.split('\n')) {
    const m = /^\s*([^:(\n[\]]{1,30}?)\s*(?:\([^)]*\))?\s*:\s*(.*)$/.exec(raw);
    if (m && m[2].trim()) lines.push({ speaker: m[1].trim(), text: m[2].trim() });
    else if (raw.trim() && lines.length) lines[lines.length - 1].text += ` ${raw.trim()}`;
  }
  return lines;
}
export const speakersOf = (text) => [...new Set(parseDialogue(text).map((l) => l.speaker))];
