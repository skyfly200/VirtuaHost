import { getStore } from "@netlify/blobs";
import { HOST_DEFAULTS, type HostConfig } from "./host.js";

const store = () => getStore("dj-host");

export async function getHostConfig(): Promise<HostConfig> {
  const saved = (await store().get("config.json", { type: "json" })) as Partial<HostConfig> | null;
  return { ...HOST_DEFAULTS, ...(saved ?? {}) };
}
export async function saveHostConfig(config: HostConfig): Promise<void> {
  await store().setJSON("config.json", config);
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
export async function getHostStatus(): Promise<HostStatus | null> {
  return ((await store().get("status.json", { type: "json" })) as HostStatus | null) ?? null;
}
export async function saveHostStatus(status: Omit<HostStatus, "reportedAt">): Promise<void> {
  await store().setJSON("status.json", { ...status, reportedAt: new Date().toISOString() });
}
