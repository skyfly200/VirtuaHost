import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { activeAlerts, normalizeAlert, resetAlertCache } from "../../lib/alerts.js";
import { renderTemplate, availableVariables, contextFor, resetWeatherCache } from "../../lib/drop-template.js";
import { handleAlerts } from "../../lib/handlers/alerts.js";
import type { Station } from "../../lib/station-profile.js";

vi.mock("../../lib/station-profile-store.js", () => ({
  getStation: vi.fn(async (id?: string) => (id === "krap" ? { id: "krap", name: "KRAP", tz: "America/Chicago", genres: [], links: [], skipArtists: [], connection: { kind: "none" }, lat: 29.76, lon: -95.37 } : id === "nowhere" ? { id: "nowhere", name: "N", tz: "UTC", genres: [], links: [], skipArtists: [], connection: { kind: "none" } } : null)),
}));

const station: Station = { id: "krap", name: "KRAP", tz: "America/Chicago", genres: [], links: [], skipArtists: [], connection: { kind: "none" }, lat: 29.76, lon: -95.37 };
const future = new Date(Date.now() + 3600_000).toISOString();
const feat = (over: Record<string, unknown> = {}) => ({ properties: { id: "urn:1", event: "Tornado Warning", severity: "Extreme", status: "Actual", messageType: "Alert", headline: "Tornado Warning until 5PM", areaDesc: "Harris, TX", expires: future, ...over } });
const fetchMock = vi.fn();
const nws = (...features: object[]) => fetchMock.mockImplementation(async () => new Response(JSON.stringify({ features })));

beforeEach(() => { resetAlertCache(); resetWeatherCache(); fetchMock.mockReset(); vi.stubGlobal("fetch", fetchMock); vi.stubEnv("ALERTS_CONTACT", "ops@example.com"); vi.stubEnv("ALERT_MIN_SEVERITY", ""); vi.stubEnv("ACCESS_KEY", "machine-key-0123456789"); vi.stubEnv("AUTH_DISABLED", ""); vi.stubEnv("SESSION_SECRET", ""); });
afterEach(() => { vi.unstubAllEnvs(); vi.unstubAllGlobals(); });

describe("normalizeAlert", () => {
  it("drops test, exercise, cancelled and expired alerts, and unknown severities become Unknown", () => {
    expect(normalizeAlert(feat())).toMatchObject({ id: "urn:1", event: "Tornado Warning", severity: "Extreme", area: "Harris, TX" });
    expect(normalizeAlert(feat({ status: "Test" }))).toBeNull();
    expect(normalizeAlert(feat({ status: "Exercise" }))).toBeNull();
    expect(normalizeAlert(feat({ messageType: "Cancel" }))).toBeNull();
    expect(normalizeAlert(feat({ expires: "2020-01-01T00:00:00Z" }))).toBeNull();
    expect(normalizeAlert(feat({ severity: "Odd" }))?.severity).toBe("Unknown");
  });
});

describe("activeAlerts", () => {
  it("asks the NWS for the station's point with a User-Agent, most serious first, Moderate and up by default", async () => {
    nws(feat({ id: "a", event: "Flood Advisory", severity: "Minor" }), feat({ id: "b", event: "Flood Watch", severity: "Moderate" }), feat({ id: "c" }));
    const out = await activeAlerts(station);
    expect(out.map((a) => a.event)).toEqual(["Tornado Warning", "Flood Watch"]);
    const [url, opts] = fetchMock.mock.calls[0];
    expect(String(url)).toBe("https://api.weather.gov/alerts/active?point=29.76%2C-95.37");
    expect(opts.headers["user-agent"]).toContain("ops@example.com");
    expect((await activeAlerts(station, "Minor")).length).toBe(3);
    expect(fetchMock).toHaveBeenCalledTimes(1);                                 // cached for a minute
  });

  it("gives [] with no location or when the NWS cannot be reached", async () => {
    expect(await activeAlerts(null)).toEqual([]);
    fetchMock.mockRejectedValue(new Error("offline"));
    expect(await activeAlerts(station)).toEqual([]);
  });
});

describe("the {{alert}} placeholders", () => {
  it("fill in from the most serious alert, and fall back when there is none", async () => {
    nws(feat());
    const ctx = contextFor({ station });
    expect((await renderTemplate("Heads up: {{alert}} for {{alert_area}} ({{alert_count}}).", ctx)).text).toBe("Heads up: Tornado Warning for Harris, TX (1).");
    resetAlertCache(); nws();
    expect((await renderTemplate("{{alert|All quiet}}", ctx)).text).toBe("All quiet");
    expect((await renderTemplate("A: {{alert}}", ctx))).toMatchObject({ text: "A:", missing: ["alert"] });
  });

  it("only asks the NWS when a template uses an alert placeholder, and only for stations with a location", async () => {
    nws();
    await renderTemplate("{{time}}", contextFor({ station }));
    expect(fetchMock).not.toHaveBeenCalled();
    expect(availableVariables(contextFor({ station: { ...station, lat: undefined, lon: undefined } })).map((v) => v.name)).not.toContain("alert");
    expect(availableVariables(contextFor({ station })).map((v) => v.name)).toEqual(expect.arrayContaining(["alert", "alert_headline", "alert_area", "alert_count"]));
  });
});

describe("GET /api/alerts", () => {
  const get = (q: string, key: string | null = "machine-key-0123456789") => handleAlerts(new Request(`http://localhost/api/alerts${q}`, { headers: key ? { "x-api-key": key } : {} }));
  it("lists the alerts for a station, and explains what is missing", async () => {
    nws(feat());
    const ok = (await (await get("?station=krap")).json()) as { alerts: Array<{ event: string }> };
    expect(ok.alerts[0].event).toBe("Tornado Warning");
    expect((await get("?station=nowhere")).status).toBe(400);
    expect((await get("?station=missing")).status).toBe(404);
    expect((await get("?station=krap&min=Bad")).status).toBe(400);
    expect((await get("?station=krap", null)).status).toBe(401);
    expect((await handleAlerts(new Request("http://localhost/api/alerts", { method: "POST", headers: { "x-api-key": "machine-key-0123456789" } }))).status).toBe(405);
  });
});
