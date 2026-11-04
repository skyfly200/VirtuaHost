import { randomUUID } from "node:crypto";
import type { HubDb } from "./db.js";
import type { AudioBlobs, RunAudio } from "./audio.js";
import { openAudio } from "./audio.js";
import type { HubModules, HubStore } from "./jit-cjs.js";
import { acquireLock, heldLocks, releaseLock } from "./locks.js";

// The hub's just-in-time drops as serverless runs. The logic is the hub's own jit.js, run on the Postgres store: load the hub's records,
// do the work, write back what changed. Two kinds of run:
//   tick      every minute, within a scheduled function's 30 seconds: expire clips nobody picked up, tidy old records, and find the slots whose
//             time has come. It does NOT write or speak anything; it hands each due slot to a background run.
//   one slot  in a background function (up to 15 minutes): write the line, check it, speak it, and queue it (or hold it for approval).
// Locks keep runs apart. Only one slot run goes at a time ("jit-work"): jit's counters and cache are shared records, and two runs
// saving them together would lose one's changes. A slot that finds the lock taken is simply picked up by the next tick.

export const TICK_LOCK_MS = 25_000;
export const WORK_LOCK_MS = 14 * 60_000;
const MODE_FRESH_MS = 10 * 60_000;
const AUDIT_KEEP = 3000;

export interface RunnerDeps extends HubModules {
  db: HubDb;
  blobs: AudioBlobs;
  now?: () => number;
  siteUrl?: string;
  siteKey?: string;
  generate?: (body: unknown, apiPath: string) => Promise<unknown>;
  fetchImpl?: typeof fetch;
  sleep?: (ms: number) => Promise<void>;
}

/* eslint-disable @typescript-eslint/no-explicit-any */
async function open(deps: RunnerDeps) {
  const now = deps.now ?? Date.now;
  const store: HubStore = deps.createPgStore(deps.db);
  await store.load();
  const audio: RunAudio = await openAudio(deps.blobs);
  const d = store.data;
  const stations = () => (d.stations ??= []) as any[];
  const audit = (entry: any) => {
    const clean = (v: unknown, n: number) => (v === undefined || v === null ? "" : String(v).replace(/(key|token|secret|password)=\S+/gi, "$1=…").slice(0, n));
    const list = (d.audit ??= []) as any[];
    list.push({ at: now(), who: clean(entry.who, 60) || "unknown", action: clean(entry.action, 60), target: clean(entry.target, 80), result: clean(entry.result, 40), detail: clean(entry.detail, 300) });
    if (list.length > AUDIT_KEEP) list.splice(0, list.length - AUDIT_KEEP);
  };
  // A pull station's mode comes from its last heartbeat (phase 2 stores it as report:<id>); a stale report counts as unknown.
  const runtime = (sid: string) => {
    const r = d[`report:${sid}`];
    const fresh = r && now() - Number(r.at) < MODE_FRESH_MS;
    return { mode: fresh && typeof r.mode === "string" ? r.mode : "unknown", lastSeen: r?.at ?? null, report: fresh ? r.report : null };
  };
  const jit = deps.createJit({
    store, audio, now, fetchImpl: deps.fetchImpl ?? fetch, siteUrl: deps.siteUrl ?? "", siteKey: deps.siteKey ?? "", generate: deps.generate ?? null,
    ...(deps.sleep ? { sleep: deps.sleep } : {}), audit,
    stations: { find: (sid: string) => stations().find((x) => x.id === sid) ?? null, list: stations, runtime },
  });
  // Audio first, then the records that point at it.
  const save = async () => {
    const files = await audio.commit();
    await store.flush();
    return files;
  };
  return { store, jit, save };
}

export interface TickResult { skipped?: "locked"; due: string[]; dispatched: string[]; failed: string[] }

/** One tick. `dispatch` starts a background run for a slot id (it should return once the run is accepted, not finished). */
export async function runTick(deps: RunnerDeps, dispatch: (slotId: string) => Promise<void>): Promise<TickResult> {
  const owner = randomUUID();
  if (!(await acquireLock(deps.db, "jit-tick", owner, TICK_LOCK_MS))) return { skipped: "locked", due: [], dispatched: [], failed: [] };
  try {
    const { jit, save } = await open(deps);
    jit.sweepQueue();
    jit.gc();
    await save();
    const working = new Set((await heldLocks(deps.db, "slot:")).map((n) => n.slice("slot:".length)));
    const due = jit.dueSlots().map((s) => s.id).filter((id) => !working.has(id));
    const settled = await Promise.allSettled(due.map((id) => dispatch(id)));
    return { due, dispatched: due.filter((_, i) => settled[i].status === "fulfilled"), failed: due.filter((_, i) => settled[i].status === "rejected") };
  } finally {
    await releaseLock(deps.db, "jit-tick", owner);
  }
}

export interface SlotResult { skipped?: "busy" | "gone"; state?: string; reason?: string }

/** One slot, start to finish. Never throws for a slot's own failure: jit records a reason and the planned clip plays. */
export async function runSlot(deps: RunnerDeps, slotId: string): Promise<SlotResult> {
  const owner = randomUUID();
  if (!(await acquireLock(deps.db, "jit-work", owner, WORK_LOCK_MS))) return { skipped: "busy" };
  try {
    await acquireLock(deps.db, `slot:${slotId}`, owner, WORK_LOCK_MS);
    const { store, jit, save } = await open(deps);
    const slot = (store.data.jit?.slots ?? []).find((s: any) => s.id === slotId);
    if (!slot) return { skipped: "gone" };
    const item = await jit.processSlot(slot);
    await save();
    return { state: item?.state, reason: item?.reason };
  } finally {
    await releaseLock(deps.db, `slot:${slotId}`, owner);
    await releaseLock(deps.db, "jit-work", owner);
  }
}
