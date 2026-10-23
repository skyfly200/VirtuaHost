import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { erpWatts, radiusKm, reachKm, patternLossDb, coverageModel, destination, bearingTo, type Transmitter } from "../../lib/propagation.js";
import { stationsNear, alertProbePoints, modelFor, stationReachKm } from "../../lib/coverage.js";
import { sanitizeStation, type Station } from "../../lib/station-profile.js";
import { handleCoverage } from "../../lib/handlers/coverage.js";
import { activeAlerts, resetAlertCache } from "../../lib/alerts.js";

// The reference setup: a quarter-wave ground plane 50 ft above ground on Mapleton Hill, Boulder (coordinates approximate).
const MAPLETON = { lat: 40.0225, lon: -105.285 };
const reference: Transmitter = { powerWatts: 5, antenna: "ground-plane", heightFt: 50, environment: "suburban" };
const station = (over: Partial<Station> = {}): Station => ({ id: "wayhigh", name: "Way High", tz: "America/Denver", genres: [], links: [], skipArtists: [], connection: { kind: "none" }, ...MAPLETON, transmitter: reference, ...over });

vi.mock("../../lib/station-profile-store.js", () => ({ getStation: vi.fn(async (id?: string) => (id === "wayhigh" ? { id: "wayhigh", name: "Way High", tz: "America/Denver", genres: [], links: [], skipArtists: [], connection: { kind: "none" }, lat: 40.0225, lon: -105.285, transmitter: { powerWatts: 5, antenna: "ground-plane", heightFt: 50, environment: "suburban" } } : null)) }));

describe("ERP", () => {
  it("is power x gain less cable loss, unless ERP is given", () => {
    expect(erpWatts({ ...reference, powerWatts: 10, lossDb: 1 })).toBeCloseTo(7.943, 2);
    expect(erpWatts({ ...reference, powerWatts: 10, antenna: "collinear" })).toBeCloseTo(19.95, 1);          // +3 dB
    expect(erpWatts({ ...reference, powerWatts: 10, gainDbd: 0, erpWatts: 2 })).toBe(2);
    expect(erpWatts({ antenna: "ground-plane", heightFt: 50, environment: "open" })).toBeNull();            // no power
  });
});

describe("the quick model", () => {
  it("gives the reference setup (5 W, 50 ft, suburban) a believable reach", () => {
    expect(reachKm(reference, "strong")).toBeCloseTo(2.0, 0);
    expect(reachKm(reference, "good")).toBeCloseTo(6.2, 0);
    expect(reachKm(reference, "fringe")).toBeCloseTo(23, 0);
  });

  it("reaches farther with more power, more height, and fewer obstructions, and never the other way", () => {
    const base = reachKm(reference, "good");
    expect(reachKm({ ...reference, powerWatts: 50 }, "good")).toBeGreaterThan(base);
    expect(reachKm({ ...reference, heightFt: 200 }, "fringe")).toBeGreaterThan(reachKm(reference, "fringe"));
    expect(reachKm({ ...reference, environment: "open" }, "good")).toBeGreaterThan(base);
    expect(reachKm({ ...reference, environment: "urban" }, "good")).toBeLessThan(base);
    expect(reachKm({ ...reference, haatFt: 400 }, "fringe")).toBeGreaterThan(reachKm(reference, "fringe"));   // HAAT beats height above ground
    expect(reachKm(reference, "strong")).toBeLessThan(reachKm(reference, "good"));
    expect(reachKm(reference, "good")).toBeLessThan(reachKm(reference, "fringe"));
  });

  it("follows free space (6 dB per doubling of distance) inside the horizon, then falls faster", () => {
    const h = 15.24;
    const d60 = radiusKm(5, h, 60, 8); const d54 = radiusKm(5, h, 54, 8);
    expect(d54 / d60).toBeCloseTo(2, 1);                                                  // 6 dB weaker = twice as far, in free space
    expect(radiusKm(5, h, 38, 8) / radiusKm(5, h, 44, 8)).toBeLessThan(2);                // past the horizon, 6 dB is less than a doubling
    expect(radiusKm(0, h, 60)).toBe(0);
  });

  it("is a circle for an omni antenna: the same reach in every direction", () => {
    const m = coverageModel(reference, MAPLETON)!;
    const reaches = [0, 45, 90, 180, 270].map((b) => reachKm(reference, "good", b));
    expect(new Set(reaches.map((r) => r.toFixed(3))).size).toBe(1);
    expect(m.geojson.features).toHaveLength(3);
    const ring = m.geojson.features[1].geometry.coordinates[0];
    expect(ring[0]).toEqual(ring[ring.length - 1]);                                       // closed
    expect(m.reachKm.good).toBeCloseTo(6.2, 0);
    expect(m.assumptions.join(" ")).toMatch(/Ignores terrain/);
  });

  it("stretches toward where a directional antenna points, and shrinks behind it", () => {
    const yagi: Transmitter = { ...reference, antenna: "directional", gainDbd: 6, directional: { azimuthDeg: 90, beamwidthDeg: 60, frontToBackDb: 20 } };
    expect(patternLossDb(yagi, 90)).toBe(0);
    expect(patternLossDb(yagi, 120)).toBeCloseTo(3, 5);                                    // -3 dB at the beamwidth edge
    expect(patternLossDb(yagi, 270)).toBe(20);                                             // capped at the front-to-back
    expect(reachKm(yagi, "good", 90)).toBeGreaterThan(reachKm(yagi, "good", 45));                 // 45 degrees off: about -7 dB
    expect(reachKm(yagi, "good", 45)).toBeGreaterThan(reachKm(yagi, "good", 270));               // behind: the full front-to-back loss
    expect(patternLossDb(reference, 123)).toBe(0);                                         // omni ignores any pattern
  });

  it("places the rings around the station (distances check out in both directions)", () => {
    const east = destination(MAPLETON.lat, MAPLETON.lon, 90, 10);
    expect(east.lat).toBeCloseTo(MAPLETON.lat, 1);
    expect(east.lon).toBeGreaterThan(MAPLETON.lon);
    expect(bearingTo(MAPLETON, east)).toBeCloseTo(90, 0);
    expect(bearingTo(MAPLETON, destination(MAPLETON.lat, MAPLETON.lon, 200, 5))).toBeCloseTo(200, 0);
  });
});

describe("a station's transmitter", () => {
  it("is saved when it has power and a height, with sensible defaults, and ignored otherwise", () => {
    const ok = sanitizeStation({ name: "WH", transmitter: { powerWatts: "5", heightFt: "50", antenna: "ground-plane" } });
    expect("station" in ok && ok.station.transmitter).toEqual({ antenna: "ground-plane", environment: "suburban", heightFt: 50, powerWatts: 5 });
    const noPower = sanitizeStation({ name: "WH", transmitter: { heightFt: 50 } });
    expect("station" in noPower && noPower.station.transmitter).toBeUndefined();
    const junk = sanitizeStation({ name: "WH", transmitter: { powerWatts: 5, heightFt: 50, antenna: "wire", environment: "moon", gainDbd: 999, directional: { azimuthDeg: 90, beamwidthDeg: 60 } } });
    expect("station" in junk && junk.station.transmitter).toEqual({ antenna: "ground-plane", environment: "suburban", heightFt: 50, powerWatts: 5 });
    const yagi = sanitizeStation({ name: "WH", transmitter: { powerWatts: 5, heightFt: 50, antenna: "directional", directional: { azimuthDeg: 90, beamwidthDeg: 60, frontToBackDb: 18 } } });
    expect("station" in yagi && yagi.station.transmitter?.directional).toEqual({ azimuthDeg: 90, beamwidthDeg: 60, frontToBackDb: 18 });
  });
});

describe("using the estimate: events and alerts", () => {
  const boulder = station();
  const denver = station({ id: "far", name: "Denver", lat: 39.74, lon: -104.99, transmitter: undefined, coverageKm: 20 });
  const bare = station({ id: "bare", name: "No power", lat: 40.1, lon: -105.1, transmitter: undefined });

  it("says whether an event is inside where each station is heard, from the transmitter or a typed radius", () => {
    const near = stationsNear([boulder, denver, bare], { lat: 40.03, lon: -105.27 });                // about 1.5 km from the Boulder antenna
    expect(near.map((n) => n.id)).toEqual(["wayhigh", "bare", "far"]);
    expect(near[0]).toMatchObject({ covers: true, reachKm: { strong: expect.any(Number), good: expect.any(Number), fringe: expect.any(Number) } });
    expect(near[1].covers).toBeNull();                                                               // coverage unknown
    expect(near[2].covers).toBe(false);                                                              // Denver's 20 km circle does not reach
    expect(stationsNear([boulder], { lat: 40.3, lon: -105.285 })[0].covers).toBe(false);             // 30 km north: beyond the good reach
    expect(stationReachKm(denver, 0)).toBe(20);
    expect(modelFor(boulder)?.reachKm.good).toBeCloseTo(6.2, 0);
    expect(modelFor(bare)).toBeNull();
  });

  it("probes the centre and eight points around the edge of the coverage area for alerts", () => {
    const probes = alertProbePoints(boulder);
    expect(probes).toHaveLength(9);
    expect(probes[0]).toEqual(MAPLETON);
    expect(probes.slice(1).every((p) => Math.abs(p.lat - MAPLETON.lat) < 0.1 && Math.abs(p.lon - MAPLETON.lon) < 0.1)).toBe(true);
    expect(alertProbePoints(station({ transmitter: undefined }))).toHaveLength(1);                    // nothing known: just the spot
  });

  describe("alerts at the edge of the area", () => {
    const fetchMock = vi.fn();
    beforeEach(() => { resetAlertCache(); fetchMock.mockReset(); vi.stubGlobal("fetch", fetchMock); });
    afterEach(() => vi.unstubAllGlobals());
    const future = new Date(Date.now() + 3600_000).toISOString();
    const alert = (id: string) => ({ properties: { id, event: "Flash Flood Warning", severity: "Severe", status: "Actual", messageType: "Alert", headline: "h", areaDesc: "Boulder, CO", expires: future } });

    it("finds an alert that touches only the edge, counts a shared one once, and asks nine places", async () => {
      fetchMock.mockImplementation(async (url: string) => {
        const lat = Number(decodeURIComponent(String(url).split("point=")[1]).split(",")[0]);
        return new Response(JSON.stringify({ features: [alert("everywhere"), ...(lat > MAPLETON.lat + 0.03 ? [alert("north-edge-only")] : [])] }));
      });
      const out = await activeAlerts(boulder);
      expect(out.map((a) => a.id).sort()).toEqual(["everywhere", "north-edge-only"]);
      expect(fetchMock).toHaveBeenCalledTimes(9);
    });

    it("asks once for a station with no known coverage", async () => {
      fetchMock.mockImplementation(async () => new Response(JSON.stringify({ features: [] })));
      await activeAlerts(station({ transmitter: undefined }));
      expect(fetchMock).toHaveBeenCalledTimes(1);
    });
  });
});

describe("/api/coverage", () => {
  beforeEach(() => { vi.stubEnv("ACCESS_KEY", "machine-key-0123456789"); vi.stubEnv("AUTH_DISABLED", ""); vi.stubEnv("SESSION_SECRET", ""); });
  afterEach(() => vi.unstubAllEnvs());
  const call = (method: string, path: string, body?: unknown, key: string | null = "machine-key-0123456789") =>
    handleCoverage(new Request(`http://localhost/api/coverage${path}`, { method, headers: { "content-type": "application/json", ...(key ? { "x-api-key": key } : {}) }, ...(body ? { body: JSON.stringify(body) } : {}) }));

  it("returns the model for a saved station and previews one that is being edited", async () => {
    const saved = (await (await call("GET", "?station=wayhigh")).json()) as { coverage: { reachKm: { good: number }; geojson: { features: unknown[] } }; options: { antennas: unknown[] } };
    expect(saved.coverage.reachKm.good).toBeCloseTo(6.2, 0);
    expect(saved.coverage.geojson.features).toHaveLength(3);
    expect(saved.options.antennas.length).toBeGreaterThan(3);
    const preview = (await (await call("POST", "", { ...MAPLETON, transmitter: { powerWatts: "20", heightFt: "50" } })).json()) as { coverage: { erpWatts: number } };
    expect(preview.coverage.erpWatts).toBe(20);
    expect(((await (await call("POST", "", { ...MAPLETON, transmitter: { heightFt: 50 } })).json()) as { coverage: unknown }).coverage).toBeNull();
  });

  it("needs a sign-in, a known station and a location", async () => {
    expect((await call("GET", "?station=wayhigh", undefined, null)).status).toBe(401);
    expect((await call("GET", "?station=nope")).status).toBe(404);
    expect((await call("POST", "", { transmitter: { powerWatts: 5, heightFt: 50 } })).status).toBe(400);
    expect((await call("DELETE", "")).status).toBe(405);
  });
});
