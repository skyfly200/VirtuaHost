const { test, after } = require('node:test');
const assert = require('node:assert');
const http = require('http');
const { PGlite } = require('@electric-sql/pglite');
const { createPgStore, migrate, fromPglite } = require('../pg-store');
const { createHub } = require('../hub');

const KEY = 'a-long-enough-hub-key';

// One in-process Postgres for the file (starting one takes seconds); each test starts from empty tables.
const pg = new PGlite();
const shared = fromPglite(pg);
after(() => pg.close());
async function freshDb() {
  await migrate(shared);
  for (const { tablename } of (await pg.query("select tablename from pg_tables where schemaname = 'public' and tablename like 'hub\\_%' and tablename <> 'hub_migrations'")).rows) await pg.query(`truncate ${tablename}`);
  return shared;
}

async function boot(db) {
  const store = createPgStore(db, undefined, { debounceMs: 5 });
  await store.load();
  const hub = createHub({ store, key: KEY, statusTtlMs: 0 });
  const server = http.createServer((req, res) => hub.handle(req, res));
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  const base = `http://127.0.0.1:${server.address().port}`;
  const call = async (method, p, body) => {
    const res = await fetch(base + p, { method, headers: { 'x-api-key': KEY, ...(body !== undefined ? { 'content-type': 'application/json' } : {}) }, body: body === undefined ? undefined : JSON.stringify(body) });
    return { status: res.status, json: await res.json().catch(() => null) };
  };
  return { store, hub, call, close: () => { hub.stop(); server.close(); server.closeAllConnections?.(); } };
}

test('migrations run once and are recorded', async () => {
  const db = shared;
  assert.deepStrictEqual(await migrate(db), ['001_init.sql', '002_locks.sql']);
  assert.deepStrictEqual(await migrate(db), []);
});

test('the hub comes back after a restart with its stations, playlists, slots and settings', async () => {
  const db = await freshDb();
  const a = await boot(db);
  const st = (await a.call('POST', '/stations', { name: 'Pull One', connection: 'pull' })).json;
  assert.ok(st.id);
  assert.strictEqual((await a.call('PUT', '/playlists/Late Night', { items: ['x/one.mp3', 'x/two.mp3'], note: 'for the ship' })).status, 200);
  const startsAt = new Date(Date.now() + 3600e3).toISOString();
  const slot = (await a.call('POST', '/jit/slots', { stationId: st.id, kind: 'time-check', startsAt, fallbackClipId: 'evergreen-1' })).json;
  assert.ok(slot.id, JSON.stringify(slot));
  assert.strictEqual((await a.call('PUT', '/jit/settings', { dailyCharCap: 1234 })).status, 200);
  await a.store.flush();
  a.close();

  const b = await boot(db);                                  // a new process: nothing in memory, everything from the database
  const sl = await b.call('GET', '/stations'); assert.deepStrictEqual(sl.json.stations.map((s) => s.name), ['Pull One']);
  assert.strictEqual((await b.call('GET', '/playlists')).json.playlists.some((p) => p.name === 'Late Night'), true);
  assert.deepStrictEqual((await b.call('GET', '/jit/slots')).json.slots.map((s) => s.id), [slot.id]);
  assert.strictEqual(b.store.data.jit.settings.dailyCharCap, 1234);
  const keys = (await shared.query('select key from hub_state order by key')).rows.map((r) => r.key);
  assert.ok(keys.includes('jit.settings') && !keys.includes('jit'), keys.join());      // the pieces of jit are separate rows
  assert.ok(b.store.data.audit.length >= 3);                 // audit entries have no id of their own
  b.close();
});

test('a flush writes only the records that changed, and removed records are deleted', async () => {
  const db = await freshDb();
  const sent = [];
  const spy = { query: db.query, batch: (s) => { sent.push(...s); return db.batch(s); } };
  const store = createPgStore(spy, undefined, { debounceMs: 5 });
  await store.load();
  store.data.stations.push({ id: 'a', name: 'A' }, { id: 'b', name: 'B' });
  await store.flush();
  assert.strictEqual(sent.length, 2);
  sent.length = 0;
  await store.flush();
  assert.strictEqual(sent.length, 0);                        // nothing changed
  store.data.stations[1].name = 'B2';
  await store.flush();
  assert.deepStrictEqual(sent.map((s) => [s.text.split(' ')[0], s.params[0]]), [['insert', 'b']]);
  sent.length = 0;
  store.data.stations = store.data.stations.filter((s) => s.id !== 'a');
  await store.flush();
  assert.deepStrictEqual(sent.map((s) => [s.text.split(' ')[0], s.params[0]]), [['insert', 'b'], ['delete', 'a']]);   // b moved up one place
  const again = createPgStore(db);
  await again.load();
  assert.deepStrictEqual(again.data.stations, [{ id: 'b', name: 'B2' }]);
});

test('two processes changing different stations do not overwrite each other', async () => {
  const db = await freshDb();
  const seed = createPgStore(db); await seed.load();
  seed.data.stations.push({ id: 'a', name: 'A' }, { id: 'b', name: 'B' });
  await seed.flush();
  const p1 = createPgStore(db); await p1.load();
  const p2 = createPgStore(db); await p2.load();
  p1.data.stations[0].name = 'A1'; await p1.flush();
  p2.data.stations[1].name = 'B2'; await p2.flush();
  const check = createPgStore(db); await check.load();
  assert.deepStrictEqual(check.data.stations.map((s) => s.name), ['A1', 'B2']);
});

test('a failed write is reported and the next flush retries it', async () => {
  const db = await freshDb();
  let fail = true;
  const flaky = { query: db.query, batch: (s) => (fail ? Promise.reject(new Error('network')) : db.batch(s)) };
  const store = createPgStore(flaky); await store.load();
  store.data.stations.push({ id: 'a', name: 'A' });
  await assert.rejects(store.flush(), /network/);
  fail = false;
  await store.flush();
  const again = createPgStore(db); await again.load();
  assert.strictEqual(again.data.stations.length, 1);
});
