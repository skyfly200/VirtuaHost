// The virtual host's settings for ONE station, and what that station's daemon last reported. Settings are per station (/api/host?station=<id>).
// `station` is the profile ({ id, name, builtin? }); the placeholder station uses the site-wide default settings.
import { h, clear, toast } from './kit.js';
import { modelVoiceFields } from './voicepicker.js';
import { createSpeaker } from './speaker.js';

export function mountHostCard(hostBox, api, { personas = [], station = null } = {}) {
  const query = station && !station.builtin ? { station: station.id } : {};
  clear(hostBox, h('p', { class: 'muted' }, 'Loading the virtual host...'));
  async function paintHost() {
    let data;
    let options;
    try { [data, options] = await Promise.all([api.get('/host', { query }), api.get('/options')]); } catch (err) { clear(hostBox, h('h2', {}, 'Virtual host'), h('p', { class: 'bad' }, err.message)); return; }
    const c = { ...data.config };
    const st = data.status;
    const age = st ? Math.round((Date.now() - Date.parse(st.reportedAt)) / 1000) : null;
    const fresh = age !== null && age < 120;
    const check = (label, key) => h('label', { class: 'row' }, h('input', { type: 'checkbox', checked: c[key], onchange: (e) => { c[key] = e.target.checked; } }), label);
    const num = (label, key, min, max) => h('label', { class: 'field' }, label, h('input', { type: 'number', min, max, value: c[key], oninput: (e) => { c[key] = Number(e.target.value); } }));
    const txt = (label, key, placeholder) => h('label', { class: 'field' }, label, h('input', { value: c[key] || '', placeholder, oninput: (e) => { c[key] = e.target.value; } }));
    const pick = (label, key, values, blankLabel) => h('label', { class: 'field' }, label,
      h('select', { onchange: (e) => { c[key] = e.target.value; if (key === 'personaId') { syncDefaults(); voiceBox.refresh(); voiceBox.invalidate(); } } }, blankLabel ? h('option', { value: '' }, blankLabel) : null, values.map(([v, t]) => h('option', { value: v, selected: v === c[key] }, t))));
    const skip = h('textarea', { rows: 3, 'aria-label': 'Skip list', oninput: (e) => { c.skipArtists = e.target.value.split('\n').map((l) => l.trim()); } });
    skip.value = c.skipArtists.join('\n');
    // The persona's own voice and models are what a blank falls back to: show them, and follow the persona when it changes.
    const speaker = createSpeaker(api, options.features);
    const defaults = { label: 'the persona' };
    const syncDefaults = () => {
      const p = personas.find((x) => x.id === c.personaId);
      Object.assign(defaults, { label: p ? p.name : 'the site default', speechModel: p && p.speechModel, voice: p && p.voice, textModel: p && p.textModel });
    };
    syncDefaults();
    const voiceBox = modelVoiceFields({
      options, value: c, defaults, onchange: () => {},
      sample: async (v) => { const p = personas.find((x) => x.id === c.personaId); return URL.createObjectURL((await speaker.render(`That was a fine song. You are listening to ${station ? station.name : 'the station'}.`, { ...((v.speechModel || (p && p.speechModel)) && options.models.choosable ? { speechModel: v.speechModel || p.speechModel } : {}), ...((v.voice || (p && p.voice)) ? { voice: v.voice || p.voice } : {}), ...((c.tone || (p && p.tone)) ? { tone: c.tone || p.tone } : {}) })).blob); },
    });
    const preview = h('div', { class: 'small' });
    const artist = h('input', { placeholder: 'Artist', 'aria-label': 'Artist to try' });
    const title = h('input', { placeholder: 'Track title', 'aria-label': 'Title to try' });
    const save = h('button', { class: 'primary', type: 'button', onclick: async () => {
      save.disabled = true;
      try { await api.put('/host', c, { query }); toast('Virtual host saved.', 'info'); await paintHost(); } catch (err) { toast(err.message, 'error'); save.disabled = false; }
    } }, 'Save host settings');
    clear(hostBox,
      h('h3', {}, `Virtual host for ${station ? station.name : 'the station'}`),
      h('p', { class: 'muted small' }, 'Between songs the host says a short link about the track that just played, in the persona\'s voice. The site writes and voices it; the station daemon watches what is playing and puts it on air (see station-daemon/README.md).'),
      !st ? h('p', { class: 'note warn' }, 'The station daemon has not reported yet.')
        : h('div', { class: fresh ? 'hint small' : 'note warn small' },
          h('b', {}, fresh ? 'Station daemon connected' : `Station daemon last seen ${Math.round(age / 60)} min ago`), h('br'),
          st.current ? `Now playing: ${st.current.artist ? `${st.current.artist} - ` : ''}${st.current.title}` : 'Nothing playing reported.', h('br'),
          st.ready ? `Link ready (${st.ready.source}): "${st.ready.text}"` : 'No link waiting.', h('br'),
          st.last ? `Last said: "${st.last.text}"` : '', st.counters ? ` · prepared ${st.counters.prepared}, said ${st.counters.played}, skipped ${st.counters.skipped}, failed ${st.counters.failed}` : '',
          st.error ? h('div', { class: 'bad' }, st.error) : null),
      h('div', { class: 'grid' },
        check('Switched on', 'enabled'),
        h('div', { class: 'grid cols' },
          pick('Persona', 'personaId', personas.map((p) => [p.id, `${p.emoji || ''} ${p.name}`.trim()]), 'No persona'),
          pick('Lines', 'lines', [['template', 'From the persona\'s example lines'], ['llm', 'Written by the AI (falls back to the example lines)']]),
          pick('Audio treatment', 'fx', data.fxPresets.filter((f) => f !== 'none').map((f) => [f, f]), 'None')),
        h('div', { class: 'grid cols' }, num('A link after every Nth track', 'every', 1, 50), num('At least this many seconds apart', 'minGapSeconds', 0, 3600), check('May cut in over a live DJ', 'preempt')),
        txt('Tone (blank: the persona\'s)', 'tone', 'persona default'),
      h('div', {}, h('div', { class: 'label' }, 'Voice and models for the host (blank = the persona\'s, then the station\'s, then the site\'s default)'), voiceBox.el),
        h('label', { class: 'field' }, 'Skip list: spots and relays, one artist per line (nothing is said over or about them)', skip)),
      h('div', { class: 'row' }, save),
      h('div', { class: 'grid cols' }, artist, title, h('button', { type: 'button', onclick: async (e) => {
        const b = e.currentTarget; b.disabled = true;
        try { const out = await api.post('/host/preview', { artist: artist.value, title: title.value }, { query }); clear(preview, h('b', {}, `Would say (${out.source}): `), out.text, out.note ? h('div', { class: 'bad' }, out.note) : null); } catch (err) { clear(preview, h('span', { class: 'bad' }, err.message)); } finally { b.disabled = false; }
      } }, 'Preview a link (saved settings)')),
      preview);
  }
  return paintHost();
}
