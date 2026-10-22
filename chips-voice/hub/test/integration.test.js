// The hub driving the real RadioDJ agent (with a stand-in for RadioDJ's REST plugin behind it).
const test = require('node:test');
const assert = require('node:assert');
const http = require('http');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { createHub } = require('../hub');
const { createStore } = require('../store');
const { createAgent } = require('../../agent-radiodj/agent');

const listen = (server) => new Promise((r) => server.listen(0, '127.0.0.1', () => r(server.address().port)));

test('hub -> RadioDJ agent -> RadioDJ: status, a broadcast, and honest "not supported" answers', async () => {
  const radiodjCalls = [];
  const radiodj = http.createServer((req, res) => {
    const url = new URL(req.url, 'http://x');
    radiodjCalls.push({ path: url.pathname, command: url.searchParams.get('command'), arg: url.searchParams.get('arg') });
    res.writeHead(200); res.end(url.pathname === '/npjson' ? '{"Artist":"Band","Title":"Tune"}' : 'OK');
  });
  const rjPort = await listen(radiodj);
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'int-'));
  const agent = createAgent({ key: 'agent-key', radiodjUrl: `http://127.0.0.1:${rjPort}`, radiodjPass: 'pw', linksDir: dir, dataDir: path.join(dir, 'agent-data'), clipCart: '12' });
  const agentPort = await listen(agent.server);

  const store = createStore(null);
  const hub = createHub({ store, key: 'a-long-enough-hub-key', statusTtlMs: 0 });
  const hubServer = http.createServer((req, res) => hub.handle(req, res));
  const hubPort = await listen(hubServer);
  const call = async (method, p, body, headers = {}) => {
    const res = await fetch(`http://127.0.0.1:${hubPort}${p}`, { method, headers: { 'x-api-key': 'a-long-enough-hub-key', ...headers }, body: Buffer.isBuffer(body) ? body : body ? JSON.stringify(body) : undefined });
    return { status: res.status, json: await res.json() };
  };

  assert.strictEqual((await call('POST', '/stations', { name: 'Windows', url: `http://127.0.0.1:${agentPort}`, key: 'agent-key' })).status, 201);
  const st = (await call('GET', '/stations')).json.stations[0];
  assert.deepStrictEqual([st.online, st.kind, st.now.title], [true, 'radiodj', 'Band - Tune']);

  const sent = await call('POST', '/broadcast/upload?stations=windows&title=ID', Buffer.from('ID3-bytes'), { 'content-type': 'audio/mpeg' });
  assert.strictEqual(sent.status, 200);
  assert.strictEqual(sent.json.results[0].played, true);
  assert.strictEqual(fs.readFileSync(path.join(dir, 'current_link.mp3'), 'utf8'), 'ID3-bytes');
  assert.deepStrictEqual(radiodjCalls.filter((c) => c.command).map((c) => [c.command, c.arg]), [['PlayCartByNumber', '12']]);

  const skip = await call('POST', '/stations/windows/skip', {});
  assert.strictEqual(skip.status, 501);                                          // no skip command configured: the hub does not even try
  assert.match(skip.json.error, /does not support skip/);

  for (const s of [radiodj, agent.server, hubServer]) { s.close(); s.closeAllConnections?.(); }
  hub.stop();
});
