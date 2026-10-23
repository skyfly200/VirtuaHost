import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { allTextModels, ensureListed, pickTextModel, textModels, resetPriceCache } from "../../lib/openrouter.js";
import { textTier } from "../../lib/pricing.js";

const fetchMock = vi.fn();
const rows = (...r: Array<[string, string, string]>) => new Response(JSON.stringify({ data: r.map(([id, p, c]) => ({ id, pricing: { prompt: p, completion: c } })) }), { status: 200 });

beforeEach(() => {
  resetPriceCache();
  fetchMock.mockReset();
  vi.stubGlobal("fetch", fetchMock);
  vi.stubEnv("OPENROUTER_API_KEY", "or-key-0000000000000000"); vi.stubEnv("OPENROUTER_TEXT_MODELS", ""); vi.stubEnv("OPENROUTER_TEXT_MODEL", ""); vi.stubEnv("OPENROUTER_ALLOW_ANY_MODEL", "");
});
afterEach(() => { vi.unstubAllEnvs(); vi.unstubAllGlobals(); });

describe("built-in writing models", () => {
  it("include Haiku 5.5, Gemini and DeepSeek as candidates, with the cheap default first", () => {
    expect(textModels()).toEqual(expect.arrayContaining(["anthropic/claude-haiku-5.5", "google/gemini-3.6-flash", "deepseek/deepseek-chat"]));
    expect(textModels()[0]).toBe("openai/gpt-4o-mini");
    expect(textModels()).not.toContain("anthropic/claude-3.5-haiku");
  });
});

describe("allTextModels", () => {
  const listing = () => fetchMock.mockImplementation(async (url: string) => (String(url).includes("speech")
    ? rows(["hexgrad/kokoro-82m", "0.0000008", "0"])
    : rows(["openai/gpt-4o-mini", "0.00000015", "0.0000006"], ["anthropic/claude-haiku-5.5", "0.000001", "0.000005"], ["foo/free-one:free", "0", "0"], ["bar/free-two:free", "0", "0"], ["paid/model", "0.000001", "0.000002"])));

  it("hides built-in candidates OpenRouter does not list, and adds its free models", async () => {
    listing();
    const all = await allTextModels();
    expect(all).toEqual(["openai/gpt-4o-mini", "anthropic/claude-haiku-5.5", "bar/free-two:free", "foo/free-one:free"]);
    expect(all).not.toContain("deepseek/deepseek-chat");                    // not listed: hidden instead of failing later
    expect(all).not.toContain("hexgrad/kokoro-82m");                         // a speech model is not a writing model
  });

  it("keeps a list you set yourself exactly as written, and the built-ins when the listing cannot be read", async () => {
    listing();
    vi.stubEnv("OPENROUTER_TEXT_MODELS", "my/own-model");
    expect((await allTextModels())[0]).toBe("my/own-model");
    resetPriceCache();
    vi.stubEnv("OPENROUTER_TEXT_MODELS", "");
    fetchMock.mockRejectedValue(new Error("offline"));
    expect(await allTextModels()).toEqual(textModels());
  });

  it("lets a listed free model be chosen without OPENROUTER_ALLOW_ANY_MODEL, but not a paid one", async () => {
    listing();
    expect(pickTextModel("foo/free-one:free")).toHaveProperty("error");      // listing not loaded yet
    await ensureListed("foo/free-one:free");
    expect(pickTextModel("foo/free-one:free")).toEqual({ model: "foo/free-one:free" });
    expect(pickTextModel("paid/model")).toHaveProperty("error");
    expect(pickTextModel("nobody/else:free")).toHaveProperty("error");       // free by name but not listed
  });
});

describe("free tier", () => {
  it("rates a zero-price model as free", () => expect(textTier({ inPerM: 0, outPerM: 0, source: "live" })).toBe("free"));
});
