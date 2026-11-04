// Postgres (Neon) store with the same shape as store.js: { data, save, flush }, plus load() to read the rows in first.
// The hub still works on one in-memory object; flush() writes back only the rows that changed since the last load or flush,
// so two writers touching different records do not overwrite each other. Two writers changing the SAME record still race
// (last write wins): claiming work safely is phase 2 (docs: hub on Netlify and Neon).
//
// db is any executor with: query(text, params) -> { rows }, and batch([{ text, params }]) which runs the statements as one transaction.
// fromPglite() adapts @electric-sql/pglite (used by the tests); a Neon adapter comes when the site wires this in.
const crypto = require('crypto');
const fs = require('fs');
const path = require('path');

// path = where the collection sits in the hub's data. kind: array (ordered records) or map (record per key).
const COLLECTIONS = [
  { path: ['stations'], kind: 'array', table: 'hub_stations' },
  { path: ['playlists'], kind: 'map', table: 'hub_playlists' },
  { path: ['jobs'], kind: 'array', table: 'hub_jobs' },
  { path: ['audit'], kind: 'array', table: 'hub_audit' },
  { path: ['jit', 'slots'], kind: 'array', table: 'hub_jit_slots' },
  { path: ['jit', 'items'], kind: 'array', table: 'hub_jit_items' },
  { path: ['jit', 'queue'], kind: 'array', table: 'hub_jit_queue' },
  { path: ['alerts', 'watches'], kind: 'array', table: 'hub_alert_watches' },
  { path: ['alerts', 'log'], kind: 'array', table: 'hub_alert_log' },
];

// Objects whose parts are stored as separate hub_state rows (jit.settings, jit.usage ...), so a writer that only changed one does not rewrite the rest.
const SPLIT = new Set(['jit', 'alerts']);
const isPlain = (v) => v && typeof v === 'object' && !Array.isArray(v);

const clone = (v) => JSON.parse(JSON.stringify(v));
const sha = (s) => crypto.createHash('sha1').update(s).digest('hex');

function getAt(root, p) { let o = root; for (const k of p) { if (!o || typeof o !== 'object') return undefined; o = o[k]; } return o; }
function setAt(root, p, value) { let o = root; for (const k of p.slice(0, -1)) { if (!o[k] || typeof o[k] !== 'object') o[k] = {}; o = o[k]; } o[p[p.length - 1]] = value; }
function delAt(root, p) { const parent = getAt(root, p.slice(0, -1)); if (parent && typeof parent === 'object') delete parent[p[p.length - 1]]; }

// id -> { pos, json } for one collection. Records without an id are named by a hash of their content (a repeat gets a suffix).
function rowsOf(col, value) {
  const rows = new Map();
  if (col.kind === 'map') {
    let pos = 0;
    for (const [k, v] of Object.entries(value || {})) rows.set(k, { pos: pos++, json: JSON.stringify(v) });
    return rows;
  }
  (Array.isArray(value) ? value : []).forEach((v, pos) => {
    const json = JSON.stringify(v);
    let id = v && typeof v === 'object' && v.id !== undefined && v.id !== null && v.id !== '' ? String(v.id) : sha(json);
    for (let n = 2; rows.has(id); n++) id = `${v && v.id !== undefined ? v.id : sha(json)}#${n}`;
    rows.set(id, { pos, json });
  });
  return rows;
}

function createPgStore(db, defaults = { stations: [], playlists: {}, jobs: [] }, { debounceMs = 200 } = {}) {
  const data = clone(defaults);
  let persisted = new Map();                 // table -> Map(id -> { pos, json })
  let persistedState = new Map();            // key -> json
  let timer = null;
  let chain = Promise.resolve();

  // Everything that is not a collection, by top-level key (jit.settings, jit.usage, alerts.seen and so on).
  function stateOf() {
    const rest = clone(data);
    for (const col of COLLECTIONS) delAt(rest, col.path);
    const out = new Map();
    for (const [k, v] of Object.entries(rest)) {
      if (SPLIT.has(k) && isPlain(v)) { for (const [sk, sv] of Object.entries(v)) out.set(`${k}.${sk}`, JSON.stringify(sv)); } else out.set(k, JSON.stringify(v));
    }
    return out;
  }

  async function load() {
    persisted = new Map(); persistedState = new Map();
    for (const col of COLLECTIONS) {
      const { rows } = await db.query(`select id, pos, doc from ${col.table} order by pos, id`);
      const map = new Map();
      for (const r of rows) map.set(r.id, { pos: Number(r.pos), json: JSON.stringify(r.doc) });
      persisted.set(col.table, map);
      if (!rows.length) continue;
      setAt(data, col.path, col.kind === 'map' ? Object.fromEntries(rows.map((r) => [r.id, r.doc])) : rows.map((r) => r.doc));
    }
    const { rows: st } = await db.query('select key, doc from hub_state');
    for (const r of st) {
      persistedState.set(r.key, JSON.stringify(r.doc));
      const dot = r.key.indexOf('.');
      if (dot > 0 && SPLIT.has(r.key.slice(0, dot))) {
        const top = r.key.slice(0, dot);
        if (!isPlain(data[top])) data[top] = {};
        data[top][r.key.slice(dot + 1)] = r.doc;
      } else if (isPlain(data[r.key]) && isPlain(r.doc)) data[r.key] = { ...data[r.key], ...r.doc };   // keep the collections already placed inside it
      else data[r.key] = r.doc;
    }
    // A collection with no rows is an empty one, as long as the object it sits in exists (the hub reads data.jit.slots without checking).
    for (const col of COLLECTIONS) {
      const parent = col.path.length > 1 ? getAt(data, col.path.slice(0, -1)) : data;
      if (parent && typeof parent === 'object' && getAt(data, col.path) === undefined) setAt(data, col.path, col.kind === 'map' ? {} : []);
    }
    return data;
  }

  function diff() {
    const stmts = [];
    const nexts = new Map();
    for (const col of COLLECTIONS) {
      const want = rowsOf(col, getAt(data, col.path));
      const had = persisted.get(col.table) || new Map();
      for (const [id, row] of want) {
        const old = had.get(id);
        if (!old || old.json !== row.json || old.pos !== row.pos) stmts.push({ text: `insert into ${col.table} (id, pos, doc, updated_at) values ($1, $2, $3::jsonb, now()) on conflict (id) do update set pos = excluded.pos, doc = excluded.doc, updated_at = now()`, params: [id, row.pos, row.json] });
      }
      for (const id of had.keys()) if (!want.has(id)) stmts.push({ text: `delete from ${col.table} where id = $1`, params: [id] });
      nexts.set(col.table, want);
    }
    const wantState = stateOf();
    for (const [k, json] of wantState) if (persistedState.get(k) !== json) stmts.push({ text: 'insert into hub_state (key, doc, updated_at) values ($1, $2::jsonb, now()) on conflict (key) do update set doc = excluded.doc, updated_at = now()', params: [k, json] });
    for (const k of persistedState.keys()) if (!wantState.has(k)) stmts.push({ text: 'delete from hub_state where key = $1', params: [k] });
    return { stmts, wantState, nexts };
  }

  function flush() {
    if (timer) { clearTimeout(timer); timer = null; }
    const run = chain.then(async () => {
      const { stmts, wantState, nexts } = diff();
      if (!stmts.length) return;
      await db.batch(stmts);
      persisted = nexts;
      persistedState = wantState;
    });
    chain = run.catch(() => {});             // a failed write is reported to whoever awaits flush(); the next flush works out the diff again and retries
    return run;
  }
  function save() { if (timer) return; timer = setTimeout(() => { flush().catch((err) => console.error(`hub store: ${err.message}`)); }, debounceMs); if (timer.unref) timer.unref(); }

  return { data, save, flush, load };
}

// Runs the .sql files in migrations/ that have not run yet, in name order.
async function migrate(db, dir = path.join(__dirname, 'migrations')) {
  await db.query('create table if not exists hub_migrations (name text primary key, ran_at timestamptz not null default now())');
  const { rows } = await db.query('select name from hub_migrations');
  const done = new Set(rows.map((r) => r.name));
  const ran = [];
  for (const name of fs.readdirSync(dir).filter((f) => f.endsWith('.sql')).sort()) {
    if (done.has(name)) continue;
    const sql = fs.readFileSync(path.join(dir, name), 'utf8');
    await db.batch([...sql.split(/;\s*\n/).map((s) => s.replace(/^\s*--.*$/gm, '').trim()).filter(Boolean).map((text) => ({ text, params: [] })), { text: 'insert into hub_migrations (name) values ($1)', params: [name] }]);
    ran.push(name);
  }
  return ran;
}

function fromPglite(pg) {
  return {
    query: async (text, params = []) => { const r = await pg.query(text, params); return { rows: r.rows }; },
    batch: (stmts) => pg.transaction(async (tx) => { for (const s of stmts) await tx.query(s.text, s.params); }),
  };
}

module.exports = { createPgStore, migrate, fromPglite, COLLECTIONS };
