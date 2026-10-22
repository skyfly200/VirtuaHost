// The speakers of a script: a row per speaker with a name, an optional persona (which can suggest the name), a voice and a
// role. A conversation needs two named speakers, up to `max`; a single-voice script has exactly one row. Names are checked as
// they are typed because each one becomes the label in front of its lines ("Name: line"), so a colon or a clash would
// misplace the speech. Messages follow the typing without redrawing the rows, so the field being typed in keeps its focus.
import { h } from './kit.js';

const NAME_RE = /^[A-Za-z0-9][A-Za-z0-9 _.'-]{0,23}$/;
const NAME_HELP = "Use 1 to 24 letters, numbers, spaces or _ . ' -, starting with a letter or number.";

// A persona's first word, reduced to characters a speaker name may use ("Rocky Flats" -> "Rocky").
const suggestName = (persona) => (persona.name || '').trim().split(/\s+/)[0].replace(/[^A-Za-z0-9 _.'-]/g, '').slice(0, 24);

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

  const blank = () => ({ name: '', personaId: '', voice: '', role: '' });
  // A persona id that no longer exists is dropped here, so get() never returns a dangling persona.
  const fromMember = (m = {}) => ({
    name: String(m.name ?? ''), personaId: personaIds.has(m.personaId) ? m.personaId : '',
    voice: String(m.voice ?? ''), role: String(m.role ?? ''),
  });
  const named = () => rows.filter((r) => r.name.trim());

  // A single voice keeps one speaker (the first named one); a conversation keeps 2 to `limit`, padding with blank rows.
  function normalise(members) {
    const all = members.map(fromMember);
    if (mode === 'single') return [all.find((r) => r.name.trim()) || all[0] || blank()];
    const next = all.slice(0, limit);
    while (next.length < 2) next.push(blank());
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
  function uniqueName(base, self) {
    const taken = new Set(rows.filter((_, j) => j !== self).map((r) => r.name.trim().toLowerCase()));
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
      const nameIn = h('input', {
        type: 'text', value: row.name, 'aria-label': 'Speaker name', placeholder: 'Name', autocomplete: 'off',
        oninput: (e) => { row.name = e.target.value; emit(); },
      });
      const personaSel = h('select', {
        'aria-label': 'Persona',
        onchange: (e) => {
          row.personaId = e.target.value;
          const p = personas.find((x) => x.id === row.personaId);
          const base = p && !row.name.trim() ? suggestName(p) : '';
          if (base) { row.name = uniqueName(base, i); nameIn.value = row.name; }
          emit();
        },
      }, h('option', { value: '' }, 'No persona'), ...personas.map((p) => h('option', { value: p.id }, `${p.emoji || ''} ${p.name}`)));
      personaSel.value = row.personaId;
      const voiceIn = h('input', { type: 'text', value: row.voice, 'aria-label': 'Voice (optional)', placeholder: 'voice name (optional)', autocomplete: 'off', oninput: (e) => { row.voice = e.target.value; emit(); } });
      const roleIn = h('input', { type: 'text', value: row.role, 'aria-label': 'Role', placeholder: 'role, e.g. host, skeptical caller', autocomplete: 'off', oninput: (e) => { row.role = e.target.value; emit(); } });
      const err = h('div', { class: 'small bad', hidden: true });
      refs.push({ err });
      const remove = mode === 'conversation' && i >= 2
        ? h('button', { type: 'button', class: 'secondary', 'aria-label': `Remove speaker ${i + 1}`, onclick: () => { rows.splice(i, 1); draw(); emit(); } }, 'Remove')
        : null;
      // The grid is set inline so the fields stack on a phone even where the stylesheet is not loaded.
      return h('div', { class: 'cast-row' },
        h('div', { class: 'cast-fields', style: 'display: grid; gap: 8px; grid-template-columns: repeat(auto-fit, minmax(150px, 1fr))' }, nameIn, personaSel, voiceIn, roleIn),
        h('div', { class: 'cast-row-foot' }, err, remove));
    }));

    addArea.replaceChildren();
    if (mode === 'conversation') {
      if (rows.length < limit) addArea.append(h('button', { type: 'button', class: 'secondary', onclick: () => { rows.push(blank()); draw('last'); emit(); } }, 'Add a speaker'));
      else addArea.append(h('span', { class: 'small muted' }, `At most ${limit} speakers`));
    }
    if (focus === 'last') list.lastElementChild?.querySelector('input')?.focus();
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
