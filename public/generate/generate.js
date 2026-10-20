// Generate tab: make a clip with the AI (OpenRouter or Gemini). Pick what kind of line it is, the tone, the models and the voice.
import { h, clear, toast, fmtDate, audioUrl } from '../shared/kit.js';

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

  const prefs = loadPrefs();
  const state = {
    mode: prefs.mode === 'ai' ? 'ai' : 'say', format: prefs.format || '', tone: prefs.tone || '',
    textModel: prefs.textModel || options.models.defaultText, speechModel: prefs.speechModel || options.models.defaultSpeech, voice: prefs.voice || '',
    textCustom: '', speechCustom: '', text: '',
  };
  const persist = () => savePrefs({ mode: state.mode, format: state.format, tone: state.tone, textModel: state.textModel, speechModel: state.speechModel, voice: state.voice });
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
    const voiceList = h('datalist', { id: 'voice-list' });
    function paintVoices() {
      const entry = options.models.speech.find((m) => m.id === state.speechModel);
      const voices = entry && entry.voice ? [entry.voice] : [];
      if (entry && entry.voices) for (const v of entry.voices) if (!voices.includes(v)) voices.push(v);
      if (options.provider === 'gemini' || state.speechModel.startsWith('google/')) for (const v of GEMINI_VOICES) if (!voices.includes(v)) voices.push(v);
      clear(voiceList, voices.map((v) => h('option', { value: v })));
      if (voiceInput) voiceInput.placeholder = entry && (entry.voice || (entry.voices && entry.voices[0])) ? `default: ${entry.voice || entry.voices[0]}` : 'model default';
    }
    const voiceInput = h('input', { value: state.voice, list: 'voice-list', placeholder: 'model default', autocomplete: 'off', 'aria-label': 'Voice', oninput: (e) => { state.voice = e.target.value; persist(); } });
    paintVoices();

    clear(form,
      h('div', { class: 'row' },
        ['say', 'ai'].map((mode) => h('button', { type: 'button', class: state.mode === mode ? 'seg on' : 'seg', onclick: () => { state.mode = mode; persist(); paintForm(); } }, mode === 'say' ? 'Say verbatim' : 'Ask the AI to write it'))),
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
      h('details', { class: 'tips' }, h('summary', {}, 'Writing tips and structure'), h('ul', {},
        h('li', {}, h('b', {}, 'Keep it short. '), 'One to three sentences is 5 to 15 seconds on air. Shape: a hook, the information, then a sign-off or station name.'),
        h('li', {}, h('b', {}, 'Say it the way it should sound. '), 'Write times and numbers as spoken ("nine thirty", not "9:30"), and add commas where you want a breath.'),
        h('li', {}, h('b', {}, 'Give the AI facts. '), 'It only knows what you put in the brief (artist, title, time, event details) and is told not to invent the rest.'),
        h('li', {}, h('b', {}, 'Delivery tags '), 'in square brackets work on Gemini speech models, for example ', h('code', {}, '[softly]'), ', ', h('code', {}, '[excited]'), ', ', h('code', {}, '[laughs]'), ', ', h('code', {}, '[short pause]'), '. Other voices may read them aloud, so test first.'),
        h('li', {}, h('b', {}, 'Tone '), 'guides the AI writer and is sent to the voice as a direction ("Say in a warm tone"). The same text can sound very different per model: generate, listen, adjust.'),
        h('li', {}, h('b', {}, 'Sound effects '), 'like ', h('code', {}, '[sfx:ding]'), ' are removed here (these speech models cannot mix them). Use the Voice Lab or the station to add them.'))),
      h('div', {}, h('button', { class: 'primary', id: 'generate-btn', onclick: submit }, 'Generate')),
      status);
  }

  const chosen = (key, customKey) => (state[key] === OTHER ? state[customKey].trim() : state[key]);

  async function submit(e) {
    const value = state.text.trim();
    status.classList.remove('bad');
    if (!value) { status.textContent = state.mode === 'say' ? 'Enter text to speak.' : 'Enter a brief for the AI.'; status.classList.add('bad'); return; }
    const button = e.currentTarget;
    button.disabled = true;
    status.textContent = 'Generating (this calls the AI live and can take a few seconds)...';
    try {
      const body = state.mode === 'say' ? { mode: 'say', text: value } : { mode: 'ai', prompt: value };
      if (state.format) body.format = state.format;
      if (state.tone.trim()) body.tone = state.tone.trim();
      if (state.voice.trim()) body.voice = state.voice.trim();
      if (options.models.choosable) {
        const speechModel = chosen('speechModel', 'speechCustom');
        if (speechModel) body.speechModel = speechModel;
        if (state.mode === 'ai') { const textModel = chosen('textModel', 'textCustom'); if (textModel) body.textModel = textModel; }
      }
      const data = await api.post('/generate', body);
      status.textContent = `Done${data.speechModel ? ` (${data.speechModel}${data.textModel ? `, written by ${data.textModel}` : ''})` : ''}: "${data.scriptText}"${data.handoff ? (data.handoff.sent ? ' Sent to the station.' : ` Station hand-off failed: ${data.handoff.error}`) : ''}`;
      state.text = ''; textArea.value = '';
      await loadClips();
    } catch (err) {
      status.textContent = err.message; status.classList.add('bad');
    } finally {
      button.disabled = false;
    }
  }

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
    h('section', { class: 'card' }, h('h2', {}, 'Generate a clip'), note, form),
    h('section', { class: 'card' }, h('h2', {}, 'Clips'), clipsBox)));
  paintForm();
  await loadClips();
}
