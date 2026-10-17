const test = require('node:test');
const assert = require('node:assert');
const http = require('http');
const express = require('express');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawnSync } = require('child_process');
const { createStore } = require('../lib/store');
const { createClips } = require('../lib/clips');
const { createScheduler } = require('../lib/scheduler');
const { createIngest, sniff } = require('../lib/ingest');
const audio = require('../lib/audio');
const { createApi } = require('../routes/api');

// A real (tiny) WAV and MP3 so the format check and ffmpeg conversion are exercised for real.
function makeWav() {
  const samples = 1000; const data = Buffer.alloc(samples * 2, 0);
  const h = Buffer.alloc(44);
  h.write('RIFF', 0); h.writeUInt32LE(36 + data.length, 4); h.write('WAVEfmt ', 8); h.writeUInt32LE(16, 16);
  h.writeUInt16LE(1, 20); h.writeUInt16LE(1, 22); h.writeUInt32LE(24000, 24); h.writeUInt32LE(48000, 28); h.writeUInt16LE(2, 32); h.writeUInt16LE(16, 34);
  h.write('data', 36); h.writeUInt32LE(data.length, 40);
  return Buffer.concat([h, data]);
}
const WAV = makeWav();
const OGG = Buffer.concat([Buffer.from('OggS'), Buffer.alloc(40, 1)]);
const MP3 = Buffer.concat([Buffer.from('ID3'), Buffer.alloc(40, 2)]);

const dirOf = () => fs.mkdtempSync(path.join(os.tmpdir(), 'ingest-'));
function setup(opts = {}) {
  const dir = dirOf();
  const store = createStore(path.join(dir, 'db.json'), { clips: {}, schedules: {} });
  const clips = createClips({ store, tts: { names: ['x'], synthesize: async () => { throw new Error('no tts here'); } }, dir: path.join(dir, 'audio'), maxBytes: opts.maxBytes });
  const ingest = createIngest({ clips, transcode: false, ...opts.ingest });
  return { dir, store, clips, ingest };
}

test('only real audio is accepted, judged by its bytes', async () => {
  assert.deepStrictEqual([sniff(WAV), sniff(OGG), sniff(MP3), sniff(Buffer.from('<html>not audio at all</html>')), sniff(Buffer.alloc(3))], ['wav', 'ogg', 'mp3', null, null]);
  const { ingest } = setup();
  await assert.rejects(ingest.importBuffer(Buffer.from('MZ\x90\x00 executable pretending to be audio')), /unsupported audio/);
  await assert.rejects(ingest.importBuffer(Buffer.alloc(0)), /no audio/);
  await assert.rejects(setup({ ingest: { maxBytes: 10 } }).ingest.importBuffer(WAV), /too large/);
});

test('imported clips are stored once (by content), are never evicted, and cannot be regenerated', async () => {
  const { clips, ingest } = setup({ maxBytes: 10 });
  const a = await ingest.importBuffer(WAV, { title: 'Station ID', text: 'You are listening to...', source: 'netlify' });
  const b = await ingest.importBuffer(WAV, { title: 'Again' });
  assert.deepStrictEqual([a.reused, b.reused, a.clip.id === b.clip.id, a.clip.title, a.clip.external], [false, true, true, 'Station ID', true]);
  assert.strictEqual(clips.list({ q: 'listening' }).length, 1);
  clips.addExternal({ buffer: OGG, ext: 'ogg', title: 'second' });        // over the 10-byte cap, but imported audio is exempt
  assert.ok(clips.exists(a.clip) && clips.evict().length === 0);
});

test('ffmpeg conversion shrinks WAV to MP3 (real ffmpeg)', { skip: !audio.ffmpegAvailable() && 'ffmpeg not installed' }, async () => {
  const { clips, ingest } = setup({ ingest: { transcode: true } });
  const out = await ingest.importBuffer(WAV, { title: 'Converted' });
  assert.strictEqual(out.clip.ext, 'mp3');
  assert.strictEqual(sniff(fs.readFileSync(clips.fileOf(out.clip))), 'mp3');
});

test('pull by link: https and allowed hosts only, no redirects, size capped', async () => {
  const body = (b, headers = {}) => ({ ok: true, status: 200, headers: { get: (n) => headers[n.toLowerCase()] || null }, body: new ReadableStream({ start(c) { c.enqueue(new Uint8Array(b)); c.close(); } }) });
  const seen = [];
  const fetchImpl = async (url, init) => { seen.push([String(url), init.redirect]); return body(WAV); };
  const { ingest } = setup({ ingest: { allowedHosts: ['Site.netlify.app'], fetchImpl } });
  assert.strictEqual(sniff(await ingest.fetchAudio('https://site.netlify.app/api/clips/1')), 'wav');
  assert.deepStrictEqual(seen[0], ['https://site.netlify.app/api/clips/1', 'error']);
  await assert.rejects(ingest.fetchAudio('https://evil.example/a.wav'), /not allowed/);
  await assert.rejects(ingest.fetchAudio('http://site.netlify.app/a.wav'), /only https/);
  await assert.rejects(ingest.fetchAudio('https://127.0.0.1/a.wav'), /not allowed/);
  await assert.rejects(ingest.fetchAudio('not a url'), /not valid/);
  const big = setup({ ingest: { allowedHosts: ['site.netlify.app'], maxBytes: 100, fetchImpl: async () => body(Buffer.alloc(500)) } }).ingest;
  await assert.rejects(big.fetchAudio('https://site.netlify.app/x'), /too large/);
  const declared = setup({ ingest: { allowedHosts: ['site.netlify.app'], maxBytes: 100, fetchImpl: async () => body(Buffer.alloc(5), { 'content-length': '9999' }) } }).ingest;
  await assert.rejects(declared.fetchAudio('https://site.netlify.app/x'), /too large/);
  const down = setup({ ingest: { allowedHosts: ['site.netlify.app'], fetchImpl: async () => ({ ok: false, status: 404, headers: { get: () => null } }) } }).ingest;
  await assert.rejects(down.fetchAudio('https://site.netlify.app/x'), /returned 404/);
});

async function boot(opts = {}) {
  const { clips, store, ingest, dir } = setup(opts);
  const plays = [];
  const play = async (clip, o) => { plays.push([clip.id, o.preempt]); return opts.playResult || { played: true }; };
  const scheduler = createScheduler({ store, clips, play });
  const llm = { enabled: false, names: [] }; const storage = { enabled: false, targets: [] };
  const authed = (req, res, next) => (req.get('x-login') === 'yes' ? next() : res.status(401).json({ error: 'login required' }));
  const { router, ingestRouter } = createApi({ clips, tts: { names: ['x'], capabilities: {}, providers: [] }, llm, storage, scheduler, play, ingest, ingestToken: 'ing-secret', authenticate: authed, ingestMaxBytes: 5000, rateLimit: { ingestMax: 100 } });
  const app = express();
  app.use(express.json());
  app.use(ingestRouter);
  app.use((req, res, next) => (req.get('x-login') === 'yes' ? next() : res.status(401).json({ error: 'login required' })), router);
  const server = await new Promise((r) => { const s = app.listen(0, '127.0.0.1', () => r(s)); });
  const base = `http://127.0.0.1:${server.address().port}`;
  const post = async (url, body, headers = {}) => {
    const res = await fetch(base + url, { method: 'POST', headers, body });
    let json = null; try { json = await res.json(); } catch (e) { /* none */ }
    return { status: res.status, json };
  };
  return { post, plays, clips, scheduler, base, close: () => server.close() };
}
const AUTH = { Authorization: 'Bearer ing-secret', 'Content-Type': 'audio/wav' };

test('push: the ingest token works only for ingest; audio is stored, deduped, and played on request', async (t) => {
  const s = await boot(); t.after(() => s.close());
  assert.strictEqual((await s.post('/ingest', WAV, { 'Content-Type': 'audio/wav' })).status, 401);                       // no credentials
  assert.strictEqual((await s.post('/ingest', WAV, { ...AUTH, Authorization: 'Bearer wrong' })).status, 401);
  const first = await s.post('/ingest?title=Top%20of%20the%20hour&text=Hello%20there&source=netlify', WAV, AUTH);
  assert.deepStrictEqual([first.status, first.json.reused, first.json.played, first.json.clip.title, first.json.clip.source], [201, false, false, 'Top of the hour', 'netlify']);
  assert.strictEqual(s.plays.length, 0);
  const again = await s.post('/ingest?play=true&preempt=true', WAV, AUTH);
  assert.deepStrictEqual([again.status, again.json.reused, again.json.played, again.json.clip.playCount], [200, true, true, 1]);
  assert.deepStrictEqual(s.plays, [[first.json.clip.id, true]]);
  assert.strictEqual((await s.post('/ingest', Buffer.from('not audio, just text content here'), AUTH)).status, 415);
  assert.strictEqual((await s.post('/ingest', Buffer.alloc(6000, 7), { ...AUTH })).status, 413);                          // over the size cap
  assert.strictEqual((await s.post('/ingest', '', AUTH)).status, 400);
  // the token must not unlock the rest of the API
  assert.strictEqual((await fetch(`${s.base}/clips`, { headers: { Authorization: 'Bearer ing-secret' } })).status, 401);
  // a normal login also works for ingest, and header metadata is accepted
  const viaLogin = await s.post('/ingest', OGG, { 'x-login': 'yes', 'Content-Type': 'audio/ogg', 'x-title': 'From%20header', 'x-play': 'true' });
  assert.deepStrictEqual([viaLogin.status, viaLogin.json.played, viaLogin.json.clip.title], [201, true, 'From header']);
});

test('push + skipped play: a live DJ on air is reported, not an error', async (t) => {
  const s = await boot({ playResult: { played: false, reason: 'live DJ on air' } }); t.after(() => s.close());
  const r = await s.post('/ingest?play=true', WAV, AUTH);
  assert.deepStrictEqual([r.status, r.json.played, r.json.reason, r.json.clip.playCount], [201, false, 'live DJ on air', 0]);
});

test('imported clips can be played again, scheduled, and shared like any other', async (t) => {
  const s = await boot(); t.after(() => s.close());
  const id = (await s.post('/ingest?title=Jingle', WAV, AUTH)).json.clip.id;
  const play = await fetch(`${s.base}/clips/${id}/play`, { method: 'POST', headers: { 'x-login': 'yes', 'Content-Type': 'application/json' }, body: '{}' });
  assert.strictEqual((await play.json()).played, true);
  const sch = s.scheduler.add({ clipId: id, startAt: Date.now() });
  await s.scheduler.tick();
  assert.strictEqual(s.scheduler.get(sch.id).lastResult, 'played');
  fs.rmSync(s.clips.fileOf(s.clips.get(id)));                                                         // file lost: clear error, no crash
  const lost = await fetch(`${s.base}/clips/${id}/play`, { method: 'POST', headers: { 'x-login': 'yes', 'Content-Type': 'application/json' }, body: '{}' });
  assert.deepStrictEqual([lost.status, (await lost.json()).error], [502, 'the imported audio file is missing']);
});

test('pull by link through the API', async (t) => {
  const origin = http.createServer((req, res) => { res.writeHead(200, { 'Content-Type': 'audio/wav' }); res.end(WAV); });
  await new Promise((r) => origin.listen(0, '127.0.0.1', r));
  t.after(() => origin.close());
  const host = `127.0.0.1:${origin.address().port}`;
  const s = await boot({ ingest: { allowedHosts: [host], allowHttp: true } }); t.after(() => s.close());
  const json = { ...AUTH, 'Content-Type': 'application/json' };
  const ok = await s.post('/ingest/url', JSON.stringify({ url: `http://${host}/api/clips/abc`, title: 'Pulled', play: true }), json);
  assert.deepStrictEqual([ok.status, ok.json.clip.title, ok.json.played, ok.json.clip.source], [201, 'Pulled', true, 'link']);
  const bad = await s.post('/ingest/url', JSON.stringify({ url: 'http://169.254.169.254/latest/meta-data' }), json);
  assert.deepStrictEqual([bad.status, /not allowed/.test(bad.json.error)], [403, true]);
  assert.strictEqual((await s.post('/ingest/url', JSON.stringify({}), json)).status, 400);
  assert.strictEqual((await s.post('/ingest/url', JSON.stringify({ url: `http://${host}/x` }), { 'Content-Type': 'application/json' })).status, 401);
});
