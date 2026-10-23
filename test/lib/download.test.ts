import { describe, it, expect } from "vitest";
// @ts-expect-error plain browser module without types
import { encodeWav, convert } from "../../public/shared/download.js";

const fakeBuffer = (samples: number[], rate = 24000) => ({ numberOfChannels: 1, length: samples.length, sampleRate: rate, getChannelData: () => Float32Array.from(samples) });

describe("download: WAV encoding", () => {
  it("writes a valid 16-bit mono WAV with the right sizes and sample values", async () => {
    const blob = encodeWav(fakeBuffer([0, 1, -1, 0.5]));
    const view = new DataView(await blob.arrayBuffer());
    const tag = (o: number) => String.fromCharCode(view.getUint8(o), view.getUint8(o + 1), view.getUint8(o + 2), view.getUint8(o + 3));
    expect(blob.type).toBe("audio/wav");
    expect([tag(0), tag(8), tag(36)]).toEqual(["RIFF", "WAVE", "data"]);
    expect(view.byteLength).toBe(44 + 4 * 2);
    expect(view.getUint32(24, true)).toBe(24000);
    expect([view.getInt16(44, true), view.getInt16(46, true), view.getInt16(48, true)]).toEqual([0, 32767, -32768]);
  });

  it("returns the original blob when the format already matches or 'as saved' is chosen", async () => {
    const wav = new Blob([new Uint8Array(4)], { type: "audio/wav" });
    expect(await convert(wav, "wav")).toBe(wav);
    expect(await convert(wav, "original")).toBe(wav);
    const mp3 = new Blob([new Uint8Array(4)], { type: "audio/mpeg" });
    expect(await convert(mp3, "mp3")).toBe(mp3);
  });
});
