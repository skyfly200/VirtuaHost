import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

const db = vi.hoisted(() => ({ blobs: new Map<string, unknown>(), users: new Map<string, Record<string, unknown>>() }));
vi.mock("@netlify/blobs", () => ({
  getStore: () => ({
    get: async (k: string) => db.blobs.get(k) ?? null,
    setJSON: async (k: string, v: unknown) => { db.blobs.set(k, v); },
    delete: async (k: string) => { db.blobs.delete(k); },
  }),
}));
vi.mock("../../lib/user-store.js", async (orig) => ({
  ...(await orig<typeof import("../../lib/user-store.js")>()),
  getUser: vi.fn(async (n: string) => db.users.get(n.toLowerCase()) ?? null),
}));
vi.mock("../../lib/station-profile-store.js", () => ({
  getStation: vi.fn(async (id: string | undefined) => (id === "kxyz" ? { id: "kxyz", name: "KXYZ", tz: "UTC", textModels: ["openai/gpt-4o-mini"], speechModels: ["hexgrad/kokoro-82m|af_heart"] } : id === "open" ? { id: "open", name: "Open", tz: "UTC" } : null)),
}));

import { handleKeys } from "../../lib/handlers/keys.js";
import { resolveScope, encrypt, decrypt } from "../../lib/provider-keys.js";
import { runWithScope, apiKey, keySource } from "../../lib/credentials.js";
import { activeProvider } from "../../lib/ai.js";
import { textModels, pickTextModel, allowAnyModel, speechModels, defaultTextModel } from "../../lib/openrouter.js";
import { chargeAi } from "../../lib/quota.js";
import { hashPassword } from "../../lib/passwords.js";
import { handleLogin } from "../../lib/handlers/login.js";

vi.mock("../../lib/throttle.js", () => ({ isBlocked: vi.fn(async () => false), recordFailure: vi.fn(), clearFailures: vi.fn() }));

const call = (method: string, path: string, token: string, body?: unknown) =>
  new Request(`http://localhost${path}`, { method, headers: { authorization: `Bearer ${token}`, "content-type": "application/json" }, ...(body ? { body: JSON.stringify(body) } : {}) });
const signIn = async (u: string, p: string) => ((await (await handleLogin(new Request("http://localhost/api/login", { method: "POST", body: JSON.stringify({ username: u, password: p }) }))).json()) as { token: string }).token;
const KEY = "sk-or-v1-abcdefghijklmnopqrstuvwxyz1234";

beforeEach(() => {
  db.blobs.clear(); db.users.clear();
  db.users.set("dana", { username: "dana", role: "user", passwordHash: hashPassword("dana password 1"), createdAt: "", updatedAt: "" });
  vi.stubEnv("SESSION_SECRET", "s".repeat(40));
  vi.stubEnv("SECRETS_KEY", "");
  vi.stubEnv("LOGIN_USERS", `root:${hashPassword("admin password 1")}`);
  vi.stubEnv("ACCESS_KEY", ""); vi.stubEnv("AUTH_DISABLED", "");
  vi.stubEnv("OPENROUTER_API_KEY", "site-or-key-0000000000"); vi.stubEnv("GEMINI_API_KEY", "");
  vi.stubEnv("PROVIDER", ""); vi.stubEnv("OPENROUTER_ALLOW_ANY_MODEL", ""); vi.stubEnv("OPENROUTER_TEXT_MODEL", "");
  for (const k of ["QUOTA_DAILY_AI", "QUOTA_MONTHLY_AI", "QUOTA_MAX_CLIPS", "QUOTA_MAX_SCHEDULES"]) vi.stubEnv(k, "");
});
afterEach(() => vi.unstubAllEnvs());

describe("stored keys", () => {
  it("encrypts round-trip, and a different secret cannot read it", () => {
    const token = encrypt(KEY);
    expect(token).not.toContain(KEY);
    expect(decrypt(token)).toBe(KEY);
    vi.stubEnv("SESSION_SECRET", "t".repeat(40));
    expect(decrypt(token)).toBeNull();
  });

  it("lets a person save and remove their own key, and never returns it", async () => {
    const dana = await signIn("dana", "dana password 1");
    expect((await handleKeys(call("PUT", "/api/keys", dana, { provider: "openrouter", key: KEY }))).status).toBe(200);
    const res = await handleKeys(call("GET", "/api/keys", dana));
    const text = JSON.stringify(await res.json());
    expect(text).toContain(KEY.slice(-4));
    expect(text).not.toContain(KEY);
    expect(JSON.stringify([...db.blobs.values()])).not.toContain(KEY);          // stored encrypted
    expect((await handleKeys(call("DELETE", "/api/keys?provider=openrouter", dana))).status).toBe(204);
    expect(((await (await handleKeys(call("GET", "/api/keys", dana))).json()) as { user: object }).user).toEqual({});
  });

  it("validates keys and only lets admins set a station's key", async () => {
    const dana = await signIn("dana", "dana password 1");
    const root = await signIn("root", "admin password 1");
    expect((await handleKeys(call("PUT", "/api/keys", dana, { provider: "openrouter", key: "short" }))).status).toBe(400);
    expect((await handleKeys(call("PUT", "/api/keys", dana, { provider: "nope", key: KEY }))).status).toBe(400);
    expect((await handleKeys(call("PUT", "/api/keys", dana, { provider: "openrouter", key: KEY, station: "open" }))).status).toBe(403);
    expect((await handleKeys(call("PUT", "/api/keys", root, { provider: "openrouter", key: KEY, station: "missing" }))).status).toBe(404);
    expect((await handleKeys(call("PUT", "/api/keys", root, { provider: "openrouter", key: KEY, station: "open" }))).status).toBe(200);
    const seen = (await (await handleKeys(call("GET", "/api/keys?station=open", root))).json()) as { station: object };
    expect(Object.keys(seen.station)).toEqual(["openrouter"]);
    const hidden = (await (await handleKeys(call("GET", "/api/keys?station=open", dana))).json()) as { station?: object };
    expect(hidden.station).toBeUndefined();
  });

  it("does not let the machine key own a provider key", async () => {
    vi.stubEnv("SESSION_SECRET", "");
    vi.stubEnv("ACCESS_KEY", "machine-key-0123456789");
    const res = await handleKeys(new Request("http://localhost/api/keys", { method: "PUT", headers: { "x-api-key": "machine-key-0123456789" }, body: "{}" }));
    expect(res.status).toBe(400);                                                // the machine key has no username to own a key
  });
});

describe("which key is used", () => {
  const withKey = async (owner: "user" | "station", id: string, key: string, provider = "openrouter") => {
    const { setProviderKey } = await import("../../lib/provider-keys.js");
    await setProviderKey({ kind: owner, id }, provider as "openrouter", key);
  };

  it("prefers the person's key, then the station's, then the site's", async () => {
    await withKey("station", "open", "station-key-0000000000");
    await withKey("user", "dana", "dana-key-00000000000000");
    const keyIn = async (user: string | undefined, station: string | undefined) => runWithScope(await resolveScope(user, station), () => apiKey("openrouter"));
    expect(await keyIn("dana", "open")).toBe("dana-key-00000000000000");
    expect(await keyIn("eve", "open")).toBe("station-key-0000000000");
    expect(await keyIn("eve", undefined)).toBe("site-or-key-0000000000");
    expect(await keyIn(undefined, undefined)).toBe("site-or-key-0000000000");
    const scope = await resolveScope("dana", "open");
    expect(runWithScope(scope, () => keySource("openrouter"))).toBe("user");
  });

  it("uses a person's Gemini key even when the site is set up for OpenRouter", async () => {
    await withKey("user", "dana", "AIzaSyDANA0000000000000000", "gemini");
    expect(activeProvider()).toBe("openrouter");
    expect(runWithScope(await resolveScope("dana", undefined), () => activeProvider())).toBe("gemini");
  });

  it("does not charge AI quota to someone using their own key", async () => {
    db.users.set("dana", { ...db.users.get("dana")!, quota: { dailyAi: 0 } });
    const dana = { username: "dana", role: "user" as const, via: "login" as const };
    expect((await chargeAi(dana))?.status).toBe(429);
    await withKey("user", "dana", "dana-key-00000000000000");
    expect(await runWithScope(await resolveScope("dana", undefined), () => chargeAi(dana))).toBeNull();
  });
});

describe("station model limits", () => {
  it("limits writing and speech models to the station's list, even with your own key", async () => {
    const { setProviderKey } = await import("../../lib/provider-keys.js");
    await setProviderKey({ kind: "user", id: "dana" }, "openrouter", "dana-key-00000000000000");
    await runWithScope(await resolveScope("dana", "kxyz"), async () => {
      expect(textModels()).toEqual(["openai/gpt-4o-mini"]);
      expect(speechModels().map((m) => m.id)).toEqual(["hexgrad/kokoro-82m"]);
      expect(allowAnyModel()).toBe(false);
      expect(pickTextModel("anthropic/claude-3.5-haiku")).toHaveProperty("error");
      expect(defaultTextModel()).toBe("openai/gpt-4o-mini");
    });
  });

  it("lets a person with their own key name any model when the station has no list", async () => {
    const { setProviderKey } = await import("../../lib/provider-keys.js");
    expect(allowAnyModel()).toBe(false);
    await setProviderKey({ kind: "user", id: "dana" }, "openrouter", "dana-key-00000000000000");
    await runWithScope(await resolveScope("dana", "open"), async () => {
      expect(allowAnyModel()).toBe(true);
      expect(pickTextModel("mistralai/mistral-small")).toEqual({ model: "mistralai/mistral-small" });
    });
  });
});
