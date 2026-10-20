// Voice Lab: try voices, models, tone and effects side by side on the same text, audition host personas, and apply what works.
import { h, clear, toast, audioUrl } from '../shared/kit.js';

let client = null;   // set by mountLab: a client for this site's /api/voice proxy
let app = null;

const state = {
  providers: null, fx: [], personas: [], sfx: [], voices: new Map(), host: null,
  mode: 'single', text: 'Welcome back to Way High Radio. [sfx:chime] We are taking radio higher.', slots: [],
};
const MAX_SLOTS = 4;
const speakersIn = (text) => [...new Set([...text.matchAll(/^\s*([^:(\n\[\]]{1,30}?)\s*(?:\([^)]*\))?\s*:/gm)].map((m) => m[1].trim()))];

async function load() {
  const [providers, fx, personas, sfx, host] = await Promise.all([
    client.get('/providers'),
    client.get('/fx/presets').catch(() => ({ presets: [] })),
    client.get('/personas').catch(() => ({ personas: [] })),
    client.get('/sfx').catch(() => ({ effects: [] })),
    client.get('/host').catch(() => null),
  ]);
  Object.assign(state, { providers, fx: fx.presets || [], personas: personas.personas || [], sfx: sfx.effects || [], host });
}

async function voicesFor(provider) {
  const key = provider || '';
  if (!state.voices.has(key)) state.voices.set(key, client.get('/tts/voices', { query: { provider: key } }).catch((e) => { toast(`Voices: ${e.message}`, 'error'); return []; }));
  return state.voices.get(key);
}
const providerInfo = (name) => state.providers.tts.providers.find((p) => p.name === (name || state.providers.tts.names[0])) || { capabilities: {}, models: [] };

function newSlot(from) {
  const first = state.providers.tts.names[0] || '';
  return { id: Math.random().toString(36).slice(2), provider: first, voice: '', model: '', tone: '', fx: '', status: '', clip: null, audio: '', ...from };
}

// ---------- shared script ----------
function scriptCard() {
  const textarea = h('textarea', { rows: 5, oninput: (e) => { state.text = e.target.value; renderSpeakers(); }, 'aria-label': 'Script' });
  textarea.value = state.text;
  const mode = h('select', { onchange: (e) => { state.mode = e.target.value; render(); }, 'aria-label': 'Mode' },
    h('option', { value: 'single', selected: state.mode === 'single' }, 'One voice'),
    h('option', { value: 'dialogue', selected: state.mode === 'dialogue' }, 'Conversation ("Name: line" per line)'));
  const insert = (name) => {
    const tag = `[sfx:${name}]`;
    const at = textarea.selectionStart ?? textarea.value.length;
    textarea.setRangeText(`${at && !/\s$/.test(textarea.value.slice(0, at)) ? ' ' : ''}${tag} `, at, textarea.selectionEnd ?? at, 'end');
    state.text = textarea.value; textarea.focus(); renderSpeakers();
  };
  const tray = state.sfx.length ? h('div', {}, h('h3', {}, 'Sound effects (click to insert)'), h('div', { class: 'sfx-tray' }, state.sfx.map((e) => h('button', { type: 'button', onclick: () => insert(e.name), title: e.label || e.name }, e.name)))) : null;
  const brief = h('input', { placeholder: 'Or ask the AI: "last call, the bar closes in ten minutes"', 'aria-label': 'AI brief' });
  const draft = h('button', { onclick: async (e) => {
    if (!brief.value.trim()) return;
    e.target.disabled = true;
    try {
      const names = state.mode === 'dialogue' ? speakersIn(textarea.value).slice(0, 2) : [];
      const out = await client.post('/announcements/draft', { prompt: brief.value, format: state.mode, speakers: names.length ? names : undefined, sfx: state.mode === 'dialogue' && state.sfx.length > 0 });
      textarea.value = state.text = out.text; renderSpeakers();
    } catch (err) { toast(err.message, 'error'); } finally { e.target.disabled = false; }
  } }, 'Draft with AI');
  state.renderSpeakers = null;
  const speakers = h('div', { class: 'speakers' });
  function renderSpeakers() {
    clear(speakers);
    if (state.mode !== 'dialogue') return;
    state.speakerVoices ||= {};
    const names = speakersIn(state.text);
    if (!names.length) { speakers.append(h('p', { class: 'muted small' }, 'Write lines like "Rocky: Hello there." to cast voices.')); return; }
    for (const name of names) {
      const sel = h('input', { value: state.speakerVoices[name] ?? name, placeholder: 'voice name or id', oninput: (e) => { state.speakerVoices[name] = e.target.value; }, 'aria-label': `Voice for ${name}` });
      speakers.append(h('label', { class: 'field' }, `${name} speaks as`, sel));
    }
  }
  renderSpeakers();
  return h('section', { class: 'card' },
    h('h2', {}, 'Script'),
    h('div', { class: 'row' }, h('label', { class: 'field grow' }, 'Mode', mode)),
    h('div', { class: 'grid' }, textarea, speakers, tray,
      h('div', { class: 'row' }, h('div', { class: 'grow' }, brief), draft)));
}

// ---------- variants ----------
function requestFor(slot) {
  const spec = { provider: slot.provider || undefined, model: slot.model || undefined, tone: slot.tone || undefined, fx: slot.fx || undefined, format: 'MP3' };
  if (state.mode === 'dialogue') {
    const voices = {};
    for (const n of speakersIn(state.text)) voices[n] = (state.speakerVoices || {})[n] || n;
    return { ...spec, script: state.text, voices };
  }
  return { ...spec, text: state.text, voice: slot.voice || undefined };
}

async function generate(slot, card) {
  slot.status = 'Generating...'; paint(slot, card);
  const t0 = performance.now();
  try {
    const out = await client.post('/synth', requestFor(slot));
    slot.clip = out.clip;
    slot.audio = await audioUrl(client, `/clips/${encodeURIComponent(out.clip.id)}/audio`);
    slot.status = `${out.reused ? 'Reused a saved clip' : 'Made'} in ${((performance.now() - t0) / 1000).toFixed(1)}s`;
  } catch (err) { slot.status = ''; slot.error = err.message; toast(err.message, 'error'); }
  paint(slot, card);
}

function paint(slot, card) { clear(card, ...slotBody(slot, card)); }

function slotBody(slot, card) {
  const info = providerInfo(slot.provider);
  const set = (k) => (e) => { slot[k] = e.target.value; };
  const providerSel = h('select', { onchange: (e) => { slot.provider = e.target.value; slot.voice = ''; slot.model = ''; paint(slot, card); }, 'aria-label': 'Provider' },
    state.providers.tts.names.map((n) => h('option', { value: n, selected: n === slot.provider }, n)));
  const voiceInput = h('input', { list: `v-${slot.id}`, value: slot.voice, placeholder: info.defaultVoice || 'default voice', oninput: set('voice'), 'aria-label': 'Voice' });
  const dl = h('datalist', { id: `v-${slot.id}` });
  voicesFor(slot.provider).then((vs) => { for (const v of vs.slice(0, 400)) dl.append(h('option', { value: v.name || v.id }, [v.language, v.gender].filter(Boolean).join(' '))); });
  const fxSel = h('select', { onchange: set('fx'), 'aria-label': 'Effect' }, h('option', { value: '' }, 'No effect'), state.fx.filter((p) => p.name !== 'none').map((p) => h('option', { value: p.name, selected: p.name === slot.fx, title: p.description }, p.label)));
  return [
    h('div', { class: 'row' }, h('strong', { class: 'grow' }, `Variant ${state.slots.indexOf(slot) + 1}`),
      h('button', { class: 'link', onclick: () => { state.slots.splice(state.slots.indexOf(slot), 0, newSlot({ ...slot, clip: null, audio: '', status: '' })); render(); }, title: 'Duplicate these settings' }, 'Duplicate'),
      state.slots.length > 1 ? h('button', { class: 'link danger', onclick: () => { state.slots = state.slots.filter((s) => s !== slot); render(); } }, 'Remove') : null),
    h('div', { class: 'grid' },
      h('label', { class: 'field' }, 'Provider', providerSel),
      state.mode === 'single' ? h('label', { class: 'field' }, 'Voice', voiceInput, dl) : h('p', { class: 'muted small' }, 'Voices come from the script cast above.'),
      info.models && info.models.length > 1 ? h('label', { class: 'field' }, 'Model', h('select', { onchange: set('model'), 'aria-label': 'Model' }, h('option', { value: '' }, 'Default'), info.models.map((m) => h('option', { value: m, selected: m === slot.model }, m)))) : null,
      info.capabilities.tone ? h('label', { class: 'field' }, 'Tone / delivery', h('input', { value: slot.tone, placeholder: 'weathered, slow, a little tired', oninput: set('tone') })) : null,
      state.fx.length ? h('label', { class: 'field' }, 'Effect', fxSel) : null,
      h('button', { class: 'primary', onclick: () => generate(slot, card), disabled: slot.status === 'Generating...' }, slot.clip ? 'Generate again' : 'Generate'),
      slot.status ? h('p', { class: 'small muted' }, slot.status) : null,
      slot.audio ? h('audio', { controls: true, src: slot.audio }) : null,
      slot.clip ? h('div', { class: 'row' },
        h('button', { onclick: async () => { try { await client.request('PATCH', `/clips/${slot.clip.id}`, { body: { favorite: true, tags: ['lab'] } }); toast('Saved to favorites', 'info'); } catch (e) { toast(e.message, 'error'); } } }, 'Keep'),
        h('span', { class: 'small muted mono' }, slot.clip.id.slice(0, 10))) : null)];
}

function variantsCard() {
  const cards = state.slots.map((slot) => { const c = h('div', { class: 'card variant' }); paint(slot, c); return { slot, c }; });
  return h('section', { class: 'card' },
    h('div', { class: 'row' }, h('h2', { class: 'grow' }, 'Compare voices'),
      state.slots.length < MAX_SLOTS ? h('button', { onclick: () => { state.slots.push(newSlot()); render(); } }, 'Add a variant') : null,
      h('button', { class: 'primary', onclick: () => Promise.all(cards.map(({ slot, c }) => generate(slot, c))) }, 'Generate all')),
    h('div', { class: 'slot-grid', style: 'margin-top:12px' }, cards.map((x) => x.c)));
}

// ---------- personas ----------
const persona = { name: '', provider: '', voice: '', model: '', sampleArtist: 'Boards of Canada', sampleTitle: 'Roygbiv', edit: null, audio: new Map() };

function personaCard() {
  const card = h('section', { class: 'card' });
  const paintPersona = () => {
    const found = state.personas.find((p) => p.name === persona.name);
    if (!found) {
      clear(card, h('h2', {}, 'Host personas'), state.personas.length
        ? h('div', { class: 'row' }, h('label', { class: 'field grow' }, 'Choose a persona', h('select', { onchange: (e) => { persona.name = e.target.value; persona.edit = null; paintPersona(); } }, h('option', { value: '' }, 'Select...'), state.personas.map((p) => h('option', { value: p.name }, p.label)))))
        : h('p', { class: 'empty' }, 'This server has no personas.'));
      return;
    }
    persona.edit ||= { tone: found.tone, fx: found.fx, persona: found.persona, templates: found.templates.join('\n') };
    const e = persona.edit;
    const info = providerInfo(persona.provider);
    const field = (key, multi, label, rows = 3) => h('label', { class: 'field' }, label, multi
      ? Object.assign(h('textarea', { rows, oninput: (ev) => { e[key] = ev.target.value; } }), { value: e[key] })
      : h('input', { value: e[key], oninput: (ev) => { e[key] = ev.target.value; } }));
    const speak = async (button, text, key) => {
      button.disabled = true;
      try {
        const out = await client.post('/synth', { text, provider: persona.provider || undefined, voice: persona.voice || undefined, model: persona.model || undefined, tone: info.capabilities.tone ? e.tone || undefined : undefined, fx: e.fx || undefined, format: 'MP3' });
        persona.audio.set(key, await audioUrl(client, `/clips/${encodeURIComponent(out.clip.id)}/audio`));
        paintPersona();
        const audio = card.querySelector(`audio[data-key="${CSS.escape(key)}"]`);
        if (audio) audio.play().catch(() => {});
      } catch (err) { toast(err.message, 'error'); button.disabled = false; }
    };
    const fillSample = (t) => t.replace(/\{artist\}/g, persona.sampleArtist).replace(/\{title\}/g, persona.sampleTitle);
    const lineRow = (text, key) => {
      const btn = h('button', { onclick: (ev) => speak(ev.target, fillSample(text), key) }, 'Hear it');
      return h('div', { class: 'line' }, h('div', {}, h('div', { class: 'text' }, fillSample(text)), persona.audio.has(key) ? h('audio', { controls: true, 'data-key': key, src: persona.audio.get(key), style: 'width:100%;margin-top:6px' }) : null), btn);
    };
    const templates = e.templates.split('\n').map((s) => s.trim()).filter(Boolean);
    clear(card,
      h('div', { class: 'row' }, h('h2', { class: 'grow' }, `Persona: ${found.label}`), h('button', { class: 'link', onclick: () => { persona.name = ''; persona.edit = null; paintPersona(); } }, 'Change')),
      h('p', { class: 'muted' }, found.description),
      h('div', { class: 'grid', style: 'grid-template-columns:repeat(auto-fit,minmax(200px,1fr))' },
        h('label', { class: 'field' }, 'Provider', h('select', { onchange: (ev) => { persona.provider = ev.target.value; persona.model = ''; paintPersona(); } }, state.providers.tts.names.map((n) => h('option', { value: n, selected: n === (persona.provider || state.providers.tts.names[0]) }, n)))),
        h('label', { class: 'field' }, 'Voice', h('input', { value: persona.voice, placeholder: 'e.g. CHIP', oninput: (ev) => { persona.voice = ev.target.value; } })),
        info.models && info.models.length > 1 ? h('label', { class: 'field' }, 'Model', h('select', { onchange: (ev) => { persona.model = ev.target.value; } }, h('option', { value: '' }, 'Default'), info.models.map((m) => h('option', { value: m, selected: m === persona.model }, m)))) : null,
        h('label', { class: 'field' }, 'Sample artist', h('input', { value: persona.sampleArtist, oninput: (ev) => { persona.sampleArtist = ev.target.value; } })),
        h('label', { class: 'field' }, 'Sample title', h('input', { value: persona.sampleTitle, oninput: (ev) => { persona.sampleTitle = ev.target.value; } }))),
      h('h3', {}, 'Edit and try'),
      h('div', { class: 'grid' },
        field('tone', false, 'Tone'),
        h('label', { class: 'field' }, 'Effect', h('select', { onchange: (ev) => { e.fx = ev.target.value; } }, h('option', { value: '' }, 'None'), state.fx.filter((p) => p.name !== 'none').map((p) => h('option', { value: p.name, selected: p.name === e.fx }, p.label)))),
        field('persona', true, 'Persona text (how the AI writes links)', 5),
        field('templates', true, 'Link templates, one per line ({artist} and {title} are filled in)', 6)),
      h('div', { class: 'row end', style: 'margin-top:8px' },
        h('button', { onclick: () => { persona.edit = null; persona.audio.clear(); paintPersona(); } }, 'Reset edits'),
        h('button', { class: 'primary', onclick: async (ev) => {
          ev.target.disabled = true;
          try {
            await client.put('/host', { preset: found.name, voice: persona.voice || undefined, provider: persona.provider || undefined, tone: e.tone, fx: e.fx, persona: e.persona, templates });
            toast('Applied to the station host. Turn the host on from the Control Panel or /host.', 'info');
          } catch (err) { toast(err.message, 'error'); } finally { ev.target.disabled = false; }
        } }, 'Apply to the station host')),
      h('h3', {}, 'Link templates'), h('div', { class: 'lines' }, templates.map((t, i) => lineRow(t, `t${i}`))),
      h('h3', {}, 'Station IDs'), h('div', { class: 'lines' }, found.stationIds.map((t, i) => lineRow(t, `s${i}`))),
      h('h3', {}, 'Time of day'), h('div', { class: 'lines' }, Object.entries(found.timeLines).map(([when, t]) => lineRow(t.trim(), `d${when}`))));
  };
  paintPersona();
  return card;
}

function render() {
  clear(app, h('div', { class: 'stack' },
    h('p', { class: 'muted' }, 'Write something, pick voices, and listen to them side by side. Nothing here goes on air; use Stations for that.'),
    scriptCard(), variantsCard(), personaCard()));
}

// Draws the Voice Lab into `root`. `voiceClient` talks to the voice server through this site's proxy.
export async function mountLab(root, voiceClient) {
  client = voiceClient;
  app = root;
  Object.assign(state, { providers: null, fx: [], personas: [], sfx: [], voices: new Map(), host: null, mode: 'single', slots: [] });
  Object.assign(persona, { name: '', provider: '', voice: '', model: '', edit: null });
  persona.audio.clear();
  clear(app, h('p', { class: 'muted' }, 'Loading the voice server...'));
  try {
    await load();
    state.slots = [newSlot(), newSlot()];
    render();
  } catch (err) {
    clear(app, h('p', { class: 'bad' }, err.message));
  }
}
