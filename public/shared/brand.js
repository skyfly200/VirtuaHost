// The VirtuaHost mark and wordmark. The mark is one of the concepts in public/brand/ (see brand/index.html); change MARK to swap it.
// It is a fixed string, drawn with the page's own colours (the ink follows the text colour, the accent follows the theme).
import { h } from './kit.js';

const MARK = '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 64 64" fill="none" aria-hidden="true"><rect x="22" y="6" width="20" height="32" rx="10" stroke="var(--accent)" stroke-width="4"/><rect x="24.75" y="18" width="3.5" height="8" rx="1.75" fill="var(--accent)"/><rect x="30.25" y="12" width="3.5" height="20" rx="1.75" fill="var(--accent)"/><rect x="35.75" y="18" width="3.5" height="8" rx="1.75" fill="var(--accent)"/><path d="M14 30a18 18 0 0 0 36 0M32 48v7M24 56h16" stroke="currentColor" stroke-width="4" stroke-linecap="round"/></svg>';

export function logoMark(size = 28) {
  const el = h('span', { class: 'logo-mark', style: `display:inline-flex;width:${size}px;height:${size}px` });
  el.innerHTML = MARK;                                                        // static markup above, never user text
  el.firstChild.setAttribute('width', size); el.firstChild.setAttribute('height', size);
  return el;
}
export const brand = (size = 28) => h('span', { class: 'brand-lockup', style: 'display:inline-flex;align-items:center;gap:8px' }, logoMark(size), h('span', { class: 'brand-word' }, 'Virtua', h('span', { style: 'color:var(--accent)' }, 'Host')));
