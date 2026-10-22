// The VirtuaHost mark and wordmark. The mark is one of the concepts in public/brand/ (see brand/index.html); change MARK to swap it.
// It is a fixed string, drawn with the page's own colours (the ink follows the text colour, the accent follows the theme).
import { h } from './kit.js';

const MARK = '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 64 64" fill="none" aria-hidden="true">'
  + '<rect x="6" y="10" width="8" height="44" rx="4" fill="currentColor"/><rect x="17" y="16" width="8" height="32" rx="4" fill="currentColor"/>'
  + '<rect x="28" y="22" width="8" height="20" rx="4" fill="var(--accent)"/><rect x="38" y="16" width="8" height="32" rx="4" fill="currentColor"/>'
  + '<rect x="50" y="10" width="8" height="44" rx="4" fill="currentColor"/></svg>';

export function logoMark(size = 28) {
  const el = h('span', { class: 'logo-mark', style: `display:inline-flex;width:${size}px;height:${size}px` });
  el.innerHTML = MARK;                                                        // static markup above, never user text
  el.firstChild.setAttribute('width', size); el.firstChild.setAttribute('height', size);
  return el;
}
export const brand = (size = 28) => h('span', { class: 'brand-lockup', style: 'display:inline-flex;align-items:center;gap:8px' }, logoMark(size), h('span', { class: 'brand-word' }, 'Virtua', h('span', { style: 'color:var(--accent)' }, 'Host')));
