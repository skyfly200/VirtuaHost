import { describe, it, expect, vi, beforeEach } from "vitest";

const blobs = new Map<string, unknown>();
vi.mock("@netlify/blobs", () => ({
  getStore: () => ({
    list: async ({ prefix }: { prefix: string }) => ({ blobs: [...blobs.keys()].filter((k) => k.startsWith(prefix)).sort().map((key) => ({ key })) }),
    get: async (key: string) => blobs.get(key) ?? null,
    setJSON: async (key: string, value: unknown) => { blobs.set(key, JSON.parse(JSON.stringify(value))); },
    delete: async (key: string) => { blobs.delete(key); },
  }),
}));
const clipList = vi.fn(async () => [] as unknown[]);
vi.mock("../../lib/store.js", () => ({ saveClip: vi.fn(), getClip: vi.fn(), listClips: (...a: unknown[]) => clipList(...(a as [])) }));
vi.mock("../../lib/gemini.js", () => ({ writeDjLine: vi.fn(), synthesizeSpeech: vi.fn(), DEFAULT_VOICE: "Kore" }));
vi.mock("../../lib/handoff.js", () => ({ handoffConfigured: vi.fn(() => false), handoffDefaults: vi.fn(() => ({ play: false, preempt: false })), pushToStation: vi.fn() }));
vi.mock("../../lib/openrouter.js", async (importOriginal) => ({ ...(await importOriginal<typeof import("../../lib/openrouter.js")>()), chat: vi.fn(async () => "Written."), speech: vi.fn(async () => ({ audio: Buffer.from([1, 2, 3, 4]), format: "mp3" })) }));

import { handleStations } from "../../lib/handlers/stations.js";
import { handleGenerate } from "../../lib/handlers/generate.js";
import { sanitizeStation } from "../../lib/station-profile.js";
import { enqueue, claimNext } from "../../lib/queue-store.js";
import { chat, speech } from "../../lib/openrouter.js";

const KEY = "test-access-key-0123456789";
const call = (method: string, id?: string, body?: unknown, action?: string) =>
  handleStations(new Request(`http://localhost/api/stations${id ? `/${id}` : ""}${action ? `/${action}` : ""}`, { method, headers: { "x-api-key": KEY, "content-type": "application/json" }, ...(body === undefined ? {} : { body: JSON.stringify(body) }) }), id, action);

beforeEach(() => {
  blobs.clear();
  vi.clearAllMocks();
  vi.stubEnv("ACCESS_KEY", KEY);
  vi.stubEnv("OPENROUTER_API_KEY", "or-key");
  for (const n of ["PROVIDER", "GEMINI_API_KEY", "OPENROUTER_TEXT_MODELS", "OPENROUTER_SPEECH_MODELS", "OPENROUTER_SPEECH_MODEL", "OPENROUTER_TEXT_MODEL", "STATION_AUTOPLAY", "STATION_PREEMPT", "STATION_FX"]) vi.stubEnv(n, "");
  vi.stubEnv("STATION_NAME", "Fallback FM");
});

describe("station profiles", () => {
  it("cleans a profile: bounded fields, a valid zone, http links only", () => {
    const out = sanitizeStation({ name: " KRAP ", callsign: "KRAP", frequency: "97.7 FM", tz: "America/New_York", color: "#ABCDEF", genres: ["Punk", "punk", " Jazz "], website: "https://krap.test", streamUrl: "javascript:alert(1)",
      links: [{ label: "Chat", url: "https://chat.test" }, { label: "Bad", url: "ftp://x" }], connection: { kind: "radiodj", hubStationId: "krap-1" }, skipArtists: ["Spot", ""], junk: 1 });
    expect(out).toEqual({ station: { name: "KRAP", tz: "America/New_York", callsign: "KRAP", frequency: "97.7 FM", color: "#abcdef", genres: ["punk", "jazz"], website: "https://krap.test", links: [{ label: "Chat", url: "https://chat.test" }], skipArtists: ["Spot"], connection: { kind: "radiodj", hubStationId: "krap-1" } } });
    expect(sanitizeStation({ name: "X", tz: "Mars/Base" })).toMatchObject({ error: expect.stringContaining("time zone") });
    expect(sanitizeStation({})).toMatchObject({ error: expect.stringContaining("name") });
    expect(sanitizeStation({ name: "X", connection: { kind: "bogus" } })).toMatchObject({ station: { connection: { kind: "none" } } });
  });

  it("offers a placeholder until you make stations, then lists yours", async () => {
    const first = (await (await call("GET")).json()) as { stations: Array<{ id: string; name: string; builtin?: boolean }> };
    expect(first.stations).toEqual([expect.objectContaining({ id: "default", name: "Fallback FM", builtin: true })]);
    expect((await call("PUT", "default", { name: "x" })).status).toBe(403);

    const made = await call("POST", undefined, { name: "Way High Radio", tz: "America/Denver", frequency: "90.5 FM", tagline: "Taking radio higher" });
    expect(made.status).toBe(201);
    const { station } = (await made.json()) as { station: { id: string } };
    expect(station.id).toMatch(/^way-high-radio-[0-9a-f]{4}$/);
    expect(((await (await call("GET")).json()) as { stations: Array<{ name: string }> }).stations.map((s) => s.name)).toEqual(["Way High Radio"]);
    expect((await call("PUT", station.id, { name: "Way High", tz: "America/Denver" })).status).toBe(200);
    expect((await call("DELETE", station.id)).status).toBe(204);
    expect((await call("GET", station.id)).status).toBe(404);
  });

  it("summarises what the site holds for a station", async () => {
    const { station } = (await (await call("POST", undefined, { name: "KRAP" })).json()) as { station: { id: string } };
    clipList.mockResolvedValue([{ info: { station: station.id, kind: "promo" } }, { info: { station: station.id } }, { info: { station: "other" } }, {}]);
    await enqueue({ clipId: "c", title: "t", play: true, preempt: false, info: { station: station.id } });
    await enqueue({ clipId: "c", title: "t", play: true, preempt: false, info: { station: "other" } });
    expect(await (await call("GET", station.id, undefined, "summary")).json()).toMatchObject({ clips: 2, promos: 1, schedules: 0, queued: 1 });
  });
});

describe("the station in use", () => {
  it("names the station in AI-written lines and fills in its defaults, then tags the clip with it", async () => {
    const { station } = (await (await call("POST", undefined, { name: "Way High Radio", tagline: "Taking radio higher", defaultPersonaId: "chip", defaultVoice: "af_heart", defaultFx: "hull" })).json()) as { station: { id: string } };
    const res = await handleGenerate(new Request("http://localhost/api/generate", { method: "POST", headers: { "x-api-key": KEY, "content-type": "application/json" }, body: JSON.stringify({ mode: "ai", prompt: "next song", station: station.id }) }));
    expect(res.status).toBe(201);
    const system = vi.mocked(chat).mock.calls[0][0].system;
    expect(system).toContain("Way High Radio");
    expect(system).toContain('tagline is "Taking radio higher"');
    expect(system).toContain("Your character: You are CHIP");                // the station's default persona
    expect(vi.mocked(speech).mock.calls[0][0]).toMatchObject({ voice: "af_heart" });
    const saved = (await import("../../lib/store.js")).saveClip as ReturnType<typeof vi.fn>;
    expect(saved.mock.calls[0][2].info).toMatchObject({ station: station.id, persona: "chip" });
    expect((await handleGenerate(new Request("http://localhost/api/generate", { method: "POST", headers: { "x-api-key": KEY, "content-type": "application/json" }, body: JSON.stringify({ mode: "say", text: "x", station: "nope" }) }))).status).toBe(400);
  });

  it("lets each station's daemon collect only its own queue items", async () => {
    await enqueue({ clipId: "c", title: "for A", play: true, preempt: false, info: { station: "a" } });
    await new Promise((r) => setTimeout(r, 4));
    await enqueue({ clipId: "c", title: "for anyone", play: true, preempt: false });
    await new Promise((r) => setTimeout(r, 4));
    await enqueue({ clipId: "c", title: "for B", play: true, preempt: false, info: { station: "b" } });
    expect((await claimNext(Date.now(), "b"))?.title).toBe("for anyone");        // not A's
    expect((await claimNext(Date.now(), "b"))?.title).toBe("for B");
    expect(await claimNext(Date.now(), "b")).toBeNull();
    expect((await claimNext(Date.now(), "a"))?.title).toBe("for A");
  });
});

describe("per-station settings", () => {
  it("keeps the virtual host's settings and status separate for each station", async () => {
    const { handleHost } = await import("../../lib/handlers/host.js");
    const { handleStation } = await import("../../lib/handlers/station.js");
    vi.stubEnv("STATION_KEY", "station-key-0123456789abcdef");
    const mk = async (name: string, extra: object = {}) => ((await (await call("POST", undefined, { name, ...extra })).json()) as { station: { id: string } }).station.id;
    const a = await mk("Alpha", { defaultPersonaId: "night-owl", defaultFx: "hull", skipArtists: ["Alpha Spot"] });
    const b = await mk("Beta");
    const host = (method: string, station: string | null, body?: unknown, path = "/api/host") => handleHost(new Request(`http://localhost${path}${station ? `?station=${station}` : ""}`, { method, headers: { "x-api-key": KEY, "content-type": "application/json" }, ...(body === undefined ? {} : { body: JSON.stringify(body) }) }));

    // a station's own profile is where its host starts
    const start = (await (await host("GET", a)).json()) as { config: { personaId: string; fx: string; skipArtists: string[]; enabled: boolean } };
    expect(start.config).toMatchObject({ personaId: "night-owl", fx: "hull", skipArtists: ["Alpha Spot"], enabled: false });
    expect(((await (await host("GET", b)).json()) as { config: { personaId: string } }).config.personaId).toBe("chip");

    // changing one leaves the other alone
    await host("PUT", a, { enabled: true, every: 4 });
    expect(((await (await host("GET", a)).json()) as { config: { enabled: boolean; every: number } }).config).toMatchObject({ enabled: true, every: 4 });
    expect(((await (await host("GET", b)).json()) as { config: { enabled: boolean; every: number } }).config).toMatchObject({ enabled: false, every: 1 });
    expect((await host("GET", "nope-0000")).status).toBe(404);

    // the daemon for each station sees its own settings and reports its own status
    const daemon = (method: string, path: string, station: string, body?: unknown) => handleStation(new Request(`http://localhost${path}?station=${station}`, { method, headers: { "x-station-key": "station-key-0123456789abcdef", "content-type": "application/json" }, ...(body === undefined ? {} : { body: JSON.stringify(body) }) }));
    expect(((await (await daemon("GET", "/api/station/host", a)).json()) as { config: { every: number } }).config.every).toBe(4);
    expect(((await (await daemon("GET", "/api/station/host", b)).json()) as { config: { every: number } }).config.every).toBe(1);
    await daemon("POST", "/api/station/host/status", a, { current: { artist: "X", title: "Song A" } });
    expect(((await (await host("GET", a)).json()) as { status: { current: { title: string } } }).status.current.title).toBe("Song A");
    expect(((await (await host("GET", b)).json()) as { status: unknown }).status).toBeNull();
  });

  it("applies a station's own send defaults to its clips", async () => {
    vi.stubEnv("STATION_MODE", "queue");
    const { sendToStation } = await import("../../lib/station-send.js");
    const mk = async (extra: object) => (await import("../../lib/station-profile-store.js")).getStation(((await (await call("POST", undefined, { name: "S", ...extra })).json()) as { station: { id: string } }).station.id);
    const loud = await mk({ autoplay: true, preempt: true, defaultFx: "hull" });
    const quiet = await mk({});
    await sendToStation({ clipId: "c", audio: Buffer.from([1]), mimeType: "audio/wav", title: "loud", station: loud });
    await sendToStation({ clipId: "c", audio: Buffer.from([1]), mimeType: "audio/wav", title: "quiet", station: quiet });
    await sendToStation({ clipId: "c", audio: Buffer.from([1]), mimeType: "audio/wav", title: "asked", station: loud, play: false, preempt: false });   // a request wins
    const { listQueue } = await import("../../lib/queue-store.js");
    const byTitle = Object.fromEntries((await listQueue()).map((i) => [i.title, [i.play, i.preempt, i.fx]]));
    expect(byTitle).toEqual({ loud: [true, true, "hull"], quiet: [false, false, undefined], asked: [false, false, "hull"] });
  });
});
