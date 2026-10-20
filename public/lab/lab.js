// Voice Lab: write something, pick voices, and listen to them side by side. Everything runs on this site's own tools:
// /api/generate for speech (any OpenRouter or Gemini voice), personas, the sound library, and in-browser effect previews.
// Nothing here goes on air; save a take to the library from its card.
import { h, clear, toast } from '../shared/kit.js';
import { createSpeaker, parseDialogue, speakersOf } from '../shared/speaker.js';
import { FX_PREVIEWS } from '../generate/fx.js';
import { effectNames } from '../generate/mixer.js';
import { createPlayer } from '../shared/playbutton.js';

const MAX_SLOTS = 4;
const PREF_KEY = 'djPrefs';

export async function mountLab(root, api) {
  clear(root, h('p', { class: 'muted' }, 'Loading...'));
  let options; let personas = [];
  try {
    [options, { personas }] = await Promise.all([api.get('/options'), api.get('/personas').catch(() => ({ personas: [] }))]);
  } catch (err) { clear(root, h('p', { class: 'bad' }, `Could not load: ${err.message}`)); return; }
  const speaker = createSpeaker(api, options.features);
  await speaker.loadLibrary();

  const choosable = options.models.choosable;
  const models = choosable ? options.models.speech : [];
  const state = {
    mode: 'single', gap: 0.3, brief: '', briefPersona: '',
    text: `Welcome back to ${options.station || 'the station'}. [sfx:chime] This is a quick test of how a voice sounds.`,
    cast: {},   // speaker name -> { persona, voice }
    slots: [],
  };
  const newSlot = (from = {}) => ({ id: Math.random().toString(36).slice(2), persona: '', speechModel: choosable ? options.models.defaultSpeech : '', voice: '', tone: '', fx: '', status: '', error: '', take: null, url: '', ...from });
  state.slots = [newSlot(), newSlot(choosable && models[1] ? { speechModel: models[1].id } : {})];

  const modelEntry = (id) => models.find((m) => m.id === id);
  const cuesFor = (slot) => (choosable ? (modelEntry(slot.speechModel) || {}).cues : options.models.fixedCues);

  const app = h('div', { class: 'stack' });

  // ---------- the script ----------
  function scriptCard() {
    const area = h('textarea', { rows: 6, 'aria-label': 'Script', oninput: (e) => { state.text = e.target.value; paintCast(); } });
    area.value = state.text;
    const insert = (tag) => {
      const at = area.selectionStart ?? area.value.length;
      area.setRangeText(`${at && !/\s$/.test(area.value.slice(0, at)) ? ' ' : ''}${tag} `, at, area.selectionEnd ?? at, 'end');
      state.text = area.value; area.focus(); paintCast();
    };
    const tray = h('div', { class: 'row', style: 'gap:6px' }, [
      ...speaker.soundNames().map((n) => h('button', { type: 'button', class: 'chip-btn', onclick: () => insert(`[sfx:${n}]`) }, n)),
      ...speaker.library.music.map((m) => h('button', { type: 'button', class: 'chip-btn', title: 'A music bed under the whole clip', onclick: () => insert(`[music:${m.name} vol=0.2]`) }, `♪ ${m.name}`)),
    ]);
    const brief = h('input', { placeholder: state.mode === 'dialogue' ? 'Ask the AI for a conversation: "two hosts argue about pineapple on pizza"' : 'Or ask the AI: "last call, the bar closes in ten minutes"', 'aria-label': 'AI brief', oninput: (e) => { state.brief = e.target.value; } });
    brief.value = state.brief;
    const persona = h('select', { 'aria-label': 'Persona for the AI', onchange: (e) => { state.briefPersona = e.target.value; } }, h('option', { value: '' }, 'No persona'), personas.map((p) => h('option', { value: p.id, selected: p.id === state.briefPersona }, `${p.emoji || ''} ${p.name}`.trim())));
    const draft = h('button', { type: 'button', onclick: async () => {
      if (!state.brief.trim()) return;
      draft.disabled = true;
      try {
        const names = state.mode === 'dialogue' ? speakersOf(state.text).slice(0, 3) : [];
        const prompt = state.mode === 'dialogue' ? `Write a short back-and-forth between ${names.length ? names.join(' and ') : 'two radio hosts'}, one "Name: line" per line, 4 to 8 lines. Topic: ${state.brief}` : state.brief;
        const out = await api.post('/generate', { mode: 'ai', prompt, textOnly: true, ...(state.briefPersona && state.mode === 'single' ? { persona: state.briefPersona } : {}) });
        state.text = out.scriptText; area.value = out.scriptText; paintCast();
      } catch (err) { toast(err.message, 'error'); } finally { draft.disabled = false; }
    } }, 'Draft with AI');
    const mode = h('select', { 'aria-label': 'Mode', onchange: (e) => { state.mode = e.target.value; paintAll(); } },
      h('option', { value: 'single', selected: state.mode === 'single' }, 'One voice'), h('option', { value: 'dialogue', selected: state.mode === 'dialogue' }, 'Conversation ("Name: line" per line)'));
    return h('section', { class: 'card' }, h('h2', {}, 'Script'),
      h('div', { class: 'grid cols' }, h('label', { class: 'field' }, 'Mode', mode),
        state.mode === 'dialogue' ? h('label', { class: 'field' }, 'Pause between lines (seconds)', h('input', { type: 'number', min: 0, max: 3, step: 0.1, value: state.gap, oninput: (e) => { state.gap = Number(e.target.value) || 0; } })) : null),
      area, castBox,
      h('details', { class: 'tips' }, h('summary', {}, 'Insert a sound effect or music bed'), tray),
      h('div', { class: 'grid cols' }, brief, state.mode === 'single' ? persona : null, draft));
  }

  // ---------- who says what (conversation mode) ----------
  const castBox = h('div', { class: 'stack' });
  function paintCast() {
    clear(castBox);
    if (state.mode !== 'dialogue') return;
    const names = speakersOf(state.text);
    if (!names.length) { castBox.append(h('p', { class: 'muted small' }, 'Write lines like "Rocky: Hello there." to cast voices.')); return; }
    castBox.append(h('p', { class: 'muted small' }, 'Cast each speaker with a persona (their voice, tone and model) and/or a voice name. Anyone left blank uses the variant\'s own settings.'));
    for (const name of names) {
      const c = (state.cast[name] ||= { persona: (personas.find((p) => p.name.toLowerCase().startsWith(name.toLowerCase())) || {}).id || '', voice: '' });
      castBox.append(h('div', { class: 'grid cols' },
        h('strong', {}, name),
        h('select', { 'aria-label': `Persona for ${name}`, onchange: (e) => { c.persona = e.target.value; } }, h('option', { value: '' }, 'Use the variant\'s voice'), personas.map((p) => h('option', { value: p.id, selected: p.id === c.persona }, `${p.emoji || ''} ${p.name}`.trim()))),
        h('input', { value: c.voice, placeholder: 'voice name (optional)', 'aria-label': `Voice for ${name}`, oninput: (e) => { c.voice = e.target.value; } })));
    }
  }

  // ---------- variants ----------
  async function generate(slot, card) {
    slot.status = 'Generating...'; slot.error = ''; paintSlot(slot, card);
    const t0 = performance.now();
    try {
      const base = { ...(slot.persona ? { persona: slot.persona } : {}), ...(slot.speechModel && choosable ? { speechModel: slot.speechModel } : {}), ...(slot.voice ? { voice: slot.voice } : {}), ...(slot.tone ? { tone: slot.tone } : {}) };
      const opts = { fx: slot.fx, onProgress: (m) => { slot.status = m; paintSlot(slot, card); } };
      slot.take = state.mode === 'dialogue'
        ? await speaker.renderDialogue(parseDialogue(state.text).map((l) => {
          const c = state.cast[l.speaker] || {};
          return { ...l, base: { ...base, ...(c.persona ? { persona: c.persona } : {}), ...(c.voice ? { voice: c.voice } : {}) } };
        }), { gap: state.gap, ...opts })
        : await speaker.render(state.text, base, opts);
      if (slot.player) slot.player.invalidate();
      slot.url = URL.createObjectURL(slot.take.blob);
      slot.player = createPlayer({ label: 'Play this take', load: async () => slot.url });
      slot.status = `Done in ${((performance.now() - t0) / 1000).toFixed(1)}s${slot.take.first.cueTagsRemoved ? ' · tags removed (this model does not perform them)' : ''}${slot.take.first.toneIgnored ? ' · tone ignored by this model' : ''}`;
    } catch (err) { slot.status = ''; slot.error = err.message; }
    paintSlot(slot, card);
  }

  function slotBody(slot, card) {
    const entry = modelEntry(slot.speechModel);
    const cues = cuesFor(slot);
    const voices = [...new Set([entry && entry.voice, ...((entry && entry.voices) || [])].filter(Boolean))];
    const set = (k) => (e) => { slot[k] = e.target.value; };
    const voiceList = h('datalist', { id: `v-${slot.id}` }, voices.slice(0, 300).map((v) => h('option', { value: v })));
    const index = state.slots.indexOf(slot) + 1;
    return [
      h('div', { class: 'row' }, h('strong', { class: 'grow' }, `Variant ${index}`),
        h('button', { class: 'link', onclick: () => { state.slots.splice(index, 0, newSlot({ ...slot, take: null, url: '', status: '', error: '' })); paintAll(); } }, 'Duplicate'),
        state.slots.length > 1 ? h('button', { class: 'link danger', onclick: () => { state.slots = state.slots.filter((x) => x !== slot); paintAll(); } }, 'Remove') : null),
      h('div', { class: 'grid' },
        h('label', { class: 'field' }, 'Persona (voice, tone, model defaults)', h('select', { onchange: set('persona') }, h('option', { value: '' }, 'None'), personas.map((p) => h('option', { value: p.id, selected: p.id === slot.persona }, `${p.emoji || ''} ${p.name}`.trim())))),
        choosable ? h('label', { class: 'field' }, 'Speech model', h('select', { onchange: (e) => { slot.speechModel = e.target.value; paintSlot(slot, card); } }, models.map((m) => h('option', { value: m.id, selected: m.id === slot.speechModel }, m.id)))) : h('p', { class: 'muted small' }, 'Using Gemini directly, so the model is fixed.'),
        h('label', { class: 'field' }, 'Voice', h('input', { value: slot.voice, list: `v-${slot.id}`, placeholder: (entry && entry.voice) || 'default voice', oninput: set('voice'), 'aria-label': 'Voice' }), voiceList),
        h('label', { class: 'field' }, 'Tone / delivery', h('input', { value: slot.tone, placeholder: cues && cues.tone === 'none' ? 'this model ignores tone' : 'weathered, slow, a little tired', oninput: set('tone') })),
        h('label', { class: 'field' }, 'Effect (preview in the browser)', h('select', { onchange: set('fx') }, h('option', { value: '' }, 'No effect'), Object.entries(FX_PREVIEWS).map(([k, f]) => h('option', { value: k, selected: k === slot.fx }, f.label)))),
        cues ? h('p', { class: 'small muted' }, `Tone: ${cues.tone === 'none' ? 'ignored' : 'yes'} · tags like [laughs]: ${cues.tags === true ? 'performed' : cues.tags === false ? 'removed' : 'untested'}`) : null,
        h('button', { class: 'primary', onclick: () => generate(slot, card), disabled: slot.status !== '' && !slot.status.startsWith('Done') }, slot.take ? 'Generate again' : 'Generate'),
        slot.status ? h('p', { class: 'small muted' }, slot.status) : null,
        slot.error ? h('p', { class: 'small bad' }, slot.error) : null,
        slot.take ? h('div', { class: 'row' }, slot.player.button,
          h('button', { onclick: () => useInGenerate(slot) }, 'Use in Generate'),
          h('button', { onclick: (e) => saveTake(slot, e.currentTarget) }, 'Save to library')) : null)];
  }
  const paintSlot = (slot, card) => clear(card, ...slotBody(slot, card));

  // The settings that worked, handed to the Generate tab through its saved preferences.
  function useInGenerate(slot) {
    try {
      const prefs = JSON.parse(localStorage.getItem(PREF_KEY) || '{}');
      Object.assign(prefs, { persona: slot.persona, ...(slot.speechModel ? { speechModel: slot.speechModel } : {}), voice: slot.voice, tone: slot.tone });
      localStorage.setItem(PREF_KEY, JSON.stringify(prefs));
      toast('The Generate tab will start with these settings.', 'info');
    } catch { toast('Could not save the settings in this browser.', 'error'); }
  }
  async function saveTake(slot, button) {
    button.disabled = true;
    try {
      const f = slot.take.first;
      const meta = { mode: 'say', input: 'voice lab', scriptText: slot.take.scriptText.slice(0, 2000), voice: f.voice, provider: f.provider, speechModel: f.speechModel, tone: slot.tone || undefined, effects: slot.take.effects, handoff: false, info: { source: 'lab', kind: 'sample', tags: ['lab'], ...(slot.persona ? { persona: slot.persona } : {}) } };
      await api.request('POST', '/clips', { raw: slot.take.blob, contentType: slot.take.blob.type, headers: { 'x-clip-meta': encodeURIComponent(JSON.stringify(meta)) } });
      toast('Saved to the library.', 'info');
    } catch (err) { toast(err.message, 'error'); } finally { button.disabled = false; }
  }

  function variantsCard() {
    const cards = state.slots.map((slot) => { const c = h('div', { class: 'card variant' }); paintSlot(slot, c); return { slot, c }; });
    return h('section', { class: 'card' },
      h('div', { class: 'row' }, h('h2', { class: 'grow' }, 'Compare voices'),
        state.slots.length < MAX_SLOTS ? h('button', { onclick: () => { state.slots.push(newSlot()); paintAll(); } }, 'Add a variant') : null,
        h('button', { class: 'primary', onclick: () => Promise.all(cards.map(({ slot, c }) => generate(slot, c))) }, 'Generate all')),
      h('div', { class: 'slot-grid', style: 'margin-top:12px' }, cards.map((x) => x.c)));
  }

  function paintAll() {
    clear(app, h('p', { class: 'muted' }, `Write something, pick voices, and listen to them side by side. Nothing here goes on air. ${effectNames().length} built-in effects${speaker.library.sfx.length ? ` and ${speaker.library.sfx.length} from your library` : ''} work as [sfx:name].`),
      scriptCard(), variantsCard());
    paintCast();
  }
  clear(root, app);
  paintAll();
}
