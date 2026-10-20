import { describe, it, expect } from "vitest";
// @ts-expect-error plain script module without types
import { extractMusic, parseScript } from "../../scripts/premix.mjs";

describe("premix script helpers", () => {
  it("reads header lines and the text", () => {
    expect(parseScript("# tone: warm\n# send: air\nHello [sfx:ding] there")).toEqual({ meta: { tone: "warm", send: "air" }, text: "Hello [sfx:ding] there" });
  });

  it("takes a music bed out of the text", () => {
    expect(extractMusic("[music:late-jazz vol=0.2] Good evening.")).toEqual({ text: "Good evening.", music: { name: "late-jazz", vol: 0.2 } });
    expect(extractMusic("Good evening. [music:Bed]").music).toEqual({ name: "bed", vol: 0.25 });
    expect(extractMusic("No music here.")).toEqual({ text: "No music here.", music: null });
    expect(extractMusic("[music:a vol=7] x").music?.vol).toBe(1);
    expect(() => extractMusic("[music:a] x [music:b]")).toThrow(/only one/);
    expect(() => extractMusic("[music: ] x")).toThrow(/malformed/);
  });
});
