// Studio: the one place to write a script (one voice, or a conversation of up to four speakers), cast it with personas, have the AI draft it,
// hear it in several voices side by side, save it, and schedule it. It replaces the separate Generate and Voice Lab tabs.
// Nothing here goes on air by itself: a take can be saved to the library, scheduled, or sent to the station from its card.
import { h, clear, toast } from '../shared/kit.js';
import { createSpeaker, parseDialogue } from '../shared/speaker.js';
import { FX_PREVIEWS } from '../generate/fx.js';
import { effectNames } from '../generate/mixer.js';
import { createPlayer } from '../shared/playbutton.js';
import { downloadMenu } from '../shared/download.js';
import { createStatus } from '../shared/status.js';
import { amountSlider } from '../shared/amount.js';
import { costGuard } from '../shared/estimate.js';
import { allStations, stationId, stationName } from '../shared/station.js';
import { castEditor } from '../shared/casteditor.js';
import { lineEditor } from '../shared/lineeditor.js';
import { audioSlots, readAudioTags, writeAudioTags } from '../shared/audioslots.js';

const MAX_SLOTS = 4;
const MAX_CAST = 4;

// A line sent here from another tab (a persona's sample), used once.
function takePrefill() { try { const t = sessionStorage.getItem('prefillText') || ''; sessionStorage.removeItem('prefillText'); return t; } catch { return ''; } }
// A persona chosen in the Personas tab ("Use in the Studio"), used once.
function takePersona() { try { const t = sessionStorage.getItem('studioPersona') || ''; sessionStorage.removeItem('studioPersona'); return t; } catch { return ''; } }
// Hands something to the Schedules tab, which prefills its form from it.
function toSchedules(draft) {
  try { sessionStorage.setItem('scheduleDraft', JSON.stringify({ from: 'the Studio', ...draft })); } catch { toast('Could not hand it to the Schedules tab in this browser.', 'error'); return; }
  window.dispatchEvent(new CustomEvent('vh-tab', { detail: 'schedules' }));
}

export async function mountStudio(root, api) {
  clear(root, h('p', { class: 'muted' }, 'Loading...'));
  let options; let personas = []; let scripts = [];
  try {
    [options, { personas }, { scripts }] = await Promise.all([
      api.get('/options', { query: { station: stationId() } }),
      api.get('/personas').catch(() => ({ personas: [] })),
      api.get('/scripts').catch(() => ({ scripts: [] })),
    ]);
  } catch (err) { clear(root, h('p', { class: 'bad' }, `Could not load: ${err.message}`)); return; }
  const speaker = createSpeaker(api, options.features);
  await speaker.loadLibrary();
  const guard = costGuard(api);

  const choosable = options.models.choosable;
  const models = choosable ? options.models.speech : [];
  const state = {
    id: '', name: '', mode: 'single', cast: [{ name: 'Host' }], topic: '', format: '', seconds: 0, explicit: false, sfx: false, gap: 0.3, notes: '',
    text: takePrefill() || `Welcome back to ${stationName(options.station) || 'the station'}. [sfx:chime] This is a quick test of how a voice sounds.`,
    slots: [],
  };
  const newSlot = (from = {}) => ({ speechModel: choosable ? options.models.defaultSpeech : '', voice: '', tone: '', fx: '', fxAmount: 1, take: null, url: '', ...from, id: Math.random().toString(36).slice(2), busy: false, st: createStatus() });
  state.slots = [newSlot()];
  const handedPersona = personas.find((p) => p.id === takePersona());
  if (handedPersona) state.cast = [{ name: 'Host', personaId: handedPersona.id }];
  const modelEntry = (id) => models.find((m) => m.id === id);
  const castOf = (name) => state.cast.find((c) => c.name.toLowerCase() === String(name).toLowerCase());
  const kind = () => (state.mode === 'conversation' ? 'conversation' : 'single');
  const app = h('div', { class: 'stack' });
  const warnings = h('div', { class: 'stack' });
  const stationWarnings = () => { const s = allStations().find((x) => x.id === stationId()); return ((s && s.warnings) || []).filter((w) => w.code === 'weather-location-missing'); };

  // ---------- saved scripts ----------
  const saveStatus = createStatus();
  async function refreshScripts() { try { scripts = (await api.get('/scripts')).scripts; } catch { /* keep the list we have */ } }
  const scriptBody = () => ({ name: state.name.trim(), kind: kind(), cast: state.cast, topic: state.topic, format: state.format || undefined, seconds: state.seconds || undefined, text: state.text, gapSeconds: state.gap, notes: state.notes, ...(stationId() ? { stationId: stationId() } : {}) });
  async function saveScript(asNew = false) {
    if (!state.name.trim()) { saveStatus.fail('Give the script a name first.'); return null; }
    saveStatus.busy('Saving the script');
    try {
      const { script } = state.id && !asNew ? await api.put(`/scripts/${encodeURIComponent(state.id)}`, scriptBody()) : await api.post('/scripts', scriptBody());
      state.id = script.id; await refreshScripts(); saveStatus.ok(`Saved "${script.name}". It can now be scheduled or used in a dynamic slot.`); paintAll(); return script;
    } catch (err) { saveStatus.fail(err.message); return null; }
  }
  function loadScript(s) {
    Object.assign(state, { id: s.id, name: s.name, mode: s.kind, cast: s.cast.length ? s.cast.map((c) => ({ ...c })) : [{ name: 'Host' }], topic: s.topic || '', format: s.format || '', seconds: s.seconds || 0, gap: s.gapSeconds ?? 0.3, text: s.text, notes: s.notes || '' });
    paintAll(); saveStatus.info(`Loaded "${s.name}".`);
  }
  function scriptBar() {
    const select = h('select', { 'aria-label': 'Saved scripts', onchange: (e) => { const s = scripts.find((x) => x.id === e.target.value); if (s) loadScript(s); else { Object.assign(state, { id: '', name: '', cast: state.mode === 'conversation' ? [{ name: 'Host' }, { name: 'Guest' }] : [{ name: 'Host' }], topic: '', text: '' }); paintAll(); } } },
      h('option', { value: '' }, scripts.length ? 'New script' : 'No saved scripts yet'), scripts.map((s) => h('option', { value: s.id, selected: s.id === state.id }, `${s.name}${s.kind === 'conversation' ? ` (${s.cast.length} speakers)` : ''}`)));
    return h('div', { class: 'stack' },
      h('div', { class: 'grid cols' }, h('label', { class: 'field' }, 'Saved scripts', select),
        h('label', { class: 'field' }, 'Name', h('input', { value: state.name, placeholder: 'e.g. Morning banter', oninput: (e) => { state.name = e.target.value; } }))),
      h('div', { class: 'row' },
        h('button', { type: 'button', class: 'primary', onclick: () => saveScript(false) }, state.id ? 'Save changes' : 'Save script'),
        state.id ? h('button', { type: 'button', onclick: () => saveScript(true) }, 'Save as a new script') : null,
        state.id ? h('button', { type: 'button', class: 'link danger', onclick: async () => { if (!confirm(`Delete "${state.name}"? Schedules that use it will stop working.`)) return; try { await api.del(`/scripts/${encodeURIComponent(state.id)}`); state.id = ''; await refreshScripts(); paintAll(); toast('Deleted.', 'info'); } catch (err) { toast(err.message, 'error'); } } }, 'Delete') : null,
        h('button', { type: 'button', onclick: async () => { const s = state.id ? { id: state.id } : await saveScript(false); if (s) toSchedules({ scriptId: s.id, name: state.name }); } }, 'Schedule this script'),
        state.id ? h('span', { class: 'small muted', title: 'Use this id for a dynamic slot on the hub' }, `id: ${state.id}`) : null),
      saveStatus.el);
  }

  // ---------- the script ----------
  let castEd; let lineEd; let plainArea;
  function insertToken(token) {
    const a = document.activeElement;
    if (!a || a.tagName !== 'TEXTAREA' || !app.contains(a)) { toast('Click in the script where it should go, then press the button.', 'info'); return; }
    a.setRangeText(token, a.selectionStart, a.selectionEnd, 'end'); a.dispatchEvent(new Event('input', { bubbles: true }));
  }
  function helpers() {
    const chips = [['{{time}}', 'time'], ['{{greeting}}', 'greeting'], ['{{weather}}', 'weather'], ['{{temp}}', 'temperature'], ['{{conditions}}', 'sky'], ['{{city}}', 'city'], ['{{station}}', 'station'], ['{{weekday}}', 'weekday']];
    const preview = h('p', { class: 'small muted' });
    const wx = stationWarnings();
    return h('details', { class: 'tips' }, h('summary', {}, 'Placeholders and sounds (time, weather, station, effects)'),
      h('div', { class: 'stack' },
        h('p', { class: 'small muted' }, 'Filled in with real values each time the script is spoken or scheduled, so it is right whenever it airs. Click in the script, then press one.'),
        h('div', { class: 'row', style: 'gap:6px' }, chips.map(([t, label]) => h('button', { type: 'button', class: 'chip-btn', title: t, onclick: () => insertToken(t) }, label))),
        wx.length ? h('p', { class: 'small bad' }, `${wx[0].message} Set the city in the Stations tab.`) : null,
        h('div', { class: 'row', style: 'gap:6px' }, [...speaker.soundNames().map((n) => h('button', { type: 'button', class: 'chip-btn', onclick: () => insertToken(`[sfx:${n}]`) }, n)), ...speaker.library.music.map((m) => h('button', { type: 'button', class: 'chip-btn', onclick: () => insertToken(`[music:${m.name} vol=0.2]`) }, `♪ ${m.name}`))]),
        h('button', { type: 'button', onclick: async () => { try { const r = await api.post('/template', { text: state.text, station: stationId() || undefined }); clear(preview, `Right now: "${r.text}"${r.missing.length ? ` (no value for: ${r.missing.join(', ')})` : ''}`); } catch (err) { clear(preview, err.message); } } }, "Preview with today's values"), preview));
  }
  // A background, intro and outro from the sound library (or your own upload). They are kept in the script as [music:], [intro:] and [outro:] tags.
  function audioCard() {
    const chosen = readAudioTags(state.text);
    const slots = audioSlots({ api, value: chosen, note: 'Mixed in when you generate. Pick none to take them out.', onchange: async (a) => {
      await speaker.loadLibrary();
      state.text = writeAudioTags(state.text, a, { conversation: state.mode === 'conversation' });
      paintAll();
    } });
    return h('details', { class: 'tips', open: Object.keys(chosen).length > 0 }, h('summary', {}, 'Background, intro and outro (upload your own)'), slots.el);
  }
  function scriptCard() {
    castEd = castEditor({ personas, cast: state.cast, kind: kind(), max: MAX_CAST, onchange: (c) => { state.cast = c; if (lineEd) lineEd.setCast(c); } });
    const draftStatus = createStatus();
    const topic = h('input', { value: state.topic, placeholder: state.mode === 'conversation' ? 'What is it about? e.g. two hosts argue about pineapple on pizza' : 'What should it say? e.g. last call, the bar closes in ten minutes', 'aria-label': 'Topic', oninput: (e) => { state.topic = e.target.value; } });
    const draft = h('button', { type: 'button', onclick: async () => {
      const problems = castEd.problems();
      if (problems.length) { draftStatus.fail(problems[0]); return; }
      if (!state.topic.trim()) { draftStatus.fail('Say what it is about first.'); return; }
      if (!(await guard.confirmSpend([{ kind: 'write', prompt: state.topic, ...(state.cast[0] && state.cast[0].personaId ? { persona: state.cast[0].personaId } : {}), ...(stationId() ? { station: stationId() } : {}) }], 'Draft with AI'))) return;
      draft.disabled = true; draftStatus.busy('Writing the script in each speaker\'s voice');
      try {
        const out = await api.post('/scripts/draft', { kind: kind(), cast: state.cast, topic: state.topic, format: state.format || undefined, seconds: state.seconds || undefined, explicit: state.explicit || undefined, sfx: state.sfx || undefined, ...(stationId() ? { station: stationId() } : {}) });
        state.text = out.raw || out.text; paintAll();
        const note = [out.copiedExample ? `${out.copiedExample.join(', ')} repeated an example line: draft again or edit it.` : '', out.droppedLines ? `${out.droppedLines} line(s) from outside the cast were dropped.` : ''].filter(Boolean).join(' ');
        if (note) toast(note, 'info');
      } catch (err) { draftStatus.fail(err.message, err.reply); } finally { draft.disabled = false; }
    } }, 'Draft with AI');
    const mode = (m, label) => h('button', { type: 'button', class: state.mode === m ? 'seg on' : 'seg', onclick: () => {
      if (state.mode === m) return;
      state.mode = m;
      if (m === 'conversation' && state.cast.length < 2) state.cast = [...state.cast, ...(state.cast.length ? [] : [{ name: 'Host' }]), { name: state.cast.some((c) => c.name === 'Guest') ? 'Guest 2' : 'Guest' }].slice(0, MAX_CAST);
      if (m === 'single') state.cast = state.cast.slice(0, 1);
      paintAll();
    } }, label);
    const body = h('div', { class: 'stack' });
    if (state.mode === 'conversation') {
      lineEd = lineEditor({ cast: state.cast, text: state.text, maxLines: 40, onchange: (t) => { state.text = t; } });
      body.append(lineEd.el);
    } else {
      lineEd = null;
      plainArea = h('textarea', { rows: 6, 'aria-label': 'Script', oninput: (e) => { state.text = e.target.value; } }); plainArea.value = state.text;
      body.append(plainArea);
    }
    return h('section', { class: 'card' }, h('h2', {}, 'Script'), scriptBar(),
      h('div', { class: 'row', style: 'flex-wrap:wrap' }, mode('single', 'One voice'), mode('conversation', 'Conversation'), h('span', { class: 'small muted' }, state.mode === 'conversation' ? 'up to 4 speakers' : '')),
      state.mode === 'conversation' ? h('label', { class: 'row small' }, 'Pause between lines', h('input', { type: 'number', min: 0, max: 3, step: 0.1, value: state.gap, style: 'width:5em', oninput: (e) => { state.gap = Number(e.target.value) || 0; } }), 'seconds') : null,
      h('h3', {}, state.mode === 'conversation' ? 'Who is talking' : 'Who is speaking'), castEd.el,
      h('div', { class: 'grid cols' }, h('label', { class: 'field' }, 'Topic for the AI', topic),
        h('label', { class: 'field' }, 'Kind of script', h('select', { onchange: (e) => { state.format = e.target.value; } }, h('option', { value: '' }, 'Free-form'), (options.formats || []).map((f) => h('option', { value: f.id, selected: f.id === state.format }, f.label)))),
        h('label', { class: 'field' }, 'Length', h('select', { onchange: (e) => { state.seconds = Number(e.target.value); } }, [[0, 'Any (short)'], [10, 'About 10 seconds'], [20, 'About 20 seconds'], [30, 'About 30 seconds'], [60, 'About a minute']].map(([v, t]) => h('option', { value: v, selected: v === state.seconds }, t))))),
      h('div', { class: 'row' }, draft, h('label', { class: 'row small' }, h('input', { type: 'checkbox', checked: state.explicit, onchange: (e) => { state.explicit = e.target.checked; } }), 'Allow strong language'), h('label', { class: 'row small', title: 'The AI may place [sfx:name] tags such as a phone ring or a chime; they are mixed in when the voice returns WAV' }, h('input', { type: 'checkbox', checked: state.sfx, onchange: (e) => { state.sfx = e.target.checked; } }), 'AI may add sound effects'), draftStatus.el),
      h('h3', {}, 'The script'), body, helpers(), audioCard());
  }

  // ---------- compare voices ----------
  function linesFor(slot) {
    const base = { ...(slot.speechModel && choosable ? { speechModel: slot.speechModel } : {}), ...(slot.voice ? { voice: slot.voice } : {}), ...(slot.tone ? { tone: slot.tone } : {}) };
    if (state.mode !== 'conversation') { const c = state.cast[0] || {}; return { base: { ...base, ...(c.personaId ? { persona: c.personaId } : {}), ...(c.voice ? { voice: c.voice } : {}) } }; }
    return { lines: parseDialogue(state.text).map((l) => { const c = castOf(l.speaker) || {}; return { ...l, base: { ...base, ...(c.personaId ? { persona: c.personaId } : {}), ...(c.voice ? { voice: c.voice } : {}) } }; }) };
  }
  async function generate(slot, card, confirmed = false) {
    if (!state.text.trim()) { slot.st.fail('Write something first.'); paintSlot(slot, card); return; }
    if (!confirmed && !(await guard.confirmSpend([{ kind: 'speak', text: state.text, ...(slot.speechModel && choosable ? { speechModel: slot.speechModel } : {}), ...(stationId() ? { station: stationId() } : {}) }], 'Generate'))) return;
    slot.busy = true; slot.st.busy('Generating'); paintSlot(slot, card);
    try {
      const opts = { fx: slot.fx, fxAmount: slot.fxAmount, onProgress: (m, p) => slot.st.busy(m, p) };
      const plan = linesFor(slot);
      slot.take = plan.lines ? await speaker.renderDialogue(plan.lines, { gap: state.gap, ...opts }) : await speaker.render(state.text, plan.base, opts);
      if (slot.player) slot.player.invalidate();
      slot.url = URL.createObjectURL(slot.take.blob);
      slot.player = createPlayer({ label: 'Play this take', load: async () => slot.url });
      slot.st.ok(`Done${slot.take.first.cueTagsRemoved ? ' · tags removed (this model does not perform them)' : ''}${slot.take.first.toneIgnored ? ' · tone ignored by this model' : ''}`);
    } catch (err) { slot.st.fail(err.message); }
    slot.busy = false; paintSlot(slot, card);
  }

  // Saves the take as a clip (library, station hand-off if the site is set up for it) and returns its id.
  async function saveTake(slot, button, then) {
    button.disabled = true;
    try {
      const f = slot.take.first;
      const meta = { mode: 'say', input: state.name || 'studio', scriptText: slot.take.scriptText.slice(0, 2000), voice: f.voice, provider: f.provider, speechModel: f.speechModel, tone: slot.tone || undefined, effects: slot.take.effects, handoff: false,
        info: { source: 'studio', kind: state.mode === 'conversation' ? 'conversation' : 'drop', tags: ['studio'], ...(stationId() ? { station: stationId() } : {}), ...(state.name ? { title: state.name.slice(0, 60) } : {}) } };
      const saved = await api.request('POST', '/clips', { raw: slot.take.blob, contentType: slot.take.blob.type, headers: { 'x-clip-meta': encodeURIComponent(JSON.stringify(meta)) } });
      toast('Saved to the library.', 'info');
      if (then) then(saved);
    } catch (err) { toast(err.message, 'error'); } finally { button.disabled = false; }
  }

  function slotBody(slot, card) {
    const entry = modelEntry(slot.speechModel);
    const voices = [...new Set([entry && entry.voice, ...((entry && entry.voices) || [])].filter(Boolean))];
    const set = (k) => (e) => { slot[k] = e.target.value; };
    const index = state.slots.indexOf(slot) + 1;
    return [
      h('div', { class: 'row' }, h('strong', { class: 'grow' }, `Voice ${index}`),
        h('button', { class: 'link', onclick: () => { if (state.slots.length < MAX_SLOTS) { state.slots.splice(index, 0, newSlot({ ...slot, take: null, url: '' })); paintAll(); } } }, 'Duplicate'),
        state.slots.length > 1 ? h('button', { class: 'link danger', onclick: () => { state.slots = state.slots.filter((x) => x !== slot); paintAll(); } }, 'Remove') : null),
      h('div', { class: 'grid' },
        choosable ? h('label', { class: 'field' }, 'Speech model', h('select', { onchange: (e) => { slot.speechModel = e.target.value; paintSlot(slot, card); } }, models.map((m) => h('option', { value: m.id, selected: m.id === slot.speechModel }, m.id)))) : h('p', { class: 'muted small' }, 'Using Gemini directly, so the model is fixed.'),
        state.mode === 'single' ? h('label', { class: 'field' }, 'Voice (overrides the persona)', h('input', { value: slot.voice, list: `v-${slot.id}`, placeholder: (entry && entry.voice) || 'persona or model default', oninput: set('voice') }), h('datalist', { id: `v-${slot.id}` }, voices.slice(0, 300).map((v) => h('option', { value: v })))) : h('p', { class: 'small muted' }, 'Each speaker keeps their own persona voice; this model is used for any speaker without one.'),
        h('label', { class: 'field' }, 'Tone / delivery', h('input', { value: slot.tone, placeholder: 'weathered, slow, a little tired', oninput: set('tone') })),
        h('label', { class: 'field' }, 'Effect (preview in the browser)', h('select', { onchange: (e) => { slot.fx = e.target.value; paintSlot(slot, card); } }, h('option', { value: '' }, 'No effect'), Object.entries(FX_PREVIEWS).map(([k, f]) => h('option', { value: k, selected: k === slot.fx }, f.label)))),
        slot.fx ? amountSlider({ label: 'Effect amount', value: Math.round(slot.fxAmount * 100), onchange: (a) => { slot.fxAmount = a; } }) : null,
        h('button', { class: 'primary', onclick: () => generate(slot, card), disabled: slot.busy }, slot.take ? 'Generate again' : 'Generate'),
        slot.st.el,
        slot.take ? h('div', { class: 'row' }, slot.player.button, downloadMenu({ load: async () => slot.take.blob, name: () => `studio-${state.name || 'take'}-${index}` }),
          h('button', { onclick: (e) => saveTake(slot, e.currentTarget) }, 'Save to library'),
          h('button', { onclick: (e) => saveTake(slot, e.currentTarget, (saved) => toSchedules({ clipId: saved.id, name: state.name || 'Studio clip' })) }, 'Save and schedule')) : null)];
  }
  const paintSlot = (slot, card) => clear(card, ...slotBody(slot, card));
  function voicesCard() {
    const cards = state.slots.map((slot) => { const c = h('div', { class: 'card variant' }); paintSlot(slot, c); return { slot, c }; });
    return h('section', { class: 'card' },
      h('div', { class: 'row' }, h('h2', { class: 'grow' }, state.slots.length > 1 ? 'Compare voices' : 'Voice'),
        state.slots.length < MAX_SLOTS ? h('button', { onclick: () => { state.slots.push(newSlot()); paintAll(); } }, 'Add a voice to compare') : null,
        state.slots.length > 1 ? h('button', { class: 'primary', onclick: async () => { if (await guard.confirmSpend(state.slots.map((s) => ({ kind: 'speak', text: state.text, ...(s.speechModel && choosable ? { speechModel: s.speechModel } : {}) })), 'Generate all')) Promise.all(cards.map(({ slot, c }) => generate(slot, c, true))); } }, 'Generate all') : null),
      h('div', { class: 'slot-grid', style: 'margin-top:12px' }, cards.map((x) => x.c)), guard.el);
  }

  function paintAll() {
    clear(app, h('p', { class: 'muted' }, `Write a script, cast it, and listen to it in different voices. Nothing here goes on air. ${effectNames().length} built-in effects${speaker.library.sfx.length ? ` and ${speaker.library.sfx.length} from your library` : ''} work as [sfx:name].`),
      scriptCard(), voicesCard());
  }
  clear(root, app, warnings);
  paintAll();
}
