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
  getUser: vi.fn(async (n: string) => db.users.get(n.trim().toLowerCase()) ?? null),
  saveUser: vi.fn(async (u: { username: string }) => { db.users.set(u.username.toLowerCase(), u as unknown as Record<string, unknown>); }),
}));
vi.mock("../../lib/throttle.js", () => ({ isBlocked: vi.fn(async () => false), recordFailure: vi.fn(), clearFailures: vi.fn() }));

import { handleOauth } from "../../lib/handlers/oauth.js";
import { handleUsers } from "../../lib/handlers/users.js";
import { handleLogin } from "../../lib/handlers/login.js";
import { hashPassword } from "../../lib/passwords.js";
import { makeState, readState } from "../../lib/oauth.js";
import { readToken } from "../../lib/session.js";

const PW = "root password 1";
const auth = (token: string, method: string, path: string, body?: unknown) =>
  new Request(`https://site.test${path}`, { method, headers: { authorization: `Bearer ${token}` }, ...(body ? { body: JSON.stringify(body) } : {}) });
const signIn = async (username = "root") =>
  ((await (await handleLogin(new Request("https://site.test/api/login", { method: "POST", body: JSON.stringify({ username, password: PW }) }))).json()) as { token: string }).token;

// Google answers the token exchange and the userinfo call.
const fakeGoogle = (sub: string) => vi.stubGlobal("fetch", vi.fn(async (url: string) =>
  new Response(JSON.stringify(String(url).includes("userinfo") ? { sub, email: `${sub}@example.com`, email_verified: true } : { access_token: "tok" }), { status: 200 })));

beforeEach(() => {
  db.blobs.clear(); db.users.clear();
  vi.stubEnv("SESSION_SECRET", "s".repeat(40));
  vi.stubEnv("LOGIN_USERS", `root:${hashPassword(PW)}`);
  vi.stubEnv("GOOGLE_CLIENT_ID", "gid"); vi.stubEnv("GOOGLE_CLIENT_SECRET", "gsecret");
  vi.stubEnv("GITHUB_CLIENT_ID", ""); vi.stubEnv("GITHUB_CLIENT_SECRET", "");
  vi.stubEnv("ACCESS_KEY", ""); vi.stubEnv("AUTH_DISABLED", ""); vi.stubEnv("SITE_URL", "");
});
afterEach(() => { vi.unstubAllEnvs(); vi.unstubAllGlobals(); });

describe("email and linked logins", () => {
  it("changes the email only with the right password, and keeps it unique", async () => {
    const token = await signIn();
    expect((await handleUsers(auth(token, "PATCH", "/api/users/me", { email: "a@b.co", currentPassword: "wrong" }), "me")).status).toBe(403);
    expect((await handleUsers(auth(token, "PATCH", "/api/users/me", { email: "nope", currentPassword: PW }), "me")).status).toBe(400);
    expect((await handleUsers(auth(token, "PATCH", "/api/users/me", { email: "A@B.co", currentPassword: PW }), "me")).status).toBe(200);
    const me = (await (await handleUsers(auth(token, "GET", "/api/users/me"), "me")).json()) as { email: string; providers: string[] };
    expect(me.email).toBe("a@b.co");
    expect(me.providers).toEqual(["google"]);
  });

  it("links Google to the signed-in account, then signs in with it, and unlinks", async () => {
    const token = await signIn();
    const start = (await (await handleOauth(auth(token, "POST", "/api/oauth/google/start"), "google", "start")).json()) as { url: string };
    const state = new URL(start.url).searchParams.get("state")!;
    expect(readState(state)).toMatchObject({ mode: "link", username: "root", provider: "google" });

    fakeGoogle("g-123");
    const linked = await handleOauth(new Request(`https://site.test/api/oauth/google/callback?code=c&state=${state}`), "google", "callback");
    expect(linked.headers.get("location")).toBe("https://site.test/#account-linked=google");

    const login = await handleOauth(new Request("https://site.test/api/oauth/google/callback?code=c&state=" + makeState({ mode: "login", provider: "google" })), "google", "callback");
    const hash = new URL(login.headers.get("location")!).hash;
    expect(readToken(hash.replace("#sso=", ""))).toBe("root");

    const me = (await (await handleUsers(auth(token, "GET", "/api/users/me"), "me")).json()) as { identities: { google: { label: string } } };
    expect(me.identities.google.label).toBe("g-123@example.com");
    expect((await handleOauth(auth(token, "DELETE", "/api/oauth/google"), "google", undefined)).status).toBe(204);
    const after = await handleOauth(new Request("https://site.test/api/oauth/google/callback?code=c&state=" + makeState({ mode: "login", provider: "google" })), "google", "callback");
    expect(after.headers.get("location")).toBe("https://site.test/#sso-error=unlinked");
  });

  it("will not link a Google account that already belongs to someone else", async () => {
    db.users.set("dana", { username: "dana", passwordHash: hashPassword(PW), role: "user", createdAt: "", updatedAt: "" });
    fakeGoogle("g-1");
    const link = async (u: string) => handleOauth(new Request(`https://site.test/api/oauth/google/callback?code=c&state=${makeState({ mode: "link", provider: "google", username: u })}`), "google", "callback");
    expect((await link("root")).headers.get("location")).toContain("account-linked");
    expect((await link("dana")).headers.get("location")).toContain("sso-error=taken");
  });

  it("rejects tampered or expired state and unconfigured providers", async () => {
    const good = makeState({ mode: "login", provider: "google" });
    expect(readState(good + "x")).toBeNull();
    expect(readState(good, Date.now() + 11 * 60_000)).toBeNull();
    const res = await handleOauth(new Request("https://site.test/api/oauth/github/start"), "github", "start");
    expect(res.status).toBe(503);
  });
});
