// Station context: what the writer should already know about a station's place, so a brief like "weather report on the road
// conditions" needs no more words. Stored on the profile (`context`), put into every AI writing prompt (buildSystemPrompt), and
// the key roads are the places the road-risk check looks at (lib/live-inputs.ts). Nothing here is invented: it is what the
// station enters. Meant to be copied between stations (export/import the `context` object).
import type { Station } from "./station-profile.js";

export interface Road { name: string; aliases?: string[]; /** A point on the road for its own weather check; without one the station's location is used. */ lat?: number; lon?: number; note?: string }
export interface StationContext { about?: string; roads: Road[] }

const line = (v: unknown, max: number): string => (typeof v === "string" ? v.replace(/[\u0000-\u001f\u007f]/g, " ").replace(/\s+/g, " ").trim().slice(0, max) : "");
const multi = (v: unknown, max: number): string => (typeof v === "string" ? v.replace(/[\u0000-\u0009\u000b-\u001f\u007f]/g, " ").replace(/[ \t]+/g, " ").replace(/\n{3,}/g, "\n\n").trim().slice(0, max) : "");
const coord = (v: unknown, lo: number, hi: number): number | undefined => { const n = typeof v === "string" && v.trim() ? Number(v) : v; return typeof n === "number" && Number.isFinite(n) && n >= lo && n <= hi ? n : undefined; };

/** Cleans what the editor sends. Returns undefined when there is nothing to keep. */
export function sanitizeContext(raw: unknown): StationContext | undefined {
  if (!raw || typeof raw !== "object") return undefined;
  const r = raw as Record<string, unknown>;
  const about = multi(r.about, 1500);
  const roads: Road[] = [];
  for (const item of Array.isArray(r.roads) ? r.roads : []) {
    if (!item || typeof item !== "object" || roads.length >= 12) continue;
    const o = item as Record<string, unknown>;
    const name = line(o.name, 80);
    if (!name) continue;
    const aliases = (Array.isArray(o.aliases) ? o.aliases : typeof o.aliases === "string" ? o.aliases.split(",") : []).map((a) => line(a, 60)).filter(Boolean).slice(0, 6);
    const lat = coord(o.lat, -90, 90); const lon = coord(o.lon, -180, 180);
    const note = line(o.note, 200);
    roads.push({ name, ...(aliases.length ? { aliases } : {}), ...(lat !== undefined && lon !== undefined ? { lat, lon } : {}), ...(note ? { note } : {}) });
  }
  return about || roads.length ? { ...(about ? { about } : {}), roads } : undefined;
}

/** The paragraph added to the writing prompt for this station; empty when the station has no context. */
export function stationBrief(station: Pick<Station, "context" | "place" | "city"> | null | undefined): string {
  const c = station?.context;
  if (!c) return "";
  const out: string[] = [];
  const where = station?.place?.label || station?.city;
  if (where) out.push(`The station is in ${where}.`);
  if (c.about) out.push(`About the station and its area: ${c.about}`);
  if (c.roads.length) {
    out.push(`Roads and routes that matter to listeners: ${c.roads.map((r) => [r.name, r.aliases?.length ? `also called ${r.aliases.join(", ")}` : "", r.note].filter(Boolean).join(" -- ")).join("; ")}.`);
    out.push('When a brief mentions "the roads", "road conditions" or "the canyon" without naming them, it means these roads. Do not name roads that are not listed here.');
  }
  return out.join(" ");
}

/** The shape writeScript takes for its `station` option. */
export const writerStation = (s: Station | null | undefined): { name: string; tagline?: string; brief?: string } | undefined => {
  if (!s) return undefined;
  const brief = stationBrief(s);
  return { name: s.name, tagline: s.tagline, ...(brief ? { brief } : {}) };
};
