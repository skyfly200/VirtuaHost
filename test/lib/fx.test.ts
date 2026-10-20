import { describe, it, expect } from "vitest";
// @ts-expect-error plain browser module without types
import { applyFx, fxNames, FX_PREVIEWS } from "../../public/generate/fx.js";
// @ts-expect-error plain browser module without types
import { RATE } from "../../public/generate/mixer.js";

const tone = (hz: number, seconds = 0.5) => Float32Array.from({ length: Math.round(seconds * RATE) }, (_, i) => 0.5 * Math.sin(2 * Math.PI * hz * i / RATE));
const rms = (x: Float32Array) => Math.sqrt(x.reduce((a, v) => a + v * v, 0) / x.length);

describe("browser audio treatments", () => {
  it("every preset returns finite, audible, unclipped audio", () => {
    expect(fxNames().length).toBeGreaterThanOrEqual(12);
    for (const name of fxNames()) {
      const out = applyFx(tone(440), name) as Float32Array;
      expect(out.length, name).toBeGreaterThan(1000);
      expect(out.every(Number.isFinite), name).toBe(true);
      expect(rms(out), name).toBeGreaterThan(0.01);
      expect(Math.max(...out.map(Math.abs)), name).toBeLessThanOrEqual(0.98 + 1e-6);
    }
  });

  it("filters, resamples and echoes the way their names say", () => {
    // a telephone removes low frequencies and keeps the middle
    expect(rms(applyFx(tone(80), "telephone"))).toBeLessThan(rms(applyFx(tone(1000), "telephone")) * 0.4);
    // deep is longer (slower), chipmunk is shorter
    expect(applyFx(tone(440), "deep").length).toBeGreaterThan(tone(440).length);
    expect(applyFx(tone(440), "chipmunk").length).toBeLessThan(tone(440).length);
    // an echo preset extends the clip with a tail
    expect(applyFx(tone(440), "cave").length).toBeGreaterThan(tone(440).length);
    // unknown or empty names leave the audio alone
    const x = tone(440);
    expect(applyFx(x, "")).toBe(x);
    expect(applyFx(x, "nope")).toBe(x);
    expect(Object.keys(FX_PREVIEWS).every((k) => FX_PREVIEWS[k].label)).toBe(true);
  });
});

describe("effect amount", () => {
  it("0% leaves the voice alone, 100% is the full effect, and in between is a blend", () => {
    const x = tone(100);
    expect(applyFx(x, "telephone", 0)).toBe(x);
    const full = applyFx(x, "telephone", 1) as Float32Array;
    const half = applyFx(x, "telephone", 0.5) as Float32Array;
    expect(rms(full)).toBeLessThan(rms(half));                    // telephone removes the low tone: half still has some of it
    expect(rms(half)).toBeLessThan(rms(x));
    expect(rms(applyFx(x, "telephone", 0.25))).toBeGreaterThan(rms(half));
  });

  it("scales how far a pitch change goes instead of mixing two voices", () => {
    const x = tone(440);
    const fullDeep = applyFx(x, "deep", 1).length;
    const halfDeep = applyFx(x, "deep", 0.5).length;
    expect(halfDeep).toBeGreaterThan(x.length);                  // still slower...
    expect(halfDeep).toBeLessThan(fullDeep);                     // ...but less than full
    expect(applyFx(x, "chipmunk", 0.5).length).toBeGreaterThan(applyFx(x, "chipmunk", 1).length);
  });

  it("keeps the audio finite and unclipped at any amount, and treats a bad amount as full", () => {
    for (const name of fxNames()) {
      for (const a of [0.1, 0.5, 0.9, 1]) {
        const out = applyFx(tone(300), name, a) as Float32Array;
        expect(out.every(Number.isFinite), `${name} ${a}`).toBe(true);
        expect(Math.max(...out.map(Math.abs)), `${name} ${a}`).toBeLessThanOrEqual(0.98 + 1e-6);
      }
    }
    expect(applyFx(tone(300), "radio", "nope" as never).length).toBe(applyFx(tone(300), "radio", 1).length);
    expect(applyFx(tone(300), "radio", 7).length).toBe(applyFx(tone(300), "radio", 1).length);   // above 100% is 100%
  });
});
