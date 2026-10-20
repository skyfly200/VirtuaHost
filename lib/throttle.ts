import { createHash } from "node:crypto";
import { getStore } from "@netlify/blobs";

// Slows down password guessing: after MAX_FAILURES wrong logins from one address within the window, further attempts are
// refused until it passes. Counts live in Netlify Blobs because functions keep no memory between calls. If Blobs is not
// available (for example a local run that is not linked to a site) the throttle is skipped rather than blocking logins.
export const MAX_FAILURES = 8;
export const WINDOW_MS = 10 * 60_000;

interface Attempts {
  failures: number[];
}

const keyFor = (ip: string) => `ip/${createHash("sha256").update(ip).digest("hex").slice(0, 32)}`;

async function read(ip: string): Promise<number[]> {
  const found = (await getStore("auth").get(keyFor(ip), { type: "json" })) as Attempts | null;
  return (found?.failures ?? []).filter((t) => Date.now() - t < WINDOW_MS);
}

export async function isBlocked(ip: string): Promise<boolean> {
  try {
    return (await read(ip)).length >= MAX_FAILURES;
  } catch {
    return false;
  }
}

export async function recordFailure(ip: string): Promise<void> {
  try {
    const failures = [...(await read(ip)), Date.now()];
    await getStore("auth").setJSON(keyFor(ip), { failures } satisfies Attempts);
  } catch {
    // no Blobs: no throttle
  }
}

export async function clearFailures(ip: string): Promise<void> {
  try {
    await getStore("auth").delete(keyFor(ip));
  } catch {
    // no Blobs: nothing to clear
  }
}
