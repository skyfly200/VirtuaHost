// Library tab: your saved clips, and the sound effects, music beds, intros and outros available to scripts (uploaded here or read from cloud folders).
// Clips: everything saved on the site (clips.js). Sounds: Built-in effects are synthesised in the browser;
// the rest come from the connected cloud storage (OwnCloud / Google Drive, see docs/LIBRARY.md). Click a tag to copy it.
import { h, clear, toast } from '../shared/kit.js';
import { effectNames, EFFECTS, toWav } from '../generate/mixer.js';
import { mountClips } from './clips.js';
import { uploadButton, KIND_LABELS } from '../shared/uploader.js';

const kb = (n) => (n === undefined ? '' : n > 1e6 ? `${(n / 1e6).toFixed(1)} MB` : `${Math.max(1, Math.round(n / 1024))} KB`);

// The Library has five parts: saved clips, sound effects, music, intros and outros.
export async function mountLibrary(root, api) {
  let part = 'clips';
  try { part = sessionStorage.getItem('libraryPart') || part; } catch { /* storage blocked */ }
  const body = h('div');
  const PARTS = [['clips', 'Clips'], ['sfx', 'Sound effects'], ['music', 'Music'], ['intro', 'Intros'], ['outro', 'Outros']];
  const buttons = PARTS.map(([id, label]) => h('button', { type: 'button', class: 'seg', onclick: () => show(id) }, label));
  const show = async (id) => {
    part = id;
    try { sessionStorage.setItem('libraryPart', id); } catch { /* storage blocked */ }
    buttons.forEach((b, i) => b.classList.toggle('on', PARTS[i][0] === id));
    if (id === 'clips') await mountClips(body, api); else await mountSounds(body, api, id);
  };
  clear(root, h('div', { class: 'stack' }, h('div', { class: 'row' }, buttons), body));
  await show(part);
}

// The built-in effects are made in the browser, so they play without any file: one at a time, a new one cuts off the last.
let preview = null;
function playBuiltin(name) {
  if (preview) { preview.pause(); URL.revokeObjectURL(preview.src); }
  preview = new Audio(URL.createObjectURL(new Blob([toWav(EFFECTS[name]())], { type: 'audio/wav' })));
  return preview.play();
}

async function mountSounds(root, api, only) {
  clear(root, h('p', { class: 'muted' }, 'Loading...'));
  let data;
  try {
    data = await api.get('/library');
  } catch (err) {
    clear(root, h('p', { class: 'bad' }, `Could not load the library: ${err.message}`));
    return;
  }

  let mine = [];
  try { mine = (await api.get('/uploads')).uploads; } catch { /* the list still shows; only rename and delete need this */ }
  const uploadOf = (kind, name) => mine.find((u) => u.kind === kind && u.name === name);
  const refresh = () => mountSounds(root, api, only);

  const copy = async (text) => {
    try { await navigator.clipboard.writeText(text); toast(`Copied ${text}`, 'info'); } catch { toast(text, 'info'); }
  };

  const row = (kind, item) => {
    const tag = kind === 'music' ? `[music:${item.name} vol=0.2]` : `[${kind}:${item.name}]`;
    const up = item.source === 'uploads' ? uploadOf(kind, item.name) : null;
    const slot = h('span');
    const play = h('button', { type: 'button', onclick: async () => {
      play.disabled = true;
      try {
        const blob = await api.get(`/library/${encodeURIComponent(item.source)}/${kind}/${encodeURIComponent(item.name)}`, { blob: true });
        const audio = h('audio', { controls: true, src: URL.createObjectURL(blob) });
        clear(slot, audio); audio.play().catch(() => {});
      } catch (err) { toast(err.message, 'error'); } finally { play.disabled = false; }
    } }, 'Play');
    return h('div', { class: 'clip' },
      h('div', { class: 'row small muted' }, h('span', { class: 'chip' }, item.source === 'owncloud' ? 'OwnCloud' : item.source === 'uploads' ? 'Uploaded' : 'Google Drive'), h('span', {}, item.file), h('span', {}, kb(item.size))),
      h('div', { class: 'row' }, h('button', { type: 'button', class: 'chip-btn', title: 'Copy the tag', onclick: () => copy(tag) }, tag), play, slot,
        up && up.canEdit ? h('button', { type: 'button', class: 'link', onclick: async () => {
          const name = prompt('New name (letters, numbers and dashes):', item.name);
          if (!name || name === item.name) return;
          try { await api.request('PATCH', `/uploads/${up.id}`, { body: { name } }); await refresh(); } catch (err) { toast(err.message, 'error'); }
        } }, 'Rename') : null,
        up && up.canEdit ? h('button', { type: 'button', class: 'link danger', onclick: async () => {
          if (!confirm(`Delete "${item.name}"? Scripts and schedules that use ${tag} will no longer find it.`)) return;
          try { await api.del(`/uploads/${up.id}`); toast('Deleted.', 'info'); await refresh(); } catch (err) { toast(err.message, 'error'); }
        } }, 'Delete') : null));
  };

  const section = (title, kind, blurb) => {
    const items = data.items.filter((i) => i.kind === kind);
    const configured = true;                                   // uploads are always available
    return h('section', { class: 'card' }, h('h2', {}, title), h('p', { class: 'muted small' }, blurb),
      configured ? (items.length ? items.map((i) => row(kind, i)) : h('p', { class: 'empty' }, 'Nothing here yet. Upload a file above' + (data.sources.some((s) => s.id !== 'uploads' && s.kinds.includes(kind)) ? ', or add files to the connected folder.' : '.')))
        : h('p', { class: 'empty' }, 'No folder is connected for this yet. See docs/LIBRARY.md.'));
  };

  const uploadCard = () => h('section', { class: 'card' }, h('h2', {}, `Upload ${({ sfx: 'a sound effect', music: 'background music', intro: 'an intro', outro: 'an outro' })[only]}`),
    h('p', { class: 'muted small' }, 'Any audio file your browser can play (mp3, wav, m4a, ogg). It is converted to mono WAV in your browser, long files are shortened to fit (' + ({ sfx: '30', music: '80', intro: '60', outro: '60' })[only] + ' seconds), and everyone on the station can use it. You can delete your own uploads here.'),
    uploadButton(api, { kind: only, label: `Upload ${KIND_LABELS[only].toLowerCase()}`, className: 'primary', onUploaded: refresh }));

  clear(root, h('div', { class: 'stack' },
    data.warning && only !== 'intro' && only !== 'outro' ? h('p', { class: 'note warn' }, data.warning) : null,
    data.errors.length ? h('p', { class: 'note warn' }, data.errors.join(' ')) : null,
    uploadCard(),
    only === 'sfx' ? h('section', { class: 'card' }, h('h2', {}, 'Built-in sound effects'),
      h('p', { class: 'muted small' }, 'Always available, no setup. Press \u25B6 to hear one; click the name to copy its tag, for example [sfx:ding] or [sfx:whoosh over].'),
      h('div', { class: 'row', style: 'gap:8px;flex-wrap:wrap' }, effectNames().map((n) => h('span', { class: 'row', style: 'gap:2px;flex-wrap:nowrap' },
        h('button', { type: 'button', class: 'icon-btn', style: 'min-width:32px;height:30px;padding:0 8px;font-size:12px', title: `Play ${n}`, 'aria-label': `Play ${n}`, onclick: () => playBuiltin(n).catch((err) => toast(err.message, 'error')) }, '\u25B6'),
        h('button', { type: 'button', class: 'chip-btn', title: 'Copy the tag', onclick: () => copy(`[sfx:${n}]`) }, n))))) : null,
    only === 'sfx' ? section('Sound effects', 'sfx', 'Short sounds from your cloud folder. A file called "Big Ding.mp3" becomes [sfx:big-ding], and overrides nothing: built-ins win a name clash.') : null,
    only === 'music' ? section('Music', 'music', 'Beds to play under a clip: [music:name vol=0.2] fades the music in before the first word and out after the last. Files up to about 5 MB.') : null,
    only === 'intro' ? section('Intros', 'intro', 'A clip played before the voice: [intro:name]. Choose one in the Studio under Background, intro and outro.') : null,
    only === 'outro' ? section('Outros', 'outro', 'A clip played after the voice: [outro:name].') : null));
}
