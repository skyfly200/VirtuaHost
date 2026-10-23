// Finding a place by name, so nobody has to type coordinates: "Houston, TX" -> latitude, longitude, state, country, time zone.
// Uses Open-Meteo's free geocoder (no key): https://geocoding-api.open-meteo.com. It finds towns and cities (not street addresses).
// NOT verified against the live service: the request and response follow Open-Meteo's public documentation
// (results[]: name, latitude, longitude, country, country_code, admin1, timezone, population).
export interface Place {
  /** "Houston, Texas, United States" */
  label: string;
  name: string;
  admin1: string;
  country: string;
  countryCode: string;
  lat: number;
  lon: number;
  tz: string;
  population: number | null;
}

export const US_STATES: Record<string, string> = {
  AL: "Alabama", AK: "Alaska", AZ: "Arizona", AR: "Arkansas", CA: "California", CO: "Colorado", CT: "Connecticut", DE: "Delaware", DC: "District of Columbia", FL: "Florida",
  GA: "Georgia", HI: "Hawaii", ID: "Idaho", IL: "Illinois", IN: "Indiana", IA: "Iowa", KS: "Kansas", KY: "Kentucky", LA: "Louisiana", ME: "Maine", MD: "Maryland",
  MA: "Massachusetts", MI: "Michigan", MN: "Minnesota", MS: "Mississippi", MO: "Missouri", MT: "Montana", NE: "Nebraska", NV: "Nevada", NH: "New Hampshire", NJ: "New Jersey",
  NM: "New Mexico", NY: "New York", NC: "North Carolina", ND: "North Dakota", OH: "Ohio", OK: "Oklahoma", OR: "Oregon", PA: "Pennsylvania", RI: "Rhode Island",
  SC: "South Carolina", SD: "South Dakota", TN: "Tennessee", TX: "Texas", UT: "Utah", VT: "Vermont", VA: "Virginia", WA: "Washington", WV: "West Virginia", WI: "Wisconsin",
  WY: "Wyoming", PR: "Puerto Rico", GU: "Guam", VI: "U.S. Virgin Islands", AS: "American Samoa", MP: "Northern Mariana Islands",
};
const STATE_ABBR = Object.fromEntries(Object.entries(US_STATES).map(([a, n]) => [n.toLowerCase(), a]));
/** "Texas" -> "TX" (US states and territories); anything else -> "". */
export const stateCode = (admin1: string): string => STATE_ABBR[admin1.toLowerCase()] ?? "";

const norm = (s: string) => s.toLowerCase().replace(/[^a-z0-9 ]+/g, " ").replace(/\s+/g, " ").trim();
const COUNTRY_WORDS: Record<string, string> = { usa: "us", "u s a": "us", "u s": "us", "united states": "us", america: "us", uk: "gb", "united kingdom": "gb", england: "gb" };

/** "Houston, TX" -> the name to search ("Houston") and a hint ("tx") used to rank the candidates. */
export function splitQuery(q: string): { name: string; hint: string } {
  const [first, ...rest] = q.split(",");
  return { name: first.trim().slice(0, 100), hint: norm(rest.join(" ")) };
}

function hintScore(p: Place, hint: string): number {
  if (!hint) return 0;
  const h = COUNTRY_WORDS[hint] ?? hint;
  const code = stateCode(p.admin1).toLowerCase();
  const tokens = hint.split(" ");
  let score = 0;
  for (const t of [h, ...tokens]) {
    if (t === code || norm(p.admin1) === t || (t.length > 3 && norm(p.admin1).startsWith(t))) score += 10;
    if (t === p.countryCode.toLowerCase() || norm(p.country) === t) score += 5;
  }
  return score;
}

const cache = new Map<string, { at: number; places: Place[] }>();
const TTL_MS = 60 * 60_000;
export const resetPlaceCache = (): void => cache.clear();

/** Up to five places matching what was typed, best first. Never throws: an outage gives []. */
export async function searchPlaces(query: string): Promise<Place[]> {
  const q = query.replace(/[\u0000-\u001f\u007f]/g, " ").trim().slice(0, 120);
  if (q.length < 2) return [];
  const hit = cache.get(q.toLowerCase());
  if (hit && Date.now() - hit.at < TTL_MS) return hit.places;
  const { name, hint } = splitQuery(q);
  if (name.length < 2) return [];
  let places: Place[] = [];
  try {
    const res = await fetch(`https://geocoding-api.open-meteo.com/v1/search?name=${encodeURIComponent(name)}&count=10&language=en&format=json`, { signal: AbortSignal.timeout(5_000) });
    const body = (await res.json()) as { results?: Array<Record<string, unknown>> };
    places = (body.results ?? []).flatMap((r) => {
      const lat = Number(r.latitude); const lon = Number(r.longitude);
      if (typeof r.name !== "string" || !Number.isFinite(lat) || !Number.isFinite(lon)) return [];
      const admin1 = typeof r.admin1 === "string" ? r.admin1 : "";
      const country = typeof r.country === "string" ? r.country : "";
      return [{
        label: [r.name, admin1, country].filter(Boolean).join(", "), name: r.name, admin1, country, countryCode: typeof r.country_code === "string" ? r.country_code : "",
        lat: Math.round(lat * 1e4) / 1e4, lon: Math.round(lon * 1e4) / 1e4, tz: typeof r.timezone === "string" ? r.timezone : "", population: typeof r.population === "number" ? r.population : null,
      }];
    });
  } catch {
    places = [];
  }
  // Best first: matches the "TX" / "Texas" / country you typed, then the biggest place (the one most people mean).
  places.sort((a, b) => hintScore(b, hint) - hintScore(a, hint) || (b.population ?? 0) - (a.population ?? 0));
  places = places.slice(0, 5);
  if (places.length) cache.set(q.toLowerCase(), { at: Date.now(), places });
  return places;
}
