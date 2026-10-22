import { bearingTo, coverageModel, destination, reachKm, type CoverageModel, type LevelName } from "./propagation.js";
import type { Station } from "./station-profile.js";

// Where a station can be heard, and which stations are near a point. A station's coverage comes from, in order: its transmitter (the quick
// power-and-antenna model in lib/propagation.ts), else a radius you typed (a plain circle), else nothing. The shape is deliberately a small
// object (a reach for each bearing) so it can later become a terrain-aware model or an imported contour without changing the callers.
// See docs/COVERAGE.md.
export interface Point { lat: number; lon: number }

const R_KM = 6371;
const rad = (d: number) => (d * Math.PI) / 180;

/** Great-circle distance between two points, in kilometres. */
export function distanceKm(a: Point, b: Point): number {
  const dLat = rad(b.lat - a.lat); const dLon = rad(b.lon - a.lon);
  const h = Math.sin(dLat / 2) ** 2 + Math.cos(rad(a.lat)) * Math.cos(rad(b.lat)) * Math.sin(dLon / 2) ** 2;
  return 2 * R_KM * Math.asin(Math.min(1, Math.sqrt(h)));
}

export const stationPoint = (s: Station): Point | null => (typeof s.lat === "number" && typeof s.lon === "number" ? { lat: s.lat, lon: s.lon } : null);

/** How far the station reaches toward a bearing at a level (default "good"), in km; 0 if its coverage is unknown. */
export function stationReachKm(s: Station, bearingDeg: number, level: LevelName = "good"): number {
  if (s.transmitter) { const r = reachKm(s.transmitter, level, bearingDeg); if (r > 0) return r; }
  return typeof s.coverageKm === "number" ? s.coverageKm : 0;
}

/** The quick coverage model for a station, or null when it has no location or no power. */
export function modelFor(s: Station): CoverageModel | null {
  const at = stationPoint(s);
  return at && s.transmitter ? coverageModel(s.transmitter, at) : null;
}

export interface Nearness { id: string; name: string; distanceKm: number; /** true when the point is inside the station's "good" coverage; null when the station's coverage is unknown */ covers: boolean | null; reachKm?: { strong: number; good: number; fringe: number } }

/** Stations that have a location, nearest to `point` first. */
export function stationsNear(stations: Station[], point: Point): Nearness[] {
  return stations.flatMap((s) => {
    const at = stationPoint(s);
    if (!at) return [];
    const km = distanceKm(point, at);
    const known = Boolean(s.transmitter) || typeof s.coverageKm === "number";
    const reach = s.transmitter ? modelFor(s)?.reachKm : undefined;
    return [{ id: s.id, name: s.name, distanceKm: Math.round(km * 10) / 10, covers: known ? km <= stationReachKm(s, bearingTo(at, point)) : null, ...(reach ? { reachKm: reach } : {}) }];
  }).sort((a, b) => a.distanceKm - b.distanceKm);
}

/**
 * Where to ask "is there an alert?" for a station: its own location, plus eight points around the edge of where it is heard (when that is
 * known), so an alert that reaches the edge of the coverage area counts, not only one over the antenna.
 */
export function alertProbePoints(s: Station, level: LevelName = "good"): Point[] {
  const at = stationPoint(s);
  if (!at) return [];
  const points = [at];
  for (let b = 0; b < 360; b += 45) {
    const km = Math.min(stationReachKm(s, b, level), 300);
    if (km > 0.5) points.push(destination(at.lat, at.lon, b, km));
  }
  return points;
}
