// Station profiles: who and where a station is, kept on the site so every view can use it before any server is connected.
// A profile is data only (name, frequency, time zone, defaults, links); connecting a real Icecast/Liquidsoap/hub later is a separate step
// (see `connection`, which only records what it will be). Other parts read the station to name it in AI-written lines, pick its time
// zone, and default its persona, voice and audio treatment.
import { isReservedVariable, VARIABLE_NAME } from "./drop-template.js";
import { validTimeZone } from "./schedule.js";
import { stateCode } from "./places.js";

export type ConnectionKind = "none" | "chips-voice" | "radiodj" | "icecast";
export const CONNECTION_KINDS: readonly ConnectionKind[] = ["none", "chips-voice", "radiodj", "icecast"];

export interface Station {
  id: string;
  name: string;
  /** Call sign or short name: "KRAP". */
  callsign?: string;
  /** As shown on the dial: "97.7 FM". */
  frequency?: string;
  tagline?: string;
  description?: string;
  /** One emoji and an accent colour for its card. */
  emoji?: string;
  color?: string;
  genres: string[];
  city?: string;
  /** IANA time zone: the station's wall clock, used for schedules, promos and time-of-day lines. */
  tz: string;
  website?: string;
  streamUrl?: string;
  contact?: string;
  links: Array<{ label: string; url: string }>;
  /** Defaults for clips made for this station (a request or a persona overrides them). */
  defaultPersonaId?: string;
  defaultFx?: string;
  defaultSpeechModel?: string;
  defaultTextModel?: string;
  defaultVoice?: string;
  /** Models this station may use (OpenRouter slugs; speech entries may carry a voice as "slug|Voice"). Empty = the site's list. Applies even with a station or personal key. */
  textModels?: string[];
  speechModels?: string[];
  /** Artists that are spots or relays on this station. */
  skipArtists: string[];
  /** Where the station is, for the {{weather}} placeholders (lib/drop-template.ts). Without it the city name is looked up. */
  lat?: number;
  lon?: number;
  /** The place the coordinates came from (found by name in the Stations tab), so it can be shown and used as {{place}} / {{state}}. */
  place?: { label: string; name: string; admin1?: string; state?: string; countryCode?: string };
  /** How far the station can be heard, in km (a circle around its location). A first coverage model; see docs/COVERAGE.md. */
  coverageKm?: number;
  /** Temperature unit for {{temp}}: F for the Americas by default, else C. */
  tempUnit?: "F" | "C";
  /** Station-specific placeholders, {{sponsor}} and so on: name -> text. */
  variables?: Record<string, string>;
  /** Per-station send defaults: put new clips on air as soon as they arrive, and let them cut in over a live DJ. A request still overrides. */
  autoplay?: boolean;
  preempt?: boolean;
  notes?: string;
  /** What this station will connect to, once it has a server. Nothing here is a secret and nothing needs to be running. */
  connection: { kind: ConnectionKind; hubStationId?: string; note?: string };
  builtin?: boolean;
  updatedAt?: string;
}

export const STATION_ID = /^[a-z0-9][a-z0-9-]{0,49}$/;
const slug = (s: string) => s.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "").slice(0, 40);
export const slugifyStation = slug;

const text = (v: unknown, max: number): string => (typeof v === "string" ? v.replace(/[\u0000-\u001f\u007f]/g, " ").replace(/\s+/g, " ").trim().slice(0, max) : "");
const url = (v: unknown): string => {
  const t = text(v, 300);
  try { return /^https?:$/.test(new URL(t).protocol) ? t : ""; } catch { return ""; }
};
const list = (v: unknown, count: number, max: number): string[] => (Array.isArray(v) ? v.map((x) => text(x, max)).filter(Boolean).slice(0, count) : []);

// Always available, so there is a station to use even before one is created: named from STATION_NAME.
export function defaultStation(): Station {
  return {
    id: "default", name: process.env.STATION_NAME?.trim() || "the station", genres: [], tz: "UTC", links: [], skipArtists: [], connection: { kind: "none" }, builtin: true,
  };
}

const num = (v: unknown, lo: number, hi: number): number | undefined => { const n = typeof v === "string" && v.trim() ? Number(v) : v; return typeof n === "number" && Number.isFinite(n) && n >= lo && n <= hi ? n : undefined; };
const geo = (r: Record<string, unknown>): { lat?: number; lon?: number } => { const lat = num(r.lat, -90, 90); const lon = num(r.lon, -180, 180); return lat !== undefined && lon !== undefined ? { lat, lon } : {}; };
// Accepts { name: text } or lines of "name=text"; names are lowercase words, built-in placeholders cannot be replaced.
function customVariables(raw: unknown): { variables?: Record<string, string> } {
  const pairs: Array<[string, string]> = typeof raw === "string" ? raw.split("\n").map((l) => { const at = l.indexOf("="); return [l.slice(0, at), l.slice(at + 1)] as [string, string]; }) : raw && typeof raw === "object" ? Object.entries(raw as Record<string, unknown>).map(([k, v]) => [k, String(v)] as [string, string]) : [];
  const out: Record<string, string> = {};
  for (const [k, v] of pairs) {
    const name = k.trim().toLowerCase();
    const value = text(v, 200);
    if (VARIABLE_NAME.test(name) && !isReservedVariable(name) && value && Object.keys(out).length < 20) out[name] = value;
  }
  return Object.keys(out).length ? { variables: out } : {};
}

const placeOf = (raw: unknown): { place?: NonNullable<Station["place"]> } => {
  if (!raw || typeof raw !== "object") return {};
  const p = raw as Record<string, unknown>;
  const label = text(p.label, 200); const name = text(p.name, 100);
  if (!label || !name) return {};
  const admin1 = text(p.admin1, 80); const code = text(p.countryCode, 2).toUpperCase(); const state = stateCode(admin1);
  return { place: { label, name, ...(admin1 ? { admin1 } : {}), ...(state ? { state } : {}), ...(code ? { countryCode: code } : {}) } };
};

const MODEL_ENTRY = /^[A-Za-z0-9][A-Za-z0-9._:/-]{0,99}(\|[A-Za-z0-9_. -]{1,60})?$/;
const modelList = <K extends "textModels" | "speechModels">(key: K, raw: unknown): Partial<Record<K, string[]>> => {
  const items = (Array.isArray(raw) ? raw : typeof raw === "string" ? raw.split(/[\n,]/) : []).map((v) => String(v).trim()).filter((v) => MODEL_ENTRY.test(v));
  const unique = [...new Set(items)].slice(0, 30);
  return unique.length ? ({ [key]: unique } as Partial<Record<K, string[]>>) : {};
};

export function sanitizeStation(raw: unknown): { station: Omit<Station, "id"> } | { error: string } {
  if (!raw || typeof raw !== "object") return { error: "Send the station as a JSON object" };
  const r = raw as Record<string, unknown>;
  const name = text(r.name, 60);
  if (!name) return { error: "A station needs a name" };
  const tzIn = text(r.tz, 60);
  if (tzIn && !validTimeZone(tzIn)) return { error: `Unknown time zone "${tzIn}" (use a name like America/New_York)` };
  const color = text(r.color, 7);
  const conn = (r.connection && typeof r.connection === "object" ? r.connection : {}) as Record<string, unknown>;
  const kind = CONNECTION_KINDS.includes(conn.kind as ConnectionKind) ? (conn.kind as ConnectionKind) : "none";
  const links = (Array.isArray(r.links) ? r.links : []).flatMap((l) => {
    const o = (l && typeof l === "object" ? l : {}) as Record<string, unknown>;
    const u = url(o.url);
    return u ? [{ label: text(o.label, 40) || u.replace(/^https?:\/\//, "").slice(0, 40), url: u }] : [];
  }).slice(0, 12);
  const opt = <K extends string>(key: K, value: string): Partial<Record<K, string>> => (value ? ({ [key]: value } as Record<K, string>) : {});
  return {
    station: {
      name, tz: tzIn || "UTC",
      ...opt("callsign", text(r.callsign, 20)), ...opt("frequency", text(r.frequency, 30)), ...opt("tagline", text(r.tagline, 120)), ...opt("description", text(r.description, 500)),
      ...opt("emoji", text(r.emoji, 8)), ...opt("color", /^#[0-9a-fA-F]{6}$/.test(color) ? color.toLowerCase() : ""),
      genres: [...new Set(list(r.genres, 8, 24).map((g) => g.toLowerCase()))],
      ...opt("city", text(r.city, 80)), ...opt("website", url(r.website)), ...opt("streamUrl", url(r.streamUrl)), ...opt("contact", text(r.contact, 120)),
      links,
      ...opt("defaultPersonaId", text(r.defaultPersonaId, 60)), ...opt("defaultFx", text(r.defaultFx, 40)), ...opt("defaultSpeechModel", text(r.defaultSpeechModel, 100)), ...opt("defaultTextModel", text(r.defaultTextModel, 100)), ...opt("defaultVoice", text(r.defaultVoice, 60)),
      skipArtists: list(r.skipArtists, 100, 100),
      ...geo(r), ...placeOf(r.place), ...(num(r.coverageKm, 1, 3000) !== undefined ? { coverageKm: num(r.coverageKm, 1, 3000) } : {}), ...(r.tempUnit === "F" || r.tempUnit === "C" ? { tempUnit: r.tempUnit } : {}), ...customVariables(r.variables),
      ...modelList("textModels", r.textModels), ...modelList("speechModels", r.speechModels),
      ...(typeof r.autoplay === "boolean" ? { autoplay: r.autoplay } : {}), ...(typeof r.preempt === "boolean" ? { preempt: r.preempt } : {}),
      ...opt("notes", text(r.notes, 1000)),
      connection: { kind, ...opt("hubStationId", text(conn.hubStationId, 60)), ...opt("note", text(conn.note, 200)) },
    },
  };
}
