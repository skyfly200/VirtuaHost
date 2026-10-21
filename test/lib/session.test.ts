import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { hashPassword, verifyPassword } from "../../lib/passwords.js";
vi.mock("../../lib/user-store.js", async (orig) => ({ ...(await orig<typeof import("../../lib/user-store.js")>()), getUser: vi.fn(async () => null) }));

import { parseUsers, checkPassword, issueToken, readToken, verifyToken, loginConfigured } from "../../lib/session.js";

const SECRET = "s".repeat(40);

describe("passwords", () => {
  it("verifies the right password and rejects wrong ones", () => {
    const hash = hashPassword("correct horse battery");
    expect(hash).toMatch(/^scrypt\.[0-9a-f]{32}\.[0-9a-f]{64}$/);
    expect(verifyPassword("correct horse battery", hash)).toBe(true);
    expect(verifyPassword("correct horse batter", hash)).toBe(false);
    expect(verifyPassword("", hash)).toBe(false);
  });

  it("salts each hash, and refuses malformed hashes instead of throwing", () => {
    expect(hashPassword("same")).not.toBe(hashPassword("same"));
    for (const bad of ["", "plain", "scrypt..", "scrypt.zz.zz", "bcrypt.aa.bb", `scrypt.${"a".repeat(32)}.abcd`]) {
      expect(verifyPassword("x", bad), bad).toBe(false);
    }
  });
});

describe("sessions", () => {
  beforeEach(() => {
    vi.stubEnv("SESSION_SECRET", SECRET);
    vi.stubEnv("SESSION_HOURS", "");
    vi.stubEnv("LOGIN_USERS", `alice:${hashPassword("alice password")}, bob:${hashPassword("bob password")}`);
  });
  afterEach(() => vi.unstubAllEnvs());

  it("reads users from LOGIN_USERS and ignores malformed entries", () => {
    expect([...parseUsers("a:h1, b:h2 ,nocolon,:nouser, bad name:h3,c:")].map(([n, h]) => `${n}=${h}`)).toEqual(["a=h1", "b=h2"]);
    expect(parseUsers("").size).toBe(0);
    expect(parseUsers(undefined).size).toBe(2);
  });

  it("is configured once the signing secret is long enough", () => {
    expect(loginConfigured()).toBe(true);
    vi.stubEnv("SESSION_SECRET", "short");
    expect(loginConfigured()).toBe(false);
  });

  it("checks passwords per user, and never accepts an unknown user", async () => {
    expect(await checkPassword("alice", "alice password")).toMatchObject({ username: "alice", role: "admin", source: "env" });
    expect(await checkPassword("alice", "bob password")).toBeNull();
    expect(await checkPassword("bob", "bob password")).not.toBeNull();
    expect(await checkPassword("mallory", "alice password")).toBeNull();
    expect(await checkPassword("", "")).toBeNull();
  });

  it("issues tokens that verify, expire, and carry the username", async () => {
    const now = 1_000_000;
    const { token, expiresAt } = issueToken("alice", now);
    expect(expiresAt).toBe(now + 12 * 3600_000);
    expect(readToken(token, now + 1000)).toBe("alice");
    expect((await verifyToken(token, now + 1000))?.username).toBe("alice");
    expect(readToken(token, expiresAt - 1)).toBe("alice");
    expect(readToken(token, expiresAt + 1)).toBeNull();
    vi.stubEnv("SESSION_HOURS", "1");
    expect(issueToken("alice", now).expiresAt).toBe(now + 3600_000);
  });

  it("rejects tampered, foreign, malformed and orphaned tokens", async () => {
    const { token } = issueToken("alice");
    const [v, payload, sig] = token.split(".");
    const forged = Buffer.from(JSON.stringify({ sub: "bob", exp: Date.now() + 1e9 })).toString("base64url");
    for (const bad of ["", "x", `${v}.${payload}.`, `${v}.${forged}.${sig}`, `${v}.${payload}.${sig.slice(0, -2)}AA`, `v2.${payload}.${sig}`, `${token}.extra`]) {
      expect(readToken(bad), bad).toBeNull();
    }
    vi.stubEnv("SESSION_SECRET", "t".repeat(40));                            // a new secret signs everyone out
    expect(readToken(token)).toBeNull();
    vi.stubEnv("SESSION_SECRET", SECRET);
    vi.stubEnv("LOGIN_USERS", `bob:${hashPassword("bob password")}`);        // removing a user ends their session
    expect(await verifyToken(token)).toBeNull();
  });
});
