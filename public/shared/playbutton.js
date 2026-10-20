// A play/pause button for hearing a sample: ▶ to play, ⏸ while playing (click to stop), … while the audio is being made.
// The audio is made on the first press (`load` returns a URL) and kept, so pressing again replays it at once. Only one sound plays
// at a time: starting one stops the other. `play()` resolves when it ends or is stopped, so a list can be played in a row.
import { h, toast } from './kit.js';

let active = null;

export function createPlayer({ load, label = 'Play sample' }) {
  let url = '';
  let audio = null;
  let finish = null;
  let state = 'idle';
  const button = h('button', { type: 'button', class: 'play', 'aria-label': label, title: label }, '▶');

  function set(next) {
    state = next;
    button.textContent = next === 'loading' ? '…' : next === 'playing' ? '⏸' : '▶';
    button.disabled = next === 'loading';
    button.classList.toggle('on', next === 'playing');
    button.setAttribute('aria-pressed', String(next === 'playing'));
    button.title = next === 'playing' ? 'Stop' : label;
  }
  function stop() {
    if (audio) { audio.pause(); audio.currentTime = 0; }
    if (state !== 'loading') set('idle');
    const done = finish; finish = null;
    if (active === player) active = null;
    if (done) done();
  }
  async function play() {
    if (state === 'playing') { stop(); return; }
    if (active && active !== player) active.stop();
    set('loading');
    try {
      if (!url) url = await load();
    } catch (err) { set('idle'); toast(err.message, 'error'); return; }
    audio = new Audio(url);
    active = player;
    await new Promise((resolve) => {
      finish = resolve;
      audio.onended = () => { set('idle'); finish = null; if (active === player) active = null; resolve(); };
      audio.onerror = () => { set('idle'); finish = null; resolve(); };
      audio.play().then(() => set('playing')).catch(() => { set('idle'); finish = null; resolve(); });
    });
  }
  // The text or settings changed: the next press makes a new sample.
  function invalidate() {
    stop();
    if (url) URL.revokeObjectURL(url);
    url = '';
  }
  button.onclick = () => { play(); };
  const player = { button, play, stop, invalidate, get ready() { return Boolean(url); } };
  return player;
}
