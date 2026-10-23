// "Background, intro and outro": three pickers over the sound library (uploads and cloud folders), each with an Upload button.
//   audioSlots({ api, value: { bed, bedVol, intro, outro }, onchange(audio) })   the pickers
//   readAudioTags(text) / writeAudioTags(text, audio, { conversation })        the same choices as [music:], [intro:] and [outro:] tags in a script
// The Studio keeps the choices in the script's own text as tags (so they are saved with it); schedules keep them as an object.
import { h, clear } from './kit.js';
import { uploadButton } from './uploader.js';

const TAG = { bed: /\[\s*music\s*:\s*([a-z0-9_-]+)([^\]]*)\]/i, intro: /\[\s*intro\s*:\s*([a-z0-9_-]+)[^\]]*\]/i, outro: /\[\s*outro\s*:\s*([a-z0-9_-]+)[^\]]*\]/i };

export function readAudioTags(text) {
  const out = {};
  const bed = TAG.bed.exec(text || ''); if (bed) { out.bed = bed[1].toLowerCase(); const v = /vol\s*=\s*([0-9.]+)/i.exec(bed[2]); out.bedVol = v ? Number(v[1]) : 0.25; }
  const intro = TAG.intro.exec(text || ''); if (intro) out.intro = intro[1].toLowerCase();
  const outro = TAG.outro.exec(text || ''); if (outro) out.outro = outro[1].toLowerCase();
  return out;
}

// Removes the old music, intro and outro tags, then puts the new ones at the start (intro, bed) and end (outro). In a conversation the tags go on the
// first and last spoken line, after the "Name:" label.
export function writeAudioTags(text, audio = {}, { conversation = false } = {}) {
  const clean = String(text || '').replace(/\[\s*(?:music|intro|outro)\s*:[^\]]*\]\s?/gi, '').replace(/[ \t]+\n/g, '\n').trim();
  const head = [audio.intro ? `[intro:${audio.intro}]` : '', audio.bed ? `[music:${audio.bed}${audio.bedVol !== undefined ? ` vol=${audio.bedVol}` : ' vol=0.2'}]` : ''].filter(Boolean).join(' ');
  const tail = audio.outro ? `[outro:${audio.outro}]` : '';
  if (!head && !tail) return clean;
  if (!conversation) return [head, clean, tail].filter(Boolean).join(' ');
  const lines = clean.split('\n');
  const spoken = lines.map((l, i) => (l.trim() ? i : -1)).filter((i) => i >= 0);
  if (!spoken.length) return clean;
  const label = /^(\s*[^:\n]{1,40}:\s*)(.*)$/;
  const firstAt = spoken[0]; const lastAt = spoken[spoken.length - 1];
  if (head) lines[firstAt] = label.test(lines[firstAt]) ? lines[firstAt].replace(label, (_m, a, b) => `${a}${head} ${b}`) : `${head} ${lines[firstAt]}`;
  if (tail) lines[lastAt] = `${lines[lastAt]} ${tail}`;
  return lines.join('\n');
}

export function audioSlots({ api, value = {}, onchange = () => {}, note = '' }) {
  const root = h('div', { class: 'stack audio-slots' });
  let items = [];
  const audio = { ...value };
  const emit = () => onchange({ ...audio });
  const names = (kind) => items.filter((i) => i.kind === kind);

  const picker = (kind, label, key) => {
    const select = h('select', { 'aria-label': label, onchange: (e) => { if (e.target.value) audio[key] = e.target.value; else delete audio[key]; if (key === 'bed' && audio.bed && audio.bedVol === undefined) audio.bedVol = 0.2; emit(); } },
      h('option', { value: '' }, 'None'),
      names(kind).map((i) => h('option', { value: i.name, selected: i.name === audio[key] }, `${i.name}${i.source === 'uploads' ? '' : ` (${i.source})`}`)),
      audio[key] && !names(kind).some((i) => i.name === audio[key]) ? h('option', { value: audio[key], selected: true }, `${audio[key]} (not in the library)`) : null);
    const extras = key === 'bed' ? h('label', { class: 'row small', title: 'How loud the background is under the voice' }, 'Volume', h('input', { type: 'range', min: 0, max: 1, step: 0.05, value: audio.bedVol ?? 0.2, disabled: !audio.bed, oninput: (e) => { audio.bedVol = Number(e.target.value); }, onchange: emit })) : null;
    return h('div', { class: 'row', style: 'flex-wrap:wrap;gap:8px;align-items:end' },
      h('label', { class: 'field grow', style: 'min-width:12em' }, label, select),
      extras,
      uploadButton(api, { kind: kind === 'music' ? 'music' : kind, label: 'Upload a file', className: 'link', onUploaded: async (saved) => { await load(); audio[key] = saved.name; if (key === 'bed' && audio.bedVol === undefined) audio.bedVol = 0.2; emit(); } }));
  };

  async function load() {
    try { items = (await api.get('/library')).items || []; } catch { items = []; }
    paint();
  }
  function paint() {
    clear(root,
      note ? h('p', { class: 'small muted' }, note) : null,
      picker('music', 'Background music (plays under the voice)', 'bed'),
      picker('intro', 'Intro (plays before)', 'intro'),
      picker('outro', 'Outro (plays after)', 'outro'),
      h('p', { class: 'small muted' }, 'Uploads are converted in your browser to mono WAV and shared with everyone on the station. Manage them in the Library.'));
  }
  paint(); load();
  return { el: root, reload: load, set(v) { Object.keys(audio).forEach((k) => delete audio[k]); Object.assign(audio, v || {}); paint(); } };
}
