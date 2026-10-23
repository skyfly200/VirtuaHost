import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

vi.mock("../../lib/user-store.js", async (orig) => ({ ...(await orig<typeof import("../../lib/user-store.js")>()), getUser: vi.fn(async () => null), saveUser: vi.fn() }));
vi.mock("../../lib/throttle.js", () => ({ isBlocked: vi.fn(), recordFailure: vi.fn(), clearFailures: vi.fn() }));

import { isBlocked, recordFailure, clearFailures } from "../../lib/throttle.js";
import { handleLogin } from "../../lib/handlers/login.js";
import { hashPassword } from "../../lib/passwords.js";
import { checkAuth } from "../../lib/auth.js";

const post = (body: unknown, ip = "203.0.113.5") =>
  new Request("http://localhost/api/login", { method: "POST", body: typeof body === "string" ? body : JSON.stringify(body), headers: { "x-nf-client-connection-ip": ip } });

beforeEach(() => {
  vi.clearAllMocks();
  vi.mocked(isBlocked).mockResolvedValue(false);
  vi.stubEnv("SESSION_SECRET", "s".repeat(40));
  vi.stubEnv("LOGIN_USERS", `alice:${hashPassword("alice password")}`);
  vi.stubEnv("ACCESS_KEY", "");
  vi.stubEnv("AUTH_DISABLED", "");
});
afterEach(() => vi.unstubAllEnvs());

describe("POST /api/login", () => {
  it("signs in with the right password and returns a token the API accepts", async () => {
    const res = await handleLogin(post({ username: "alice", password: "alice password" }));
    const body = (await res.json()) as { token: string; username: string; expiresAt: number };

    expect(res.status).toBe(200);
    expect(body.username).toBe("alice");
    expect(body.expiresAt).toBeGreaterThan(Date.now());
    expect(vi.mocked(clearFailures)).toHaveBeenCalledWith("203.0.113.5");
    const api = new Request("http://localhost/api/clips", { headers: { authorization: `Bearer ${body.token}` } });
    expect(await checkAuth(api)).toBeNull();
  });

  it("refuses a wrong password or unknown user with the same message, and counts the failure", async () => {
    const wrong = await handleLogin(post({ username: "alice", password: "nope nope nope" }));
    const unknown = await handleLogin(post({ username: "mallory", password: "alice password" }));
    expect(wrong.status).toBe(401);
    expect(unknown.status).toBe(401);
    expect(((await wrong.json()) as { error: string }).error).toBe(((await unknown.json()) as { error: string }).error);
    expect(vi.mocked(recordFailure)).toHaveBeenCalledTimes(2);
    expect(vi.mocked(clearFailures)).not.toHaveBeenCalled();
  });

  it("is blocked after too many failures, without even checking the password", async () => {
    vi.mocked(isBlocked).mockResolvedValue(true);
    const res = await handleLogin(post({ username: "alice", password: "alice password" }));
    expect(res.status).toBe(429);
    expect(vi.mocked(recordFailure)).not.toHaveBeenCalled();
  });

  it("validates the request", async () => {
    expect((await handleLogin(post("not json"))).status).toBe(400);
    expect((await handleLogin(post({ username: "alice" }))).status).toBe(400);
    expect((await handleLogin(post({ username: "alice", password: "x".repeat(500) }))).status).toBe(400);
    expect((await handleLogin(post({ username: 5, password: 6 }))).status).toBe(400);
    expect((await handleLogin(new Request("http://localhost/api/login", { method: "PUT" }))).status).toBe(405);
  });

  it("says so when password login is not set up", async () => {
    vi.stubEnv("SESSION_SECRET", "");
    const res = await handleLogin(post({ username: "alice", password: "alice password" }));
    expect(res.status).toBe(503);
    expect(((await res.json()) as { error: string }).error).toMatch(/SESSION_SECRET/);
  });
});

describe("GET /api/login", () => {
  it("reports which sign-in methods exist, and nothing secret", async () => {
    vi.stubEnv("ACCESS_KEY", "k".repeat(20));
    const res = await handleLogin(new Request("http://localhost/api/login"));
    expect(await res.json()).toEqual({ passwordLogin: true, accessKey: true, disabled: false });
    vi.stubEnv("SESSION_SECRET", "");
    vi.stubEnv("ACCESS_KEY", "");
    expect(await (await handleLogin(new Request("http://localhost/api/login"))).json()).toEqual({ passwordLogin: false, accessKey: false, disabled: false });
  });
});

describe("the API accepts either a login or the access key", () => {
  const req = (credential?: string) => new Request("http://localhost/api/clips", { headers: credential ? { "x-api-key": credential } : {} });

  it("lets a script use the access key while people use logins", async () => {
    vi.stubEnv("ACCESS_KEY", "machine-key-0123456789");
    const login = (await (await handleLogin(post({ username: "alice", password: "alice password" }))).json()) as { token: string };
    expect(await checkAuth(req("machine-key-0123456789"))).toBeNull();
    expect(await checkAuth(req(login.token))).toBeNull();
    expect((await checkAuth(req("something else")))?.status).toBe(401);
    expect((await checkAuth(req()))?.status).toBe(401);
  });

  it("works with only logins configured, and with only the key configured", async () => {
    expect((await checkAuth(req()))?.status).toBe(401);                         // logins only, no credential
    vi.stubEnv("SESSION_SECRET", "");
    vi.stubEnv("ACCESS_KEY", "machine-key-0123456789");
    expect(await checkAuth(req("machine-key-0123456789"))).toBeNull();
    vi.stubEnv("ACCESS_KEY", "");
    expect((await checkAuth(req("machine-key-0123456789")))?.status).toBe(503);  // nothing configured: closed
  });

  it("does not accept a session token once the user is gone, or after a new secret", async () => {
    const login = (await (await handleLogin(post({ username: "alice", password: "alice password" }))).json()) as { token: string };
    vi.stubEnv("SESSION_SECRET", "z".repeat(40));
    expect((await checkAuth(req(login.token)))?.status).toBe(401);
  });
});
