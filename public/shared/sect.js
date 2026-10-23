// Turns a long form into collapsible sections: every <h3> and what follows it up to the next <h3> becomes a <details>, so a page can be taken in
// at a glance and opened where needed. Existing elements are moved, not copied, so their handlers keep working. `open`: indexes opened at first.
import { h } from './kit.js';

export function sectionize(card, { open = [0] } = {}) {
  const kids = [...card.children];
  const first = kids.findIndex((k) => k.tagName === 'H3');
  if (first < 0) return card;
  const head = kids.slice(0, first);
  const sections = [];
  for (const k of kids.slice(first)) {
    if (k.tagName === 'H3') sections.push({ title: k.textContent, body: [] });
    else sections[sections.length - 1].body.push(k);
  }
  card.replaceChildren(...head, ...sections.map((s, i) => h('details', { class: 'sect', open: open.includes(i) }, h('summary', {}, s.title), h('div', { class: 'sect-body stack' }, ...s.body))));
  return card;
}
