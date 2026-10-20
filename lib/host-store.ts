import { getStore } from "@netlify/blobs";
import { HOST_DEFAULTS, hostDefaultsFor, type HostConfig } from "./host.js";
import { STATION_ID, type Station } from "./station-profile.js";

// The virtual host's settings and last status are kept per station: each profile has its own ("default" is the placeholder station).
const store = () => getStore("dj-host");
export const hostKey = (stationId?: string) => (stationId && STATION_ID.test(stationId) ? stationId : "default");

export async function getHostConfig(station?: Pick<Station, "id"> | null): Promise<HostConfig> {
  const id = hostKey(station?.id);
  let saved = (await store().get(`config/${id}.json`, { type: "json" })) as Partial<HostConfig> | null;
  if (!saved && id === "default") saved = (await store().get("config.json", { type: "json" })) as Partial<HostConfig> | null;   // from before settings were per station
  return { ...HOST_DEFAULTS, ...hostDefaultsFor(station as Station | null), ...(saved ?? {}) };
}
export async function saveHostConfig(config: HostConfig, stationId?: string): Promise<void> {
  await store().setJSON(`config/${hostKey(stationId)}.json`, config);
}

// What the station daemon last reported about itself, so the site can show the host's state.
export interface HostStatus {
  reportedAt: string;
  current?: { artist: string; title: string };
  ready?: { text: string; about: string; source: string };
  last?: { at: string; text: string; about: string; played: boolean; reason?: string };
  counters?: { prepared: number; played: number; skipped: number; failed: number };
  error?: string;
}
export async function getHostStatus(stationId?: string): Promise<HostStatus | null> {
  const id = hostKey(stationId);
  const found = (await store().get(`status/${id}.json`, { type: "json" })) as HostStatus | null;
  if (found) return found;
  return id === "default" ? (((await store().get("status.json", { type: "json" })) as HostStatus | null) ?? null) : null;
}
export async function saveHostStatus(status: Omit<HostStatus, "reportedAt">, stationId?: string): Promise<void> {
  await store().setJSON(`status/${hostKey(stationId)}.json`, { ...status, reportedAt: new Date().toISOString() });
}
