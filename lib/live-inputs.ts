// Live inputs: what is true about the station's area right now (weather, NWS alerts, road-ice risk). Two uses:
//  1. liveHelp(): a short "right now" block given to the AI writer, so a drop is written to fit conditions (placeholders stay for
//     values that change between writing and air time).
//  2. evalCondition(): the gate on a conditional schedule ("only when ice is likely on Left Hand Canyon Drive").
// Road risk is DERIVED from weather at a road's point (freezing temperature with precipitation, snow, freezing rain): it is not a
// road-sensor or DOT feed, and it says so. Weather is Open-Meteo, alerts are api.weather.gov; neither verified against the live service.
// Anything unreachable gives "unknown", and a condition on something unknown is NOT met (fail closed).
import { activeAlerts, SEVERITIES, type NwsAlert, type Severity } from "./alerts.js";
import { locate } from "./geo.js";
import { conditionsFor } from "./drop-template.js";
import type { Station } from "./station-profile.js";

export type Risk = "none" | "watch" | "high";
export const RISKS: readonly Risk[] = ["none", "watch", "high"];
export interface Sample { tempC: number; precipMm: number; snowCm: number; code: number; nextHoursMinC?: number; nextHoursPrecipMm?: number }
export interface RoadRisk { road: string; risk: Risk; why: string; sample: Sample | null }
export interface Live { at: number; weather: Sample | null; alerts: NwsAlert[]; roads: RoadRisk[] }

const SNOW_CODES = new Set([71, 73, 75, 77, 85, 86]);
const FREEZING_CODES = new Set([56, 57, 66, 67]);
const WET_CODES = (c: number) => (c >= 51 && c <= 67) || (c >= 80 && c <= 82) || c >= 95;

/** Pure rule: ice/snow risk from a weather sample. */
export function assessRisk(s: Sample | null): { risk: Risk; why: string } {
  if (!s) return { risk: "none", why: "no weather data" };
  const minT = Math.min(s.tempC, s.nextHoursMinC ?? s.tempC);
  const wet = s.precipMm > 0 || s.snowCm > 0 || WET_CODES(s.code) || SNOW_CODES.has(s.code) || (s.nextHoursPrecipMm ?? 0) > 0;
  if (FREEZING_CODES.has(s.code)) return { risk: "high", why: "freezing rain or drizzle" };
  if (s.snowCm > 0 || SNOW_CODES.has(s.code)) return { risk: minT <= 1 ? "high" : "watch", why: "snow falling" };
  if (minT <= 0 && wet) return { risk: "high", why: "precipitation with temperatures at or below freezing" };
  if (minT <= 3 && wet) return { risk: "watch", why: "precipitation with temperatures near freezing" };
  if (minT <= -2 && s.tempC <= 0) return { risk: "watch", why: "hard freeze, frost or leftover ice possible" };
  return { risk: "none", why: "no ice or snow signal" };
}

const cache = new Map<string, { at: number; value: Sample | null }>();
const TTL_MS = 10 * 60_000;
export const resetLiveCache = (): void => cache.clear();

async function sampleAt(lat: number, lon: number): Promise<Sample | null> {
  const key = `${lat.toFixed(3)},${lon.toFixed(3)}`;
  const hit = cache.get(key);
  if (hit && Date.now() - hit.at < TTL_MS) return hit.value;
  let value: Sample | null = null;
  try {
    const res = await fetch(`https://api.open-meteo.com/v1/forecast?latitude=${lat}&longitude=${lon}&current=temperature_2m,precipitation,snowfall,weather_code&hourly=temperature_2m,precipitation&forecast_hours=4&temperature_unit=celsius`, { signal: AbortSignal.timeout(4_000) });
    const b = (await res.json()) as { current?: Record<string, number>; hourly?: { temperature_2m?: number[]; precipitation?: number[] } };
    const c = b.current;
    if (c && typeof c.temperature_2m === "number" && typeof c.weather_code === "number") {
      const t = (b.hourly?.temperature_2m ?? []).filter((n) => typeof n === "number");
      const p = (b.hourly?.precipitation ?? []).filter((n) => typeof n === "number");
      value = { tempC: c.temperature_2m, precipMm: c.precipitation ?? 0, snowCm: c.snowfall ?? 0, code: c.weather_code, ...(t.length ? { nextHoursMinC: Math.min(...t) } : {}), ...(p.length ? { nextHoursPrecipMm: p.reduce((a, n) => a + n, 0) } : {}) };
    }
  } catch { value = null; }
  cache.set(key, { at: Date.now(), value });
  return value;
}

/** Everything live for a station: its own weather, active alerts, and one risk per key road. Never throws. */
export async function liveFor(station: Station | null | undefined, now = Date.now()): Promise<Live> {
  const live: Live = { at: now, weather: null, alerts: [], roads: [] };
  if (!station) return live;
  const where = await locate(station);
  live.weather = where ? await sampleAt(where.lat, where.lon) : null;
  live.alerts = await activeAlerts(station);
  for (const r of station.context?.roads ?? []) {
    const s = r.lat !== undefined && r.lon !== undefined ? await sampleAt(r.lat, r.lon) : live.weather;
    const a = assessRisk(s);
    live.roads.push({ road: r.name, ...a, sample: s });
  }
  if (!live.roads.length) { const a = assessRisk(live.weather); live.roads.push({ road: "roads in the area", ...a, sample: live.weather }); }
  return live;
}

const f = (c: number, unit: "F" | "C") => Math.round(unit === "F" ? (c * 9) / 5 + 32 : c);

/** The "right now" block for the writer. Empty when nothing is known. */
export function liveHelp(live: Live, unit: "F" | "C" = "F"): string {
  const out: string[] = [];
  if (live.weather) out.push(`weather ${f(live.weather.tempC, unit)} degrees ${unit}, ${conditionsFor(live.weather.code)}`);
  if (live.alerts.length) out.push(`active National Weather Service alerts: ${live.alerts.slice(0, 3).map((a) => `${a.event} (${a.severity}) for ${a.area}${a.expires ? `, until ${new Date(a.expires).toISOString()}` : ""}`).join("; ")}`);
  const risky = live.roads.filter((r) => r.risk !== "none");
  if (risky.length) out.push(`road ice/snow risk (estimated from the weather, not a road sensor): ${risky.map((r) => `${r.road} ${r.risk} (${r.why})`).join("; ")}`);
  else if (live.weather) out.push("no ice or snow risk on the roads right now");
  if (!out.length) return "";
  return `Right now (use only these facts, never invent conditions, and do not claim road closures or crashes): ${out.join(". ")}. Write the line to fit these conditions. If a value could change before the line airs, use a placeholder instead of a number.`;
}

// ---------- conditions ----------
export type Condition =
  | { kind: "alert"; /** Match any of these event names (case-insensitive, partial); empty = any alert. */ events?: string[]; minSeverity?: Severity }
  | { kind: "road-risk"; /** A key road's name; omitted = any road. */ road?: string; min: Exclude<Risk, "none"> }
  | { kind: "temp"; op: "below" | "above"; /** In the station's unit. */ value: number }
  | { kind: "precip" };

export interface Gate { condition: Condition; /** At least this long between runs. */ cooldownMinutes: number; /** Log "would run" and make nothing. */ dryRun: boolean }
export const DEFAULT_COOLDOWN = 180;

const rank = (r: Risk) => RISKS.indexOf(r);

/** Does the condition hold? `reason` explains it either way (kept in the schedule's last result). */
export function evalCondition(c: Condition, live: Live, unit: "F" | "C" = "F"): { met: boolean; reason: string } {
  if (c.kind === "alert") {
    const min = c.minSeverity ? SEVERITIES.indexOf(c.minSeverity) : 0;
    const hit = live.alerts.find((a) => SEVERITIES.indexOf(a.severity) >= min && (!c.events?.length || c.events.some((e) => a.event.toLowerCase().includes(e.toLowerCase()))));
    return hit ? { met: true, reason: `${hit.event} (${hit.severity})` } : { met: false, reason: "no matching alert" };
  }
  if (c.kind === "road-risk") {
    const roads = c.road ? live.roads.filter((r) => r.road.toLowerCase() === c.road!.toLowerCase()) : live.roads;
    const hit = roads.find((r) => rank(r.risk) >= rank(c.min));
    return hit ? { met: true, reason: `${hit.road}: ${hit.risk}, ${hit.why}` } : { met: false, reason: roads.length ? "road risk below the threshold" : "that road is not on the station's list" };
  }
  if (!live.weather) return { met: false, reason: "weather unavailable" };
  if (c.kind === "temp") {
    const t = f(live.weather.tempC, unit);
    const met = c.op === "below" ? t <= c.value : t >= c.value;
    return { met, reason: `${t} degrees ${unit}, wanted ${c.op} ${c.value}` };
  }
  const wet = live.weather.precipMm > 0 || live.weather.snowCm > 0 || WET_CODES(live.weather.code) || SNOW_CODES.has(live.weather.code);
  return { met: wet, reason: wet ? conditionsFor(live.weather.code) : "dry" };
}

export function sanitizeGate(raw: unknown): Gate | undefined {
  if (!raw || typeof raw !== "object") return undefined;
  const g = raw as Record<string, unknown>;
  const c = (g.condition && typeof g.condition === "object" ? g.condition : {}) as Record<string, unknown>;
  const s = (v: unknown, n: number) => (typeof v === "string" ? v.trim().slice(0, n) : "");
  let condition: Condition;
  if (c.kind === "alert") {
    const events = (Array.isArray(c.events) ? c.events : typeof c.events === "string" ? c.events.split(",") : []).map((e) => s(e, 60)).filter(Boolean).slice(0, 10);
    condition = { kind: "alert", ...(events.length ? { events } : {}), ...((SEVERITIES as readonly string[]).includes(String(c.minSeverity)) ? { minSeverity: c.minSeverity as Severity } : {}) };
  } else if (c.kind === "road-risk") {
    condition = { kind: "road-risk", min: c.min === "high" ? "high" : "watch", ...(s(c.road, 80) ? { road: s(c.road, 80) } : {}) };
  } else if (c.kind === "temp") {
    const v = Number(c.value);
    if (!Number.isFinite(v) || v < -80 || v > 150) throw new Error("Enter a temperature for the condition");
    condition = { kind: "temp", op: c.op === "above" ? "above" : "below", value: v };
  } else if (c.kind === "precip") {
    condition = { kind: "precip" };
  } else throw new Error('A condition must be alert, road-risk, temp or precip');
  const cool = Math.floor(Number(g.cooldownMinutes));
  return { condition, cooldownMinutes: Number.isFinite(cool) ? Math.min(Math.max(cool, 0), 60 * 24 * 7) : DEFAULT_COOLDOWN, dryRun: g.dryRun !== false };   // dry run unless switched off on purpose
}
