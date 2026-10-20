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
