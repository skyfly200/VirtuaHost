import { describe, it, expect, vi, beforeEach } from "vitest";

const blobs = new Map<string, unknown>();
vi.mock("@netlify/blobs", () => ({
  getStore: () => ({
    list: async ({ prefix }: { prefix: string }) => ({ blobs: [...blobs.keys()].filter((k) => k.startsWith(prefix)).map((key) => ({ key })) }),
    get: async (key: string) => blobs.get(key) ?? null,
    setJSON: async (key: string, value: unknown) => { blobs.set(key, JSON.parse(JSON.stringify(value))); },
    delete: async (key: string) => { blobs.delete(key); },
  }),
}));
vi.mock("../../lib/gemini.js", () => ({ writeDjLine: vi.fn(), synthesizeSpeech: vi.fn(), DEFAULT_VOICE: "Kore" }));
vi.mock("../../lib/store.js", () => ({ saveClip: vi.fn(), getClip: vi.fn(), listClips: vi.fn() }));
vi.mock("../../lib/ai.js", async (importOriginal) => ({ ...(await importOriginal<typeof import("../../lib/ai.js")>()), complete: vi.fn(), speak: vi.fn() }));

import { complete, speak } from "../../lib/ai.js";
import { saveClip } from "../../lib/store.js";
import { handleHost } from "../../lib/handlers/host.js";
import { handleStation } from "../../lib/handlers/station.js";
import { applyHostPatch, HOST_DEFAULTS, isSkipped, templateLine, daypart } from "../../lib/host.js";

const USER_KEY = "test-access-key-0123456789";
const STATION_KEY = "station-key-0123456789abcdef";
const host = (method: string, path = "/api/host", body?: unknown) =>
  handleHost(new Request(`http://localhost${path}`, { method, headers: { "x-api-key": USER_KEY, "content-type": "application/json" }, ...(body === undefined ? {} : { body: JSON.stringify(body) }) }));
const station = (method: string, path: string, body?: unknown) =>
  handleStation(new Request(`http://localhost${path}`, { method, headers: { "x-station-key": STATION_KEY, "content-type": "application/json" }, ...(body === undefined ? {} : { body: JSON.stringify(body) }) }));

beforeEach(() => {
  blobs.clear();
  vi.clearAllMocks();
  vi.stubEnv("ACCESS_KEY", USER_KEY);
  vi.stubEnv("STATION_KEY", STATION_KEY);
  vi.stubEnv("OPENROUTER_API_KEY", "or-key");
  for (const n of ["PROVIDER", "GEMINI_API_KEY", "OPENROUTER_SPEECH_MODELS", "OPENROUTER_SPEECH_MODEL", "OPENROUTER_TEXT_MODELS", "OPENROUTER_TEXT_MODEL", "STATION_NAME"]) vi.stubEnv(n, "");
  vi.mocked(speak).mockResolvedValue({ audio: Buffer.from([1, 2, 3, 4]), mimeType: "audio/mpeg", voice: "af_heart", model: "hexgrad/kokoro-82m" });
});

describe("host rules", () => {
  it("validates and merges settings", () => {
    const next = applyHostPatch(HOST_DEFAULTS, { enabled: true, every: 99, minGapSeconds: -5, lines: "llm", fx: "underground", skipArtists: [" A ", 5], junk: 1 });
    expect(next).toMatchObject({ enabled: true, every: 50, minGapSeconds: 0, lines: "llm", fx: "underground", skipArtists: ["A", "5"] });
    expect(applyHostPatch(next, { fx: "none" }).fx).toBe("");
    expect(() => applyHostPatch(HOST_DEFAULTS, { fx: "nope" })).toThrow(/unknown effect/);
  });

  it("skips spots and fills template lines", () => {
    expect(isSkipped("Way High Radio", "Jingle", HOST_DEFAULTS)).toBe(true);
    expect(isSkipped("Ada", "", HOST_DEFAULTS)).toBe(true);
    expect(isSkipped("Ada", "Song", HOST_DEFAULTS)).toBe(false);
    const seq = [0, 0.1];   // first template, then a time-of-day line (under 0.3)
    expect(templateLine({ artist: "Ada", title: "Song", station: "Radio X", hour: 23, templates: ["{artist} - {title} on {station}."], rng: () => seq.shift() ?? 0 })).toBe("Ada - Song on Radio X. Late night, just us and the music.");
    expect(daypart(7)).toBe("morning");
  });
});

describe("host endpoints", () => {
  it("saves settings and rejects bad ones", async () => {
    expect(((await (await host("GET")).json()) as { config: { enabled: boolean } }).config.enabled).toBe(false);
    expect((await host("PUT", "/api/host", { enabled: true, every: 2 })).status).toBe(200);
    expect(((await (await host("GET")).json()) as { config: { enabled: boolean; every: number } }).config).toMatchObject({ enabled: true, every: 2 });
    expect((await host("PUT", "/api/host", { fx: "nope" })).status).toBe(400);
  });

  it("previews a link without voicing it, falling back to a template when the model fails", async () => {
    await host("PUT", "/api/host", { lines: "llm" });
    vi.mocked(complete).mockResolvedValueOnce('  Ada, "Song". Nice one.\n');
    expect(await (await host("POST", "/api/host/preview", { artist: "Ada", title: "Song" })).json()).toMatchObject({ source: "llm" });
    vi.mocked(complete).mockRejectedValueOnce(new Error("boom"));
    const fallback = (await (await host("POST", "/api/host/preview", { artist: "Ada", title: "Song" })).json()) as { source: string; text: string; note: string };
    expect(fallback.source).toBe("template");
    expect(fallback.text).toContain("Ada");
    expect(fallback.note).toMatch(/boom/);
    expect(speak).not.toHaveBeenCalled();
    expect((await host("POST", "/api/host/preview", {})).status).toBe(400);
  });

  it("writes and voices a link for the station, using the persona and settings, and refuses when off or skipped", async () => {
    expect((await station("POST", "/api/station/host/link", { artist: "Ada", title: "Song" })).status).toBe(409);   // off by default
    await host("PUT", "/api/host", { enabled: true, fx: "hull", preempt: true });

    expect((await station("POST", "/api/station/host/link", { artist: "Way High Radio", title: "Jingle" })).status).toBe(409);
    const res = await station("POST", "/api/station/host/link", { artist: "Ada", title: "Song" });
    expect(res.status).toBe(200);
    const body = (await res.json()) as { clipId: string; text: string; audioUrl: string; fx: string; preempt: boolean };
    expect(body).toMatchObject({ audioUrl: `/api/station/clips/${body.clipId}`, fx: "hull", preempt: true });
    expect(body.text).toContain("Ada");
    const spoken = vi.mocked(speak).mock.calls[0][0];
    expect(spoken.tone).toContain("weathered");        // the default persona is CHIP
    expect(vi.mocked(saveClip).mock.calls[0][2]).toMatchObject({ id: body.clipId, format: "host-link", input: "host link: Ada - Song" });
  });

  it("stores the daemon's status, trimmed to known fields, and shows it to users", async () => {
    expect((await station("POST", "/api/station/host/status", { current: { artist: "Ada", title: "Song", extra: "x" }, counters: { played: 2, prepared: "3" }, secret: "no" })).status).toBe(200);
    const { status } = (await (await host("GET")).json()) as { status: Record<string, unknown> };
    expect(status).toMatchObject({ current: { artist: "Ada", title: "Song" }, counters: { played: 2, prepared: 3, skipped: 0, failed: 0 } });
    expect(status).not.toHaveProperty("secret");
    expect(status.reportedAt).toBeTruthy();
  });
});
