import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { estimateText, estimateSpeech, textTier, speechTier, tokensFor } from "../../lib/pricing.js";
import { resetPriceCache } from "../../lib/openrouter.js";
import { handleEstimate } from "../../lib/handlers/estimate.js";

const fetchMock = vi.fn();
const listing = (rows: Array<[string, string, string]>) => new Response(JSON.stringify({ data: rows.map(([id, p, c]) => ({ id, pricing: { prompt: p, completion: c } })) }), { status: 200 });

beforeEach(() => {
  resetPriceCache();
  fetchMock.mockReset();
  vi.stubGlobal("fetch", fetchMock);
  vi.stubEnv("OPENROUTER_API_KEY", "or-key-0000000000000000"); vi.stubEnv("GEMINI_API_KEY", ""); vi.stubEnv("PROVIDER", "");
  vi.stubEnv("OPENROUTER_TEXT_MODEL", ""); vi.stubEnv("OPENROUTER_TEXT_MODELS", ""); vi.stubEnv("OPENROUTER_ALLOW_ANY_MODEL", "true");
  vi.stubEnv("ELEVENLABS_API_KEY", ""); vi.stubEnv("ACCESS_KEY", "machine-key-0123456789"); vi.stubEnv("AUTH_DISABLED", ""); vi.stubEnv("SESSION_SECRET", "");
});
afterEach(() => { vi.unstubAllEnvs(); vi.unstubAllGlobals(); });

describe("tiers", () => {
  it("rates text models by output price and speech models by name or price", () => {
    expect(textTier({ inPerM: 0.15, outPerM: 0.6, source: "live" })).toBe("budget");
    expect(textTier({ inPerM: 3, outPerM: 15, source: "live" })).toBe("premium");
    expect(textTier(null)).toBe("unknown");
    expect(speechTier("hexgrad/kokoro-82m", null)).toBe("budget");
    expect(speechTier("mystery/tts-x", null)).toBe("standard");
    expect(speechTier("mystery/voice", null)).toBe("unknown");
  });
  it("counts about four characters to a token", () => expect(tokensFor(401)).toBe(101));
});

describe("text estimates", () => {
  it("uses OpenRouter's listed price, and shows a ceiling above the likely cost", async () => {
    fetchMock.mockImplementation(async () => listing([["openai/gpt-4o-mini", "0.00000015", "0.0000006"]]));
    const e = await estimateText({ kind: "write", model: "openai/gpt-4o-mini", inputChars: 400, systemChars: 800, maxOut: 300, expectedOut: 80 });
    expect(e).toMatchObject({ tier: "budget", warn: false, priceSource: "live", tokens: { in: 300, out: 300 } });
    expect(e.costUsd!.max).toBeGreaterThan(e.costUsd!.likely);
    expect(e.costUsd!.max).toBeCloseTo((300 * 0.15 + 300 * 0.6) / 1e6, 8);
  });

  it("warns about a premium model, saying how much dearer it is than the default", async () => {
    fetchMock.mockImplementation(async () => listing([["openai/gpt-4o-mini", "0.00000015", "0.0000006"], ["big/model", "0.000003", "0.000015"]]));
    const e = await estimateText({ kind: "write", model: "big/model", inputChars: 400, maxOut: 300 });
    expect(e).toMatchObject({ tier: "premium", warn: true });
    expect(Math.round(e.timesDefault!)).toBe(25);
    expect(e.message).toMatch(/uses your credits faster/);
  });

  it("falls back to the built-in table when the listing is unavailable, and warns when a price is unknown", async () => {
    fetchMock.mockRejectedValue(new Error("offline"));
    expect(await estimateText({ kind: "write", model: "openai/gpt-4o-mini", inputChars: 100, maxOut: 300 })).toMatchObject({ priceSource: "approx", warn: false });
    const unknown = await estimateText({ kind: "write", model: "who/knows", inputChars: 100, maxOut: 300 });
    expect(unknown).toMatchObject({ tier: "unknown", costUsd: null, warn: true });
  });

  it("counts an image against the flier reader", async () => {
    fetchMock.mockRejectedValue(new Error("offline"));
    const withImage = await estimateText({ kind: "flier-read", model: "openai/gpt-4o-mini", inputChars: 100, maxOut: 900, image: true });
    const without = await estimateText({ kind: "flier-read", model: "openai/gpt-4o-mini", inputChars: 100, maxOut: 900 });
    expect(withImage.tokens!.in - without.tokens!.in).toBe(1100);
  });
});

describe("speech estimates", () => {
  it("shows length always, and a cost only when a price is listed", async () => {
    fetchMock.mockImplementation(async (url: string) => (String(url).includes("speech") ? listing([["hexgrad/kokoro-82m", "0.0000008", "0"]]) : listing([])));
    const priced = await estimateSpeech({ model: "hexgrad/kokoro-82m", chars: 300 });
    expect(priced.seconds).toBe(20);
    expect(priced).toMatchObject({ tier: "budget", warn: false });
    expect(priced.costUsd).not.toBeNull();
    fetchMock.mockRejectedValue(new Error("offline"));
    expect((await estimateSpeech({ model: "other/tts", chars: 300 })).costUsd).toBeNull();
  });
});

describe("POST /api/estimate", () => {
  const call = (body: unknown, key: string | null = "machine-key-0123456789") =>
    handleEstimate(new Request("http://localhost/api/estimate", { method: "POST", headers: { "content-type": "application/json", ...(key ? { "x-api-key": key } : {}) }, body: JSON.stringify(body) }));

  it("needs a sign-in and a known kind", async () => {
    expect((await call({ kind: "write" }, null)).status).toBe(401);
    expect((await call({ kind: "nope" })).status).toBe(400);
    expect((await handleEstimate(new Request("http://localhost/api/estimate"))).status).toBe(401);
  });

  it("estimates writing, speaking and flier steps without calling any AI model", async () => {
    fetchMock.mockImplementation(async () => listing([["openai/gpt-4o-mini", "0.00000015", "0.0000006"]]));
    const write = (await (await call({ kind: "write", prompt: "a station id" })).json()) as { estimate: { model: string; tokens: { out: number } } };
    expect(write.estimate).toMatchObject({ model: "openai/gpt-4o-mini", tokens: { out: 1500 } });
    const speak = (await (await call({ kind: "speak", text: "Hello [laughs] there" })).json()) as { estimate: { model: string; seconds: number } };
    expect(speak.estimate.model).toBe("hexgrad/kokoro-82m");
    expect(speak.estimate.seconds).toBeCloseTo("Hello  there".length / 15, 5);
    expect((await call({ kind: "flier-read", image: "data:image/png;base64,AAAA" })).status).toBe(200);
    expect((await call({ kind: "flier-promo", event: { name: "Show" }, count: 2 })).status).toBe(200);
    expect(fetchMock.mock.calls.every((c) => String(c[0]).includes("/models"))).toBe(true);   // only price listings, never a completion
  });

  it("rejects a writing model that is not allowed", async () => {
    vi.stubEnv("OPENROUTER_ALLOW_ANY_MODEL", "");
    fetchMock.mockImplementation(async () => listing([]));
    expect((await call({ kind: "write", prompt: "x", textModel: "not/allowed" })).status).toBe(400);
  });
});
