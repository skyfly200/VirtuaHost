const test = require('node:test');
const assert = require('node:assert');
const { createAlerts, normalize, matters, speakable, sanitizeWatch, fetchActive } = require('../alerts');
const { createHub } = require('../hub');
const { createStore } = require('../store');

const NOW = Date.parse('2026-10-21T21:00:00Z');
const feature = (over = {}) => ({ properties: { id: 'urn:nws:1', event: 'Tornado Warning', severity: 'Extreme', urgency: 'Immediate', certainty: 'Observed', status: 'Actual', messageType: 'Alert',
  headline: 'Tornado Warning issued October 21 at 4:00PM CDT until 5:00PM CDT by NWS Houston/Galveston TX', instruction: 'Take cover now! Move to an interior room.', areaDesc: 'Harris, TX', senderName: 'NWS Houston', sent: '2026-10-21T21:00:00Z', expires: '2026-10-21T22:00:00Z', ...over } });
const nws = (features) => async (url) => ({ ok: true, status: 200, json: async () => ({ features }), _url: String(url) });
const watch = (over = {}) => sanitizeWatch({ name: 'Houston', lat: 29.76, lon: -95.37, ...over });
const memStore = () => createStore(null);

test('normalizes an NWS feature and keeps only what is needed', () => {
  const a = normalize(feature());
  assert.deepStrictEqual([a.id, a.event, a.severity, a.area, a.expires], ['urn:nws:1', 'Tornado Warning', 'Extreme', 'Harris, TX', Date.parse('2026-10-21T22:00:00Z')]);
  assert.strictEqual(normalize(feature({ severity: 'Nonsense' })).severity, 'Unknown');
});

test('only real, current alerts at or above the minimum severity count', () => {
  const w = watch({ minSeverity: 'Severe' });
  const ok = (over) => matters(normalize(feature(over)), w, NOW);
  assert.strictEqual(ok({}), true);
  assert.strictEqual(ok({ status: 'Test' }), false);
  assert.strictEqual(ok({ status: 'Exercise' }), false);
  assert.strictEqual(ok({ messageType: 'Cancel' }), false);
  assert.strictEqual(ok({ expires: '2026-10-21T20:00:00Z' }), false);
  assert.strictEqual(ok({ severity: 'Moderate' }), false);
  assert.strictEqual(ok({ severity: 'Severe' }), true);
  assert.strictEqual(matters(normalize(feature({ event: 'Flood Watch', severity: 'Severe' })), watch({ events: ['tornado warning'] }), NOW), false);
  assert.strictEqual(matters(normalize(feature()), watch({ events: ['tornado warning'] }), NOW), true);
});

test('says the NWS headline and the first sentence of the instruction, plus an optional prefix and suffix', () => {
  const text = speakable(normalize(feature()), watch({ prefix: 'Weather alert.', suffix: 'Stay tuned.' }));
  assert.match(text, /^Weather alert\. Tornado Warning issued October 21/);
  assert.match(text, /Take cover now!/);
  assert.doesNotMatch(text, /Move to an interior room/);
  assert.match(text, /Stay tuned\.$/);
});

test('validates watches', () => {
  assert.throws(() => sanitizeWatch({ name: 'x' }), /say where/);
  assert.throws(() => sanitizeWatch({ lat: 99, lon: 0 }), /latitude/);
  assert.throws(() => sanitizeWatch({ area: 'Texas' }), /two-letter/);
  assert.throws(() => sanitizeWatch({ zone: 'nope' }), /zone looks like/);
  assert.throws(() => sanitizeWatch({ area: 'TX', action: 'shout' }), /notify/);
  const w = sanitizeWatch({ area: 'tx' });
  assert.deepStrictEqual([w.area, w.action, w.minSeverity, w.stations], ['TX', 'notify', 'Severe', 'all']);
});

test('asks the NWS for a point, a zone or a state, and identifies itself', async () => {
  const seen = [];
  const f = async (url, opts) => { seen.push([String(url), opts.headers]); return { ok: true, json: async () => ({ features: [] }) }; };
  await fetchActive(watch(), { fetchImpl: f, contact: 'ops@example.com' });
  await fetchActive(sanitizeWatch({ zone: 'TXZ213' }), { fetchImpl: f });
  await fetchActive(sanitizeWatch({ area: 'TX' }), { fetchImpl: f });
  assert.match(seen[0][0], /alerts\/active\?point=29\.76%2C-95\.37$/);
  assert.match(seen[1][0], /zone=TXZ213$/);
  assert.match(seen[2][0], /area=TX$/);
  assert.match(seen[0][1]['user-agent'], /ops@example\.com/);
  assert.strictEqual(seen[0][1].accept, 'application/geo+json');
});

test('notify only records an alert, once, and never airs it', async () => {
  const store = memStore(); let aired = 0;
  const alerts = createAlerts({ store, fetchImpl: nws([feature()]), now: () => NOW, broadcast: async () => { aired += 1; }, speak: async () => 'clip1' });
  const w = alerts.add({ name: 'Houston', lat: 29.76, lon: -95.37 });
  const first = await alerts.checkWatch(w);
  assert.deepStrictEqual([first.found, first.relevant, first.results[0].status], [1, 1, 'noted']);
  assert.strictEqual((await alerts.checkWatch(w)).results.length, 0);          // the same alert is not handled twice
  assert.strictEqual(aired, 0);
  assert.strictEqual(alerts.list().log[0].event, 'Tornado Warning');
});

test('broadcast has the voice server speak it and sends the clip to the chosen stations, once', async () => {
  const store = memStore(); const sent = []; const spoken = [];
  const alerts = createAlerts({ store, fetchImpl: nws([feature()]), now: () => NOW, speak: async (t) => { spoken.push(t); return 'clip9'; }, broadcast: async (b) => { sent.push(b); return { played: true }; } });
  const w = alerts.add({ name: 'Houston', lat: 29.76, lon: -95.37, action: 'broadcast', stations: ['wayhigh', 'greenlight'], preempt: true });
  const out = await alerts.checkWatch(w);
  assert.strictEqual(out.results[0].status, 'broadcast');
  assert.deepStrictEqual(sent, [{ clipId: 'clip9', stations: ['wayhigh', 'greenlight'], title: 'Alert: Tornado Warning', preempt: true }]);
  assert.match(spoken[0], /Tornado Warning/);
  await alerts.checkWatch(w);
  assert.strictEqual(sent.length, 1);
});

test('a failed broadcast is retried on the next poll instead of being lost', async () => {
  const store = memStore(); let fail = true; const sent = [];
  const alerts = createAlerts({ store, fetchImpl: nws([feature()]), now: () => NOW, speak: async () => 'c', broadcast: async (b) => { if (fail) throw new Error('station offline'); sent.push(b); return {}; } });
  const w = alerts.add({ lat: 29.76, lon: -95.37, action: 'broadcast' });
  assert.strictEqual((await alerts.checkWatch(w)).results[0].status, 'failed');
  fail = false;
  assert.strictEqual((await alerts.checkWatch(w)).results[0].status, 'broadcast');
  assert.strictEqual(sent.length, 1);
});

test('broadcast without a voice server says what is missing; a dry run touches nothing', async () => {
  const store = memStore();
  const alerts = createAlerts({ store, fetchImpl: nws([feature()]), now: () => NOW });
  const w = alerts.add({ lat: 29.76, lon: -95.37, action: 'broadcast' });
  const dry = await alerts.checkWatch(w, { dry: true });
  assert.strictEqual(dry.results[0].status, 'would-handle');
  assert.strictEqual(alerts.list().log.length, 0);
  const real = await alerts.checkWatch(w);
  assert.match(real.results[0].error, /VOICE_URL/);
});

test('an NWS outage is reported per watch and does not stop the others', async () => {
  const store = memStore(); let n = 0;
  const alerts = createAlerts({ store, now: () => NOW, fetchImpl: async () => { n += 1; if (n === 1) throw new Error('offline'); return { ok: true, json: async () => ({ features: [feature()] }) }; } });
  alerts.add({ name: 'a', lat: 1, lon: 1 }); alerts.add({ name: 'b', lat: 2, lon: 2 });
  const out = await alerts.checkAll();
  assert.match(out[0].error, /not reachable/);
  assert.strictEqual(out[1].results[0].status, 'noted');
});

test('the hub serves the alerts routes and needs the key', async () => {
  const store = memStore();
  const real = globalThis.fetch;
  const hub = createHub({ store, key: 'a-long-enough-hub-key', alertPollMs: 0, now: () => NOW, fetchImpl: async (u, o) => (String(u).startsWith('https://api.weather.gov') ? nws([feature()])(u, o) : real(u, o)) });
  const http = require('http');
  const server = http.createServer((req, res) => hub.handle(req, res));
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  const base = `http://127.0.0.1:${server.address().port}`;
  const call = (method, path, body, key = 'a-long-enough-hub-key') => real(base + path, { method, headers: { 'x-api-key': key, 'content-type': 'application/json' }, body: body ? JSON.stringify(body) : undefined }).then(async (r) => ({ status: r.status, body: await r.json() }));
  try {
    assert.strictEqual((await call('GET', '/alerts', null, 'wrong')).status, 401);
    const made = await call('POST', '/alerts/watches', { name: 'Houston', lat: 29.76, lon: -95.37 });
    assert.strictEqual(made.status, 201);
    assert.strictEqual((await call('POST', '/alerts/watches', { name: 'bad' })).status, 400);
    const dry = await call('POST', '/alerts/check?dry=1');
    assert.strictEqual(dry.body.results[0].results[0].status, 'would-handle');
    const live = await call('POST', '/alerts/check');
    assert.strictEqual(live.body.results[0].results[0].status, 'noted');
    assert.strictEqual((await call('GET', '/alerts')).body.log.length, 1);
    assert.strictEqual((await call('GET', '/alerts/active?lat=29.76&lon=-95.37')).body.alerts[0].event, 'Tornado Warning');
    assert.strictEqual((await call('PUT', `/alerts/watches/${made.body.id}`, { action: 'broadcast' })).body.action, 'broadcast');
    assert.strictEqual((await call('DELETE', `/alerts/watches/${made.body.id}`)).status, 200);
    assert.strictEqual((await call('DELETE', '/alerts/watches/nope')).status, 404);
  } finally { server.close(); hub.stop(); }
});
