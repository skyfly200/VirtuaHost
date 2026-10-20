// Library tab: the sound effects and music beds available to scripts. Built-in effects are synthesised in the browser;
// the rest come from the connected cloud storage (OwnCloud / Google Drive, see docs/LIBRARY.md). Click a tag to copy it.
import { h, clear, toast } from '../shared/kit.js';
import { effectNames } from '../generate/mixer.js';

const kb = (n) => (n === undefined ? '' : n > 1e6 ? `${(n / 1e6).toFixed(1)} MB` : `${Math.max(1, Math.round(n / 1024))} KB`);

export async function mountLibrary(root, api) {
  clear(root, h('p', { class: 'muted' }, 'Loading...'));
  let data;
  try {
    data = await api.get('/library');
  } catch (err) {
    clear(root, h('p', { class: 'bad' }, `Could not load the library: ${err.message}`));
    return;
  }

  const copy = async (text) => {
    try { await navigator.clipboard.writeText(text); toast(`Copied ${text}`, 'info'); } catch { toast(text, 'info'); }
  };

  const row = (kind, item) => {
    const tag = kind === 'music' ? `[music:${item.name} vol=0.2]` : `[sfx:${item.name}]`;
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
      h('div', { class: 'row small muted' }, h('span', { class: 'chip' }, item.source === 'owncloud' ? 'OwnCloud' : 'Google Drive'), h('span', {}, item.file), h('span', {}, kb(item.size))),
      h('div', { class: 'row' }, h('button', { type: 'button', class: 'chip-btn', title: 'Copy the tag', onclick: () => copy(tag) }, tag), play, slot));
  };

  const section = (title, kind, blurb) => {
    const items = data.items.filter((i) => i.kind === kind);
    const configured = data.sources.some((s) => s.kinds.includes(kind));
    return h('section', { class: 'card' }, h('h2', {}, title), h('p', { class: 'muted small' }, blurb),
      configured ? (items.length ? items.map((i) => row(kind, i)) : h('p', { class: 'empty' }, 'The folder has no audio files yet (mp3, wav, ogg, m4a or flac).'))
        : h('p', { class: 'empty' }, 'No folder is connected for this yet. See docs/LIBRARY.md.'));
  };

  clear(root, h('div', { class: 'stack' },
    data.warning ? h('p', { class: 'note warn' }, data.warning) : null,
    data.errors.length ? h('p', { class: 'note warn' }, data.errors.join(' ')) : null,
    h('section', { class: 'card' }, h('h2', {}, 'Built-in sound effects'),
      h('p', { class: 'muted small' }, 'Always available, no setup. Use them in the Generate tab, for example [sfx:ding] or [sfx:whoosh over].'),
      h('div', { class: 'row', style: 'gap:6px' }, effectNames().map((n) => h('button', { type: 'button', class: 'chip-btn', onclick: () => copy(`[sfx:${n}]`) }, n)))),
    section('Sound effects', 'sfx', 'Short sounds from your cloud folder. A file called "Big Ding.mp3" becomes [sfx:big-ding], and overrides nothing: built-ins win a name clash.'),
    section('Music', 'music', 'Beds to play under a clip: [music:name vol=0.2] fades the music in before the first word and out after the last. Files up to about 5 MB.')));
}
