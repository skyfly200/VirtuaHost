import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

const db = vi.hoisted(() => ({ clips: [{ id: "c1", createdAt: "2026-01-01", scriptText: "Hello", mimeType: "audio/wav", info: {} }] as Array<Record<string, unknown>>, queued: [] as unknown[] }));
vi.mock("../../lib/station-profile-store.js", () => ({
  listStations: vi.fn(async () => [
    { id: "wayhigh", name: "Way High", tz: "America/Chicago", lat: 29.76, lon: -95.37, coverageKm: 60, genres: [], links: [], skipArtists: [], connection: { kind: "none" } },
    { id: "green", name: "Greenlight", tz: "America/Chicago", lat: 30.27, lon: -97.74, genres: [], links: [], skipArtists: [], connection: { kind: "none" } },
  ]),
  getStation: vi.fn(async () => null), saveStation: vi.fn(), deleteStation: vi.fn(),
}));
vi.mock("../../lib/store.js", () => ({
  listClips: vi.fn(async () => db.clips),
  getClip: vi.fn(async (id: string) => { const m = db.clips.find((c) => c.id === id); return m ? { data: new ArrayBuffer(4), metadata: m } : null; }),
  saveClip: vi.fn(), deleteClip: vi.fn(),
}));
vi.mock("../../lib/queue-store.js", () => ({
  enqueue: vi.fn(async (item: object) => { db.queued.push(item); return { id: "q1", ...item }; }),
  listQueue: vi.fn(async () => []), getItem: vi.fn(), finish: vi.fn(), claimNext: vi.fn(),
}));
vi.mock("../../lib/schedule-store.js", () => ({ listSchedules: vi.fn(async () => []), getSchedule: vi.fn(), saveSchedule: vi.fn(), deleteSchedule: vi.fn() }));
vi.mock("../../lib/persona-store.js", () => ({ listPersonas: vi.fn(async () => []), getPersona: vi.fn(async () => null), savePersona: vi.fn(), deletePersona: vi.fn(), newPersonaId: vi.fn() }));

import { handleMcp } from "../../lib/handlers/mcp.js";

const KEY = "machine-key-0123456789";
const rpc = (body: unknown, key: string | null = KEY, method = "POST") =>
  handleMcp(new Request("http://localhost/api/mcp", { method, headers: { "content-type": "application/json", ...(key ? { "x-api-key": key } : {}) }, ...(method === "POST" ? { body: JSON.stringify(body) } : {}) }));
const call = async (name: string, args: Record<string, unknown> = {}, id = 1) => {
  const res = await rpc({ jsonrpc: "2.0", id, method: "tools/call", params: { name, arguments: args } });
  return (await res.json()) as { result?: { isError?: boolean; content: Array<{ text: string }> }; error?: { code: number; message: string } };
};
const text = (r: Awaited<ReturnType<typeof call>>) => r.result!.content[0].text;

const fetchMock = vi.fn();
beforeEach(() => {
  db.queued.length = 0; fetchMock.mockReset(); vi.stubGlobal("fetch", fetchMock);
  vi.stubEnv("ACCESS_KEY", KEY); vi.stubEnv("AUTH_DISABLED", ""); vi.stubEnv("SESSION_SECRET", ""); vi.stubEnv("MCP_READ_ONLY", "");
});
afterEach(() => { vi.unstubAllEnvs(); vi.unstubAllGlobals(); });

describe("the MCP endpoint", () => {
  it("needs a credential and only accepts POST", async () => {
    expect((await rpc({}, null)).status).toBe(401);
    const get = await rpc({}, KEY, "GET");
    expect(get.status).toBe(405);
    expect(get.headers.get("allow")).toBe("POST");
    expect((await handleMcp(new Request("http://localhost/api/mcp", { method: "POST", headers: { "x-api-key": KEY }, body: "not json" }))).status).toBe(400);
  });

  it("initializes, answers ping, and accepts notifications without a reply", async () => {
    const init = (await (await rpc({ jsonrpc: "2.0", id: 1, method: "initialize", params: { protocolVersion: "2025-06-18", capabilities: {}, clientInfo: { name: "t", version: "1" } } })).json()) as { result: { protocolVersion: string; serverInfo: { name: string }; capabilities: { tools: object }; instructions: string } };
    expect(init.result).toMatchObject({ protocolVersion: "2025-06-18", serverInfo: { name: "virtuahost" }, capabilities: { tools: {} } });
    expect(init.result.instructions).toMatch(/PUBLIC STREAM/);
    expect((await (await rpc({ jsonrpc: "2.0", id: 2, method: "ping" })).json())).toEqual({ jsonrpc: "2.0", id: 2, result: {} });
    expect((await rpc({ jsonrpc: "2.0", method: "notifications/initialized" })).status).toBe(202);
    expect(((await (await rpc({ jsonrpc: "2.0", id: 3, method: "nope" })).json()) as { error: { code: number } }).error.code).toBe(-32601);
  });

  it("lists tools with annotations, marking the ones that reach the public stream or delete as destructive", async () => {
    const list = (await (await rpc({ jsonrpc: "2.0", id: 1, method: "tools/list" })).json()) as { result: { tools: Array<{ name: string; description: string; inputSchema: { type: string }; annotations: { readOnlyHint: boolean; destructiveHint: boolean } }> } };
    const tools = new Map(list.result.tools.map((t) => [t.name, t]));
    expect(tools.get("list_stations")!.annotations).toMatchObject({ readOnlyHint: true, destructiveHint: false });
    expect(tools.get("make_clip")!.annotations).toMatchObject({ readOnlyHint: false, destructiveHint: false });
    expect(tools.get("send_clip_to_station")!.annotations).toMatchObject({ readOnlyHint: false, destructiveHint: true });
    expect(tools.get("send_clip_to_station")!.description).toMatch(/confirm with the person first/);
    expect(tools.get("find_place")!.inputSchema.type).toBe("object");
    for (const t of tools.values()) expect(t.description.length).toBeGreaterThan(20);
  });

  it("offers only the read tools when MCP_READ_ONLY is set", async () => {
    vi.stubEnv("MCP_READ_ONLY", "true");
    const list = (await (await rpc({ jsonrpc: "2.0", id: 1, method: "tools/list" })).json()) as { result: { tools: Array<{ name: string; annotations: { readOnlyHint: boolean } }> } };
    expect(list.result.tools.every((t) => t.annotations.readOnlyHint)).toBe(true);
    expect(list.result.tools.map((t) => t.name)).not.toContain("send_clip_to_station");
    expect((await call("send_clip_to_station", { clipId: "c1", play: true, confirm: true })).error?.code).toBe(-32602);
  });
});

describe("the tools", () => {
  it("lists stations, and ranks them by distance from an event with whether each covers it", async () => {
    const near = JSON.parse(text(await call("list_stations", { lat: 29.9, lon: -95.4 }))) as { near: Array<{ id: string; covers: boolean | null }> };
    expect(near.near.map((n) => n.id)).toEqual(["wayhigh", "green"]);
    expect(near.near[0].covers).toBe(true);
  });

  it("finds a place through the geocoder", async () => {
    fetchMock.mockResolvedValue(new Response(JSON.stringify({ results: [{ name: "Houston", admin1: "Texas", country: "United States", country_code: "US", latitude: 29.76, longitude: -95.36, timezone: "America/Chicago", population: 2300000 }] })));
    const out = JSON.parse(text(await call("find_place", { query: "Houston, TX" }))) as { places: Array<{ label: string; tz: string }> };
    expect(out.places[0]).toMatchObject({ label: "Houston, Texas, United States", tz: "America/Chicago" });
  });

  it("limits list_clips and reports the total", async () => {
    const out = JSON.parse(text(await call("list_clips", { limit: 1 }))) as { clips: unknown[]; total: number };
    expect([out.clips.length, out.total]).toEqual([1, 1]);
  });

  it("refuses to send to air or delete without confirm, and does it with confirm", async () => {
    const refused = await call("send_clip_to_station", { clipId: "c1", play: true });
    expect(refused.result).toMatchObject({ isError: true });
    expect(text(refused)).toMatch(/PUBLIC STREAM.*confirm=true/);
    expect(db.queued).toHaveLength(0);
    const sent = await call("send_clip_to_station", { clipId: "c1", play: true, confirm: true });
    expect(sent.result?.isError).toBeUndefined();
    expect(db.queued[0]).toMatchObject({ clipId: "c1", play: true });
    expect(text(await call("delete_clip", { clipId: "c1" }))).toMatch(/permanent/);
    expect(text(await call("create_schedule", { name: "x", when: { type: "interval", everyMinutes: 60 }, content: { kind: "text", text: "hi" }, send: "air" }))).toMatch(/PUBLIC STREAM/);
  });

  it("turns an API failure into a message the agent can act on, and rejects unknown tools", async () => {
    const missing = await call("clip_info", { clipId: "nope" });
    expect(missing.result).toMatchObject({ isError: true });
    expect(text(missing)).toMatch(/Clip not found \(404\)/);
    expect(text(await call("find_place", {}))).toMatch(/query is required/);
    expect((await call("no_such_tool")).error?.code).toBe(-32602);
  });

  it("reaches the hub through the site's proxy, and keeps automatic broadcasting behind confirm", async () => {
    vi.stubEnv("HUB_URL", "https://hub.example.com"); vi.stubEnv("HUB_KEY", "hub-key-0123456789");
    fetchMock.mockResolvedValue(new Response(JSON.stringify({ stations: [{ id: "wayhigh", online: true }] }), { headers: { "content-type": "application/json" } }));
    expect(JSON.parse(text(await call("hub_stations")))).toEqual({ stations: [{ id: "wayhigh", online: true }] });
    const [url, init] = fetchMock.mock.calls[0];
    expect(String(url)).toBe("https://hub.example.com/stations");
    expect(init.headers["x-api-key"]).toBe("hub-key-0123456789");
    const refused = await call("hub_set_alert_watch", { name: "Houston", lat: 29.76, lon: -95.37, action: "broadcast" });
    expect(text(refused)).toMatch(/PUBLIC STREAM/);
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it("answers a batch, skipping notifications", async () => {
    const res = await rpc([{ jsonrpc: "2.0", id: 1, method: "ping" }, { jsonrpc: "2.0", method: "notifications/initialized" }, { jsonrpc: "2.0", id: 2, method: "ping" }]);
    expect(((await res.json()) as unknown[]).length).toBe(2);
  });
});
