// The hub: one API over many stations. A "station" is anything that speaks the agent API (docs/HUB.md): a Chips Voice server in front of
// Liquidsoap/Icecast, or the RadioDJ agent on a Windows machine. The hub keeps the list, polls them, and does the things that need more
// than one station: broadcasts at the same moment, playlists pushed to several stations, host settings copied between them.
//
// Stations are never trusted with each other's keys: each station's key stays in the hub's store and is never sent back to a browser.
const crypto = require('crypto');
const { createAuth, createLimiter } = require('./auth');

class HubError extends Error {
  constructor(message, status = 400) { super(message); this.status = status; }
}

const slug = (s) => String(s).toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 40);
const HOST_FIELDS = ['preset', 'fx', 'tone', 'persona', 'templates', 'lines', 'every', 'minGapSeconds', 'skipArtists'];
const MAX_AHEAD_MS = 24 * 3600e3;

function createHub({ store, key, voiceUrl = '', voiceKey = '', fetchImpl = globalThis.fetch, now = Date.now, statusTtlMs = 4000, timeoutMs = 6000, tickMs = 1000, corsOrigin = '*', maxAudioBytes = 25e6, ttlMs }) {
  const auth = createAuth({ key, now, ttlMs });
  const loginLimit = createLimiter({ max: 10, now });
  const jobTimers = new Set();
  const cache = new Map();                                    // station id -> { at, status }
  const libraries = new Map();                                // station id -> { at, paths:Set }
  let ticker = null;

  // ---------- talking to a station ----------
  async function call(station, method, path, { body, raw, query, timeout = timeoutMs, contentType } = {}) {
    const url = new URL(path, station.url.endsWith('/') ? station.url : `${station.url}/`);
    for (const [k, v] of Object.entries(query || {})) if (v !== undefined && v !== '') url.searchParams.set(k, String(v));
    const headers = { 'x-api-key': station.key || '' };
    let payload;
    if (raw) { payload = raw; headers['content-type'] = contentType || 'application/octet-stream'; } else if (body !== undefined) { payload = JSON.stringify(body); headers['content-type'] = 'application/json'; }
    let res;
    try {
      res = await fetchImpl(url, { method, headers, body: payload, signal: AbortSignal.timeout(timeout) });
    } catch (err) {
      throw new HubError(`${station.name} is not reachable: ${err.name === 'TimeoutError' ? 'timed out' : err.message}`, 502);
    }
    const text = await res.text();
    let json = null;
    try { json = text ? JSON.parse(text) : null; } catch (err) { /* not JSON */ }
    if (!res.ok) throw new HubError(`${station.name}: ${(json && json.error) || `answered ${res.status}`}`, res.status === 401 || res.status === 403 ? 502 : res.status >= 500 ? 502 : res.status);
    return json;
  }

  const stations = () => store.data.stations;
  const find = (id) => {
    const s = stations().find((x) => x.id === id);
    if (!s) throw new HubError(`no station "${String(id).slice(0, 40)}"`, 404);
    return s;
  };
  const view = (s) => ({ id: s.id, name: s.name, site: s.site || '', url: s.url, notes: s.notes || '', hasKey: !!s.key });

  async function status(station, { fresh = false } = {}) {
    const hit = cache.get(station.id);
    if (!fresh && hit && now() - hit.at < statusTtlMs) return hit.status;
    const out = { ...view(station), online: false, kind: null, capabilities: {}, now: null, error: '', checkedAt: now() };
    try {
      const [info, np] = await Promise.all([call(station, 'GET', '/agent/info', { timeout: 4000 }), call(station, 'GET', '/music/now', { timeout: 4000 }).catch((e) => ({ error: e.message }))]);
      Object.assign(out, { online: true, kind: info.kind, capabilities: info.capabilities || {}, agentName: info.name });
      out.now = np && !np.error ? np : null;
      if (np && np.error) out.error = np.error;
    } catch (err) {
      out.error = err.message;
    }
    cache.set(station.id, { at: now(), status: out });
    return out;
  }

  function needs(statusObj, capability) {
    if (!statusObj.online) throw new HubError(`${statusObj.name} is offline: ${statusObj.error}`, 502);
    if (!statusObj.capabilities[capability]) throw new HubError(`${statusObj.name} (${statusObj.kind}) does not support ${capability}`, 501);
  }

  // Picks stations from { stations: [ids] | "all", site }.
  function targets(sel) {
    let list;
    if (sel.stations === 'all' || (sel.stations === undefined && sel.site)) list = stations();
    else if (Array.isArray(sel.stations) && sel.stations.length) list = sel.stations.map(find);
    else throw new HubError('choose stations: a list of ids, or "all"');
    if (sel.site) list = list.filter((s) => (s.site || '') === sel.site);
    if (!list.length) throw new HubError('no stations match');
    return [...new Map(list.map((s) => [s.id, s])).values()];
  }

  // ---------- stations ----------
  function cleanStation(input, existing) {
    const url = String(input.url !== undefined ? input.url : existing && existing.url || '').trim().replace(/\/+$/, '');
    if (!/^https?:\/\/[^\s/]+/i.test(url)) throw new HubError('url must start with http:// or https://');
    const name = String(input.name !== undefined ? input.name : existing && existing.name || '').trim().slice(0, 60);
    if (!name) throw new HubError('name is required');
    return {
      name, url, site: String(input.site !== undefined ? input.site : existing && existing.site || '').trim().slice(0, 60),
      notes: String(input.notes !== undefined ? input.notes : existing && existing.notes || '').slice(0, 300),
      key: typeof input.key === 'string' && input.key !== '' ? input.key.trim().slice(0, 300) : existing && existing.key || '',
    };
  }
  function addStation(input) {
    const clean = cleanStation(input);
    let id = slug(input.id || clean.name) || 'station';
    const base = id; let n = 2;
    while (stations().some((s) => s.id === id)) id = `${base}-${n++}`;
    const station = { id, ...clean };
    stations().push(station); store.save();
    return view(station);
  }
  function updateStation(id, input) {
    const station = find(id);
    Object.assign(station, cleanStation(input, station)); store.save(); cache.delete(id); libraries.delete(id);
    return view(station);
  }
  function removeStation(id) {
    const station = find(id);
    store.data.stations = stations().filter((s) => s !== station);
    store.data.jobs = store.data.jobs.filter((j) => j.status !== 'waiting' || !j.targets.some((t) => t.stationId === id));
    store.save(); cache.delete(id); libraries.delete(id);
  }

  // ---------- music controls ----------
  async function control(id, action, body = {}) {
    const station = find(id);
    const st = await status(station, { fresh: true });
    if (action === 'skip') { needs(st, 'skip'); return call(station, 'POST', '/music/skip'); }
    if (action === 'volume') {
      needs(st, 'volume');
      const volume = Number(body.volume);
      if (!Number.isFinite(volume) || volume < 0 || volume > 1) throw new HubError('volume must be between 0 and 1');
      return call(station, 'POST', '/music/volume', { body: { volume } });
    }
    if (action === 'playlist') { needs(st, 'playlists'); return call(station, 'POST', '/music/playlist', { body: { name: String(body.name || '') } }); }
    throw new HubError('unknown action', 404);
  }
  async function groupControl(action, body) {
    const list = targets(body);
    return Promise.all(list.map(async (s) => {
      try { return { station: s.id, ok: true, result: await control(s.id, action, body) }; } catch (err) { return { station: s.id, ok: false, error: err.message }; }
    }));
  }

  // ---------- playlists ----------
  const playlists = () => store.data.playlists;
  function cleanName(name) {
    const n = String(name || '');
    if (!/^[A-Za-z0-9][A-Za-z0-9 _.-]{0,59}$/.test(n)) throw new HubError('playlist names are letters, numbers, spaces, dots, dashes and underscores (up to 60)');
    return n;
  }
  function cleanItems(items) {
    if (!Array.isArray(items) || !items.length) throw new HubError('items must be a non-empty list of track paths');
    if (items.length > 5000) throw new HubError('at most 5000 tracks per playlist');
    return [...new Set(items.map((i) => String(i).slice(0, 400)))];
  }
  function savePlaylist(name, body) {
    const n = cleanName(name);
    playlists()[n] = { items: cleanItems(body.items), note: String(body.note || '').slice(0, 300), updatedAt: now() };
    store.save();
    return { name: n, ...playlists()[n] };
  }
  const getPlaylist = (name) => {
    const p = playlists()[name];
    if (!p) throw new HubError(`no playlist "${String(name).slice(0, 40)}"`, 404);
    return p;
  };

  async function library(station, { fresh = false } = {}) {
    const hit = libraries.get(station.id);
    if (!fresh && hit && now() - hit.at < 60000) return hit.paths;
    const out = await call(station, 'GET', '/music/library', { timeout: 20000 });
    const paths = new Set((out.tracks || []).map((t) => t.path));
    libraries.set(station.id, { at: now(), paths, count: paths.size });
    return paths;
  }

  async function coverage(name, sel = { stations: 'all' }) {
    const p = getPlaylist(name);
    return Promise.all(targets(sel).map(async (s) => {
      try {
        const st = await status(s);
        needs(st, 'library');
        const have = await library(s);
        const missing = p.items.filter((i) => !have.has(i));
        return { station: s.id, ok: true, have: p.items.length - missing.length, total: p.items.length, missing: missing.slice(0, 25) };
      } catch (err) { return { station: s.id, ok: false, error: err.message }; }
    }));
  }

  async function pushPlaylist(name, body) {
    const p = getPlaylist(name);
    const apply = body.apply === true;
    return Promise.all(targets(body).map(async (s) => {
      try {
        const st = await status(s, { fresh: true });
        needs(st, 'definePlaylist');
        const saved = await call(s, 'PUT', `/music/playlists/${encodeURIComponent(name)}`, { body: { items: p.items }, timeout: 30000 });
        let applied = false;
        if (apply) { await call(s, 'POST', '/music/playlist', { body: { name: `list:${name}` } }); applied = true; }
        return { station: s.id, ok: true, written: saved.written, missing: (saved.missing || []).length, missingSample: (saved.missing || []).slice(0, 10), applied };
      } catch (err) { return { station: s.id, ok: false, error: err.message }; }
    }));
  }

  // A playlist definition from one station's folder, so a library laid out the same way elsewhere can be matched.
  async function importPlaylist(body) {
    const station = find(body.station);
    const prefix = String(body.prefix || '').replace(/^\/+|\/+$/g, '');
    const out = await call(station, 'GET', '/music/library', { timeout: 20000 });
    const items = (out.tracks || []).map((t) => t.path).filter((p) => !prefix || p.startsWith(`${prefix}/`));
    if (!items.length) throw new HubError(`${station.name} has no tracks under "${prefix}"`);
    return savePlaylist(body.name || prefix || station.id, { items, note: `imported from ${station.name}` });
  }

  // ---------- host settings ----------
  async function hostSettings(id) {
    const station = find(id);
    const st = await status(station, { fresh: true });
    needs(st, 'host');
    return (await call(station, 'GET', '/host')).settings || {};
  }
  async function syncHost(body) {
    const source = await hostSettings(body.from);
    const fields = Array.isArray(body.fields) && body.fields.length ? body.fields.filter((f) => typeof f === 'string') : HOST_FIELDS;
    const patch = {};
    for (const f of fields) if (source[f] !== undefined && source[f] !== '') patch[f] = source[f];
    if (!Object.keys(patch).length) throw new HubError(`${body.from} has no settings to copy`);
    const list = targets({ stations: body.to }).filter((s) => s.id !== body.from);
    const results = await Promise.all(list.map(async (s) => {
      try {
        const st = await status(s, { fresh: true });
        needs(st, 'host');
        await call(s, 'PUT', '/host', { body: patch });
        return { station: s.id, ok: true };
      } catch (err) { return { station: s.id, ok: false, error: err.message }; }
    }));
    return { copied: Object.keys(patch), results };
  }

  // ---------- broadcasts ----------
  async function voiceCall(method, path, body) {
    if (!voiceUrl) throw new HubError('set VOICE_URL (and VOICE_KEY) to broadcast clips from the voice server', 503);
    return call({ name: 'the voice server', url: voiceUrl, key: voiceKey }, method, path, { body });
  }
  async function fetchClipAudio(clipId) {
    const link = await voiceCall('POST', `/clips/${encodeURIComponent(clipId)}/link`, { hours: 1 });
    return fetchAudio(link.url);
  }
  async function fetchAudio(url) {
    let res;
    try { res = await fetchImpl(url, { signal: AbortSignal.timeout(20000) }); } catch (err) { throw new HubError(`could not fetch the audio: ${err.message}`, 502); }
    if (!res.ok) throw new HubError(`could not fetch the audio (${res.status})`, 502);
    const buffer = Buffer.from(await res.arrayBuffer());
    if (!buffer.length || buffer.length > maxAudioBytes) throw new HubError('the audio is empty or too large');
    return { buffer, contentType: res.headers.get('content-type') || 'audio/mpeg' };
  }

  // Step 1: put the audio on every target without playing it. Step 2: fire them together.
  async function stage({ buffer, contentType }, list, title) {
    return Promise.all(list.map(async (s) => {
      const t0 = now();
      try {
        const st = await status(s, { fresh: true });
        needs(st, 'clip');
        const out = await call(s, 'POST', '/ingest', { raw: buffer, contentType, query: { title, play: '0' }, timeout: 30000 });
        return { station: s.id, ok: true, clipId: out.clip.id, stagedMs: now() - t0 };
      } catch (err) { return { station: s.id, ok: false, error: err.message }; }
    }));
  }
  async function fire(staged, preempt) {
    const started = now();
    const results = await Promise.all(staged.map(async (t) => {
      if (!t.ok) return t;
      try {
        const out = await call(find(t.station), 'POST', `/clips/${encodeURIComponent(t.clipId)}/play`, { body: preempt ? { preempt: true } : {} });
        return { ...t, played: out && out.played !== false, reason: out && out.reason || '', firedAfterMs: now() - started };
      } catch (err) { return { ...t, ok: false, error: err.message }; }
    }));
    const times = results.filter((r) => r.firedAfterMs !== undefined).map((r) => r.firedAfterMs);
    return { results, spreadMs: times.length ? Math.max(...times) - Math.min(...times) : 0 };
  }

  async function broadcast(body, audioInput) {
    const list = targets(body);
    const title = String(body.title || 'Broadcast').slice(0, 100);
    let audio = audioInput;
    if (!audio) {
      if (body.clipId) audio = await fetchClipAudio(body.clipId);
      else if (body.url) audio = await fetchAudio(String(body.url));
      else throw new HubError('give a clipId (from the voice server), a url, or upload audio');
    }
    let at = null;
    if (body.at !== undefined && body.at !== null && body.at !== '') {
      at = typeof body.at === 'number' ? now() + body.at * 1000 : Date.parse(body.at);
      if (!Number.isFinite(at)) throw new HubError('at must be a date/time or a number of seconds from now');
      if (at - now() > MAX_AHEAD_MS) throw new HubError('at can be at most 24 hours ahead');
      if (at <= now() + 1500) at = null;
    }
    const staged = await stage(audio, list, title);
    if (!staged.some((t) => t.ok)) return { staged, results: staged, played: false };
    if (!at) return { ...(await fire(staged, body.preempt === true)), played: true };
    const job = { id: crypto.randomBytes(5).toString('hex'), at, title, preempt: body.preempt === true, status: 'waiting',
      targets: staged.filter((t) => t.ok).map((t) => ({ stationId: t.station, clipId: t.clipId })), failedToStage: staged.filter((t) => !t.ok) };
    store.data.jobs.push(job); store.save();
    return { job: jobView(job), staged, played: false };
  }
  const jobView = (j) => ({ id: j.id, at: j.at, title: j.title, status: j.status, stations: j.targets.map((t) => t.stationId), preempt: j.preempt, result: j.result });

  async function runDueJobs() {
    for (const job of store.data.jobs.filter((j) => j.status === 'waiting' && j.at <= now())) {
      job.status = 'running';
      try {
        job.result = await fire(job.targets.map((t) => ({ station: t.stationId, ok: true, clipId: t.clipId })), job.preempt);
        job.status = job.result.results.some((r) => r.ok) ? 'done' : 'failed';
      } catch (err) { job.status = 'failed'; job.result = { error: err.message }; }
      store.save();
    }
    // Finished jobs are kept for a day so the UI can show what happened.
    const keep = store.data.jobs.filter((j) => j.status === 'waiting' || j.status === 'running' || now() - j.at < 24 * 3600e3);
    if (keep.length !== store.data.jobs.length) { store.data.jobs = keep; store.save(); }
  }
  function start() { if (!ticker) { ticker = setInterval(() => runDueJobs().catch(() => {}), tickMs); if (ticker.unref) ticker.unref(); } }
  function stop() { if (ticker) clearInterval(ticker); ticker = null; for (const t of jobTimers) clearTimeout(t); }

  // ---------- HTTP ----------
  async function readBody(req, limit) {
    const chunks = []; let size = 0;
    for await (const c of req) { size += c.length; if (size > limit) throw new HubError('body is too large', 413); chunks.push(c); }
    return Buffer.concat(chunks);
  }
  const json = async (req) => {
    const buf = await readBody(req, 4e6);
    if (!buf.length) return {};
    try { return JSON.parse(buf.toString()); } catch (err) { throw new HubError('the body is not valid JSON'); }
  };

  const routes = [];
  const add = (method, pattern, handler, { open = false } = {}) => routes.push({ method, re: new RegExp(`^${pattern.replace(/:(\w+)/g, '(?<$1>[^/]+)')}$`), handler, open });

  add('GET', '/health', async () => ({ ok: true, stations: stations().length, time: now() }), { open: true });
  add('POST', '/auth/login', async (ctx) => {
    if (loginLimit.blocked(ctx.ip)) throw new HubError('too many attempts, wait a minute', 429);
    const body = await json(ctx.req);
    if (!auth.checkKey(body.key || '')) { loginLimit.fail(ctx.ip); throw new HubError('wrong key', 401); }
    return auth.issue();
  }, { open: true });

  add('GET', '/stations', async (ctx) => ({ stations: await Promise.all(stations().map((s) => status(s, { fresh: ctx.query.get('fresh') === '1' }))) }));
  add('POST', '/stations', async (ctx) => ({ status: 201, body: addStation(await json(ctx.req)) }));
  add('GET', '/stations/:id', async (ctx) => {
    const s = find(ctx.params.id);
    const st = await status(s, { fresh: true });
    let playlistsHere = [];
    if (st.online && st.capabilities.playlists) playlistsHere = await call(s, 'GET', '/music/playlists').catch(() => []);
    return { ...st, playlists: playlistsHere };
  });
  add('PUT', '/stations/:id', async (ctx) => updateStation(ctx.params.id, await json(ctx.req)));
  add('DELETE', '/stations/:id', async (ctx) => { removeStation(ctx.params.id); return { ok: true }; });
  add('POST', '/stations/:id/:action', async (ctx) => control(ctx.params.id, ctx.params.action, await json(ctx.req)));
  add('GET', '/stations/:id/library', async (ctx) => { const s = find(ctx.params.id); return { tracks: (await call(s, 'GET', '/music/library', { timeout: 20000 })).tracks }; });
  add('GET', '/stations/:id/host', async (ctx) => ({ settings: await hostSettings(ctx.params.id) }));

  add('POST', '/group/:action', async (ctx) => ({ results: await groupControl(ctx.params.action, await json(ctx.req)) }));

  add('GET', '/playlists', async () => ({ playlists: Object.entries(playlists()).map(([name, p]) => ({ name, count: p.items.length, note: p.note, updatedAt: p.updatedAt })) }));
  add('POST', '/playlists/import', async (ctx) => ({ status: 201, body: await importPlaylist(await json(ctx.req)) }));
  add('GET', '/playlists/:name', async (ctx) => ({ name: ctx.params.name, ...getPlaylist(decodeURIComponent(ctx.params.name)) }));
  add('PUT', '/playlists/:name', async (ctx) => savePlaylist(decodeURIComponent(ctx.params.name), await json(ctx.req)));
  add('DELETE', '/playlists/:name', async (ctx) => { getPlaylist(decodeURIComponent(ctx.params.name)); delete playlists()[decodeURIComponent(ctx.params.name)]; store.save(); return { ok: true }; });
  add('GET', '/playlists/:name/coverage', async (ctx) => ({ results: await coverage(decodeURIComponent(ctx.params.name)) }));
  add('POST', '/playlists/:name/push', async (ctx) => ({ results: await pushPlaylist(decodeURIComponent(ctx.params.name), await json(ctx.req)) }));

  add('POST', '/sync/host', async (ctx) => syncHost(await json(ctx.req)));

  add('POST', '/broadcast', async (ctx) => broadcast(await json(ctx.req)));
  add('POST', '/broadcast/upload', async (ctx) => {
    const buffer = await readBody(ctx.req, maxAudioBytes);
    if (!buffer.length) throw new HubError('send the audio as the request body');
    const q = ctx.query;
    return broadcast({
      stations: q.get('stations') === 'all' || !q.get('stations') ? 'all' : q.get('stations').split(','), site: q.get('site') || undefined,
      title: q.get('title') || undefined, at: q.get('at') || undefined, preempt: q.get('preempt') === '1',
    }, { buffer, contentType: ctx.req.headers['content-type'] || 'audio/mpeg' });
  });
  add('GET', '/jobs', async () => ({ jobs: store.data.jobs.map(jobView) }));
  add('DELETE', '/jobs/:id', async (ctx) => {
    const job = store.data.jobs.find((j) => j.id === ctx.params.id && j.status === 'waiting');
    if (!job) throw new HubError('no waiting job with that id', 404);
    job.status = 'cancelled'; store.save();
    return { ok: true };
  });

  async function handle(req, res) {
    const url = new URL(req.url, 'http://hub');
    const cors = { 'access-control-allow-origin': corsOrigin, 'access-control-allow-headers': 'authorization, content-type, x-api-key', 'access-control-allow-methods': 'GET, POST, PUT, DELETE, OPTIONS', 'access-control-max-age': '600' };
    const send = (status, body) => { const text = JSON.stringify(body); res.writeHead(status, { ...cors, 'content-type': 'application/json', 'content-length': Buffer.byteLength(text) }); res.end(text); };
    if (req.method === 'OPTIONS') { res.writeHead(204, cors); return res.end(); }
    try {
      const route = routes.find((r) => r.method === req.method && r.re.test(url.pathname));
      if (!route) {
        if (routes.some((r) => r.re.test(url.pathname))) throw new HubError('method not allowed', 405);
        throw new HubError('not found', 404);
      }
      if (!route.open && !auth.allowed(req)) throw new HubError('unauthorized', 401);
      const params = route.re.exec(url.pathname).groups || {};
      const out = await route.handler({ req, params, query: url.searchParams, ip: req.socket.remoteAddress || '' });
      if (out && out.status && out.body !== undefined && Object.keys(out).length === 2) return send(out.status, out.body);
      return send(200, out);
    } catch (err) {
      if (err instanceof HubError) return send(err.status, { error: err.message });
      return send(500, { error: 'internal error' });
    }
  }

  return { handle, start, stop, runDueJobs, status, auth, _call: call };
}

module.exports = { createHub, HubError };
