import type { Station } from "./station-profile.js";
import { activeAlerts, type NwsAlert } from "./alerts.js";
import { locate } from "./geo.js";

// Templates for drops: the writer (or you) puts placeholders like {{time}} or {{weather|nice out}} in a line, and the engine fills them
// in with real values AFTER the words are written and BEFORE they are spoken. So an AI never has to guess the time or the temperature,
// and the same line is correct whenever it is made (every schedule run is filled in fresh).
//
//   {{name}}                the value of a variable          {{time}}  ->  3:45 PM
//   {{name|fallback}}       the fallback when there is none  {{weather|a lovely day}}
//   {{pick: a | b | c}}     one of the choices, at random    {{pick: Stay tuned | Don't go anywhere}}
//
// Variable names are case-insensitive. A placeholder with no value and no fallback is removed (and reported in `missing`), and nothing
// that looks like {{...}} ever reaches the voice. Single braces ({artist}) belong to the older persona line banks and are untouched.
// Weather comes from Open-Meteo (free, no key) for the station's location. NOT verified against the live service.
export interface TemplateContext {
  now?: Date;
  /** IANA zone for times and dates: the station's, else UTC. */
  tz?: string;
  station?: Station | null;
  persona?: { name: string; tagline?: string } | null;
  /** How long the drop should run when spoken. */
  targetSeconds?: number;
  /** Song details for a host link or a song intro. */
  song?: { artist?: string; title?: string };
  rng?: () => number;
}

export type VarGroup = "station" | "time" | "weather" | "alert" | "dj" | "length" | "song" | "custom";
interface VarDef {
  name: string;
  group: VarGroup;
  description: string;
  example: string;
  /** Whether this context can supply it (checked without any network call). */
  available: (c: TemplateContext) => boolean;
  value: (c: TemplateContext, w: Weather | null, a: NwsAlert[]) => string | undefined;
}

export interface Weather { tempC: number; code: number }
const WORDS_PER_SECOND = 2.5;                                              // about 150 words a minute

// ---------- time ----------
const parts = (c: TemplateContext) => {
  const now = c.now ?? new Date();
  const tz = c.tz || c.station?.tz || "UTC";
  const f = (o: Intl.DateTimeFormatOptions) => { try { return new Intl.DateTimeFormat("en-US", { timeZone: tz, ...o }).format(now); } catch { return new Intl.DateTimeFormat("en-US", { timeZone: "UTC", ...o }).format(now); } };
  const hour24 = Number(f({ hour: "numeric", hourCycle: "h23" }));
  return { f, hour24 };
};
export const daypart = (hour24: number): "morning" | "afternoon" | "evening" | "night" => (hour24 >= 5 && hour24 < 12 ? "morning" : hour24 < 17 && hour24 >= 12 ? "afternoon" : hour24 >= 17 && hour24 < 21 ? "evening" : "night");
const GREETING = { morning: "Good morning", afternoon: "Good afternoon", evening: "Good evening", night: "Hello, night owls" } as const;

// ---------- weather ----------
const WMO: Array<[number, string]> = [[0, "clear"], [1, "mostly clear"], [2, "partly cloudy"], [3, "overcast"], [48, "foggy"], [57, "drizzling"], [65, "rainy"], [67, "freezing rain"], [77, "snowy"], [82, "showery"], [86, "snowing"], [99, "stormy"]];
export const conditionsFor = (code: number): string => (WMO.find(([max]) => code <= max) ?? [0, "unsettled"])[1];
// Fahrenheit unless told otherwise: the station's own setting first, then TEMP_UNIT (F or C) for the whole site, then Fahrenheit.
export const defaultTempUnit = (): "F" | "C" => (/^c/i.test(process.env.TEMP_UNIT?.trim() ?? "") ? "C" : "F");
const unitOf = (c: TemplateContext): "F" | "C" => c.station?.tempUnit ?? defaultTempUnit();
const tempIn = (w: Weather, unit: "F" | "C") => Math.round(unit === "F" ? (w.tempC * 9) / 5 + 32 : w.tempC);
const hasLocation = (c: TemplateContext) => Boolean(c.station && ((typeof c.station.lat === "number" && typeof c.station.lon === "number") || c.station.city));

const weatherCache = new Map<string, { at: number; value: Weather | null }>();
const WEATHER_TTL_MS = 10 * 60_000;
export const resetWeatherCache = (): void => weatherCache.clear();

export async function weatherFor(station: Station | null | undefined): Promise<Weather | null> {
  if (!station) return null;
  const key = `${station.id}|${station.lat ?? ""}|${station.lon ?? ""}|${station.city ?? ""}`;
  const hit = weatherCache.get(key);
  if (hit && Date.now() - hit.at < WEATHER_TTL_MS) return hit.value;
  let value: Weather | null = null;
  const where = await locate(station);
  if (where) {
    try {
      const res = await fetch(`https://api.open-meteo.com/v1/forecast?latitude=${where.lat}&longitude=${where.lon}&current=temperature_2m,weather_code&temperature_unit=celsius`, { signal: AbortSignal.timeout(4_000) });
      const cur = ((await res.json()) as { current?: { temperature_2m?: number; weather_code?: number } }).current;
      if (typeof cur?.temperature_2m === "number" && typeof cur.weather_code === "number") value = { tempC: cur.temperature_2m, code: cur.weather_code };
    } catch {
      value = null;                                   // no weather today: the placeholder uses its fallback or is removed
    }
  }
  weatherCache.set(key, { at: Date.now(), value });
  return value;
}

// ---------- the variables ----------
const always = () => true;
const fromStation = (key: "callsign" | "frequency" | "tagline" | "city" | "website") => (c: TemplateContext) => (c.station?.[key] as string | undefined) || undefined;

const BUILT_IN: VarDef[] = [
  { name: "station", group: "station", description: "the station's name", example: "Way High Radio", available: always, value: (c) => c.station?.name || process.env.STATION_NAME || "the station" },
  { name: "callsign", group: "station", description: "the call sign (falls back to the name)", example: "KRAP", available: always, value: (c) => c.station?.callsign || c.station?.name || process.env.STATION_NAME || undefined },
  { name: "frequency", group: "station", description: "where it is on the dial", example: "97.7 FM", available: (c) => Boolean(c.station?.frequency), value: fromStation("frequency") },
  { name: "tagline", group: "station", description: "the station's tagline", example: "Houston's underground", available: (c) => Boolean(c.station?.tagline), value: fromStation("tagline") },
  { name: "place", group: "station", description: "the station's place, as found by name (town, state)", example: "Houston, Texas", available: (c) => Boolean(c.station?.place), value: (c) => [c.station?.place?.name, c.station?.place?.admin1].filter(Boolean).join(", ") || undefined },
  { name: "state", group: "station", description: "the station's state", example: "Texas", available: (c) => Boolean(c.station?.place?.admin1), value: (c) => c.station?.place?.admin1 },
  { name: "city", group: "station", description: "the station's city", example: "Houston", available: (c) => Boolean(c.station?.city), value: fromStation("city") },
  { name: "website", group: "station", description: "the station's website", example: "krap.fm", available: (c) => Boolean(c.station?.website), value: (c) => c.station?.website?.replace(/^https?:\/\//, "").replace(/\/$/, "") },

  { name: "time", group: "time", description: "the current local time", example: "3:45 PM", available: always, value: (c) => parts(c).f({ hour: "numeric", minute: "2-digit", hour12: true }) },
  { name: "time_24", group: "time", description: "the current local time, 24-hour", example: "15:45", available: always, value: (c) => parts(c).f({ hour: "2-digit", minute: "2-digit", hourCycle: "h23" }) },
  { name: "hour", group: "time", description: "the hour, 12-hour clock, no minutes", example: "3", available: always, value: (c) => parts(c).f({ hour: "numeric", hour12: true }).replace(/\s?[AP]M$/i, "") },
  { name: "daypart", group: "time", description: "morning, afternoon, evening or night", example: "afternoon", available: always, value: (c) => daypart(parts(c).hour24) },
  { name: "greeting", group: "time", description: "a greeting for the time of day", example: "Good afternoon", available: always, value: (c) => GREETING[daypart(parts(c).hour24)] },
  { name: "weekday", group: "time", description: "the day of the week", example: "Tuesday", available: always, value: (c) => parts(c).f({ weekday: "long" }) },
  { name: "date", group: "time", description: "today's date, spoken style", example: "Tuesday, October 21", available: always, value: (c) => parts(c).f({ weekday: "long", month: "long", day: "numeric" }) },
  { name: "month", group: "time", description: "the month", example: "October", available: always, value: (c) => parts(c).f({ month: "long" }) },
  { name: "day", group: "time", description: "the day of the month", example: "21", available: always, value: (c) => parts(c).f({ day: "numeric" }) },
  { name: "year", group: "time", description: "the year", example: "2026", available: always, value: (c) => parts(c).f({ year: "numeric" }) },

  { name: "weather", group: "weather", description: "temperature and sky together", example: "62 degrees and cloudy", available: hasLocation, value: (c, w) => (w ? `${tempIn(w, unitOf(c))} degrees and ${conditionsFor(w.code)}` : undefined) },
  { name: "temp", group: "weather", description: "the temperature", example: "62 degrees", available: hasLocation, value: (c, w) => (w ? `${tempIn(w, unitOf(c))} degrees` : undefined) },
  { name: "conditions", group: "weather", description: "the sky right now", example: "cloudy", available: hasLocation, value: (_c, w) => (w ? conditionsFor(w.code) : undefined) },

  { name: "alert", group: "alert", description: "the most serious active National Weather Service alert for the station's area (empty when there is none: always give a fallback)", example: "Tornado Warning", available: hasLocation, value: (_c, _w, a) => a[0]?.event },
  { name: "alert_headline", group: "alert", description: "that alert's full NWS headline", example: "Tornado Warning issued October 21 at 4:00PM CDT until 5:00PM CDT", available: hasLocation, value: (_c, _w, a) => a[0]?.headline },
  { name: "alert_area", group: "alert", description: "the places that alert covers", example: "Harris, TX", available: hasLocation, value: (_c, _w, a) => a[0]?.area },
  { name: "alert_count", group: "alert", description: "how many alerts are active (only when there is at least one)", example: "2", available: hasLocation, value: (_c, _w, a) => (a.length ? String(a.length) : undefined) },

  { name: "dj", group: "dj", description: "the name of the DJ (persona) speaking", example: "DJ Midnight", available: (c) => Boolean(c.persona), value: (c) => c.persona?.name },
  { name: "dj_tagline", group: "dj", description: "the DJ's own tagline", example: "Your late-night friend", available: (c) => Boolean(c.persona?.tagline), value: (c) => c.persona?.tagline },

  { name: "target_seconds", group: "length", description: "how many seconds the drop should run", example: "10", available: (c) => Boolean(c.targetSeconds), value: (c) => (c.targetSeconds ? String(Math.round(c.targetSeconds)) : undefined) },
  { name: "target_words", group: "length", description: "about how many words fit in that time", example: "25", available: (c) => Boolean(c.targetSeconds), value: (c) => (c.targetSeconds ? String(Math.max(1, Math.round(c.targetSeconds * WORDS_PER_SECOND))) : undefined) },

  { name: "artist", group: "song", description: "the artist of the song just played or coming up", example: "Ada Lovelace", available: (c) => Boolean(c.song?.artist), value: (c) => c.song?.artist },
  { name: "title", group: "song", description: "the title of that song", example: "Analytical Love", available: (c) => Boolean(c.song?.title), value: (c) => c.song?.title },
];
const RESERVED = new Set(BUILT_IN.map((v) => v.name));
export const isReservedVariable = (name: string): boolean => RESERVED.has(name);
export const VARIABLE_NAME = /^[a-z][a-z0-9_]{0,29}$/;

const customVars = (c: TemplateContext): VarDef[] => Object.entries(c.station?.variables ?? {}).filter(([k]) => !RESERVED.has(k)).map(([name, v]) => ({
  name, group: "custom" as const, description: "set for this station", example: v, available: always, value: () => v,
}));
const allVars = (c: TemplateContext): VarDef[] => [...BUILT_IN, ...customVars(c)];

/** The variables this context can fill, for the UI and for the writer's instructions. */
export function availableVariables(c: TemplateContext): Array<Pick<VarDef, "name" | "group" | "description" | "example">> {
  return allVars(c).filter((v) => v.available(c)).map(({ name, group, description, example }) => ({ name, group, description, example }));
}

/** The same list with today's real values filled in (fetches the weather when the station has a location). */
export async function variableValues(c: TemplateContext): Promise<Array<{ name: string; group: VarGroup; description: string; example: string; value: string | null }>> {
  const list = allVars(c).filter((v) => v.available(c));
  const w = list.some((v) => v.group === "weather") ? await weatherFor(c.station) : null;
  const a = list.some((v) => v.group === "alert") ? await activeAlerts(c.station) : [];
  return list.map((v) => ({ name: v.name, group: v.group, description: v.description, example: v.example, value: v.value(c, w, a) ?? null }));
}

/** Instructions for the writing model: what placeholders exist, and not to invent what they stand for. Empty when there are none to offer. */
export function promptHelp(c: TemplateContext): string {
  const vars = availableVariables(c);
  if (!vars.length) return "";
  return [
    "Placeholders: where it helps, write these exactly as shown and the system will replace each with the real value after you write, so never guess or invent the time, date, weather, names or numbers yourself.",
    "Syntax: {{name}} for a value; {{name|fallback}} to say something else when there is no value (always give a fallback for {{weather}}); {{pick: first | second | third}} for one random choice.",
    `Available: ${vars.map((v) => `{{${v.name}}} (${v.description}, e.g. "${v.example}")`).join("; ")}.`,
    "Use them only where they read naturally aloud, and write the surrounding words so the line still makes sense with the value in place.",
  ].join(" ");
}

// ---------- rendering ----------
const TOKEN = /\{\{\s*([^{}]+?)\s*\}\}/g;
const norm = (s: string) => s.trim().toLowerCase().replace(/[-\s]+/g, "_");

export interface Rendered { text: string; used: string[]; missing: string[] }

export async function renderTemplate(input: string, c: TemplateContext = {}): Promise<Rendered> {
  if (!input.includes("{{")) return { text: input, used: [], missing: [] };
  const rng = c.rng ?? Math.random;
  const defs = new Map(allVars(c).map((v) => [v.name, v]));
  const wantsWeather = [...input.matchAll(TOKEN)].some((m) => { const n = norm(m[1].split("|")[0]); return defs.get(n)?.group === "weather"; });
  const wantsAlerts = [...input.matchAll(TOKEN)].some((m) => { const n = norm(m[1].split("|")[0]); return defs.get(n)?.group === "alert"; });
  const w = wantsWeather ? await weatherFor(c.station) : null;
  const alerts = wantsAlerts ? await activeAlerts(c.station) : [];
  const used = new Set<string>();
  const missing = new Set<string>();

  let text = input.replace(TOKEN, (_all, body: string) => {
    const pick = /^(pick|one_of|choose)\s*:(.*)$/is.exec(body);
    if (pick) {
      const choices = pick[2].split("|").map((s) => s.trim()).filter(Boolean);
      used.add("pick");
      return choices.length ? choices[Math.min(choices.length - 1, Math.floor(rng() * choices.length))] : "";
    }
    const bar = body.indexOf("|");
    const name = norm(bar < 0 ? body : body.slice(0, bar));
    const fallback = bar < 0 ? undefined : body.slice(bar + 1).trim();
    const def = defs.get(name);
    const value = def && def.available(c) ? def.value(c, w, alerts) : undefined;
    if (value) { used.add(name); return value; }
    if (fallback) { used.add(name); return fallback; }
    missing.add(name);
    return "";
  });

  // Whatever is left over must never be spoken, and a removed placeholder should not leave a gap.
  text = text.replace(/\{\{|\}\}/g, "").replace(/[ \t]{2,}/g, " ").replace(/\s+([,.!?;:])/g, "$1").trim();
  return { text, used: [...used], missing: [...missing] };
}

/** The context a request or schedule run builds from its station, persona and options. */
export function contextFor(o: { station?: Station | null; persona?: { name: string; tagline?: string } | null; targetSeconds?: number; song?: { artist?: string; title?: string }; now?: Date; rng?: () => number }): TemplateContext {
  return { station: o.station ?? null, persona: o.persona ?? null, targetSeconds: o.targetSeconds, song: o.song, now: o.now, rng: o.rng, tz: o.station?.tz };
}
