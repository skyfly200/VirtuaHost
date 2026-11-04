import { createHash } from "node:crypto";
import { createRequire } from "node:module";
import { readFileSync } from "node:fs";
import http from "node:http";
import { PGlite } from "@electric-sql/pglite";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import type { AudioBlobs } from "../../lib/hub/audio.js";
import { setHubDb, type HubDb } from "../../lib/hub/db.js";
import { acquireLock, releaseLock } from "../../lib/hub/locks.js";
import { runSlot, runTick, type RunnerDeps } from "../../lib/hub/runner.js";
import { handleHubPull } from "../../lib/handlers/hub-pull.js";

/* eslint-disable @typescript-eslint/no-explicit-any */
// The hub's own just-in-time logic running on the Postgres store, the way the scheduled and background functions run it:
// a real in-process Postgres (PGlite) with the real migrations, the hub's CommonJS code, a fake site standing in for /api/generate,
// and a Map standing in for Netlify Blobs.
const require = createRequire(import.meta.url);
const { createJit } = require("../../chips-voice/hub/jit.js");
const { createPgStore } = require("../../chips-voice/hub/pg-store.js");
const { createHub } = require("../../chips-voice/hub/hub.js");

const pg = new PGlite();
const db: HubDb = { query: async (text, params = []) => ({ rows: (await pg.query(text, params as any[])).rows as any[] }), batch: (stmts) => pg.transaction(async (tx) => { for (const x of stmts) await tx.query(x.text, x.params as any[]); }) };
const sha = (b: Buffer) => createHash("sha256").update(b).digest("hex");
const mp3 = (text: string) => Buffer.concat([Buffer.from("ID3"), createHash("sha512").update(text).digest(), Buffer.alloc(2000, 7)]);
const KEY = "a-long-enough-control-key";
const clock = { t: Date.parse("2026-10-22T20:00:00Z") };               // 2:00 PM in Denver

let files: Map<string, { bytes: Buffer; mime: string }>;
const blobs: AudioBlobs = {
  list: async () => [...files.keys()],
  set: async (hash, bytes, mime) => void files.set(hash, { bytes, mime }),
  delete: async (hash) => void files.delete(hash),
};
let site: { fail: boolean; calls: any[] };
const generate = async (body: any) => {
  site.calls.push(body);
  if (site.fail) return { status: 502, json: { error: "upstream down" } };
  if (body.textOnly) return { status: 200, json: { textOnly: true, filledIn: "Eight oh four on Green Light Radio.", raw: "Eight oh four on Green Light Radio.", textModel: "fake/writer" } };
  return { status: 200, json: { preview: true, audio: mp3(body.text).toString("base64"), mimeType: "audio/mpeg", speechModel: "fake/tts" } };
};
const deps = (): RunnerDeps => ({ db, blobs, createJit, createPgStore, now: () => clock.t, generate, sleep: async () => {} });

// Sets the hub up through its own API (a pull station with just-in-time live, one slot due now), then saves it to the database.
async function seed(): Promise<{ stationId: string; pullKey: string; slotId: string }> {
  const store = createPgStore(db);
  await store.load();
  const hub = createHub({ store, key: KEY, now: () => clock.t, generate, sleep: async () => {}, jitTickMs: 0, statusTtlMs: 0, alertPollMs: 0 });
  const server = http.createServer((req, res) => hub.handle(req, res));
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
  const base = `http://127.0.0.1:${(server.address() as any).port}`;
  const call = async (method: string, path: string, body?: unknown) => {
    const res = await fetch(base + path, { method, headers: { "x-api-key": KEY, ...(body ? { "content-type": "application/json" } : {}) }, body: body ? JSON.stringify(body) : undefined });
    return { status: res.status, json: (await res.json()) as any };
  };
  const st = await call("POST", "/stations", { name: "Green Light Radio", connection: "pull", broadcastTz: "America/Denver", machineTz: "America/Chicago", siteStationId: "green-light-radio-d6b9" });
  expect(st.status).toBe(201);
  expect((await call("PUT", `/stations/${st.json.id}/jit`, { enabled: true, shadow: false, requireApproval: false })).status).toBe(200);
  const slot = await call("POST", "/jit/slots", { stationId: st.json.id, kind: "time-check", startsAt: new Date(clock.t + 8 * 60000).toISOString(), leadSeconds: 600, personaId: "rocky-flats-7fb0ca", fallbackClipId: "evergreen-time-1" });
  expect(slot.status).toBe(201);
  await store.flush();
  hub.stop();
  server.close();
  server.closeAllConnections?.();
  return { stationId: st.json.id, pullKey: st.json.pullKey, slotId: slot.json.id };
}

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
  for (const t of ["hub_stations", "hub_playlists", "hub_jobs", "hub_audit", "hub_jit_slots", "hub_jit_items", "hub_jit_queue", "hub_alert_watches", "hub_alert_log", "hub_state", "hub_locks"]) await pg.exec(`delete from ${t}`);
  files = new Map();
  site = { fail: false, calls: [] };
  clock.t = Date.parse("2026-10-22T20:00:00Z");
});

describe("tick", () => {
  it("finds the slot whose time has come and hands it to a background run, once it is running not again", async () => {
    const { slotId } = await seed();
    const sent: string[] = [];
    const r = await runTick(deps(), async (id) => void sent.push(id));
    expect(r).toMatchObject({ due: [slotId], dispatched: [slotId], failed: [] });
    expect(sent).toEqual([slotId]);
    expect(site.calls).toEqual([]);                                  // the tick itself writes and speaks nothing
    await acquireLock(db, `slot:${slotId}`, "worker", 60_000);       // a run for it is under way
    expect((await runTick(deps(), async (id) => void sent.push(id))).due).toEqual([]);
  });

  it("does nothing before the lead time, and skips when another tick holds the lock", async () => {
    await seed();
    clock.t -= 30 * 60_000;
    expect((await runTick(deps(), async () => {})).due).toEqual([]);
    clock.t += 30 * 60_000;
    await acquireLock(db, "jit-tick", "someone-else", 60_000);
    expect(await runTick(deps(), async () => {})).toMatchObject({ skipped: "locked" });
  });

  it("reports a slot it could not hand over", async () => {
    const { slotId } = await seed();
    const r = await runTick(deps(), async () => { throw new Error("502"); });
    expect(r).toMatchObject({ due: [slotId], dispatched: [], failed: [slotId] });
  });
});

describe("one slot", () => {
  it("writes and speaks the line, stores the audio, and queues it for the station to pull", async () => {
    const { slotId, stationId, pullKey } = await seed();
    const out = await runSlot(deps(), slotId);
    expect(out.state).toBe("queued");
    expect(site.calls.map((c) => !!c.textOnly)).toEqual([true, false]);

    const hash = sha(mp3("Eight oh four on Green Light Radio."));
    expect([...files.keys()]).toEqual([hash]);                       // audio is stored before the records that point to it
    expect(files.get(hash)!.mime).toBe("audio/mpeg");
    const q = (await pg.query("select doc from hub_jit_queue")).rows as any[];
    expect(q).toHaveLength(1);
    expect(q[0].doc).toMatchObject({ stationId, state: "queued", audioHash: hash, replace: "evergreen-time-1" });
    expect((await pg.query("select count(*)::int as n from hub_locks")).rows[0]).toEqual({ n: 0 });   // every lock given back

    // and the station can fetch it through the pull calls
    const pull = (path: string) => handleHubPull(new Request(`https://site.test${path}`, { headers: { "x-api-key": pullKey } }), async (h) => (files.get(h)?.bytes ? new Uint8Array(files.get(h)!.bytes).buffer : null), clock.t);
    const queue = (await (await pull(`/api/pull/stations/${stationId}/queue`)).json()) as any;
    expect(queue.items.map((i: any) => i.sha256)).toEqual([hash]);
    const audio = await pull(`/api/pull/stations/${stationId}/queue/${queue.items[0].id}/audio`);
    expect(audio.status).toBe(200);
    expect(Buffer.from(await audio.arrayBuffer()).equals(mp3("Eight oh four on Green Light Radio."))).toBe(true);

    expect((await runTick(deps(), async () => {})).due).toEqual([]);   // it has its item now
  });

  it("fails open: when the site cannot write the line, nothing is queued and the planned clip stays", async () => {
    const { slotId } = await seed();
    site.fail = true;
    const out = await runSlot(deps(), slotId);
    expect(out.state).toBe("fallback");
    expect((await pg.query("select count(*)::int as n from hub_jit_queue")).rows[0]).toEqual({ n: 0 });
    expect(files.size).toBe(0);
  });

  it("leaves the slot for the next tick when another run is working", async () => {
    const { slotId } = await seed();
    await acquireLock(db, "jit-work", "other", 60_000);
    expect(await runSlot(deps(), slotId)).toEqual({ skipped: "busy" });
    expect(site.calls).toEqual([]);
    await releaseLock(db, "jit-work", "other");
    expect((await runSlot(deps(), slotId)).state).toBe("queued");
  });

  it("says when the slot is gone", async () => {
    await seed();
    expect(await runSlot(deps(), "no-such-slot")).toEqual({ skipped: "gone" });
  });

  it("the same text is the same clip: a second slot reuses the stored audio", async () => {
    const { stationId, slotId } = await seed();
    await runSlot(deps(), slotId);
    const store = createPgStore(db);
    await store.load();
    const first = store.data.jit.slots[0];
    store.data.jit.slots.push({ ...first, id: "second-slot", startsAt: first.startsAt + 60_000 });
    await store.flush();
    site.calls.length = 0;
    const out = await runSlot(deps(), "second-slot");
    expect(out.state).toBe("queued");
    expect(site.calls.filter((c) => !c.textOnly)).toEqual([]);       // no second speech request
    expect(files.size).toBe(1);
    expect((await pg.query("select count(*)::int as n from hub_jit_queue where doc->>'stationId' = $1", [stationId])).rows[0]).toEqual({ n: 2 });
  });
});
