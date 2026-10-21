// Generate tab: make a clip with the AI (OpenRouter or Gemini). Pick what kind of line it is, the tone, the models and the voice.
import { h, clear, toast, fmtDate, audioUrl } from '../shared/kit.js';
import { effectNames } from './mixer.js';
import { createSpeaker } from '../shared/speaker.js';
import { stationId } from '../shared/station.js';
import { createStatus } from '../shared/status.js';
import { amountSlider } from '../shared/amount.js';
import { FX_PREVIEWS } from './fx.js';
import { downloadMenu } from '../shared/download.js';
import { costGuard } from '../shared/estimate.js';
import { modelLabel, allowsStrongLanguage, infoOf } from '../shared/modelinfo.js';

const GEMINI_VOICES = ['Kore', 'Puck', 'Charon', 'Fenrir', 'Aoede', 'Leda', 'Zephyr', 'Orus'];
const OTHER = '__other';
const PREF_KEY = 'djPrefs';

// A line sent here from another tab (a persona's sample), used once.
function takePrefill() { try { const t = sessionStorage.getItem('prefillText') || ''; sessionStorage.removeItem('prefillText'); return t; } catch { return ''; } }
const loadPrefs = () => { try { return JSON.parse(localStorage.getItem(PREF_KEY) || '{}'); } catch { return {}; } };
const savePrefs = (prefs) => { try { localStorage.setItem(PREF_KEY, JSON.stringify(prefs)); } catch { /* storage blocked */ } };

// Draws the tab into `root`. `api` is a client for this site's /api.
export async function mountGenerate(root, api) {
  clear(root, h('p', { class: 'muted' }, 'Loading...'));
  let options;
  try {
    options = await api.get('/options', { query: { station: stationId() } });
  } catch (err) {
    clear(root, h('p', { class: 'bad' }, `Could not load options: ${err.message}`));
    return;
  }

  let personas = [];
  try { personas = (await api.get('/personas')).personas; } catch { /* the picker is optional */ }

  // Speaking and mixing (built-in effects, the cloud library, music beds) is shared with Voice Lab: public/shared/speaker.js.
  const speaker = createSpeaker(api, options.features);
  const library = await speaker.loadLibrary();

  const prefs = loadPrefs();
  const state = {
    mode: prefs.mode === 'ai' ? 'ai' : 'say', format: prefs.format || '', persona: personas.some((p) => p.id === prefs.persona) ? prefs.persona : '', tone: prefs.tone || '',
    textModel: prefs.textModel || options.models.defaultText, speechModel: prefs.speechModel || options.models.defaultSpeech, voice: prefs.voice || '',
    fx: FX_PREVIEWS[prefs.fx] ? prefs.fx : '', fxAmount: typeof prefs.fxAmount === 'number' ? Math.min(1, Math.max(0, prefs.fxAmount)) : 1,
    textCustom: '', speechCustom: '', text: takePrefill(), explicit: prefs.explicit === true, seconds: Number(prefs.seconds) || 0,
  };
  // Strong language mode leaves out models that filter it, and moves a chosen filtered model to the first one that does not.
  const useUnfiltered = () => {
    for (const [key, list] of [['textModel', options.models.text || []], ['speechModel', (options.models.speech || []).map((m) => m.id)]]) {
      if (allowsStrongLanguage(options, state[key])) continue;
      const next = list.find((id) => allowsStrongLanguage(options, id));
      if (next) { toast(`Switched ${key === 'textModel' ? 'writing' : 'speech'} model to ${next}: ${state[key]} filters strong language.`, 'info'); state[key] = next; }
    }
  };
  const persist = () => savePrefs({ seconds: state.seconds, explicit: state.explicit, mode: state.mode, format: state.format, persona: state.persona, tone: state.tone, textModel: state.textModel, speechModel: state.speechModel, voice: state.voice, fx: state.fx, fxAmount: state.fxAmount });
  const formatOf = () => options.formats.find((f) => f.id === state.format);

  const note = options.warning
    ? h('p', { class: 'note warn' }, options.warning)
    : h('p', { class: 'muted small' }, options.models.choosable
      ? 'Using OpenRouter: pick any listed model for the writing and the voice.'
      : 'Using Gemini directly, so the models are fixed. Set OPENROUTER_API_KEY on the site to choose models.');

  // ----- the form (repainted when the mode or format changes) -----
  const form = h('div', { class: 'grid' });
  const status = createStatus();
  const clipsBox = h('div');
  let textArea;
  // Marks each model with its price tier (from /api/options) so the dear ones stand out before they are chosen.
  const tierLabel = (id) => modelLabel(options, id);
  const guard = costGuard(api);
  // What the next press will use, shown under the text: the writing step for "ask the AI", the speech step for "say verbatim".
  const estimateBodies = (text = state.text) => (state.mode === 'ai'
    ? [{ kind: 'write', prompt: text, ...writerBase() }]
    : [{ kind: 'speak', text, ...speakChoice() }]);
  const refreshEstimate = () => guard.show(estimateBodies());

  function paintForm() {
    const f = formatOf();
    textArea = h('textarea', {
      rows: 4, 'aria-label': state.mode === 'say' ? 'Text to speak' : 'Brief for the AI',
      placeholder: state.mode === 'say' ? 'Coming up, the top of the hour news.' : "hype up the next song, it's a summer anthem",
      oninput: (e) => { state.text = e.target.value; refreshEstimate(); },
    });
    textArea.value = state.text;

    const toneInput = h('input', { value: state.tone, maxlength: options.maxToneLength, placeholder: 'e.g. warm, slow, a little tired', 'aria-label': 'Tone', oninput: (e) => { state.tone = e.target.value; persist(); paintChips(); } });
    const chips = h('div', { class: 'row', style: 'gap:6px' });
    function paintChips() {
      const chosen = state.tone.split(',').map((t) => t.trim().toLowerCase());
      clear(chips, options.tones.map((tone) => h('button', {
        type: 'button', class: chosen.includes(tone) ? 'chip-btn on' : 'chip-btn',
        onclick: () => {
          const parts = state.tone.split(',').map((t) => t.trim()).filter(Boolean);
          const at = parts.findIndex((t) => t.toLowerCase() === tone);
          if (at >= 0) parts.splice(at, 1); else parts.push(tone);
          state.tone = parts.join(', '); toneInput.value = state.tone; persist(); paintChips();
        },
      }, tone)));
    }
    paintChips();

    const modelSelect = (key, customKey, values, label, dim) => {
      const shown = state.explicit ? values.filter((v) => allowsStrongLanguage(options, v)) : values;
      const items = shown.map((v) => h('option', { value: v, selected: state[key] === v }, tierLabel(v)));
      if (options.models.allowAny) items.push(h('option', { value: OTHER, selected: state[key] === OTHER }, 'Other (type a model name)...'));
      const custom = h('input', { value: state[customKey], placeholder: 'provider/model-name', hidden: state[key] !== OTHER, 'aria-label': `${label} name`, oninput: (e) => { state[customKey] = e.target.value; } });
      const select = h('select', { disabled: !options.models.choosable, 'aria-label': label, onchange: (e) => { state[key] = e.target.value; custom.hidden = state[key] !== OTHER; persist(); paintVoices(); refreshEstimate(); } }, items);
      return h('label', { class: 'field', style: dim ? 'opacity:.6' : '' }, label, select, custom);
    };
    // What the chosen speech model does with tone and inline tags like [laughs] (decided on the server, lib/cues.ts).
    const cueBox = h('div', { class: 'hint small' });
    const UNKNOWN_CUES = { tone: 'instructions', tags: 'unknown', basis: 'unknown', note: 'Not checked: the tone is sent as an instruction and tags are left in the text, so listen to the result.' };
    function paintCues() {
      const entry = options.models.speech.find((m) => m.id === state.speechModel);
      const cues = options.models.choosable ? (entry && entry.cues) || UNKNOWN_CUES : options.models.fixedCues;
      if (!cues) { clear(cueBox); return; }
      const tone = { text: 'Tone: yes', instructions: 'Tone: yes', none: 'Tone: ignored' }[cues.tone];
      const tags = cues.tags === true ? 'Tags like [laughs]: performed' : cues.tags === false ? 'Tags like [laughs]: removed' : 'Tags like [laughs]: untested';
      clear(cueBox, h('b', {}, `${tone} \u00b7 ${tags}`), cues.basis === 'documented' ? '' : cues.basis === 'assumed' ? ' (not yet confirmed by listening)' : '', h('br'), cues.note);
    }
    const voiceList = h('datalist', { id: 'voice-list' });
    function paintVoices() {
      const entry = options.models.speech.find((m) => m.id === state.speechModel);
      const voices = entry && entry.voice ? [entry.voice] : [];
      if (entry && entry.voices) for (const v of entry.voices) if (!voices.includes(v)) voices.push(v);
      if (options.provider === 'gemini' || (state.speechModel || '').startsWith('google/')) for (const v of GEMINI_VOICES) if (!voices.includes(v)) voices.push(v);
      clear(voiceList, voices.map((v) => h('option', { value: v })));
      paintCues();
      if (voiceInput) voiceInput.placeholder = entry && (entry.voice || (entry.voices && entry.voices[0])) ? `default: ${entry.voice || entry.voices[0]}` : 'model default';
    }
    const voiceInput = h('input', { value: state.voice, list: 'voice-list', placeholder: 'model default', autocomplete: 'off', 'aria-label': 'Voice', oninput: (e) => { state.voice = e.target.value; persist(); } });
    paintVoices();

    clear(form,
      h('div', { class: 'row' },
        ['say', 'ai'].map((mode) => h('button', { type: 'button', class: state.mode === mode ? 'seg on' : 'seg', onclick: () => { state.mode = mode; persist(); paintForm(); } }, mode === 'say' ? 'Say verbatim' : 'Ask the AI to write it'))),
      personas.length ? h('label', { class: 'field' }, 'Persona (who is speaking; optional)',
        h('select', { onchange: (e) => { state.persona = e.target.value; const p = personas.find((x) => x.id === state.persona); if (p && p.tone) { state.tone = p.tone; } persist(); paintForm(); } },
          h('option', { value: '' }, 'None'), personas.map((p) => h('option', { value: p.id, selected: p.id === state.persona }, p.name)))) : null,
      h('label', { class: 'field' }, 'What kind of line is it?',
        h('select', { onchange: (e) => { state.format = e.target.value; persist(); paintForm(); } },
          h('option', { value: '' }, 'Free-form'), options.formats.map((x) => h('option', { value: x.id, selected: x.id === state.format }, x.label)))),
      f ? h('div', { class: 'hint' }, h('b', {}, 'Structure: '), f.structure, h('br'), h('b', {}, state.mode === 'say' ? 'Example: ' : 'Example brief: '), state.mode === 'say' ? f.example : f.prompt) : null,
      textArea,
      f ? h('div', {}, h('button', { type: 'button', onclick: () => { state.text = state.mode === 'say' ? f.example : f.prompt; textArea.value = state.text; textArea.focus(); } }, state.mode === 'say' ? 'Use the example line' : 'Use the example brief')) : null,
      h('div', {}, h('div', { class: 'label' }, 'Tone (click any that fit, or describe your own)'), chips, toneInput),
      h('label', { class: 'row small' }, 'Length',
        h('select', { 'aria-label': 'Length of the drop', onchange: (e) => { state.seconds = Number(e.target.value); persist(); refreshEstimate(); } },
          [[0, 'Any (short)'], [5, 'About 5 seconds'], [10, 'About 10 seconds'], [15, 'About 15 seconds'], [20, 'About 20 seconds'], [30, 'About 30 seconds'], [45, 'About 45 seconds'], [60, 'About a minute']].map(([v, t]) => h('option', { value: v, selected: v === state.seconds }, t))),
        h('span', { class: 'muted' }, 'The writer is told how long to aim for.')),
      placeholderPanel(),
      h('label', { class: 'row small', title: 'Models that filter or soften profanity are hidden while this is on' },
        h('input', { type: 'checkbox', checked: state.explicit, onchange: (e) => { state.explicit = e.target.checked; if (state.explicit && options.models.choosable) useUnfiltered(); persist(); paintForm(); } }),
        'Allow strong language (profanity). Hides models marked "filtered"; the writer is told not to censor.'),
      options.models.choosable ? h('p', { class: 'small muted' }, [['Writing', state.mode === 'ai' ? state.textModel : ''], ['Speech', state.speechModel]].filter(([, id]) => id && infoOf(options, id) && infoOf(options, id).content).map(([label, id]) => `${label} (${id}): ${infoOf(options, id).content.note}`).join(' ')) : null,
      h('div', { class: 'grid cols' },
        modelSelect('textModel', 'textCustom', options.models.text, 'Writing model (used when the AI writes the line)', state.mode !== 'ai'),
        modelSelect('speechModel', 'speechCustom', options.models.speech.map((m) => m.id), 'Speech model'),
        h('label', { class: 'field' }, 'Voice', voiceInput, voiceList)),
      cueBox,
      // An audio treatment applied to the finished clip (voice and any mixed-in sounds) before you hear it and save it.
      h('div', { class: 'grid cols' },
        h('label', { class: 'field' }, 'Effect on the audio',
          h('select', { 'aria-label': 'Effect', onchange: (e) => { state.fx = e.target.value; persist(); paintForm(); } }, h('option', { value: '' }, 'None'),
            Object.entries(FX_PREVIEWS).map(([k, f]) => h('option', { value: k, selected: k === state.fx }, f.label)))),
        state.fx ? amountSlider({ label: 'Effect amount', value: Math.round(state.fxAmount * 100), onchange: (a) => { state.fxAmount = a; persist(); } }) : null),
      state.fx ? h('p', { class: 'muted small' }, 'Applied in the browser and saved into the audio. It is a preview-quality version of the station\'s treatment of the same name; the station can still apply its own on top.') : null,
      h('details', { class: 'tips' }, h('summary', {}, 'Writing tips and structure'), h('ul', {},
        h('li', {}, h('b', {}, 'Keep it short. '), 'One to three sentences is 5 to 15 seconds on air. Shape: a hook, the information, then a sign-off or station name.'),
        h('li', {}, h('b', {}, 'Say it the way it should sound. '), 'Write times and numbers as spoken ("nine thirty", not "9:30"), and add commas where you want a breath.'),
        h('li', {}, h('b', {}, 'Give the AI facts. '), 'It only knows what you put in the brief (artist, title, time, event details) and is told not to invent the rest.'),
        h('li', {}, h('b', {}, 'Delivery tags '), 'in square brackets are performed only by models that support them (see the note under the speech model). Others have them removed before speaking. Example: ', h('code', {}, '[softly]'), ', ', h('code', {}, '[excited]'), ', ', h('code', {}, '[laughs]'), ', ', h('code', {}, '[short pause]'), '.'),
        h('li', {}, h('b', {}, 'Tone '), 'guides the AI writer and is sent to the voice as a direction ("Say in a warm tone"). The same text can sound very different per model: generate, listen, adjust.'),
        h('li', {}, h('b', {}, 'Ask the AI to write it '), 'writes the line first and shows it to you; nothing is spoken until you press "Make the audio", so you can edit the words (and add effect tags) first.'),
        h('li', {}, h('b', {}, 'Sound effects and music '), 'in the text are mixed into the preview: ', h('code', {}, '[sfx:ding]'), ', ', h('code', {}, '[sfx:whoosh over]'), ' (over the next words), ', h('code', {}, '[sfx:crowd vol=0.5]'), ', ', h('code', {}, '[sfx:beep wait=0.5]'), `, and ${library.music.length ? `[music:${library.music[0].name} vol=0.2] for a music bed under the clip` : 'a music bed with [music:name] once a library is connected'}. Built in: ${effectNames().join(', ')}${library.sfx.length ? `. From your library: ${library.sfx.map((i) => i.name).join(', ')}` : ''}.`))),
      guard.el,
      h('div', {}, h('button', { class: 'primary', id: 'generate-btn', onclick: submit }, state.mode === 'ai' ? 'Write the line' : 'Generate preview')),
      status.el);
    refreshEstimate();
  }

  // The placeholders the engine can fill in ({{time}}, {{weather}}, {{dj}}...), with today's values; click one to put it in the text.
  function placeholderPanel() {
    const body = h('div', { class: 'stack small' });
    let loaded = false;
    const insert = (name) => {
      const token = `{{${name}}}`; const a = textArea; const at = a.selectionStart ?? a.value.length;
      a.value = a.value.slice(0, at) + token + a.value.slice(a.selectionEnd ?? at); state.text = a.value; a.focus(); a.selectionStart = a.selectionEnd = at + token.length; refreshEstimate();
    };
    async function load() {
      clear(body, h('span', { class: 'muted' }, 'Loading...'));
      try {
        const data = await api.get('/template', { query: { station: stationId(), persona: state.persona || undefined, seconds: state.seconds || undefined } });
        const groups = {};
        for (const v of data.variables) (groups[v.group] ||= []).push(v);
        const preview = h('p', { class: 'muted' });
        clear(body,
          h('p', { class: 'muted' }, 'Write ', h('code', {}, '{{name}}'), ' where the value should go, ', h('code', {}, '{{name|fallback}}'), ' for a backup (always give one for weather), or ', h('code', {}, '{{pick: a | b | c}}'), ' for a random choice. They are filled in after the AI writes and before the voice speaks, so the line is right whenever it is made. The AI is told which ones exist.'),
          Object.entries(groups).map(([g, vars]) => h('div', {}, h('strong', {}, g), h('div', { class: 'row' }, vars.map((v) => h('button', { type: 'button', class: 'chip', title: `${v.description}. Right now: ${v.value ?? 'not available'}`, onclick: () => insert(v.name) }, `${v.name}${v.value ? ` = ${v.value}` : ''}`))))),
          h('div', { class: 'row' }, h('button', { type: 'button', onclick: async () => {
            try { const r = await api.post('/template', { text: state.text, station: stationId(), persona: state.persona || undefined, seconds: state.seconds || undefined }); clear(preview, `Right now: "${r.text}"${r.missing.length ? ` (no value for: ${r.missing.join(', ')})` : ''}`); } catch (err) { toast(err.message, 'error'); }
          } }, "Preview my text with today's values")), preview);
      } catch (err) { clear(body, h('span', { class: 'bad' }, err.message)); }
    }
    return h('details', { class: 'tips', ontoggle: (e) => { if (e.target.open && !loaded) { loaded = true; load(); } } }, h('summary', {}, 'Placeholders (time, weather, station, DJ, length...)'), body);
  }
  const speakChoice = () => ({ ...(state.explicit ? { explicit: true } : {}), ...(state.persona ? { persona: state.persona } : {}), ...(stationId() ? { station: stationId() } : {}), ...(options.models.choosable && chosen('speechModel', 'speechCustom') ? { speechModel: chosen('speechModel', 'speechCustom') } : {}) });
  const chosen = (key, customKey) => (state[key] === OTHER ? state[customKey].trim() : state[key]);

  // ----- preview, then save -----
  // Generating makes a draft only (nothing is stored or sent to the station). Sound effect tags in "Say verbatim" text are
  // mixed in here in the browser, so the draft you hear is the file that gets saved.
  const draftBox = h('div');
  let draft = null;
  const writerBase = () => ({
    ...(stationId() ? { station: stationId() } : {}),
    ...(state.persona ? { persona: state.persona } : {}), ...(state.format ? { format: state.format } : {}), ...(state.tone.trim() ? { tone: state.tone.trim() } : {}), ...(state.explicit ? { explicit: true } : {}), ...(state.seconds ? { seconds: state.seconds } : {}),
    ...(options.models.choosable ? (() => { const m = chosen('textModel', 'textCustom'); return m ? { textModel: m } : {}; })() : {}),
  });

  async function submit(e) {
    const value = state.text.trim();
    
    if (!value) { status.fail(state.mode === 'say' ? 'Enter text to speak.' : 'Enter a brief for the AI.'); return; }
    const button = e.currentTarget;
    button.disabled = true;
    try {
      // "Ask the AI to write it" writes the line first and stops, so it can be read and edited before any speech is generated.
      if (!(await guard.confirmSpend(estimateBodies(value), state.mode === 'ai' ? 'Write the line' : 'Generate the audio'))) return;
      if (state.mode === 'ai') await writeLine(value);
      else await makeAudio(value, { mode: 'say', input: value });
    } catch (err) {
      status.fail(err.message);
    } finally {
      button.disabled = false;
    }
  }

  async function writeLine(brief) {
    status.busy('Writing the line (nothing is spoken yet)');
    const data = await api.post('/generate', { mode: 'ai', prompt: brief, textOnly: true, ...writerBase() });
    showScript({ brief, text: data.scriptText, textModel: data.textModel });
    status.ok(`Line written${data.textModel ? ` by ${data.textModel}` : ''}. Edit it if you like, then make the audio.`);
  }

  // The written line, editable, with the next step. Sound effect tags can be added here and are mixed in like any other text.
  function showScript(script) {
    if (draft) { URL.revokeObjectURL(draft.url); draft = null; }
    const box = h('textarea', { rows: 4, 'aria-label': 'Written line', oninput: (e) => { script.text = e.target.value; } });
    box.value = script.text;
    const make = h('button', { class: 'primary', type: 'button', onclick: async () => {
      if (!script.text.trim()) { status.fail('The line is empty.'); return; }
      make.disabled = true; 
      try { if (!(await guard.confirmSpend([{ kind: 'speak', text: script.text, ...speakChoice() }], 'Make the audio'))) { make.disabled = false; return; } await makeAudio(script.text.trim(), { mode: 'ai', input: script.brief, textModel: script.textModel }); } catch (err) { status.fail(err.message); } finally { make.disabled = false; }
    } }, 'Make the audio');
    const again = h('button', { type: 'button', onclick: async () => {
      again.disabled = true; 
      try { if (!(await guard.confirmSpend(estimateBodies(script.brief), 'Write it again'))) { again.disabled = false; return; } await writeLine(script.brief); } catch (err) { status.fail(err.message); again.disabled = false; }
    } }, 'Write it again');
    clear(draftBox, h('div', { class: 'clip' },
      h('div', { class: 'row small muted' }, h('span', { class: 'chip' }, 'written line, not spoken yet'), script.textModel ? h('span', { class: 'chip' }, script.textModel) : null),
      box,
      h('div', { class: 'row' }, make, again, h('button', { type: 'button', onclick: discard }, 'Discard'))));
  }

  // The speech step: each stretch of text goes to the speech service as plain "say" text; effects are mixed here.
  async function makeAudio(value, meta) {
    
    status.busy('Generating a preview');
    const base = { ...(state.persona ? { persona: state.persona } : {}), ...(stationId() ? { station: stationId() } : {}) };
    if (state.tone.trim()) base.tone = state.tone.trim();
    if (state.voice.trim()) base.voice = state.voice.trim();
    if (options.models.choosable) {
      const speechModel = chosen('speechModel', 'speechCustom');
      if (speechModel) base.speechModel = speechModel;
    }
    const out = await speaker.render(value, base, { fx: state.fx, fxAmount: state.fxAmount, onProgress: (m, p) => status.busy(m, p) });
    const first = out.first;
    showDraft({ blob: out.blob, scriptText: out.scriptText, input: meta.input, mode: meta.mode, textModel: meta.textModel, first, effects: out.effects, fx: state.fx ? { name: state.fx, amount: state.fxAmount } : null });
    status.ok(`Preview ready${first.speechModel ? ` (${first.speechModel}${meta.textModel ? `, written by ${meta.textModel}` : ''})` : ''}. Listen, then save it or discard it.${first.cueTagsRemoved ? ' Delivery tags were removed (this model does not perform them).' : ''}${first.toneIgnored ? ' This model ignores tone.' : ''}`);
  }

  function showDraft(next) {
    if (draft) URL.revokeObjectURL(draft.url);
    draft = { ...next, url: URL.createObjectURL(next.blob) };
    const player = h('audio', { controls: true, src: draft.url });
    const saveStatus = createStatus();
    // Details that travel with the clip to other systems (docs/CLIP-METADATA.md); all optional.
    const detail = { title: '', kind: state.format || '', expires: '', tags: '' };
    const field = (label, key, props = {}) => h('label', { class: 'field' }, label, h('input', { ...props, value: detail[key], oninput: (e) => { detail[key] = e.target.value; } }));
    const details = h('details', { class: 'tips' }, h('summary', {}, 'Details for other systems (title, kind, expiry)'),
      h('div', { class: 'grid cols' }, field('Title', 'title', { placeholder: 'shown by players and now-playing' }), field('Kind', 'kind', { placeholder: 'drop, promo, station-id...' }),
        field('Tags (comma separated)', 'tags'), field('Do not play after', 'expires', { type: 'datetime-local' })),
      h('p', { class: 'muted small' }, 'These are written into the audio file and saved with the clip. A clip is never queued, scheduled or played after its expiry.'));
    const saveButton = h('button', { class: 'primary', type: 'button', onclick: async () => {
      saveButton.disabled = true; saveStatus.busy('Saving the clip');
      try {
        const f = draft.first;
        const meta = { mode: draft.mode, input: draft.input, scriptText: draft.scriptText, voice: f.voice, provider: f.provider, speechModel: f.speechModel, textModel: draft.textModel, tone: state.tone.trim() || undefined, format: state.format || undefined, effects: draft.effects,
          info: { ...(stationId() ? { station: stationId() } : {}), ...(draft.fx ? { extra: { effect: draft.fx.name, effect_amount: String(Math.round(draft.fx.amount * 100)) } } : {}), ...(detail.title.trim() ? { title: detail.title.trim() } : {}), ...(detail.kind.trim() ? { kind: detail.kind.trim() } : {}), ...(detail.tags.trim() ? { tags: detail.tags.split(',').map((t) => t.trim()) } : {}), ...(detail.expires ? { expiresAt: new Date(detail.expires).toISOString() } : {}), ...(state.persona ? { persona: state.persona } : {}) } };
        const saved = await api.request('POST', '/clips', { raw: draft.blob, contentType: draft.blob.type, headers: { 'x-clip-meta': encodeURIComponent(JSON.stringify(meta)) } });
        toast(saved.handoff ? (saved.handoff.sent ? 'Saved and sent to the station.' : `Saved. Station hand-off failed: ${saved.handoff.error}`) : 'Saved to the library.', saved.handoff && !saved.handoff.sent ? 'error' : 'info');
        discard(); state.text = ''; if (textArea) textArea.value = ''; status.clear();
        await loadClips();
      } catch (err) { saveStatus.fail(err.message); saveButton.disabled = false; }
    } }, 'Save to library');
    clear(draftBox, h('div', { class: 'clip' },
      h('div', { class: 'row small muted' }, h('span', { class: 'chip' }, 'preview, not saved yet'), draft.effects.length ? h('span', { class: 'chip' }, `sounds: ${[...new Set(draft.effects)].join(', ')}`) : null, draft.fx ? h('span', { class: 'chip' }, `effect: ${FX_PREVIEWS[draft.fx.name].label} ${Math.round(draft.fx.amount * 100)}%`) : null, h('span', {}, `${(draft.blob.size / 1024).toFixed(0)} KB`)),
      h('p', { class: 'clip-script' }, draft.scriptText),
      player, details,
      h('div', { class: 'row' }, saveButton, downloadMenu({ load: async () => draft.blob, name: () => detail.title.trim() || draft.scriptText }), h('button', { type: 'button', onclick: discard }, 'Discard'), saveStatus.el)));
    player.play().catch(() => {});
  }
  function discard() { if (draft) URL.revokeObjectURL(draft.url); draft = null; clear(draftBox); }

  // ----- clips -----
  async function loadClips() {
    try {
      const { clips } = await api.get('/clips');
      clear(clipsBox, clips.length ? clips.map((clip) => h('div', { class: 'clip' },
        h('div', { class: 'row small muted' },
          h('span', { class: 'chip' }, clip.mode), h('span', {}, fmtDate(Date.parse(clip.createdAt))), h('span', {}, clip.voice),
          clip.speechModel ? h('span', { class: 'chip' }, clip.speechModel) : null, clip.tone ? h('span', { class: 'chip' }, clip.tone) : null,
          clip.info && clip.info.kind ? h('span', { class: 'chip' }, clip.info.kind) : null, expiryChip(clip)),
        h('p', { class: 'clip-script' }, clip.scriptText),
        h('div', { class: 'row' }, playButton(clip.id), downloadMenu({ load: () => api.get(`/clips/${encodeURIComponent(clip.id)}`, { blob: true }), name: (clip.info && clip.info.title) || clip.scriptText }), ...(expired(clip) ? [] : sendButtons(clip.id))))) : h('p', { class: 'empty' }, 'No clips yet. Generate one above.'));
    } catch (err) {
      clear(clipsBox, h('p', { class: 'empty' }, `Failed to load clips: ${err.message}`));
    }
  }
  // A clip with an expiry is never sent, queued or played after it (the site and the station both check).
  const expired = (clip) => Boolean(clip.info && clip.info.expiresAt && Date.parse(clip.info.expiresAt) <= Date.now());
  const expiryChip = (clip) => (clip.info && clip.info.expiresAt
    ? h('span', { class: 'chip', title: clip.info.expiresAt, style: expired(clip) ? 'opacity:.6;text-decoration:line-through' : '' }, expired(clip) ? 'expired' : `expires ${fmtDate(Date.parse(clip.info.expiresAt))}`) : null);
  // With STATION_MODE=queue a saved clip can be sent to the station daemon, to go on air now or just to be kept there.
  function sendButtons(id) {
    if (!(options.features && options.features.stationQueue)) return [];
    const send = (play) => async (e) => {
      const button = e.currentTarget; button.disabled = true;
      try { await api.post('/queue', { clipId: id, play }); toast(play ? 'Queued to go on air.' : 'Queued for the station library.', 'info'); } catch (err) { toast(err.message, 'error'); } finally { button.disabled = false; }
    };
    return [h('button', { type: 'button', onclick: send(true) }, 'Send to air'), h('button', { type: 'button', onclick: send(false) }, 'Send to station library')];
  }
  // An <audio src> cannot send the sign-in, so the audio is fetched first and played from memory.
  function playButton(id) {
    return h('button', { type: 'button', onclick: async (e) => {
      const button = e.currentTarget;
      button.disabled = true;
      try {
        const audio = h('audio', { controls: true, src: await audioUrl(api, `/clips/${encodeURIComponent(id)}`) });
        button.replaceWith(audio);
        audio.play().catch(() => {});
      } catch (err) { toast(err.message, 'error'); button.disabled = false; }
    } }, 'Play');
  }

  clear(root, h('div', { class: 'stack' },
    h('section', { class: 'card' }, h('h2', {}, 'Generate a clip'), note, form, draftBox),
    h('section', { class: 'card' }, h('h2', {}, 'Clips'), clipsBox)));
  paintForm();
  await loadClips();
}
