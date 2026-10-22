// The voice and model that belong to something (a persona, the virtual host, a station, a promo): the speech model, the voice (with
// suggestions from that model), the writing model, and a button to hear the result. A blank means "use the default", and the default
// is shown, so you can see what you would get. Values are kept in `value` and reported through `onchange`.
import { h, clear } from './kit.js';
import { createPlayer } from './playbutton.js';
import { modelLabel, isOffered, flagOf } from './modelinfo.js';

// options: GET /api/options. value: { speechModel, voice, textModel }. defaults: { speechModel, voice, textModel, label } shown for a blank.
// sample: optional async (value) => object URL of a short sample in this voice; adds a play button.
export function modelVoiceFields({ options, value, defaults = {}, onchange, sample, writing = true, disabled = false }) {
  const choosable = options.models.choosable;
  const speech = choosable ? options.models.speech || [] : [];
  const texts = choosable ? (options.models.text || []).filter((m) => isOffered(options, m) || m === (value && value.textModel)) : [];
  const where = defaults.label || 'the default';
  const tierLabel = (id) => modelLabel(options, id);
  const box = h('div', { class: 'grid' });
  const row = h('div', { class: 'grid cols' });
  let player = null;

  const changed = () => { if (player) player.invalidate(); onchange(value); };

  function paint() {
    const entry = speech.find((m) => m.id === (value.speechModel || defaults.speechModel || options.models.defaultSpeech));
    const voices = [...new Set([entry && entry.voice, ...((entry && entry.voices) || [])].filter(Boolean))];
    const effectiveVoice = value.voice || defaults.voice || (entry && entry.voice) || '';
    const fields = [];
    if (choosable) {
      fields.push(h('label', { class: 'field' }, 'Speech model (the voice)',
        h('select', { disabled, onchange: (e) => { value.speechModel = e.target.value; value.voice = ''; changed(); paint(); } },
          h('option', { value: '' }, `Use ${defaults.speechModel ? `${where}: ${defaults.speechModel}` : `the default: ${options.models.defaultSpeech}`}`),
          speech.map((m) => h('option', { value: m.id, selected: m.id === value.speechModel }, tierLabel(m.id))))));
    }
    fields.push(h('label', { class: 'field' }, 'Voice',
      h('input', { value: value.voice || '', disabled, list: 'mv-voices', placeholder: effectiveVoice ? `${defaults.voice ? where : 'model default'}: ${effectiveVoice}` : 'model default', autocomplete: 'off', oninput: (e) => { value.voice = e.target.value; changed(); } }),
      h('datalist', { id: 'mv-voices' }, voices.slice(0, 300).map((v) => h('option', { value: v })))));
    if (writing && choosable) {
      fields.push(h('label', { class: 'field' }, 'Writing model (the words)',
        h('select', { disabled, onchange: (e) => { value.textModel = e.target.value; changed(); } },
          h('option', { value: '' }, `Use ${defaults.textModel ? `${where}: ${defaults.textModel}` : `the default: ${options.models.defaultText}`}`),
          texts.map((m) => h('option', { value: m, selected: m === value.textModel, title: flagOf(options, m) ? flagOf(options, m).note : undefined }, tierLabel(m))))));
    }
    clear(row, fields);
  }
  paint();

  const parts = [row];
  if (sample) {
    player = createPlayer({ label: 'Hear this voice', load: () => sample(value) });
    parts.push(h('div', { class: 'row' }, player.button, h('span', { class: 'small muted' }, 'Hear this voice'), player.download('voice-sample')));
  }
  clear(box, parts);
  return { el: box, value, refresh: paint, invalidate: () => player && player.invalidate() };
}
