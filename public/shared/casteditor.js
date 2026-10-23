// The speakers of a script: a row per speaker with who they are (Host, DJ or Guest: that becomes the label in front of their lines, "Host: line",
// numbered when it repeats: "Guest 2"), an optional persona and an optional voice. A conversation needs two speakers, up to `max`; a single-voice
// script has exactly one row. A name from an older script that is not one of the three stays selectable, so nothing is lost.
import { h } from './kit.js';

const NAME_RE = /^[A-Za-z0-9][A-Za-z0-9 _.'-]{0,23}$/;
const NAME_HELP = "Use 1 to 24 letters, numbers, spaces or _ . ' -, starting with a letter or number.";

const ROLES = ['Host', 'DJ', 'Guest'];

export function castEditor({ personas = [], cast = [], kind = 'conversation', max = 4, onchange = () => {} } = {}) {
  const personaIds = new Set(personas.map((p) => p.id));
  const limit = Math.max(max, 2);
  let mode = kind === 'single' ? 'single' : 'conversation';
  let rows = [];
  let refs = []; // per row: the element that shows its message

  const el = h('div', { class: 'cast-editor' });
  const list = h('div', { class: 'cast-rows' });
  const addArea = h('div', { class: 'cast-add' });
  const countNote = h('div', { class: 'small bad', hidden: true });
  el.append(list, addArea, countNote);

  // A new speaker is the first of Host, DJ, Guest not yet in the cast (then Guest 2, Guest 3...).
  const blank = (from = rows) => ({ name: uniqueName(ROLES.find((r) => !from.some((x) => x.name.trim().toLowerCase() === r.toLowerCase())) || 'Guest', -1, from), personaId: '', voice: '', role: '' });
  // A persona id that no longer exists is dropped here, so get() never returns a dangling persona.
  const fromMember = (m = {}) => ({
    name: String(m.name ?? ''), personaId: personaIds.has(m.personaId) ? m.personaId : '',
    voice: String(m.voice ?? ''), role: String(m.role ?? ''),
  });
  const named = () => rows.filter((r) => r.name.trim());

  // A single voice keeps one speaker (the first named one); a conversation keeps 2 to `limit`, padding with blank rows.
  function normalise(members) {
    const all = members.map(fromMember);
    if (mode === 'single') return [all.find((r) => r.name.trim()) || { ...(all[0] || blank([])), name: all[0] && all[0].name.trim() ? all[0].name : 'Host' }];
    const next = all.slice(0, limit);
    next.forEach((r) => { if (!r.name.trim()) r.name = uniqueName('Guest', -1, next.filter((x) => x !== r)); });
    while (next.length < 2) next.push(blank(next));
    return next;
  }

  function nameProblem(i) {
    const name = rows[i].name.trim();
    if (!name) return '';
    if (name.includes(':')) return 'A name cannot contain a colon.';
    if (!NAME_RE.test(name)) return NAME_HELP;
    const clash = rows.some((r, j) => j !== i && r.name.trim().toLowerCase() === name.toLowerCase());
    return clash ? `Another speaker is already called "${name}".` : '';
  }

  // A suggested name gets " 2", " 3"... when its first word is already used (ignoring case), keeping within 24 characters.
  function uniqueName(base, self, from = rows) {
    const taken = new Set(from.filter((_, j) => j !== self).map((r) => r.name.trim().toLowerCase()));
    let candidate = base;
    for (let n = 2; taken.has(candidate.toLowerCase()); n++) {
      const suffix = ` ${n}`;
      candidate = base.slice(0, 24 - suffix.length) + suffix;
    }
    return candidate;
  }

  function paint() {
    refs.forEach((ref, i) => { const msg = nameProblem(i); ref.err.textContent = msg; ref.err.hidden = !msg; });
    const short = mode === 'conversation' && named().length < 2;
    countNote.textContent = short ? 'A conversation needs at least 2 named speakers.' : '';
    countNote.hidden = !short;
  }

  function emit() { paint(); onchange(get()); }

  function draw(focus) {
    refs = [];
    list.replaceChildren(...rows.map((row, i) => {
      // Who they are. The current name is always an option (a numbered "Guest 2", or a name from an older script); picking Host, DJ or Guest numbers it if taken.
      const roleSel = h('select', {
        'aria-label': 'Speaker',
        onchange: (e) => { row.name = uniqueName(e.target.value, i); draw(); emit(); },   // redrawn so a numbered name ("Host 2") is an option
      }, ...(ROLES.includes(row.name) ? [] : [h('option', { value: row.name }, row.name)]), ...ROLES.map((r) => h('option', { value: r }, r)));
      roleSel.value = row.name;
      const personaSel = h('select', {
        'aria-label': 'Persona',
        onchange: (e) => { row.personaId = e.target.value; emit(); },
      }, h('option', { value: '' }, 'No persona'), ...personas.map((p) => h('option', { value: p.id }, `${p.emoji || ''} ${p.name}`)));
      personaSel.value = row.personaId;
      const voiceIn = h('input', { type: 'text', value: row.voice, 'aria-label': 'Voice (optional)', placeholder: 'voice name (optional)', autocomplete: 'off', oninput: (e) => { row.voice = e.target.value; emit(); } });
      const err = h('div', { class: 'small bad', hidden: true });
      refs.push({ err });
      const remove = mode === 'conversation' && i >= 2
        ? h('button', { type: 'button', class: 'secondary', 'aria-label': `Remove speaker ${i + 1}`, onclick: () => { rows.splice(i, 1); draw(); emit(); } }, 'Remove')
        : null;
      // The grid is set inline so the fields stack on a phone even where the stylesheet is not loaded.
      return h('div', { class: 'cast-row' },
        h('div', { class: 'cast-fields', style: 'display: grid; gap: 8px; grid-template-columns: repeat(auto-fit, minmax(150px, 1fr))' }, roleSel, personaSel, voiceIn),
        h('div', { class: 'cast-row-foot' }, err, remove));
    }));

    addArea.replaceChildren();
    if (mode === 'conversation') {
      if (rows.length < limit) addArea.append(h('button', { type: 'button', class: 'secondary', onclick: () => { rows.push(blank()); draw('last'); emit(); } }, 'Add a speaker'));
      else addArea.append(h('span', { class: 'small muted' }, `At most ${limit} speakers`));
    }
    if (focus === 'last') list.lastElementChild?.querySelector('select')?.focus();
    paint();
  }

  // Named speakers only, trimmed; a row with no name is not a speaker yet.
  function get() {
    return named().map((r) => {
      const m = { name: r.name.trim() };
      if (r.personaId) m.personaId = r.personaId;
      if (r.voice.trim()) m.voice = r.voice.trim();
      if (r.role.trim()) m.role = r.role.trim();
      return m;
    });
  }

  // Programmatic changes do not call onchange: the caller already knows the cast it set, and calling back would loop.
  function set(newCast = []) { rows = normalise(newCast); draw(); }
  function setKind(k) { mode = k === 'single' ? 'single' : 'conversation'; rows = normalise(rows); draw(); }

  function problems() {
    const out = [];
    rows.forEach((_, i) => { const msg = nameProblem(i); if (msg) out.push(`Speaker ${i + 1}: ${msg}`); });
    if (mode === 'conversation' && named().length < 2) out.push('A conversation needs at least 2 named speakers.');
    return out;
  }

  rows = normalise(cast);
  draw();
  return { el, get, set, setKind, problems };
}
