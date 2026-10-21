import { getStore } from "@netlify/blobs";
import type { Principal } from "./auth.js";
import { getUser, type Quota } from "./user-store.js";

// Per-person limits so one account cannot spend the whole AI budget or fill the storage.
//   AI requests per day / month   counted when a request that calls the AI provider is accepted (a failed provider call still counts)
//   clips / schedules             counted from what the person currently owns
// A user's own limits (set by an admin in the Users tab) win; otherwise the site defaults apply; otherwise there is no limit.
// Admins and the machine ACCESS_KEY are never limited. Days and months are UTC. The counters are plain read-then-write on Blobs,
// so two simultaneous requests can both slip under a limit by one; that is fine for cost control, not for billing.
//
//   QUOTA_DAILY_AI, QUOTA_MONTHLY_AI, QUOTA_MAX_CLIPS, QUOTA_MAX_SCHEDULES   defaults for people with no limits of their own
export type QuotaKind = keyof Quota;

const ENV: Record<QuotaKind, string> = { dailyAi: "QUOTA_DAILY_AI", monthlyAi: "QUOTA_MONTHLY_AI", maxClips: "QUOTA_MAX_CLIPS", maxSchedules: "QUOTA_MAX_SCHEDULES" };

export function siteDefaults(): Quota {
  const out: Quota = {};
  for (const kind of Object.keys(ENV) as QuotaKind[]) {
    const n = Number(process.env[ENV[kind]]);
    if (process.env[ENV[kind]] && Number.isInteger(n) && n >= 0) out[kind] = n;
  }
  return out;
}

export const effectiveQuota = (own: Quota | undefined): Quota => ({ ...siteDefaults(), ...(own ?? {}) });

/** Cleans quota input from the admin form: whole numbers >= 0; null or "" clears a limit (back to the default). */
export function sanitizeQuota(raw: unknown): Quota | { error: string } {
  if (!raw || typeof raw !== "object") return {};
  const out: Quota = {};
  for (const kind of Object.keys(ENV) as QuotaKind[]) {
    const v = (raw as Record<string, unknown>)[kind];
    if (v === undefined || v === null || v === "") continue;
    const n = typeof v === "number" ? v : Number(v);
    if (!Number.isInteger(n) || n < 0 || n > 1_000_000) return { error: `${kind} must be a whole number from 0 to 1000000, or empty for the default` };
    out[kind] = n;
  }
  return out;
}

const store = () => getStore("usage");
const day = (now = new Date()) => now.toISOString().slice(0, 10);
const month = (now = new Date()) => now.toISOString().slice(0, 7);
const keyFor = (username: string, period: string) => `ai/${username}/${period}`;

async function limitsFor(who: Principal): Promise<Quota | null> {
  if (who.role === "admin") return null;                        // unlimited
  return effectiveQuota((await getUser(who.username))?.quota);
}

export async function aiUsage(username: string): Promise<{ daily: number; monthly: number }> {
  const [daily, monthly] = await Promise.all([store().get(keyFor(username, day()), { type: "json" }), store().get(keyFor(username, month()), { type: "json" })]);
  return { daily: Number((daily as { n?: number } | null)?.n ?? 0), monthly: Number((monthly as { n?: number } | null)?.n ?? 0) };
}

const tooMany = (message: string) => Response.json({ error: message, quota: true }, { status: 429 });

/** Call before spending an AI request. Returns the 429 response to send when the person is over a limit, otherwise counts the request. */
export async function chargeAi(who: Principal): Promise<Response | null> {
  try {
    const limits = await limitsFor(who);
    if (!limits || (limits.dailyAi === undefined && limits.monthlyAi === undefined)) return null;
    const used = await aiUsage(who.username);
    if (limits.dailyAi !== undefined && used.daily >= limits.dailyAi) return tooMany(`Daily limit reached (${limits.dailyAi} AI requests a day). It resets at midnight UTC.`);
    if (limits.monthlyAi !== undefined && used.monthly >= limits.monthlyAi) return tooMany(`Monthly limit reached (${limits.monthlyAi} AI requests a month). It resets on the 1st (UTC).`);
    await Promise.all([store().setJSON(keyFor(who.username, day()), { n: used.daily + 1 }), store().setJSON(keyFor(who.username, month()), { n: used.monthly + 1 })]);
    return null;
  } catch {
    return null;                                                // no Blobs (local run): no quota
  }
}

/** Call before creating a clip or schedule; `current` counts what the person already has (only called when a limit applies). */
export async function checkCount(who: Principal, kind: "maxClips" | "maxSchedules", current: () => Promise<number>): Promise<Response | null> {
  try {
    const limit = (await limitsFor(who))?.[kind];
    if (limit !== undefined && (await current()) >= limit) return tooMany(`You can keep at most ${limit} ${kind === "maxClips" ? "clips" : "schedules"}. Delete one first, or ask an admin to raise your limit.`);
    return null;
  } catch {
    return null;
  }
}
