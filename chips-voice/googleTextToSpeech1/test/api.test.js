const test = require('node:test');
const audio = require('../lib/audio');
const assert = require('node:assert');
const express = require('express');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { createStore } = require('../lib/store');
const { createClips } = require('../lib/clips');
const { createScheduler } = require('../lib/scheduler');
const { createApi } = require('../routes/api');

async function boot(extra = {}) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'api-'));
  const synthCalls = [];
  const state = { fail: false };
  const tts = {
    names: ['fake'], capabilities: { ssml: false },
    listVoices: async () => [{ id: 'v1' }],
    synthesize: async (spec) => { if (state.fail) throw new Error('speech synthesis failed (google: quota)'); synthCalls.push(spec); return { audio: extra.ttsAudio || Buffer.from('0123456789'.repeat(10)), ext: extra.ttsExt || 'ogg', provider: 'fake' }; },
  };
  const plays = [];
  const playResult = { value: { played: true } };
  const play = async (clip, o) => { plays.push([clip.id, o.preempt]); return playResult.value; };
  const store = createStore(path.join(dir, 'db.json'), { clips: {}, schedules: {} });
  const clips = createClips({ store, tts, dir: path.join(dir, 'audio'), sfx: extra.sfx });
  const scheduler = createScheduler({ store, clips, play });
  const llmCalls = [];
  const llm = { enabled: true, names: ['openrouter'], listModels: async () => [{ id: 'm' }],
    generate: async (r) => { llmCalls.push(r); return { text: 'Draft text. '.repeat(100), provider: 'openrouter', model: 'm' }; } };
  const storage = { enabled: true, targets: [{ name: 'owncloud', label: 'ownCloud' }], share: async (clip, file, target) => ({ target: target || 'owncloud', url: 'https://c/s/T', directUrl: 'https://c/s/T/download', file }) };
  const { router, publicRouter } = createApi({ host: extra.host, sfx: extra.sfx, clips, tts, llm, storage, scheduler, play, streamSecret: 'sec', publicUrl: 'https://radio.test', ...extra });
  const app = express();
  app.set('trust proxy', true);
  app.use(express.json());
  app.use(publicRouter);
  app.use(router);
  const server = await new Promise((r) => { const s = app.listen(0, '127.0.0.1', () => r(s)); });
  const base = `http://127.0.0.1:${server.address().port}`;
  const call = async (method, url, body, headers = {}) => {
    const res = await fetch(base + url, { method, headers: { 'Content-Type': 'application/json', ...headers }, body: body ? JSON.stringify(body) : undefined });
    const text = await res.text();
    let json; try { json = JSON.parse(text); } catch (e) { json = null; }
    return { status: res.status, json, text, headers: res.headers };
  };
  return { state, call, base, synthCalls, plays, playResult, llmCalls, clips, scheduler, close: () => server.close() };
}

test('speak reuses the clip, plays it, records the play; skipped plays are not counted', async () => {
  const t = await boot();
  const a = await t.call('POST', '/speak', { text: 'Doors open', voice: 'v1', preempt: true });
  assert.strictEqual(a.status, 200);
  assert.deepStrictEqual([a.json.reused, a.json.played, a.json.clip.playCount], [false, true, 1]);
  const b = await t.call('POST', '/speak', { text: 'Doors open', voice: 'v1' });
  assert.deepStrictEqual([b.json.reused, t.synthCalls.length, b.json.clip.playCount], [true, 1, 2]);
  assert.deepStrictEqual(t.plays.map((p) => p[1]), [true, undefined]);
  t.playResult.value = { played: false, reason: 'live DJ on air' };
  const c = await t.call('POST', '/speak', { text: 'Doors open', voice: 'v1' });
  assert.deepStrictEqual([c.json.played, c.json.reason, c.json.clip.playCount], [false, 'live DJ on air', 2]);
  assert.strictEqual((await t.call('POST', '/speak', { text: '' })).status, 400);
  assert.strictEqual((await t.call('POST', '/synth', { text: 'x'.repeat(501) })).status, 400);
  t.close();
});

test('library: list, edit, play (regenerates when evicted), delete', async () => {
  const t = await boot();
  const { json } = await t.call('POST', '/synth', { text: 'Last call' });
  const id = json.clip.id;
  assert.strictEqual((await t.call('GET', '/clips?q=last')).json.length, 1);
  assert.deepStrictEqual((await t.call('PATCH', `/clips/${id}`, { title: 'Closing', favorite: true, tags: ['bar'] })).json.title, 'Closing');
  fs.rmSync(t.clips.fileOf(t.clips.get(id)));                         // pretend it was evicted
  assert.strictEqual((await t.call('GET', '/clips')).json[0].available, false);
  assert.strictEqual((await t.call('POST', `/clips/${id}/play`, {})).json.played, true);
  assert.strictEqual(t.synthCalls.length, 2);                         // regenerated from saved settings
  assert.strictEqual((await t.call('POST', '/clips/nope/play', {})).status, 404);
  assert.strictEqual((await t.call('DELETE', `/clips/${id}`)).status, 200);
  assert.strictEqual((await t.call('DELETE', `/clips/${id}`)).status, 404);
  t.close();
});

test('stream link: signed, public, seekable, expires, tamper-proof', async () => {
  const t = await boot();
  const id = (await t.call('POST', '/synth', { text: 'Stream me', format: 'MP3' })).json.clip.id;
  const link = (await t.call('POST', `/clips/${id}/link`, { hours: 2 })).json;
  assert.match(link.url, /^https:\/\/radio\.test\/a\/[0-9a-f]+\/stream-me\.ogg\?exp=\d+&sig=/);
  const local = link.url.replace('https://radio.test', t.base);       // no login needed on this route
  const full = await fetch(local);
  assert.deepStrictEqual([full.status, full.headers.get('content-type'), full.headers.get('accept-ranges')], [200, 'audio/ogg', 'bytes']);
  assert.strictEqual((await full.arrayBuffer()).byteLength, 100);
  const part = await fetch(local, { headers: { Range: 'bytes=10-19' } });
  assert.deepStrictEqual([part.status, part.headers.get('content-range'), await part.text()], [206, 'bytes 10-19/100', '0123456789']);
  assert.strictEqual((await fetch(local.replace(/sig=./, 'sig=x'))).status, 403);
  assert.strictEqual((await fetch(local.replace(/exp=\d+/, 'exp=9999999999'))).status, 403);
  const expired = (await t.call('POST', `/clips/${id}/link`, { hours: 1 })).json.url.replace('https://radio.test', t.base)
    .replace(/exp=\d+/, `exp=${Math.floor(Date.now() / 1000) - 5}`);
  assert.strictEqual((await fetch(expired)).status, 403);
  t.close();
});

test('links need a secret; share goes to storage; draft uses the LLM and is capped', async () => {
  const t = await boot({ streamSecret: '' });
  const id = (await t.call('POST', '/synth', { text: 'Hi' })).json.clip.id;
  assert.strictEqual((await t.call('POST', `/clips/${id}/link`, {})).status, 503);
  const shared = await t.call('POST', `/clips/${id}/share`, { target: 'owncloud' });
  assert.deepStrictEqual([shared.json.url, shared.json.directUrl], ['https://c/s/T', 'https://c/s/T/download']);
  assert.strictEqual(t.clips.get(id).cloud.url, 'https://c/s/T');
  const draft = await t.call('POST', '/announcements/draft', { prompt: 'Doors open at 6', tone: 'friendly' });
  assert.ok(draft.json.text.length <= 500 && draft.json.provider === 'openrouter');
  assert.match(t.llmCalls[0].system, /Tone: friendly/);
  assert.strictEqual((await t.call('POST', '/announcements/draft', { prompt: '' })).status, 400);
  assert.strictEqual((await t.call('POST', '/announcements/draft', { prompt: 'x'.repeat(1001) })).status, 400);
  const info = (await t.call('GET', '/providers')).json;
  assert.deepStrictEqual([info.llm.enabled, info.storage.targets[0].name, info.links.enabled], [true, 'owncloud', false]);
  assert.deepStrictEqual((await t.call('GET', '/tts/voices')).json, [{ id: 'v1' }]);
  assert.deepStrictEqual((await t.call('GET', '/llm/models')).json, [{ id: 'm' }]);
  t.close();
});

test('schedules through the API', async () => {
  const t = await boot();
  const bad = await t.call('POST', '/schedules', { spec: { text: 'x' }, startAt: 'soon' });
  assert.strictEqual(bad.status, 400);
  const made = await t.call('POST', '/schedules', { spec: { text: 'Happy hour' }, startAt: Date.now() + 60000, intervalSec: 3600, count: 4, preempt: true });
  assert.strictEqual(made.status, 201);
  assert.strictEqual((await t.call('GET', '/schedules')).json.length, 1);
  assert.strictEqual((await t.call('PATCH', `/schedules/${made.json.id}`, { enabled: false })).json.enabled, false);
  assert.strictEqual((await t.call('DELETE', `/schedules/${made.json.id}`)).status, 200);
  assert.strictEqual((await t.call('PATCH', '/schedules/zzz', {})).status, 404);
  t.close();
});

test('provider failures come back as errors, not crashes; rate limit protects costly calls', async () => {
  const t = await boot({ rateLimit: { max: 3, windowMs: 60000 } });
  t.state.fail = true;
  const failed = await t.call('POST', '/speak', { text: 'will fail' });
  assert.deepStrictEqual([failed.status, failed.json.error], [502, 'speech synthesis failed (google: quota)']);
  assert.strictEqual(t.plays.length, 0);
  t.state.fail = false;
  assert.strictEqual((await t.call('POST', '/synth', { text: 'recovers' })).status, 200);
  assert.strictEqual((await t.call('POST', '/synth', { text: 'third' })).status, 200);
  assert.strictEqual((await t.call('POST', '/synth', { text: 'fourth' })).status, 429);
  assert.strictEqual((await t.call('GET', '/clips')).status, 200);   // reads are not limited
  t.close();
});

test('effects API: presets are listed, processed copies are made, and bad requests are refused', async () => {
  const t = await boot();
  const presets = (await t.call('GET', '/fx/presets')).json;
  assert.ok(presets.presets.some((p) => p.name === 'underground') && presets.presets.some((p) => p.name === 'robot'));
  assert.deepStrictEqual(presets.ranges, { pitch: [-12, 12], speed: [0.5, 2] });
  assert.strictEqual(typeof (await t.call('GET', '/providers')).json.fx.available, 'boolean');
  const bad = await t.call('POST', '/synth', { text: 'hi', fx: 'not-a-preset' });
  assert.deepStrictEqual([bad.status, /unknown effect/.test(bad.json.error)], [400, true]);
  const none = await t.call('POST', '/clips/nope/fx', { fx: 'robot' });
  assert.strictEqual(none.status, audio.ffmpegAvailable() ? 404 : 503);
  t.close();
});

test('host API: status, settings, and a dry-run say', async () => {
  const { createHost } = require('../lib/host');
  const hostStore = createStore(null, {});
  const h = createHost({ store: hostStore, clips: { getOrCreate: async (s) => ({ clip: { id: 'h1', text: s.text }, reused: false }), get: () => ({ id: 'h1', text: 'x' }) },
    play: async () => ({ played: true }), nowPlaying: async () => ({ artist: '', title: '' }), rng: () => 0 });
  const t = await boot({ host: h });
  assert.strictEqual((await t.call('GET', '/host')).json.running, false);
  const upd = await t.call('PUT', '/host', { enabled: true, every: 3, voice: 'Rocky' });
  assert.deepStrictEqual([upd.json.running, upd.json.settings.every, upd.json.settings.voice], [true, 3, 'Rocky']);
  const dry = await t.call('POST', '/host/say', { artist: 'Band', title: 'Tune', dryRun: true });
  assert.deepStrictEqual([dry.status, dry.json.dryRun, /Band with Tune/.test(dry.json.text)], [200, true, true]);
  assert.strictEqual((await t.call('POST', '/host/say', { artist: 'Band' })).status, 400);
  await t.call('PUT', '/host', { enabled: false });
  h.stop();
  t.close();
});

test('sound effects API: list, upload, preview, delete, and tagged speech through /synth (real ffmpeg)', { skip: !audio.ffmpegAvailable() && 'ffmpeg not installed' }, async (t) => {
  const { createSfx } = require('../lib/sfx');
  const sfx = createSfx({ dir: path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'sfxapi-')), 'lib'), builtinDir: fs.mkdtempSync(path.join(os.tmpdir(), 'sfxb-')) });
  const sine = require('child_process').spawnSync('ffmpeg', ['-y', '-loglevel', 'error', '-f', 'lavfi', '-i', 'sine=frequency=300:duration=1', '-f', 'mp3', '-']).stdout;
  const s = await boot({ sfx, ttsAudio: sine, ttsExt: 'mp3' }); t.after(() => s.close());
  const listed = (await s.call('GET', '/sfx')).json;
  assert.ok(listed.available && listed.effects.some((e) => e.name === 'ding' && e.source === 'built-in') && /\[sfx:name\]/.test(listed.syntax));
  assert.deepStrictEqual((await s.call('GET', '/providers')).json.sfx.available, true);

  const wav = require('child_process').spawnSync('ffmpeg', ['-y', '-loglevel', 'error', '-f', 'lavfi', '-i', 'sine=frequency=500:duration=0.5', '-ar', '24000', '-ac', '1', '-f', 'wav', '-']).stdout;
  const up = await fetch(`${s.base}/sfx?name=Our-Jingle`, { method: 'POST', headers: { 'Content-Type': 'audio/wav' }, body: wav });
  assert.deepStrictEqual([up.status, (await up.json()).name], [201, 'our-jingle']);
  const bad = await fetch(`${s.base}/sfx?name=x`, { method: 'POST', headers: { 'Content-Type': 'audio/wav' }, body: Buffer.from('this is just text, not audio at all') });
  assert.deepStrictEqual([bad.status, /unsupported audio/.test((await bad.json()).error)], [400, true]);
  const big = await fetch(`${s.base}/sfx?name=big`, { method: 'POST', headers: { 'Content-Type': 'audio/wav' }, body: Buffer.alloc(6e6, 1) });
  assert.deepStrictEqual([big.status, (await big.json()).error], [413, 'file is too large']);
  const preview = await fetch(`${s.base}/sfx/our-jingle/audio`);
  assert.deepStrictEqual([preview.status, preview.headers.get('content-type')], [200, 'audio/mpeg']);
  assert.strictEqual((await s.call('GET', '/sfx/nope/audio')).status, 404);

  // tagged text through the speech API: the tag is not spoken, the unknown name is refused
  const made = await s.call('POST', '/synth', { text: 'Welcome [sfx:our-jingle] everybody.' });
  assert.strictEqual(made.status, 200);
  assert.strictEqual(made.json.clip.text, 'Welcome everybody.');
  assert.ok(s.synthCalls.every((c) => !/sfx/.test(c.text)));
  const unknown = await s.call('POST', '/synth', { text: 'Hi [sfx:nope] there' });
  assert.deepStrictEqual([unknown.status, /unknown sound effect/.test(unknown.json.error)], [400, true]);

  assert.strictEqual((await s.call('DELETE', '/sfx/our-jingle')).status, 200);
  assert.strictEqual((await s.call('DELETE', '/sfx/ding')).status, 404);                       // built-ins cannot be deleted
});

test('drafting: a conversation script with delivery directions and the available effects, on a chosen model', async () => {
  const t = await boot();
  const plain = await t.call('POST', '/announcements/draft', { prompt: 'Doors at six' });
  assert.deepStrictEqual([plain.status, plain.json.format], [200, 'text']);
  const convo = await t.call('POST', '/announcements/draft', { prompt: 'Banter about the weather', format: 'dialogue', speakers: ['Rocky', 'Britta', 'Bad<>Name'], tone: 'sleepy', model: 'anthropic/claude-3.5-sonnet' });
  assert.deepStrictEqual([convo.status, convo.json.format], [200, 'dialogue']);
  const sent = t.llmCalls[t.llmCalls.length - 1];
  assert.strictEqual(sent.model, 'anthropic/claude-3.5-sonnet');
  assert.match(sent.system, /speakers are: Rocky, Britta, BadName/);                           // names are cleaned before they reach the prompt
  assert.match(sent.system, /"Name \(delivery direction\): what they say"/);
  assert.match(sent.system, /Overall tone: sleepy/);
  assert.doesNotMatch(sent.system, /\[sfx:name\]/);                                            // effects are only offered when asked for
  t.close();
});
