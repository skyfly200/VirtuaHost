const test = require('node:test');
const assert = require('node:assert');
const http = require('http');
const { createHub } = require('../hub');
const { createStore } = require('../store');

const KEY = 'a-long-enough-hub-key';

// A fake station that implements the agent API and records what it receives.
async function fakeStation({ kind = 'liquidsoap', name = 'Fake', key = 'station-secret-key', caps = {}, now = { title: 'A - B', listeners: 3 }, library = ['x/one.mp3', 'x/two.mp3'], host = { settings: { preset: 'chip', fx: 'hull', tone: 'grumbly', voice: 'Local', templates: ['t'] } }, delay = 0 } = {}) {
  const calls = [];
  let staged = 0;
  const capabilities = { skip: true, volume: true, playlists: true, library: true, definePlaylist: true, clip: true, host: true, ...caps };
  const server = http.createServer(async (req, res) => {
    const chunks = []; for await (const c of req) chunks.push(c);
    const body = Buffer.concat(chunks);
    const url = new URL(req.url, 'http://x');
    const rec = { method: req.method, path: url.pathname, query: Object.fromEntries(url.searchParams), key: req.headers['x-api-key'], body: body.length ? (req.headers['content-type'] || '').includes('json') ? JSON.parse(body.toString()) : body : undefined, at: Date.now() };
    calls.push(rec);
    const send = (s, o) => { res.writeHead(s, { 'content-type': 'application/json' }); res.end(JSON.stringify(o)); };
    if (delay) await new Promise((r) => setTimeout(r, delay));
    if (rec.key !== key) return send(401, { error: 'unauthorized' });
    const p = url.pathname;
    if (p === '/agent/info') return send(200, { kind, name, capabilities });
    if (p === '/music/now') return send(200, now);
    if (p === '/music/skip' || p === '/music/volume' || p === '/music/playlist') return send(200, { ok: true });
    if (p === '/music/playlists' && req.method === 'GET') return send(200, ['Rock', 'list:late']);
    if (p === '/music/library') return send(200, { tracks: library.map((x) => ({ path: x, size: 1 })) });
    if (p.startsWith('/music/playlists/') && req.method === 'PUT') { const items = rec.body.items; const have = items.filter((i) => library.includes(i)); return send(200, { written: have.length, missing: items.filter((i) => !library.includes(i)) }); }
    if (p === '/ingest') { staged += 1; return send(201, { clip: { id: `c${staged}` }, played: false }); }
    if (/^\/clips\/[^/]+\/play$/.test(p)) return send(200, { played: true });
    if (p === '/host' && req.method === 'GET') return send(200, host);
    if (p === '/host' && req.method === 'PUT') return send(200, { settings: rec.body });
    return send(404, { error: 'not found' });
  });
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  return { calls, url: `http://127.0.0.1:${server.address().port}`, key, close: () => { server.close(); server.closeAllConnections?.(); }, by: (path) => calls.filter((c) => c.path === path) };
}

async function boot(opts = {}) {
  const store = createStore(null);
  const hub = createHub({ store, key: KEY, statusTtlMs: 0, ...opts });
  const server = http.createServer((req, res) => hub.handle(req, res));
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  const base = `http://127.0.0.1:${server.address().port}`;
  const call = async (method, p, body, headers = {}) => {
    const isBuf = Buffer.isBuffer(body);
    const res = await fetch(base + p, { method, headers: { 'x-api-key': KEY, ...(isBuf ? {} : body !== undefined ? { 'content-type': 'application/json' } : {}), ...headers }, body: isBuf ? body : body !== undefined ? JSON.stringify(body) : undefined });
    return { status: res.status, json: await res.json().catch(() => null), headers: res.headers };
  };
  return { call, hub, store, base, close: () => { hub.stop(); server.close(); server.closeAllConnections?.(); } };
}

const addStation = (t, s, extra = {}) => t.call('POST', '/stations', { name: extra.name || 'Fake', url: s.url, key: s.key, ...extra });

test('the hub needs a key and issues short-lived tokens for it', async () => {
  assert.throws(() => createHub({ store: createStore(null), key: 'short' }), /HUB_KEY/);
  let clock = 1000;
  const t = await boot({ now: () => clock, ttlMs: 60000 });
  assert.strictEqual((await fetch(`${t.base}/stations`)).status, 401);
  assert.strictEqual((await fetch(`${t.base}/stations`, { headers: { 'x-api-key': 'wrong' } })).status, 401);
  assert.strictEqual((await fetch(`${t.base}/health`)).status, 200);                      // health is open
  assert.strictEqual((await t.call('POST', '/auth/login', { key: 'nope' }, { 'x-api-key': '' })).status, 401);
  const login = await t.call('POST', '/auth/login', { key: KEY }, { 'x-api-key': '' });
  assert.strictEqual(login.status, 200);
  const withToken = await fetch(`${t.base}/stations`, { headers: { authorization: `Bearer ${login.json.token}` } });
  assert.strictEqual(withToken.status, 200);
  const tampered = login.json.token.slice(0, -2) + 'xx';
  assert.strictEqual((await fetch(`${t.base}/stations`, { headers: { authorization: `Bearer ${tampered}` } })).status, 401);
  clock += 61000;                                                                         // the token has expired
  assert.strictEqual((await fetch(`${t.base}/stations`, { headers: { authorization: `Bearer ${login.json.token}` } })).status, 401);
  t.close();
});

test('too many wrong keys are blocked', async () => {
  const t = await boot();
  for (let i = 0; i < 10; i++) assert.strictEqual((await t.call('POST', '/auth/login', { key: 'wrong' }, { 'x-api-key': '' })).status, 401);
  assert.strictEqual((await t.call('POST', '/auth/login', { key: KEY }, { 'x-api-key': '' })).status, 429);
  t.close();
});

test('stations: add, list with live status, never show the key, update, remove', async () => {
  const s = await fakeStation({ name: 'Ship' });
  const t = await boot();
  const added = await addStation(t, s, { name: 'Ship Radio', site: 'Way High' });
  assert.strictEqual(added.status, 201);
  const { id, name, site, url, notes, hasKey, ...extra } = added.json;
  assert.deepStrictEqual({ id, name, site, url, notes, hasKey }, { id: 'ship-radio', name: 'Ship Radio', site: 'Way High', url: s.url, notes: '', hasKey: true });
  assert.deepStrictEqual([extra.connection, extra.machineTz, extra.broadcastTz, extra.mode, extra.hasPullKey, extra.jit.enabled, extra.jit.shadow], ['push', '', '', 'unknown', false, false, true]);   // new, additive fields
  assert.strictEqual((await addStation(t, s, { name: 'Ship Radio' })).json.id, 'ship-radio-2');       // ids stay unique
  const list = (await t.call('GET', '/stations')).json.stations;
  assert.strictEqual(list[0].online, true);
  assert.strictEqual(list[0].kind, 'liquidsoap');
  assert.deepStrictEqual(list[0].now, { title: 'A - B', listeners: 3 });
  assert.ok(!JSON.stringify(list).includes(s.key));                                                    // the station key never leaves the hub
  assert.strictEqual(s.calls[0].key, 'station-secret-key');                                                             // but the hub sends it to the station
  const upd = await t.call('PUT', '/stations/ship-radio', { name: 'Ship FM', key: '' });
  assert.strictEqual(upd.json.name, 'Ship FM');
  assert.strictEqual(upd.json.hasKey, true);                                                           // an empty key keeps the old one
  assert.strictEqual((await t.call('POST', '/stations', { name: 'x', url: 'ftp://bad' })).status, 400);
  assert.strictEqual((await t.call('POST', '/stations', { url: s.url })).status, 400);
  assert.strictEqual((await t.call('DELETE', '/stations/ship-radio')).status, 200);
  assert.strictEqual((await t.call('GET', '/stations/ship-radio')).status, 404);
  s.close(); t.close();
});

test('an offline or unauthorised station is reported, not fatal', async () => {
  const good = await fakeStation({ name: 'Good' });
  const wrongKey = await fakeStation({ name: 'Locked', key: 'right' });
  const t = await boot();
  await addStation(t, good, { name: 'Good' });
  await addStation(t, wrongKey, { name: 'Locked', key: 'wrong' });
  await t.call('POST', '/stations', { name: 'Gone', url: 'http://127.0.0.1:9', key: 'k' });
  const list = (await t.call('GET', '/stations')).json.stations;
  assert.deepStrictEqual(list.map((s) => [s.id, s.online]), [['good', true], ['locked', false], ['gone', false]]);
  assert.match(list[1].error, /unauthorized/);
  assert.match(list[2].error, /not reachable/);
  good.close(); wrongKey.close(); t.close();
});

test('skip, volume and playlist go to one station; unsupported actions say so', async () => {
  const s = await fakeStation({ caps: {} });
  const rj = await fakeStation({ kind: 'radiodj', name: 'Win', caps: { skip: false, volume: false, playlists: false } });
  const t = await boot();
  await addStation(t, s, { name: 'A' });
  await addStation(t, rj, { name: 'B' });
  assert.strictEqual((await t.call('POST', '/stations/a/skip', {})).status, 200);
  assert.strictEqual((await t.call('POST', '/stations/a/volume', { volume: 0.4 })).status, 200);
  assert.deepStrictEqual(s.by('/music/volume')[0].body, { volume: 0.4 });
  assert.strictEqual((await t.call('POST', '/stations/a/volume', { volume: 3 })).status, 400);
  assert.strictEqual((await t.call('POST', '/stations/a/volume', { volume: 'loud' })).status, 400);
  await t.call('POST', '/stations/a/playlist', { name: 'Rock' });
  assert.deepStrictEqual(s.by('/music/playlist')[0].body, { name: 'Rock' });
  const refused = await t.call('POST', '/stations/b/skip', {});
  assert.strictEqual(refused.status, 501);
  assert.match(refused.json.error, /radiodj\) does not support skip/);
  assert.strictEqual(rj.by('/music/skip').length, 0);                                                  // never even sent
  assert.strictEqual((await t.call('POST', '/stations/a/explode', {})).status, 404);
  const detail = (await t.call('GET', '/stations/a')).json;
  assert.deepStrictEqual(detail.playlists, ['Rock', 'list:late']);
  s.close(); rj.close(); t.close();
});

test('group actions report each station separately', async () => {
  const a = await fakeStation({ name: 'A' });
  const b = await fakeStation({ name: 'B', caps: { volume: false } });
  const t = await boot();
  await addStation(t, a, { name: 'A', site: 'north' });
  await addStation(t, b, { name: 'B', site: 'south' });
  const all = (await t.call('POST', '/group/volume', { stations: 'all', volume: 0.5 })).json.results;
  assert.deepStrictEqual(all.map((r) => [r.station, r.ok]), [['a', true], ['b', false]]);
  assert.match(all[1].error, /does not support volume/);
  const north = (await t.call('POST', '/group/skip', { site: 'north' })).json.results;
  assert.deepStrictEqual(north.map((r) => r.station), ['a']);
  assert.strictEqual((await t.call('POST', '/group/skip', {})).status, 400);
  assert.strictEqual((await t.call('POST', '/group/skip', { stations: ['nope'] })).status, 404);
  a.close(); b.close(); t.close();
});

test('playlists: save, coverage per station, push (and apply), and a station that cannot define them', async () => {
  const a = await fakeStation({ name: 'A', library: ['x/one.mp3', 'x/two.mp3', 'y/three.mp3'] });
  const b = await fakeStation({ name: 'B', library: ['x/one.mp3'] });
  const rj = await fakeStation({ kind: 'radiodj', name: 'RJ', caps: { definePlaylist: false } });
  const t = await boot();
  for (const [s, n] of [[a, 'A'], [b, 'B'], [rj, 'RJ']]) await addStation(t, s, { name: n });
  assert.strictEqual((await t.call('PUT', '/playlists/Late Night', { items: ['x/one.mp3', 'x/two.mp3', 'x/one.mp3'], note: 'for the ship' })).json.items.length, 2);   // duplicates dropped
  assert.strictEqual((await t.call('PUT', '/playlists/bad%2Fname', { items: ['a.mp3'] })).status, 400);
  assert.strictEqual((await t.call('PUT', '/playlists/ok', { items: [] })).status, 400);
  assert.deepStrictEqual((await t.call('GET', '/playlists')).json.playlists.map((p) => [p.name, p.count]), [['Late Night', 2]]);

  const cov = (await t.call('GET', '/playlists/Late%20Night/coverage')).json.results;
  assert.deepStrictEqual(cov.filter((c) => c.ok).map((c) => [c.station, c.have, c.total]), [['a', 2, 2], ['b', 1, 2], ['rj', 2, 2]]);
  assert.deepStrictEqual(cov.find((c) => c.station === 'b').missing, ['x/two.mp3']);

  const pushed = (await t.call('POST', '/playlists/Late%20Night/push', { stations: 'all', apply: true })).json.results;
  const by = Object.fromEntries(pushed.map((r) => [r.station, r]));
  assert.deepStrictEqual([by.a.ok, by.a.written, by.a.missing, by.a.applied], [true, 2, 0, true]);
  assert.deepStrictEqual([by.b.ok, by.b.written, by.b.missing], [true, 1, 1]);
  assert.strictEqual(by.rj.ok, false);
  assert.match(by.rj.error, /does not support definePlaylist/);
  assert.deepStrictEqual(a.by('/music/playlist')[0].body, { name: 'list:Late Night' });           // applied as a saved list
  assert.strictEqual(b.by('/music/playlist').length === 1, true);
  assert.strictEqual((await t.call('GET', '/playlists/nope')).status, 404);
  assert.strictEqual((await t.call('DELETE', '/playlists/Late%20Night')).status, 200);
  assert.strictEqual((await t.call('GET', '/playlists/Late%20Night')).status, 404);
  a.close(); b.close(); rj.close(); t.close();
});

test('a playlist can be imported from a folder on one station', async () => {
  const a = await fakeStation({ library: ['rock/a.mp3', 'rock/b.mp3', 'jazz/c.mp3'] });
  const t = await boot();
  await addStation(t, a, { name: 'A' });
  const out = await t.call('POST', '/playlists/import', { station: 'a', prefix: 'rock', name: 'Rock Set' });
  assert.strictEqual(out.status, 201);
  assert.deepStrictEqual(out.json.items, ['rock/a.mp3', 'rock/b.mp3']);
  assert.strictEqual((await t.call('POST', '/playlists/import', { station: 'a', prefix: 'metal' })).status, 400);
  a.close(); t.close();
});

test('host settings are copied between stations without the voice unless asked', async () => {
  const src = await fakeStation({ name: 'Src' });
  const dst = await fakeStation({ name: 'Dst' });
  const noHost = await fakeStation({ name: 'None', caps: { host: false } });
  const t = await boot();
  for (const [s, n] of [[src, 'Src'], [dst, 'Dst'], [noHost, 'None']]) await addStation(t, s, { name: n });
  const out = (await t.call('POST', '/sync/host', { from: 'src', to: 'all' })).json;
  assert.deepStrictEqual(out.copied.sort(), ['fx', 'preset', 'templates', 'tone']);
  assert.deepStrictEqual(out.results.map((r) => [r.station, r.ok]), [['dst', true], ['none', false]]);   // never copies onto the source itself
  assert.deepStrictEqual(dst.by('/host').find((c) => c.method === 'PUT').body, { preset: 'chip', fx: 'hull', tone: 'grumbly', templates: ['t'] });
  await t.call('POST', '/sync/host', { from: 'src', to: ['dst'], fields: ['voice'] });
  assert.deepStrictEqual(dst.by('/host').filter((c) => c.method === 'PUT')[1].body, { voice: 'Local' });
  src.close(); dst.close(); noHost.close(); t.close();
});

test('a broadcast is staged on every station first, then fired together', async () => {
  const a = await fakeStation({ name: 'A' });
  const b = await fakeStation({ name: 'B', kind: 'radiodj' });
  const off = await fakeStation({ name: 'Off', caps: { clip: false } });
  const t = await boot();
  for (const [s, n] of [[a, 'A'], [b, 'B'], [off, 'Off']]) await addStation(t, s, { name: n });
  const audio = Buffer.from('ID3-audio-bytes');
  const out = await t.call('POST', '/broadcast/upload?stations=a,b,off&title=Station%20ID', audio, { 'content-type': 'audio/mpeg' });
  assert.strictEqual(out.status, 200);
  assert.deepStrictEqual(out.json.results.map((r) => [r.station, r.ok]), [['a', true], ['b', true], ['off', false]]);
  assert.match(out.json.results[2].error, /does not support clip/);
  for (const s of [a, b]) {
    assert.deepStrictEqual(s.by('/ingest')[0].body, audio);
    assert.deepStrictEqual([s.by('/ingest')[0].query.title, s.by('/ingest')[0].query.play], ['Station ID', '0']);      // staged, not played
    assert.strictEqual(s.calls.findIndex((c) => c.path === '/ingest') < s.calls.findIndex((c) => /\/play$/.test(c.path)), true);
    assert.strictEqual(s.calls.filter((c) => /\/clips\/c1\/play$/.test(c.path)).length, 1);
  }
  assert.ok(out.json.spreadMs < 500);
  a.close(); b.close(); off.close(); t.close();
});

test('a broadcast can name a clip on the voice server, which is fetched through a signed link', async () => {
  const voice = await new Promise((resolve) => {
    const calls = [];
    const server = http.createServer((req, res) => {
      calls.push(`${req.method} ${req.url}`);
      if (req.url.startsWith('/clips/clip1/link')) { res.writeHead(200, { 'content-type': 'application/json' }); return res.end(JSON.stringify({ url: `http://127.0.0.1:${server.address().port}/a/clip1/x.mp3?sig=1` })); }
      if (req.url.startsWith('/a/clip1')) { res.writeHead(200, { 'content-type': 'audio/mpeg' }); return res.end('voice-audio'); }
      res.writeHead(404); res.end('{}');
    });
    server.listen(0, '127.0.0.1', () => resolve({ calls, url: `http://127.0.0.1:${server.address().port}`, close: () => server.close() }));
  });
  const a = await fakeStation({ name: 'A' });
  const t = await boot({ voiceUrl: voice.url, voiceKey: 'vk' });
  await addStation(t, a, { name: 'A' });
  const out = await t.call('POST', '/broadcast', { clipId: 'clip1', stations: 'all', preempt: true });
  assert.strictEqual(out.status, 200);
  assert.deepStrictEqual(a.by('/ingest')[0].body.toString(), 'voice-audio');
  assert.deepStrictEqual(a.calls.find((c) => /\/play$/.test(c.path)).body, { preempt: true });
  assert.strictEqual((await t.call('POST', '/broadcast', { stations: 'all' })).status, 400);              // no audio source
  t.close();
  const noVoice = await boot();
  await addStation(noVoice, a, { name: 'A' });
  assert.strictEqual((await noVoice.call('POST', '/broadcast', { clipId: 'c', stations: 'all' })).status, 503);
  noVoice.close(); a.close(); voice.close();
});

test('a timed broadcast is staged now and fired when due, and can be cancelled', async () => {
  let clock = Date.parse('2026-10-20T12:00:00Z');
  const a = await fakeStation({ name: 'A' });
  const t = await boot({ now: () => clock });
  await addStation(t, a, { name: 'A' });
  const out = await t.call('POST', '/broadcast/upload?stations=a&at=2026-10-20T12:05:00Z', Buffer.from('audio'));
  assert.strictEqual(out.json.played, false);
  assert.strictEqual(out.json.job.status, 'waiting');
  assert.strictEqual(a.by('/ingest').length, 1);
  assert.strictEqual(a.calls.filter((c) => /\/play$/.test(c.path)).length, 0);
  await t.hub.runDueJobs();
  assert.strictEqual(a.calls.filter((c) => /\/play$/.test(c.path)).length, 0);                            // not due yet
  clock += 5 * 60000 + 1;
  await t.hub.runDueJobs();
  assert.strictEqual(a.calls.filter((c) => /\/play$/.test(c.path)).length, 1);
  assert.strictEqual((await t.call('GET', '/jobs')).json.jobs[0].status, 'done');

  const second = await t.call('POST', '/broadcast/upload?stations=a&at=2026-10-20T13:00:00Z', Buffer.from('audio2'));
  assert.strictEqual((await t.call('DELETE', `/jobs/${second.json.job.id}`)).status, 200);
  clock += 3600e3;
  await t.hub.runDueJobs();
  assert.strictEqual(a.calls.filter((c) => /\/play$/.test(c.path)).length, 1);                            // cancelled: never fired
  assert.strictEqual((await t.call('DELETE', `/jobs/${second.json.job.id}`)).status, 404);
  assert.strictEqual((await t.call('POST', '/broadcast/upload?stations=a&at=2026-10-30T00:00:00Z', Buffer.from('x'))).status, 400);   // too far ahead
  assert.strictEqual((await t.call('POST', '/broadcast/upload?stations=a&at=nonsense', Buffer.from('x'))).status, 400);
  a.close(); t.close();
});

test('request problems come back as JSON errors', async () => {
  const t = await boot();
  assert.strictEqual((await t.call('GET', '/nope')).status, 404);
  assert.strictEqual((await t.call('DELETE', '/health')).status, 405);
  const bad = await fetch(`${t.base}/stations`, { method: 'POST', headers: { 'x-api-key': KEY, 'content-type': 'application/json' }, body: '{oops' });
  assert.strictEqual(bad.status, 400);
  const pre = await fetch(`${t.base}/stations`, { method: 'OPTIONS' });
  assert.strictEqual(pre.status, 204);
  assert.strictEqual(pre.headers.get('access-control-allow-origin'), '*');
  t.close();
});
