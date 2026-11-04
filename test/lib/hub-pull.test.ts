import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { PGlite } from "@electric-sql/pglite";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { setHubDb, type HubDb } from "../../lib/hub/db.js";
import { acquireLock, releaseLock } from "../../lib/hub/locks.js";
import { PullError, ackQueueItem, authenticateStation, getQueue, recordHeartbeat } from "../../lib/hub/pull.js";
import { handleHubPull } from "../../lib/handlers/hub-pull.js";

// The hub's tables in an in-process Postgres (PGlite), made from the real migration files.
const pg = new PGlite();
const db: HubDb = { query: async (text, params = []) => ({ rows: (await pg.query(text, params as any[])).rows as any[] }) }; // eslint-disable-line @typescript-eslint/no-explicit-any
const sha = (s: string) => createHash("sha256").update(s).digest("hex");
const KEY = "pull-key-for-denver-station";
const NOW = Date.UTC(2026, 9, 22, 23, 0, 0);

const put = (table: string, id: string, doc: object, pos = 0) =>
  table === "hub_state" ? pg.query("insert into hub_state (key, doc) values ($1, $2::jsonb)", [id, JSON.stringify(doc)]) : pg.query(`insert into ${table} (id, pos, doc) values ($1, $2, $3::jsonb)`, [id, pos, JSON.stringify(doc)]);
const docOf = async (table: string, id: string) => ((await pg.query<{ doc: any }>(`select doc from ${table} where ${table === "hub_state" ? "key" : "id"} = $1`, [id])).rows[0])?.doc; // eslint-disable-line @typescript-eslint/no-explicit-any

beforeAll(async () => {
  await pg.exec(readFileSync("chips-voice/hub/migrations/001_init.sql", "utf8"));
  await pg.exec(readFileSync("chips-voice/hub/migrations/002_locks.sql", "utf8"));
  setHubDb(db);
});
afterAll(async () => {
  setHubDb(null);
  await pg.close();
});

beforeEach(async () => {
  for (const t of ["hub_stations", "hub_jit_queue", "hub_jit_items", "hub_state", "hub_audit", "hub_locks"]) await pg.exec(`delete from ${t}`);
  await put("hub_stations", "den", { id: "den", name: "Denver", connection: "pull", broadcastTz: "America/Denver", pullKeyHash: sha(KEY) });
  await put("hub_stations", "other", { id: "other", name: "Other", connection: "pull", pullKeyHash: sha("another-stations-key") });
  await put("hub_jit_items", "i1", { id: "i1", state: "queued", reason: "", log: [], stationId: "den" });
  await put("hub_jit_queue", "q1", { id: "q1", itemId: "i1", stationId: "den", kind: "time-check", title: "time-check 17:05", text: "It is five past five.", startsAt: NOW + 600_000, expiresAt: NOW + 570_000, ahead: 2, replace: "evergreen-1", sha256: "ab".repeat(32), audioHash: "ab".repeat(32), bytes: 4000, mime: "audio/mpeg", state: "queued", createdAt: NOW });
});

describe("pull key", () => {
  it("opens the station's own calls and nothing else", async () => {
    expect((await authenticateStation(db, "den", KEY)).name).toBe("Denver");
    await expect(authenticateStation(db, "den", "wrong")).rejects.toMatchObject({ status: 401 });
    await expect(authenticateStation(db, "den", "another-stations-key")).rejects.toMatchObject({ status: 401 });
    await expect(authenticateStation(db, "nope", KEY)).rejects.toMatchObject({ status: 401 });
    await expect(authenticateStation(db, "den", "")).rejects.toMatchObject({ status: 401 });
  });
});

describe("queue", () => {
  it("hands out waiting clips with the time in the station's own zone", async () => {
    const station = await authenticateStation(db, "den", KEY);
    const out = await getQueue(db, station, NOW);
    expect(out.killed).toBe(false);
    expect(out.items).toHaveLength(1);
    expect(out.items[0]).toMatchObject({ id: "q1", replace: "evergreen-1", ahead: 2, bytes: 4000, startsAtIso: "2026-10-22T17:10:00-06:00" });
  });

  it("expires a clip that was not picked up and lets its line fall back", async () => {
    const station = await authenticateStation(db, "den", KEY);
    const out = await getQueue(db, station, NOW + 600_000);
    expect(out.items).toEqual([]);
    expect((await docOf("hub_jit_queue", "q1")).state).toBe("expired");
    const item = await docOf("hub_jit_items", "i1");
    expect(item).toMatchObject({ state: "fallback", reason: "the station did not pick the clip up in time" });
    expect(item.log.at(-1)).toMatchObject({ step: "fallback", ok: false });
  });

  it("hands out nothing during a live show or when a kill switch is on", async () => {
    const station = await authenticateStation(db, "den", KEY);
    await recordHeartbeat(db, station, { mode: "live-show", name: "RadioDJ" }, NOW);
    expect(await getQueue(db, station, NOW)).toMatchObject({ mode: "live-show", items: [] });
    await recordHeartbeat(db, station, { mode: "automation" }, NOW);
    expect((await getQueue(db, station, NOW)).items).toHaveLength(1);
    await put("hub_state", "jit", { settings: { kill: { on: true, reason: "maintenance" } } });
    expect(await getQueue(db, station, NOW)).toMatchObject({ killed: true, reason: "maintenance", items: [] });
  });

  it("forgets a stale mode report", async () => {
    const station = await authenticateStation(db, "den", KEY);
    await recordHeartbeat(db, station, { mode: "live-show" }, NOW);
    expect((await getQueue(db, station, NOW + 10 * 60_000 - 1)).mode).toBe("live-show");
    expect((await getQueue(db, station, NOW + 10 * 60_000)).mode).toBe("unknown");   // too old to hold clips back
  });
});

describe("heartbeat", () => {
  it("keeps only the known fields and says whether to stand down", async () => {
    const station = await authenticateStation(db, "den", KEY);
    const r = await recordHeartbeat(db, station, { mode: "automation", secret: "x", next: [{ artist: "A", title: "T", extra: 1 }], warnings: [{ code: "c", level: "bad", message: "m" }] }, NOW);
    expect(r).toEqual({ ok: true, time: NOW, killed: false });
    const saved = await docOf("hub_state", "report:den");
    expect(saved.report.secret).toBeUndefined();
    expect(saved.report.next).toEqual([{ artist: "A", title: "T" }]);
    expect(saved.report.warnings[0].level).toBe("warn");
    await expect(recordHeartbeat(db, station, null, NOW)).rejects.toBeInstanceOf(PullError);
  });
});

describe("acknowledging a clip", () => {
  it("marks the clip and its line, once", async () => {
    const station = await authenticateStation(db, "den", KEY);
    expect(await ackQueueItem(db, station, "q1", { status: "inserted", position: 3, verified: true, replaced: true }, NOW)).toEqual({ ok: true });
    expect((await docOf("hub_jit_queue", "q1")).state).toBe("inserted");
    expect(await docOf("hub_jit_items", "i1")).toMatchObject({ state: "inserted", reason: "inserted at position 3, replacing evergreen-1" });
    expect((await pg.query("select count(*)::int as n from hub_audit")).rows[0]).toEqual({ n: 1 });
    expect(await ackQueueItem(db, station, "q1", { status: "failed", reason: "late" }, NOW + 1)).toEqual({ ok: true, already: true });
    expect((await docOf("hub_jit_items", "i1")).state).toBe("inserted");
  });

  it("two stations' answers at the same moment: one wins", async () => {
    const station = await authenticateStation(db, "den", KEY);
    const both = await Promise.all([ackQueueItem(db, station, "q1", { status: "inserted", position: 1 }, NOW), ackQueueItem(db, station, "q1", { status: "failed", reason: "x" }, NOW)]);
    expect(both.filter((r) => r.already).length).toBe(1);
    expect((await pg.query("select count(*)::int as n from hub_audit")).rows[0]).toEqual({ n: 1 });
  });

  it("accepts a late 'inserted' for a clip that had already expired", async () => {
    const station = await authenticateStation(db, "den", KEY);
    await getQueue(db, station, NOW + 600_000);
    expect((await docOf("hub_jit_items", "i1")).state).toBe("fallback");
    await ackQueueItem(db, station, "q1", { status: "inserted", position: 2 }, NOW + 601_000);
    expect(await docOf("hub_jit_items", "i1")).toMatchObject({ state: "inserted" });
  });

  it("records a shadow-mode answer and refuses nonsense or another station's clip", async () => {
    const station = await authenticateStation(db, "den", KEY);
    await expect(ackQueueItem(db, station, "q1", { status: "maybe" }, NOW)).rejects.toMatchObject({ status: 400 });
    const other = await authenticateStation(db, "other", "another-stations-key");
    await expect(ackQueueItem(db, other, "q1", { status: "inserted" }, NOW)).rejects.toMatchObject({ status: 404 });
    await ackQueueItem(db, station, "q1", { status: "shadow", reason: "shadow flag on" }, NOW);
    expect(await docOf("hub_jit_items", "i1")).toMatchObject({ state: "shadow", reason: "the station is in shadow mode: shadow flag on" });
  });
});

describe("locks", () => {
  it("lets one holder in at a time and hands over after expiry", async () => {
    expect(await acquireLock(db, "tick", "a", 60_000)).toBe(true);
    expect(await acquireLock(db, "tick", "b", 60_000)).toBe(false);
    await releaseLock(db, "tick", "b");                      // not the holder: no effect
    expect(await acquireLock(db, "tick", "b", 60_000)).toBe(false);
    await releaseLock(db, "tick", "a");
    expect(await acquireLock(db, "tick", "b", 60_000)).toBe(true);
    expect(await acquireLock(db, "short", "a", 1)).toBe(true);
    await new Promise((r) => setTimeout(r, 15));
    expect(await acquireLock(db, "short", "b", 60_000)).toBe(true);
  });

  it("of two callers at once, exactly one gets it", async () => {
    const got = await Promise.all([acquireLock(db, "slot-1", "a", 60_000), acquireLock(db, "slot-1", "b", 60_000)]);
    expect(got.filter(Boolean)).toHaveLength(1);
  });
});

describe("the HTTP calls", () => {
  const call = (path: string, init: RequestInit = {}, key: string | null = KEY, read = async () => new TextEncoder().encode("MP3!").buffer as ArrayBuffer) =>
    handleHubPull(new Request(`https://site.test${path}`, { ...init, headers: { ...(key ? { "x-api-key": key } : {}), ...(init.body ? { "content-type": "application/json" } : {}) } }), read, NOW);

  it("serves the four calls with the station's key", async () => {
    expect((await call("/api/pull/stations/den/heartbeat", { method: "POST", body: JSON.stringify({ status: { mode: "automation" } }) })).status).toBe(200);
    const q = (await (await call("/api/pull/stations/den/queue")).json()) as { items: { id: string }[] };
    expect(q.items[0].id).toBe("q1");
    const audio = await call("/api/pull/stations/den/queue/q1/audio");
    expect(audio.headers.get("x-sha256")).toBe("ab".repeat(32));
    expect(audio.headers.get("content-type")).toBe("audio/mpeg");
    expect(await audio.text()).toBe("MP3!");
    expect(await (await call("/api/pull/stations/den/queue/q1/ack", { method: "POST", body: JSON.stringify({ status: "inserted", position: 1 }) })).json()).toEqual({ ok: true });
  });

  it("refuses a missing or wrong key, wrong methods and unknown paths; reports a gone audio file", async () => {
    expect((await call("/api/pull/stations/den/queue", {}, null)).status).toBe(401);
    expect((await call("/api/pull/stations/den/queue", {}, "nope")).status).toBe(401);
    expect((await call("/api/pull/stations/den/queue", {}, "another-stations-key")).status).toBe(401);
    expect((await call("/api/pull/stations/den/queue", { method: "POST", body: "{}" })).status).toBe(405);
    expect((await call("/api/pull/stations/den/elsewhere")).status).toBe(404);
    expect((await call("/api/pull/stations/den/heartbeat", { method: "POST", body: "[]" })).status).toBe(400);
    expect((await call("/api/pull/stations/den/queue/q1/audio", {}, KEY, async () => null as unknown as ArrayBuffer)).status).toBe(410);
  });

  it("says so when the database is not connected", async () => {
    setHubDb(null);
    const saved = process.env.DATABASE_URL;
    delete process.env.DATABASE_URL;
    try {
      expect((await call("/api/pull/stations/den/queue")).status).toBe(503);
    } finally {
      if (saved !== undefined) process.env.DATABASE_URL = saved;
      setHubDb(db);
    }
  });
});
