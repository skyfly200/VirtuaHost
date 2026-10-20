import { describe, it, expect, vi, beforeEach } from "vitest";

vi.mock("../../lib/gemini.js", () => ({ writeDjLine: vi.fn(), synthesizeSpeech: vi.fn(), DEFAULT_VOICE: "Kore" }));
vi.mock("../../lib/store.js", () => ({ saveClip: vi.fn() }));
vi.mock("../../lib/persona-store.js", async () => {
  const { BUILTIN_PERSONAS } = await import("../../lib/personas.js");
  return { getPersona: vi.fn(async (id: string) => BUILTIN_PERSONAS.find((p) => p.id === id) ?? null) };
});
vi.mock("../../lib/handoff.js", () => ({ handoffConfigured: vi.fn(), handoffDefaults: vi.fn(), pushToStation: vi.fn() }));
// Real model configuration, but no network: only the two calls to OpenRouter are replaced.
vi.mock("../../lib/openrouter.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../../lib/openrouter.js")>()),
  chat: vi.fn(),
  speech: vi.fn(),
}));

import { writeDjLine, synthesizeSpeech } from "../../lib/gemini.js";
import { saveClip } from "../../lib/store.js";
import { handoffConfigured, handoffDefaults, pushToStation } from "../../lib/handoff.js";
import { chat, speech } from "../../lib/openrouter.js";
import { handleGenerate } from "../../lib/handlers/generate.js";
import { handleOptions } from "../../lib/handlers/options.js";

const KEY = "test-access-key-0123456789";
const mockedChat = vi.mocked(chat);
const mockedSpeech = vi.mocked(speech);
const mockedSave = vi.mocked(saveClip);

const post = (body: unknown) =>
  new Request("http://localhost/api/generate", { method: "POST", body: JSON.stringify(body), headers: { "content-type": "application/json", "x-api-key": KEY } });

interface Body { error?: string; provider?: string; speechModel?: string; textModel?: string; scriptText?: string }

beforeEach(() => {
  vi.clearAllMocks();
  vi.stubEnv("ACCESS_KEY", KEY);
  vi.stubEnv("OPENROUTER_API_KEY", "or-key");
  vi.stubEnv("GEMINI_API_KEY", "");
  vi.stubEnv("PROVIDER", "");
  for (const name of ["OPENROUTER_TEXT_MODEL", "OPENROUTER_TEXT_MODELS", "OPENROUTER_SPEECH_MODEL", "OPENROUTER_SPEECH_MODELS", "OPENROUTER_VOICE", "OPENROUTER_ALLOW_ANY_MODEL", "STATION_NAME"]) vi.stubEnv(name, "");
  vi.mocked(handoffConfigured).mockReturnValue(false);
  vi.mocked(handoffDefaults).mockReturnValue({ play: false, preempt: false });
  mockedSave.mockResolvedValue(undefined);
  mockedChat.mockResolvedValue("Written by the model.");
  mockedSpeech.mockResolvedValue({ audio: Buffer.from([9, 9, 9, 9]), format: "mp3" });
});

describe("generate with OpenRouter", () => {
  it("uses OpenRouter for both writing and speech when its key is set", async () => {
    const res = await handleGenerate(post({ mode: "ai", prompt: "hype friday" }));
    const body = (await res.json()) as Body;

    expect(res.status).toBe(201);
    expect(body).toMatchObject({ provider: "openrouter", scriptText: "Written by the model.", textModel: "openai/gpt-4o-mini", speechModel: "google/gemini-3.1-flash-tts-preview" });
    expect(writeDjLine).not.toHaveBeenCalled();
    expect(synthesizeSpeech).not.toHaveBeenCalled();
    expect(mockedChat.mock.calls[0][0]).toMatchObject({ model: "openai/gpt-4o-mini", prompt: "hype friday" });
  });

  it("uses the models, voice and tone the request names", async () => {
    vi.stubEnv("OPENROUTER_TEXT_MODELS", "a/writer,b/writer");
    vi.stubEnv("OPENROUTER_SPEECH_MODELS", "x/tts|Nova,y/tts");
    const res = await handleGenerate(post({ mode: "ai", prompt: "intro", textModel: "b/writer", speechModel: "y/tts", voice: "Puck", tone: "  warm,   slow \n", format: "song-intro" }));

    expect(res.status).toBe(201);
    expect(mockedChat.mock.calls[0][0].model).toBe("b/writer");
    const system = mockedChat.mock.calls[0][0].system;
    expect(system).toContain("Tone: warm, slow.");                       // cleaned up
    expect(system).toContain("Song intro");                              // the format's structure hint reaches the model
    expect(mockedSpeech.mock.calls[0][0]).toMatchObject({ model: "y/tts", voice: "Puck", tone: "warm, slow", text: "Written by the model." });
    const [id, , metadata] = mockedSave.mock.calls[0];
    expect(metadata).toMatchObject({ id, provider: "openrouter", textModel: "b/writer", speechModel: "y/tts", voice: "Puck", tone: "warm, slow", format: "song-intro", mimeType: "audio/mpeg" });
  });

  it("uses the speech model's own voice by default, and say mode skips the writing model", async () => {
    vi.stubEnv("OPENROUTER_SPEECH_MODELS", "x/tts|Nova");
    await handleGenerate(post({ mode: "say", text: "Exactly this" }));
    expect(mockedChat).not.toHaveBeenCalled();
    expect(mockedSpeech.mock.calls[0][0]).toMatchObject({ model: "x/tts", voice: "Nova", text: "Exactly this" });
  });

  it("removes delivery tags for a model that cannot perform them, and keeps them for Gemini", async () => {
    vi.stubEnv("OPENROUTER_SPEECH_MODELS", "hexgrad/kokoro-82m|af_heart,google/gemini-3.1-flash-tts-preview|Kore");
    const kokoro = (await (await handleGenerate(post({ mode: "say", text: "Hi [laughs] there", speechModel: "hexgrad/kokoro-82m", tone: "warm" }))).json()) as Record<string, unknown>;
    expect(mockedSpeech.mock.calls[0][0].text).toBe("Hi there");
    expect(kokoro).toMatchObject({ cueTagsRemoved: true, toneIgnored: true });

    await handleGenerate(post({ mode: "say", text: "Hi [laughs] there", speechModel: "google/gemini-3.1-flash-tts-preview" }));
    expect(mockedSpeech.mock.calls[1][0].text).toBe("Hi [laughs] there");
  });

  it("returns audio without saving or sending it when asked for a preview", async () => {
    vi.mocked(handoffConfigured).mockReturnValue(true);
    const res = await handleGenerate(post({ mode: "say", text: "Just listening", preview: true }));
    const body = (await res.json()) as Record<string, unknown>;
    expect(res.status).toBe(200);
    expect(body).toMatchObject({ preview: true, scriptText: "Just listening", audio: Buffer.from([9, 9, 9, 9]).toString("base64"), mimeType: "audio/mpeg" });
    expect(mockedSave).not.toHaveBeenCalled();
    expect(pushToStation).not.toHaveBeenCalled();
  });

  it("applies a persona: its character goes to the writer and its tone is the default", async () => {
    const res = await handleGenerate(post({ mode: "ai", prompt: "next song", persona: "chip" }));
    expect(res.status).toBe(201);
    expect(mockedChat.mock.calls[0][0].system).toContain("Your character: You are CHIP");
    expect(mockedSpeech.mock.calls[0][0].tone).toContain("weathered");
    expect((await handleGenerate(post({ mode: "ai", prompt: "x", persona: "nobody" }))).status).toBe(400);
  });

  it("writes the line without calling the speech service when asked for text only", async () => {
    const res = await handleGenerate(post({ mode: "ai", prompt: "hype friday", textOnly: true }));
    expect(res.status).toBe(200);
    expect(await res.json()).toMatchObject({ textOnly: true, scriptText: "Written by the model.", textModel: "openai/gpt-4o-mini" });
    expect(mockedSpeech).not.toHaveBeenCalled();
    expect(mockedSave).not.toHaveBeenCalled();
    expect((await handleGenerate(post({ mode: "say", text: "hi", textOnly: true }))).status).toBe(400);
  });

  it("wraps PCM from Google models in a WAV header and stores the file type", async () => {
    mockedSpeech.mockResolvedValue({ audio: Buffer.from([1, 2, 3, 4]), format: "pcm" });
    await handleGenerate(post({ mode: "say", text: "hi" }));
    const [, data, metadata] = mockedSave.mock.calls[0];
    expect(data.subarray(0, 4).toString()).toBe("RIFF");
    expect(metadata.mimeType).toBe("audio/wav");
  });

  it("rejects unlisted models before spending anything, and unknown formats", async () => {
    for (const body of [{ textModel: "evil/model" }, { speechModel: "evil/tts" }, { format: "nonsense" }]) {
      const res = await handleGenerate(post({ mode: "ai", prompt: "x", ...body }));
      expect(res.status, JSON.stringify(body)).toBe(400);
    }
    expect(mockedChat).not.toHaveBeenCalled();
    expect(mockedSpeech).not.toHaveBeenCalled();
    expect(mockedSave).not.toHaveBeenCalled();
  });

  it("passes the stored file type to the station", async () => {
    vi.mocked(handoffConfigured).mockReturnValue(true);
    vi.mocked(pushToStation).mockResolvedValue({ sent: true });
    await handleGenerate(post({ mode: "say", text: "hi" }));
    expect(vi.mocked(pushToStation).mock.calls[0][1].contentType).toBe("audio/mpeg");
  });

  it("shows OpenRouter's message when a model fails", async () => {
    mockedSpeech.mockRejectedValue(new Error("voice 'x' is not supported (OpenRouter 400)"));
    const res = await handleGenerate(post({ mode: "say", text: "hi", voice: "x" }));
    expect(res.status).toBe(502);
    expect(((await res.json()) as Body).error).toBe("Speech synthesis failed: voice 'x' is not supported (OpenRouter 400)");
  });
});

describe("provider choice", () => {
  it("says what to set when no provider is configured, before doing any work", async () => {
    vi.stubEnv("OPENROUTER_API_KEY", "");
    const res = await handleGenerate(post({ mode: "say", text: "hi" }));
    expect(res.status).toBe(503);
    expect(((await res.json()) as Body).error).toMatch(/OPENROUTER_API_KEY/);
    expect(mockedSpeech).not.toHaveBeenCalled();
  });

  it("falls back to Gemini when only its key is set, and refuses model choices there", async () => {
    vi.stubEnv("OPENROUTER_API_KEY", "");
    vi.stubEnv("GEMINI_API_KEY", "g-key");
    vi.mocked(synthesizeSpeech).mockResolvedValue({ pcm: Buffer.from([1, 2]), mimeType: "audio/pcm" });
    const ok = await handleGenerate(post({ mode: "say", text: "hi", tone: "calm", voice: "Puck" }));
    expect(ok.status).toBe(201);
    expect(vi.mocked(synthesizeSpeech)).toHaveBeenCalledWith("Say in a calm tone: hi", "Puck");
    expect(((await ok.json()) as Body).provider).toBe("gemini");

    const refused = await handleGenerate(post({ mode: "say", text: "hi", speechModel: "x/tts" }));
    expect(refused.status).toBe(400);
  });

  it("can be forced to one provider, and forcing one without its key is an error, not a silent switch", async () => {
    vi.stubEnv("GEMINI_API_KEY", "g-key");
    vi.stubEnv("PROVIDER", "gemini");
    vi.mocked(synthesizeSpeech).mockResolvedValue({ pcm: Buffer.from([1, 2]), mimeType: "audio/pcm" });
    expect(((await (await handleGenerate(post({ mode: "say", text: "hi" }))).json()) as Body).provider).toBe("gemini");
    vi.stubEnv("GEMINI_API_KEY", "");
    expect((await handleGenerate(post({ mode: "say", text: "hi" }))).status).toBe(503);
  });
});

describe("GET /api/options", () => {
  const get = (key: string | null = KEY) => new Request("http://localhost/api/options", { headers: key ? { "x-api-key": key } : {} });

  it("needs the access key", async () => {
    expect((await handleOptions(get(null))).status).toBe(401);
  });

  it("lists models, tones and formats with examples filled in for the station", async () => {
    vi.stubEnv("STATION_NAME", "Way High Radio");
    vi.stubEnv("OPENROUTER_TEXT_MODELS", "a/one");
    const body = (await (await handleOptions(get())).json()) as {
      provider: string; station: string; tones: string[]; formats: Array<{ id: string; structure: string; example: string; prompt: string }>;
      models: { choosable: boolean; text: string[]; speech: Array<{ id: string }>; defaultText: string };
    };
    expect(body.provider).toBe("openrouter");
    expect(body.models).toMatchObject({ choosable: true, text: ["a/one"], defaultText: "a/one" });
    expect(body.models.speech.length).toBeGreaterThan(1);
    expect(body.tones).toContain("friendly");
    expect(body.formats.map((f) => f.id)).toContain("station-id");
    for (const f of body.formats) {
      expect(f.structure.length).toBeGreaterThan(20);
      expect(f.example).not.toContain("{station}");
    }
    expect(body.formats.find((f) => f.id === "station-id")?.example).toContain("Way High Radio");
  });

  it("explains that models are fixed under Gemini and warns when nothing is configured", async () => {
    vi.stubEnv("OPENROUTER_API_KEY", "");
    vi.stubEnv("GEMINI_API_KEY", "g");
    expect(((await (await handleOptions(get())).json()) as { models: { choosable: boolean } }).models.choosable).toBe(false);
    vi.stubEnv("GEMINI_API_KEY", "");
    const none = (await (await handleOptions(get())).json()) as { provider: string | null; warning: string };
    expect(none.provider).toBeNull();
    expect(none.warning).toMatch(/OPENROUTER_API_KEY/);
  });
});
