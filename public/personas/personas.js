// Personas tab: who the host is. Browse and search personas, edit them, explore how each one sounds (explorer.js), draft one with
// the AI, import and export them as JSON, use one in the Generate tab or as the virtual host (and set the host up).
import { h, clear, toast } from '../shared/kit.js';
import { createSpeaker } from '../shared/speaker.js';
import { mountExplorer } from './explorer.js';
import { createPlayer } from '../shared/playbutton.js';

const LINES = (value) => value.split('\n').map((l) => l.trim()).filter(Boolean);
const blank = () => ({ name: '', emoji: '', tagline: '', description: '', instructions: '', tone: '', voice: '', speechModel: '', tags: [], templates: [], stationIds: [], promos: [], signOffs: [], timeLines: {} });
const goTo = (tab) => window.dispatchEvent(new CustomEvent('vh-tab', { detail: tab }));

export async function mountPersonas(root, api) {
  clear(root, h('p', { class: 'muted' }, 'Loading...'));
  let personas = []; let options = null;
  try {
    [{ personas }, options] = await Promise.all([api.get('/personas'), api.get('/options')]);
  } catch (err) {
    clear(root, h('p', { class: 'bad' }, `Could not load personas: ${err.message}`));
    return;
  }
  const speaker = createSpeaker(api, options.features);
  await speaker.loadLibrary();

  const ui = { search: '', tag: '', current: null, exploring: null };
  const gridBox = h('div', { class: 'persona-grid', style: 'display:grid;grid-template-columns:repeat(auto-fill,minmax(260px,1fr));gap:12px' });
  const filterBox = h('div', { class: 'row', style: 'gap:6px' });
  const editorBox = h('div');
  const explorerBox = h('div', { class: 'stack' });

  const reload = async () => { personas = (await api.get('/personas')).personas; paintGrid(); };

  // ---------- the grid ----------
  function paintGrid() {
    const tags = [...new Set(personas.flatMap((p) => p.tags || []))].sort();
    clear(filterBox, h('button', { type: 'button', class: ui.tag ? 'chip-btn' : 'chip-btn on', onclick: () => { ui.tag = ''; paintGrid(); } }, 'all'),
      tags.map((t) => h('button', { type: 'button', class: ui.tag === t ? 'chip-btn on' : 'chip-btn', onclick: () => { ui.tag = ui.tag === t ? '' : t; paintGrid(); } }, t)));
    const q = ui.search.trim().toLowerCase();
    const shown = personas.filter((p) => (!ui.tag || (p.tags || []).includes(ui.tag)) && (!q || [p.name, p.description, p.tagline, ...(p.tags || [])].join(' ').toLowerCase().includes(q)));
    clear(gridBox, shown.length ? shown.map(card) : h('p', { class: 'empty' }, 'No personas match.'));
  }

  // A quick sample straight from the card: the persona's first station ID (or song link) in its own tone, voice and model.
  const samples = new Map();
  function sampleFor(p) {
    if (!samples.has(p.id)) {
      const station = options.station || 'the station';
      const line = (p.stationIds[0] || p.templates[0] || p.promos[0] || p.signOffs[0] || `Hello, this is ${p.name}.`).replace(/\{artist\}/g, 'Ada Lovelace').replace(/\{title\}/g, 'Analytical Love').replace(/\{station\}/g, station);
      samples.set(p.id, createPlayer({ label: `Hear ${p.name}`, load: async () => URL.createObjectURL((await speaker.render(line, { ...(p.speechModel && options.models.choosable ? { speechModel: p.speechModel } : {}), ...(p.voice ? { voice: p.voice } : {}), ...(p.tone ? { tone: p.tone } : {}) })).blob) }));
    }
    return samples.get(p.id);
  }

  function card(p) {
    return h('div', { class: 'clip' },
      h('div', { class: 'row' }, sampleFor(p).button, h('span', { style: 'font-size:28px;line-height:1' }, p.emoji || '🎙️'), h('div', { class: 'grow' }, h('strong', {}, p.name), p.tagline ? h('div', { class: 'small muted' }, `"${p.tagline}"`) : null),
        p.builtin ? h('span', { class: 'chip' }, 'example') : null),
      h('p', { class: 'clip-script small' }, p.description || p.instructions.slice(0, 140)),
      h('div', { class: 'row small muted', style: 'gap:4px' }, (p.tags || []).map((t) => h('span', { class: 'chip' }, t)), p.voice ? h('span', { class: 'chip' }, `voice: ${p.voice}`) : null, p.speechModel ? h('span', { class: 'chip' }, p.speechModel) : null),
      h('div', { class: 'row' },
        h('button', { type: 'button', class: 'primary', onclick: () => explore(p) }, 'Explore'),
        h('button', { type: 'button', onclick: () => edit(p) }, p.builtin ? 'View' : 'Edit'),
        h('button', { type: 'button', onclick: () => edit({ ...p, id: undefined, builtin: false, name: `${p.name} (copy)` }) }, 'Duplicate')),
      h('div', { class: 'row' },
        h('button', { type: 'button', class: 'link', onclick: () => useInGenerate(p) }, 'Use in Generate'),
        h('button', { type: 'button', class: 'link', onclick: () => makeHost(p) }, 'Make the host'),
        h('button', { type: 'button', class: 'link', onclick: () => exportPersona(p) }, 'Export')));
  }

  function useInGenerate(p, text) {
    try {
      const prefs = JSON.parse(localStorage.getItem('djPrefs') || '{}');
      Object.assign(prefs, { persona: p.id, tone: p.tone || '', mode: text ? 'say' : prefs.mode });
      localStorage.setItem('djPrefs', JSON.stringify(prefs));
      if (text) sessionStorage.setItem('prefillText', text);
    } catch { /* storage blocked */ }
    goTo('generate');
  }
  async function makeHost(p) {
    try { await api.put('/host', { personaId: p.id }); toast(`${p.name} is now the host persona. Switch the host on below.`, 'info'); paintHost(); } catch (err) { toast(err.message, 'error'); }
  }
  function exportPersona(p) {
    const rest = { ...p };
    for (const key of ['id', 'builtin', 'updatedAt']) delete rest[key];
    const url = URL.createObjectURL(new Blob([JSON.stringify(rest, null, 2)], { type: 'application/json' }));
    const a = h('a', { href: url, download: `${(p.id || p.name).replace(/[^a-z0-9-]+/gi, '-').toLowerCase()}.persona.json` });
    document.body.append(a); a.click(); a.remove(); setTimeout(() => URL.revokeObjectURL(url), 2000);
  }
  async function importFiles(files) {
    let made = 0;
    for (const file of files) {
      try {
        const data = JSON.parse(await file.text());
        for (const item of Array.isArray(data) ? data : [data]) { await api.post('/personas', item); made += 1; }
      } catch (err) { toast(`${file.name}: ${err.message}`, 'error'); }
    }
    if (made) { toast(`Imported ${made} persona${made > 1 ? 's' : ''}.`, 'info'); await reload(); }
  }

  // ---------- the explorer ----------
  function explore(p) {
    ui.exploring = p;
    mountExplorer(explorerBox, p, {
      api, options, speaker, personas,
      onClose: () => { ui.exploring = null; clear(explorerBox); },
      onUse: (text) => useInGenerate(p, text),
      onSaveDefaults: async (voice) => { await api.put(`/personas/${encodeURIComponent(p.id)}`, { ...p, ...voice }); await reload(); },
    });
    explorerBox.scrollIntoView({ behavior: 'smooth', block: 'start' });
  }

  // ---------- the editor ----------
  function edit(persona) {
    ui.current = { ...blank(), ...persona, timeLines: { ...(persona.timeLines || {}) } };
    paintEditor();
    editorBox.scrollIntoView({ behavior: 'smooth', block: 'nearest' });
  }

  function paintEditor() {
    const c = ui.current;
    if (!c) { clear(editorBox); return; }
    const locked = Boolean(c.builtin);
    const input = (label, key, { rows, placeholder, list, tags } = {}) => {
      const el = rows ? h('textarea', { rows, placeholder, disabled: locked }) : h('input', { placeholder, disabled: locked });
      el.value = list ? (c[key] || []).join('\n') : tags ? (c[key] || []).join(', ') : c[key] || '';
      el.oninput = () => { c[key] = list ? LINES(el.value) : tags ? el.value.split(',').map((t) => t.trim()).filter(Boolean) : el.value; };
      return h('label', { class: 'field' }, label, el);
    };
    const timeInput = (part) => {
      const el = h('input', { disabled: locked, placeholder: `${part}...` });
      el.value = (c.timeLines[part] || '').trim();
      el.oninput = () => { if (el.value.trim()) c.timeLines[part] = ` ${el.value.trim()}`; else delete c.timeLines[part]; };
      return h('label', { class: 'field' }, part[0].toUpperCase() + part.slice(1), el);
    };
    const models = options.models.choosable ? options.models.speech.map((m) => m.id) : [];
    const speechSelect = h('select', { disabled: locked || !models.length, onchange: (e) => { c.speechModel = e.target.value; } },
      h('option', { value: '' }, 'Use the default'), models.map((id) => h('option', { value: id, selected: id === c.speechModel }, id)));

    const describe = h('input', { placeholder: 'e.g. a sleepy night-owl who loves jazz and calls everyone "friend"', 'aria-label': 'Describe the host' });
    const draftStatus = h('span', { class: 'small muted', role: 'status' });
    const draftButton = h('button', { type: 'button', onclick: async () => {
      if (!describe.value.trim()) { draftStatus.textContent = 'Describe the host first.'; return; }
      draftButton.disabled = true; draftStatus.classList.remove('bad'); draftStatus.textContent = 'Writing a persona...';
      try {
        const { persona } = await api.post('/personas/generate', { description: describe.value.trim() });
        ui.current = { ...blank(), ...persona, id: c.id, timeLines: { ...(persona.timeLines || {}) } };
        paintEditor(); toast('Drafted. Edit anything, then save.', 'info');
      } catch (err) { draftStatus.textContent = err.message; draftStatus.classList.add('bad'); draftButton.disabled = false; }
    } }, 'Draft with AI');

    const save = h('button', { class: 'primary', type: 'button', disabled: locked, onclick: async () => {
      save.disabled = true;
      try {
        const { persona } = c.id ? await api.put(`/personas/${encodeURIComponent(c.id)}`, c) : await api.post('/personas', c);
        await reload(); ui.current = { ...blank(), ...persona, timeLines: { ...(persona.timeLines || {}) } };
        paintEditor(); toast('Persona saved.', 'info');
      } catch (err) { toast(err.message, 'error'); save.disabled = false; }
    } }, c.id ? 'Save changes' : 'Save persona');
    const del = c.id && !locked ? h('button', { type: 'button', onclick: async () => {
      if (!confirm(`Delete "${c.name}"?`)) return;
      try { await api.del(`/personas/${encodeURIComponent(c.id)}`); ui.current = null; await reload(); paintEditor(); toast('Deleted.', 'info'); } catch (err) { toast(err.message, 'error'); }
    } }, 'Delete') : null;

    clear(editorBox, h('section', { class: 'card' },
      h('h2', {}, locked ? `${c.emoji || ''} ${c.name} (example, read only)` : c.id ? `Edit ${c.name}` : 'New persona'),
      locked ? h('p', { class: 'muted small' }, 'Example personas cannot be changed. Use Duplicate on the card to make a copy of your own.')
        : h('div', { class: 'grid' }, h('label', { class: 'field' }, 'Let the AI draft it from a description', describe), h('div', { class: 'row' }, draftButton, draftStatus)),
      h('div', { class: 'grid' },
        h('div', { class: 'grid cols' }, input('Emoji', 'emoji', { placeholder: '🎙️' }), input('Name', 'name'), input('Tagline', 'tagline', { placeholder: 'their catchphrase' })),
        input('One-line description', 'description'),
        input('Character brief (who they are, how they talk; the AI writer reads this)', 'instructions', { rows: 5 }),
        h('div', { class: 'grid cols' }, input('Tone', 'tone', { placeholder: 'e.g. weathered, dry, slow' }), input('Voice (optional)', 'voice', { placeholder: 'model default' }), h('label', { class: 'field' }, 'Speech model (optional)', speechSelect)),
        input('Tags (comma separated)', 'tags', { tags: true, placeholder: 'jazz, late-night, chill' }),
        input('Song links, one per line ({artist}, {title} and {station} are filled in)', 'templates', { rows: 5, list: true }),
        input('Station IDs, one per line', 'stationIds', { rows: 3, list: true }),
        h('div', { class: 'grid cols' }, input('Promos, one per line', 'promos', { rows: 3, list: true }), input('Sign-offs, one per line', 'signOffs', { rows: 3, list: true })),
        h('div', {}, h('div', { class: 'label' }, 'Time-of-day lines (added to a song link now and then)'), h('div', { class: 'grid cols' }, ['morning', 'afternoon', 'evening', 'night'].map(timeInput)))),
      h('div', { class: 'row' }, save, c.id ? h('button', { type: 'button', onclick: () => explore(c) }, 'Explore this persona') : null, del, h('button', { type: 'button', onclick: () => { ui.current = null; paintEditor(); } }, 'Close'))));
  }

  // ---------- the virtual host: settings, and what the station daemon last reported ----------
  const hostBox = h('section', { class: 'card' }, h('p', { class: 'muted' }, 'Loading the virtual host...'));
  async function paintHost() {
    let data;
    try { data = await api.get('/host'); } catch (err) { clear(hostBox, h('h2', {}, 'Virtual host'), h('p', { class: 'bad' }, err.message)); return; }
    const c = { ...data.config };
    const st = data.status;
    const age = st ? Math.round((Date.now() - Date.parse(st.reportedAt)) / 1000) : null;
    const fresh = age !== null && age < 120;
    const check = (label, key) => h('label', { class: 'row' }, h('input', { type: 'checkbox', checked: c[key], onchange: (e) => { c[key] = e.target.checked; } }), label);
    const num = (label, key, min, max) => h('label', { class: 'field' }, label, h('input', { type: 'number', min, max, value: c[key], oninput: (e) => { c[key] = Number(e.target.value); } }));
    const txt = (label, key, placeholder) => h('label', { class: 'field' }, label, h('input', { value: c[key] || '', placeholder, oninput: (e) => { c[key] = e.target.value; } }));
    const pick = (label, key, values, blankLabel) => h('label', { class: 'field' }, label,
      h('select', { onchange: (e) => { c[key] = e.target.value; } }, blankLabel ? h('option', { value: '' }, blankLabel) : null, values.map(([v, t]) => h('option', { value: v, selected: v === c[key] }, t))));
    const skip = h('textarea', { rows: 3, 'aria-label': 'Skip list', oninput: (e) => { c.skipArtists = e.target.value.split('\n').map((l) => l.trim()); } });
    skip.value = c.skipArtists.join('\n');
    const preview = h('div', { class: 'small' });
    const artist = h('input', { placeholder: 'Artist', 'aria-label': 'Artist to try' });
    const title = h('input', { placeholder: 'Track title', 'aria-label': 'Title to try' });
    const save = h('button', { class: 'primary', type: 'button', onclick: async () => {
      save.disabled = true;
      try { await api.put('/host', c); toast('Virtual host saved.', 'info'); await paintHost(); } catch (err) { toast(err.message, 'error'); save.disabled = false; }
    } }, 'Save host settings');
    clear(hostBox,
      h('h2', {}, 'Virtual host'),
      h('p', { class: 'muted small' }, 'Between songs the host says a short link about the track that just played, in the persona\'s voice. The site writes and voices it; the station daemon watches what is playing and puts it on air (see station-daemon/README.md).'),
      !st ? h('p', { class: 'note warn' }, 'The station daemon has not reported yet.')
        : h('div', { class: fresh ? 'hint small' : 'note warn small' },
          h('b', {}, fresh ? 'Station daemon connected' : `Station daemon last seen ${Math.round(age / 60)} min ago`), h('br'),
          st.current ? `Now playing: ${st.current.artist ? `${st.current.artist} - ` : ''}${st.current.title}` : 'Nothing playing reported.', h('br'),
          st.ready ? `Link ready (${st.ready.source}): "${st.ready.text}"` : 'No link waiting.', h('br'),
          st.last ? `Last said: "${st.last.text}"` : '', st.counters ? ` · prepared ${st.counters.prepared}, said ${st.counters.played}, skipped ${st.counters.skipped}, failed ${st.counters.failed}` : '',
          st.error ? h('div', { class: 'bad' }, st.error) : null),
      h('div', { class: 'grid' },
        check('Switched on', 'enabled'),
        h('div', { class: 'grid cols' },
          pick('Persona', 'personaId', personas.map((p) => [p.id, `${p.emoji || ''} ${p.name}`.trim()]), 'No persona'),
          pick('Lines', 'lines', [['template', 'From the persona\'s example lines'], ['llm', 'Written by the AI (falls back to the example lines)']]),
          pick('Audio treatment', 'fx', data.fxPresets.filter((f) => f !== 'none').map((f) => [f, f]), 'None')),
        h('div', { class: 'grid cols' }, num('A link after every Nth track', 'every', 1, 50), num('At least this many seconds apart', 'minGapSeconds', 0, 3600), check('May cut in over a live DJ', 'preempt')),
        h('div', { class: 'grid cols' }, txt('Voice (blank: the persona\'s)', 'voice', 'persona default'), txt('Tone (blank: the persona\'s)', 'tone', 'persona default')),
        h('label', { class: 'field' }, 'Skip list: spots and relays, one artist per line (nothing is said over or about them)', skip)),
      h('div', { class: 'row' }, save),
      h('div', { class: 'grid cols' }, artist, title, h('button', { type: 'button', onclick: async (e) => {
        const b = e.currentTarget; b.disabled = true;
        try { const out = await api.post('/host/preview', { artist: artist.value, title: title.value }); clear(preview, h('b', {}, `Would say (${out.source}): `), out.text, out.note ? h('div', { class: 'bad' }, out.note) : null); } catch (err) { clear(preview, h('span', { class: 'bad' }, err.message)); } finally { b.disabled = false; }
      } }, 'Preview a link (saved settings)')),
      preview);
  }

  // ---------- the page ----------
  const search = h('input', { type: 'search', placeholder: 'Search personas...', 'aria-label': 'Search personas', oninput: (e) => { ui.search = e.target.value; paintGrid(); } });
  const importInput = h('input', { type: 'file', accept: '.json,application/json', multiple: true, hidden: true, onchange: (e) => { importFiles([...e.target.files]); e.target.value = ''; } });
  clear(root, h('div', { class: 'stack' },
    h('section', { class: 'card' },
      h('div', { class: 'row' }, h('h2', { class: 'grow' }, 'Personas'),
        h('button', { class: 'primary', type: 'button', onclick: () => edit(blank()) }, 'New persona'),
        h('button', { type: 'button', onclick: () => importInput.click() }, 'Import'), importInput),
      h('p', { class: 'muted small' }, 'A persona is the host: character, tone, voice and a bank of lines. Explore one to hear it say a station ID, a song link or a promo (and compare voices), pick one in Generate, or make it the virtual host.'),
      search, filterBox, gridBox),
    explorerBox, editorBox, hostBox));
  paintGrid();
  paintHost();
}
