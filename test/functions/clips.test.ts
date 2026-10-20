import { describe, it, expect, vi, beforeEach } from "vitest";

vi.mock("../../lib/store.js", () => ({
  getClip: vi.fn(),
  listClips: vi.fn(),
  saveClip: vi.fn(),
}));
vi.mock("../../lib/handoff.js", () => ({ handoffConfigured: vi.fn(() => false), handoffDefaults: vi.fn(), pushToStation: vi.fn() }));

import { getClip, listClips, saveClip } from "../../lib/store.js";
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
      expect(vi.mocked(saveClip).mock.calls[0][2]).toMatchObject({ scriptText: "Hi there", effects: ["ding"], tone: "warm", mimeType: "audio/wav", byteSize: wav.length });
    });

    it("rejects the wrong type, non-audio bytes, a missing script and an oversized body", async () => {
      expect((await save(wav, undefined, "text/plain")).status).toBe(400);
      expect((await save(Buffer.from("not audio"))).status).toBe(400);
      expect((await save(wav, {})).status).toBe(400);
      expect((await save(Buffer.concat([wav, Buffer.alloc(5_600_000)]))).status).toBe(413);
      expect(saveClip).not.toHaveBeenCalled();
    });
  });
});
