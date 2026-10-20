// Generate tab: make a clip with the AI (OpenRouter or Gemini). Pick what kind of line it is, the tone, the models and the voice.
import { h, clear, toast, fmtDate, audioUrl } from '../shared/kit.js';
import { parseTags, mix, toWav, effectNames, RATE } from './mixer.js';

const GEMINI_VOICES = ['Kore', 'Puck', 'Charon', 'Fenrir', 'Aoede', 'Leda', 'Zephyr', 'Orus'];
const OTHER = '__other';
const PREF_KEY = 'djPrefs';

const loadPrefs = () => { try { return JSON.parse(localStorage.getItem(PREF_KEY) || '{}'); } catch { return {}; } };
const savePrefs = (prefs) => { try { localStorage.setItem(PREF_KEY, JSON.stringify(prefs)); } catch { /* storage blocked */ } };

// Draws the tab into `root`. `api` is a client for this site's /api.
export async function mountGenerate(root, api) {
  clear(root, h('p', { class: 'muted' }, 'Loading...'));
  let options;
  try {
    options = await api.get('/options');
  } catch (err) {
    clear(root, h('p', { class: 'bad' }, `Could not load options: ${err.message}`));
    return;
  }

  let personas = [];
  try { personas = (await api.get('/personas')).personas; } catch { /* the picker is optional */ }

  // Sounds from the connected cloud library (OwnCloud / Google Drive), usable as [sfx:name] and [music:name].
  const library = { sfx: [], music: [] };
  if (options.features && options.features.library && (options.features.library.sfx || options.features.library.music)) {
    try { for (const item of (await api.get('/library')).items) (library[item.kind] || []).push(item); } catch { /* built-in effects still work */ }
  }
  const libraryItem = (kind, name) => library[kind].find((i) => i.name === name);
  const sampleCache = new Map();
  async function librarySamples(kind, name) {
    const key = `${kind}/${name}`;
    if (!sampleCache.has(key)) {
      const item = libraryItem(kind, name);
      const blob = await api.get(`/library/${encodeURIComponent(item.source)}/${kind}/${encodeURIComponent(item.name)}`, { blob: true });
      sampleCache.set(key, await decodeToSamples(new Uint8Array(await blob.arrayBuffer())));
    }
    return sampleCache.get(key);
  }

  const prefs = loadPrefs();
  const state = {
    mode: prefs.mode === 'ai' ? 'ai' : 'say', format: prefs.format || '', persona: personas.some((p) => p.id === prefs.persona) ? prefs.persona : '', tone: prefs.tone || '',
    textModel: prefs.textModel || options.models.defaultText, speechModel: prefs.speechModel || options.models.defaultSpeech, voice: prefs.voice || '',
    textCustom: '', speechCustom: '', text: '',
  };
  const persist = () => savePrefs({ mode: state.mode, format: state.format, persona: state.persona, tone: state.tone, textModel: state.textModel, speechModel: state.speechModel, voice: state.voice });
  const formatOf = () => options.formats.find((f) => f.id === state.format);

  const note = options.warning
    ? h('p', { class: 'note warn' }, options.warning)
    : h('p', { class: 'muted small' }, options.models.choosable
      ? 'Using OpenRouter: pick any listed model for the writing and the voice.'
      : 'Using Gemini directly, so the models are fixed. Set OPENROUTER_API_KEY on the site to choose models.');

  // ----- the form (repainted when the mode or format changes) -----
  const form = h('div', { class: 'grid' });
  const status = h('p', { class: 'small muted', role: 'status' });
  const clipsBox = h('div');
  let textArea;

  function paintForm() {
    const f = formatOf();
    textArea = h('textarea', {
      rows: 4, 'aria-label': state.mode === 'say' ? 'Text to speak' : 'Brief for the AI',
      placeholder: state.mode === 'say' ? 'Coming up, the top of the hour news.' : "hype up the next song, it's a summer anthem",
      oninput: (e) => { state.text = e.target.value; },
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
      const items = values.map((v) => h('option', { value: v, selected: state[key] === v }, v));
      if (options.models.allowAny) items.push(h('option', { value: OTHER, selected: state[key] === OTHER }, 'Other (type a model name)...'));
      const custom = h('input', { value: state[customKey], placeholder: 'provider/model-name', hidden: state[key] !== OTHER, 'aria-label': `${label} name`, oninput: (e) => { state[customKey] = e.target.value; } });
      const select = h('select', { disabled: !options.models.choosable, 'aria-label': label, onchange: (e) => { state[key] = e.target.value; custom.hidden = state[key] !== OTHER; persist(); paintVoices(); } }, items);
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
      if (options.provider === 'gemini' || state.speechModel.startsWith('google/')) for (const v of GEMINI_VOICES) if (!voices.includes(v)) voices.push(v);
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
      h('div', { class: 'grid cols' },
        modelSelect('textModel', 'textCustom', options.models.text, 'Writing model (used when the AI writes the line)', state.mode !== 'ai'),
        modelSelect('speechModel', 'speechCustom', options.models.speech.map((m) => m.id), 'Speech model'),
        h('label', { class: 'field' }, 'Voice', voiceInput, voiceList)),
      cueBox,
      h('details', { class: 'tips' }, h('summary', {}, 'Writing tips and structure'), h('ul', {},
        h('li', {}, h('b', {}, 'Keep it short. '), 'One to three sentences is 5 to 15 seconds on air. Shape: a hook, the information, then a sign-off or station name.'),
        h('li', {}, h('b', {}, 'Say it the way it should sound. '), 'Write times and numbers as spoken ("nine thirty", not "9:30"), and add commas where you want a breath.'),
        h('li', {}, h('b', {}, 'Give the AI facts. '), 'It only knows what you put in the brief (artist, title, time, event details) and is told not to invent the rest.'),
        h('li', {}, h('b', {}, 'Delivery tags '), 'in square brackets are performed only by models that support them (see the note under the speech model). Others have them removed before speaking. Example: ', h('code', {}, '[softly]'), ', ', h('code', {}, '[excited]'), ', ', h('code', {}, '[laughs]'), ', ', h('code', {}, '[short pause]'), '.'),
        h('li', {}, h('b', {}, 'Tone '), 'guides the AI writer and is sent to the voice as a direction ("Say in a warm tone"). The same text can sound very different per model: generate, listen, adjust.'),
        h('li', {}, h('b', {}, 'Ask the AI to write it '), 'writes the line first and shows it to you; nothing is spoken until you press "Make the audio", so you can edit the words (and add effect tags) first.'),
        h('li', {}, h('b', {}, 'Sound effects and music '), 'in the text are mixed into the preview: ', h('code', {}, '[sfx:ding]'), ', ', h('code', {}, '[sfx:whoosh over]'), ' (over the next words), ', h('code', {}, '[sfx:crowd vol=0.5]'), ', ', h('code', {}, '[sfx:beep wait=0.5]'), `, and ${library.music.length ? `[music:${library.music[0].name} vol=0.2] for a music bed under the clip` : 'a music bed with [music:name] once a library is connected'}. Built in: ${effectNames().join(', ')}${library.sfx.length ? `. From your library: ${library.sfx.map((i) => i.name).join(', ')}` : ''}.`))),
      h('div', {}, h('button', { class: 'primary', id: 'generate-btn', onclick: submit }, state.mode === 'ai' ? 'Write the line' : 'Generate preview')),
      status);
  }

  const chosen = (key, customKey) => (state[key] === OTHER ? state[customKey].trim() : state[key]);

  // ----- preview, then save -----
  // Generating makes a draft only (nothing is stored or sent to the station). Sound effect tags in "Say verbatim" text are
  // mixed in here in the browser, so the draft you hear is the file that gets saved.
  const draftBox = h('div');
  let draft = null;
  const bytesOf = (b64) => Uint8Array.from(atob(b64), (c) => c.charCodeAt(0));
  async function decodeToSamples(bytes) {
    const buffer = await new OfflineAudioContext(1, 1, RATE).decodeAudioData(bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength));
    return buffer.getChannelData(0);
  }

  const writerBase = () => ({
    ...(state.persona ? { persona: state.persona } : {}), ...(state.format ? { format: state.format } : {}), ...(state.tone.trim() ? { tone: state.tone.trim() } : {}),
    ...(options.models.choosable ? (() => { const m = chosen('textModel', 'textCustom'); return m ? { textModel: m } : {}; })() : {}),
  });

  async function submit(e) {
    const value = state.text.trim();
    status.classList.remove('bad');
    if (!value) { status.textContent = state.mode === 'say' ? 'Enter text to speak.' : 'Enter a brief for the AI.'; status.classList.add('bad'); return; }
    const button = e.currentTarget;
    button.disabled = true;
    try {
      // "Ask the AI to write it" writes the line first and stops, so it can be read and edited before any speech is generated.
      if (state.mode === 'ai') await writeLine(value);
      else await makeAudio(value, { mode: 'say', input: value });
    } catch (err) {
      status.textContent = err.message; status.classList.add('bad');
    } finally {
      button.disabled = false;
    }
  }

  async function writeLine(brief) {
    status.textContent = 'Writing the line (the speech service is not called yet)...';
    const data = await api.post('/generate', { mode: 'ai', prompt: brief, textOnly: true, ...writerBase() });
    showScript({ brief, text: data.scriptText, textModel: data.textModel });
    status.textContent = `Line written${data.textModel ? ` by ${data.textModel}` : ''}. Edit it if you like, then make the audio.`;
  }

  // The written line, editable, with the next step. Sound effect tags can be added here and are mixed in like any other text.
  function showScript(script) {
    if (draft) { URL.revokeObjectURL(draft.url); draft = null; }
    const box = h('textarea', { rows: 4, 'aria-label': 'Written line', oninput: (e) => { script.text = e.target.value; } });
    box.value = script.text;
    const make = h('button', { class: 'primary', type: 'button', onclick: async () => {
      if (!script.text.trim()) { status.textContent = 'The line is empty.'; status.classList.add('bad'); return; }
      make.disabled = true; status.classList.remove('bad');
      try { await makeAudio(script.text.trim(), { mode: 'ai', input: script.brief, textModel: script.textModel }); } catch (err) { status.textContent = err.message; status.classList.add('bad'); } finally { make.disabled = false; }
    } }, 'Make the audio');
    const again = h('button', { type: 'button', onclick: async () => {
      again.disabled = true; status.classList.remove('bad');
      try { await writeLine(script.brief); } catch (err) { status.textContent = err.message; status.classList.add('bad'); again.disabled = false; }
    } }, 'Write it again');
    clear(draftBox, h('div', { class: 'clip' },
      h('div', { class: 'row small muted' }, h('span', { class: 'chip' }, 'written line, not spoken yet'), script.textModel ? h('span', { class: 'chip' }, script.textModel) : null),
      box, h('div', { class: 'row' }, make, again, h('button', { type: 'button', onclick: discard }, 'Discard'))));
  }

  // The speech step: each stretch of text goes to the speech service as plain "say" text; effects are mixed here.
  async function makeAudio(value, meta) {
    status.classList.remove('bad');
    status.textContent = 'Generating a preview (this calls the speech service live and can take a few seconds)...';
    const base = { preview: true, mode: 'say', ...(state.persona ? { persona: state.persona } : {}) };
    if (state.tone.trim()) base.tone = state.tone.trim();
    if (state.voice.trim()) base.voice = state.voice.trim();
    if (options.models.choosable) {
      const speechModel = chosen('speechModel', 'speechCustom');
      if (speechModel) base.speechModel = speechModel;
    }
    const pieces = parseTags(value);
    const tagged = pieces.filter((p) => p.type !== 'speech');
    for (const p of tagged) {
      if (p.type === 'sfx' && !effectNames().includes(p.name) && !libraryItem('sfx', p.name)) throw new Error(`Unknown sound effect "${p.name}". Available: ${[...effectNames(), ...library.sfx.map((i) => i.name)].join(', ')}`);
      if (p.type === 'music' && !libraryItem('music', p.name)) throw new Error(library.music.length ? `Unknown music "${p.name}". Available: ${library.music.map((i) => i.name).join(', ')}` : 'No music library is connected (see docs/LIBRARY.md).');
    }
    if (!pieces.some((p) => p.type === 'speech')) throw new Error('Add some words to speak as well as the sound effects.');

    const results = [];
    const speechCount = pieces.filter((p) => p.type === 'speech').length;
    for (const piece of pieces) {
      if (piece.type !== 'speech') { results.push(piece); continue; }
      status.textContent = `Generating speech${speechCount > 1 ? ` (${results.filter((r) => r.type === 'speech').length + 1} of ${speechCount})` : ''}...`;
      results.push({ type: 'speech', data: await api.post('/generate', { ...base, text: piece.text }) });
    }
    const first = results.find((r) => r.type === 'speech').data;
    let blob;
    if (!tagged.length) {
      blob = new Blob([bytesOf(first.audio)], { type: first.mimeType });
    } else {
      status.textContent = 'Mixing...';
      const items = [];
      for (const r of results) {
        if (r.type === 'speech') items.push({ kind: 'speech', samples: await decodeToSamples(bytesOf(r.data.audio)) });
        else if (r.type === 'music') items.push({ kind: 'music', vol: r.vol, samples: await librarySamples('music', r.name) });
        else items.push({ kind: 'sfx', name: r.name, vol: r.vol, over: r.over, wait: r.wait, ...(effectNames().includes(r.name) ? {} : { samples: await librarySamples('sfx', r.name) }) });
      }
      blob = new Blob([toWav(mix(items))], { type: 'audio/wav' });
    }
    const tagText = (r) => `[${r.type}:${r.name}${r.over ? ' over' : ''}${r.vol !== (r.type === 'music' ? 0.25 : 1) ? ` vol=${r.vol}` : ''}${r.wait ? ` wait=${r.wait}` : ''}]`;
    const scriptText = tagged.length ? results.map((r) => (r.type === 'speech' ? r.data.scriptText : tagText(r))).join(' ') : first.scriptText;
    showDraft({ blob, scriptText, input: meta.input, mode: meta.mode, textModel: meta.textModel, first, effects: tagged.map((p) => p.name) });
    status.textContent = `Preview ready${first.speechModel ? ` (${first.speechModel}${meta.textModel ? `, written by ${meta.textModel}` : ''})` : ''}. Listen, then save it or discard it.${first.cueTagsRemoved ? ' Delivery tags were removed (this model does not perform them).' : ''}${first.toneIgnored ? ' This model ignores tone.' : ''}`;
  }

  function showDraft(next) {
    if (draft) URL.revokeObjectURL(draft.url);
    draft = { ...next, url: URL.createObjectURL(next.blob) };
    const player = h('audio', { controls: true, src: draft.url });
    const saveStatus = h('span', { class: 'small muted', role: 'status' });
    const saveButton = h('button', { class: 'primary', type: 'button', onclick: async () => {
      saveButton.disabled = true; saveStatus.classList.remove('bad'); saveStatus.textContent = 'Saving...';
      try {
        const f = draft.first;
        const meta = { mode: draft.mode, input: draft.input, scriptText: draft.scriptText, voice: f.voice, provider: f.provider, speechModel: f.speechModel, textModel: draft.textModel, tone: state.tone.trim() || undefined, format: state.format || undefined, effects: draft.effects };
        const saved = await api.request('POST', '/clips', { raw: draft.blob, contentType: draft.blob.type, headers: { 'x-clip-meta': encodeURIComponent(JSON.stringify(meta)) } });
        toast(saved.handoff ? (saved.handoff.sent ? 'Saved and sent to the station.' : `Saved. Station hand-off failed: ${saved.handoff.error}`) : 'Saved to the library.', saved.handoff && !saved.handoff.sent ? 'error' : 'info');
        discard(); state.text = ''; if (textArea) textArea.value = ''; status.textContent = '';
        await loadClips();
      } catch (err) { saveStatus.textContent = err.message; saveStatus.classList.add('bad'); saveButton.disabled = false; }
    } }, 'Save to library');
    clear(draftBox, h('div', { class: 'clip' },
      h('div', { class: 'row small muted' }, h('span', { class: 'chip' }, 'preview, not saved yet'), draft.effects.length ? h('span', { class: 'chip' }, `effects: ${[...new Set(draft.effects)].join(', ')}`) : null, h('span', {}, `${(draft.blob.size / 1024).toFixed(0)} KB`)),
      h('p', { class: 'clip-script' }, draft.scriptText),
      player,
      h('div', { class: 'row' }, saveButton, h('button', { type: 'button', onclick: discard }, 'Discard'), saveStatus)));
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
          clip.speechModel ? h('span', { class: 'chip' }, clip.speechModel) : null, clip.tone ? h('span', { class: 'chip' }, clip.tone) : null),
        h('p', { class: 'clip-script' }, clip.scriptText),
        playButton(clip.id))) : h('p', { class: 'empty' }, 'No clips yet. Generate one above.'));
    } catch (err) {
      clear(clipsBox, h('p', { class: 'empty' }, `Failed to load clips: ${err.message}`));
    }
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
