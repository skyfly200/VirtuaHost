import { describe, it, expect } from "vitest";
import { joinAudio, parseWav } from "../../lib/audio-join.js";
import { pcmToWav } from "../../lib/wav.js";

const wav = (bytes: number, fill: number, rate = 24000) => pcmToWav(Buffer.alloc(bytes, fill), rate);

// An MP3-looking buffer: an ID3v2 tag with a syncsafe size of `tagPayload` bytes, then an MPEG frame header (0xFF 0xFB) and some data.
const mp3 = (tagPayload: number, marker: string) => {
  const id3 = Buffer.from([0x49, 0x44, 0x33, 4, 0, 0, 0, 0, 0, tagPayload]);
  return Buffer.concat([id3, Buffer.alloc(tagPayload, 0x20), Buffer.from([0xff, 0xfb]), Buffer.from(marker, "latin1")]);
};

describe("parseWav", () => {
  it("reads the format and the sample data of a WAV, and rejects anything else", () => {
    const parsed = parseWav(wav(10, 7));
    expect(parsed).toMatchObject({ sampleRate: 24000, channels: 1, bits: 16 });
    expect(parsed?.pcm.length).toBe(10);
    expect(parseWav(Buffer.from("not a wav file at all, really not"))).toBeNull();
  });
});

describe("joinAudio (WAV)", () => {
  it("joins two WAVs of the same rate with a gap of silence between them", () => {
    const a = wav(1000, 0x11);
    const b = wav(1000, 0x22);
    const out = joinAudio([{ audio: a, mimeType: "audio/wav" }, { audio: b, mimeType: "audio/wav" }], 0.5);
    expect(out.mimeType).toBe("audio/wav");
    expect(out.gapApplied).toBe(true);
    const parsed = parseWav(out.audio);
    expect(parsed?.sampleRate).toBe(24000);
    // 1000 + 24000 (0.5 s at 24 kHz, mono, 16-bit) + 1000
    expect(parsed?.pcm.length).toBe(1000 + 24000 + 1000);
    const pcm = parsed!.pcm;
    expect(pcm.subarray(0, 1000).every((x) => x === 0x11)).toBe(true);
    expect(pcm.subarray(1000, 25000).every((x) => x === 0)).toBe(true);
    expect(pcm.subarray(25000).every((x) => x === 0x22)).toBe(true);
    expect(out.audio.length).toBe(44 + 26000);
  });

  it("adds no silence when the gap is zero, and says so", () => {
    const out = joinAudio([{ audio: wav(100, 1), mimeType: "audio/wav" }, { audio: wav(100, 2), mimeType: "audio/wav" }]);
    expect(out.gapApplied).toBe(false);
    expect(parseWav(out.audio)?.pcm.length).toBe(200);
  });

  it("refuses WAVs at different sample rates", () => {
    expect(() => joinAudio([{ audio: wav(100, 1, 24000), mimeType: "audio/wav" }, { audio: wav(100, 1, 16000), mimeType: "audio/wav" }])).toThrow(/different/);
  });
});

describe("joinAudio (MP3)", () => {
  it("joins MP3 frames and drops the second part's ID3 tag", () => {
    const a = mp3(3, "AAA");
    const b = mp3(3, "BBB");
    const out = joinAudio([{ audio: a, mimeType: "audio/mpeg" }, { audio: b, mimeType: "audio/mpeg" }], 0.5);
    expect(out.gapApplied).toBe(false);
    expect(out.mimeType).toBe("audio/mpeg");
    // The first part is kept whole; the second contributes only its frames (after 10 header bytes and 3 tag bytes).
    expect(out.audio.equals(Buffer.concat([a, Buffer.from([0xff, 0xfb]), Buffer.from("BBB", "latin1")]))).toBe(true);
    expect(out.audio.indexOf(Buffer.from("ID3", "latin1"), 1)).toBe(-1);
  });
});

describe("joinAudio (edge cases)", () => {
  it("refuses a WAV mixed with an MP3", () => {
    expect(() => joinAudio([{ audio: wav(100, 1), mimeType: "audio/wav" }, { audio: mp3(3, "AAA"), mimeType: "audio/mpeg" }])).toThrow(/different audio formats/);
  });

  it("returns a single part unchanged", () => {
    const audio = wav(50, 9);
    const out = joinAudio([{ audio, mimeType: "audio/wav" }], 2);
    expect(out).toEqual({ audio, mimeType: "audio/wav", gapApplied: false });
    expect(out.audio).toBe(audio);
  });

  it("throws when there is nothing to join", () => {
    expect(() => joinAudio([])).toThrow("There is no audio to join");
  });
});
