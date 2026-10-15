const test = require('node:test');
const assert = require('node:assert');
const http = require('http');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { createStore } = require('../lib/store');
const { createClips } = require('../lib/clips');
const { createScheduler } = require('../lib/scheduler');
const { createStorage } = require('../lib/storage');
const rclone = require('../lib/storage/rclone');
const owncloud = require('../lib/storage/owncloud');
const { directUrl } = require('../lib/storage/links');

const tmp = (p) => fs.mkdtempSync(path.join(os.tmpdir(), p));
function fakeTts(bytes = 100) {
  const calls = [];
  return { calls, names: ['fake'], synthesize: async (spec) => { calls.push(spec); await new Promise((r) => setTimeout(r, 5)); return { audio: Buffer.alloc(bytes, 'a'), ext: 'ogg', provider: 'fake' }; } };
}
function setup(opts = {}) {
  const dir = tmp('clips-');
  const tts = opts.tts || fakeTts(opts.bytes);
  let t = 1_000_000;
  const clock = { now: () => t, advance: (ms) => { t += ms; } };
  const store = createStore(path.join(dir, 'db.json'), { clips: {}, schedules: {} });
  const clips = createClips({ store, tts, dir: path.join(dir, 'audio'), maxBytes: opts.maxBytes, now: clock.now });
  return { dir, tts, clock, store, clips };
}

test('same announcement is reused; any change generates a new clip', async () => {
  const { clips, tts } = setup();
  const a = await clips.getOrCreate({ text: 'Hello everyone', voice: 'v1' });
  const b = await clips.getOrCreate({ text: '  Hello everyone ', voice: 'v1' });       // whitespace only
  const c = await clips.getOrCreate({ text: 'Hello everyone', voice: 'v2' });
  const d = await clips.getOrCreate({ text: 'Hello everyone', voice: 'v1', rate: 1.5 });
  assert.deepStrictEqual([a.reused, b.reused, c.reused, d.reused], [false, true, false, false]);
  assert.strictEqual(a.clip.id, b.clip.id);
  assert.strictEqual(new Set([a, c, d].map((x) => x.clip.id)).size, 3);
  assert.strictEqual(tts.calls.length, 3);
  assert.ok(fs.existsSync(clips.fileOf(a.clip)));
});

test('concurrent identical requests synthesize once', async () => {
  const { clips, tts } = setup();
  const [x, y] = await Promise.all([clips.getOrCreate({ text: 'Same' }), clips.getOrCreate({ text: 'Same' })]);
  assert.strictEqual(x.clip.id, y.clip.id);
  assert.strictEqual(tts.calls.length, 1);
});

test('validation: empty, too long, bad numbers are handled', async () => {
  const { clips } = setup();
  await assert.rejects(clips.getOrCreate({ text: '   ' }), /text is required/);
  await assert.rejects(clips.getOrCreate({ text: 'x'.repeat(501) }), /too long/);
  await assert.rejects(clips.getOrCreate({ ssmlMode: true, ssml: '' }), /ssml is required/);
  const { clip } = await clips.getOrCreate({ text: 'ok', rate: 99, pitch: 'abc', format: 'EXE' });
  assert.deepStrictEqual([clip.spec.rate, clip.spec.pitch, clip.spec.format], [4, 0, 'OGG_OPUS']);
});

test('catalogue: search, favorites, tags, rename, delete, restart', async () => {
  const { clips, store, dir, clock } = setup();
  const a = (await clips.getOrCreate({ text: 'Doors open at six' })).clip;
  clock.advance(1000);
  const b = (await clips.getOrCreate({ text: 'Last call for drinks' })).clip;
  clips.update(a.id, { title: 'Doors', favorite: true, tags: ['Event', 'event', ' door '] });
  assert.deepStrictEqual(clips.get(a.id).tags, ['event', 'door']);
  assert.deepStrictEqual(clips.list({ q: 'drinks' }).map((c) => c.id), [b.id]);
  assert.deepStrictEqual(clips.list({ favorite: true }).map((c) => c.id), [a.id]);
  assert.deepStrictEqual(clips.list({ tag: 'event' }).map((c) => c.id), [a.id]);
  clock.advance(1000);
  clips.markPlayed(a.id);
  assert.strictEqual(clips.list()[0].id, a.id);                      // most recently used first
  store.flush();
  const again = createClips({ store: createStore(path.join(dir, 'db.json'), { clips: {} }), tts: fakeTts(), dir: path.join(dir, 'audio') });
  assert.strictEqual(again.get(a.id).title, 'Doors');
  assert.ok(clips.remove(b.id));
  assert.ok(!fs.existsSync(path.join(dir, 'audio', b.file)) && !clips.get(b.id));
});

test('disk cap evicts the least recently played non-favorites and keeps their rows', async () => {
  const { clips, clock } = setup({ bytes: 100, maxBytes: 250 });
  const a = (await clips.getOrCreate({ text: 'one' })).clip; clock.advance(10);
  const b = (await clips.getOrCreate({ text: 'two' })).clip; clock.advance(10);
  clips.update(a.id, { favorite: true });
  const c = (await clips.getOrCreate({ text: 'three' })).clip;        // 300 bytes > 250: evict b (a is a favorite)
  assert.ok(clips.exists(a) && clips.exists(c) && !clips.exists(b));
  assert.ok(clips.get(b.id), 'row kept');
  assert.strictEqual(clips.list().find((x) => x.id === b.id).available, false);
  const back = await clips.getOrCreate({ text: 'two' });             // evicted clip is regenerated, same id
  assert.deepStrictEqual([back.reused, back.clip.id], [false, b.id]);
});

test('scheduler: one-shot, repeating with count, skip, missed, errors', async () => {
  const { clips, store, clock } = setup();
  const played = [];
  let reply = { played: true };
  const sched = createScheduler({ store, clips, now: clock.now, graceMs: 60000, play: async (clip, o) => { played.push([clip.text, o.preempt]); return reply; } });

  const once = sched.add({ spec: { text: 'Once' }, startAt: clock.now() + 1000, preempt: true });
  const rep = sched.add({ spec: { text: 'Often' }, startAt: clock.now() + 1000, intervalSec: 60, count: 3 });
  await sched.tick();
  assert.strictEqual(played.length, 0);                              // not due yet
  clock.advance(1000); await sched.tick();
  assert.deepStrictEqual(played, [['Once', true], ['Often', false]]);
  assert.strictEqual(sched.get(once.id).enabled, false);             // one-shot is finished
  assert.strictEqual(sched.get(rep.id).nextAt, rep.startAt + 60000);
  reply = { played: false, reason: 'live DJ on air' };
  clock.advance(60000); await sched.tick();
  assert.strictEqual(sched.get(rep.id).lastResult, 'skipped: live DJ on air');
  clock.advance(60000); await sched.tick();
  assert.deepStrictEqual([sched.get(rep.id).runs, sched.get(rep.id).enabled], [3, false]);   // count reached

  const late = sched.add({ spec: { text: 'Late' }, startAt: clock.now() + 1000, intervalSec: 60 });
  clock.advance(10 * 60 * 1000); played.length = 0; await sched.tick();   // server "was off" for 10 minutes
  assert.strictEqual(played.length, 0);
  assert.match(sched.get(late.id).lastResult, /missed/);
  assert.ok(sched.get(late.id).nextAt > clock.now());                // next slot is in the future, no burst of catch-up runs

  assert.throws(() => sched.add({ spec: { text: 'x' }, startAt: 'nonsense' }), /startAt/);
  assert.throws(() => sched.add({ spec: { text: 'x' }, startAt: 1, intervalSec: 5 }), /at least 30/);
  assert.throws(() => sched.add({ clipId: 'nope', startAt: 1 }), /clip not found/);
  assert.ok(sched.remove(late.id) && !sched.remove(late.id));
});

test('scheduler by clip id, and a failing player is recorded not thrown', async () => {
  const { clips, store, clock } = setup();
  const clip = (await clips.getOrCreate({ text: 'From library' })).clip;
  const sched = createScheduler({ store, clips, now: clock.now, play: async () => { throw new Error('liquidsoap down'); } });
  const s = sched.add({ clipId: clip.id, startAt: clock.now() });
  await sched.tick();
  assert.strictEqual(sched.get(s.id).lastResult, 'error: liquidsoap down');
});

test('rclone storage: uploads then asks for a link; drive links get a direct URL', async () => {
  const calls = [];
  const adapter = rclone.create({ STORAGE_RCLONE_REMOTE: 'gdrive:Radio/' }, { run: async (args) => { calls.push(args); return args[0] === 'link' ? 'https://drive.google.com/open?id=ABC123\n' : ''; } });
  const out = await adapter.share('/tmp/x.ogg', 'hello-abc.ogg');
  assert.deepStrictEqual(calls, [['copyto', '/tmp/x.ogg', 'gdrive:Radio/hello-abc.ogg'], ['link', 'gdrive:Radio/hello-abc.ogg']]);
  assert.strictEqual(out.url, 'https://drive.google.com/open?id=ABC123');
  assert.strictEqual(out.directUrl, 'https://drive.google.com/uc?export=download&id=ABC123');
  const bad = rclone.create({ STORAGE_RCLONE_REMOTE: 'x:' }, { run: async () => 'not a link' });
  await assert.rejects(bad.share('/tmp/x', 'n'), /did not return a link/);
  assert.strictEqual(directUrl('https://cloud.example.com/s/AbC123'), 'https://cloud.example.com/s/AbC123/download');
  assert.strictEqual(directUrl('https://example.com/page'), null);
});

test('ownCloud storage: creates the folder, uploads via WebDAV, makes (and reuses) a public link', async () => {
  const seen = []; let shares = [];
  const server = http.createServer((req, res) => {
    let body = ''; req.on('data', (d) => { body += d; });
    req.on('end', () => {
      seen.push(`${req.method} ${req.url}`);
      assert.strictEqual(req.headers.authorization, 'Basic ' + Buffer.from('bob:app-pass').toString('base64'));
      if (req.method === 'MKCOL') { res.writeHead(seen.filter((s) => s.startsWith('MKCOL')).length === 1 ? 201 : 405); return res.end(); }
      if (req.method === 'PUT') { assert.strictEqual(body, 'AUDIO'); res.writeHead(201); return res.end(); }
      res.writeHead(200, { 'Content-Type': 'application/json' });
      if (req.method === 'GET') return res.end(JSON.stringify({ ocs: { data: shares } }));
      assert.match(body, /path=%2FChips%2Fhello\.ogg&shareType=3&permissions=1/);
      shares = [{ share_type: 3, url: 'http://x/s/TOK123' }];
      res.end(JSON.stringify({ ocs: { data: { url: 'http://x/s/TOK123' } } }));
    });
  });
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  const base = `http://127.0.0.1:${server.address().port}`;
  const file = path.join(tmp('oc-'), 'hello.ogg'); fs.writeFileSync(file, 'AUDIO');
  const adapter = owncloud.create({ OWNCLOUD_URL: base, OWNCLOUD_USER: 'bob', OWNCLOUD_PASSWORD: 'app-pass', OWNCLOUD_FOLDER: 'Chips' });
  assert.ok(adapter.enabled);
  const first = await adapter.share(file, 'hello.ogg');
  assert.deepStrictEqual([first.url, first.directUrl, first.path], ['http://x/s/TOK123', 'http://x/s/TOK123/download', '/Chips/hello.ogg']);
  assert.ok(seen.includes('PUT /remote.php/dav/files/bob/Chips/hello.ogg'));
  const second = await adapter.share(file, 'hello.ogg');            // folder exists (405) and link is reused
  assert.strictEqual(second.url, first.url);
  assert.strictEqual(seen.filter((s) => s.startsWith('POST')).length, 1);
  server.close();
  assert.ok(!owncloud.create({}).enabled);
});

test('storage registry picks the default and the named target', async () => {
  const fake = (name) => ({ name, label: name, enabled: true, share: async (f, n) => ({ target: name, name: n }) });
  const none = createStorage({}, { rclone: { enabled: false }, owncloud: { enabled: false } });
  assert.ok(!none.enabled);
  await assert.rejects(none.share({ title: 'T', id: 'abcdefghij', ext: 'ogg' }, '/f'), /no cloud storage/);
  const both = createStorage({ STORAGE_DEFAULT: 'owncloud' }, { rclone: fake('rclone'), owncloud: fake('owncloud') });
  assert.strictEqual((await both.share({ title: 'My clip', id: 'abcdefghij', ext: 'ogg' }, '/f')).target, 'owncloud');
  const r = await both.share({ title: 'My clip', id: 'abcdefghij', ext: 'ogg' }, '/f', 'rclone');
  assert.deepStrictEqual([r.target, r.name], ['rclone', 'my-clip-abcdefgh.ogg']);
  await assert.rejects(both.share({ title: 'x', id: 'abcdefghij', ext: 'ogg' }, '/f', 'ftp'), /unknown storage target/);
});
