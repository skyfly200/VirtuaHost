import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

vi.mock("../../lib/gemini.js", () => ({ writeDjLine: vi.fn(), synthesizeSpeech: vi.fn(), DEFAULT_VOICE: "Kore" }));
vi.mock("../../lib/store.js", () => ({ saveClip: vi.fn(), listClips: vi.fn(async () => []) }));
vi.mock("../../lib/handoff.js", () => ({ handoffConfigured: vi.fn(() => false), handoffDefaults: vi.fn(), pushToStation: vi.fn() }));
vi.mock("../../lib/station-profile-store.js", () => ({
  getStation: vi.fn(async (id?: string) => (id === "krap" ? { id: "krap", name: "KRAP", callsign: "KRAP", tz: "America/Chicago", genres: [], links: [], skipArtists: [], connection: { kind: "none" }, variables: { sponsor: "Joe's Pizza" } } : null)),
}));

import { writeDjLine, synthesizeSpeech } from "../../lib/gemini.js";
import { handleGenerate } from "../../lib/handlers/generate.js";
import { handleTemplate } from "../../lib/handlers/template.js";

const KEY = "test-access-key-0123456789";
const post = (path: string, body: unknown) => new Request(`http://localhost${path}`, { method: "POST", body: JSON.stringify(body), headers: { "content-type": "application/json", "x-api-key": KEY } });

beforeEach(() => {
  vi.clearAllMocks();
  vi.stubEnv("ACCESS_KEY", KEY); vi.stubEnv("GEMINI_API_KEY", "gemini-test-key"); vi.stubEnv("OPENROUTER_API_KEY", ""); vi.stubEnv("PROVIDER", ""); vi.stubEnv("AUTH_DISABLED", ""); vi.stubEnv("SESSION_SECRET", "");
  vi.mocked(synthesizeSpeech).mockResolvedValue({ pcm: Buffer.alloc(480), sampleRate: 24000 } as never);
});
afterEach(() => vi.unstubAllEnvs());

describe("templates in /api/generate", () => {
  it("fills placeholders in text you wrote before it is spoken", async () => {
    const res = await handleGenerate(post("/api/generate", { mode: "say", text: "This is {{station}}, brought to you by {{sponsor|our friends}}.", station: "krap", preview: true }));
    const body = (await res.json()) as { scriptText: string };
    expect(body.scriptText).toBe("This is KRAP, brought to you by Joe's Pizza.");
    expect(vi.mocked(synthesizeSpeech).mock.calls[0][0]).toBe("This is KRAP, brought to you by Joe's Pizza.");
  });

  it("tells the writer which placeholders exist, then fills in what it wrote", async () => {
    vi.mocked(writeDjLine).mockResolvedValue("{{greeting}}, it's {{time}} on {{callsign}}! {{secret_thing}}");
    const res = await handleGenerate(post("/api/generate", { mode: "ai", prompt: "say hi", station: "krap", seconds: 10, preview: true }));
    const body = (await res.json()) as { scriptText: string; templateMissing?: string[] };
    expect(vi.mocked(writeDjLine).mock.calls[0][1]).toMatch(/Placeholders:.*\{\{time\}\}.*\{\{sponsor\}\}/);
    expect(vi.mocked(writeDjLine).mock.calls[0][1]).toMatch(/about 10 seconds when spoken/);
    expect(body.scriptText).toMatch(/^Good (morning|afternoon|evening)|^Hello, night owls/);
    expect(body.scriptText).toMatch(/it's \d{1,2}:\d{2} (AM|PM) on KRAP!$/);
    expect(body.scriptText).not.toContain("{{");
    expect(body.templateMissing).toEqual(["secret_thing"]);
  });

  it("keeps the placeholders in the written line (so it can be edited) and shows what it would say now", async () => {
    vi.mocked(writeDjLine).mockResolvedValue("It's {{time}} on {{station}}.");
    const res = await handleGenerate(post("/api/generate", { mode: "ai", prompt: "time check", station: "krap", textOnly: true }));
    const body = (await res.json()) as { scriptText: string; filledIn: string };
    expect(body.scriptText).toBe("It's {{time}} on {{station}}.");
    expect(body.filledIn).toMatch(/^It's \d{1,2}:\d{2} (AM|PM) on KRAP\.$/);
    expect(vi.mocked(synthesizeSpeech)).not.toHaveBeenCalled();
  });
});

describe("/api/template", () => {
  it("lists the variables with today's values for a station", async () => {
    const res = await handleTemplate(new Request("http://localhost/api/template?station=krap&seconds=12", { headers: { "x-api-key": KEY } }));
    const body = (await res.json()) as { variables: Array<{ name: string; value: string | null }>; syntax: unknown[] };
    const value = (n: string) => body.variables.find((v) => v.name === n)?.value;
    expect(value("station")).toBe("KRAP");
    expect(value("sponsor")).toBe("Joe's Pizza");
    expect(value("target_words")).toBe("30");
    expect(value("time")).toMatch(/^\d{1,2}:\d{2} (AM|PM)$/);
    expect(body.variables.find((v) => v.name === "weather")).toBeUndefined();       // this station has no location
    expect(body.syntax.length).toBe(3);
  });

  it("tries a text, needs a sign-in and validates", async () => {
    const ok = await handleTemplate(post("/api/template", { text: "{{pick: a | a}} at {{callsign}} {{nope}}", station: "krap" }));
    expect(await ok.json()).toEqual({ text: "a at KRAP", used: ["pick", "callsign"], missing: ["nope"] });
    expect((await handleTemplate(post("/api/template", { station: "krap" }))).status).toBe(400);
    expect((await handleTemplate(post("/api/template", { text: "x", station: "nope" }))).status).toBe(404);
    expect((await handleTemplate(new Request("http://localhost/api/template", { method: "POST", body: "{}" }))).status).toBe(401);
  });
});
