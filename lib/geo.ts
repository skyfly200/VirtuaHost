import type { Station } from "./station-profile.js";

// Where a station is: its saved coordinates, else its city looked up once (Open-Meteo's geocoder, free). NOT verified against the live service.
export async function locate(station: Station): Promise<{ lat: number; lon: number } | null> {
  if (typeof station.lat === "number" && typeof station.lon === "number") return { lat: station.lat, lon: station.lon };
  if (!station.city) return null;
  try {
    const res = await fetch(`https://geocoding-api.open-meteo.com/v1/search?name=${encodeURIComponent(station.city)}&count=1`, { signal: AbortSignal.timeout(4_000) });
    const hit = ((await res.json()) as { results?: Array<{ latitude?: number; longitude?: number }> }).results?.[0];
    return typeof hit?.latitude === "number" && typeof hit.longitude === "number" ? { lat: hit.latitude, lon: hit.longitude } : null;
  } catch {
    return null;
  }
}
