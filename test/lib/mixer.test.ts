import { describe, it, expect } from "vitest";
// @ts-expect-error plain browser module without types
import { parseTags, mix, toWav, EFFECTS, effectNames, RATE } from "../../public/generate/mixer.js";

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
});
