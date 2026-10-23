import { describe, it, expect, vi, beforeEach } from "vitest";

vi.mock("../../lib/store.js", () => ({
  getClip: vi.fn(),
  listClips: vi.fn(),
  saveClip: vi.fn(),
  deleteClip: vi.fn(),
}));
vi.mock("../../lib/handoff.js", () => ({ handoffConfigured: vi.fn(() => false), handoffDefaults: vi.fn(), pushToStation: vi.fn() }));

import { getClip, listClips, saveClip, deleteClip } from "../../lib/store.js";
import { handleClips } from "../../lib/handlers/clips.js";
import type { ClipMetadata } from "../../lib/types.js";

const TEST_KEY = "test-access-key-0123456789";
vi.stubEnv("ACCESS_KEY", TEST_KEY);

const mockedGetClip = vi.mocked(getClip);
const mockedListClips = vi.mocked(listClips);

function getRequest(): Request {
  return new Request("http://localhost/api/clips", { method: "GET", headers: { "x-api-key": TEST_KEY } });
}

const sampleMetadata: ClipMetadata = {
  id: "abc",
  createdAt: "2026-01-01T00:00:00.000Z",
  mode: "say",
  input: "hello",
  scriptText: "hello",
  voice: "Kore",
  mimeType: "audio/wav",
  byteSize: 4,
};

describe("handleClips", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("rejects other methods", async () => {
    const req = new Request("http://localhost/api/clips", { method: "PUT", headers: { "x-api-key": TEST_KEY } });
    const res = await handleClips(req, undefined);
    expect(res.status).toBe(405);
  });

  it("lists clips when no id is given", async () => {
    mockedListClips.mockResolvedValue([sampleMetadata]);

    const res = await handleClips(getRequest(), undefined);

    expect(res.status).toBe(200);
    const body = (await res.json()) as { clips: ClipMetadata[] };
    expect(body.clips).toEqual([sampleMetadata]);
  });

  it("returns 404 when the clip does not exist", async () => {
    mockedGetClip.mockResolvedValue(null);

    const res = await handleClips(getRequest(), "missing");

    expect(res.status).toBe(404);
  });

  it("streams the clip's audio bytes with the stored mime type", async () => {
    const data = new Uint8Array([1, 2, 3, 4]).buffer;
    mockedGetClip.mockResolvedValue({ data, metadata: sampleMetadata });

    const res = await handleClips(getRequest(), "abc");

    expect(res.status).toBe(200);
    expect(res.headers.get("Content-Type")).toBe("audio/wav");
    expect(res.headers.get("Content-Length")).toBe("4");
    const buf = Buffer.from(await res.arrayBuffer());
    expect([...buf]).toEqual([1, 2, 3, 4]);
  });

  describe("saving audio the browser mixed", () => {
    const wav = Buffer.from("RIFF\0\0\0\0WAVEdata", "latin1");
    const save = (body: Uint8Array | null, meta: unknown = { scriptText: "Hi there", effects: ["ding"], tone: "warm" }, type = "audio/wav") =>
      handleClips(new Request("http://localhost/api/clips", { method: "POST", body, headers: { "x-api-key": TEST_KEY, "content-type": type, "x-clip-meta": encodeURIComponent(JSON.stringify(meta)) } }), undefined);

    it("stores the audio with its details", async () => {
      const res = await save(wav);
      expect(res.status).toBe(201);
      const { id } = (await res.json()) as { id: string };
      expect(vi.mocked(saveClip).mock.calls[0][0]).toBe(id);
      expect(vi.mocked(saveClip).mock.calls[0][2]).toMatchObject({ scriptText: "Hi there", effects: ["ding"], tone: "warm", mimeType: "audio/wav" });
      // the saved file carries the details: bigger than what was sent, and starts the same
      const [, saved, stored] = vi.mocked(saveClip).mock.calls[0];
      expect(saved.length).toBeGreaterThan(wav.length);
      expect(stored.byteSize).toBe(saved.length);
      expect(stored.info).toMatchObject({ title: "Hi there", source: "browser" });
    });

    it("keeps the metadata the browser sends: event, kind and expiry", async () => {
      const info = { kind: "promo", expiresAt: "2030-04-12T23:00:00Z", event: { name: "Spring Fling", venue: "The Barn" }, junk: 1 };
      expect((await save(wav, { scriptText: "Join us", info })).status).toBe(201);
      expect(vi.mocked(saveClip).mock.calls[0][2].info).toMatchObject({ kind: "promo", expiresAt: "2030-04-12T23:00:00.000Z", event: { name: "Spring Fling", venue: "The Barn" } });
      expect(vi.mocked(saveClip).mock.calls[0][2].info).not.toHaveProperty("junk");
    });

    it("rejects the wrong type, non-audio bytes, a missing script and an oversized body", async () => {
      expect((await save(wav, undefined, "text/plain")).status).toBe(400);
      expect((await save(Buffer.from("not audio"))).status).toBe(400);
      expect((await save(wav, {})).status).toBe(400);
      expect((await save(Buffer.concat([wav, Buffer.alloc(5_600_000)]))).status).toBe(413);
      expect(saveClip).not.toHaveBeenCalled();
    });
  });

  it("serves a clip's metadata as JSON for other systems", async () => {
    mockedGetClip.mockResolvedValue({ data: new ArrayBuffer(4), metadata: { ...sampleMetadata, info: { kind: "promo", expiresAt: "2030-04-12T23:00:00.000Z", event: { name: "Spring Fling" } } } });
    const res = await handleClips(new Request("http://localhost/api/clips/abc/meta", { headers: { "x-api-key": TEST_KEY } }), "abc");
    expect(res.status).toBe(200);
    expect(await res.json()).toMatchObject({ id: "abc", scriptText: "hello", kind: "promo", expiresAt: "2030-04-12T23:00:00.000Z", event: { name: "Spring Fling" } });
  });
});

describe("editing and deleting a clip", () => {
  const edit = (method: string, id: string, body?: unknown) =>
    handleClips(new Request(`http://localhost/api/clips/${id}`, { method, headers: { "x-api-key": TEST_KEY, "content-type": "application/json" }, ...(body === undefined ? {} : { body: JSON.stringify(body) }) }), id);

  beforeEach(async () => {
    const { embedTags } = await import("../../lib/clip-info.js");
    const wav = Buffer.from("RIFF\0\0\0\0WAVEdata\x04\0\0\0abcd", "latin1");
    wav.writeUInt32LE(wav.length - 8, 4);
    const tagged = embedTags(wav, "audio/wav", { title: "Spring Fling", kind: "promo", expiresAt: "2030-04-12T22:00:00.000Z" }, { clipId: "abc" });
    mockedGetClip.mockResolvedValue({ data: tagged.buffer.slice(tagged.byteOffset, tagged.byteOffset + tagged.byteLength) as ArrayBuffer, metadata: { ...sampleMetadata, mimeType: "audio/wav", info: { title: "Spring Fling", kind: "promo", expiresAt: "2030-04-12T22:00:00.000Z" } } });
  });

  it("extends or removes an expiry, rewriting the tags without piling up chunks", async () => {
    const res = await edit("PATCH", "abc", { expiresAt: "2030-04-13T02:00:00Z", title: "Spring Fling (extended)" });
    expect(res.status).toBe(200);
    const [, saved, meta] = vi.mocked(saveClip).mock.calls[0];
    expect(meta.info).toMatchObject({ title: "Spring Fling (extended)", kind: "promo", expiresAt: "2030-04-13T02:00:00.000Z" });
    const { readWavInfo } = await import("../../lib/clip-info.js");
    const read = readWavInfo(saved);
    expect(read.info.INAM).toBe("Spring Fling (extended)");
    expect(read.json?.expiresAt).toBe("2030-04-13T02:00:00.000Z");
    expect(saved.readUInt32LE(4)).toBe(saved.length - 8);
    expect(saved.toString("latin1").split("vhmd").length - 1).toBe(1);               // one metadata chunk, not two
    expect(meta.byteSize).toBe(saved.length);

    await edit("PATCH", "abc", { expiresAt: null });
    expect(vi.mocked(saveClip).mock.calls[1][2].info).not.toHaveProperty("expiresAt");
  });

  it("rejects bad changes and unknown clips, and deletes", async () => {
    expect((await edit("PATCH", "abc", { expiresAt: "soon" })).status).toBe(400);
    expect((await edit("PATCH", "abc", "nope")).status).toBe(400);
    mockedGetClip.mockResolvedValueOnce(null);
    expect((await edit("PATCH", "missing", { title: "x" })).status).toBe(404);
    expect((await edit("DELETE", "abc")).status).toBe(204);
    expect(vi.mocked(deleteClip)).toHaveBeenCalledWith("abc");
    expect(saveClip).not.toHaveBeenCalledWith(expect.anything(), expect.anything(), expect.objectContaining({ info: expect.objectContaining({ expiresAt: "soon" }) }));
  });
});
