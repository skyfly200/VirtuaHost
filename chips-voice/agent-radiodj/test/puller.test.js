// The whole pull loop with real components and fakes at the edges: a hub (in memory) with a fake writer/speaker, a RadioDJ agent, a fake RadioDJ.
// The PC never receives a connection: only the puller (outbound) talks to the hub.
const test = require('node:test');
const assert = require('node:assert');
const http = require('http');
const fs = require('fs');
const os = require('os');
const path = require('path');
const crypto = require('crypto');
const { createAgent } = require('../agent');
const { createPuller } = require('../puller');
const { createHub } = require('../../hub/hub');
const { createStore } = require('../../hub/store');

const DEN = 'America/Denver';
const audioFor = (text) => Buffer.concat([Buffer.from('ID3'), crypto.createHash('sha512').update(text).digest(), Buffer.alloc(2000, 7)]);
const track = (artist, title, extra = {}) => ({ Artist: artist, Title: title, ...extra });

async function listen(handler) {
  const server = http.createServer(handler);
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  return { server, url: `http://127.0.0.1:${server.address().port}`, close: () => { server.close(); server.closeAllConnections?.(); } };
}

async function world({ agentOpts = {}, now = Date.parse('2026-10-22T20:00:00Z') } = {}) {
  const clock = { t: now };
  const rdj = { playlist: [track('A', 'One'), track('', 'evergreen-time-1', { Path: 'evergreen-time-1.mp3' }), track('C', 'Three')], commands: [] };
  const radio = await listen((req, res) => {
    const url = new URL(req.url, 'http://x');
    if (url.pathname === '/npjson') { res.writeHead(200); return res.end(JSON.stringify({ CurrentTrack: track('Now', 'Playing', { Duration: 200, Elapsed: 50, Remaining: 150 }), Playlist: rdj.playlist })); }
    if (url.pathname === '/opt') rdj.commands.push(Object.fromEntries(url.searchParams));
    res.writeHead(200); res.end('OK');
  });
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'pull-'));
  const sched = path.join(dir, 'sched');
  fs.mkdirSync(sched);
  const execs = [];
  const agent = createAgent({
    key: 'local-control', radiodjUrl: radio.url, radiodjPass: 'pw', linksDir: path.join(dir, 'clips'), dataDir: path.join(dir, 'data'), broadcastTz: DEN, machineTz: 'America/Chicago', shadow: false,
    insertExec: 'python insert.py', scheduleDir: sched, now: () => clock.t, execImpl: (p, a, o, cb) => { execs.push(a); if (!agentOpts.noSwap) { const i = rdj.playlist.findIndex((x) => x.Title === 'evergreen-time-1'); if (i >= 0) rdj.playlist.splice(i, 1, track('', path.basename(a[1], path.extname(a[1])), { Path: a[1] })); } cb(null, 'ok', ''); }, ...agentOpts,
  });
  await new Promise((r) => agent.server.listen(0, '127.0.0.1', r));
  const agentUrl = `http://127.0.0.1:${agent.server.address().port}`;

  const speech = [];
  const generate = async (b) => {
    if (b.textOnly) return { status: 200, json: { filledIn: 'Eight oh four on Green Light Radio.', raw: 'x', textModel: 'fake/writer' } };
    speech.push(b);
    return { status: 200, json: { preview: true, audio: audioFor(b.text).toString('base64'), mimeType: 'audio/mpeg' } };
  };
  const store = createStore(null);
  const hub = createHub({ store, key: 'hub-control-key-123', now: () => clock.t, generate, sleep: async () => {}, jitTickMs: 0, alertPollMs: 0, statusTtlMs: 0 });
  const hubServer = await listen((req, res) => hub.handle(req, res));
  const hcall = async (method, p, body, key = 'hub-control-key-123') => { const r = await fetch(hubServer.url + p, { method, headers: { 'x-api-key': key, 'content-type': 'application/json' }, body: body ? JSON.stringify(body) : undefined }); return { status: r.status, json: await r.json().catch(() => null) }; };
  const st = (await hcall('POST', '/stations', { name: 'Green Light Radio', connection: 'pull', broadcastTz: DEN, machineTz: 'America/Chicago', siteStationId: 'green-light-radio-d6b9' })).json;
  await hcall('PUT', `/stations/${st.id}/jit`, { enabled: true, shadow: false, requireApproval: false });
  const puller = createPuller({ hubUrl: hubServer.url, stationId: st.id, key: st.pullKey, localUrl: agentUrl, localKey: 'local-control', now: () => clock.t, log: () => {} });
  return { clock, rdj, execs, agent, agentUrl, hub, hcall, st, puller, speech, store, sched, dir, close: () => { puller.stop(); hub.stop(); agent.server.close(); agent.server.closeAllConnections?.(); hubServer.close(); radio.close(); } };
}
const slotAt = (w, minutes, extra = {}) => w.hcall('POST', '/jit/slots', { stationId: w.st.id, kind: 'time-check', startsAt: new Date(w.clock.t + minutes * 60000).toISOString(), personaId: 'rocky-flats-7fb0ca', fallbackClipId: 'evergreen-time-1', ...extra });

test('end to end by pull: a heartbeat shows the station online, a finished clip is fetched, checked, inserted two ahead locally, and acked', async () => {
  const w = await world();
  await slotAt(w, 8);
  await w.hub.jit.tick();
  assert.strictEqual((await w.hcall('GET', '/jit/items')).json.items[0].state, 'queued');

  const r = await w.puller.tick();
  assert.deepStrictEqual(r, { handled: 1 });
  // the hub now knows the station from its report alone
  const rec = (await w.hcall('GET', '/stations')).json.stations[0];
  assert.deepStrictEqual([rec.online, rec.mode, rec.nowPlaying.title, rec.nowPlaying.remainingSeconds, rec.next.length, rec.shadow], [true, 'automation', 'Playing', 150, 3, false]);
  assert.ok(rec.warnings.some((x) => x.code === 'zones-differ'));
  // the agent inserted it through its local script, 2 ahead, and the hub knows
  assert.strictEqual(w.execs.length, 1);
  assert.deepStrictEqual([w.execs[0][0], w.execs[0][2], w.execs[0][3]], ['insert.py', '2', 'evergreen-time-1']);      // position 2, replacing the planned clip
  assert.ok(!w.rdj.playlist.some((x) => x.Title === 'evergreen-time-1'));                                              // the planned clip is gone: the generated one preempted it
  const item = (await w.hcall('GET', '/jit/items')).json.items[0];
  assert.strictEqual(item.state, 'inserted');
  assert.match(item.reason, /inserted at position 2, replacing evergreen-time-1/);
  assert.strictEqual(item.queue.ack.status, 'inserted');
  assert.deepStrictEqual(fs.readdirSync(path.join(w.dir, 'clips')).length, 1);                          // saved under its hash-based name
  // idempotent: another pass finds nothing to do and inserts nothing twice
  assert.deepStrictEqual(await w.puller.tick(), { handled: 0 });
  assert.strictEqual(w.execs.length, 1);
  w.close();
});

test('the agent in shadow mode accepts the clip but inserts nothing, and the hub is told', async () => {
  const w = await world({ agentOpts: { shadow: true } });
  await slotAt(w, 8);
  await w.hub.jit.tick();
  await w.puller.tick();
  assert.strictEqual(w.execs.length, 0);
  assert.strictEqual(w.rdj.commands.length, 0);
  const item = (await w.hcall('GET', '/jit/items')).json.items[0];
  assert.strictEqual(item.state, 'shadow');
  assert.match(item.reason, /local agent is in shadow mode/);
  w.close();
});

test('the agent\'s own kill switch wins: the clip is skipped and the planned clip plays', async () => {
  const w = await world();
  fs.mkdirSync(path.join(w.dir, 'data'), { recursive: true });
  fs.writeFileSync(path.join(w.dir, 'data', 'KILL'), 'stop');
  await slotAt(w, 8);
  await w.hub.jit.tick();
  await w.puller.tick();
  assert.strictEqual(w.execs.length, 0);
  const item = (await w.hcall('GET', '/jit/items')).json.items[0];
  assert.strictEqual(item.state, 'fallback');
  assert.match(item.reason, /did not insert it \(skipped\).*kill switch is on/);
  w.close();
});

test('a live show on the PC: the heartbeat tells the hub, which hands out nothing; the agent would refuse anyway', async () => {
  const w = await world();
  fs.mkdirSync(path.join(w.dir, 'data'), { recursive: true });
  fs.writeFileSync(path.join(w.dir, 'data', 'mode'), 'live-show');
  await slotAt(w, 8);
  await w.hub.jit.tick();
  const r = await w.puller.tick();
  assert.deepStrictEqual(r, { handled: 0 });
  assert.strictEqual(w.execs.length, 0);
  assert.strictEqual((await w.hcall('GET', '/stations')).json.stations[0].mode, 'live-show');
  const res = await fetch(`${w.agentUrl}/queue/insert`, { method: 'POST', headers: { 'x-api-key': 'local-control', 'content-type': 'application/json' }, body: '{"clip":"x"}' });
  assert.strictEqual(res.status, 409);
  w.close();
});

test('a queue too short to insert two ahead is skipped, not forced into the next slot', async () => {
  const w = await world();
  w.rdj.playlist.length = 0;
  await slotAt(w, 8);
  await w.hub.jit.tick();
  await w.puller.tick();
  assert.strictEqual(w.execs.length, 0);
  assert.match((await w.hcall('GET', '/jit/items')).json.items[0].reason, /not enough items are queued ahead/);
  w.close();
});

test('a damaged download is refused before it reaches RadioDJ', async () => {
  const w = await world();
  await slotAt(w, 8);
  await w.hub.jit.tick();
  const q = w.store.data.jit.queue[0];
  q.sha256 = 'f'.repeat(64);                                                    // the hub claims a hash the audio does not have
  await w.puller.tick();
  assert.strictEqual(w.execs.length, 0);
  assert.match((await w.hcall('GET', '/jit/items')).json.items[0].reason, /does not match its sha256/);
  w.close();
});

test('the hub\'s kill switch stops the loop from fetching anything; a hub that is down is survived', async () => {
  const w = await world();
  await slotAt(w, 8);
  await w.hub.jit.tick();
  await w.hcall('POST', '/jit/kill', { on: true, reason: 'stop' });
  assert.deepStrictEqual(await w.puller.tick(), { killed: true, handled: 0 });
  assert.strictEqual(w.execs.length, 0);
  const lost = createPuller({ hubUrl: 'http://127.0.0.1:1', stationId: 'x', key: 'k', localUrl: w.agentUrl, localKey: 'local-control', log: () => {} });
  assert.match((await lost.tick()).error, /./);                                  // reported, not thrown
  assert.throws(() => createPuller({ hubUrl: '', stationId: 'x', key: 'k' }), /HUB_URL/);
  w.close();
});

test('the nightly plan reaches the hub: dynamic slots in the agent\'s schedule become hub slots in the broadcast zone', async () => {
  const w = await world();
  fs.writeFileSync(path.join(w.sched, 'GLR 2026-10-22.json'), JSON.stringify({ items: [
    { time: '19:00:00', kind: 'song', artist: 'A', title: 'B' },
    { time: '19:04:00', kind: 'dynamic-slot', dynamic: { slotKind: 'time-check', personaId: 'rocky-flats-7fb0ca', leadSeconds: 600, fallbackClipId: 'evergreen-time-1' } },
    { time: '20:00:00', kind: 'dynamic-slot', dynamic: { slotKind: 'station-id', personaId: 'rocky-flats-7fb0ca' } },
  ] }));
  await w.puller.tick();
  const slots = (await w.hcall('GET', `/jit/slots?stationId=${w.st.id}`)).json.slots;
  assert.deepStrictEqual(slots.map((s) => [s.kind, s.startsAtIso, s.source, s.fallbackClipId]).sort(), [['station-id', '2026-10-22T20:00:00-06:00', 'schedule', ''], ['time-check', '2026-10-22T19:04:00-06:00', 'schedule', 'evergreen-time-1']]);
  assert.strictEqual((await w.puller.tick()).handled, 0);                         // unchanged: not sent again
  w.close();
});

test('if the planned clip is still queued after the insert, the hub is told it failed (both would air), not that it worked', async () => {
  const w = await world({ agentOpts: { noSwap: true } });
  await slotAt(w, 8);
  await w.hub.jit.tick();
  await w.puller.tick();
  const item = (await w.hcall('GET', '/jit/items')).json.items[0];
  assert.strictEqual(item.state, 'fallback');
  assert.match(item.reason, /planned clip was not removed: both may play/);
  w.close();
});
