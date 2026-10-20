// The station queue: clips waiting to go to air, kept in Netlify Blobs. The station daemon (station-daemon/) polls the
// site, claims the oldest item, plays it and reports back, so the station needs no public address and no AI keys.
import { getStore } from "@netlify/blobs";
import { randomUUID } from "node:crypto";
import type { ClipInfo } from "./clip-info.js";
import { isExpired } from "./clip-info.js";
import type { FxSetting } from "./handoff.js";

export type QueueStatus = "queued" | "claimed" | "played" | "failed" | "skipped";

export interface QueueItem {
  id: string;
  clipId: string;
  title: string;
  /** Put it on air as soon as it arrives; otherwise the station just keeps it. */
  play: boolean;
  /** Let it cut in over a live DJ. */
  preempt: boolean;
  fx?: FxSetting;
  /** The clip's metadata, passed on to the station (and from there to Liquidsoap and other systems). */
  info?: ClipInfo;
  /** Never played after this instant; an expired item is skipped, not delivered. */
  expiresAt?: string;
  status: QueueStatus;
  createdAt: string;
  claimedAt?: string;
  doneAt?: string;
  attempts: number;
  error?: string;
}

const store = () => getStore("dj-queue");
const keyOf = (item: Pick<QueueItem, "id" | "createdAt">) => `queue/${item.createdAt}-${item.id}.json`;

export const LEASE_MS = 90_000;       // a claimed item nobody confirms within this is offered again
export const MAX_ATTEMPTS = 3;
const KEEP_DONE_MS = 24 * 3600_000;

async function all(): Promise<QueueItem[]> {
  const { blobs } = await store().list({ prefix: "queue/" });
  const items = await Promise.all(blobs.map(({ key }) => store().get(key, { type: "json" }) as Promise<QueueItem | null>));
  return items.filter((i): i is QueueItem => Boolean(i)).sort((a, b) => a.createdAt.localeCompare(b.createdAt) || a.id.localeCompare(b.id));
}

export async function enqueue(input: { clipId: string; title: string; play: boolean; preempt: boolean; fx?: FxSetting; info?: ClipInfo }): Promise<QueueItem> {
  const item: QueueItem = {
    id: randomUUID(), status: "queued", createdAt: new Date().toISOString(), attempts: 0, ...input, title: input.title.slice(0, 200),
    ...(input.info?.expiresAt ? { expiresAt: input.info.expiresAt } : {}),
  };
  await store().setJSON(keyOf(item), item);
  return item;
}

// Newest first, for the UI. Finished items older than a day are cleaned up here.
export async function listQueue(limit = 50): Promise<QueueItem[]> {
  const items = await all();
  const now = Date.now();
  const stale = items.filter((i) => i.doneAt && now - Date.parse(i.doneAt) > KEEP_DONE_MS);
  await Promise.all(stale.map((i) => store().delete(keyOf(i))));
  return items.filter((i) => !stale.includes(i)).reverse().slice(0, limit);
}

// Hands the oldest waiting item to the station. A claim whose lease ran out (the daemon died mid-clip) is offered again,
// up to MAX_ATTEMPTS, then marked failed. One daemon per station is assumed: two polling at once could claim the same item.
export async function claimNext(now = Date.now()): Promise<QueueItem | null> {
  for (const item of await all()) {
    const expired = item.status === "claimed" && item.claimedAt !== undefined && now - Date.parse(item.claimedAt) > LEASE_MS;
    if (item.status !== "queued" && !expired) continue;
    if (isExpired(item, now)) {
      await store().setJSON(keyOf(item), { ...item, status: "skipped", doneAt: new Date(now).toISOString(), error: "expired before it could play" });
      continue;
    }
    if (item.attempts >= MAX_ATTEMPTS) {
      await store().setJSON(keyOf(item), { ...item, status: "failed", doneAt: new Date(now).toISOString(), error: item.error ?? "the station never confirmed it" });
      continue;
    }
    const claimed: QueueItem = { ...item, status: "claimed", claimedAt: new Date(now).toISOString(), attempts: item.attempts + 1 };
    await store().setJSON(keyOf(claimed), claimed);
    return claimed;
  }
  return null;
}

export async function getItem(id: string): Promise<QueueItem | null> {
  return (await all()).find((i) => i.id === id) ?? null;
}

export async function finish(id: string, status: "played" | "failed" | "skipped", error?: string): Promise<QueueItem | null> {
  const item = await getItem(id);
  if (!item) return null;
  const done: QueueItem = { ...item, status, doneAt: new Date().toISOString(), ...(error ? { error: error.slice(0, 300) } : {}) };
  await store().setJSON(keyOf(done), done);
  return done;
}
