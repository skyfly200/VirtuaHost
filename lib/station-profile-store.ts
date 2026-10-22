import { getStore } from "@netlify/blobs";
import { randomBytes } from "node:crypto";
import { defaultStation, slugifyStation, STATION_ID, type Station } from "./station-profile.js";

// Strong consistency: a read right after a save returns the saved version, not the one from before (Blobs is otherwise eventually consistent).
const store = () => getStore({ name: "dj-stations", consistency: "strong" });
const key = (id: string) => `stations/${id}.json`;

// The stations you made; or the one default station (named from STATION_NAME) when there are none yet.
export async function listStations(): Promise<Station[]> {
  const { blobs } = await store().list({ prefix: "stations/" });
  const stored = (await Promise.all(blobs.map(({ key: k }) => store().get(k, { type: "json" }) as Promise<Station | null>))).filter((s): s is Station => Boolean(s));
  stored.sort((a, b) => a.name.localeCompare(b.name));
  return stored.length ? stored : [defaultStation()];
}

export async function getStation(id: string | undefined): Promise<Station | null> {
  if (!id) return null;
  if (id === "default") return (await listStations()).find((s) => s.id === "default") ?? null;
  if (!STATION_ID.test(id)) return null;
  return ((await store().get(key(id), { type: "json" })) as Station | null) ?? null;
}

export const newStationId = (name: string): string => `${slugifyStation(name) || "station"}-${randomBytes(2).toString("hex")}`;
export async function saveStation(s: Station): Promise<void> { await store().setJSON(key(s.id), { ...s, builtin: undefined, updatedAt: new Date().toISOString() }); }
export async function deleteStation(id: string): Promise<void> { await store().delete(key(id)); }
