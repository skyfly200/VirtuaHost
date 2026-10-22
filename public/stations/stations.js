// Stations tab: station profiles. Set a station up before it has a server; everything here is plain data on the site, and the other tabs
// use it (the station's name in AI-written lines, its time zone for schedules and promos, its default persona, voice and treatment).
// Connecting a real Icecast / Liquidsoap / hub later is a separate step (station-daemon/README.md); nothing here needs one.
import { h, clear, toast } from '../shared/kit.js';
import { loadStations, setStation, currentStation, allStations } from '../shared/station.js';
import { mountHostCard } from '../shared/hostcard.js';
import { modelVoiceFields } from '../shared/voicepicker.js';
import { createSpeaker } from '../shared/speaker.js';
import { keyBox } from '../shared/keybox.js';

const blank = () => ({ name: '', callsign: '', frequency: '', tagline: '', description: '', emoji: '📻', color: '#5b3df5', genres: [], city: '', tz: Intl.DateTimeFormat().resolvedOptions().timeZone || 'UTC', website: '', streamUrl: '', contact: '', links: [], defaultPersonaId: '', defaultFx: '', defaultSpeechModel: '', defaultTextModel: '', defaultVoice: '', skipArtists: [], place: null, coverageKm: '', transmitter: null, lat: '', lon: '', tempUnit: '', variablesText: '', autoplay: false, preempt: false, notes: '', connection: { kind: 'none', hubStationId: '', note: '' } });
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
    editing = { ...blank(), ...station, id: station.builtin ? undefined : station.id, builtin: false, connection: { kind: 'none', hubStationId: '', note: '', ...(station.connection || {}) }, links: [...(station.links || [])], genres: [...(station.genres || [])], skipArtists: [...(station.skipArtists || [])], variablesText: Object.entries(station.variables || {}).map(([k, v]) => `${k}=${v}`).join('\n'), lat: station.lat ?? '', lon: station.lon ?? '' };
    paintEditor();
    editorBox.scrollIntoView({ behavior: 'smooth', block: 'nearest' });
  }

  function paintEditor() {
    const c = editing;
    if (!c) { clear(editorBox); clear(hostBox); return; }
    const text = (label, key, props = {}) => h('label', { class: 'field' }, label, h('input', { ...props, value: c[key] || '', oninput: (e) => { c[key] = e.target.value; } }));
    const area = (label, key, rows = 3, props = {}) => h('label', { class: 'field' }, label, Object.assign(h('textarea', { rows, ...props, oninput: (e) => { c[key] = e.target.value; } }), { value: c[key] || '' }));
    const listField = (label, key, rows, placeholder) => h('label', { class: 'field' }, label, Object.assign(h('textarea', { rows, placeholder, oninput: (e) => { c[key] = LINES(e.target.value); } }), { value: (c[key] || []).join('\n') }));
    // Two clocks, never mixed up: the station's own (what listeners hear and schedules use) and the playout PC's (only for reading the PC's timestamps).
    const offset = (zone) => { try { const p = Object.fromEntries(new Intl.DateTimeFormat('en-US', { timeZone: zone, hourCycle: 'h23', year: 'numeric', month: 'numeric', day: 'numeric', hour: 'numeric', minute: 'numeric', second: 'numeric' }).formatToParts(new Date()).filter((x) => x.type !== 'literal').map((x) => [x.type, Number(x.value)])); return Math.round((Date.UTC(p.year, p.month - 1, p.day, p.hour % 24, p.minute, p.second) - Math.floor(Date.now() / 1000) * 1000) / 60000); } catch { return null; } };
    const warnBox = h('div', { class: 'stack' });
    const paintWarnings = () => {
      const list = [];
      const a = c.broadcastTz || c.tz; const b = c.machineTz;
      if (a && b && offset(a) !== null && offset(b) !== null && offset(a) !== offset(b)) list.push({ level: 'warn', message: `The PC clock (${b}) and the broadcast clock (${a}) differ by ${Math.abs(offset(a) - offset(b)) / 60} hour(s) right now. Times from the PC are converted; on-air wording uses ${a}.` });
      for (const w of c.warnings || []) if (!(w.code === 'zones-differ' && list.length)) list.push(w);
      if (c.lat === '' || c.lat === undefined) if (!c.city && !(c.warnings || []).some((w) => w.code === 'weather-location-missing')) list.push({ level: 'warn', message: '{{weather}} and {{temp}} need a place: set the city, or find the town above. Until then they are left out of the spoken line.' });
      clear(warnBox, list.map((w) => h('p', { class: `small ${w.level === 'error' ? 'bad' : ''}`, role: w.level === 'error' ? 'alert' : undefined, style: 'margin:2px 0;padding:6px 10px;border:1px solid currentColor;border-radius:6px' }, `${w.level === 'error' ? '⛔ ' : '⚠ '}${w.message}`)));
    };
    const zoneField = (label, key, help, onSet) => h('label', { class: 'field' }, label, h('input', { value: c[key] || '', list: 'st-zones', placeholder: 'e.g. America/Denver', oninput: (e) => { onSet(e.target.value.trim()); paintWarnings(); } }), h('span', { class: 'small muted' }, help));
    const clocks = h('div', { class: 'grid cols' },
      zoneField('Broadcast time zone', 'tz', 'The station\'s own clock: {{time}}, schedules, "tonight at 7", weather and alert wording.', (v) => { c.tz = v; c.broadcastTz = v; }),
      zoneField('Playout PC time zone', 'machineTz', 'Only for a RadioDJ PC whose clock is in another zone. Used just to read the PC\'s own timestamps.', (v) => { c.machineTz = v; }));
    const zones = h('datalist', { id: 'st-zones' }, (Intl.supportedValuesOf ? Intl.supportedValuesOf('timeZone') : []).map((z) => h('option', { value: z })));
    const links = h('div', { class: 'stack' });
    const paintLinks = () => clear(links, c.links.map((l, i) => h('div', { class: 'grid cols' },
      h('input', { value: l.label, placeholder: 'Label', 'aria-label': 'Link label', oninput: (e) => { l.label = e.target.value; } }),
      h('input', { value: l.url, placeholder: 'https://...', 'aria-label': 'Link address', oninput: (e) => { l.url = e.target.value; } }),
      h('button', { type: 'button', class: 'link danger', onclick: () => { c.links.splice(i, 1); paintLinks(); } }, 'Remove'))),
    c.links.length < 12 ? h('button', { type: 'button', onclick: () => { c.links.push({ label: '', url: '' }); paintLinks(); } }, 'Add a link') : null);
    paintLinks();
    paintWarnings();
    // The voice and models new clips for this station use by default (a persona or a request can still choose differently).
    const speaker = createSpeaker(api, options.features);
    const defaults = { speechModel: c.defaultSpeechModel || '', voice: c.defaultVoice || '', textModel: c.defaultTextModel || '' };
    const voiceBox = modelVoiceFields({
      options, value: defaults,
      onchange: (v) => { c.defaultSpeechModel = v.speechModel; c.defaultVoice = v.voice; c.defaultTextModel = v.textModel; },
      sample: async (v) => URL.createObjectURL((await speaker.render(`This is ${c.name || 'the station'}${c.tagline ? `. ${c.tagline}` : ''}.`, { ...(v.speechModel && options.models.choosable ? { speechModel: v.speechModel } : {}), ...(v.voice ? { voice: v.voice } : {}) })).blob),
    });
    const select = (label, key, pairs, blankLabel) => h('label', { class: 'field' }, label, h('select', { onchange: (e) => { c[key] = e.target.value; } }, h('option', { value: '' }, blankLabel), pairs.map(([v, t]) => h('option', { value: v, selected: v === c[key] }, t))));

    // Find the station's place by name (town, "Houston, TX"): fills in the city, coordinates and time zone, so nobody types latitude and longitude.
    const placeInput = h('input', { value: (c.place && c.place.label) || c.city || '', placeholder: 'Town or city, for example Houston, TX', 'aria-label': 'Find the station\'s place' });
    const placeResults = h('div', { class: 'stack' });
    const placeNote = h('p', { class: 'small muted' });
    const paintPlaceNote = () => clear(placeNote, c.place
      ? `📍 ${c.place.label}${c.lat !== '' && c.lat !== undefined ? ` (${c.lat}, ${c.lon})` : ''}${c.tz ? ` · ${c.tz}` : ''}. Used for weather, alerts, {{place}} and {{state}}, and to tell which stations are near an event.`
      : 'No place chosen yet. Search for the town or city; the coordinates and time zone are filled in for you.');
    paintPlaceNote();
    async function findPlace() {
      const q = placeInput.value.trim();
      if (q.length < 2) { toast('Type at least two letters of a town or city.', 'error'); return; }
      clear(placeResults, h('span', { class: 'muted small' }, 'Searching...'));
      try {
        const { places } = await api.get('/places', { query: { q } });
        clear(placeResults, places.length ? places.map((p) => h('button', { type: 'button', class: 'chip', title: `${p.lat}, ${p.lon}${p.tz ? ` · ${p.tz}` : ''}`, onclick: () => {
          c.place = { label: p.label, name: p.name, admin1: p.admin1, countryCode: p.countryCode };
          c.city = p.name; c.lat = p.lat; c.lon = p.lon; if (p.tz) { c.tz = p.tz; c.broadcastTz = p.tz; }
          paintEditor();
        } }, `${p.label}${p.population ? ` (${p.population.toLocaleString()})` : ''}`)) : h('span', { class: 'bad small' }, 'No match. Try the town name alone, or add the state ("Springfield, IL").'));
      } catch (err) { clear(placeResults, h('span', { class: 'bad small' }, err.message)); }
    }
    placeInput.addEventListener('keydown', (e) => { if (e.key === 'Enter') { e.preventDefault(); findPlace(); } });
    const placeBlock = h('div', { class: 'stack' },
      h('label', { class: 'field' }, 'Where is it? (find by name)', h('div', { class: 'row' }, placeInput, h('button', { type: 'button', onclick: findPlace }, 'Find'),
        c.place ? h('button', { type: 'button', class: 'link danger', onclick: () => { c.place = null; c.lat = ''; c.lon = ''; paintEditor(); } }, 'Clear') : null)),
      placeResults, placeNote,
      h('label', { class: 'field' }, 'Or just type how far it can be heard (km): used when there is no transmitter above', h('input', { type: 'number', min: 1, max: 3000, value: c.coverageKm || '', placeholder: 'e.g. 60', oninput: (e) => { c.coverageKm = e.target.value; } })));
    // The transmitter and antenna: a quick power-based estimate of where the station is heard (a circle, or a rough ellipse for a directional
    // antenna). It ignores terrain, so it is for decisions like "is this alert or event in range", not a coverage study (docs/COVERAGE.md).
    const tx = c.transmitter ||= { antenna: 'ground-plane', environment: 'suburban' };
    const txResult = h('div', { class: 'stack' });
    let txTimer = null; let txSeq = 0;
    const txNum = (label, key, props = {}) => h('label', { class: 'field' }, label, h('input', { type: 'number', step: 'any', min: 0, value: tx[key] ?? '', ...props, oninput: (e) => { tx[key] = e.target.value; refreshTx(); } }));
    const txDirectional = () => (tx.directional ||= { azimuthDeg: '', beamwidthDeg: '60', frontToBackDb: '20' });
    const diagram = (geo) => {
      const rings = geo.features; const [lon0, lat0] = [Number(c.lon), Number(c.lat)]; const k = Math.cos((lat0 * Math.PI) / 180);
      const pts = (f) => f.geometry.coordinates[0].map(([lo, la]) => [(lo - lon0) * k, -(la - lat0)]);
      const span = Math.max(...pts(rings[2]).flat().map(Math.abs)) || 1;
      const path = (f) => `M${pts(f).map(([x, y]) => `${(x / span) * 90 + 100},${(y / span) * 90 + 100}`).join('L')}Z`;
      const ns = 'http://www.w3.org/2000/svg';
      const el = (tag, attrs, text) => { const n = document.createElementNS(ns, tag); for (const [a, v] of Object.entries(attrs)) n.setAttribute(a, v); if (text) n.textContent = text; return n; };
      const svg = el('svg', { viewBox: '0 0 200 200', width: '200', height: '200', role: 'img', 'aria-label': 'Estimated coverage: strong, good and fringe rings around the transmitter' });
      [['fringe', .12], ['good', .22], ['strong', .4]].forEach(([name, op]) => svg.append(el('path', { d: path(rings.find((r) => r.properties.level === name)), fill: 'var(--accent, #5b3df5)', 'fill-opacity': op, stroke: 'var(--accent, #5b3df5)', 'stroke-width': '1' })));
      svg.append(el('circle', { cx: 100, cy: 100, r: 3, fill: 'currentColor' }), el('text', { x: 100, y: 10, 'text-anchor': 'middle', 'font-size': 10, fill: 'currentColor' }, 'N'));
      return svg;
    };
    async function refreshTx() {
      clearTimeout(txTimer);
      const mine = ++txSeq;
      txTimer = setTimeout(async () => {
        if (c.lat === '' || c.lat === undefined || c.lon === '' || c.lon === undefined) { clear(txResult, h('p', { class: 'small muted' }, 'Find the station\'s place first: the estimate needs its location.')); return; }
        if (!tx.heightFt || (!tx.powerWatts && !tx.erpWatts)) { clear(txResult, h('p', { class: 'small muted' }, 'Enter the transmitter power and the antenna height to see the estimate.')); return; }
        try {
          const { coverage } = await api.post('/coverage', { lat: c.lat, lon: c.lon, transmitter: tx });
          if (mine !== txSeq) return;
          if (!coverage) { clear(txResult, h('p', { class: 'small muted' }, 'Not enough to estimate yet.')); return; }
          const km = (n) => `${n.toFixed(n < 10 ? 1 : 0)} km (${(n * 0.621371).toFixed(n < 10 ? 1 : 0)} mi)`;
          clear(txResult, h('div', { class: 'row', style: 'align-items:flex-start' }, diagram(coverage.geojson),
            h('div', { class: 'stack small' }, h('strong', {}, `About ${coverage.erpWatts < 10 ? coverage.erpWatts.toFixed(2) : Math.round(coverage.erpWatts)} W effective radiated power`),
              coverage.levels.map((l) => h('div', {}, `${l.label} (${l.dbu} dBµV/m): `, h('strong', {}, km(l.km)))),
              h('details', {}, h('summary', {}, 'What this assumes'), h('ul', {}, coverage.assumptions.map((a) => h('li', {}, a)))))));
        } catch (err) { clear(txResult, h('p', { class: 'bad small' }, err.message)); }
      }, 350);
    }
    const antennaSelect = h('label', { class: 'field' }, 'Antenna', h('select', { onchange: (e) => { tx.antenna = e.target.value; paintEditor(); } },
      [['ground-plane', 'Quarter-wave ground plane (omni)'], ['dipole', 'Half-wave dipole (omni)'], ['collinear', 'Collinear / multi-bay (omni, about 3 dB gain)'], ['directional', 'Directional (yagi, panel)'], ['other', 'Other (enter the gain)']].map(([v, t]) => h('option', { value: v, selected: v === tx.antenna }, t))));
    const txBlock = h('div', { class: 'stack' },
      h('h3', {}, 'Transmitter and antenna (coverage estimate)'),
      h('p', { class: 'small muted' }, 'A quick estimate from power, antenna and height: a circle for an omni antenna, a rough ellipse for a directional one. It ignores hills and mountains, so use it to decide whether an alert or an event is in range, not as a coverage study. Used for which alerts to follow and which stations an event is near.'),
      h('div', { class: 'grid cols' }, txNum('Transmitter power (watts)', 'powerWatts', { placeholder: 'e.g. 5' }), antennaSelect, txNum('Antenna height above ground (feet)', 'heightFt', { placeholder: 'e.g. 50' })),
      h('div', { class: 'grid cols' },
        txNum('Antenna gain over a dipole (dB, optional)', 'gainDbd', { step: 'any', min: -20, placeholder: 'default for the antenna' }), txNum('Cable and connector loss (dB)', 'lossDb', { placeholder: '0' }),
        h('label', { class: 'field' }, 'Surroundings', h('select', { onchange: (e) => { tx.environment = e.target.value; refreshTx(); } }, [['open', 'Open country (no extra loss)'], ['suburban', 'Suburban / light trees (8 dB)'], ['urban', 'Dense city (16 dB)']].map(([v, t]) => h('option', { value: v, selected: v === tx.environment }, t))))),
      h('div', { class: 'grid cols' },
        txNum('Height above average terrain, HAAT (feet, optional)', 'haatFt', { placeholder: 'better than height above ground, esp. on a hill' }), txNum('Effective radiated power (watts, if you know it)', 'erpWatts', { placeholder: 'overrides power x gain' }), txNum('Frequency (MHz, optional)', 'frequencyMHz', { placeholder: 'e.g. 98.1' })),
      tx.antenna === 'directional' ? h('div', { class: 'grid cols' },
        h('label', { class: 'field' }, 'Points toward (degrees from north)', h('input', { type: 'number', min: 0, max: 360, value: txDirectional().azimuthDeg, oninput: (e) => { txDirectional().azimuthDeg = e.target.value; refreshTx(); } })),
        h('label', { class: 'field' }, 'Beamwidth (degrees)', h('input', { type: 'number', min: 10, max: 360, value: txDirectional().beamwidthDeg, oninput: (e) => { txDirectional().beamwidthDeg = e.target.value; refreshTx(); } })),
        h('label', { class: 'field' }, 'Weaker behind it by (dB)', h('input', { type: 'number', min: 0, max: 60, value: txDirectional().frontToBackDb, oninput: (e) => { txDirectional().frontToBackDb = e.target.value; refreshTx(); } }))) : null,
      txResult);
    refreshTx();
    const save = h('button', { class: 'primary', type: 'button', onclick: async () => {
      save.disabled = true;
      try {
        const body = { ...c, genres: c.genres, variables: c.variablesText };
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
      placeBlock,
      txBlock,
      h('div', { class: 'grid cols' }, text('City', 'city'), text('Contact', 'contact', { placeholder: 'studio line or email' })),
      clocks, zones,
      warnBox,
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
      h('h3', {}, 'Placeholders for drops'),
      h('p', { class: 'small muted' }, 'Drops can say {{time}}, {{weather}}, {{station}}, {{dj}} and more, filled in when the audio is made. Weather and alerts need a location: find the place above, or enter the coordinates here by hand.'),
      h('div', { class: 'grid cols' }, text('Latitude', 'lat', { placeholder: '29.76' }), text('Longitude', 'lon', { placeholder: '-95.37' }),
        h('label', { class: 'field' }, 'Temperature unit', h('select', { onchange: (e) => { c.tempUnit = e.target.value; } }, [['', 'Automatic (F in the Americas)'], ['F', 'Fahrenheit'], ['C', 'Celsius']].map(([v, t]) => h('option', { value: v, selected: v === (c.tempUnit || '') }, t))))),
      area('Your own placeholders, one per line as name=text (for example sponsor=Joe\'s Pizza, then {{sponsor}} in a drop)', 'variablesText', 3, { placeholder: 'sponsor=Joe\'s Pizza\nhotline=555 0100' }),
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
