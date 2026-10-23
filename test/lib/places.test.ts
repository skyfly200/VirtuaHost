import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { searchPlaces, splitQuery, stateCode, resetPlaceCache } from "../../lib/places.js";
import { distanceKm, stationsNear } from "../../lib/coverage.js";
import { sanitizeStation, type Station } from "../../lib/station-profile.js";
import { renderTemplate, contextFor } from "../../lib/drop-template.js";
import { handlePlaces } from "../../lib/handlers/places.js";
import { handleStations } from "../../lib/handlers/stations.js";

vi.mock("../../lib/station-profile-store.js", () => ({
  listStations: vi.fn(async () => [
    { id: "wayhigh", name: "Way High", tz: "America/Chicago", lat: 29.76, lon: -95.37, coverageKm: 60, genres: [], links: [], skipArtists: [], connection: { kind: "none" } },
    { id: "green", name: "Greenlight", tz: "America/Chicago", lat: 30.27, lon: -97.74, genres: [], links: [], skipArtists: [], connection: { kind: "none" } },
    { id: "noloc", name: "No location", tz: "UTC", genres: [], links: [], skipArtists: [], connection: { kind: "none" } },
  ]),
  getStation: vi.fn(), saveStation: vi.fn(), deleteStation: vi.fn(),
}));

const fetchMock = vi.fn();
const row = (name: string, admin1: string, cc: string, country: string, lat: number, lon: number, population: number, timezone = "America/Chicago") => ({ name, admin1, country_code: cc, country, latitude: lat, longitude: lon, population, timezone });
const geocoder = (...results: object[]) => fetchMock.mockImplementation(async () => new Response(JSON.stringify({ results })));

beforeEach(() => { resetPlaceCache(); fetchMock.mockReset(); vi.stubGlobal("fetch", fetchMock); vi.stubEnv("ACCESS_KEY", "machine-key-0123456789"); vi.stubEnv("AUTH_DISABLED", ""); vi.stubEnv("SESSION_SECRET", ""); });
afterEach(() => { vi.unstubAllEnvs(); vi.unstubAllGlobals(); });

describe("searchPlaces", () => {
  it("splits what was typed into a name to search and a hint to rank by", () => {
    expect(splitQuery("Houston, TX")).toEqual({ name: "Houston", hint: "tx" });
    expect(splitQuery("Springfield, Illinois, USA")).toEqual({ name: "Springfield", hint: "illinois usa" });
    expect(splitQuery("Austin")).toEqual({ name: "Austin", hint: "" });
    expect(stateCode("Texas")).toBe("TX");
    expect(stateCode("Bavaria")).toBe("");
  });

  it("finds a place and fills in coordinates and time zone, asking for the name only", async () => {
    geocoder(row("Houston", "Texas", "US", "United States", 29.76328, -95.36327, 2_300_000));
    const [p] = await searchPlaces("Houston, TX");
    expect(p).toMatchObject({ label: "Houston, Texas, United States", lat: 29.7633, lon: -95.3633, tz: "America/Chicago", countryCode: "US" });
    expect(String(fetchMock.mock.calls[0][0])).toContain("name=Houston&");
    expect(String(fetchMock.mock.calls[0][0])).not.toContain("TX");
  });

  it("ranks the state you typed above a bigger place elsewhere, otherwise the biggest", async () => {
    geocoder(row("Springfield", "Missouri", "US", "United States", 37.2, -93.3, 169_000), row("Springfield", "Illinois", "US", "United States", 39.8, -89.6, 114_000), row("Springfield", "Massachusetts", "US", "United States", 42.1, -72.6, 155_000));
    expect((await searchPlaces("Springfield, IL"))[0].admin1).toBe("Illinois");
    resetPlaceCache();
    expect((await searchPlaces("Springfield"))[0].admin1).toBe("Missouri");
  });

  it("gives [] for short input or an outage, and caches answers", async () => {
    expect(await searchPlaces("a")).toEqual([]);
    fetchMock.mockRejectedValue(new Error("offline"));
    expect(await searchPlaces("Nowhere")).toEqual([]);
    geocoder(row("Austin", "Texas", "US", "United States", 30.27, -97.74, 960_000));
    await searchPlaces("Austin"); await searchPlaces("Austin");
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });
});

describe("GET /api/places", () => {
  it("needs a sign-in and at least two letters", async () => {
    geocoder(row("Austin", "Texas", "US", "United States", 30.27, -97.74, 960_000));
    const get = (q: string, key: string | null = "machine-key-0123456789") => handlePlaces(new Request(`http://localhost/api/places?q=${encodeURIComponent(q)}`, { headers: key ? { "x-api-key": key } : {} }));
    expect(((await (await get("Austin")).json()) as { places: unknown[] }).places.length).toBe(1);
    expect((await get("a")).status).toBe(400);
    expect((await get("Austin", null)).status).toBe(401);
  });
});

describe("coverage", () => {
  it("measures distance, and ranks stations by it with whether each one's circle covers the point", async () => {
    expect(Math.round(distanceKm({ lat: 29.76, lon: -95.37 }, { lat: 30.27, lon: -97.74 }))).toBe(235);          // Houston to Austin, as the crow flies
    const res = await handleStations(new Request("http://localhost/api/stations?near=29.9,-95.4", { headers: { "x-api-key": "machine-key-0123456789" } }), undefined, undefined);
    const near = (await res.json()) as { near: Array<{ id: string; covers: boolean | null; distanceKm: number }> };
    expect(near.near.map((n) => n.id)).toEqual(["wayhigh", "green"]);                                              // no location: left out
    expect(near.near[0]).toMatchObject({ covers: true });
    expect(near.near[1].covers).toBeNull();                                                                       // no radius set
    expect(stationsNear([{ id: "a", name: "A", lat: 0, lon: 0, coverageKm: 10 } as Station], { lat: 0, lon: 1 })[0].covers).toBe(false);
  });

  it("rejects a bad near value", async () => {
    expect((await handleStations(new Request("http://localhost/api/stations?near=abc", { headers: { "x-api-key": "machine-key-0123456789" } }), undefined, undefined)).status).toBe(400);
  });
});

describe("a station's place", () => {
  it("is saved with its state and a coverage radius, and ignores junk", () => {
    const out = sanitizeStation({ name: "KRAP", lat: 29.76, lon: -95.37, coverageKm: "60", place: { label: "Houston, Texas, United States", name: "Houston", admin1: "Texas", countryCode: "us" } });
    expect("station" in out && out.station).toMatchObject({ lat: 29.76, lon: -95.37, coverageKm: 60, place: { name: "Houston", admin1: "Texas", state: "TX", countryCode: "US" } });
    const junk = sanitizeStation({ name: "X", coverageKm: -5, place: "nope" });
    expect("station" in junk && junk.station.coverageKm).toBeUndefined();
    expect("station" in junk && junk.station.place).toBeUndefined();
  });

  it("fills {{place}} and {{state}} in drops", async () => {
    const station = { id: "k", name: "KRAP", tz: "America/Chicago", genres: [], links: [], skipArtists: [], connection: { kind: "none" }, place: { label: "Houston, Texas, United States", name: "Houston", admin1: "Texas", state: "TX" } } as Station;
    expect((await renderTemplate("Live from {{place}}, {{state|}}!", contextFor({ station }))).text).toBe("Live from Houston, Texas, Texas!");
  });
});
