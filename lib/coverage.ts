import type { Station } from "./station-profile.js";

// Where a station can be heard, and which stations are near a point. Today a station's coverage is a circle (its location plus a radius in
// km); the shape is deliberately a small object so it can later become a real model (a contour polygon, population served) without changing
// the callers. See docs/COVERAGE.md.
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

export interface Nearness { id: string; name: string; distanceKm: number; /** true when the point is inside the station's coverage circle */ covers: boolean | null }

/** Stations that have a location, nearest to `point` first. `covers` is null when the station has no coverage radius set. */
export function stationsNear(stations: Station[], point: Point): Nearness[] {
  return stations.flatMap((s) => {
    const at = stationPoint(s);
    if (!at) return [];
    const km = distanceKm(point, at);
    return [{ id: s.id, name: s.name, distanceKm: Math.round(km * 10) / 10, covers: typeof s.coverageKm === "number" ? km <= s.coverageKm : null }];
  }).sort((a, b) => a.distanceKm - b.distanceKm);
}
