const test = require('node:test');
const assert = require('node:assert');
const http = require('http');
const path = require('path');
const express = require('express');
const { McpServer } = require('@modelcontextprotocol/sdk/server/mcp.js');
const { Client } = require('@modelcontextprotocol/sdk/client/index.js');
const { InMemoryTransport } = require('@modelcontextprotocol/sdk/inMemory.js');
const { StdioClientTransport } = require('@modelcontextprotocol/sdk/client/stdio.js');
const { StreamableHTTPClientTransport } = require('@modelcontextprotocol/sdk/client/streamableHttp.js');
const { registerTools } = require('../lib/mcp-tools');
const { createStationClient, StationError } = require('../lib/station-client');
const { createMcpRoutes } = require('../routes/mcp');

// A station stand-in: records requests and answers by path.
function mockStation(answers = {}) {
  const seen = [];
  const server = http.createServer((req, res) => {
    let body = '';
    req.on('data', (d) => { body += d; });
    req.on('end', () => {
      const url = new URL(req.url, 'http://x');
      seen.push({ method: req.method, path: url.pathname, query: Object.fromEntries(url.searchParams), headers: req.headers, body: body ? JSON.parse(body) : undefined });
      const key = `${req.method} ${url.pathname}`;
      const a = answers[key] !== undefined ? answers[key] : {};
      const status = a && a.__status ? a.__status : 200;
      res.writeHead(status, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify(a && a.__status ? { error: a.error } : a));
    });
  });
  return new Promise((resolve) => server.listen(0, '127.0.0.1', () => resolve({ url: `http://127.0.0.1:${server.address().port}`, seen, close: () => server.close() })));
}

// A recording fake of the station client, for testing the tools alone.
function fakeClient(overrides = {}) {
  const calls = [];
  const rec = (name, result = { ok: true }) => async (...args) => { calls.push([name, ...args]); return typeof result === 'function' ? result(...args) : result; };
  const names = ['status', 'nowPlaying', 'voices', 'fxPresets', 'sfx', 'clips', 'schedules', 'host', 'hostSay', 'draft', 'synth', 'applyFx', 'updateClip', 'clipLink', 'shareClip',
    'hostUpdate', 'speak', 'playClip', 'schedule', 'deleteSchedule', 'skip', 'setVolume', 'setPlaylist'];
  const client = {};
  for (const n of names) client[n] = rec(n);
  Object.assign(client, overrides);
  return { client, calls };
}

async function connect(client, options) {
  const server = new McpServer({ name: 'test', version: '1' });
  registerTools(server, client, options);
  const [a, b] = InMemoryTransport.createLinkedPair();
  await server.connect(a);
  const mcp = new Client({ name: 'tester', version: '1' });
  await mcp.connect(b);
  return { mcp, close: async () => { await mcp.close(); await server.close(); } };
}
const textOf = (r) => r.content[0].text;

test('station client: paths, credentials, bodies, and clear errors', async (t) => {
  const st = await mockStation({ 'GET /music/now': { title: 'T', listeners: 2 }, 'POST /speak': { played: true }, 'GET /host': { running: false }, 'GET /providers': { tts: {} }, 'DELETE /schedules/a%2Fb': { ok: true }, 'POST /music/skip': { __status: 502, error: 'liquidsoap down' } });
  t.after(() => st.close());
  const c = createStationClient({ baseUrl: `${st.url}/`, key: 'secret' });
  assert.deepStrictEqual(await c.nowPlaying(), { title: 'T', listeners: 2 });
  await c.speak({ text: 'hi', voice: 'Rocky' });
  await c.clips({ q: 'drinks', tag: undefined, favorite: '' });
  await c.deleteSchedule('a/b');
  await c.updateClip('c1', { title: 'x' });
  await c.setVolume(0.5);
  assert.deepStrictEqual(st.seen.map((s) => `${s.method} ${s.path}`), ['GET /music/now', 'POST /speak', 'GET /clips', 'DELETE /schedules/a%2Fb', 'PATCH /clips/c1', 'POST /music/volume']);
  assert.ok(st.seen.every((s) => s.headers['x-api-key'] === 'secret'));
  assert.deepStrictEqual(st.seen[1].body, { text: 'hi', voice: 'Rocky' });
  assert.deepStrictEqual(st.seen[2].query, { q: 'drinks' });                                          // empty and undefined parameters are not sent
  assert.deepStrictEqual((await c.status()).now, { title: 'T', listeners: 2 });
  await assert.rejects(c.skip(), (e) => e instanceof StationError && e.status === 502 && e.message === 'liquidsoap down');
  const down = createStationClient({ baseUrl: 'http://127.0.0.1:1', key: 'k', timeoutMs: 2000 });
  await assert.rejects(down.nowPlaying(), /cannot reach the station/);
  assert.deepStrictEqual((await down.status()).now.error.includes('cannot reach'), true);              // status() never throws, it reports
  assert.throws(() => createStationClient({}), /CHIPS_VOICE_URL/);
});

test('tools: the full list is offered, and read-only mode offers only the looking tools', async () => {
  const full = await connect(fakeClient().client);
  const tools = (await full.mcp.listTools()).tools;
  const names = tools.map((x) => x.name);
  for (const n of ['station_status', 'now_playing', 'say_on_air', 'make_clip', 'play_clip', 'schedule_announcement', 'host_configure', 'draft_announcement', 'apply_effect', 'list_sound_effects', 'skip_track']) {
    assert.ok(names.includes(n), n);
  }
  assert.ok(tools.every((x) => x.description && x.annotations));
  // anything that reaches the public stream says so, and is not marked read-only
  for (const n of ['say_on_air', 'play_clip', 'schedule_announcement', 'skip_track', 'host_configure']) {
    const tool = tools.find((x) => x.name === n);
    assert.match(tool.description, /PUBLIC STREAM/, n);
    assert.strictEqual(tool.annotations.readOnlyHint, false, n);
  }
  assert.ok(tools.filter((x) => /^(station_status|now_playing|list_|host_status|preview_host_line)/.test(x.name)).every((x) => x.annotations.readOnlyHint === true));
  await full.close();
  const ro = await connect(fakeClient().client, { readOnly: true });
  const roNames = (await ro.mcp.listTools()).tools.map((x) => x.name);
  assert.ok(roNames.includes('now_playing') && roNames.includes('list_clips'));
  for (const n of ['say_on_air', 'play_clip', 'skip_track', 'make_clip', 'host_configure', 'schedule_announcement', 'draft_announcement']) assert.ok(!roNames.includes(n), `${n} must not be offered read-only`);
  await ro.close();
});

test('tools call the station client with the right arguments', async () => {
  const { client, calls } = fakeClient({ clips: async () => [{ id: 'c1', title: 'Station ID', text: 'You are listening', provider: 'x', playCount: 2, favorite: true, tags: ['krap'], available: true, spec: { big: 'internal' } }] });
  const { mcp, close } = await connect(client);
  const call = (name, args) => mcp.callTool({ name, arguments: args });
  const listed = JSON.parse(textOf(await call('list_clips', { query: 'station' })));
  assert.deepStrictEqual(listed[0], { id: 'c1', title: 'Station ID', text: 'You are listening', provider: 'x', plays: 2, favorite: true, tags: ['krap'], available: true });   // trimmed for the model
  await call('say_on_air', { script: 'Rocky: Hi\nBritta: Hello', voices: { Rocky: 'Rocky' }, provider: 'elevenlabs', tone: 'warm', fx: { preset: 'underground' }, preempt: true });
  await call('make_clip', { text: 'Saved only [sfx:ding]' });
  await call('play_clip', { id: 'c1' });
  await call('set_music_volume', { percent: 35 });
  await call('apply_effect', { id: 'c1', fx: 'robot' });
  await call('host_configure', { enabled: true, every: 3 });
  await call('preview_host_line', { artist: 'Band', title: 'Tune' });
  await call('draft_announcement', { prompt: 'banter', format: 'dialogue', speakers: ['Rocky', 'Britta'], sfx: true, model: 'anthropic/claude-3.5-sonnet' });
  await call('schedule_announcement', { text: 'Happy hour', startAt: '2026-10-20T18:30:00-06:00', intervalMinutes: 60, count: 5, preempt: false });
  await call('schedule_announcement', { clipId: 'c1', startAt: '2026-10-21T09:00:00Z' });
  const by = (n) => calls.filter((c) => c[0] === n).map((c) => c.slice(1));
  assert.deepStrictEqual(by('speak')[0], [{ script: 'Rocky: Hi\nBritta: Hello', voices: { Rocky: 'Rocky' }, provider: 'elevenlabs', tone: 'warm', fx: { preset: 'underground' }, preempt: true }]);
  assert.deepStrictEqual(by('synth')[0], [{ text: 'Saved only [sfx:ding]' }]);
  assert.deepStrictEqual([by('playClip')[0], by('setVolume')[0], by('applyFx')[0], by('hostUpdate')[0]], [['c1', undefined], [0.35], ['c1', 'robot'], [{ enabled: true, every: 3 }]]);
  assert.deepStrictEqual(by('hostSay')[0], [{ artist: 'Band', title: 'Tune', dryRun: true }]);
  assert.deepStrictEqual(by('draft')[0], [{ prompt: 'banter', format: 'dialogue', speakers: ['Rocky', 'Britta'], sfx: true, model: 'anthropic/claude-3.5-sonnet' }]);
  const [text, clipSched] = by('schedule');
  assert.deepStrictEqual(text[0], { clipId: undefined, name: undefined, spec: { text: 'Happy hour' }, startAt: '2026-10-20T18:30:00-06:00', intervalSec: 3600, count: 5, preempt: false });
  assert.deepStrictEqual([clipSched[0].clipId, clipSched[0].spec, clipSched[0].intervalSec], ['c1', undefined, 0]);
  await close();
});

test('tools: bad input is rejected by the schema, and station failures come back as tool errors', async () => {
  const { client, calls } = fakeClient({ skip: async () => { throw new Error('liquidsoap down'); }, speak: async () => { throw new Error('speech synthesis failed (google: quota)'); } });
  const { mcp, close } = await connect(client);
  const bad = await mcp.callTool({ name: 'set_music_volume', arguments: { percent: 500 } }).catch((e) => ({ isError: true, content: [{ text: String(e.message) }] }));
  assert.strictEqual(bad.isError, true);
  assert.ok(!calls.some((c) => c[0] === 'setVolume'));                                                // never reached the station
  const missing = await mcp.callTool({ name: 'play_clip', arguments: {} }).catch((e) => ({ isError: true, content: [{ text: String(e.message) }] }));
  assert.strictEqual(missing.isError, true);
  const skip = await mcp.callTool({ name: 'skip_track', arguments: {} });
  assert.deepStrictEqual([skip.isError, textOf(skip)], [true, 'Error: liquidsoap down']);
  const say = await mcp.callTool({ name: 'say_on_air', arguments: { text: 'hi' } });
  assert.deepStrictEqual([say.isError, textOf(say)], [true, 'Error: speech synthesis failed (google: quota)']);
  const ok = await mcp.callTool({ name: 'now_playing', arguments: {} });
  assert.notStrictEqual(ok.isError, true);
  await close();
});

test('stdio server: a real process lists tools and calls the station with the key', async (t) => {
  const st = await mockStation({ 'GET /music/now': { title: 'Live Song', listeners: 4 } }); t.after(() => st.close());
  const transport = new StdioClientTransport({ command: process.execPath, args: [path.join(__dirname, '..', 'mcp', 'stdio.js')], env: { ...process.env, CHIPS_VOICE_URL: st.url, CHIPS_VOICE_KEY: 'stdio-key' }, stderr: 'ignore' });
  const mcp = new Client({ name: 'tester', version: '1' });
  await mcp.connect(transport);
  t.after(() => mcp.close());
  assert.ok((await mcp.listTools()).tools.length >= 20);
  const out = await mcp.callTool({ name: 'now_playing', arguments: {} });
  assert.deepStrictEqual(JSON.parse(textOf(out)), { title: 'Live Song', listeners: 4 });
  assert.strictEqual(st.seen[0].headers['x-api-key'], 'stdio-key');
});

test('stdio server: read-only mode, and a clear failure without a URL', async (t) => {
  const st = await mockStation(); t.after(() => st.close());
  const transport = new StdioClientTransport({ command: process.execPath, args: [path.join(__dirname, '..', 'mcp', 'stdio.js')], env: { ...process.env, CHIPS_VOICE_URL: st.url, MCP_READ_ONLY: 'true' }, stderr: 'ignore' });
  const mcp = new Client({ name: 'tester', version: '1' });
  await mcp.connect(transport); t.after(() => mcp.close());
  assert.ok(!(await mcp.listTools()).tools.some((x) => x.name === 'say_on_air'));
  const { spawnSync } = require('child_process');
  const r = spawnSync(process.execPath, [path.join(__dirname, '..', 'mcp', 'stdio.js')], { env: { PATH: process.env.PATH }, encoding: 'utf8', timeout: 15000 });
  assert.notStrictEqual(r.status, 0);
  assert.match(r.stderr, /CHIPS_VOICE_URL is not set/);
});

test('HTTP /mcp: behind the login, one request per call, same tools', async (t) => {
  const { client, calls } = fakeClient();
  const app = express();
  app.use(express.json());
  app.use((req, res, next) => (req.get('authorization') === 'Bearer good' ? next() : res.status(401).json({ error: 'login required' })));
  app.use(createMcpRoutes({ clientFor: () => client }));
  const server = await new Promise((r) => { const s = app.listen(0, '127.0.0.1', () => r(s)); });
  t.after(() => server.close());
  const url = new URL(`http://127.0.0.1:${server.address().port}/mcp`);

  assert.strictEqual((await fetch(url, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{}' })).status, 401);
  assert.strictEqual((await fetch(url, { method: 'GET', headers: { Authorization: 'Bearer good' } })).status, 405);

  const mcp = new Client({ name: 'tester', version: '1' });
  await mcp.connect(new StreamableHTTPClientTransport(url, { requestInit: { headers: { Authorization: 'Bearer good' } } }));
  t.after(() => mcp.close());
  assert.ok((await mcp.listTools()).tools.some((x) => x.name === 'say_on_air'));
  const out = await mcp.callTool({ name: 'skip_track', arguments: {} });
  assert.notStrictEqual(out.isError, true);
  assert.deepStrictEqual(calls.map((c) => c[0]), ['skip']);

  const rejected = new Client({ name: 'bad', version: '1' });
  await assert.rejects(rejected.connect(new StreamableHTTPClientTransport(url, { requestInit: { headers: { Authorization: 'Bearer nope' } } })));
});
