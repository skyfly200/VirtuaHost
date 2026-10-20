import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { handleProxy, features, MAX_BODY_BYTES } from "../../lib/handlers/proxy.js";

const KEY = "machine-key-0123456789";
const fetchMock = vi.fn();

const call = (path: string, init: RequestInit & { auth?: boolean } = {}) => {
  const { auth = true, headers, ...rest } = init;
  return handleProxy(new Request(`http://localhost${path}`, { ...rest, headers: { ...(auth ? { "x-api-key": KEY } : {}), ...(headers as Record<string, string>) } }));
};

beforeEach(() => {
  fetchMock.mockReset();
  vi.stubGlobal("fetch", fetchMock);
  vi.stubEnv("ACCESS_KEY", KEY);
  vi.stubEnv("LOGIN_USERS", "");
  vi.stubEnv("AUTH_DISABLED", "");
  vi.stubEnv("HUB_URL", "https://hub.example.com");
  vi.stubEnv("HUB_KEY", "hub-secret-key-123");
  vi.stubEnv("VOICE_URL", "https://voice.example.com/base");
  vi.stubEnv("VOICE_KEY", "voice-secret-key-1");
  fetchMock.mockResolvedValue(new Response('{"ok":true}', { status: 200, headers: { "content-type": "application/json" } }));
});
afterEach(() => {
  vi.unstubAllEnvs();
  vi.unstubAllGlobals();
});

describe("handleProxy", () => {
  it("needs a sign-in before it forwards anything", async () => {
    expect((await call("/api/hub/stations", { auth: false })).status).toBe(401);
    expect((await call("/api/voice/providers", { headers: { "x-api-key": "wrong" }, auth: false })).status).toBe(401);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("forwards to the hub with the hub's key, not the caller's credential", async () => {
    const res = await call("/api/hub/stations?fresh=1", { method: "GET", headers: { accept: "application/json", cookie: "x=1" } });
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ ok: true });

    const [url, init] = fetchMock.mock.calls[0];
    expect(String(url)).toBe("https://hub.example.com/stations?fresh=1");
    expect(init.headers).toEqual({ "x-api-key": "hub-secret-key-123", accept: "application/json" });   // nothing else is passed on
    expect(JSON.stringify(init.headers)).not.toContain(KEY);
  });

  it("keeps a path prefix on the voice server and passes bodies and content types through", async () => {
    await call("/api/voice/synth", { method: "POST", body: '{"text":"hi"}', headers: { "content-type": "application/json" } });
    const [url, init] = fetchMock.mock.calls[0];
    expect(String(url)).toBe("https://voice.example.com/base/synth");
    expect(init.method).toBe("POST");
    expect(init.headers["content-type"]).toBe("application/json");
    expect(init.headers["x-api-key"]).toBe("voice-secret-key-1");
    expect(Buffer.from(init.body).toString()).toBe('{"text":"hi"}');
  });

  it("returns the upstream status, body and content type (including audio)", async () => {
    fetchMock.mockResolvedValue(new Response(new Uint8Array([1, 2, 3]), { status: 200, headers: { "content-type": "audio/mpeg", "set-cookie": "a=b" } }));
    const res = await call("/api/voice/clips/c1/audio");
    expect(res.headers.get("content-type")).toBe("audio/mpeg");
    expect(res.headers.get("set-cookie")).toBeNull();
    expect(new Uint8Array(await res.arrayBuffer())).toEqual(new Uint8Array([1, 2, 3]));

    fetchMock.mockResolvedValue(new Response('{"error":"no station"}', { status: 404, headers: { "content-type": "application/json" } }));
    const missing = await call("/api/hub/stations/nope");
    expect(missing.status).toBe(404);
    expect(await missing.json()).toEqual({ error: "no station" });
  });

  it("cannot be steered to another server or out of the voice server's prefix", async () => {
    for (const path of ["/api/hub//evil.example.com/x", "/api/hub/https://evil.example.com/x", "/api/voice/../secret", "/api/voice/%2e%2e/secret"]) {
      fetchMock.mockClear();
      const res = await call(path);
      const target = fetchMock.mock.calls[0]?.[0];
      if (target) {
        const url = new URL(String(target));
        expect(url.origin, path).toBe(path.includes("voice") ? "https://voice.example.com" : "https://hub.example.com");
        if (path.includes("voice")) expect(url.pathname.startsWith("/base"), path).toBe(true);
      } else {
        expect([400, 404], path).toContain(res.status);          // refused (the URL parser may already have flattened ../)
      }
    }
  });

  it("says a part is not connected instead of failing mysteriously", async () => {
    vi.stubEnv("HUB_URL", "");
    const res = await call("/api/hub/stations");
    expect(res.status).toBe(503);
    expect(await res.json()).toMatchObject({ notConnected: true, error: expect.stringContaining("HUB_URL and HUB_KEY") });
    expect(fetchMock).not.toHaveBeenCalled();
    vi.stubEnv("HUB_URL", "https://hub.example.com");
    vi.stubEnv("HUB_KEY", "");
    expect((await call("/api/hub/stations")).status).toBe(503);
  });

  it("refuses a plain-http server (the key would travel in the clear) except on this machine", async () => {
    vi.stubEnv("HUB_URL", "http://hub.example.com");
    const res = await call("/api/hub/stations");
    expect(res.status).toBe(503);
    expect(((await res.json()) as { error: string }).error).toMatch(/https/);
    vi.stubEnv("HUB_URL", "http://localhost:3200");
    expect((await call("/api/hub/stations")).status).toBe(200);
    vi.stubEnv("HUB_URL", "not a url");
    expect((await call("/api/hub/stations")).status).toBe(503);
  });

  it("limits upload size", async () => {
    const big = new Uint8Array(MAX_BODY_BYTES + 1);
    const res = await call("/api/hub/broadcast/upload", { method: "POST", body: big, headers: { "content-type": "audio/mpeg" } });
    expect(res.status).toBe(413);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("blames the site's configuration, not the person, when the key is rejected", async () => {
    fetchMock.mockResolvedValue(new Response('{"error":"unauthorized"}', { status: 401 }));
    const res = await call("/api/hub/stations");
    expect(res.status).toBe(502);
    expect(((await res.json()) as { error: string }).error).toMatch(/rejected this site's key: check HUB_URL and HUB_KEY/);
  });

  it("reports an unreachable server as a 502", async () => {
    fetchMock.mockRejectedValue(new Error("connect ECONNREFUSED"));
    const res = await call("/api/voice/providers");
    expect(res.status).toBe(502);
    expect(((await res.json()) as { error: string }).error).toContain("voice server did not answer");
  });

  it("does not follow redirects, so the key cannot be sent elsewhere", async () => {
    await call("/api/hub/stations");
    expect(fetchMock.mock.calls[0][1].redirect).toBe("manual");
  });

  it("only handles /api/hub and /api/voice", async () => {
    expect((await call("/api/other")).status).toBe(404);
  });
});

describe("features", () => {
  it("are on only when both the address and the key are set", () => {
    expect(features()).toEqual({ hub: true, voice: true });
    vi.stubEnv("HUB_KEY", "");
    vi.stubEnv("VOICE_URL", "");
    expect(features()).toEqual({ hub: false, voice: false });
  });
});
