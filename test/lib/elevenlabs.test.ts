import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { listVoices, resolveVoice, elevenSpeech, resetVoiceCache, parseNamedVoices } from "../../lib/elevenlabs.js";
import { runWithScope } from "../../lib/credentials.js";
import { speak } from "../../lib/ai.js";
import { speechModels, allSpeechModels } from "../../lib/openrouter.js";
import { cuesFor } from "../../lib/cues.js";
import { estimateSpeech } from "../../lib/pricing.js";

const CLONE = "AbCdEfGhIjKlMnOpQrSt";
const PREMADE = "ZyXwVuTsRqPoNmLkJiHg";
const voicesBody = { voices: [{ voice_id: PREMADE, name: "Rachel", category: "premade" }, { voice_id: CLONE, name: "Rocky", category: "cloned" }] };
const fetchMock = vi.fn();

beforeEach(() => {
  resetVoiceCache();
  fetchMock.mockReset();
  vi.stubGlobal("fetch", fetchMock);
  vi.stubEnv("ELEVENLABS_API_KEY", "eleven-site-key-0000000000");
  vi.stubEnv("ELEVENLABS_VOICES", "");
  vi.stubEnv("OPENROUTER_API_KEY", "or-key-0000000000000000"); vi.stubEnv("GEMINI_API_KEY", ""); vi.stubEnv("PROVIDER", "");
  for (const k of ["OPENROUTER_SPEECH_MODELS", "OPENROUTER_SPEECH_MODEL"]) vi.stubEnv(k, "");
});
afterEach(() => { vi.unstubAllEnvs(); vi.unstubAllGlobals(); });

const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });

describe("ElevenLabs voices", () => {
  it("lists cloned voices first and sends the key", async () => {
    fetchMock.mockResolvedValue(json(voicesBody));
    const voices = await listVoices();
    expect(voices.map((v) => v.name)).toEqual(["Rocky", "Rachel"]);
    expect(fetchMock.mock.calls[0][1].headers["xi-api-key"]).toBe("eleven-site-key-0000000000");
    await listVoices();
    expect(fetchMock).toHaveBeenCalledTimes(1);                                  // cached
  });

  it("resolves a voice by name (any case) or id, and refuses unknown names", async () => {
    fetchMock.mockResolvedValue(json(voicesBody));
    expect(await resolveVoice("rocky")).toEqual({ id: CLONE, name: "Rocky" });
    expect(await resolveVoice(PREMADE)).toEqual({ id: PREMADE, name: "Rachel" });
    expect(await resolveVoice("NoSuchVoice")).toHaveProperty("error");
    expect(await resolveVoice("")).toEqual({ id: CLONE, name: "Rocky" });          // default: the first clone
  });

  it("falls back to the named voices in ELEVENLABS_VOICES when the account cannot be listed", async () => {
    vi.stubEnv("ELEVENLABS_VOICES", `Britta=${PREMADE}, junk, Bad=short`);
    fetchMock.mockRejectedValue(new Error("offline"));
    expect(parseNamedVoices().map((v) => v.name)).toEqual(["Britta"]);
    expect((await listVoices()).map((v) => v.name)).toEqual(["Britta"]);
  });
});

describe("ElevenLabs speech", () => {
  it("posts text to the chosen voice and returns MP3", async () => {
    fetchMock.mockImplementation(async (url: string) => (String(url).endsWith("/v1/voices") ? json(voicesBody) : new Response(new Uint8Array([1, 2, 3]), { status: 200 })));
    const out = await speak({ text: "Hello", provider: "openrouter", speechModel: { id: "elevenlabs/eleven_flash_v2_5" }, voice: "Rocky" });
    expect(out).toMatchObject({ mimeType: "audio/mpeg", voice: "Rocky", model: "elevenlabs/eleven_flash_v2_5" });
    const call = fetchMock.mock.calls.find((c) => String(c[0]).includes("/text-to-speech/"))!;
    expect(String(call[0])).toContain(`/v1/text-to-speech/${CLONE}`);
    expect(JSON.parse(call[1].body)).toEqual({ text: "Hello", model_id: "eleven_flash_v2_5" });
  });

  it("passes ElevenLabs' own error message through", async () => {
    fetchMock.mockImplementation(async (url: string) => (String(url).endsWith("/v1/voices") ? json(voicesBody) : json({ detail: { message: "quota_exceeded" } }, 401)));
    await expect(elevenSpeech({ model: "elevenlabs/eleven_flash_v2_5", voice: "Rocky", text: "Hi" })).rejects.toThrow(/quota_exceeded.*401/);
  });

  it("uses a person's own key in place of the site's", async () => {
    fetchMock.mockResolvedValue(json(voicesBody));
    await runWithScope({ keys: { elevenlabs: "dana-eleven-key-000000000" }, source: { elevenlabs: "user" } }, () => listVoices());
    expect(fetchMock.mock.calls[0][1].headers["xi-api-key"]).toBe("dana-eleven-key-000000000");
  });
});

describe("ElevenLabs in the model list", () => {
  it("offers the models only when a key is in scope, with the account's voices", async () => {
    fetchMock.mockImplementation(async (url: string) => (String(url).includes("elevenlabs") ? json(voicesBody) : json({ data: [] })));
    expect(speechModels().map((m) => m.id)).toEqual(expect.arrayContaining(["elevenlabs/eleven_multilingual_v2", "elevenlabs/eleven_flash_v2_5"]));
    const eleven = (await allSpeechModels()).find((m) => m.id === "elevenlabs/eleven_flash_v2_5");
    expect(eleven?.voices).toEqual(["Rocky", "Rachel"]);
    vi.stubEnv("ELEVENLABS_API_KEY", "");
    expect(speechModels().some((m) => m.id.startsWith("elevenlabs/"))).toBe(false);
  });

  it("ignores tone and strips tags for ElevenLabs models", () => {
    expect(cuesFor("elevenlabs/eleven_flash_v2_5")).toMatchObject({ tone: "none", tags: false });
  });
});

describe("ElevenLabs estimates", () => {
  it("counts characters of credits, and warns only for the premium model", async () => {
    const flash = await estimateSpeech({ model: "elevenlabs/eleven_flash_v2_5", chars: 300 });
    expect(flash).toMatchObject({ tier: "standard", warn: false, credits: { characters: 300 }, costUsd: null });
    expect(flash.message).toMatch(/300 characters of your ElevenLabs credits/);
    const multi = await estimateSpeech({ model: "elevenlabs/eleven_multilingual_v2", chars: 300 });
    expect(multi).toMatchObject({ tier: "premium", warn: true });
    expect(multi.message).toMatch(/premium model/);
  });
});
