// An emoji field: a button showing the current emoji that opens a searchable grid (groups, keyword search), with a box to paste any other
// emoji and a Clear button. emojiField({ label, value, onchange(emoji), disabled, placeholder }) returns a form field to drop into an editor.
import { h } from './kit.js';

// [group, [[emoji, keywords]...]]. Keywords are what the search matches (and the button's accessible name).
const GROUPS = [
  ['Radio and music', [['🎙️', 'microphone mic host voice'], ['📻', 'radio'], ['🎧', 'headphones listen'], ['🎚️', 'mixer slider levels'], ['🎛️', 'knobs control studio'], ['🎵', 'music note'], ['🎶', 'music notes'], ['🎤', 'karaoke microphone sing'], ['🎸', 'guitar rock'], ['🎹', 'piano keyboard keys'], ['🥁', 'drum drums'], ['🎷', 'saxophone jazz'], ['🎺', 'trumpet horn'], ['🎻', 'violin fiddle'], ['🪕', 'banjo country folk'], ['📡', 'antenna satellite broadcast signal'], ['📢', 'loudspeaker announcement'], ['📣', 'megaphone'], ['🔊', 'speaker loud'], ['💿', 'cd disc'], ['📼', 'cassette tape'], ['🕺', 'dance disco'], ['💃', 'dance']]],
  ['Faces and people', [['😀', 'smile happy'], ['😎', 'cool sunglasses'], ['🤠', 'cowboy western'], ['🤖', 'robot ai bot'], ['👽', 'alien ufo'], ['👻', 'ghost spooky'], ['💀', 'skull dead'], ['😈', 'devil mischief'], ['🥸', 'disguise pretend'], ['🧑‍🎤', 'singer artist'], ['🧑‍🚀', 'astronaut space'], ['🧙', 'wizard magic'], ['🧛', 'vampire night'], ['🦸', 'hero'], ['🕵️', 'detective spy mystery'], ['👷', 'worker construction'], ['🧓', 'old elder'], ['🧔', 'beard']]],
  ['Nature and weather', [['🌵', 'cactus desert'], ['🏔️', 'mountain snow peak'], ['⛰️', 'mountain'], ['🌲', 'pine tree forest'], ['🌴', 'palm beach tropical'], ['🌻', 'sunflower'], ['🌈', 'rainbow'], ['☀️', 'sun sunny day'], ['🌙', 'moon night'], ['⭐', 'star'], ['🌟', 'glowing star'], ['⚡', 'lightning bolt electric'], ['🔥', 'fire hot'], ['❄️', 'snow cold winter'], ['🌧️', 'rain'], ['🌪️', 'tornado storm'], ['🌊', 'wave ocean sea'], ['🌋', 'volcano'], ['🌍', 'earth world globe']]],
  ['Animals', [['🦊', 'fox'], ['🐺', 'wolf'], ['🦅', 'eagle bird'], ['🦉', 'owl night'], ['🐻', 'bear'], ['🐴', 'horse'], ['🐍', 'snake'], ['🦎', 'lizard'], ['🦖', 'dinosaur'], ['🐙', 'octopus'], ['🐢', 'turtle slow'], ['🦄', 'unicorn'], ['🐶', 'dog'], ['🐱', 'cat'], ['🦇', 'bat night'], ['🐝', 'bee buzz']]],
  ['Symbols and signs', [['☢️', 'radioactive nuclear radiation rocky flats'], ['☣️', 'biohazard'], ['⚠️', 'warning caution'], ['🚀', 'rocket launch'], ['🛸', 'ufo flying saucer'], ['💥', 'boom explosion'], ['💫', 'dizzy sparkle'], ['✨', 'sparkles'], ['💡', 'idea light bulb'], ['🔮', 'crystal ball'], ['🧿', 'eye charm'], ['☮️', 'peace'], ['❤️', 'heart love'], ['💚', 'green heart'], ['💜', 'purple heart'], ['🏴‍☠️', 'pirate flag'], ['👑', 'crown king'], ['💎', 'gem diamond'], ['🎯', 'target'], ['🎲', 'dice game'], ['🕰️', 'clock time'], ['🗝️', 'key']]],
  ['Places and things', [['🏠', 'home house'], ['🏙️', 'city skyline'], ['🌃', 'night city'], ['🌉', 'bridge night'], ['🚗', 'car drive road'], ['🚌', 'bus'], ['✈️', 'airplane travel'], ['🚂', 'train'], ['🏍️', 'motorcycle'], ['⛺', 'tent camping'], ['🏭', 'factory industry'], ['⚙️', 'gear'], ['🔧', 'wrench tool'], ['📰', 'news newspaper'], ['☕', 'coffee morning'], ['🍺', 'beer bar'], ['🍕', 'pizza'], ['🌮', 'taco'], ['🍔', 'burger'], ['🎪', 'circus'], ['🎬', 'film movie'], ['📞', 'phone call']]],
];

const first = (s) => {                       // the first emoji (grapheme) of whatever was typed or pasted
  const t = String(s || '').trim();
  if (!t) return '';
  try { return [...new Intl.Segmenter(undefined, { granularity: 'grapheme' }).segment(t)][0].segment; } catch { return [...t][0] || ''; }
};

export function emojiField({ label = 'Emoji', value = '', onchange = () => {}, disabled = false, placeholder = '🎙️' } = {}) {
  let current = value || '';
  const face = h('span', { class: 'emoji-face', 'aria-hidden': 'true' }, current || placeholder);
  const button = h('button', { type: 'button', class: 'emoji-btn', disabled, 'aria-haspopup': 'dialog', 'aria-expanded': 'false', title: 'Choose an emoji' }, face, h('span', { class: 'caret', 'aria-hidden': 'true' }, '▾'));
  const search = h('input', { type: 'search', placeholder: 'Search (radio, moon, alien...)', 'aria-label': 'Search emoji' });
  const custom = h('input', { placeholder: 'or paste any emoji', 'aria-label': 'Paste any emoji', maxlength: 16 });
  const grid = h('div', { class: 'emoji-grid' });
  const pop = h('div', { class: 'emoji-pop', role: 'dialog', 'aria-label': 'Choose an emoji', hidden: true },
    search, grid,
    h('div', { class: 'row' }, h('span', { class: 'grow' }, custom), h('button', { type: 'button', class: 'chip-btn', onclick: () => pick('') }, 'Clear')));
  const root = h('div', { class: 'field emoji-field' }, label, h('span', { class: 'emoji-wrap' }, button, pop));

  function set(emoji) { current = emoji; face.textContent = current || placeholder; }
  function pick(emoji) { set(emoji); onchange(emoji); close(true); }
  function paint() {
    const q = search.value.trim().toLowerCase();
    grid.replaceChildren();
    for (const [name, items] of GROUPS) {
      const shown = items.filter(([e, k]) => !q || k.includes(q) || name.toLowerCase().includes(q) || e === q);
      if (!shown.length) continue;
      grid.append(h('div', { class: 'emoji-group' }, name), h('div', { class: 'emoji-row' }, shown.map(([e, k]) => h('button', { type: 'button', class: `emoji-cell${e === current ? ' on' : ''}`, 'aria-label': k.split(' ')[0] + (e === current ? ' (selected)' : ''), title: k, onclick: () => pick(e) }, e))));
    }
    if (!grid.children.length) grid.append(h('p', { class: 'small muted' }, 'No match. Paste any emoji below.'));
  }
  function open() {
    if (disabled) return;
    pop.hidden = false; button.setAttribute('aria-expanded', 'true'); search.value = ''; paint(); search.focus();
    setTimeout(() => document.addEventListener('click', outside), 0);
  }
  function close(focus) {
    pop.hidden = true; button.setAttribute('aria-expanded', 'false'); document.removeEventListener('click', outside);
    if (focus) button.focus();
  }
  const outside = (e) => { if (!root.contains(e.target)) close(); };
  button.addEventListener('click', () => (pop.hidden ? open() : close()));
  search.addEventListener('input', paint);
  custom.addEventListener('input', () => { const e = first(custom.value); if (e) { custom.value = ''; pick(e); } });
  pop.addEventListener('keydown', (e) => { if (e.key === 'Escape') { e.stopPropagation(); close(true); } });
  root.set = set;
  return root;
}
