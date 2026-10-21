import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

// An in-memory stand-in for the users and usage kept in Netlify Blobs.
const db = vi.hoisted(() => ({ users: new Map<string, Record<string, unknown>>(), usage: new Map<string, unknown>(), clips: [] as Record<string, unknown>[] }));
vi.mock("../../lib/user-store.js", async (orig) => ({
  ...(await orig<typeof import("../../lib/user-store.js")>()),
  getUser: vi.fn(async (n: string) => db.users.get(n.trim().toLowerCase()) ?? null),
  listUsers: vi.fn(async () => [...db.users.values()]),
  saveUser: vi.fn(async (u: { username: string }) => { db.users.set(u.username.toLowerCase(), u as unknown as Record<string, unknown>); }),
  deleteUser: vi.fn(async (n: string) => { db.users.delete(n.toLowerCase()); }),
}));
vi.mock("@netlify/blobs", () => ({
  getStore: () => ({
    get: async (k: string) => db.usage.get(k) ?? null,
    setJSON: async (k: string, v: unknown) => { db.usage.set(k, v); },
  }),
}));
vi.mock("../../lib/throttle.js", () => ({ isBlocked: vi.fn(async () => false), recordFailure: vi.fn(), clearFailures: vi.fn() }));
vi.mock("../../lib/store.js", () => ({
  listClips: vi.fn(async () => db.clips),
  getClip: vi.fn(async (id: string) => { const m = db.clips.find((c) => c.id === id); return m ? { data: new ArrayBuffer(4), metadata: m } : null; }),
  saveClip: vi.fn(), deleteClip: vi.fn(),
}));

import { handleUsers } from "../../lib/handlers/users.js";
import { handleLogin } from "../../lib/handlers/login.js";
import { handleClips } from "../../lib/handlers/clips.js";
import { chargeAi } from "../../lib/quota.js";
import { hashPassword } from "../../lib/passwords.js";

const ADMIN_PW = "admin password 1";
const call = (method: string, path: string, token: string, body?: unknown) =>
  new Request(`http://localhost${path}`, { method, headers: { authorization: `Bearer ${token}` }, ...(body ? { body: JSON.stringify(body) } : {}) });
const signIn = async (username: string, password: string) =>
  ((await (await handleLogin(new Request("http://localhost/api/login", { method: "POST", body: JSON.stringify({ username, password }) }))).json()) as { token: string }).token;

beforeEach(() => {
  db.users.clear(); db.usage.clear(); db.clips = [];
  vi.stubEnv("SESSION_SECRET", "s".repeat(40));
  vi.stubEnv("LOGIN_USERS", `root:${hashPassword(ADMIN_PW)}`);
  vi.stubEnv("ACCESS_KEY", ""); vi.stubEnv("AUTH_DISABLED", "");
  for (const k of ["QUOTA_DAILY_AI", "QUOTA_MONTHLY_AI", "QUOTA_MAX_CLIPS", "QUOTA_MAX_SCHEDULES"]) vi.stubEnv(k, "");
});
afterEach(() => vi.unstubAllEnvs());

describe("user management", () => {
  it("lets an admin create a user who can then sign in, and never returns the hash", async () => {
    const admin = await signIn("root", ADMIN_PW);
    const res = await handleUsers(call("POST", "/api/users", admin, { username: "Dana", password: "dana password 1" }), undefined);
    expect(res.status).toBe(201);
    expect(JSON.stringify(await res.json())).not.toContain("scrypt");
    expect(await signIn("dana", "dana password 1")).toBeTruthy();
    const list = (await (await handleUsers(call("GET", "/api/users", admin), undefined)).json()) as { users: { username: string; source: string }[] };
    expect(list.users.map((u) => `${u.username}:${u.source}`)).toEqual(["root:env", "dana:database"]);
  });

  it("refuses non-admins, duplicate names, weak passwords and self-lockout", async () => {
    const admin = await signIn("root", ADMIN_PW);
    await handleUsers(call("POST", "/api/users", admin, { username: "dana", password: "dana password 1" }), undefined);
    const dana = await signIn("dana", "dana password 1");
    expect((await handleUsers(call("GET", "/api/users", dana), undefined)).status).toBe(403);
    expect((await handleUsers(call("POST", "/api/users", admin, { username: "dana", password: "another password" }), undefined)).status).toBe(409);
    expect((await handleUsers(call("POST", "/api/users", admin, { username: "root", password: "another password" }), undefined)).status).toBe(409);
    expect((await handleUsers(call("POST", "/api/users", admin, { username: "eve", password: "short" }), undefined)).status).toBe(400);
    expect((await handleUsers(call("DELETE", "/api/users/root", admin), "root")).status).toBe(409);   // env account
  });

  it("ends a session as soon as the user is disabled or deleted", async () => {
    const admin = await signIn("root", ADMIN_PW);
    await handleUsers(call("POST", "/api/users", admin, { username: "dana", password: "dana password 1" }), undefined);
    const dana = await signIn("dana", "dana password 1");
    expect((await handleClips(call("GET", "/api/clips", dana), undefined)).status).toBe(200);
    await handleUsers(call("PATCH", "/api/users/dana", admin, { disabled: true }), "dana");
    expect((await handleClips(call("GET", "/api/clips", dana), undefined)).status).toBe(401);
    await expect(signIn("dana", "dana password 1")).resolves.toBeUndefined();
  });

  it("lets people change their own password only with the current one", async () => {
    const admin = await signIn("root", ADMIN_PW);
    await handleUsers(call("POST", "/api/users", admin, { username: "dana", password: "dana password 1" }), undefined);
    const dana = await signIn("dana", "dana password 1");
    expect((await handleUsers(call("PATCH", "/api/users/me", dana, { currentPassword: "wrong", newPassword: "brand new password" }), "me")).status).toBe(403);
    expect((await handleUsers(call("PATCH", "/api/users/me", dana, { currentPassword: "dana password 1", newPassword: "brand new password" }), "me")).status).toBe(200);
    expect(await signIn("dana", "brand new password")).toBeTruthy();
  });
});

describe("ownership", () => {
  it("shows people their own clips plus the station's, and keeps others' private", async () => {
    db.clips = [{ id: "mine", ownerId: "dana", createdAt: "2026-01-02", scriptText: "x", mimeType: "audio/wav" }, { id: "theirs", ownerId: "eve", createdAt: "2026-01-03", scriptText: "x", mimeType: "audio/wav" }, { id: "shared", createdAt: "2026-01-01", scriptText: "x", mimeType: "audio/wav" }];
    const admin = await signIn("root", ADMIN_PW);
    await handleUsers(call("POST", "/api/users", admin, { username: "dana", password: "dana password 1" }), undefined);
    const dana = await signIn("dana", "dana password 1");
    const ids = async (t: string) => ((await (await handleClips(call("GET", "/api/clips", t), undefined)).json()) as { clips: { id: string }[] }).clips.map((c) => c.id);
    expect(await ids(dana)).toEqual(["mine", "shared"]);
    expect((await ids(admin)).length).toBe(3);
    expect((await handleClips(call("GET", "/api/clips/theirs", dana), "theirs")).status).toBe(404);
    expect((await handleClips(call("DELETE", "/api/clips/shared", dana), "shared")).status).toBe(403);
    expect((await handleClips(call("DELETE", "/api/clips/mine", dana), "mine")).status).toBe(204);
  });
});

describe("quotas", () => {
  it("stops a user at their daily AI limit but never limits admins", async () => {
    const admin = await signIn("root", ADMIN_PW);
    await handleUsers(call("POST", "/api/users", admin, { username: "dana", password: "dana password 1", quota: { dailyAi: 2 } }), undefined);
    const dana = { username: "dana", role: "user" as const, via: "login" as const };
    expect(await chargeAi(dana)).toBeNull();
    expect(await chargeAi(dana)).toBeNull();
    const blocked = await chargeAi(dana);
    expect(blocked?.status).toBe(429);
    expect(((await blocked!.json()) as { error: string }).error).toMatch(/Daily limit/);
    for (let i = 0; i < 5; i++) expect(await chargeAi({ username: "root", role: "admin", via: "login" })).toBeNull();
  });

  it("falls back to the site default, and a user's own limit wins", async () => {
    vi.stubEnv("QUOTA_DAILY_AI", "1");
    const admin = await signIn("root", ADMIN_PW);
    await handleUsers(call("POST", "/api/users", admin, { username: "dana", password: "dana password 1" }), undefined);
    await handleUsers(call("POST", "/api/users", admin, { username: "eve", password: "eve password 123", quota: { dailyAi: 3 } }), undefined);
    const as = (username: string) => ({ username, role: "user" as const, via: "login" as const });
    expect(await chargeAi(as("dana"))).toBeNull();
    expect((await chargeAi(as("dana")))?.status).toBe(429);
    for (let i = 0; i < 3; i++) expect(await chargeAi(as("eve"))).toBeNull();
    expect((await chargeAi(as("eve")))?.status).toBe(429);
  });

  it("validates quota numbers and reports a user's own usage", async () => {
    const admin = await signIn("root", ADMIN_PW);
    expect((await handleUsers(call("POST", "/api/users", admin, { username: "dana", password: "dana password 1", quota: { dailyAi: -1 } }), undefined)).status).toBe(400);
    await handleUsers(call("POST", "/api/users", admin, { username: "dana", password: "dana password 1", quota: { dailyAi: 5 } }), undefined);
    await chargeAi({ username: "dana", role: "user", via: "login" });
    const dana = await signIn("dana", "dana password 1");
    const me = (await (await handleUsers(call("GET", "/api/users/me", dana), "me")).json()) as { role: string; quota: { dailyAi: number }; usage: { daily: number } };
    expect(me).toMatchObject({ role: "user", quota: { dailyAi: 5 }, usage: { daily: 1, monthly: 1 } });
  });
});
