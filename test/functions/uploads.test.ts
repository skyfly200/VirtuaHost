import { describe, it, expect, vi, beforeEach } from "vitest";

// An in-memory Netlify Blobs.
const blobs = vi.hoisted(() => new Map<string, { data: ArrayBuffer; metadata: Record<string, unknown> }>());
vi.mock("@netlify/blobs", () => ({
  getStore: () => ({
    list: async ({ prefix = "" } = {}) => ({ blobs: [...blobs.keys()].filter((k) => k.startsWith(prefix)).map((key) => ({ key })) }),
    getMetadata: async (key: string) => (blobs.has(key) ? { metadata: blobs.get(key)!.metadata } : null),
    getWithMetadata: async (key: string) => (blobs.has(key) ? { data: blobs.get(key)!.data, metadata: blobs.get(key)!.metadata } : null),
    get: async (key: string) => blobs.get(key)?.data ?? null,
    set: async (key: string, data: ArrayBuffer, opts: { metadata: Record<string, unknown> }) => { blobs.set(key, { data, metadata: opts.metadata }); },
    delete: async (key: string) => { blobs.delete(key); },
  }),
}));

import { handleUploads } from "../../lib/handlers/uploads.js";
import { handleLibrary } from "../../lib/handlers/library.js";
import { clearLibraryCache } from "../../lib/library/index.js";
import { pcmToWav } from "../../lib/wav.js";

const KEY = "test-access-key-0123456789";
vi.stubEnv("ACCESS_KEY", KEY);
const wav = () => pcmToWav(Buffer.alloc(4800), 24000);
const meta = (m: Record<string, unknown>) => encodeURIComponent(JSON.stringify(m));
const post = (body: Buffer | Uint8Array, m: Record<string, unknown> = { kind: "intro" }, type = "audio/wav") =>
  handleUploads(new Request("http://localhost/api/uploads", { method: "POST", body: body as never, headers: { "x-api-key": KEY, "content-type": type, "x-upload-meta": meta(m) } }));
const call = (method: string, id?: string, body?: unknown) =>
  handleUploads(new Request(`http://localhost/api/uploads${id ? `/${id}` : ""}`, { method, body: body === undefined ? undefined : JSON.stringify(body), headers: { "x-api-key": KEY, "content-type": "application/json" } }), id);

beforeEach(() => { blobs.clear(); clearLibraryCache(); });

describe("/api/uploads", () => {
  it("saves a file under a tag-safe name, lists it, and offers it through the sound library", async () => {
    const res = await post(wav(), { kind: "intro", file: "My Show Intro!.wav", seconds: 3.04 });
    expect(res.status).toBe(201);
    const made = (await res.json()) as { id: string; name: string; kind: string; seconds: number; canEdit: boolean };
    expect(made).toMatchObject({ name: "my-show-intro", kind: "intro", seconds: 3, canEdit: true });
    expect(((await (await call("GET")).json()) as { uploads: unknown[] }).uploads).toHaveLength(1);

    const lib = (await (await handleLibrary(new Request("http://localhost/api/library?kind=intro", { headers: { "x-api-key": KEY } }), {})).json()) as { items: Array<{ source: string; name: string }> };
    expect(lib.items).toEqual([expect.objectContaining({ source: "uploads", kind: "intro", name: "my-show-intro" })]);
    const file = await handleLibrary(new Request("http://localhost/api/library/uploads/intro/my-show-intro", { headers: { "x-api-key": KEY } }), { source: "uploads", kind: "intro", name: "my-show-intro" });
    expect(file.status).toBe(200);
    expect(file.headers.get("content-type")).toBe("audio/wav");
    expect(Buffer.from(await file.arrayBuffer()).subarray(0, 4).toString()).toBe("RIFF");
  });

  it("gives a second file with the same name a number, and keeps built-in effect names free", async () => {
    await post(wav(), { kind: "music", file: "bed.wav" });
    expect(((await (await post(wav(), { kind: "music", file: "bed.wav" })).json()) as { name: string }).name).toBe("bed-2");
    expect(((await (await post(wav(), { kind: "sfx", file: "ding.wav" })).json()) as { name: string }).name).toBe("ding-2");
  });

  it("renames, changes the kind, and deletes", async () => {
    const { id } = (await (await post(wav(), { kind: "sfx", file: "pop.wav" })).json()) as { id: string };
    expect(await (await call("PATCH", id, { name: "Big Pop", kind: "outro" })).json()).toMatchObject({ name: "big-pop", kind: "outro" });
    expect((await call("PATCH", id, { kind: "nonsense" })).status).toBe(400);
    expect((await call("DELETE", id)).status).toBe(204);
    expect((await call("DELETE", id)).status).toBe(404);
    expect(blobs.size).toBe(0);
  });

  it("refuses files that are not audio, too large, or have no kind", async () => {
    expect((await post(Buffer.from("not audio at all"), { kind: "intro" })).status).toBe(400);
    expect((await post(wav(), { kind: "nope" })).status).toBe(400);
    expect((await post(wav(), { kind: "intro" }, "text/plain")).status).toBe(400);
    expect((await post(Buffer.concat([wav(), Buffer.alloc(5_600_000)]), { kind: "intro" })).status).toBe(413);
    expect((await handleUploads(new Request("http://localhost/api/uploads", { method: "POST", body: wav() as never, headers: { "x-api-key": KEY, "content-type": "audio/wav", "x-upload-meta": "%%%" } }))).status).toBe(400);
    expect(blobs.size).toBe(0);
  });

  it("needs a sign-in", async () => {
    const res = await handleUploads(new Request("http://localhost/api/uploads", { method: "GET" }));
    expect(res.status).toBe(401);
  });
});
