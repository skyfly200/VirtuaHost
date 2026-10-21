import type { Principal } from "./auth.js";
import { runWithScope } from "./credentials.js";
import { resolveScope } from "./provider-keys.js";

/** Runs `fn` with the provider keys and model limits that apply to this person and station (see lib/credentials.ts). */
export async function withKeys<T>(who: Pick<Principal, "username"> | { username?: string }, stationId: string | undefined, fn: () => Promise<T>): Promise<T> {
  return runWithScope(await resolveScope(who.username, stationId), fn);
}

/** The station a request names, read without consuming the body: `?station=` or a JSON body's `station`. */
export async function stationOf(req: Request): Promise<string | undefined> {
  const fromQuery = new URL(req.url).searchParams.get("station");
  if (fromQuery) return fromQuery;
  if (!(req.headers.get("content-type") ?? "").includes("json")) return undefined;
  const body = (await req.clone().json().catch(() => null)) as { station?: unknown } | null;
  return typeof body?.station === "string" ? body.station : undefined;
}
