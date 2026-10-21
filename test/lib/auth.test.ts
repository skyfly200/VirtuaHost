import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

vi.mock("../../lib/gemini.js", () => ({ writeDjLine: vi.fn(), synthesizeSpeech: vi.fn(), DEFAULT_VOICE: "Kore" }));
vi.mock("../../lib/store.js", () => ({ saveClip: vi.fn(), getClip: vi.fn(), listClips: vi.fn(async () => []) }));
vi.mock("../../lib/user-store.js", async (orig) => ({ ...(await orig<typeof import("../../lib/user-store.js")>()), getUser: vi.fn(async () => null) }));
vi.mock("../../lib/handoff.js", () => ({ handoffConfigured: vi.fn(() => false), handoffDefaults: vi.fn(), pushToStation: vi.fn() }));

import { checkAuth } from "../../lib/auth.js";
import { handleGenerate } from "../../lib/handlers/generate.js";
import { handleClips } from "../../lib/handlers/clips.js";
import { writeDjLine, synthesizeSpeech } from "../../lib/gemini.js";

const KEY = "a-random-key-0123456789abcdef";
const req = (headers: Record<string, string> = {}, method = "GET") => new Request("http://localhost/api/clips", { method, headers });

describe("access key", () => {
  beforeEach(() => {
    vi.stubEnv("ACCESS_KEY", KEY);
    vi.stubEnv("AUTH_DISABLED", "");
  });
  afterEach(() => vi.unstubAllEnvs());

  it("lets a request with the key as x-api-key or as a Bearer token through", async () => {
    expect(await checkAuth(req({ "x-api-key": KEY }))).toBeNull();
    expect(await checkAuth(req({ authorization: `Bearer ${KEY}` }))).toBeNull();
    expect(await checkAuth(req({ authorization: `bearer ${KEY}` }))).toBeNull();
  });

  it("refuses a missing, wrong, truncated or empty key with 401", async () => {
    const bad: Record<string, string>[] = [{}, { "x-api-key": "wrong" }, { "x-api-key": KEY.slice(0, -1) }, { "x-api-key": "" }, { authorization: "Bearer " }];
    for (const headers of bad) {
      const res = await checkAuth(req(headers));
      expect(res?.status, JSON.stringify(headers)).toBe(401);
    }
    const body = (await (await checkAuth(req()))!.json()) as { error: string };
    expect(body.error).not.toContain(KEY);
  });

  it("refuses everything with 503 when no usable key is configured (never open by accident)", async () => {
    for (const value of ["", "short-key"]) {
      vi.stubEnv("ACCESS_KEY", value);
      const res = await checkAuth(req({ "x-api-key": value || "anything" }));
      expect(res?.status).toBe(503);
      expect(((await res!.json()) as { error: string }).error).toMatch(/ACCESS_KEY/);
    }
  });

  it("can be switched off explicitly for local development", async () => {
    vi.stubEnv("ACCESS_KEY", "");
    vi.stubEnv("AUTH_DISABLED", "true");
    expect(await checkAuth(req())).toBeNull();
    vi.stubEnv("AUTH_DISABLED", "yes");                                      // only the exact value counts
    expect((await checkAuth(req()))?.status).toBe(503);
  });

  it("protects /api/generate: nothing is spent on Gemini without the key", async () => {
    const body = JSON.stringify({ mode: "say", text: "hello" });
    const noKey = await handleGenerate(new Request("http://localhost/api/generate", { method: "POST", body }));
    expect(noKey.status).toBe(401);
    const wrong = await handleGenerate(new Request("http://localhost/api/generate", { method: "POST", body, headers: { "x-api-key": "nope" } }));
    expect(wrong.status).toBe(401);
    expect(writeDjLine).not.toHaveBeenCalled();
    expect(synthesizeSpeech).not.toHaveBeenCalled();
  });

  it("protects the clip list and each clip's audio", async () => {
    expect((await handleClips(req(), undefined)).status).toBe(401);
    expect((await handleClips(req(), "abc")).status).toBe(401);
    expect((await handleClips(req({ "x-api-key": KEY }), undefined)).status).toBe(200);
  });
});
