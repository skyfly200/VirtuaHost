const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { createStore } = require('../lib/store');
const { sign, verify, signedUrl, slug } = require('../lib/signing');
const { createLimiter } = require('../lib/ratelimit');

test('store persists, survives restart, and keeps a corrupt file aside', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'store-'));
  const file = path.join(dir, 'db.json');
  const a = createStore(file, { clips: {} });
  a.data.clips.x = { id: 'x' };
  a.flush();
  assert.deepStrictEqual(createStore(file, { clips: {} }).data.clips, { x: { id: 'x' } });
  fs.writeFileSync(file, '{not json');
  const b = createStore(file, { clips: {} });
  assert.deepStrictEqual(b.data.clips, {});
  assert.ok(fs.readdirSync(dir).some((f) => f.includes('.corrupt-')));
});

test('signed links verify, expire, and cannot be altered', () => {
  const now = 1_000_000_000_000;
  const { url, expires } = signedUrl({ base: 'https://x.test/', secret: 's', id: 'abc', ext: 'mp3', title: 'Hello World!', ttlSeconds: 60, nowMs: now });
  assert.match(url, /^https:\/\/x\.test\/a\/abc\/hello-world\.mp3\?exp=\d+&sig=/);
  assert.ok(expires.startsWith('2001-'));
  const q = new URL(url).searchParams;
  assert.ok(verify('s', 'abc', q.get('exp'), q.get('sig'), now));
  assert.ok(!verify('s', 'abc', q.get('exp'), q.get('sig'), now + 61000)); // expired
  assert.ok(!verify('s', 'other', q.get('exp'), q.get('sig'), now)); // other clip
  assert.ok(!verify('t', 'abc', q.get('exp'), q.get('sig'), now)); // other secret
  assert.ok(!verify('s', 'abc', Number(q.get('exp')) + 1000, q.get('sig'), now)); // longer expiry
  assert.ok(!verify('', 'abc', q.get('exp'), q.get('sig'), now));
  assert.strictEqual(slug('  ***  '), 'clip');
});

test('rate limiter blocks after the cap and resets', () => {
  let t = 0;
  const limit = createLimiter({ windowMs: 1000, max: 2, now: () => t });
  const run = (ip) => { let out = 'ok'; limit({ ip }, { set() {}, status() { return { json() { out = '429'; } }; } }, () => {}); return out; };
  assert.deepStrictEqual([run('a'), run('a'), run('a'), run('b')], ['ok', 'ok', '429', 'ok']);
  t = 1001;
  assert.strictEqual(run('a'), 'ok');
});
