// A labelled slider for "how much": 0 to 100 percent with the value shown beside it and a clear reset. `onchange(fraction)` gets 0..1.
import { h } from './kit.js';

export function amountSlider({ label = 'Amount', value = 100, min = 0, max = 100, step = 5, unit = '%', disabled = false, onchange }) {
  const out = h('output', { class: 'small', style: 'min-width:3.2em;text-align:right' }, `${value}${unit}`);
  const input = h('input', { type: 'range', min, max, step, value, disabled, 'aria-label': label, oninput: (e) => { out.textContent = `${e.target.value}${unit}`; onchange(Number(e.target.value) / 100); } });
  const reset = h('button', { type: 'button', class: 'link', title: 'Back to full strength', disabled, onclick: () => { input.value = 100; out.textContent = `100${unit}`; onchange(1); } }, 'reset');
  return h('label', { class: 'field' }, label, h('div', { class: 'row', style: 'gap:8px;flex-wrap:nowrap' }, input, out, reset));
}
