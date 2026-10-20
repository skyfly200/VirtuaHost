// Control Panel: every station on one screen, plus the things that need several at once (broadcasts, playlists, copying host settings).
import { h, clear, toast, fmtDate } from '../shared/kit.js';

let client = null;   // set by mountPanel: a client for this site's /api/hub proxy
let app = null;
let timer = null;

const state = { stations: [], selected: new Set(), playlists: [], jobs: [], volumes: new Map(), results: null, coverage: null, editingPlaylist: null };
const stationName = (id) => (state.stations.find((s) => s.id === id) || { name: id }).name;
const debounce = (fn, ms = 350) => { let t; return (...a) => { clearTimeout(t); t = setTimeout(() => fn(...a), ms); }; };
const guard = (fn) => async (e) => {
  const b = e && e.currentTarget; if (b) b.disabled = true;
  try { await fn(e); } catch (err) { toast(err.message, 'error'); } finally { if (b) b.disabled = false; }
};

async function refresh({ quiet = true } = {}) {
  try {
    const [st, pl, jobs] = await Promise.all([client.get('/stations'), client.get('/playlists'), client.get('/jobs')]);
    const playlistsChanged = JSON.stringify(pl.playlists) !== JSON.stringify(state.playlists);
    state.stations = st.stations; state.playlists = pl.playlists; state.jobs = jobs.jobs;
    for (const id of [...state.selected]) if (!state.stations.some((s) => s.id === id)) state.selected.delete(id);
    const typing = app.contains(document.activeElement) && ['INPUT', 'TEXTAREA', 'SELECT'].includes(document.activeElement.tagName);
    if (!quiet) paintLive();
    else if (!typing) { paintStations(); paintJobs(); paintTargets(); if (playlistsChanged) paintPlaylists(); }       // a quiet refresh never touches forms being filled in
  } catch (err) { if (!quiet) toast(err.message, 'error'); }
}

// ---------- stations ----------
function stationCard(s) {
  const caps = s.capabilities || {};
  const pick = h('input', { type: 'checkbox', checked: state.selected.has(s.id), onchange: (e) => { if (e.target.checked) state.selected.add(s.id); else state.selected.delete(s.id); paintTargets(); }, 'aria-label': `Select ${s.name}` });
  const volume = h('input', { type: 'range', min: 0, max: 100, value: state.volumes.get(s.id) ?? 100, disabled: !s.online || !caps.volume, title: caps.volume ? 'Music volume' : 'This station cannot set volume', 'aria-label': `Volume for ${s.name}`,
    oninput: (e) => { state.volumes.set(s.id, e.target.value); send(e.target.value); } });
  const send = debounce((v) => client.post(`/stations/${s.id}/volume`, { volume: Number(v) / 100 }).catch((e) => toast(e.message, 'error')));
  const now = s.online ? (s.now && s.now.title) || 'Nothing reported' : 'Offline';
  const detail = guard(async () => {
    const d = await client.get(`/stations/${s.id}`);
    if (!d.playlists.length) return toast('No playlists reported for this station', 'info');
    const name = prompt(`Switch ${s.name} to which playlist?\n\n${d.playlists.join('\n')}`);
    if (name) { await client.post(`/stations/${s.id}/playlist`, { name }); toast(`${s.name}: playlist set`, 'info'); }
  });
  return h('div', { class: `card station ${s.online ? '' : 'offline'}` },
    h('div', { class: 'row' },
      h('label', { class: 'pick grow' }, pick, h('span', { class: `dot ${s.online ? 'on' : 'off'}` }), h('strong', {}, s.name)),
      s.kind ? h('span', { class: 'chip' }, s.kind) : null,
      h('button', { class: 'link', onclick: () => editStation(s) }, 'Edit')),
    h('div', { class: 'now' }, now),
    h('div', { class: 'small muted' }, s.online ? [s.now && s.now.listeners != null ? `${s.now.listeners} listening` : null, s.now && s.now.live ? 'live DJ on air' : null].filter(Boolean).join(' · ') : s.error),
    h('div', { class: 'tools' },
      h('button', { disabled: !s.online || !caps.skip, title: caps.skip ? '' : 'This station cannot skip from here', onclick: guard(async () => { await client.post(`/stations/${s.id}/skip`, {}); toast(`${s.name}: skipped`, 'info'); setTimeout(refresh, 1200); }) }, 'Skip'),
      h('button', { disabled: !s.online || !caps.playlists, onclick: detail }, 'Playlist'),
      volume));
}

let fillSyncFrom = () => {};
const grid = h('div');
function paintStations() {
  const bySite = new Map();
  for (const s of state.stations) { const k = s.site || ''; if (!bySite.has(k)) bySite.set(k, []); bySite.get(k).push(s); }
  if (!state.stations.length) return clear(grid, h('p', { class: 'empty' }, 'No stations yet. Add one with its address and key.'));
  clear(grid, [...bySite].map(([site, list]) => h('div', {},
    site ? h('p', { class: 'site' }, site) : null,
    h('div', { class: 'grid cols' }, list.map(stationCard)))));
  fillSyncFrom();
}

function stationsToolbar() {
  const all = h('button', { onclick: () => { const everyone = state.stations.every((s) => state.selected.has(s.id)); state.selected = new Set(everyone ? [] : state.stations.map((s) => s.id)); paintLive(); } }, 'Select all');
  const sites = [...new Set(state.stations.map((s) => s.site).filter(Boolean))];
  return h('div', { class: 'row' },
    h('button', { class: 'primary', onclick: () => editStation() }, 'Add a station'), all,
    sites.map((site) => h('button', { onclick: () => { state.selected = new Set(state.stations.filter((s) => s.site === site).map((s) => s.id)); paintLive(); } }, `Select ${site}`)),
    h('span', { class: 'grow' }),
    h('button', { onclick: guard(async () => { const r = await client.post('/group/skip', { stations: [...state.selected] }); report(r.results, 'skipped'); }), disabled: !state.selected.size }, 'Skip selected'),
    h('button', { onclick: () => refresh({ quiet: false }) }, 'Refresh'));
}

function report(results, verb) {
  const ok = results.filter((r) => r.ok).length;
  const bad = results.filter((r) => !r.ok);
  toast(`${ok} ${verb}${bad.length ? `, ${bad.length} failed: ${bad.map((b) => `${stationName(b.station)} (${b.error})`).join('; ')}` : ''}`, bad.length ? 'error' : 'info');
}

function editStation(existing) {
  const f = { name: existing?.name || '', url: existing?.url || '', key: '', site: existing?.site || '', notes: existing?.notes || '' };
  const input = (k, label, type = 'text', ph = '') => h('label', { class: 'field' }, label, h('input', { type, value: f[k], placeholder: ph, oninput: (e) => { f[k] = e.target.value; }, autocomplete: 'off' }));
  const error = h('p', { class: 'bad small', role: 'alert' });
  const dialog = h('dialog', {}, h('form', { method: 'dialog', class: 'grid', onsubmit: async (e) => {
    e.preventDefault();
    try {
      if (existing) await client.put(`/stations/${existing.id}`, f); else await client.post('/stations', f);
      dialog.close(); dialog.remove(); await refresh({ quiet: false });
    } catch (err) { error.textContent = err.message; }
  } },
  h('h2', {}, existing ? `Edit ${existing.name}` : 'Add a station'),
  input('name', 'Name', 'text', 'Ship Radio'), input('url', 'Agent address', 'url', 'https://stream.example.com'),
  input('key', existing ? 'Key (leave empty to keep the current one)' : 'Station key', 'password'),
  input('site', 'Site / group', 'text', 'Way High'), input('notes', 'Notes'), error,
  h('div', { class: 'row end' },
    existing ? h('button', { type: 'button', class: 'danger', onclick: async () => { if (confirm(`Remove ${existing.name} from the hub?`)) { await client.del(`/stations/${existing.id}`); dialog.close(); dialog.remove(); refresh({ quiet: false }); } } }, 'Remove') : null,
    h('button', { type: 'button', onclick: () => { dialog.close(); dialog.remove(); } }, 'Cancel'),
    h('button', { class: 'primary', type: 'submit' }, 'Save'))));
  document.body.append(dialog); dialog.showModal();
}

// ---------- broadcast ----------
const targetsLabel = h('span', { class: 'muted small' });
function paintTargets() { targetsLabel.textContent = state.selected.size ? `${state.selected.size} selected: ${[...state.selected].map(stationName).join(', ')}` : 'Select stations above first'; }

function broadcastCard() {
  const b = { source: 'upload', file: null, clipId: '', url: '', title: '', when: 'now', delay: 60, at: '', preempt: false };
  const resultBox = h('div');
  const src = h('div', { class: 'grid' });
  const paintSrc = () => clear(src,
    b.source === 'upload' ? h('label', { class: 'field' }, 'Audio file', h('input', { type: 'file', accept: 'audio/*', onchange: (e) => { b.file = e.target.files[0] || null; if (b.file && !b.title) b.title = b.file.name.replace(/\.[^.]+$/, ''); } })) :
      b.source === 'clip' ? h('label', { class: 'field' }, 'Clip id from the voice server', h('input', { value: b.clipId, oninput: (e) => { b.clipId = e.target.value.trim(); }, placeholder: 'from the Voice Lab or /clips' })) :
        h('label', { class: 'field' }, 'Audio link (https)', h('input', { type: 'url', value: b.url, oninput: (e) => { b.url = e.target.value.trim(); } })));
  paintSrc();
  const when = h('div', { class: 'row' });
  const paintWhen = () => clear(when,
    h('label', { class: 'field' }, 'When', h('select', { onchange: (e) => { b.when = e.target.value; paintWhen(); } },
      [['now', 'Right away, together'], ['delay', 'In a number of seconds'], ['at', 'At a date and time']].map(([v, t]) => h('option', { value: v, selected: b.when === v }, t)))),
    b.when === 'delay' ? h('label', { class: 'field' }, 'Seconds', h('input', { type: 'number', min: 5, max: 86400, value: b.delay, oninput: (e) => { b.delay = Number(e.target.value); } })) : null,
    b.when === 'at' ? h('label', { class: 'field' }, 'Date and time', h('input', { type: 'datetime-local', value: b.at, oninput: (e) => { b.at = e.target.value; } })) : null);
  paintWhen();
  const send = guard(async () => {
    if (!state.selected.size) throw new Error('Select at least one station first');
    const at = b.when === 'delay' ? b.delay : b.when === 'at' ? new Date(b.at).toISOString() : undefined;
    if (b.when === 'at' && !b.at) throw new Error('Pick a date and time');
    if (!confirm(`Put this on air on ${state.selected.size} station(s)${at ? ' at the chosen time' : ' now'}?`)) return;
    let out;
    if (b.source === 'upload') {
      if (!b.file) throw new Error('Choose an audio file');
      out = await client.request('POST', '/broadcast/upload', { raw: b.file, contentType: b.file.type || 'audio/mpeg', query: { stations: [...state.selected].join(','), title: b.title, at: at === undefined ? '' : at, preempt: b.preempt ? '1' : '' } });
    } else {
      out = await client.post('/broadcast', { stations: [...state.selected], title: b.title, preempt: b.preempt, at, ...(b.source === 'clip' ? { clipId: b.clipId } : { url: b.url }) });
    }
    state.results = out; paintResults(); await refresh();
  });
  function paintResults() {
    const out = state.results;
    if (!out) return clear(resultBox);
    const rows = out.results || out.staged || [];
    clear(resultBox, h('h3', {}, out.job ? `Scheduled for ${fmtDate(out.job.at)}` : out.played ? `Fired together (spread ${out.spreadMs} ms)` : 'Not played'),
      h('table', {}, h('tbody', {}, rows.map((r) => h('tr', {}, h('td', {}, stationName(r.station)), h('td', { class: r.ok ? 'good' : 'bad' }, r.ok ? (r.played === false ? `Not played${r.reason ? `: ${r.reason}` : ''}` : r.played ? 'On air' : 'Ready') : r.error))))));
  }
  paintResults();
  return h('section', { class: 'card' }, h('h2', {}, 'Broadcast'),
    h('p', { class: 'muted small' }, 'Sends one piece of audio to the selected stations. It is put on every station first, then started on all of them together.'),
    h('div', { class: 'grid' },
      h('label', { class: 'field' }, 'Source', h('select', { onchange: (e) => { b.source = e.target.value; paintSrc(); } }, [['upload', 'Upload a file'], ['clip', 'A clip from the voice server'], ['url', 'A link']].map(([v, t]) => h('option', { value: v }, t)))),
      src, h('label', { class: 'field' }, 'Title', h('input', { value: b.title, oninput: (e) => { b.title = e.target.value; } })), when,
      h('label', { class: 'row small' }, h('input', { type: 'checkbox', onchange: (e) => { b.preempt = e.target.checked; } }), 'Allow it to cut in over a live DJ'),
      h('div', { class: 'row' }, targetsLabel, h('span', { class: 'grow' }), h('button', { class: 'primary', onclick: send }, 'Send to selected')),
      resultBox));
}

const jobsBox = h('div');
function paintJobs() {
  const jobs = state.jobs.filter((j) => j.status !== 'cancelled');
  clear(jobsBox, jobs.length ? h('table', {}, h('thead', {}, h('tr', {}, ['When', 'What', 'Stations', 'Status', ''].map((x) => h('th', {}, x)))),
    h('tbody', {}, jobs.map((j) => h('tr', {}, h('td', {}, fmtDate(j.at)), h('td', {}, j.title), h('td', {}, j.stations.map(stationName).join(', ')), h('td', {}, j.status),
      h('td', {}, j.status === 'waiting' ? h('button', { class: 'link danger', onclick: guard(async () => { await client.del(`/jobs/${j.id}`); refresh(); }) }, 'Cancel') : null))))) : h('p', { class: 'empty' }, 'No timed broadcasts.'));
}

// ---------- playlists ----------
const plBox = h('div');
function playlistsCard() {
  return h('section', { class: 'card' }, h('h2', {}, 'Shared playlists'),
    h('p', { class: 'muted small' }, 'A playlist is a list of track paths. Each station keeps its own files; pushing a playlist makes each station play the tracks it has and reports the ones it is missing.'), plBox);
}
function paintPlaylists() {
  const ed = state.editingPlaylist;
  const covBox = h('div');
  clear(plBox,
    state.playlists.length ? h('table', {}, h('tbody', {}, state.playlists.map((p) => h('tr', {},
      h('td', {}, h('strong', {}, p.name), h('div', { class: 'small muted' }, `${p.count} tracks${p.note ? ` · ${p.note}` : ''}`)),
      h('td', { class: 'row end' },
        h('button', { onclick: guard(async () => { const d = await client.get(`/playlists/${encodeURIComponent(p.name)}`); state.editingPlaylist = { name: p.name, items: d.items.join('\n'), note: d.note || '' }; paintPlaylists(); }) }, 'Edit'),
        h('button', { onclick: guard(async () => { state.coverage = { name: p.name, results: (await client.get(`/playlists/${encodeURIComponent(p.name)}/coverage`)).results }; paintPlaylists(); }) }, 'Coverage'),
        h('button', { class: 'primary', onclick: guard(async () => {
          if (!state.selected.size) throw new Error('Select stations first');
          const apply = confirm(`Push "${p.name}" to ${state.selected.size} station(s).\n\nOK = also switch them to it now.\nCancel = only save it there.`);
          const r = await client.post(`/playlists/${encodeURIComponent(p.name)}/push`, { stations: [...state.selected], apply });
          state.coverage = { name: p.name, push: true, results: r.results }; paintPlaylists();
        }) }, 'Push to selected'),
        h('button', { class: 'link danger', onclick: guard(async () => { if (confirm(`Delete "${p.name}" from the hub?`)) { await client.del(`/playlists/${encodeURIComponent(p.name)}`); refresh(); } }) }, 'Delete'))))))
      : h('p', { class: 'empty' }, 'No playlists yet.'),
    state.coverage ? h('div', {}, h('h3', {}, `${state.coverage.push ? 'Push result' : 'Coverage'}: ${state.coverage.name}`), h('table', {}, h('tbody', {}, state.coverage.results.map((r) => h('tr', {}, h('td', {}, stationName(r.station)),
      h('td', { class: r.ok ? '' : 'bad' }, !r.ok ? r.error : state.coverage.push ? `${r.written} tracks${r.missing ? `, ${r.missing} missing` : ''}${r.applied ? ', now playing it' : ''}` : `${r.have} of ${r.total}`),
      h('td', { class: 'small muted' }, (r.missing && r.missing.length ? (Array.isArray(r.missing) ? r.missing : r.missingSample || []).slice(0, 3).join(', ') : '')))))) ) : null,
    covBox,
    h('h3', {}, ed ? `Editing ${ed.name || 'a new playlist'}` : 'New playlist'),
    playlistForm(ed || { name: '', items: '', note: '' }),
    h('h3', {}, 'Copy from a station folder'), importForm());
}
function playlistForm(ed) {
  const f = { ...ed };
  return h('div', { class: 'grid' },
    h('label', { class: 'field' }, 'Name', h('input', { value: f.name, oninput: (e) => { f.name = e.target.value; } })),
    h('label', { class: 'field' }, 'Tracks, one path per line (like Artist/Album/01 Song.mp3)', h('textarea', { rows: 6, class: 'mono', oninput: (e) => { f.items = e.target.value; } }, f.items)),
    h('label', { class: 'field' }, 'Note', h('input', { value: f.note, oninput: (e) => { f.note = e.target.value; } })),
    h('div', { class: 'row end' }, state.editingPlaylist ? h('button', { onclick: () => { state.editingPlaylist = null; paintPlaylists(); } }, 'Cancel') : null,
      h('button', { class: 'primary', onclick: guard(async () => {
        await client.put(`/playlists/${encodeURIComponent(f.name)}`, { items: f.items.split('\n').map((x) => x.trim()).filter(Boolean), note: f.note });
        state.editingPlaylist = null; toast('Playlist saved', 'info'); refresh();
      }) }, 'Save playlist')));
}
function importForm() {
  const f = { station: state.stations[0]?.id || '', prefix: '', name: '' };
  return h('div', { class: 'row' },
    h('label', { class: 'field' }, 'Station', h('select', { onchange: (e) => { f.station = e.target.value; } }, state.stations.map((s) => h('option', { value: s.id }, s.name)))),
    h('label', { class: 'field grow' }, 'Folder (blank = everything)', h('input', { oninput: (e) => { f.prefix = e.target.value; } })),
    h('label', { class: 'field' }, 'Save as', h('input', { oninput: (e) => { f.name = e.target.value; } })),
    h('button', { onclick: guard(async () => { await client.post('/playlists/import', { station: f.station || state.stations[0]?.id, prefix: f.prefix, name: f.name }); toast('Playlist created', 'info'); refresh(); }) }, 'Import'));
}

// ---------- host sync ----------
function syncCard() {
  const f = { from: '', withVoice: false };
  const box = h('div');
  const from = h('select', { onchange: (e) => { f.from = e.target.value; } });
  fillSyncFrom = () => {
    const keep = from.value;
    clear(from, state.stations.filter((s) => s.capabilities && s.capabilities.host).map((s) => h('option', { value: s.id, selected: s.id === keep }, s.name)));
    f.from = from.value;
  };
  fillSyncFrom();
  return h('section', { class: 'card' }, h('h2', {}, 'Copy host settings'),
    h('p', { class: 'muted small' }, 'Copies the virtual host persona, tone, effect, link templates and timing from one station to the selected ones. Each station keeps its own voice unless you tick the box.'),
    h('div', { class: 'row' }, h('label', { class: 'field' }, 'From', from), h('label', { class: 'row small' }, h('input', { type: 'checkbox', onchange: (e) => { f.withVoice = e.target.checked; } }), 'Include voice and provider'),
      h('span', { class: 'grow' }),
      h('button', { class: 'primary', onclick: guard(async () => {
        if (!state.selected.size) throw new Error('Select the stations to copy onto');
        const fields = ['preset', 'fx', 'tone', 'persona', 'templates', 'lines', 'every', 'minGapSeconds', 'skipArtists', ...(f.withVoice ? ['voice', 'provider'] : [])];
        const out = await client.post('/sync/host', { from: from.value, to: [...state.selected], fields });
        clear(box, h('p', { class: 'small muted' }, `Copied: ${out.copied.join(', ')}`), h('table', {}, h('tbody', {}, out.results.map((r) => h('tr', {}, h('td', {}, stationName(r.station)), h('td', { class: r.ok ? 'good' : 'bad' }, r.ok ? 'Updated' : r.error))))));
      }) }, 'Copy to selected')), box);
}

// ---------- layout ----------
const live = h('div', { class: 'grid' });
function paintLive() {
  clear(live, stationsToolbar(), grid);
  paintStations(); paintTargets(); paintJobs(); paintPlaylists();
}
function build() {
  clear(app, h('div', { class: 'stack' }, live,
    h('div', { class: 'two' }, broadcastCard(), h('section', { class: 'card' }, h('h2', {}, 'Timed broadcasts'), jobsBox)),
    h('div', { class: 'two' }, playlistsCard(), syncCard())));
  paintLive();
}

// Draws the Control Panel into `root`. `hubClient` talks to the hub through this site's proxy. Call unmountPanel() when leaving.
export async function mountPanel(root, hubClient) {
  client = hubClient;
  app = root;
  Object.assign(state, { stations: [], selected: new Set(), playlists: [], jobs: [], volumes: new Map(), results: null, coverage: null, editingPlaylist: null });
  build();
  await refresh({ quiet: false });
  clearInterval(timer);
  timer = setInterval(() => { if (!document.hidden && app && app.isConnected) refresh(); }, 5000);
}

export function unmountPanel() {
  clearInterval(timer);
  timer = null;
}
