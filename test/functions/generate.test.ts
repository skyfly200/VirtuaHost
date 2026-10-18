import { describe, it, expect, vi, beforeEach } from "vitest";

vi.mock("../../lib/gemini.js", () => ({
  writeDjLine: vi.fn(),
  synthesizeSpeech: vi.fn(),
  DEFAULT_VOICE: "Kore",
}));
vi.mock("../../lib/store.js", () => ({
  saveClip: vi.fn(),
}));
vi.mock("../../lib/handoff.js", () => ({
  handoffConfigured: vi.fn(),
  handoffDefaults: vi.fn(),
  pushToStation: vi.fn(),
}));

import { writeDjLine, synthesizeSpeech } from "../../lib/gemini.js";
import { saveClip } from "../../lib/store.js";
import { handoffConfigured, handoffDefaults, pushToStation } from "../../lib/handoff.js";
import { handleGenerate } from "../../lib/handlers/generate.js";

const TEST_KEY = "test-access-key-0123456789";
vi.stubEnv("ACCESS_KEY", TEST_KEY);

const mockedWriteDjLine = vi.mocked(writeDjLine);
const mockedSynthesizeSpeech = vi.mocked(synthesizeSpeech);
const mockedSaveClip = vi.mocked(saveClip);
const mockedHandoffConfigured = vi.mocked(handoffConfigured);
const mockedHandoffDefaults = vi.mocked(handoffDefaults);
const mockedPushToStation = vi.mocked(pushToStation);

interface GenerateResponseBody {
  id: string;
  scriptText: string;
  audioUrl: string;
}

function jsonRequest(method: string, body?: unknown): Request {
  return new Request("http://localhost/api/generate", {
    method,
    body: body === undefined ? undefined : JSON.stringify(body),
    headers: { "content-type": "application/json", "x-api-key": TEST_KEY },
  });
}

describe("handleGenerate", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockedSynthesizeSpeech.mockResolvedValue({ pcm: Buffer.from([1, 2, 3]), mimeType: "audio/pcm" });
    mockedSaveClip.mockResolvedValue(undefined);
    mockedHandoffConfigured.mockReturnValue(false);
    mockedHandoffDefaults.mockReturnValue({ play: false, preempt: false });
  });

  it("rejects non-POST requests", async () => {
    const res = await handleGenerate(jsonRequest("GET"));
    expect(res.status).toBe(405);
  });

  it("rejects invalid JSON bodies", async () => {
    const req = new Request("http://localhost/api/generate", { method: "POST", body: "not json", headers: { "x-api-key": TEST_KEY } });
    const res = await handleGenerate(req);
    expect(res.status).toBe(400);
  });

  it("rejects an unknown mode", async () => {
    const res = await handleGenerate(jsonRequest("POST", { mode: "sing" }));
    expect(res.status).toBe(400);
  });

  it("requires text for mode 'say'", async () => {
    const res = await handleGenerate(jsonRequest("POST", { mode: "say" }));
    expect(res.status).toBe(400);
    expect(mockedSynthesizeSpeech).not.toHaveBeenCalled();
  });

  it("requires prompt for mode 'ai'", async () => {
    const res = await handleGenerate(jsonRequest("POST", { mode: "ai" }));
    expect(res.status).toBe(400);
  });

  it("synthesizes verbatim text for mode 'say' without calling the LLM", async () => {
    const res = await handleGenerate(jsonRequest("POST", { mode: "say", text: "hello listeners" }));

    expect(res.status).toBe(201);
    expect(mockedWriteDjLine).not.toHaveBeenCalled();
    expect(mockedSynthesizeSpeech).toHaveBeenCalledWith("hello listeners");

    const body = (await res.json()) as GenerateResponseBody;
    expect(body.scriptText).toBe("hello listeners");
    expect(body.audioUrl).toBe(`/api/clips/${body.id}`);
    expect(mockedSaveClip).toHaveBeenCalledTimes(1);
  });

  it("writes a DJ line via Gemini for mode 'ai' before synthesizing", async () => {
    mockedWriteDjLine.mockResolvedValue("Coming up next, a certified banger.");

    const res = await handleGenerate(jsonRequest("POST", { mode: "ai", prompt: "hype the next song" }));

    expect(res.status).toBe(201);
    expect(mockedWriteDjLine).toHaveBeenCalledWith("hype the next song");
    expect(mockedSynthesizeSpeech).toHaveBeenCalledWith("Coming up next, a certified banger.");

    const body = (await res.json()) as GenerateResponseBody;
    expect(body.scriptText).toBe("Coming up next, a certified banger.");
  });

  it("returns 502 when script generation fails", async () => {
    mockedWriteDjLine.mockRejectedValue(new Error("quota exceeded"));

    const res = await handleGenerate(jsonRequest("POST", { mode: "ai", prompt: "hype it up" }));

    expect(res.status).toBe(502);
    expect(mockedSaveClip).not.toHaveBeenCalled();
  });

  it("returns 502 when speech synthesis fails", async () => {
    mockedSynthesizeSpeech.mockRejectedValue(new Error("tts unavailable"));

    const res = await handleGenerate(jsonRequest("POST", { mode: "say", text: "hello" }));

    expect(res.status).toBe(502);
    expect(mockedSaveClip).not.toHaveBeenCalled();
  });

  describe("sound effect tags", () => {
    it("removes [sfx:...] tags before speaking, because Gemini would read them aloud", async () => {
      const res = await handleGenerate(jsonRequest("POST", { mode: "say", text: "Welcome [sfx:ding] to the show [SFX: whoosh over vol=0.5] folks." }));

      expect(res.status).toBe(201);
      expect(mockedSynthesizeSpeech).toHaveBeenCalledWith("Welcome to the show folks.");
      const body = (await res.json()) as { scriptText: string; sfxTagsRemoved: boolean };
      expect(body.scriptText).toBe("Welcome to the show folks.");
      expect(body.sfxTagsRemoved).toBe(true);
    });

    it("leaves other bracketed text alone and does not flag it", async () => {
      const res = await handleGenerate(jsonRequest("POST", { mode: "say", text: "Hello [laughs] there" }));
      expect(mockedSynthesizeSpeech).toHaveBeenCalledWith("Hello [laughs] there");
      expect(await res.json()).not.toHaveProperty("sfxTagsRemoved");
    });

    it("rejects text that is only tags", async () => {
      const res = await handleGenerate(jsonRequest("POST", { mode: "say", text: "[sfx:ding]" }));
      expect(res.status).toBe(400);
      expect(mockedSynthesizeSpeech).not.toHaveBeenCalled();
    });
  });

  describe("station hand-off", () => {
    beforeEach(() => {
      mockedHandoffConfigured.mockReturnValue(true);
      mockedPushToStation.mockResolvedValue({ sent: true, clipId: "st1", played: false });
    });

    it("sends nothing and adds no handoff field when no station is configured", async () => {
      mockedHandoffConfigured.mockReturnValue(false);
      const res = await handleGenerate(jsonRequest("POST", { mode: "say", text: "hello" }));
      expect(mockedPushToStation).not.toHaveBeenCalled();
      expect(await res.json()).not.toHaveProperty("handoff");
    });

    it("pushes the generated WAV to the station and reports the result", async () => {
      const res = await handleGenerate(jsonRequest("POST", { mode: "say", text: "hello" }));

      expect(res.status).toBe(201);
      const [wav, options] = mockedPushToStation.mock.calls[0];
      expect(wav.subarray(0, 4).toString()).toBe("RIFF");
      expect(options).toEqual({ title: "hello", text: "hello", play: false, preempt: false });
      expect(((await res.json()) as { handoff: unknown }).handoff).toEqual({ sent: true, clipId: "st1", played: false });
    });

    it("uses the environment defaults for play and preempt, which the request can override", async () => {
      mockedHandoffDefaults.mockReturnValue({ play: true, preempt: true });

      await handleGenerate(jsonRequest("POST", { mode: "say", text: "a" }));
      expect(mockedPushToStation.mock.calls[0][1]).toMatchObject({ play: true, preempt: true });

      await handleGenerate(jsonRequest("POST", { mode: "say", text: "b", play: false, preempt: false }));
      expect(mockedPushToStation.mock.calls[1][1]).toMatchObject({ play: false, preempt: false });
    });

    it("passes the request's effect, falling back to the station-wide default", async () => {
      mockedHandoffDefaults.mockReturnValue({ play: false, preempt: false, fx: "underground" });

      await handleGenerate(jsonRequest("POST", { mode: "say", text: "a" }));
      expect(mockedPushToStation.mock.calls[0][1].fx).toBe("underground");

      await handleGenerate(jsonRequest("POST", { mode: "say", text: "b", fx: { preset: "robot", pitch: 2 } }));
      expect(mockedPushToStation.mock.calls[1][1].fx).toEqual({ preset: "robot", pitch: 2 });
    });

    it("sends the written script, not the prompt, in ai mode", async () => {
      mockedWriteDjLine.mockResolvedValue("Here comes the weekend.");
      await handleGenerate(jsonRequest("POST", { mode: "ai", prompt: "hype friday" }));
      expect(mockedPushToStation.mock.calls[0][1].text).toBe("Here comes the weekend.");
    });

    it("can be switched off per request", async () => {
      const res = await handleGenerate(jsonRequest("POST", { mode: "say", text: "hello", handoff: false }));
      expect(mockedPushToStation).not.toHaveBeenCalled();
      expect(await res.json()).not.toHaveProperty("handoff");
    });

    it("still succeeds and says so when the station could not be reached", async () => {
      mockedPushToStation.mockResolvedValue({ sent: false, error: "could not reach the station: timeout" });
      const res = await handleGenerate(jsonRequest("POST", { mode: "say", text: "hello" }));

      expect(res.status).toBe(201);
      expect(mockedSaveClip).toHaveBeenCalledTimes(1);
      expect(((await res.json()) as { handoff: { sent: boolean } }).handoff.sent).toBe(false);
    });
  });
});
