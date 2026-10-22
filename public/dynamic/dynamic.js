// Dynamic drops: supervise just-in-time generation from one screen (docs/HUB.md). Everything here talks to the hub through the site's
// /api/hub proxy; the site only supplies personas and station names. Nothing on this page airs anything by itself: shadow mode is the default,
// and "Live" is a deliberate switch per station.
import { h, clear, toast, fmtDate, audioUrl } from '../shared/kit.js';

const ZONES = () => (Intl.supportedValuesOf ? Intl.supportedValuesOf('timeZone') : []);
const KINDS = [['time-check', 'Time check'], ['weather', 'Weather'], ['event-reminder', 'Event reminder'], ['host-break', 'Host break'], ['station-id', 'Station ID'], ['promo', 'Promo']];
const STATE_LABEL = { shadow: 'would have aired', 'awaiting-approval': 'waiting for approval', queued: 'queued for the station', inserted: 'inserted', fallback: 'fell back to the planned clip', suppressed: 'suppressed', rejected: 'rejected', generating: 'working' };
const STATE_TONE = { shadow: 'warn', 'awaiting-approval': 'warn', queued: 'on', inserted: 'on', fallback: 'bad', suppressed: 'off', rejected: 'bad' };

// "Thu 7:04 PM MDT" in a given zone: the station's clock, never the viewer's.
export function fmtIn(ms, tz) {
  try { return new Intl.DateTimeFormat([], { timeZone: tz || undefined, weekday: 'short', month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit', timeZoneName: 'short' }).format(new Date(ms)); } catch { return fmtDate(ms); }
}
const offsetMin = (tz, at = Date.now()) => {
  try {
    const p = Object.fromEntries(new Intl.DateTimeFormat('en-US', { timeZone: tz, hourCycle: 'h23', year: 'numeric', month: 'numeric', day: 'numeric', hour: 'numeric', minute: 'numeric', second: 'numeric' }).formatToParts(new Date(at)).filter((x) => x.type !== 'literal').map((x) => [x.type, Number(x.value)]));
    return Math.round((Date.UTC(p.year, p.month - 1, p.day, p.hour % 24, p.minute, p.second) - Math.floor(at / 1000) * 1000) / 60000);
  } catch { return null; }
};
const ago = (ms) => { if (!ms) return 'never'; const s = Math.max(0, Math.round((Date.now() - ms) / 1000)); return s < 90 ? `${s} s ago` : s < 5400 ? `${Math.round(s / 60)} min ago` : `${Math.round(s / 3600)} h ago`; };
const mmss = (s) => (Number.isFinite(s) ? `${Math.floor(s / 60)}:${String(Math.round(s % 60)).padStart(2, '0')}` : '?');
const pill = (text, tone, title) => h('span', { class: `dyn-pill ${tone}`, title }, text);
const note = (w) => h('div', { class: `dyn-note ${w.level === 'error' ? 'error' : 'warn'}`, role: w.level === 'error' ? 'alert' : undefined }, w.message);

let timer = null;
export function unmountDynamic() { if (timer) clearInterval(timer); timer = null; }

export async function mountDynamic(root, site, hub) {
  unmountDynamic();
  clear(root, h('p', { class: 'muted' }, 'Loading...'));
  const S = { stations: [], jit: null, slots: [], items: [], personas: [], siteStations: [], audit: [], filter: 'review', rawShown: new Set() };
  const boxes = { banner: h('section', { class: 'card dyn-banner' }), stations: h('div', { class: 'dyn-stations' }), slots: h('section', { class: 'card' }), review: h('section', { class: 'card' }), spend: h('section', { class: 'card' }), audit: h('section', { class: 'card' }), alerts: h('section', { class: 'card dyn-off' }) };
  const by = (id) => S.stations.find((s) => s.id === id);
  const tzOf = (id) => (by(id) && by(id).broadcastTz) || 'UTC';

  async function load() {
    const [stations, jit, slots, items, personas, siteStations] = await Promise.all([
      hub.get('/stations'), hub.get('/jit/status'), hub.get('/jit/slots'), hub.get('/jit/items', { query: { limit: 200 } }),
      site.get('/personas').catch(() => ({ personas: [] })), site.get('/stations').catch(() => ({ stations: [] })),
    ]);
    Object.assign(S, { stations: stations.stations, jit, slots: slots.slots, items: items.items, personas: personas.personas, siteStations: siteStations.stations });
  }
  const act = async (fn, ok) => { try { const r = await fn(); if (ok) toast(ok, 'info'); await refresh(); return r; } catch (err) { toast(err.message, 'error'); return null; } };

  // ---------- banner: the global kill switch ----------
  function paintBanner() {
    const kill = S.jit.settings.kill;
    const live = S.jit.stations.filter((s) => s.enabled && !s.shadow).length;
    boxes.banner.classList.toggle('killed', !!kill.on);
    clear(boxes.banner,
      h('div', { class: 'grow' },
        h('div', { class: 'big' }, kill.on ? 'KILL SWITCH ON: nothing is generated and nothing is handed to any station' : 'Dynamic drops'),
        h('div', { class: 'small muted' }, kill.on ? `${kill.reason || 'no reason given'}${kill.by ? ` · by ${kill.by}` : ''}` : `${S.jit.stations.filter((s) => s.enabled).length} station(s) on, ${live} live. Shadow mode is the default: lines are written and spoken but nothing is queued. Any failure leaves the planned clip in place.`),
        S.jit.siteConfigured ? null : h('div', { class: 'dyn-note error', role: 'alert' }, 'The hub cannot reach the site to write lines: set SITE_URL and SITE_KEY on the hub (docs/HUB.md).')),
      h('button', { type: 'button', class: kill.on ? 'primary' : 'danger', onclick: async () => {
        if (kill.on) { if (confirm('Switch the kill switch off? Stations that are switched on will start generating again.')) act(() => hub.post('/jit/kill', { on: false }), 'Kill switch off.'); return; }
        const reason = prompt('Switch everything off now. Why? (shown to everyone)', 'stopping dynamic drops');
        if (reason !== null) act(() => hub.post('/jit/kill', { on: true, reason }), 'Kill switch ON.');
      } }, kill.on ? 'Switch the kill switch off' : 'Kill switch'));
  }

  // ---------- stations ----------
  function stationCard(s) {
    const j = S.jit.stations.find((x) => x.stationId === s.id) || {};
    const np = s.nowPlaying;
    const f = { broadcastTz: s.broadcastTz || '', machineTz: s.machineTz || '', siteStationId: s.siteStationId || '' };
    const diff = f.broadcastTz && f.machineTz ? (offsetMin(f.broadcastTz) - offsetMin(f.machineTz)) / 60 : 0;
    const diffNote = h('div', { class: 'dyn-note warn', hidden: !diff }, diff ? `The PC clock (${f.machineTz}) and the broadcast clock (${f.broadcastTz}) differ by ${Math.abs(diff)} hour(s) right now. Wording and schedules use the broadcast clock; the PC clock is only used to read the PC's own timestamps.` : '');
    const checkDiff = () => { const d = f.broadcastTz && f.machineTz ? (offsetMin(f.broadcastTz) - offsetMin(f.machineTz)) / 60 : 0; diffNote.hidden = !d; diffNote.textContent = d ? `The PC clock (${f.machineTz}) and the broadcast clock (${f.broadcastTz}) differ by ${Math.abs(d)} hour(s) right now.` : ''; };
    const zoneInput = (label, key, help) => h('label', { class: 'field' }, label, h('input', { value: f[key], list: 'dyn-zones', placeholder: 'e.g. America/Denver', oninput: (e) => { f[key] = e.target.value.trim(); checkDiff(); } }), h('span', { class: 'small muted' }, help));
    const toggle = (label, key, value, extra = {}) => h('label', { class: 'row small' }, h('input', { type: 'checkbox', checked: value, onchange: async (e) => {
      const next = e.target.checked;
      if (key === 'shadow' && !next && !confirm(`Take ${s.name} LIVE?\n\nGenerated lines will be handed to the station${j.requireApproval ? ' once you approve each one' : ' WITHOUT approval'}. Do this only after the shadow review looks right and the station owner has approved a live single-item test.`)) { e.target.checked = true; return; }
      if (key === 'requireApproval' && !next && !confirm('Let lines go to the station without a person approving each one?')) { e.target.checked = true; return; }
      act(() => hub.put(`/stations/${encodeURIComponent(s.id)}/jit`, { [key]: key === 'shadow' ? !next : next }), 'Saved.');
    }, ...extra }), label);
    const meter = j.usage ? h('div', { class: 'small' }, `Today (${j.usage.day}): ${j.usage.chars} of ${j.usage.cap ?? 'no limit'} characters`, j.usage.cap ? h('progress', { class: 'dyn-meter', max: j.usage.cap, value: Math.min(j.usage.chars, j.usage.cap) }) : null) : null;
    const siteSel = h('label', { class: 'field' }, 'Its station on this site', h('select', { onchange: (e) => { f.siteStationId = e.target.value; } }, h('option', { value: '' }, '(none)'), S.siteStations.filter((x) => !x.builtin).map((x) => h('option', { value: x.id, selected: x.id === f.siteStationId }, `${x.name} (${x.id})`))),
      h('span', { class: 'small muted' }, 'Lines are written for this station: its persona, city and weather.'));
    const keyOut = h('div');
    return h('div', { class: `card dyn-station ${s.online ? '' : 'offline'}` },
      h('div', { class: 'row' }, h('strong', { class: 'grow' }, s.name), pill(s.online ? 'online' : 'offline', s.online ? 'on' : 'off', s.error || ''), s.mode === 'live-show' ? pill('live show on air', 'live') : s.mode && s.mode !== 'unknown' ? pill(s.mode, 'off') : null,
        j.enabled ? pill(j.shadow ? 'shadow' : 'LIVE', j.shadow ? 'warn' : 'live') : pill('dynamic off', 'off'), j.kill ? pill('station kill switch', 'bad') : null),
      h('div', { class: 'small muted' }, `${s.connection === 'pull' ? 'pulls from the hub (no inbound connection)' : s.url} · last report ${ago(s.lastSeen)}`),
      np ? h('div', {}, h('strong', {}, [np.artist, np.title].filter(Boolean).join(' - ') || '(unknown)'), h('span', { class: 'small muted' }, ` ${mmss(np.elapsedSeconds)} played, ${mmss(np.remainingSeconds)} left`)) : h('div', { class: 'small muted' }, 'Nothing reported yet.'),
      (s.next || []).length ? h('ol', { class: 'small', style: 'margin:4px 0 4px 18px;padding:0' }, s.next.map((n) => h('li', {}, [n.artist, n.title].filter(Boolean).join(' - ')))) : null,
      s.stream ? h('div', { class: 'small muted' }, `Stream ${s.stream.up === true ? 'up' : s.stream.up === false ? 'DOWN' : 'unknown'}${s.stream.listeners !== null && s.stream.listeners !== undefined ? ` · ${s.stream.listeners} listening` : ''}`) : null,
      s.killSwitch && s.killSwitch.on ? h('div', { class: 'dyn-note error' }, `The agent's own kill switch is ON (${s.killSwitch.reason || 'no reason'}); it refuses all control calls.`) : null,
      (s.warnings || []).map(note),
      h('details', {}, h('summary', {}, 'Clocks and connection'),
        h('div', { class: 'stack' }, zoneInput('Broadcast time zone', 'broadcastTz', 'The station\'s own clock: {{time}}, schedules, "tonight at 7", weather and alert wording.'),
          zoneInput('PC (machine) time zone', 'machineTz', 'The RadioDJ PC\'s clock. Used only to read timestamps that come from the PC.'), diffNote, siteSel,
          h('div', { class: 'row' }, h('button', { type: 'button', onclick: () => act(() => hub.put(`/stations/${encodeURIComponent(s.id)}`, f), 'Saved.') }, 'Save clocks'),
            s.connection === 'pull' ? h('button', { type: 'button', onclick: async () => { if (!confirm('Make a new station key? The old one stops working.')) return; const r = await act(() => hub.post(`/stations/${encodeURIComponent(s.id)}/pullkey`, {})); if (r) clear(keyOut, h('p', { class: 'small' }, 'Put this in the agent as HUB_STATION_KEY. It is shown once:'), h('div', { class: 'dyn-key' }, r.key)); } }, s.hasPullKey ? 'New station key' : 'Make a station key') : null), keyOut)),
      h('div', { class: 'stack' },
        toggle('Dynamic drops on', 'enabled', !!j.enabled),
        toggle('Live (off = shadow: write and speak, queue nothing)', 'shadow', j.enabled && !j.shadow),
        toggle('A person approves each line before it goes to the station', 'requireApproval', j.requireApproval !== false),
        toggle('Station kill switch', 'kill', !!j.kill, {}),
        meter,
        h('label', { class: 'field small' }, 'Daily character cap for this station (empty = the site-wide cap)', h('input', { type: 'number', min: 0, value: j.dailyCharCap ?? '', onchange: (e) => act(() => hub.put(`/stations/${encodeURIComponent(s.id)}/jit`, { dailyCharCap: e.target.value === '' ? null : Number(e.target.value) }), 'Saved.') }))));
  }
  function paintStations() {
    const addForm = { name: '', connection: 'pull', url: '', broadcastTz: Intl.DateTimeFormat().resolvedOptions().timeZone || '', machineTz: '' };
    const add = h('details', { class: 'card' }, h('summary', {}, 'Add a station to the hub'),
      h('div', { class: 'grid cols' },
        h('label', { class: 'field' }, 'Name', h('input', { oninput: (e) => { addForm.name = e.target.value; } })),
        h('label', { class: 'field' }, 'How it connects', h('select', { onchange: (e) => { addForm.connection = e.target.value; } }, h('option', { value: 'pull' }, 'It calls the hub (pull: for a PC behind a home router)'), h('option', { value: 'push' }, 'The hub calls it (needs a reachable address)'))),
        h('label', { class: 'field' }, 'Address (push only)', h('input', { placeholder: 'https://...', oninput: (e) => { addForm.url = e.target.value; } })),
        h('label', { class: 'field' }, 'Broadcast time zone', h('input', { value: addForm.broadcastTz, list: 'dyn-zones', oninput: (e) => { addForm.broadcastTz = e.target.value; } })),
        h('label', { class: 'field' }, 'PC time zone', h('input', { list: 'dyn-zones', placeholder: 'e.g. America/Chicago', oninput: (e) => { addForm.machineTz = e.target.value; } }))),
      h('button', { type: 'button', class: 'primary', onclick: async () => { const r = await act(() => hub.post('/stations', addForm), 'Station added.'); if (r && r.pullKey) prompt('Station key (shown once). Put it in the agent as HUB_STATION_KEY:', r.pullKey); } }, 'Add'));
    clear(boxes.stations, h('datalist', { id: 'dyn-zones' }, ZONES().map((z) => h('option', { value: z }))), S.stations.length ? S.stations.map(stationCard) : h('p', { class: 'muted' }, 'No stations in the hub yet.'), add);
  }

  // ---------- slots ----------
  const lines = (v) => v.split('\n').map((l) => l.trim()).filter(Boolean);
  function slotForm(existing) {
    const c = existing ? existing.constraints || {} : {};
    const f = { stationId: existing ? existing.stationId : (S.stations[0] && S.stations[0].id) || '', kind: existing ? existing.kind : 'time-check', startsAt: existing ? existing.startsAtIso.slice(0, 16) : '', leadSeconds: existing ? existing.leadSeconds : 600,
      personaId: existing ? existing.personaId : '', fallbackClipId: existing ? existing.fallbackClipId : '', maxChars: c.maxChars || '', maxSeconds: c.maxSeconds || '', languagePolicy: c.languagePolicy || '', blocklist: (c.blocklist || []).join(', '),
      names: (c.names || []).map((n) => (typeof n === 'string' ? n : [n.artist, n.title].filter(Boolean).join(' - '))).join('\n'), facts: (c.facts || []).join('\n'), eventName: (c.event && c.event.name) || '', eventStarts: '', eventVenue: (c.event && c.event.venue) || '' };
    const zoneHint = h('span', { class: 'small muted' });
    const hint = () => { zoneHint.textContent = `Local time at the station: ${tzOf(f.stationId)}`; };
    const body = () => ({
      stationId: f.stationId, kind: f.kind, startsAt: f.startsAt, leadSeconds: Number(f.leadSeconds) || 600, personaId: f.personaId, fallbackClipId: f.fallbackClipId,
      constraints: { ...(f.maxChars ? { maxChars: Number(f.maxChars) } : {}), ...(f.maxSeconds ? { maxSeconds: Number(f.maxSeconds) } : {}), ...(f.languagePolicy ? { languagePolicy: f.languagePolicy } : {}), blocklist: f.blocklist.split(',').map((x) => x.trim()).filter(Boolean),
        names: lines(f.names).map((l) => { const [artist, ...t] = l.split(' - '); return t.length ? { artist: artist.trim(), title: t.join(' - ').trim() } : l; }), facts: lines(f.facts),
        ...(f.kind === 'event-reminder' ? { event: { name: f.eventName, startsAt: f.eventStarts, venue: f.eventVenue } } : {}) },
    });
    const text = (label, key, props = {}) => h('label', { class: 'field' }, label, h('input', { value: f[key], ...props, oninput: (e) => { f[key] = e.target.value; if (key === 'stationId') hint(); } }));
    const eventBox = h('div', { class: 'grid cols' }, text('Event name', 'eventName'), h('label', { class: 'field' }, 'Event starts (station time)', h('input', { type: 'datetime-local', oninput: (e) => { f.eventStarts = e.target.value; } })), text('Venue', 'eventVenue'));
    eventBox.hidden = f.kind !== 'event-reminder';
    const out = h('div');
    hint();
    return h('div', { class: 'stack' },
      h('div', { class: 'grid cols' },
        h('label', { class: 'field' }, 'Station', h('select', { onchange: (e) => { f.stationId = e.target.value; hint(); } }, S.stations.map((s) => h('option', { value: s.id, selected: s.id === f.stationId }, s.name)))),
        h('label', { class: 'field' }, 'Kind', h('select', { onchange: (e) => { f.kind = e.target.value; eventBox.hidden = f.kind !== 'event-reminder'; } }, KINDS.map(([v, t]) => h('option', { value: v, selected: v === f.kind }, t)))),
        h('label', { class: 'field' }, 'Starts at', h('input', { type: 'datetime-local', value: f.startsAt, oninput: (e) => { f.startsAt = e.target.value; } }), zoneHint),
        text('Write it this many seconds ahead', 'leadSeconds', { type: 'number', min: 60, max: 3600 }),
        h('label', { class: 'field' }, 'Persona', h('select', { onchange: (e) => { f.personaId = e.target.value; } }, h('option', { value: '' }, '(station default)'), S.personas.map((p) => h('option', { value: p.id, selected: p.id === f.personaId }, `${p.emoji || ''} ${p.name}`.trim())))),
        text('Planned clip that plays if anything fails', 'fallbackClipId', { placeholder: 'the id the playlist builder put there' })),
      eventBox,
      h('details', {}, h('summary', {}, 'Limits and what the line may mention'),
        h('div', { class: 'grid cols' }, text('Longest line (characters)', 'maxChars', { type: 'number', min: 40, max: 1000, placeholder: '400' }), text('Longest (seconds)', 'maxSeconds', { type: 'number', min: 3, max: 90 }),
          h('label', { class: 'field' }, 'Language', h('select', { onchange: (e) => { f.languagePolicy = e.target.value; } }, [['', 'Persona / site default'], ['clean', 'Clean'], ['explicit-ok', 'Strong language allowed']].map(([v, t]) => h('option', { value: v, selected: v === f.languagePolicy }, t)))), text('Words it must not say (comma separated)', 'blocklist')),
        h('label', { class: 'field' }, 'Songs it may name, one per line as "Artist - Title" (anything else is refused)', Object.assign(h('textarea', { rows: 3, oninput: (e) => { f.names = e.target.value; } }), { value: f.names })),
        h('label', { class: 'field' }, 'Facts it may use, one per line (nothing else may be claimed)', Object.assign(h('textarea', { rows: 3, oninput: (e) => { f.facts = e.target.value; } }), { value: f.facts }))),
      h('div', { class: 'row' },
        h('button', { type: 'button', class: 'primary', onclick: () => act(() => (existing ? hub.put(`/jit/slots/${existing.id}`, body()) : hub.post('/jit/slots', body())), 'Slot saved.') }, existing ? 'Save slot' : 'Add slot'),
        existing ? h('button', { type: 'button', class: 'link danger', onclick: () => confirm('Delete this slot?') && act(() => hub.del(`/jit/slots/${existing.id}`), 'Deleted.') }, 'Delete') : null,
        existing ? h('button', { type: 'button', onclick: () => previewNow(existing, out) }, 'Write and speak it now (preview)') : null), out);
  }
  // Spending needs a yes: the estimate comes first, then the run (shadow, so nothing is queued).
  async function previewNow(slot, out) {
    try {
      const est = (await hub.post('/jit/run', { slotId: slot.id })).estimate;
      const dollars = est.usd ? ` (about $${est.usd.total.toFixed(4)})` : '';
      if (!confirm(`This will write a line and speak it: up to ${est.ceilingChars} characters (${est.credits} credits)${dollars}.\n${est.cap.wouldExceed ? 'WARNING: that is over today\'s cap, so it will be refused.\n' : ''}Nothing will be queued or aired. Go ahead?`)) return;
      clear(out, h('p', { class: 'muted small' }, 'Working...'));
      const r = await hub.post('/jit/run', { slotId: slot.id, confirm: true });
      clear(out, h('div', { class: 'dyn-note info' }, `${STATE_LABEL[r.item.state] || r.item.state}${r.item.reason ? `: ${r.item.reason}` : ''}`));
      await refresh();
    } catch (err) { clear(out, h('div', { class: 'dyn-note error' }, err.message)); }
  }
  function paintSlots() {
    const rows = S.slots.slice().sort((a, b) => a.startsAt - b.startsAt);
    const editBox = h('div');
    clear(boxes.slots,
      h('h2', {}, 'Dynamic slots'),
      h('p', { class: 'small muted' }, 'A slot is a place in the playlist where a line is written and spoken a few minutes before it airs. The nightly playlist builder marks them and puts the planned (evergreen) clip there; that clip plays whenever anything here does not finish.'),
      rows.length ? h('table', { class: 'dyn-table' }, h('thead', {}, h('tr', {}, ['Station', 'Kind', 'Starts (station time)', 'Lead', 'Persona', 'Planned clip', 'Status', ''].map((t) => h('th', {}, t)))),
        h('tbody', {}, rows.map((s) => h('tr', {}, h('td', {}, (by(s.stationId) || {}).name || s.stationId), h('td', {}, (KINDS.find((k) => k[0] === s.kind) || [0, s.kind])[1]), h('td', {}, fmtIn(s.startsAt, tzOf(s.stationId))), h('td', {}, `${s.leadSeconds / 60} min`), h('td', {}, s.personaId || '(default)'),
          h('td', {}, s.fallbackClipId || h('span', { class: 'muted' }, 'none set')), h('td', {}, s.item ? pill(STATE_LABEL[s.item.state] || s.item.state, STATE_TONE[s.item.state] || 'off', s.item.reason) : s.source === 'schedule' ? pill('from the plan', 'off') : pill('waiting', 'off')),
          h('td', {}, h('button', { type: 'button', class: 'link', onclick: () => clear(editBox, h('div', { class: 'card' }, h('h3', {}, 'Edit slot'), slotForm(s))) }, 'Edit')))))) : h('p', { class: 'muted' }, 'No slots yet.'),
      h('h3', {}, 'Add a slot'), S.stations.length ? slotForm() : h('p', { class: 'muted' }, 'Add a station first.'), editBox);
  }

  // ---------- review: what would air, and the approval queue ----------
  async function itemCard(it) {
    const tz = tzOf(it.stationId);
    const textBox = h('p', { class: 'dyn-line' });
    const paintText = () => { const raw = S.rawShown.has(it.id); clear(textBox, it.text ? (raw ? it.text.raw : it.text.filledIn) : h('span', { class: 'muted' }, 'No line was written.')); };
    paintText();
    const player = h('div');
    if (it.audio) player.append(h('button', { type: 'button', onclick: async (e) => { e.target.disabled = true; try { clear(player, h('audio', { controls: true, autoplay: true, src: await audioUrl(hub, `/jit/items/${it.id}/audio`) })); } catch (err) { toast(err.message, 'error'); e.target.disabled = false; } } }, '▶ Listen'));
    const decide = (verdict) => {
      const note = prompt(verdict === 'approve' ? 'Approve. A note for the record (optional):' : 'Reject. Why? (shown as the reason)', '');
      if (note !== null) act(() => hub.post(`/jit/items/${it.id}/${verdict}`, { note }), verdict === 'approve' ? 'Approved.' : 'Rejected.');
    };
    const canDecide = (it.state === 'shadow' || it.state === 'awaiting-approval') && it.approval.state !== 'rejected';
    return h('div', { class: `card dyn-item ${it.state}` },
      h('div', { class: 'row' }, h('strong', { class: 'grow' }, `${(by(it.stationId) || {}).name || it.stationId} · ${(KINDS.find((k) => k[0] === it.kind) || [0, it.kind])[1]} · ${fmtIn(it.startsAt, tz)}`), pill(STATE_LABEL[it.state] || it.state, STATE_TONE[it.state] || 'off'), it.shadow ? pill('shadow', 'warn') : null),
      it.reason ? h('div', { class: `dyn-note ${it.state === 'fallback' ? 'error' : 'info'}` }, it.state === 'fallback' ? `Why the planned clip plays instead: ${it.reason}` : it.reason) : null,
      it.fallbackClipId ? h('div', { class: 'small muted' }, `Planned clip: ${it.fallbackClipId}`) : null,
      textBox,
      it.text ? h('label', { class: 'row small' }, h('input', { type: 'checkbox', checked: S.rawShown.has(it.id), onchange: (e) => { if (e.target.checked) S.rawShown.add(it.id); else S.rawShown.delete(it.id); paintText(); } }), 'Show the raw text with {{placeholders}}') : null,
      h('div', { class: 'small muted' }, [it.textModel && `written by ${it.textModel}`, it.chars && `${it.chars} characters`, it.audio && (it.audio.cacheHit ? 'audio reused (no new spend)' : `audio ${(it.audio.bytes / 1024).toFixed(0)} KB`)].filter(Boolean).join(' · ')),
      it.validation && !it.validation.ok ? h('ul', { class: 'small' }, it.validation.problems.map((p) => h('li', { class: 'bad' }, p.message))) : null,
      it.approval.state !== 'none' && it.approval.state !== 'pending' ? h('div', { class: 'small' }, `${it.approval.state === 'approved' ? 'Approved' : 'Rejected'} by ${it.approval.by || '?'} · ${fmtDate(it.approval.at)}${it.approval.note ? ` · "${it.approval.note}"` : ''}`) : null,
      h('div', { class: 'row' }, player, canDecide ? h('button', { type: 'button', class: 'primary', onclick: () => decide('approve') }, it.shadow ? 'Looks right' : 'Approve') : null, canDecide ? h('button', { type: 'button', class: 'danger', onclick: () => decide('reject') }, 'Reject') : null));
  }
  async function paintReview() {
    const FILTERS = [['review', 'Needs a look (would air / waiting for approval)'], ['fallback', 'Fell back to the planned clip'], ['live', 'Queued or inserted'], ['all', 'Everything']];
    const list = S.items.filter((i) => ({ review: ['shadow', 'awaiting-approval'].includes(i.state) && i.approval.state === 'pending', fallback: ['fallback', 'suppressed', 'rejected'].includes(i.state), live: ['queued', 'inserted'].includes(i.state), all: true }[S.filter]));
    const cards = await Promise.all(list.slice(0, 60).map(itemCard));
    clear(boxes.review,
      h('div', { class: 'row' }, h('h2', { class: 'grow' }, 'Shadow review and approvals'), h('select', { 'aria-label': 'Filter', onchange: (e) => { S.filter = e.target.value; paintReview(); } }, FILTERS.map(([v, t]) => h('option', { value: v, selected: v === S.filter }, t)))),
      h('p', { class: 'small muted' }, 'In shadow mode this is what WOULD have aired, with the filled-in words and the audio, so you can judge it before anything goes live. In live mode with approval on, a line waits here until you approve it; approving too late means the planned clip plays.'),
      cards.length ? cards : h('p', { class: 'empty' }, 'Nothing here.'));
  }

  // ---------- spend ----------
  function paintSpend() {
    const s = S.jit.settings;
    const f = { dailyCharCap: s.dailyCharCap ?? '', globalDailyCharCap: s.globalDailyCharCap ?? '', costPer1kCharsUsd: s.costPer1kCharsUsd ?? '', blocklist: (s.blocklist || []).join(', '), languagePolicy: s.languagePolicy };
    const est = { stationId: (S.stations[0] && S.stations[0].id) || '', chars: 300 };
    const estOut = h('div', { class: 'small' });
    const num = (label, key, help) => h('label', { class: 'field' }, label, h('input', { type: 'number', min: 0, step: 'any', value: f[key], oninput: (e) => { f[key] = e.target.value; } }), h('span', { class: 'small muted' }, help));
    clear(boxes.spend, h('h2', {}, 'Spend'),
      h('p', { class: 'small muted' }, 'Speech is billed by the character (about one credit each). The hub stops at the daily cap and plays the planned clip instead. A clip reused for several stations is spoken, and paid for, once.'),
      h('div', { class: 'grid cols' }, S.jit.stations.map((j) => h('div', {}, h('strong', {}, (by(j.stationId) || {}).name || j.stationId), h('div', { class: 'small' }, `${j.usage.chars} of ${j.usage.cap ?? 'no limit'} characters today · ${j.usage.requests} spoken`), j.usage.cap ? h('progress', { class: 'dyn-meter', max: j.usage.cap, value: Math.min(j.usage.chars, j.usage.cap) }) : null))),
      h('p', { class: 'small' }, `All stations today: ${S.jit.globalUsedChars} characters.`),
      h('h3', {}, 'Estimate before you spend'),
      h('div', { class: 'row' }, h('select', { 'aria-label': 'Station', onchange: (e) => { est.stationId = e.target.value; } }, S.stations.map((x) => h('option', { value: x.id }, x.name))),
        h('input', { type: 'number', min: 1, max: 1000, value: est.chars, 'aria-label': 'Characters', oninput: (e) => { est.chars = Number(e.target.value); } }), 'characters',
        h('button', { type: 'button', onclick: async () => { try { const r = await hub.post('/jit/estimate', est); clear(estOut, `${r.chars} characters is about ${r.seconds} seconds and ${r.credits} credits${r.usd ? `, about $${r.usd.total.toFixed(4)}` : ''}. ${r.cap.cap === null ? 'No daily cap.' : `${r.cap.remaining} left of today's ${r.cap.cap}${r.cap.wouldExceed ? ': this WOULD exceed it' : ''}.`} ${r.note}`); } catch (err) { clear(estOut, h('span', { class: 'bad' }, err.message)); } } }, 'Estimate')), estOut,
      h('h3', {}, 'Limits'),
      h('div', { class: 'grid cols' }, num('Daily cap per station (characters)', 'dailyCharCap', 'Used for stations with no cap of their own.'), num('Daily cap, all stations (characters)', 'globalDailyCharCap', 'Empty = none.'), num('Dollars per 1,000 characters', 'costPer1kCharsUsd', 'Only to show dollars in estimates; set it from your ElevenLabs plan.'),
        h('label', { class: 'field' }, 'Language', h('select', { onchange: (e) => { f.languagePolicy = e.target.value; } }, [['clean', 'Clean'], ['explicit-ok', 'Strong language allowed']].map(([v, t]) => h('option', { value: v, selected: v === f.languagePolicy }, t))))),
      h('label', { class: 'field' }, 'Words no line may contain (comma separated)', h('input', { value: f.blocklist, oninput: (e) => { f.blocklist = e.target.value; } })),
      h('button', { type: 'button', class: 'primary', onclick: () => act(() => hub.put('/jit/settings', { dailyCharCap: f.dailyCharCap === '' ? null : Number(f.dailyCharCap), globalDailyCharCap: f.globalDailyCharCap === '' ? null : Number(f.globalDailyCharCap), costPer1kCharsUsd: f.costPer1kCharsUsd === '' ? null : Number(f.costPer1kCharsUsd), blocklist: f.blocklist.split(',').map((x) => x.trim()).filter(Boolean), languagePolicy: f.languagePolicy }), 'Saved.') }, 'Save limits'),
      h('h3', {}, 'Providers'), h('div', { class: 'row small' }, ['text', 'speech'].map((n) => { const b = S.jit.breakers[n]; return h('span', {}, `${n}: `, b.open ? pill('paused after repeated failures', 'bad', b.lastError) : b.fails ? pill(`${b.fails} failure(s) in a row`, 'warn', b.lastError) : pill('ok', 'on')); })));
  }

  // ---------- audit ----------
  async function paintAudit() {
    const { entries } = await hub.get('/audit', { query: { limit: 150 } });
    clear(boxes.audit, h('h2', {}, 'Audit log'), h('p', { class: 'small muted' }, 'Who changed what, and when. It is only ever added to, and holds no keys.'),
      h('table', { class: 'dyn-table' }, h('thead', {}, h('tr', {}, ['When', 'Who', 'What', 'On', 'Result'].map((t) => h('th', {}, t)))), h('tbody', {}, entries.map((e) => h('tr', {}, h('td', {}, fmtDate(e.at)), h('td', {}, e.who), h('td', {}, e.action), h('td', {}, e.target), h('td', {}, e.result || e.detail))))));
  }

  function paintAlerts() {
    clear(boxes.alerts, h('div', { class: 'row' }, h('h2', { class: 'grow' }, 'Emergency alerts'), pill('planned, not built', 'off')),
      h('p', { class: 'small' }, 'Switched off. When they are built they will use the official National Weather Service text word for word, only for the station\'s area, wait for a person to approve, respect the kill switch, and stay off until someone turns them on. Nothing here can put an alert on air.'),
      h('button', { type: 'button', disabled: true }, 'Enable (not available)'));
  }

  async function refresh() {
    await load();
    paintBanner(); paintStations(); paintSlots(); await paintReview(); paintSpend(); await paintAudit();
  }
  clear(root, h('div', { class: 'stack' }, boxes.banner, h('h2', {}, 'Stations'), boxes.stations, boxes.review, boxes.slots, boxes.spend, boxes.audit, boxes.alerts));
  try { await refresh(); paintAlerts(); } catch (err) { clear(root, h('p', { class: 'bad' }, `Could not load the hub: ${err.message}`)); return; }
  // Keep the status fresh without disturbing a form that is being filled in: only the banner, stations and review lists repaint.
  timer = setInterval(async () => {
    if (document.activeElement && ['INPUT', 'TEXTAREA', 'SELECT'].includes(document.activeElement.tagName)) return;
    try { await load(); paintBanner(); paintStations(); await paintReview(); } catch { /* the next pass tries again */ }
  }, 15000);
}
