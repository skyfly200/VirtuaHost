import { describe, it, expect } from "vitest";
// @ts-expect-error plain browser module without types
import { parseTags, mix, toWav, EFFECTS, effectNames, RATE, BED_LEAD, BED_TAIL } from "../../public/generate/mixer.js";

describe("browser mixer", () => {
  it("splits text at tags and reads their options", () => {
    expect(parseTags("Hello [sfx:whoosh over] world [sfx:crowd vol=0.5 wait=1] bye")).toEqual([
      { type: "speech", text: "Hello" },
      { type: "sfx", name: "whoosh", vol: 1, over: true, wait: 0 },
      { type: "speech", text: "world" },
      { type: "sfx", name: "crowd", vol: 0.5, over: false, wait: 1 },
      { type: "speech", text: "bye" },
    ]);
    expect(() => parseTags("a [sfx:ding loud] b")).toThrow(/unknown sound effect option/i);
    expect(() => parseTags("a [sfx: ding now please maybe] b")).toThrow(/malformed|unknown/i);
  });

  it("synthesises every effect as finite audio of a sensible length", () => {
    for (const name of effectNames()) {
      const x = EFFECTS[name]() as Float32Array;
      expect(x.length, name).toBeGreaterThan(RATE * 0.05);
      expect(x.length, name).toBeLessThan(RATE * 4);
      expect(x.every(Number.isFinite), name).toBe(true);
      expect(x.some((v) => v !== 0), name).toBe(true);
    }
  });

  it("joins speech and effects in order, and overlaps an 'over' effect with the next speech", () => {
    const speech = (n: number) => ({ kind: "speech", samples: new Float32Array(n).fill(0.1) });
    const ding = EFFECTS.ding().length;
    expect(mix([speech(1000), { kind: "sfx", name: "ding", vol: 1, over: false, wait: 0 }, speech(500)]).length).toBe(1500 + ding);
    expect(mix([{ kind: "sfx", name: "ding", vol: 1, over: true, wait: 0 }, speech(500)]).length).toBe(Math.max(ding, 500));
    expect(mix([{ kind: "sfx", name: "beep", vol: 1, over: false, wait: 0.5 }, speech(100)]).length).toBe(EFFECTS.beep().length + RATE / 2 + 100);
  });

  it("writes a valid 16-bit mono WAV", () => {
    const wav = toWav(new Float32Array([0, 0.5, -0.5, 2])) as Uint8Array;
    expect(String.fromCharCode(...wav.subarray(0, 4))).toBe("RIFF");
    expect(String.fromCharCode(...wav.subarray(8, 12))).toBe("WAVE");
    expect(wav.length).toBe(44 + 8);
    expect(new DataView(wav.buffer).getInt16(44 + 6, true)).toBe(32767); // clipped, not wrapped
  });

  it("mixes library samples and puts a music bed under the whole clip", () => {
    expect(parseTags("[music:jazz vol=0.2] Hello [sfx:ding]")).toEqual([
      { type: "music", name: "jazz", vol: 0.2, over: false, wait: 0 },
      { type: "speech", text: "Hello" },
      { type: "sfx", name: "ding", vol: 1, over: false, wait: 0 },
    ]);
    expect(parseTags("[music:a]")[0].vol).toBe(0.25);
    expect(() => parseTags("[music:a] x [music:b]")).toThrow(/only one/i);
    expect(() => parseTags("[music:a over] x")).toThrow(/unknown music option/i);

    const speech = { kind: "speech", samples: new Float32Array(RATE).fill(0.1) };
    const custom = { kind: "sfx", name: "mine", vol: 1, over: false, wait: 0, samples: new Float32Array(100).fill(0.2) };
    expect(mix([speech, custom]).length).toBe(RATE + 100);

    const bed = { kind: "music", vol: 0.5, samples: new Float32Array(1000).fill(0.4) }; // shorter than the clip: loops
    const out = mix([speech, bed]) as Float32Array;
    expect(out.length).toBe(Math.round(BED_LEAD * RATE) + RATE + Math.round(BED_TAIL * RATE));
    expect(out[Math.round(BED_LEAD * RATE) + 5000]).toBeCloseTo(0.1 + 0.4 * 0.5, 5);   // speech plus bed, after the fade-in
    expect(Math.abs(out[out.length - 1])).toBeLessThan(0.01);                              // faded out
  });
});
