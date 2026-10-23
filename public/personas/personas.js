// Personas tab: who the host is. Browse and search personas, edit them, explore how each one sounds (explorer.js), draft one with
// the AI, import and export them as JSON, use one in the Generate tab or as the virtual host (and set the host up).
import { h, clear, toast } from '../shared/kit.js';
import { createSpeaker } from '../shared/speaker.js';
import { mountExplorer } from './explorer.js';
import { createPlayer } from '../shared/playbutton.js';
import { stationId, stationName } from '../shared/station.js';
import { createStatus } from '../shared/status.js';
import { modelVoiceFields } from '../shared/voicepicker.js';
import { popMenu } from '../shared/popmenu.js';
import { emojiField } from '../shared/emojipicker.js';

const LINES = (value) => value.split('\n').map((l) => l.trim()).filter(Boolean);
const blank = () => ({ name: '', emoji: '', tagline: '', description: '', instructions: '', tone: '', voice: '', speechModel: '', tags: [], templates: [], stationIds: [], promos: [], signOffs: [], timeLines: {} });
const goTo = (tab) => window.dispatchEvent(new CustomEvent('vh-tab', { detail: tab }));

// Admins can edit the example personas too (the edit replaces the example for everyone, and Reset brings the original back); everyone else duplicates one.
export async function mountPersonas(root, api, { admin = false } = {}) {
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
  const gridBox = h('div', { class: 'persona-grid' });
  const activeTag = h('span');                                     // the chosen tag, shown beside the search box
  const tagDrop = h('div', { class: 'popmenu tag-drop', role: 'listbox', 'aria-label': 'Tags', hidden: true });
  const editorBox = h('div');
  const explorerBox = h('div', { class: 'stack' });

  const reload = async () => { personas = (await api.get('/personas')).personas; paintGrid(); };

  // ---------- the grid ----------
  function paintGrid() {
    const tags = [...new Set(personas.flatMap((p) => p.tags || []))].sort();
    const count = (t) => personas.filter((p) => (p.tags || []).includes(t)).length;
    const pickTag = (t) => { ui.tag = t; tagDrop.hidden = true; paintGrid(); };
    clear(tagDrop, h('button', { type: 'button', role: 'option', 'aria-selected': String(!ui.tag), class: ui.tag ? '' : 'on', onclick: () => pickTag('') }, 'All tags'),
      tags.map((t) => h('button', { type: 'button', role: 'option', 'aria-selected': String(ui.tag === t), class: ui.tag === t ? 'on' : '', onclick: () => pickTag(ui.tag === t ? '' : t) }, h('span', { class: 'grow' }, t), h('span', { class: 'muted small' }, count(t)))));
    clear(activeTag, ui.tag ? h('button', { type: 'button', class: 'chip-btn on', title: 'Show all tags again', onclick: () => pickTag('') }, `${ui.tag} \u2715`) : '');
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

  // A card shows what you need at a glance (who, one line about them, a few tags) and keeps three actions in view: hear, explore, edit.
  // Everything else is in the "more" menu.
  function card(p) {
    const sample = sampleFor(p);
    const tags = p.tags || [];
    return h('article', { class: 'pcard' },
      h('div', { class: 'pcard-head' }, h('span', { class: 'pcard-emoji', 'aria-hidden': 'true' }, p.emoji || '🎙️'),
        h('div', { class: 'grow' }, h('strong', {}, p.name), p.tagline ? h('div', { class: 'small muted clamp1' }, `\u201C${p.tagline}\u201D`) : null),
        p.builtin ? h('span', { class: 'chip', title: admin ? 'An example persona. You can edit it; Reset puts the original back.' : 'An example: duplicate it to change it' }, p.edited ? 'example, edited' : 'example') : null),
      h('p', { class: 'small clamp2', style: 'margin:0' }, p.description || p.instructions),
      tags.length ? h('div', { class: 'row small', style: 'gap:4px' }, tags.slice(0, 3).map((t) => h('span', { class: 'chip' }, t)), tags.length > 3 ? h('span', { class: 'muted' }, `+${tags.length - 3}`) : null) : null,
      h('div', { class: 'pcard-actions' }, sample.button,
        h('button', { type: 'button', class: 'primary', onclick: () => explore(p) }, 'Explore'),
        h('button', { type: 'button', onclick: () => edit(p) }, p.builtin && !admin ? 'View' : 'Edit'),
        h('span', { class: 'grow' }),
        popMenu({ label: `More for ${p.name}`, items: [
          { label: 'Use in the Studio', onclick: () => useInGenerate(p) },
          { label: 'Make the virtual host', onclick: () => makeHost(p) },
          { label: 'Duplicate', onclick: () => edit({ ...p, id: undefined, builtin: false, name: `${p.name} (copy)` }) },
          { label: 'Export as JSON', onclick: () => exportPersona(p) }] })));
  }

  function useInGenerate(p, text) {
    try {
      const prefs = JSON.parse(localStorage.getItem('djPrefs') || '{}');
      Object.assign(prefs, { persona: p.id, tone: p.tone || '', mode: text ? 'say' : prefs.mode });
      localStorage.setItem('djPrefs', JSON.stringify(prefs));
      sessionStorage.setItem('studioPersona', p.id);
      if (text) sessionStorage.setItem('prefillText', text);
    } catch { /* storage blocked */ }
    goTo('studio');
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
    const locked = Boolean(c.builtin) && !admin;                 // an example is read-only unless you are an admin
    const example = Boolean(c.builtin);
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
    const reset = example && admin && c.edited ? h('button', { type: 'button', onclick: async () => {
      if (!confirm(`Put the original "${c.name}" example back? Your changes to it are lost.`)) return;
      try { await api.del(`/personas/${encodeURIComponent(c.id)}`); ui.current = null; await reload(); paintEditor(); toast('Back to the original.', 'info'); } catch (err) { toast(err.message, 'error'); }
    } }, 'Reset to original') : null;
    const del = c.id && !example ? h('button', { type: 'button', onclick: async () => {
      if (!confirm(`Delete "${c.name}"?`)) return;
      try { await api.del(`/personas/${encodeURIComponent(c.id)}`); ui.current = null; await reload(); paintEditor(); toast('Deleted.', 'info'); } catch (err) { toast(err.message, 'error'); }
    } }, 'Delete') : null;

    // Grouped so it can be taken in at a glance: who they are and how they talk are open; the rest opens on demand and says what is inside.
    const count = (list) => ((list || []).length ? `${list.length} line${list.length === 1 ? '' : 's'}` : 'empty');
    const sect = (title, hint, open, ...body) => h('details', { class: 'sect', open }, h('summary', {}, title, h('span', { class: 'sect-hint' }, hint)), h('div', { class: 'sect-body stack' }, ...body));
    const lineCount = (c.templates || []).length + (c.stationIds || []).length + (c.promos || []).length + (c.signOffs || []).length;
    const filledTimes = Object.keys(c.timeLines || {}).length;
    clear(editorBox, h('section', { class: 'card stack' },
      h('div', { class: 'row' }, h('h2', { class: 'grow', style: 'margin:0' }, locked ? `${c.emoji || ''} ${c.name}` : c.id ? `Edit ${c.name}` : 'New persona'), example ? h('span', { class: 'chip' }, locked ? 'example, read only' : c.edited ? 'example, edited' : 'example') : null,
        h('button', { type: 'button', class: 'icon-btn', 'aria-label': 'Close', title: 'Close', onclick: () => { ui.current = null; paintEditor(); } }, '\u2715')),
      example && !locked ? h('p', { class: 'muted small' }, 'This is an example persona. Saving replaces it for everyone on the station' + (c.edited ? '; Reset to original puts the shipped version back.' : '; you can reset it to the original later.')) : null,
      locked ? h('p', { class: 'muted small' }, 'Example personas can only be changed by an admin. Use More, then Duplicate, on the card to make a copy of your own.')
        : sect('Start from a description', 'optional', !c.id && !c.name, h('div', { class: 'row' }, h('label', { class: 'field grow' }, 'Describe the host and let the AI draft the rest', describe), draftButton), draftStatus.el),
      sect('Identity', c.name || 'name, emoji, tagline', true,
        h('div', { class: 'grid cols' }, emojiField({ value: c.emoji, disabled: locked, onchange: (e) => { c.emoji = e; } }), input('Name', 'name'), input('Tagline', 'tagline', { placeholder: 'their catchphrase' })),
        input('One-line description', 'description'),
        input('Tags (comma separated)', 'tags', { tags: true, placeholder: 'jazz, late-night, chill' })),
      sect('Character', c.tone || 'brief and tone', true,
        input('Character brief (who they are, how they talk; the AI writer reads this)', 'instructions', { rows: 5, max: 1500 }),
        input('Tone', 'tone', { placeholder: 'e.g. weathered, dry, slow' })),
      sect('Voice and models', c.voice || c.speechModel || 'station default', false,
        h('p', { class: 'small muted', style: 'margin:0' }, 'Blank means the station\'s choice, then the site\'s default.'), voiceBox.el),
      sect('Lines', lineCount ? `${lineCount} lines` : 'none yet', false,
        h('p', { class: 'small muted', style: 'margin:0' }, 'Ready-made lines for song links, station IDs, promos and sign-offs. {artist}, {title} and {station} are filled in.'),
        input(`Song links, one per line (${count(c.templates)})`, 'templates', { rows: 4, list: true }),
        input(`Station IDs, one per line (${count(c.stationIds)})`, 'stationIds', { rows: 3, list: true }),
        h('div', { class: 'grid cols' }, input(`Promos, one per line (${count(c.promos)})`, 'promos', { rows: 3, list: true }), input(`Sign-offs, one per line (${count(c.signOffs)})`, 'signOffs', { rows: 3, list: true }))),
      sect('Time of day', filledTimes ? `${filledTimes} of 4 set` : 'optional', false,
        h('p', { class: 'small muted', style: 'margin:0' }, 'A short sentence added to a song link now and then.'), h('div', { class: 'grid cols' }, ['morning', 'afternoon', 'evening', 'night'].map(timeInput))),
      h('div', { class: 'actionbar' }, save, c.id ? h('button', { type: 'button', onclick: () => explore(c) }, 'Explore this persona') : null, h('span', { class: 'grow' }), reset, del)));
  }

  // ---------- the page ----------
  const search = h('input', { type: 'search', placeholder: 'Search personas...', 'aria-label': 'Search personas', 'aria-haspopup': 'listbox', oninput: (e) => { ui.search = e.target.value; paintGrid(); } });
  // Clicking in the search box drops down the tags to filter by; a click elsewhere or Escape closes it.
  const searchBox = h('div', { class: 'row', style: 'gap:8px;align-items:center' }, h('span', { class: 'popwrap grow' }, search, tagDrop), activeTag);
  search.addEventListener('focus', () => { tagDrop.hidden = false; });
  search.addEventListener('click', () => { tagDrop.hidden = false; });
  search.addEventListener('keydown', (e) => { if (e.key === 'Escape') { tagDrop.hidden = true; } if (e.key === 'ArrowDown') { const first = tagDrop.querySelector('button'); if (first) { e.preventDefault(); tagDrop.hidden = false; first.focus(); } } });
  tagDrop.addEventListener('keydown', (e) => {
    const rows = [...tagDrop.querySelectorAll('button')]; const at = rows.indexOf(document.activeElement);
    if (e.key === 'ArrowDown') { e.preventDefault(); rows[(at + 1) % rows.length].focus(); } else if (e.key === 'ArrowUp') { e.preventDefault(); rows[(at - 1 + rows.length) % rows.length].focus(); } else if (e.key === 'Escape') { tagDrop.hidden = true; search.focus(); }
  });
  document.addEventListener('click', (e) => { if (!searchBox.contains(e.target)) tagDrop.hidden = true; });
  const importInput = h('input', { type: 'file', accept: '.json,application/json', multiple: true, hidden: true, onchange: (e) => { importFiles([...e.target.files]); e.target.value = ''; } });
  clear(root, h('div', { class: 'stack' },
    h('section', { class: 'card' },
      h('div', { class: 'row' }, h('h2', { class: 'grow' }, 'Personas'),
        h('button', { class: 'primary', type: 'button', onclick: () => edit(blank()) }, 'New persona'),
        h('button', { type: 'button', onclick: () => importInput.click() }, 'Import'), importInput),
      h('p', { class: 'muted small' }, 'A persona is the host: character, tone, voice and a bank of lines. Explore one to hear it say a station ID, a song link or a promo (and compare voices), use one in the Studio, or make it the virtual host for the station you are working on (virtual host settings are per station, in the Stations tab).'),
      searchBox, gridBox),
    explorerBox, editorBox));
  paintGrid();
}
