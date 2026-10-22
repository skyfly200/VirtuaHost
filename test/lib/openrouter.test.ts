import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import {
  chat, speech, textModels, speechModels, defaultTextModel, defaultSpeechModel, pickTextModel, pickSpeechModel, voiceFor, applyTone, speechFormat,
} from "../../lib/openrouter.js";

const fetchMock = vi.fn();

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
}

beforeEach(() => {
  vi.stubGlobal("fetch", fetchMock);
  fetchMock.mockReset();
  vi.stubEnv("OPENROUTER_API_KEY", "or-key");
  for (const name of ["OPENROUTER_TEXT_MODEL", "OPENROUTER_TEXT_MODELS", "OPENROUTER_SPEECH_MODEL", "OPENROUTER_SPEECH_MODELS", "OPENROUTER_VOICE", "OPENROUTER_ALLOW_ANY_MODEL", "OPENROUTER_BASE_URL", "OPENROUTER_REFERER", "STATION_NAME"]) {
    vi.stubEnv(name, "");
  }
});
afterEach(() => {
  vi.unstubAllEnvs();
  vi.unstubAllGlobals();
});

describe("model configuration", () => {
  it("has working defaults", () => {
    expect(textModels().length).toBeGreaterThan(1);
    expect(defaultTextModel()).toBe(textModels()[0]);
    expect(defaultSpeechModel()).toEqual({ id: "hexgrad/kokoro-82m", voice: "af_heart" });      // the cheapest first
  });

  it("reads lists from the environment, with an optional default voice per speech model", () => {
    vi.stubEnv("OPENROUTER_TEXT_MODELS", " a/one , b/two ");
    vi.stubEnv("OPENROUTER_SPEECH_MODELS", "x/tts|Nova, y/tts");
    expect(textModels()).toEqual(["a/one", "b/two"]);
    expect(speechModels()).toEqual([{ id: "x/tts", voice: "Nova" }, { id: "y/tts" }]);
  });

  it("puts a default model that is not in the list first, so it is always available", () => {
    vi.stubEnv("OPENROUTER_TEXT_MODELS", "a/one");
    vi.stubEnv("OPENROUTER_TEXT_MODEL", "c/three");
    vi.stubEnv("OPENROUTER_SPEECH_MODELS", "x/tts");
    vi.stubEnv("OPENROUTER_SPEECH_MODEL", "z/tts");
    expect(textModels()).toEqual(["c/three", "a/one"]);
    expect(defaultTextModel()).toBe("c/three");
    expect(defaultSpeechModel().id).toBe("z/tts");
  });

  it("only allows listed models, unless any slug is explicitly allowed", () => {
    vi.stubEnv("OPENROUTER_TEXT_MODELS", "a/one");
    vi.stubEnv("OPENROUTER_SPEECH_MODELS", "x/tts|Nova");
    expect(pickTextModel(undefined)).toEqual({ model: "a/one" });
    expect(pickTextModel("a/one")).toEqual({ model: "a/one" });
    expect(pickTextModel("evil/expensive")).toHaveProperty("error");
    expect(pickSpeechModel("x/tts")).toEqual({ model: { id: "x/tts", voice: "Nova" } });
    expect(pickSpeechModel("nope/tts")).toHaveProperty("error");

    vi.stubEnv("OPENROUTER_ALLOW_ANY_MODEL", "true");
    expect(pickTextModel("evil/expensive")).toEqual({ model: "evil/expensive" });
    expect(pickSpeechModel("any/tts:free")).toEqual({ model: { id: "any/tts:free" } });
    expect(pickTextModel("bad slug with spaces")).toHaveProperty("error");   // still has to look like a model slug
    expect(pickTextModel("x".repeat(200))).toHaveProperty("error");
  });

  it("picks the voice: request, then the model's own, then OPENROUTER_VOICE", () => {
    vi.stubEnv("OPENROUTER_VOICE", "alloy");
    expect(voiceFor({ id: "m", voice: "Kore" }, "Puck")).toBe("Puck");
    expect(voiceFor({ id: "m", voice: "Kore" })).toBe("Kore");
    expect(voiceFor({ id: "m" })).toBe("alloy");
    vi.stubEnv("OPENROUTER_VOICE", "");
    expect(voiceFor({ id: "m" })).toBeUndefined();
  });
});

describe("tone", () => {
  it("is written into the text for Google speech models and sent as instructions for others", () => {
    expect(applyTone("google/gemini-3.1-flash-tts-preview", "Hello", "warm and slow")).toEqual({ input: "Say in a warm and slow tone: Hello" });
    expect(applyTone("deepgram/flux-tts:free", "Hello", "warm and slow")).toEqual({ input: "Hello", instructions: "Speak in a warm and slow tone." });
    expect(applyTone("deepgram/flux-tts:free", "Hello", "")).toEqual({ input: "Hello" });
  });

  it("asks Google models for raw PCM and everything else for MP3", () => {
    expect(speechFormat("google/anything")).toBe("pcm");
    expect(speechFormat("hexgrad/kokoro-82m")).toBe("mp3");
  });
});

describe("chat", () => {
  it("posts the system prompt and the request to the chosen model and returns the text", async () => {
    fetchMock.mockResolvedValue(jsonResponse({ choices: [{ message: { content: "  Hello crew.  " } }] }));
    vi.stubEnv("STATION_NAME", "Way High Radio");
    vi.stubEnv("OPENROUTER_REFERER", "https://site.example");
    const text = await chat({ model: "a/one", system: "be brief", prompt: "say hi" });

    expect(text).toBe("Hello crew.");
    const [url, init] = fetchMock.mock.calls[0];
    expect(url).toBe("https://openrouter.ai/api/v1/chat/completions");
    expect(init.headers.authorization).toBe("Bearer or-key");
    expect(init.headers["x-title"]).toBe("Way High Radio");
    expect(init.headers["http-referer"]).toBe("https://site.example");
    expect(JSON.parse(init.body)).toEqual({ model: "a/one", max_tokens: 3000, reasoning: { effort: "low" }, messages: [{ role: "system", content: "be brief" }, { role: "user", content: "say hi" }] });
  });

  it("passes OpenRouter's error message through", async () => {
    fetchMock.mockResolvedValue(jsonResponse({ error: { message: "No endpoints found for a/one" } }, 404));
    await expect(chat({ model: "a/one", system: "s", prompt: "p" })).rejects.toThrow("No endpoints found for a/one (OpenRouter 404)");
  });

  it("fails clearly on an empty answer or a missing key", async () => {
    fetchMock.mockImplementation(async () => jsonResponse({ choices: [{ message: { content: "" } }] }));
    await expect(chat({ model: "a/one", system: "s", prompt: "p" })).rejects.toThrow("a/one returned no text");
    vi.stubEnv("OPENROUTER_API_KEY", "");
    await expect(chat({ model: "a/one", system: "s", prompt: "p" })).rejects.toThrow("OPENROUTER_API_KEY is not set");
  });
});

describe("speech", () => {
  const audioResponse = (bytes = [1, 2, 3, 4]) => new Response(new Uint8Array(bytes), { status: 200, headers: { "content-type": "audio/mpeg" } });

  it("asks a non-Google model for MP3 with the voice and tone instructions", async () => {
    fetchMock.mockResolvedValue(audioResponse());
    const out = await speech({ model: "deepgram/flux-tts:free", voice: "aura", text: "Hi there", tone: "dry" });

    expect(out.format).toBe("mp3");
    expect(out.audio).toEqual(Buffer.from([1, 2, 3, 4]));
    const [url, init] = fetchMock.mock.calls[0];
    expect(url).toBe("https://openrouter.ai/api/v1/audio/speech");
    expect(JSON.parse(init.body)).toEqual({ model: "deepgram/flux-tts:free", input: "Hi there", voice: "aura", response_format: "mp3", instructions: "Speak in a dry tone." });
  });

  it("asks a Google model for PCM and puts the tone in the text", async () => {
    fetchMock.mockResolvedValue(audioResponse());
    const out = await speech({ model: "google/gemini-3.1-flash-tts-preview", voice: "Kore", text: "Hi", tone: "warm" });
    expect(out.format).toBe("pcm");
    expect(JSON.parse(fetchMock.mock.calls[0][1].body)).toEqual({ model: "google/gemini-3.1-flash-tts-preview", input: "Say in a warm tone: Hi", voice: "Kore", response_format: "pcm" });
  });

  it("leaves out the voice and instructions when there are none", async () => {
    fetchMock.mockResolvedValue(audioResponse());
    await speech({ model: "x/tts", text: "Hi" });
    expect(JSON.parse(fetchMock.mock.calls[0][1].body)).toEqual({ model: "x/tts", input: "Hi", response_format: "mp3" });
  });

  it("reports errors, including a JSON error that came back with a 200", async () => {
    fetchMock.mockResolvedValueOnce(jsonResponse({ error: { message: "voice 'x' is not supported" } }, 400));
    await expect(speech({ model: "x/tts", text: "Hi", voice: "x" })).rejects.toThrow("voice 'x' is not supported (OpenRouter 400)");
    fetchMock.mockResolvedValueOnce(jsonResponse({ error: { message: "model overloaded" } }, 200));
    await expect(speech({ model: "x/tts", text: "Hi" })).rejects.toThrow("model overloaded");
    fetchMock.mockResolvedValueOnce(new Response(new Uint8Array(0), { status: 200, headers: { "content-type": "audio/mpeg" } }));
    await expect(speech({ model: "x/tts", text: "Hi" })).rejects.toThrow("x/tts returned no audio");
  });
});

describe("speech model discovery", () => {
  it("merges the models OpenRouter lists, with their voices, into the configured list", async () => {
    vi.resetModules();
    const { allSpeechModels, voiceFor: voiceForFresh } = await import("../../lib/openrouter.js");
    fetchMock.mockResolvedValue(jsonResponse({ data: [
      { id: "hexgrad/kokoro-82m", supported_voices: ["af_heart", "af_bella"] },
      { id: "new/tts", supported_voices: ["ana", "", 5] },
      { id: "bad slug!" },
    ] }));
    const all = await allSpeechModels();
    expect(fetchMock.mock.calls[0][0]).toBe("https://openrouter.ai/api/v1/models?output_modalities=speech");
    expect(all.find((m) => m.id === "hexgrad/kokoro-82m")).toEqual({ id: "hexgrad/kokoro-82m", voice: "af_heart", voices: ["af_heart", "af_bella"] });
    const added = all.find((m) => m.id === "new/tts")!;
    expect(added.voices).toEqual(["ana"]);
    expect(all.some((m) => m.id.includes("bad"))).toBe(false);
    expect(voiceForFresh(added)).toBe("ana");
  });

  it("falls back to the configured list when OpenRouter cannot be reached", async () => {
    vi.resetModules();
    const { allSpeechModels } = await import("../../lib/openrouter.js");
    fetchMock.mockRejectedValue(new Error("offline"));
    expect((await allSpeechModels()).length).toBeGreaterThan(1);
  });
});

describe("delivery cues by model", () => {
  it("sends tone the way each model takes it, or not at all", async () => {
    const { cuesFor, stripDeliveryTags } = await import("../../lib/cues.js");
    expect(cuesFor("google/gemini-3.1-flash-tts-preview")).toMatchObject({ tone: "text", tags: true });
    expect(cuesFor("openai/gpt-4o-mini-tts-2025-12-15")).toMatchObject({ tone: "instructions", tags: false });
    expect(cuesFor("hexgrad/kokoro-82m")).toMatchObject({ tone: "none", tags: false });
    expect(cuesFor("some/new-tts")).toMatchObject({ tags: "unknown", basis: "unknown" });
    expect(applyTone("openai/gpt-4o-mini-tts-2025-12-15", "Hi", "warm")).toEqual({ input: "Hi", instructions: "Speak in a warm tone." });
    expect(applyTone("hexgrad/kokoro-82m", "Hi", "warm")).toEqual({ input: "Hi" });
    expect(stripDeliveryTags("Hello [laughs] world, [short pause] ok.")).toEqual({ text: "Hello world, ok.", removed: true });
    expect(stripDeliveryTags("No tags here.")).toEqual({ text: "No tags here.", removed: false });
  });
});

describe("models that do not exist", () => {
  it("hides built-in speech models OpenRouter does not list, but keeps ones you configured", async () => {
    vi.resetModules();
    const { allSpeechModels } = await import("../../lib/openrouter.js");
    fetchMock.mockResolvedValue(jsonResponse({ data: [{ id: "google/gemini-3.1-flash-tts-preview" }, { id: "real/tts", supported_voices: ["v1"] }] }));
    const ids = (await allSpeechModels()).map((m) => m.id);
    expect(ids).toEqual(["google/gemini-3.1-flash-tts-preview", "real/tts"]);      // kokoro is built in but not listed: hidden

    vi.resetModules();
    vi.stubEnv("OPENROUTER_SPEECH_MODELS", "hexgrad/kokoro-82m|af_heart");
    const again = await import("../../lib/openrouter.js");
    fetchMock.mockResolvedValue(jsonResponse({ data: [{ id: "real/tts" }] }));
    expect((await again.allSpeechModels()).map((m) => m.id)).toEqual(["hexgrad/kokoro-82m", "real/tts"]);   // yours stays
  });

  it("keeps the built-in list when OpenRouter cannot be asked", async () => {
    vi.resetModules();
    const { allSpeechModels } = await import("../../lib/openrouter.js");
    fetchMock.mockRejectedValue(new Error("offline"));
    expect((await allSpeechModels()).map((m) => m.id)).toEqual(["hexgrad/kokoro-82m", "google/gemini-3.1-flash-tts-preview"]);
  });

  it("explains a missing model instead of just repeating the error", async () => {
    fetchMock.mockResolvedValue(jsonResponse({ error: { message: "Model openai/gpt-4o-mini-tts-2025-12-15 does not exist" } }, 400));
    await expect(speech({ model: "openai/gpt-4o-mini-tts-2025-12-15", text: "hi" })).rejects.toThrow(/does not exist.*pick another in the Speech model list/s);
    fetchMock.mockResolvedValue(jsonResponse({ error: { message: "Invalid voice" } }, 400));
    await expect(speech({ model: "x/tts", text: "hi" })).rejects.not.toThrow(/pick another/);
  });
});

describe("thinking models (empty or cut-off replies)", () => {
  const reply = (content: unknown, finish = "stop", reasoning?: string) => new Response(JSON.stringify({ choices: [{ finish_reason: finish, message: { content, ...(reasoning ? { reasoning } : {}) } }] }), { status: 200 });
  beforeEach(() => vi.stubEnv("OPENROUTER_API_KEY", "or-key"));

  it("retries once with a bigger budget when the first reply is empty because the model spent it thinking", async () => {
    fetchMock.mockResolvedValueOnce(reply(null, "length", "hmm, let me think...")).mockResolvedValueOnce(reply("Hello crew."));
    expect(await chat({ model: "anthropic/claude-haiku-5.5", system: "s", prompt: "p" })).toBe("Hello crew.");
    const [first, second] = fetchMock.mock.calls.map((c) => JSON.parse(c[1].body));
    expect([first.max_tokens, second.max_tokens]).toEqual([3000, 6000]);
    expect(second.reasoning).toEqual({ effort: "minimal" });
  });

  it("retries when the reply is cut off mid-sentence, rather than returning half a line", async () => {
    fetchMock.mockResolvedValueOnce(reply("I was staring into the microwave wondering if", "length")).mockResolvedValueOnce(reply("I was staring into the microwave, and it stared back."));
    expect(await chat({ model: "google/gemini-3.6-flash", system: "s", prompt: "p" })).toBe("I was staring into the microwave, and it stared back.");
  });

  it("says so, in plain words, when it still fails, and does not return a cut-off line", async () => {
    fetchMock.mockImplementation(async () => reply("I was staring into the", "length"));
    await expect(chat({ model: "google/gemini-3.6-flash", system: "s", prompt: "p" })).rejects.toThrow(/cut off before it finished.*another writing model/);
    fetchMock.mockReset().mockImplementation(async () => reply("", "length", "thinking forever"));
    await expect(chat({ model: "anthropic/claude-haiku-5.5", system: "s", prompt: "p" })).rejects.toThrow(/no text.*thinking/);
  });

  it("reads replies given as a list of parts", async () => {
    fetchMock.mockResolvedValue(reply([{ type: "text", text: "Hello " }, { type: "text", text: "there." }]));
    expect(await chat({ model: "a/one", system: "s", prompt: "p" })).toBe("Hello there.");
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });
});
