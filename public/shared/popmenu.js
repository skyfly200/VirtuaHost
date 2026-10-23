// A small popover menu behind one button: the way to keep a row of actions short. One menu is open at a time; a click elsewhere or Escape closes
// it; arrow keys move between items. items: [{ label, onclick, danger?, hidden? }] (or { label, heading: true } for a non-clickable title) (or a function returning that list, read each time it opens).
import { h } from './kit.js';

let open = null;
let listening = false;
// Registered when the first menu is made, not when the file loads, so the module can be imported where there is no document (tests).
function listen() {
  if (listening) return;
  listening = true;
  document.addEventListener('click', (e) => { if (open && !open.el.contains(e.target)) open.close(); });
  document.addEventListener('keydown', (e) => { if (e.key === 'Escape' && open) { const m = open; m.close(); m.button.focus(); } });
}

export function popMenu({ label = 'More actions', icon = '⋯', items, className = '' }) {
  listen();
  const button = h('button', { type: 'button', class: `icon-btn ${className}`.trim(), 'aria-haspopup': 'menu', 'aria-expanded': 'false', 'aria-label': label, title: label }, icon);
  const list = h('div', { class: 'popmenu', role: 'menu', 'aria-label': label, hidden: true });
  const el = h('span', { class: 'popwrap' }, button, list);
  const menu = {
    el, button,
    close() { list.hidden = true; button.setAttribute('aria-expanded', 'false'); if (open === menu) open = null; },
    open() {
      if (open && open !== menu) open.close();
      const rows = (typeof items === 'function' ? items() : items).filter((i) => !i.hidden);
      list.replaceChildren(...rows.map((i) => i.heading ? h('div', { class: 'pop-heading', role: 'presentation' }, i.label) : h('button', { type: 'button', role: 'menuitem', class: i.danger ? 'danger' : '', onclick: () => { menu.close(); i.onclick(); } }, i.label)));
      list.hidden = false; button.setAttribute('aria-expanded', 'true'); open = menu;
    },
  };
  button.addEventListener('click', () => (list.hidden ? menu.open() : menu.close()));
  button.addEventListener('keydown', (e) => { if (e.key === 'ArrowDown') { e.preventDefault(); menu.open(); const first = list.querySelector('button'); if (first) first.focus(); } });
  list.addEventListener('keydown', (e) => {
    const rows = [...list.querySelectorAll('button')]; const at = rows.indexOf(document.activeElement);
    if (e.key === 'ArrowDown') { e.preventDefault(); rows[(at + 1) % rows.length].focus(); } else if (e.key === 'ArrowUp') { e.preventDefault(); rows[(at - 1 + rows.length) % rows.length].focus(); }
  });
  return el;
}
