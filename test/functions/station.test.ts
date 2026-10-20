import { describe, it, expect, vi, beforeEach } from "vitest";

const blobs = new Map<string, unknown>();
vi.mock("@netlify/blobs", () => ({
  getStore: () => ({
    list: async ({ prefix }: { prefix: string }) => ({ blobs: [...blobs.keys()].filter((k) => k.startsWith(prefix)).sort().map((key) => ({ key })) }),
    get: async (key: string) => blobs.get(key) ?? null,
    setJSON: async (key: string, value: unknown) => { blobs.set(key, JSON.parse(JSON.stringify(value))); },
    delete: async (key: string) => { blobs.delete(key); },
  }),
}));
vi.mock("../../lib/store.js", () => ({
  getClip: vi.fn(async (id: string) => (id === "clip1" ? { data: new Uint8Array([1, 2, 3]).buffer, metadata: { id, scriptText: "Hello station", mimeType: "audio/wav" } } : null)),
  saveClip: vi.fn(), listClips: vi.fn(),
}));

import { handleStation } from "../../lib/handlers/station.js";
import { handleQueue } from "../../lib/handlers/queue.js";
import { sendToStation } from "../../lib/station-send.js";
import { LEASE_MS, claimNext } from "../../lib/queue-store.js";

const USER_KEY = "test-access-key-0123456789";
const STATION_KEY = "station-key-0123456789abcdef";
const station = (path: string, init: RequestInit = {}, key: string | null = STATION_KEY) =>
  handleStation(new Request(`http://localhost${path}`, { ...init, headers: { ...(key ? { "x-station-key": key } : {}), "content-type": "application/json" } }));
const user = (method: string, id?: string, body?: unknown) =>
  handleQueue(new Request(`http://localhost/api/queue${id ? `/${id}` : ""}`, { method, headers: { "x-api-key": USER_KEY, "content-type": "application/json" }, ...(body === undefined ? {} : { body: JSON.stringify(body) }) }), id);

beforeEach(() => {
  blobs.clear();
  vi.stubEnv("ACCESS_KEY", USER_KEY);
  vi.stubEnv("STATION_KEY", STATION_KEY);
  vi.stubEnv("STATION_MODE", "queue");
  for (const n of ["STATION_AUTOPLAY", "STATION_PREEMPT", "STATION_FX"]) vi.stubEnv(n, "");
});

describe("station queue", () => {
  it("only answers to the station key", async () => {
    expect((await station("/api/station/next", {}, null)).status).toBe(401);
    expect((await station("/api/station/next", {}, "wrong-key-0123456789abcdef")).status).toBe(401);
    expect((await handleStation(new Request("http://localhost/api/station/next", { headers: { "x-api-key": USER_KEY } }))).status).toBe(401);
    vi.stubEnv("STATION_KEY", "short");
    expect((await station("/api/station/next")).status).toBe(503);
  });

  it("hands out the oldest item once, serves its audio, and records the outcome", async () => {
    await sendToStation({ clipId: "clip1", audio: Buffer.from([1]), mimeType: "audio/wav", title: "first", play: true, preempt: false, fx: "underground" });
    await new Promise((r) => setTimeout(r, 5));
    await sendToStation({ clipId: "clip1", audio: Buffer.from([1]), mimeType: "audio/wav", title: "second" });

    const first = (await (await station("/api/station/next")).json()) as { item: { id: string; title: string; play: boolean; fx: string; audioUrl: string } };
    expect(first.item).toMatchObject({ title: "first", play: true, fx: "underground", audioUrl: "/api/station/clips/clip1" });
    const second = (await (await station("/api/station/next")).json()) as { item: { title: string } };
    expect(second.item.title).toBe("second");
    expect(((await (await station("/api/station/next")).json()) as { item: unknown }).item).toBeNull();

    const audio = await station(first.item.audioUrl);
    expect(audio.headers.get("content-type")).toBe("audio/wav");
    expect(new Uint8Array(await audio.arrayBuffer())).toEqual(new Uint8Array([1, 2, 3]));

    expect((await station("/api/station/ack", { method: "POST", body: JSON.stringify({ id: first.item.id, status: "played" }) })).status).toBe(200);
    const list = (await (await user("GET")).json()) as { items: Array<{ title: string; status: string }> };
    expect(list.items.map((i) => [i.title, i.status])).toEqual([["second", "claimed"], ["first", "played"]]);
    expect((await station("/api/station/ack", { method: "POST", body: JSON.stringify({ id: "nope", status: "played" }) })).status).toBe(404);
    expect((await station("/api/station/ack", { method: "POST", body: JSON.stringify({ id: first.item.id, status: "weird" }) })).status).toBe(400);
  });

  it("offers a claimed item again after its lease runs out, then gives up", async () => {
    await sendToStation({ clipId: "clip1", audio: Buffer.from([1]), mimeType: "audio/wav", title: "stuck" });
    const t0 = Date.now();
    expect(await claimNext(t0)).toMatchObject({ attempts: 1 });
    expect(await claimNext(t0 + 1000)).toBeNull();                          // still leased
    expect(await claimNext(t0 + LEASE_MS + 1)).toMatchObject({ attempts: 2 });
    expect(await claimNext(t0 + 2 * LEASE_MS + 2)).toMatchObject({ attempts: 3 });
    expect(await claimNext(t0 + 3 * LEASE_MS + 3)).toBeNull();              // out of attempts
    const list = (await (await user("GET")).json()) as { items: Array<{ status: string; error?: string }> };
    expect(list.items[0]).toMatchObject({ status: "failed", error: expect.stringContaining("never confirmed") });
  });

  it("lets a user queue an existing clip and cancel it before it is collected", async () => {
    expect((await user("POST", undefined, { clipId: "missing" })).status).toBe(404);
    const made = await user("POST", undefined, { clipId: "clip1", play: true });
    expect(made.status).toBe(201);
    const { item } = (await made.json()) as { item: { id: string; title: string; play: boolean } };
    expect(item).toMatchObject({ title: "Hello station", play: true });
    expect((await user("DELETE", item.id)).status).toBe(204);
    expect(((await (await station("/api/station/next")).json()) as { item: unknown }).item).toBeNull();
    expect((await user("DELETE", item.id)).status).toBe(409);
  });
});
