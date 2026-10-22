import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

vi.mock("../../lib/gemini.js", () => ({ writeDjLine: vi.fn(), synthesizeSpeech: vi.fn(), DEFAULT_VOICE: "Kore" }));
vi.mock("../../lib/store.js", () => ({ saveClip: vi.fn(), listClips: vi.fn(async () => []), getClip: vi.fn() }));
vi.mock("../../lib/handoff.js", () => ({ handoffConfigured: vi.fn(() => false), handoffDefaults: vi.fn(), pushToStation: vi.fn() }));
vi.mock("../../lib/station-profile-store.js", () => ({
  getStation: vi.fn(async (id?: string) => (id === "glr" ? { id: "glr", name: "Green Light Radio", tz: "America/Denver", genres: [], links: [], skipArtists: [], connection: { kind: "none" } } : null)),
}));
const PERSONAS: Record<string, unknown> = {
  rocky: { id: "rocky", name: "Rocky", instructions: "A gruff old DJ.", tone: "gravelly", voice: "Puck", templates: [], tags: [], promos: [], signOffs: [], stationIds: [] },
  britta: { id: "britta", name: "Britta", instructions: "A bright co-host.", tone: "bright", voice: "Kore", templates: [], tags: [], promos: [], signOffs: [], stationIds: [] },
};
vi.mock("../../lib/persona-store.js", () => ({ getPersona: vi.fn(async (id: string) => PERSONAS[id] ?? null) }));
const SCRIPTS = new Map<string, unknown>();
vi.mock("../../lib/script-store.js", () => ({ getScript: vi.fn(async (id: string) => SCRIPTS.get(id) ?? null), SCRIPT_ID: /^[a-z0-9][a-z0-9-]{0,59}$/ }));

import { writeDjLine, synthesizeSpeech } from "../../lib/gemini.js";
import { saveClip } from "../../lib/store.js";
import { handleGenerate } from "../../lib/handlers/generate.js";
import { runSchedule } from "../../lib/scheduler.js";
import { sanitizeContent, type Schedule } from "../../lib/schedule.js";
import { parseWav } from "../../lib/audio-join.js";

const KEY = "test-access-key-0123456789";
const post = (body: unknown) => new Request("http://localhost/api/generate", { method: "POST", body: JSON.stringify(body), headers: { "content-type": "application/json", "x-api-key": KEY } });
const cast = [{ name: "Rocky", personaId: "rocky" }, { name: "Britta", personaId: "britta" }];
const TEXT = "Rocky: Welcome back to {{station}}.\nBritta: Glad to be here, Rocky.";

beforeEach(() => {
  vi.clearAllMocks(); SCRIPTS.clear();
  vi.stubEnv("ACCESS_KEY", KEY); vi.stubEnv("GEMINI_API_KEY", "g"); vi.stubEnv("OPENROUTER_API_KEY", ""); vi.stubEnv("PROVIDER", ""); vi.stubEnv("AUTH_DISABLED", "");
  vi.mocked(synthesizeSpeech).mockResolvedValue({ pcm: Buffer.alloc(2400, 1), sampleRate: 24000 } as never);
});
afterEach(() => vi.unstubAllEnvs());

describe("POST /api/generate mode script", () => {
  it("speaks each line in its speaker's voice and joins the lines (with a real gap) into one clip", async () => {
    const res = await handleGenerate(post({ mode: "script", cast, text: TEXT, gapSeconds: 0.5, station: "glr", preview: true }));
    expect(res.status).toBe(200);
    const body = (await res.json()) as { audio: string; lines: number; filledIn: string; gapApplied: boolean };
    expect(body.lines).toBe(2);
    expect(body.gapApplied).toBe(true);
    expect(body.filledIn).toBe("Rocky: Welcome back to Green Light Radio.\nBritta: Glad to be here, Rocky.");
    const calls = vi.mocked(synthesizeSpeech).mock.calls;
    expect(calls.map((c) => c[1]).sort()).toEqual(["Kore", "Puck"]);                          // each persona's own voice
    const wav = parseWav(Buffer.from(body.audio, "base64"));
    expect(wav?.pcm.length).toBe(2400 * 2 + 0.5 * 24000 * 2);                                 // two lines + half a second of silence
    expect(vi.mocked(saveClip)).not.toHaveBeenCalled();
  });

  it("saves the joined clip when it is not a preview", async () => {
    const res = await handleGenerate(post({ mode: "script", cast, text: TEXT }));
    expect(res.status).toBe(201);
    expect(vi.mocked(saveClip)).toHaveBeenCalledTimes(1);
    expect(vi.mocked(saveClip).mock.calls[0][2]).toMatchObject({ mode: "script", info: { kind: "conversation" } });
  });

  it("uses a saved script, and the text sent with it wins", async () => {
    SCRIPTS.set("two-hosts", { id: "two-hosts", name: "Two hosts", kind: "conversation", cast, text: "Rocky: Saved line.\nBritta: Reply.", gapSeconds: 0, topic: "", tags: [], notes: "" });
    const saved = (await (await handleGenerate(post({ mode: "script", scriptId: "two-hosts", preview: true }))).json()) as { filledIn: string };
    expect(saved.filledIn).toContain("Saved line.");
    const over = (await (await handleGenerate(post({ mode: "script", scriptId: "two-hosts", text: "Rocky: Other.\nBritta: Yes.", preview: true }))).json()) as { filledIn: string };
    expect(over.filledIn).toContain("Other.");
    expect((await handleGenerate(post({ mode: "script", scriptId: "nope" }))).status).toBe(404);
  });

  it("refuses more than four speakers, a speaker outside the cast, an unknown persona and empty text", async () => {
    const five = ["A", "B", "C", "D", "E"].map((name) => ({ name }));
    const r5 = await handleGenerate(post({ mode: "script", cast: five, text: "A: hi\nB: yo" }));
    expect(r5.status).toBe(400);
    expect(((await r5.json()) as { error: string }).error).toMatch(/at most 4/);
    const stray = await handleGenerate(post({ mode: "script", cast, text: "Rocky: Hi.\nCarl: Who am I?" }));
    expect(stray.status).toBe(400);
    expect(((await stray.json()) as { error: string }).error).toMatch(/"Carl" is not in the cast/);
    expect((await handleGenerate(post({ mode: "script", cast: [{ name: "Rocky", personaId: "ghost" }, { name: "B" }], text: "Rocky: Hi.\nB: Hey." }))).status).toBe(400);
    expect((await handleGenerate(post({ mode: "script", cast, text: "  " }))).status).toBe(400);
    expect(vi.mocked(synthesizeSpeech)).not.toHaveBeenCalled();
  });

  it("names the line when speech fails", async () => {
    vi.mocked(synthesizeSpeech).mockResolvedValueOnce({ pcm: Buffer.alloc(100), sampleRate: 24000 } as never).mockRejectedValueOnce(new Error("busy"));
    const res = await handleGenerate(post({ mode: "script", cast, text: TEXT, preview: true }));
    expect(res.status).toBe(502);
    expect(((await res.json()) as { error: string }).error).toMatch(/Line \d \((Rocky|Britta)\)/);
  });
});

describe("schedules with a saved script", () => {
  const schedule = (content: Schedule["content"]): Schedule => ({ id: "s1", name: "Morning banter", enabled: true, when: { type: "interval", everyMinutes: 60 }, content, personaId: "", voice: "", speechModel: "", tone: "", send: "none", preempt: false, fx: "", count: 0, runs: 0, nextAt: null, createdAt: new Date().toISOString(), stationId: "glr" });

  it("validates the content kind", () => {
    expect(sanitizeContent({ kind: "script", scriptId: "two-hosts", fresh: true })).toEqual({ kind: "script", scriptId: "two-hosts", fresh: true });
    expect(sanitizeContent({ kind: "script", scriptId: "two-hosts" })).toEqual({ kind: "script", scriptId: "two-hosts" });
    expect(() => sanitizeContent({ kind: "script", scriptId: "Bad Id!" })).toThrow(/saved script/);
  });

  it("speaks the saved text (placeholders filled in at run time) as one saved clip", async () => {
    SCRIPTS.set("two-hosts", { id: "two-hosts", name: "Two hosts", kind: "conversation", cast, text: TEXT, gapSeconds: 0.3, topic: "", tags: [], notes: "" });
    expect(await runSchedule(schedule({ kind: "script", scriptId: "two-hosts" }))).toBe("saved");
    const meta = vi.mocked(saveClip).mock.calls[0][2];
    expect(meta.scriptText).toContain("Welcome back to Green Light Radio.");
    expect(meta.info).toMatchObject({ source: "schedule" });
    expect(vi.mocked(synthesizeSpeech)).toHaveBeenCalledTimes(2);
  });

  it("with fresh: true the AI drafts a new conversation from the topic and cast every run", async () => {
    SCRIPTS.set("two-hosts", { id: "two-hosts", name: "Two hosts", kind: "conversation", cast, text: "old text", gapSeconds: 0, topic: "argue about pineapple on pizza", tags: [], notes: "" });
    vi.mocked(writeDjLine).mockResolvedValue("Rocky: Pineapple belongs nowhere near a pizza.\nBritta: You say that every week, Rocky.");
    await runSchedule(schedule({ kind: "script", scriptId: "two-hosts", fresh: true }));
    expect(vi.mocked(writeDjLine).mock.calls[0][1]).toContain("A gruff old DJ.");            // the cast's persona briefs reach the writer
    expect(vi.mocked(saveClip).mock.calls[0][2].scriptText).toContain("Pineapple belongs nowhere");
  });

  it("fails clearly when the script was deleted or has no topic to draft from", async () => {
    await expect(runSchedule(schedule({ kind: "script", scriptId: "gone" }))).rejects.toThrow(/deleted/);
    SCRIPTS.set("no-topic", { id: "no-topic", name: "x", kind: "conversation", cast, text: "Rocky: a\nBritta: b", gapSeconds: 0, topic: "", tags: [], notes: "" });
    await expect(runSchedule(schedule({ kind: "script", scriptId: "no-topic", fresh: true }))).rejects.toThrow(/no topic/);
  });
});
