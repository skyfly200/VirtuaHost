// Personas tab: who the host is. Browse and search personas, edit them, explore how each one sounds (explorer.js), draft one with
// the AI, import and export them as JSON, use one in the Generate tab or as the virtual host (and set the host up).
import { h, clear, toast } from '../shared/kit.js';
import { createSpeaker } from '../shared/speaker.js';
import { mountExplorer } from './explorer.js';
import { createPlayer } from '../shared/playbutton.js';
import { stationId, stationName } from '../shared/station.js';
import { createStatus } from '../shared/status.js';
import { modelVoiceFields } from '../shared/voicepicker.js';

const LINES = (value) => value.split('\n').map((l) => l.trim()).filter(Boolean);
const blank = () => ({ name: '', emoji: '', tagline: '', description: '', instructions: '', tone: '', voice: '', speechModel: '', tags: [], templates: [], stationIds: [], promos: [], signOffs: [], timeLines: {} });
const goTo = (tab) => window.dispatchEvent(new CustomEvent('vh-tab', { detail: tab }));

export async function mountPersonas(root, api) {
  clear(root, h('p', { class: 'muted' }, 'Loading...'));
  let personas = []; let options = null;
  try {
    [{ personas }, options] = await Promise.all([api.get('/personas'), api.get('/options', { query: { station: stationId() } })]);
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
      const station = stationName(options.station) || 'the station';
      const line = (p.stationIds[0] || p.templates[0] || p.promos[0] || p.signOffs[0] || `Hello, this is ${p.name}.`).replace(/\{artist\}/g, 'Ada Lovelace').replace(/\{title\}/g, 'Analytical Love').replace(/\{station\}/g, station);
      samples.set(p.id, createPlayer({ label: `Hear ${p.name}`, load: async () => URL.createObjectURL((await speaker.render(line, { ...(p.speechModel && options.models.choosable ? { speechModel: p.speechModel } : {}), ...(p.voice ? { voice: p.voice } : {}), ...(p.tone ? { tone: p.tone } : {}) })).blob) }));
    }
    return samples.get(p.id);
  }

  function card(p) {
    return h('div', { class: 'clip' },
      h('div', { class: 'row' }, sampleFor(p).button, sampleFor(p).download(p.name), h('span', { style: 'font-size:28px;line-height:1' }, p.emoji || '🎙️'), h('div', { class: 'grow' }, h('strong', {}, p.name), p.tagline ? h('div', { class: 'small muted' }, `"${p.tagline}"`) : null),
        p.builtin ? h('span', { class: 'chip' }, 'example') : null),
      h('p', { class: 'clip-script small' }, p.description || p.instructions.slice(0, 140)),
      h('div', { class: 'row small muted', style: 'gap:4px' }, (p.tags || []).map((t) => h('span', { class: 'chip' }, t)), p.voice ? h('span', { class: 'chip' }, `voice: ${p.voice}`) : null, p.speechModel ? h('span', { class: 'chip' }, `🔊 ${p.speechModel}`) : null, p.textModel ? h('span', { class: 'chip' }, `✍ ${p.textModel}`) : null),
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
    try { await api.put('/host', { personaId: p.id }, { query: { station: stationId() || undefined } }); toast(`${p.name} is now the virtual host's persona for ${stationName('this station')}. Switch the host on in the Stations tab.`, 'info'); } catch (err) { toast(err.message, 'error'); }
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
    const input = (label, key, { rows, placeholder, list, tags, max } = {}) => {
      const el = rows ? h('textarea', { rows, placeholder, disabled: locked }) : h('input', { placeholder, disabled: locked });
      el.value = list ? (c[key] || []).join('\n') : tags ? (c[key] || []).join(', ') : c[key] || '';
      // A field with a hard limit shows a live count and says plainly when it is over: saving is blocked instead of the text being cut.
      const counter = max ? h('span', { class: 'small', 'aria-live': 'polite' }) : null;
      const count = () => {
        if (!counter) return;
        const used = (c[key] || '').replace(/\s+/g, ' ').trim().length;
        counter.textContent = used > max ? `${used} of ${max} characters: ${used - max} too many. Shorten it before saving; nothing is cut for you.` : `${used} of ${max} characters`;
        counter.className = `small ${used > max ? 'bad' : used > max * 0.9 ? '' : 'muted'}`;
        el.setAttribute('aria-invalid', String(used > max));
        if (typeof save !== 'undefined' && save && !locked) save.disabled = used > max;
      };
      el.oninput = () => { c[key] = list ? LINES(el.value) : tags ? el.value.split(',').map((t) => t.trim()).filter(Boolean) : el.value; count(); };
      setTimeout(count, 0);
      return h('label', { class: 'field' }, label, el, counter);
    };
    const timeInput = (part) => {
      const el = h('input', { disabled: locked, placeholder: `${part}...` });
      el.value = (c.timeLines[part] || '').trim();
      el.oninput = () => { if (el.value.trim()) c.timeLines[part] = ` ${el.value.trim()}`; else delete c.timeLines[part]; };
      return h('label', { class: 'field' }, part[0].toUpperCase() + part.slice(1), el);
    };
    // The voice and models that belong to this persona: what speaks, what writes, and a button to hear it.
    const sampleLine = () => ((c.stationIds || [])[0] || (c.templates || [])[0] || `Hello, this is ${c.name || 'your host'}.`).replace(/\{artist\}/g, 'Ada Lovelace').replace(/\{title\}/g, 'Analytical Love').replace(/\{station\}/g, stationName(options.station) || 'the station');
    const voiceBox = modelVoiceFields({
      options, value: c, disabled: locked, onchange: () => {},
      sample: async (v) => URL.createObjectURL((await speaker.render(sampleLine(), { ...(v.speechModel && options.models.choosable ? { speechModel: v.speechModel } : {}), ...(v.voice ? { voice: v.voice } : {}), ...(c.tone ? { tone: c.tone } : {}) })).blob),
    });

    const describe = h('input', { placeholder: 'e.g. a sleepy night-owl who loves jazz and calls everyone "friend"', 'aria-label': 'Describe the host' });
    const draftStatus = createStatus();
    const draftButton = h('button', { type: 'button', onclick: async () => {
      if (!describe.value.trim()) { draftStatus.fail('Describe the host first.'); return; }
      draftButton.disabled = true; draftStatus.busy('Writing a persona');
      try {
        const { persona } = await api.post('/personas/generate', { description: describe.value.trim() });
        ui.current = { ...blank(), ...persona, id: c.id, timeLines: { ...(persona.timeLines || {}) } };
        paintEditor(); toast('Drafted. Edit anything, then save.', 'info');
      } catch (err) { draftStatus.fail(err.message); draftButton.disabled = false; }
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
        : h('div', { class: 'grid' }, h('label', { class: 'field' }, 'Let the AI draft it from a description', describe), h('div', { class: 'row' }, draftButton, draftStatus.el)),
      h('div', { class: 'grid' },
        h('div', { class: 'grid cols' }, input('Emoji', 'emoji', { placeholder: '🎙️' }), input('Name', 'name'), input('Tagline', 'tagline', { placeholder: 'their catchphrase' })),
        input('One-line description', 'description'),
        input('Character brief (who they are, how they talk; the AI writer reads this)', 'instructions', { rows: 5, max: 1500 }),
        input('Tone', 'tone', { placeholder: 'e.g. weathered, dry, slow' }),
        h('div', {}, h('div', { class: 'label' }, 'Voice and models for this persona (blank = the station\'s, then the site\'s default)'), voiceBox.el),
        input('Tags (comma separated)', 'tags', { tags: true, placeholder: 'jazz, late-night, chill' }),
        input('Song links, one per line ({artist}, {title} and {station} are filled in)', 'templates', { rows: 5, list: true }),
        input('Station IDs, one per line', 'stationIds', { rows: 3, list: true }),
        h('div', { class: 'grid cols' }, input('Promos, one per line', 'promos', { rows: 3, list: true }), input('Sign-offs, one per line', 'signOffs', { rows: 3, list: true })),
        h('div', {}, h('div', { class: 'label' }, 'Time-of-day lines (added to a song link now and then)'), h('div', { class: 'grid cols' }, ['morning', 'afternoon', 'evening', 'night'].map(timeInput)))),
      h('div', { class: 'row' }, save, c.id ? h('button', { type: 'button', onclick: () => explore(c) }, 'Explore this persona') : null, del, h('button', { type: 'button', onclick: () => { ui.current = null; paintEditor(); } }, 'Close'))));
  }

  // ---------- the page ----------
  const search = h('input', { type: 'search', placeholder: 'Search personas...', 'aria-label': 'Search personas', oninput: (e) => { ui.search = e.target.value; paintGrid(); } });
  const importInput = h('input', { type: 'file', accept: '.json,application/json', multiple: true, hidden: true, onchange: (e) => { importFiles([...e.target.files]); e.target.value = ''; } });
  clear(root, h('div', { class: 'stack' },
    h('section', { class: 'card' },
      h('div', { class: 'row' }, h('h2', { class: 'grow' }, 'Personas'),
        h('button', { class: 'primary', type: 'button', onclick: () => edit(blank()) }, 'New persona'),
        h('button', { type: 'button', onclick: () => importInput.click() }, 'Import'), importInput),
      h('p', { class: 'muted small' }, 'A persona is the host: character, tone, voice and a bank of lines. Explore one to hear it say a station ID, a song link or a promo (and compare voices), pick one in Generate, or make it the virtual host for the station you are working on (virtual host settings are per station, in the Stations tab).'),
      search, filterBox, gridBox),
    explorerBox, editorBox));
  paintGrid();
}
