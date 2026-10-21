import { locate } from "./geo.js";
import type { Station } from "./station-profile.js";

// Active US weather alerts for a station's location, from the National Weather Service (api.weather.gov: free, no key; it asks for a
// User-Agent that says who you are, so set ALERTS_CONTACT). Used for the {{alert}} placeholders and GET /api/alerts. The hub
// (chips-voice/hub/alerts.js) is what can AIR them. This relays what the NWS publishes: it is not the Emergency Alert System (docs/ALERTS.md).
// NOT verified against the live service: the shapes follow the api.weather.gov GeoJSON documentation.
export const SEVERITIES = ["Unknown", "Minor", "Moderate", "Severe", "Extreme"] as const;
export type Severity = (typeof SEVERITIES)[number];
export interface NwsAlert { id: string; event: string; severity: Severity; headline: string; area: string; instruction: string; expires: number | null; sent: number | null }

const rank = (s: string) => Math.max(0, SEVERITIES.indexOf(s as Severity));
const clean = (v: unknown, max: number): string => (typeof v === "string" ? v.replace(/[\u0000-\u001f\u007f]/g, " ").replace(/\s+/g, " ").trim().slice(0, max) : "");

export function normalizeAlert(feature: { properties?: Record<string, unknown> }, now = Date.now()): NwsAlert | null {
  const p = feature.properties ?? {};
  if (p.status && p.status !== "Actual") return null;                      // never relay Test or Exercise alerts
  if (p.messageType === "Cancel") return null;
  const expires = Date.parse(String(p.ends || p.expires || ""));
  if (Number.isFinite(expires) && expires <= now) return null;
  const id = clean(p.id, 200);
  if (!id) return null;
  return {
    id, event: clean(p.event, 80), severity: (SEVERITIES as readonly string[]).includes(String(p.severity)) ? (p.severity as Severity) : "Unknown",
    headline: clean(p.headline, 300), area: clean(p.areaDesc, 300), instruction: clean(p.instruction, 1000),
    expires: Number.isFinite(expires) ? expires : null, sent: Date.parse(String(p.sent || "")) || null,
  };
}

const cache = new Map<string, { at: number; alerts: NwsAlert[] }>();
const TTL_MS = 60_000;
export const resetAlertCache = (): void => cache.clear();

/** Active alerts at the station's location, most serious first, at least `minSeverity` (default Moderate). Never throws: no location or an outage gives []. */
export async function activeAlerts(station: Station | null | undefined, minSeverity: Severity = (process.env.ALERT_MIN_SEVERITY as Severity) || "Moderate"): Promise<NwsAlert[]> {
  if (!station) return [];
  const where = await locate(station);
  if (!where) return [];
  const key = `${where.lat},${where.lon}`;
  let alerts = cache.get(key);
  if (!alerts || Date.now() - alerts.at > TTL_MS) {
    let found: NwsAlert[] = [];
    try {
      const res = await fetch(`https://api.weather.gov/alerts/active?point=${encodeURIComponent(key)}`, {
        headers: { accept: "application/geo+json", "user-agent": `(${process.env.STATION_NAME || "VirtuaHost"}, ${process.env.ALERTS_CONTACT || "set ALERTS_CONTACT"})` },
        signal: AbortSignal.timeout(5_000),
      });
      const body = (await res.json()) as { features?: Array<{ properties?: Record<string, unknown> }> };
      found = (body.features ?? []).flatMap((f) => { const a = normalizeAlert(f); return a ? [a] : []; });
    } catch {
      found = [];                                                          // no alerts known: placeholders use their fallback
    }
    alerts = { at: Date.now(), alerts: found };
    cache.set(key, alerts);
  }
  return alerts.alerts.filter((a) => rank(a.severity) >= rank(minSeverity)).sort((a, b) => rank(b.severity) - rank(a.severity) || (a.expires ?? 0) - (b.expires ?? 0));
}
