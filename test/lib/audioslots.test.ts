import { describe, it, expect } from "vitest";
// @ts-expect-error plain browser module without types
import { readAudioTags, writeAudioTags } from "../../public/shared/audioslots.js";

describe("background, intro and outro as tags in a script", () => {
  it("writes them around a single-voice script and reads them back", () => {
    const out = writeAudioTags("Welcome back. [sfx:chime] Stay tuned.", { intro: "hello", bed: "lofi", bedVol: 0.2, outro: "bye" });
    expect(out).toBe("[intro:hello] [music:lofi vol=0.2] Welcome back. [sfx:chime] Stay tuned. [outro:bye]");
    expect(readAudioTags(out)).toEqual({ intro: "hello", bed: "lofi", bedVol: 0.2, outro: "bye" });
  });
  it("replaces the old choices instead of stacking them, and clears them", () => {
    const first = writeAudioTags("Hi.", { intro: "a", outro: "b" });
    const second = writeAudioTags(first, { intro: "c" });
    expect(second).toBe("[intro:c] Hi.");
    expect(writeAudioTags(second, {})).toBe("Hi.");
  });
  it("puts them on the first and last spoken line of a conversation, after the speaker's label", () => {
    const text = "Host: Hello there.\nGuest: Hi!\nHost: Bye now.";
    const out = writeAudioTags(text, { intro: "hello", bed: "lofi", outro: "bye" }, { conversation: true });
    expect(out.split("\n")).toEqual(["Host: [intro:hello] [music:lofi vol=0.2] Hello there.", "Guest: Hi!", "Host: Bye now. [outro:bye]"]);
    expect(readAudioTags(out)).toMatchObject({ intro: "hello", bed: "lofi", outro: "bye" });
    expect(writeAudioTags(out, {}, { conversation: true })).toBe(text);
  });
  it("uses a default bed volume and reads one when only the name is there", () => {
    expect(writeAudioTags("Hi.", { bed: "x" })).toBe("[music:x vol=0.2] Hi.");
    expect(readAudioTags("[music:x] hi").bedVol).toBe(0.25);
    expect(readAudioTags("nothing here")).toEqual({});
  });
});
