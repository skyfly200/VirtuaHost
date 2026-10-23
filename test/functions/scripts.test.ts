import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

// One in-memory stand-in for every Netlify Blobs store (scripts, users, usage, secrets, stations).
const blobs = vi.hoisted(() => new Map<string, unknown>());
vi.mock("@netlify/blobs", () => ({
  getStore: () => ({
    list: async ({ prefix }: { prefix: string }) => ({ blobs: [...blobs.keys()].filter((k) => k.startsWith(prefix)).sort().map((key) => ({ key })) }),
    get: async (key: string) => blobs.get(key) ?? null,
    setJSON: async (key: string, value: unknown) => { blobs.set(key, JSON.parse(JSON.stringify(value))); },
    delete: async (key: string) => { blobs.delete(key); },
  }),
}));
vi.mock("../../lib/ai.js", async (importOriginal) => ({ ...(await importOriginal<typeof import("../../lib/ai.js")>()), complete: vi.fn() }));
vi.mock("../../lib/throttle.js", () => ({ isBlocked: vi.fn(async () => false), recordFailure: vi.fn(), clearFailures: vi.fn() }));

import { complete } from "../../lib/ai.js";
import { handleScripts } from "../../lib/handlers/scripts.js";
import { issueToken } from "../../lib/session.js";
import { hashPassword } from "../../lib/passwords.js";

const KEY = "test-access-key-0123456789";
const SECRET = "s".repeat(40);
const cast = [{ name: "Rocky", role: "host" }, { name: "Dale", role: "caller" }];
const conversation = { name: "Late shift", kind: "conversation", cast, topic: "the night crew", text: "Rocky: Welcome to {{station}}.\nDale: Glad to be here.", tags: ["late"] };

// Requests as the admin (the access key, which owns nothing) unless `as` names a signed-in user.
const req = (method: string, path: string, body?: unknown, as?: string) => {
  const headers: Record<string, string> = { "content-type": "application/json" };
  if (as) headers.authorization = `Bearer ${issueToken(as).token}`;
  else headers["x-api-key"] = KEY;
  return new Request(`http://localhost/api/scripts${path}`, { method, headers, ...(body === undefined ? {} : { body: JSON.stringify(body) }) });
};
const route = (method: string, id?: string, body?: unknown, as?: string) => handleScripts(req(method, id ? `/${id}` : "", body, as), id);
const json = async <T = Record<string, unknown>>(res: Response): Promise<T> => (await res.json()) as T;

beforeEach(() => {
  blobs.clear();
  vi.mocked(complete).mockReset();
  vi.stubEnv("ACCESS_KEY", KEY);
  vi.stubEnv("SESSION_SECRET", SECRET);
  vi.stubEnv("LOGIN_USERS", `root:${hashPassword("root password 1")}`);
  vi.stubEnv("OPENROUTER_API_KEY", "or-key");
  vi.stubEnv("PROVIDER", "");
  vi.stubEnv("STATION_NAME", "KRAP");
  vi.stubEnv("QUOTA_DAILY_AI", "");
  vi.stubEnv("QUOTA_MONTHLY_AI", "");
});
afterEach(() => vi.unstubAllEnvs());

describe("scripts API", () => {
  it("refuses an unauthenticated request", async () => {
    const res = await handleScripts(new Request("http://localhost/api/scripts", { method: "GET" }), undefined);
    expect(res.status).toBe(401);
  });

  it("creates, lists, reads, updates and deletes a script", async () => {
    const created = await route("POST", undefined, conversation);
    expect(created.status).toBe(201);
    const { script } = await json<{ script: { id: string; name: string; gapSeconds: number } }>(created);
    expect(script.name).toBe("Late shift");
    expect(script.gapSeconds).toBe(0.3);

    const list = await json<{ scripts: Array<{ id: string }> }>(await route("GET"));
    expect(list.scripts.map((s) => s.id)).toContain(script.id);

    const one = await route("GET", script.id);
    expect((await json<{ script: { text: string } }>(one)).script.text).toContain("{{station}}");

    const put = await route("PUT", script.id, { ...conversation, name: "Late shift, revised" });
    expect(put.status).toBe(200);
    expect((await json<{ script: { name: string } }>(put)).script.name).toBe("Late shift, revised");

    expect((await route("DELETE", script.id)).status).toBe(204);
    expect((await route("GET", script.id)).status).toBe(404);
  });

  it("refuses an invalid script with the reason, saving nothing", async () => {
    const five = { ...conversation, cast: [...cast, { name: "Ann" }, { name: "Bo" }, { name: "Cy" }] };
    const res = await route("POST", undefined, five);
    expect(res.status).toBe(400);
    expect((await json<{ error: string }>(res)).error).toContain("at most 4");
    expect((await json<{ scripts: unknown[] }>(await route("GET"))).scripts).toEqual([]);
  });

  it("lets a signed-in user change their own script, but not one that is shared", async () => {
    blobs.set("users/alice.json", { username: "alice", role: "user", passwordHash: hashPassword("alice password 1") });
    const mine = await json<{ script: { id: string; ownerId?: string } }>(await route("POST", undefined, conversation, "alice"));
    expect(mine.script.ownerId).toBe("alice");
    expect((await route("PUT", mine.script.id, { ...conversation, name: "Mine" }, "alice")).status).toBe(200);

    const shared = await json<{ script: { id: string; ownerId?: string } }>(await route("POST", undefined, { ...conversation, name: "House script" }));
    expect(shared.script.ownerId).toBeUndefined();
    expect((await route("GET", shared.script.id, undefined, "alice")).status).toBe(200);
    expect((await route("PUT", shared.script.id, { ...conversation, name: "Hijacked" }, "alice")).status).toBe(403);
    expect((await route("DELETE", shared.script.id, undefined, "alice")).status).toBe(403);
    expect((await route("PUT", shared.script.id, { ...conversation, name: "Admin edit" })).status).toBe(200);
  });

  it("drafts a script with the AI and returns the text and its lines (nothing saved)", async () => {
    vi.mocked(complete).mockResolvedValue("Rocky: Welcome to {{station}} at midnight.\nDale: Glad to be here.");
    const res = await route("POST", "draft", { kind: "conversation", cast, topic: "the night crew" });
    expect(res.status).toBe(200);
    const body = await json<{ text: string; lines: Array<{ speaker: string; text: string }> }>(res);
    expect(body.text).toBe("Rocky: Welcome to KRAP at midnight.\nDale: Glad to be here.");
    expect(body.lines).toEqual([
      { speaker: "Rocky", text: "Welcome to {{station}} at midnight." },
      { speaker: "Dale", text: "Glad to be here." },
    ]);
    expect((await json<{ scripts: unknown[] }>(await route("GET"))).scripts).toEqual([]);
  });

  it("answers 400 for a draft without a topic, and for a conversation with one speaker", async () => {
    const noTopic = await route("POST", "draft", { kind: "conversation", cast });
    expect(noTopic.status).toBe(400);
    expect((await json<{ error: string }>(noTopic)).error).toContain("topic");

    const oneSpeaker = await route("POST", "draft", { kind: "conversation", cast: [cast[0]], topic: "x" });
    expect(oneSpeaker.status).toBe(400);
    expect((await json<{ error: string }>(oneSpeaker)).error).toContain("at least two speakers");
    expect(vi.mocked(complete)).not.toHaveBeenCalled();
  });

  it("answers 502 when the writing model fails", async () => {
    vi.mocked(complete).mockRejectedValue(new Error("upstream timeout"));
    const res = await route("POST", "draft", { kind: "conversation", cast, topic: "x" });
    expect(res.status).toBe(502);
    expect((await json<{ error: string }>(res)).error).toContain("upstream timeout");
  });

  it("fills a saved script's placeholders for the station, and 404s an unknown script", async () => {
    const { script } = await json<{ script: { id: string } }>(await route("POST", undefined, { ...conversation, stationId: "default" }));
    const res = await route("POST", "filled", { scriptId: script.id });
    expect(res.status).toBe(200);
    const body = await json<{ filledIn: string; raw: string }>(res);
    expect(body.filledIn).toBe("Rocky: Welcome to KRAP.\nDale: Glad to be here.");
    expect(body.raw).toContain("{{station}}");

    const missing = await route("POST", "filled", { scriptId: "no-such-script" });
    expect(missing.status).toBe(404);
  });
});
