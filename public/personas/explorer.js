// The persona sample explorer: hear a persona say each kind of line (station ID, song link, promo, sign-off, ...), write new
// ones in character, play them all in a row, and compare voices side by side before choosing one.
import { h, clear, toast } from '../shared/kit.js';
import { FX_PREVIEWS } from '../generate/fx.js';

const MAX_COMPARE = 4;

// What a persona can say, and how to ask the writer for another of each kind.
const kindsOf = (p, sample) => [
  { key: 'stationId', label: 'Station IDs', lines: p.stationIds, format: 'station-id', brief: 'a station ID' },
  { key: 'link', label: 'Song links (after a track)', lines: p.templates, format: 'back-announce', brief: `that was "${sample.title}" by ${sample.artist}` },
  { key: 'intro', label: 'Song intros', lines: [], format: 'song-intro', brief: `introduce "${sample.title}" by ${sample.artist}` },
  { key: 'time', label: 'Time of day', lines: Object.values(p.timeLines || {}).map((l) => l.trim()), format: 'time-check', brief: 'a quick time check' },
  { key: 'promo', label: 'Promos', lines: p.promos || [], format: 'promo', brief: 'promote an upcoming event this Friday night' },
  { key: 'signoff', label: 'Sign-offs', lines: p.signOffs || [], format: '', brief: 'sign off at the end of the show' },
  { key: 'shout', label: 'Shout-outs', lines: [], format: 'shoutout', brief: 'give a shout-out to a listener named Alex' },
];

// Draws the explorer into `box` for `persona`. `ctx` = { api, options, speaker, personas, onSaveDefaults(settings), onUse(text) }.
export function mountExplorer(box, persona, ctx) {
  const { api, options, speaker } = ctx;
  const choosable = options.models.choosable;
  const models = choosable ? options.models.speech : [];
  const saved = Boolean(persona.id);   // an unsaved draft cannot be sent to the writer by id
  const settings = { speechModel: persona.speechModel || (choosable ? options.models.defaultSpeech : ''), voice: persona.voice || '', tone: persona.tone || '', fx: '', artist: 'Boards of Canada', title: 'Roygbiv' };
  const station = options.station || 'the station';
  const fill = (t) => t.replace(/\{artist\}/g, settings.artist).replace(/\{title\}/g, settings.title).replace(/\{station\}/g, station);
  const rows = new Map();     // key -> [{ text, url, status, error }]
  let compare = [];
  let stopAll = false;

  const entry = () => models.find((m) => m.id === settings.speechModel);
  const baseFor = (over = {}) => ({ ...(choosable && (over.speechModel ?? settings.speechModel) ? { speechModel: over.speechModel ?? settings.speechModel } : {}), ...((over.voice ?? settings.voice) ? { voice: over.voice ?? settings.voice } : {}), ...((over.tone ?? settings.tone) ? { tone: over.tone ?? settings.tone } : {}) });

  async function say(text, over = {}) {
    const out = await speaker.render(fill(text), baseFor(over), { fx: over.fx ?? settings.fx });
    return { url: URL.createObjectURL(out.blob), out };
  }

  const rowsFor = (kind) => {
    if (!rows.has(kind.key)) rows.set(kind.key, kind.lines.slice(0, 3).map((text) => ({ text, url: '', status: '', error: '' })));
    return rows.get(kind.key);
  };

  // Asks the writer for a new line of this kind, in character.
  async function writeInto(kind, row, repaint) {
    row.status = 'Writing...'; repaint();
    try {
      const brief = kindsOf(persona, settings).find((k) => k.key === kind.key).brief;
      const out = await api.post('/generate', { mode: 'ai', prompt: brief, textOnly: true, persona: persona.id, ...(kind.format ? { format: kind.format } : {}), ...(settings.tone ? { tone: settings.tone } : {}) });
      row.text = out.scriptText; if (row.url) URL.revokeObjectURL(row.url); row.url = ''; row.error = ''; row.status = '';
    } catch (err) { row.error = err.message; row.status = ''; }
    repaint();
  }

  function lineRow(kind, row, repaint) {
    const hear = h('button', { type: 'button', onclick: async () => {
      row.status = 'Speaking...'; row.error = ''; repaint();
      try { if (row.url) URL.revokeObjectURL(row.url); row.url = (await say(row.text)).url; row.status = ''; } catch (err) { row.error = err.message; row.status = ''; }
      repaint();
      const a = box.querySelector(`audio[data-row="${row.id}"]`); if (a) a.play().catch(() => {});
    } }, row.url ? 'Hear it again' : 'Hear it');
    const rewrite = h('button', { type: 'button', disabled: !saved, title: saved ? 'Ask the AI for a new one in this persona\'s voice' : 'Save the persona first', onclick: () => writeInto(kind, row, repaint) }, 'Write another');
    const text = h('textarea', { rows: 2, 'aria-label': `${kind.label} line`, oninput: (e) => { row.text = e.target.value; row.url = ''; } });
    text.value = row.text;
    return h('div', { class: 'line' }, h('div', {},
      text,
      h('div', { class: 'row' }, hear, rewrite, h('button', { type: 'button', class: 'link', onclick: () => ctx.onUse(fill(row.text)) }, 'Use in Generate'),
        row.status ? h('span', { class: 'small muted' }, row.status) : null, row.error ? h('span', { class: 'small bad' }, row.error) : null),
      row.url ? h('audio', { controls: true, src: row.url, 'data-row': row.id, style: 'width:100%' }) : null));
  }

  // ----- play every line in a row, one after another -----
  async function playAll(button) {
    stopAll = false; button.disabled = true;
    const all = kindsOf(persona, settings).flatMap((k) => rowsFor(k).filter((r) => r.text.trim()).map((r) => ({ k, r })));
    try {
      for (const [i, { r }] of all.entries()) {
        if (stopAll) break;
        status(`Line ${i + 1} of ${all.length}...`);
        if (!r.url) r.url = (await say(r.text)).url;
        paintKinds();
        await new Promise((resolve) => {
          const a = box.querySelector(`audio[data-row="${r.id}"]`);
          if (!a) { resolve(); return; }
          a.onended = resolve; a.onerror = resolve; a.play().catch(resolve);
        });
      }
      status(stopAll ? 'Stopped.' : 'Done.');
    } catch (err) { status(err.message, true); } finally { button.disabled = false; }
  }

  // ----- compare voices -----
  function compareCard() {
    const line = h('input', { value: fill(persona.stationIds[0] || persona.templates[0] || ''), 'aria-label': 'Line to compare', style: 'width:100%' });
    const grid = h('div', { class: 'slot-grid' });
    const paint = () => clear(grid, compare.map((c, i) => {
      const e = models.find((m) => m.id === c.speechModel);
      const voices = [...new Set([e && e.voice, ...((e && e.voices) || [])].filter(Boolean))];
      const dl = h('datalist', { id: `cv-${i}` }, voices.slice(0, 300).map((v) => h('option', { value: v })));
      return h('div', { class: 'card variant' },
        choosable ? h('label', { class: 'field' }, 'Model', h('select', { onchange: (ev) => { c.speechModel = ev.target.value; c.voice = ''; paint(); } }, models.map((m) => h('option', { value: m.id, selected: m.id === c.speechModel }, m.id)))) : null,
        h('label', { class: 'field' }, 'Voice', h('input', { value: c.voice, list: `cv-${i}`, placeholder: (e && e.voice) || 'default', oninput: (ev) => { c.voice = ev.target.value; } }), dl),
        h('div', { class: 'row' }, h('button', { type: 'button', onclick: async (ev) => {
          const b = ev.currentTarget; b.disabled = true; c.error = '';
          try { if (c.url) URL.revokeObjectURL(c.url); c.url = (await say(line.value, { speechModel: c.speechModel, voice: c.voice })).url; } catch (err) { c.error = err.message; }
          b.disabled = false; paint();
        } }, c.url ? 'Again' : 'Hear it'), h('button', { type: 'button', onclick: () => { settings.speechModel = c.speechModel; settings.voice = c.voice; toast('Now using this voice for the samples above.', 'info'); paintSettings(); } }, 'Use this voice'),
        h('button', { type: 'button', class: 'link danger', onclick: () => { compare.splice(i, 1); paint(); } }, 'Remove')),
        c.error ? h('p', { class: 'small bad' }, c.error) : null, c.url ? h('audio', { controls: true, src: c.url }) : null);
    }));
    if (!compare.length) compare = [{ speechModel: settings.speechModel, voice: settings.voice }, { speechModel: (models[1] || models[0] || {}).id || '', voice: '' }];
    paint();
    return h('section', { class: 'card' }, h('h3', {}, 'Compare voices'),
      h('p', { class: 'muted small' }, 'The same line in different models and voices, side by side. Pick the one that sounds like this persona.'),
      h('div', { class: 'row' }, h('div', { class: 'grow' }, line), choosable && compare.length < MAX_COMPARE ? h('button', { type: 'button', onclick: () => { compare.push({ speechModel: settings.speechModel, voice: '' }); paint(); } }, 'Add one') : null,
        h('button', { type: 'button', class: 'primary', onclick: (ev) => { const b = ev.currentTarget; b.disabled = true; Promise.all([...grid.querySelectorAll('button')].filter((x) => /^(Hear it|Again)$/.test(x.textContent)).map((x) => x.click())).finally(() => { b.disabled = false; }); } }, 'Hear all')),
      grid);
  }

  // ----- the voice settings every sample uses -----
  const statusEl = h('p', { class: 'small muted', role: 'status' });
  const status = (m, bad = false) => { statusEl.textContent = m; statusEl.classList.toggle('bad', bad); };
  const settingsBox = h('div');
  function paintSettings() {
    const e = entry();
    const voices = [...new Set([e && e.voice, ...((e && e.voices) || [])].filter(Boolean))];
    const cues = choosable ? (e || {}).cues : options.models.fixedCues;
    clear(settingsBox, h('div', { class: 'grid cols' },
      choosable ? h('label', { class: 'field' }, 'Speech model', h('select', { onchange: (ev) => { settings.speechModel = ev.target.value; settings.voice = ''; paintSettings(); } }, models.map((m) => h('option', { value: m.id, selected: m.id === settings.speechModel }, m.id)))) : h('p', { class: 'muted small' }, 'Using Gemini directly; the model is fixed.'),
      h('label', { class: 'field' }, 'Voice', h('input', { value: settings.voice, list: 'ex-voices', placeholder: (e && e.voice) || 'default', oninput: (ev) => { settings.voice = ev.target.value; } }), h('datalist', { id: 'ex-voices' }, voices.map((v) => h('option', { value: v })))),
      h('label', { class: 'field' }, 'Tone', h('input', { value: settings.tone, placeholder: cues && cues.tone === 'none' ? 'this model ignores tone' : 'how it should sound', oninput: (ev) => { settings.tone = ev.target.value; } })),
      h('label', { class: 'field' }, 'Effect (preview)', h('select', { onchange: (ev) => { settings.fx = ev.target.value; } }, h('option', { value: '' }, 'None'), Object.entries(FX_PREVIEWS).map(([k, f]) => h('option', { value: k, selected: k === settings.fx }, f.label))))),
    h('div', { class: 'grid cols' },
      h('label', { class: 'field' }, 'Sample artist', h('input', { value: settings.artist, oninput: (ev) => { settings.artist = ev.target.value; } })),
      h('label', { class: 'field' }, 'Sample title', h('input', { value: settings.title, oninput: (ev) => { settings.title = ev.target.value; } }))),
    cues ? h('p', { class: 'small muted' }, `This model: tone ${cues.tone === 'none' ? 'is ignored' : 'works'}; tags like [laughs] are ${cues.tags === true ? 'performed' : cues.tags === false ? 'removed' : 'untested'}.`) : null);
  }

  const kindsBox = h('div', { class: 'stack' });
  let nextId = 0;
  function paintKinds() {
    clear(kindsBox, kindsOf(persona, settings).map((kind) => {
      const list = rowsFor(kind);
      for (const r of list) r.id ||= `r${nextId++}`;
      const inner = h('div', { class: 'lines' });
      const repaint = () => { clear(inner, list.map((r) => lineRow(kind, r, repaint))); };
      repaint();
      return h('section', { class: 'card' }, h('div', { class: 'row' }, h('h3', { class: 'grow' }, kind.label),
        h('button', { type: 'button', disabled: !saved, onclick: () => { const row = { id: `r${nextId++}`, text: '', url: '', status: '', error: '' }; list.push(row); writeInto(kind, row, repaint); } }, 'Add one with AI')),
        list.length ? inner : h('p', { class: 'muted small' }, saved ? 'None written yet. "Add one with AI" writes one in this persona\'s voice.' : 'None yet.'));
    }));
  }

  const playButton = h('button', { class: 'primary', type: 'button', onclick: (e) => playAll(e.currentTarget) }, 'Play all in a row');
  const stopButton = h('button', { type: 'button', onclick: () => { stopAll = true; box.querySelectorAll('audio').forEach((a) => a.pause()); } }, 'Stop');
  const saveDefaults = h('button', { type: 'button', disabled: persona.builtin || !saved, title: persona.builtin ? 'Duplicate this persona to change its defaults' : '', onclick: async (e) => {
    e.currentTarget.disabled = true;
    try { await ctx.onSaveDefaults({ speechModel: settings.speechModel, voice: settings.voice, tone: settings.tone }); toast('Saved as this persona\'s voice.', 'info'); } catch (err) { toast(err.message, 'error'); } finally { e.currentTarget.disabled = persona.builtin || !saved; }
  } }, 'Save this voice as the persona\'s default');

  clear(box, h('section', { class: 'card' },
    h('div', { class: 'row' }, h('h2', { class: 'grow' }, `${persona.emoji || ''} Explore ${persona.name}`.trim()), h('button', { type: 'button', onclick: ctx.onClose }, 'Close')),
    persona.tagline ? h('p', { class: 'muted' }, `"${persona.tagline}"`) : null,
    settingsBox, h('div', { class: 'row' }, playButton, stopButton, saveDefaults), statusEl),
  kindsBox, compareCard());
  paintSettings();
  paintKinds();
}
