import { getStore } from "@netlify/blobs";
import type { Schedule } from "./schedule.js";

// Strong consistency: a read right after a save returns the saved version, not the one from before (Blobs is otherwise eventually consistent).
const store = () => getStore({ name: "dj-schedules", consistency: "strong" });
const key = (id: string) => `schedules/${id}.json`;

export async function listSchedules(): Promise<Schedule[]> {
  const { blobs } = await store().list({ prefix: "schedules/" });
  const all = (await Promise.all(blobs.map(({ key: k }) => store().get(k, { type: "json" }) as Promise<Schedule | null>))).filter((s): s is Schedule => Boolean(s));
  return all.sort((a, b) => (a.nextAt ?? "9999").localeCompare(b.nextAt ?? "9999"));
}
export const getSchedule = async (id: string): Promise<Schedule | null> => ((await store().get(key(id), { type: "json" })) as Schedule | null) ?? null;
export const saveSchedule = async (s: Schedule): Promise<void> => { await store().setJSON(key(s.id), s); };
export const deleteSchedule = async (id: string): Promise<void> => { await store().delete(key(id)); };
