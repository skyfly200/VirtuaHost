import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { contentFilter } from "../../lib/content.js";
import { buildSystemPrompt } from "../../lib/formats.js";
import { handleEstimate } from "../../lib/handlers/estimate.js";
import { resetPriceCache } from "../../lib/openrouter.js";

describe("contentFilter", () => {
  it("labels hosted frontier models as filtered, open models as unfiltered, and the rest by name or as unknown", () => {
    expect(contentFilter("openai/gpt-4o-mini").level).toBe("filtered");
    expect(contentFilter("anthropic/claude-3.5-haiku").level).toBe("filtered");
    expect(contentFilter("google/gemini-3.1-flash-tts-preview").level).toBe("filtered");
    expect(contentFilter("meta-llama/llama-3.1-8b-instruct").level).toBe("light");
    expect(contentFilter("hexgrad/kokoro-82m").level).toBe("open");
    expect(contentFilter("cognitivecomputations/dolphin-mixtral-8x22b").level).toBe("open");
    expect(contentFilter("elevenlabs/eleven_flash_v2_5").level).toBe("light");
    expect(contentFilter("who/knows").level).toBe("unknown");
  });

  it("trusts OpenRouter's moderation flag over the name hints", () => {
    expect(contentFilter("meta-llama/llama-3.1-8b-instruct", { moderated: true })).toMatchObject({ level: "filtered", live: true });
    expect(contentFilter("who/knows", { moderated: false }).level).toBe("light");
    expect(contentFilter("openai/gpt-4o-mini", { moderated: false }).level).toBe("filtered");       // a named frontier model keeps its hint
  });

  it("always says it is a hint, not a test, unless OpenRouter said so", () => {
    expect(contentFilter("openai/gpt-4o-mini").note).toMatch(/hint, not a test/);
    expect(contentFilter("openai/gpt-4o-mini").live).toBe(false);
  });
});

describe("strong language in the writing prompt", () => {
  it("only tells the writer not to censor when asked", () => {
    expect(buildSystemPrompt({ station: "KRAP" })).not.toMatch(/profanity/i);
    const prompt = buildSystemPrompt({ station: "KRAP", explicit: true });
    expect(prompt).toMatch(/profanity and strong language are allowed/);
    expect(prompt).toMatch(/do not censor, bleep/);
  });
});

describe("persona example lines", () => {
  it("tells the writer to use them for style only", () => {
    const p = buildSystemPrompt({ station: "KRAP", persona: "Rocky. Example: Not even your dog." });
    expect(p).toMatch(/example lines[^.]*only show the voice and style: never repeat or lightly reword them/);
    expect(buildSystemPrompt({ station: "KRAP" })).not.toMatch(/example lines/);
  });
});

describe("estimate flags filtered models when strong language is wanted", () => {
  const fetchMock = vi.fn();
  beforeEach(() => {
    resetPriceCache();
    fetchMock.mockReset();
    fetchMock.mockRejectedValue(new Error("offline"));
    vi.stubGlobal("fetch", fetchMock);
    vi.stubEnv("OPENROUTER_API_KEY", "or-key-0000000000000000"); vi.stubEnv("GEMINI_API_KEY", ""); vi.stubEnv("PROVIDER", "");
    vi.stubEnv("OPENROUTER_ALLOW_ANY_MODEL", "true"); vi.stubEnv("OPENROUTER_TEXT_MODEL", ""); vi.stubEnv("OPENROUTER_TEXT_MODELS", ""); vi.stubEnv("ELEVENLABS_API_KEY", "");
    vi.stubEnv("ACCESS_KEY", "machine-key-0123456789"); vi.stubEnv("AUTH_DISABLED", ""); vi.stubEnv("SESSION_SECRET", "");
  });
  afterEach(() => { vi.unstubAllEnvs(); vi.unstubAllGlobals(); });
  const call = async (body: unknown) => ((await (await handleEstimate(new Request("http://localhost/api/estimate", { method: "POST", headers: { "content-type": "application/json", "x-api-key": "machine-key-0123456789" }, body: JSON.stringify(body) }))).json()) as { estimate: { warn: boolean; message: string; content: { level: string } } }).estimate;

  it("warns for a filtered model with strong language on, and not otherwise", async () => {
    const on = await call({ kind: "write", prompt: "swear a lot", explicit: true });
    expect(on).toMatchObject({ warn: true, content: { level: "filtered" } });
    expect(on.message).toMatch(/may refuse or soften/);
    expect((await call({ kind: "write", prompt: "swear a lot" })).warn).toBe(false);
    const open = await call({ kind: "write", prompt: "x", explicit: true, textModel: "meta-llama/llama-3.1-8b-instruct" });
    expect(open.warn).toBe(false);
    expect((await call({ kind: "speak", text: "hello", explicit: true })).warn).toBe(false);          // kokoro is unfiltered
  });
});
