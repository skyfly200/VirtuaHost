// Stations tab: station profiles. Set a station up before it has a server; everything here is plain data on the site, and the other tabs
// use it (the station's name in AI-written lines, its time zone for schedules and promos, its default persona, voice and treatment).
// Connecting a real Icecast / Liquidsoap / hub later is a separate step (station-daemon/README.md); nothing here needs one.
import { h, clear, toast } from '../shared/kit.js';
import { loadStations, setStation, currentStation, allStations } from '../shared/station.js';
import { mountHostCard } from '../shared/hostcard.js';
import { modelVoiceFields } from '../shared/voicepicker.js';
import { createSpeaker } from '../shared/speaker.js';
import { keyBox } from '../shared/keybox.js';

const blank = () => ({ name: '', callsign: '', frequency: '', tagline: '', description: '', emoji: '📻', color: '#5b3df5', genres: [], city: '', tz: Intl.DateTimeFormat().resolvedOptions().timeZone || 'UTC', website: '', streamUrl: '', contact: '', links: [], defaultPersonaId: '', defaultFx: '', defaultSpeechModel: '', defaultTextModel: '', defaultVoice: '', skipArtists: [], autoplay: false, preempt: false, notes: '', connection: { kind: 'none', hubStationId: '', note: '' } });
const LINES = (v) => v.split('\n').map((l) => l.trim()).filter(Boolean);
const clock = (tz) => { try { return new Intl.DateTimeFormat([], { timeZone: tz, weekday: 'short', hour: 'numeric', minute: '2-digit' }).format(new Date()); } catch { return ''; } };
const when = (iso) => (iso ? new Date(iso).toLocaleString([], { weekday: 'short', month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' }) : '');
const CONNECTIONS = [['none', 'Not connected yet'], ['chips-voice', 'A Chips Voice server (Icecast + Liquidsoap)'], ['radiodj', 'RadioDJ (through its agent)'], ['icecast', 'Just an Icecast stream']];

export async function mountStationProfiles(root, api) {
  clear(root, h('p', { class: 'muted' }, 'Loading...'));
  let stations; let personas = []; let options; let fxPresets = [];
  try {
    stations = await loadStations(api);
    [{ personas }, options] = await Promise.all([api.get('/personas').catch(() => ({ personas: [] })), api.get('/options')]);
    fxPresets = ((await api.get('/host').catch(() => ({}))).fxPresets || []).filter((f) => f !== 'none');
  } catch (err) { clear(root, h('p', { class: 'bad' }, `Could not load stations: ${err.message}`)); return; }

  const gridBox = h('div', { style: 'display:grid;grid-template-columns:repeat(auto-fill,minmax(300px,1fr));gap:12px' });
  const editorBox = h('div');
  const hostBox = h('section', { class: 'card' });
  let editing = null;

  const changed = async () => { stations = await loadStations(api); window.dispatchEvent(new CustomEvent('vh-stations')); paintGrid(); };

  // ---------- the cards ----------
  function paintGrid() {
    const active = currentStation();
    clear(gridBox, stations.map((s) => {
      const summary = h('div', { class: 'small muted' }, 'Counting...');
      api.get(`/stations/${encodeURIComponent(s.id)}/summary`).then((m) => {
        clear(summary, `${m.clips} clip${m.clips === 1 ? '' : 's'}${m.promos ? ` (${m.promos} promo${m.promos === 1 ? '' : 's'})` : ''} · ${m.schedulesOn} schedule${m.schedulesOn === 1 ? '' : 's'} on${m.nextRun ? `, next ${when(m.nextRun)}` : ''} · ${m.queued} waiting for the station${m.hostSeenAt ? ` · host seen ${when(m.hostSeenAt)}` : ''}`);
      }).catch(() => clear(summary, ''));
      const isActive = active && active.id === s.id;
      return h('div', { class: 'clip', style: `border-left:5px solid ${s.color || 'var(--accent)'}` },
        h('div', { class: 'row' }, h('span', { style: 'font-size:30px;line-height:1' }, s.emoji || '📻'),
          h('div', { class: 'grow' }, h('strong', {}, s.name), h('div', { class: 'small muted' }, [s.callsign, s.frequency].filter(Boolean).join(' · '))),
          isActive ? h('span', { class: 'chip' }, 'working on') : null, s.builtin ? h('span', { class: 'chip' }, 'placeholder') : null),
        s.tagline ? h('p', { class: 'small' }, `"${s.tagline}"`) : null,
        h('p', { class: 'small muted' }, [s.city, s.tz && `${s.tz} (${clock(s.tz)})`].filter(Boolean).join(' · ')),
        h('div', { class: 'row small', style: 'gap:4px' }, (s.genres || []).map((g) => h('span', { class: 'chip' }, g)),
          h('span', { class: 'chip', title: 'No server is needed for any of this' }, s.connection.kind === 'none' ? 'not connected' : `will use: ${s.connection.kind}`)),
        summary,
        h('div', { class: 'row' },
          h('button', { type: 'button', class: isActive ? '' : 'primary', disabled: isActive, onclick: () => { setStation(s.id); paintGrid(); toast(`Now working on ${s.name}. The other tabs use it.`, 'info'); } }, isActive ? 'Working on it' : 'Work on this station'),
          h('button', { type: 'button', onclick: () => edit(s) }, s.builtin ? 'Make it yours' : 'Edit'),
          s.builtin ? null : h('button', { type: 'button', onclick: () => edit({ ...s, id: undefined, name: `${s.name} (copy)` }) }, 'Duplicate'),
          s.builtin ? null : h('button', { type: 'button', class: 'link', onclick: () => exportStation(s) }, 'Export')));
    }));
  }

  function exportStation(s) {
    const rest = { ...s };
    for (const k of ['id', 'builtin', 'updatedAt']) delete rest[k];
    const url = URL.createObjectURL(new Blob([JSON.stringify(rest, null, 2)], { type: 'application/json' }));
    const a = h('a', { href: url, download: `${s.id}.station.json` });
    document.body.append(a); a.click(); a.remove(); setTimeout(() => URL.revokeObjectURL(url), 2000);
  }
  async function importFiles(files) {
    let made = 0;
    for (const file of files) {
      try { const data = JSON.parse(await file.text()); for (const item of Array.isArray(data) ? data : [data]) { await api.post('/stations', item); made += 1; } } catch (err) { toast(`${file.name}: ${err.message}`, 'error'); }
    }
    if (made) { toast(`Imported ${made} station${made > 1 ? 's' : ''}.`, 'info'); await changed(); }
  }

  // ---------- the editor ----------
  function edit(station) {
    // The placeholder becomes a real station with the same name when you "make it yours".
    editing = { ...blank(), ...station, id: station.builtin ? undefined : station.id, builtin: false, connection: { kind: 'none', hubStationId: '', note: '', ...(station.connection || {}) }, links: [...(station.links || [])], genres: [...(station.genres || [])], skipArtists: [...(station.skipArtists || [])] };
    paintEditor();
    editorBox.scrollIntoView({ behavior: 'smooth', block: 'nearest' });
  }

  function paintEditor() {
    const c = editing;
    if (!c) { clear(editorBox); clear(hostBox); return; }
    const text = (label, key, props = {}) => h('label', { class: 'field' }, label, h('input', { ...props, value: c[key] || '', oninput: (e) => { c[key] = e.target.value; } }));
    const area = (label, key, rows = 3, props = {}) => h('label', { class: 'field' }, label, Object.assign(h('textarea', { rows, ...props, oninput: (e) => { c[key] = e.target.value; } }), { value: c[key] || '' }));
    const listField = (label, key, rows, placeholder) => h('label', { class: 'field' }, label, Object.assign(h('textarea', { rows, placeholder, oninput: (e) => { c[key] = LINES(e.target.value); } }), { value: (c[key] || []).join('\n') }));
    const zones = h('datalist', { id: 'st-zones' }, (Intl.supportedValuesOf ? Intl.supportedValuesOf('timeZone') : []).map((z) => h('option', { value: z })));
    const links = h('div', { class: 'stack' });
    const paintLinks = () => clear(links, c.links.map((l, i) => h('div', { class: 'grid cols' },
      h('input', { value: l.label, placeholder: 'Label', 'aria-label': 'Link label', oninput: (e) => { l.label = e.target.value; } }),
      h('input', { value: l.url, placeholder: 'https://...', 'aria-label': 'Link address', oninput: (e) => { l.url = e.target.value; } }),
      h('button', { type: 'button', class: 'link danger', onclick: () => { c.links.splice(i, 1); paintLinks(); } }, 'Remove'))),
    c.links.length < 12 ? h('button', { type: 'button', onclick: () => { c.links.push({ label: '', url: '' }); paintLinks(); } }, 'Add a link') : null);
    paintLinks();
    // The voice and models new clips for this station use by default (a persona or a request can still choose differently).
    const speaker = createSpeaker(api, options.features);
    const defaults = { speechModel: c.defaultSpeechModel || '', voice: c.defaultVoice || '', textModel: c.defaultTextModel || '' };
    const voiceBox = modelVoiceFields({
      options, value: defaults,
      onchange: (v) => { c.defaultSpeechModel = v.speechModel; c.defaultVoice = v.voice; c.defaultTextModel = v.textModel; },
      sample: async (v) => URL.createObjectURL((await speaker.render(`This is ${c.name || 'the station'}${c.tagline ? `. ${c.tagline}` : ''}.`, { ...(v.speechModel && options.models.choosable ? { speechModel: v.speechModel } : {}), ...(v.voice ? { voice: v.voice } : {}) })).blob),
    });
    const select = (label, key, pairs, blankLabel) => h('label', { class: 'field' }, label, h('select', { onchange: (e) => { c[key] = e.target.value; } }, h('option', { value: '' }, blankLabel), pairs.map(([v, t]) => h('option', { value: v, selected: v === c[key] }, t))));

    const save = h('button', { class: 'primary', type: 'button', onclick: async () => {
      save.disabled = true;
      try {
        const body = { ...c, genres: c.genres };
        const { station } = c.id ? await api.put(`/stations/${encodeURIComponent(c.id)}`, body) : await api.post('/stations', body);
        await changed();
        if (!c.id) setStation(station.id);
        editing = { ...blank(), ...station }; paintEditor(); paintGrid(); toast('Station saved.', 'info');
      } catch (err) { toast(err.message, 'error'); save.disabled = false; }
    } }, c.id ? 'Save changes' : 'Create station');
    const del = c.id ? h('button', { type: 'button', onclick: async () => {
      if (!confirm(`Delete "${c.name}"? Clips and schedules made for it stay, but lose the link to it.`)) return;
      try { await api.del(`/stations/${encodeURIComponent(c.id)}`); editing = null; await changed(); paintEditor(); toast('Deleted.', 'info'); } catch (err) { toast(err.message, 'error'); }
    } }, 'Delete') : null;

    clear(editorBox, h('section', { class: 'card' },
      h('h2', {}, c.id ? `Edit ${c.name}` : 'New station'),
      h('p', { class: 'muted small' }, 'None of this needs a server. It is the station\'s profile; other tabs use it as soon as you choose "Work on this station".'),
      h('h3', {}, 'Who it is'),
      h('div', { class: 'grid cols' }, text('Emoji', 'emoji', { placeholder: '📻' }), text('Name', 'name'), text('Call sign', 'callsign', { placeholder: 'e.g. KRAP' }), text('On the dial', 'frequency', { placeholder: '97.7 FM' })),
      h('div', { class: 'grid cols' }, text('Tagline', 'tagline', { placeholder: 'the line the AI hosts say' }), h('label', { class: 'field' }, 'Accent colour', h('input', { type: 'color', value: c.color || '#5b3df5', oninput: (e) => { c.color = e.target.value; } }))),
      area('About it', 'description', 3),
      listField('Genres and vibes (one per line)', 'genres', 3, 'punk\ntalk\nlate night'),
      h('h3', {}, 'Where it is'),
      h('div', { class: 'grid cols' }, text('City', 'city'), h('label', { class: 'field' }, 'Time zone (its wall clock: schedules and promos use it)', h('input', { value: c.tz, list: 'st-zones', oninput: (e) => { c.tz = e.target.value; } }), zones), text('Contact', 'contact', { placeholder: 'studio line or email' })),
      h('div', { class: 'grid cols' }, text('Website', 'website', { placeholder: 'https://' }), text('Stream address', 'streamUrl', { placeholder: 'https://.../stream' })),
      h('div', {}, h('div', { class: 'label' }, 'Links (chat, socials, schedule page)'), links),
      h('h3', {}, 'How new clips sound by default'),
      h('div', { class: 'grid cols' },
        select('Persona', 'defaultPersonaId', personas.map((p) => [p.id, `${p.emoji || ''} ${p.name}`.trim()]), 'None'),
        fxPresets.length ? select('Audio treatment at the station', 'defaultFx', fxPresets.map((f) => [f, f]), 'None') : null),
      voiceBox.el,
      h('h3', {}, 'Allowed models'),
      h('p', { class: 'small muted' }, 'Optional. Limit this station to these models, one per line (OpenRouter names like openai/gpt-4o-mini; a speech model may add a voice: hexgrad/kokoro-82m|af_heart). Empty uses the site\'s list. The limit applies even to people using their own key.'),
      h('div', { class: 'grid cols' }, listField('Writing models', 'textModels', 4, 'openai/gpt-4o-mini'), listField('Speech models', 'speechModels', 4, 'hexgrad/kokoro-82m|af_heart')),
      c.id ? keyBox(api, { station: c.id }) : null,
      listField('Skip list: spots and relays, one artist per line (the host says nothing over or about them)', 'skipArtists', 3, 'Jingle Radio'),
      h('h3', {}, 'Sending clips to this station'),
      h('p', { class: 'muted small' }, 'Defaults for clips made for this station. A request, a schedule or a button press can still choose differently.'),
      h('div', { class: 'grid cols' },
        h('label', { class: 'row' }, h('input', { type: 'checkbox', checked: Boolean(c.autoplay), onchange: (e) => { c.autoplay = e.target.checked; } }), 'Put new clips on air as soon as they arrive'),
        h('label', { class: 'row' }, h('input', { type: 'checkbox', checked: Boolean(c.preempt), onchange: (e) => { c.preempt = e.target.checked; } }), 'May cut in over a live DJ')),
      h('h3', {}, 'Connection (later)'),
      h('p', { class: 'muted small' }, 'Record what this station will connect to once it has a server. It is only a note for now; nothing connects.'),
      h('div', { class: 'grid cols' },
        h('label', { class: 'field' }, 'Will use', h('select', { onchange: (e) => { c.connection.kind = e.target.value; } }, CONNECTIONS.map(([v, t]) => h('option', { value: v, selected: v === c.connection.kind }, t)))),
        h('label', { class: 'field' }, 'Its id in the hub (optional)', h('input', { value: c.connection.hubStationId || '', oninput: (e) => { c.connection.hubStationId = e.target.value; } })),
        h('label', { class: 'field' }, 'Note', h('input', { value: c.connection.note || '', placeholder: 'e.g. VPS ready in May', oninput: (e) => { c.connection.note = e.target.value; } }))),
      area('Notes', 'notes', 3),
      h('div', { class: 'row' }, save, del, h('button', { type: 'button', onclick: () => { editing = null; paintEditor(); } }, 'Close'))));
    // The virtual host is configured per station, so it belongs to a saved one.
    if (c.id) mountHostCard(hostBox, api, { personas, station: c });
    else clear(hostBox, h('h3', {}, 'Virtual host'), h('p', { class: 'muted small' }, 'Save the station first, then set up its virtual host here.'));
  }

  const importInput = h('input', { type: 'file', accept: '.json,application/json', multiple: true, hidden: true, onchange: (e) => { importFiles([...e.target.files]); e.target.value = ''; } });
  clear(root, h('div', { class: 'stack' },
    h('section', { class: 'card' },
      h('div', { class: 'row' }, h('h2', { class: 'grow' }, 'Stations'),
        h('button', { class: 'primary', type: 'button', onclick: () => edit(blank()) }, 'Add a station'),
        h('button', { type: 'button', onclick: () => importInput.click() }, 'Import'), importInput),
      h('p', { class: 'muted small' }, 'Set stations up now, before they have servers. The one marked "working on" (also in the header) is used by every other tab: its name in AI-written lines, its time zone for schedules and promos, its default persona, voice and treatment, and clips are tagged with it.'),
      allStations().length === 1 && allStations()[0].builtin ? h('p', { class: 'note warn small' }, 'This is a placeholder named from the site\'s STATION_NAME setting. Add your own station to replace it.') : null,
      gridBox),
    editorBox, hostBox));
  paintGrid();
}
