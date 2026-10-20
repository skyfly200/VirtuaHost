import { createHash, timingSafeEqual } from "node:crypto";
import { MIN_KEY_LENGTH } from "./auth.js";

// The station daemon's own key (STATION_KEY), separate from user logins and the machine ACCESS_KEY: it can fetch queued
// clips and report back, nothing else. Sent as `x-station-key` or a Bearer token.
const digest = (value: string) => createHash("sha256").update(value).digest();

export function checkStationAuth(req: Request): Response | null {
  const key = process.env.STATION_KEY ?? "";
  if (key.length < MIN_KEY_LENGTH) {
    return Response.json({ error: `STATION_KEY is not set (at least ${MIN_KEY_LENGTH} characters, for example from "openssl rand -hex 24")` }, { status: 503 });
  }
  const given = req.headers.get("x-station-key") ?? req.headers.get("authorization")?.replace(/^Bearer\s+/i, "") ?? "";
  if (!given || !timingSafeEqual(digest(given), digest(key))) return Response.json({ error: "Unauthorized" }, { status: 401 });
  return null;
}
