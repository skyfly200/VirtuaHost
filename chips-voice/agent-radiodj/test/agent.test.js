const test = require('node:test');
const assert = require('node:assert');
const http = require('http');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { createAgent } = require('../agent');

// A stand-in for RadioDJ's REST plugin that records what it is asked.
async function fakeRadioDJ(npjson = '{"Artist":"Boards of Canada","Title":"Roygbiv","PlayingTrackRemainingSeconds":"42"}') {
  const calls = [];
  const server = http.createServer((req, res) => {
    const url = new URL(req.url, 'http://x');
    calls.push({ path: url.pathname, ...Object.fromEntries(url.searchParams) });
    if (url.searchParams.get('auth') !== 'pw') { res.writeHead(403); return res.end('no'); }
    if (url.pathname === '/npjson') { if (npjson === null) { res.writeHead(404); return res.end(); } res.writeHead(200); return res.end(npjson); }
    if (url.pathname === '/np') { res.writeHead(200); return res.end('Fallback Artist - Fallback Title'); }
    res.writeHead(200); res.end('OK');
  });
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  return { calls, url: `http://127.0.0.1:${server.address().port}`, close: () => server.close() };
}

async function boot(extra = {}, npjson) {
  const radiodj = await fakeRadioDJ(npjson);
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'agent-'));
  const agent = createAgent({ key: 'secret', radiodjUrl: radiodj.url, radiodjPass: 'pw', linksDir: path.join(dir, 'links'), clipCart: '7', ...extra });
  await new Promise((r) => agent.server.listen(0, '127.0.0.1', r));
  const base = `http://127.0.0.1:${agent.server.address().port}`;
  const call = async (method, p, body, headers = {}) => {
    const res = await fetch(base + p, { method, headers: { 'x-api-key': 'secret', ...headers }, body });
    return { status: res.status, json: await res.json().catch(() => null) };
  };
  return { call, radiodj, dir, base, close: () => { agent.server.close(); radiodj.close(); } };
}

test('every request needs the key', async () => {
  const t = await boot();
  const res = await fetch(`${t.base}/agent/info`);
  assert.strictEqual(res.status, 401);
  const bad = await fetch(`${t.base}/agent/info`, { headers: { 'x-api-key': 'wrong' } });
  assert.strictEqual(bad.status, 401);
  assert.throws(() => createAgent({}), /AGENT_KEY is required/);
  t.close();
});

test('info reports what is configured: skip and volume only when their commands are set', async () => {
  const t = await boot();
  let info = (await t.call('GET', '/agent/info')).json;
  assert.deepStrictEqual([info.kind, info.capabilities.skip, info.capabilities.volume, info.capabilities.clip, info.capabilities.definePlaylist], ['radiodj', false, false, true, false]);
  assert.strictEqual((await t.call('POST', '/music/skip')).status, 501);
  assert.strictEqual((await t.call('POST', '/music/volume', '{"volume":0.5}')).status, 501);
  t.close();
  const t2 = await boot({ cmdSkip: 'PlayNext', cmdVolume: 'SetVol' });
  info = (await t2.call('GET', '/agent/info')).json;
  assert.deepStrictEqual([info.capabilities.skip, info.capabilities.volume], [true, true]);
  await t2.call('POST', '/music/skip');
  await t2.call('POST', '/music/volume', '{"volume":0.5}');
  await t2.call('POST', '/music/volume', '{"volume":9}');
  const sent = t2.radiodj.calls.filter((c) => c.path === '/opt');
  assert.deepStrictEqual(sent.map((c) => [c.command, c.arg]), [['PlayNext', ''], ['SetVol', '50'], ['SetVol', '100']]);   // volume is clamped to 0-1 then scaled
  assert.strictEqual((await t2.call('POST', '/music/volume', '{"volume":"loud"}')).status, 400);
  assert.strictEqual((await t2.call('POST', '/music/volume', '{nope')).status, 400);
  t2.close();
});

test('now playing is read from RadioDJ JSON, from text, and failures are reported', async () => {
  let t = await boot();
  assert.deepStrictEqual((await t.call('GET', '/music/now')).json, { title: 'Boards of Canada - Roygbiv', artist: 'Boards of Canada', track: 'Roygbiv', remainingSeconds: 42, listeners: null, live: false });
  t.close();
  t = await boot({}, '{"nested":{"trackartist":"A","tracktitle":"B"}}');
  assert.strictEqual((await t.call('GET', '/music/now')).json.title, 'A - B');
  t.close();
  t = await boot({}, 'Plain Artist - Plain Title');
  assert.strictEqual((await t.call('GET', '/music/now')).json.title, 'Plain Artist - Plain Title');
  t.close();
  t = await boot({}, null);                                              // no npjson: falls back to /np
  assert.strictEqual((await t.call('GET', '/music/now')).json.title, 'Fallback Artist - Fallback Title');
  t.close();
  t = await boot({ radiodjPass: 'wrong' });
  const bad = await t.call('GET', '/music/now');
  assert.strictEqual(bad.status, 502);
  assert.match(bad.json.error, /cannot reach RadioDJ/);
  t.close();
});

test('a clip is written to the fixed file and its cart fired, now or later', async () => {
  const t = await boot();
  const audio = Buffer.from('ID3fakeaudio');
  const now = await t.call('POST', '/ingest?play=1&title=Hello', audio, { 'content-type': 'audio/mpeg' });
  assert.strictEqual(now.status, 200);
  assert.strictEqual(now.json.played, true);
  assert.deepStrictEqual(fs.readFileSync(path.join(t.dir, 'links', 'current_link.mp3')), audio);
  assert.deepStrictEqual(t.radiodj.calls.filter((c) => c.command === 'PlayCartByNumber').map((c) => c.arg), ['7']);

  const staged = await t.call('POST', '/ingest?title=Later', Buffer.from('second'), { 'content-type': 'audio/mpeg' });
  assert.strictEqual(staged.status, 201);
  assert.strictEqual(staged.json.played, false);
  assert.strictEqual(t.radiodj.calls.filter((c) => c.command === 'PlayCartByNumber').length, 1);       // staged, not fired
  assert.strictEqual((await t.call('POST', `/clips/${staged.json.clip.id}/play`)).status, 200);
  assert.strictEqual(t.radiodj.calls.filter((c) => c.command === 'PlayCartByNumber').length, 2);
  assert.strictEqual((await t.call('POST', `/clips/${staged.json.clip.id}/play`)).status, 404);        // already played
  assert.strictEqual((await t.call('POST', '/clips/nope/play')).status, 404);
  assert.strictEqual((await t.call('POST', '/ingest', Buffer.alloc(0))).status, 400);
  t.close();
});

test('a newer staged clip replaces the older one, which can no longer be fired by mistake', async () => {
  const t = await boot();
  const a = await t.call('POST', '/ingest', Buffer.from('first'));
  const b = await t.call('POST', '/ingest', Buffer.from('second'));
  assert.strictEqual((await t.call('POST', `/clips/${a.json.clip.id}/play`)).status, 404);
  assert.strictEqual((await t.call('POST', `/clips/${b.json.clip.id}/play`)).status, 200);
  t.close();
});

test('uploads over the limit are refused, clips need the cart settings, and the library lists music', async () => {
  let t = await boot({ maxClipBytes: 10 });
  assert.strictEqual((await t.call('POST', '/ingest', Buffer.alloc(100))).status, 413);
  t.close();
  t = await boot({ linksDir: '', clipCart: '' });
  assert.strictEqual((await t.call('POST', '/ingest', Buffer.from('x'))).status, 501);
  t.close();
  const music = fs.mkdtempSync(path.join(os.tmpdir(), 'music-'));
  fs.mkdirSync(path.join(music, 'A'));
  fs.writeFileSync(path.join(music, 'A', 'one.mp3'), '12345');
  fs.writeFileSync(path.join(music, 'readme.txt'), 'x');
  t = await boot({ musicDir: music });
  assert.deepStrictEqual((await t.call('GET', '/music/library')).json, { tracks: [{ path: 'A/one.mp3', size: 5 }] });
  assert.deepStrictEqual((await t.call('GET', '/music/playlists')).json, []);
  assert.strictEqual((await t.call('PUT', '/music/playlists/x', '{"items":["a.mp3"]}')).status, 501);
  assert.strictEqual((await t.call('GET', '/nope')).status, 404);
  t.close();
});
