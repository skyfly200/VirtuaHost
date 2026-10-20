// Station profiles: who and where a station is, kept on the site so every view can use it before any server is connected.
// A profile is data only (name, frequency, time zone, defaults, links); connecting a real Icecast/Liquidsoap/hub later is a separate step
// (see `connection`, which only records what it will be). Other parts read the station to name it in AI-written lines, pick its time
// zone, and default its persona, voice and audio treatment.
import { validTimeZone } from "./schedule.js";

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
  defaultVoice?: string;
  /** Artists that are spots or relays on this station. */
  skipArtists: string[];
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
      ...opt("defaultPersonaId", text(r.defaultPersonaId, 60)), ...opt("defaultFx", text(r.defaultFx, 40)), ...opt("defaultSpeechModel", text(r.defaultSpeechModel, 100)), ...opt("defaultVoice", text(r.defaultVoice, 60)),
      skipArtists: list(r.skipArtists, 100, 100),
      ...opt("notes", text(r.notes, 1000)),
      connection: { kind, ...opt("hubStationId", text(conn.hubStationId, 60)), ...opt("note", text(conn.note, 200)) },
    },
  };
}
