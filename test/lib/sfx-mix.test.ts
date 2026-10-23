import { describe, it, expect, vi } from "vitest";
const clips = vi.hoisted(() => new Map<string, Buffer>());   // "kind/name" -> a WAV file the fake library holds
vi.mock("../../lib/library/index.js", () => ({
  listLibrary: vi.fn(async (kind: string) => ({ items: [...clips.keys()].filter((k) => k.startsWith(`${kind}/`)).map((k) => ({ source: "uploads", kind, name: k.split("/")[1], file: "x.wav", ref: k })), errors: [] })),
  fetchLibraryItem: vi.fn(async (_s: string, kind: string, name: string) => { const b = clips.get(`${kind}/${name}`); return b ? { data: b.buffer.slice(b.byteOffset, b.byteOffset + b.byteLength), mimeType: "audio/wav" } : null; }),
}));

import { parsePieces, synthesize, SFX_NAMES, speakMixed, canMix, hasTags, stripTags, sfxHelp, sanitizeAudio, withAudio } from "../../lib/sfx-mix.js";
import { parseWav } from "../../lib/audio-join.js";
import { pcmToWav } from "../../lib/wav.js";

const RATE = 24000;
const speech = (seconds: number) => ({ audio: pcmToWav(Buffer.alloc(Math.round(seconds * RATE) * 2, 1), RATE), mimeType: "audio/wav", voice: "Kore", model: "m" });
const seconds = (audio: Buffer) => { const w = parseWav(audio)!; return w.pcm.length / 2 / w.sampleRate; };

describe("parsePieces", () => {
  it("splits words and effects, with options", () => {
    expect(parsePieces("Hi [sfx:ding vol=0.5] there [sfx:whoosh over] now [sfx:beep wait=1]")).toEqual([
      { type: "speech", text: "Hi" }, { type: "sfx", name: "ding", vol: 0.5, over: false, wait: 0 },
      { type: "speech", text: "there" }, { type: "sfx", name: "whoosh", vol: 1, over: true, wait: 0 },
      { type: "speech", text: "now" }, { type: "sfx", name: "beep", vol: 1, over: false, wait: 1 },
    ]);
  });
  it("leaves out a tag with an option it does not know, and never leaves brackets in the words", () => {
    expect(parsePieces("a [sfx:ding bogus=1] b [sfx:") .every((p) => p.type !== "speech" || !p.text.includes("[sfx:ding"))).toBe(true);
    expect(parsePieces("a [sfx:ding bogus=1] b")).toEqual([{ type: "speech", text: "a" }, { type: "speech", text: "b" }]);
  });
  it("helpers", () => {
    expect(hasTags("x [music:bed] y")).toBe(true);
    expect(stripTags("x [sfx:ding] y")).toBe("x y");
  });
});

describe("synthesize", () => {
  it("makes every built-in effect at any rate, and the same sound twice", () => {
    for (const name of SFX_NAMES) { const a = synthesize(name, RATE)!; expect(a.length, name).toBeGreaterThan(100); expect(a.every(Number.isFinite), name).toBe(true); }
    expect([...synthesize("static", RATE)!.slice(0, 5)]).toEqual([...synthesize("static", RATE)!.slice(0, 5)]);
    expect(synthesize("nope", RATE)).toBeNull();
  });
});

describe("speakMixed", () => {
  it("puts the effect between the words", async () => {
    const calls: string[] = [];
    const m = await speakMixed("One [sfx:ding] two", async (w) => { calls.push(w); return speech(1); });
    expect(calls).toEqual(["One", "two"]);
    expect(m!.applied).toEqual(["ding"]);
    expect(m!.scriptText).toBe("One two");
    expect(seconds(m!.spoken.audio)).toBeCloseTo(2 + 1.2, 1);
  });
  it("lays an 'over' effect on top of the next words and adds a pause for wait", async () => {
    const over = await speakMixed("One [sfx:whoosh over] two", async () => speech(3));
    expect(seconds(over!.spoken.audio)).toBeCloseTo(3 + 3, 1);          // speech + speech, the whoosh is inside the second
    const wait = await speakMixed("One [sfx:beep wait=1] two", async () => speech(1));
    expect(seconds(wait!.spoken.audio)).toBeCloseTo(2 + 0.25 + 1, 1);
  });
  it("reports what it could not do, drops music, and caps the number of effects", async () => {
    const m = await speakMixed("a [sfx:zzz] b [music:bed] c", async () => speech(0.5));
    expect(m!.applied).toEqual([]);
    expect(m!.skipped).toEqual(["zzz (not found)", "music:bed (music not found, or not a WAV file)"]);
    const many = await speakMixed(`a ${"[sfx:click] ".repeat(10)} b`, async () => speech(0.1));
    expect(many!.applied).toHaveLength(8);
    expect(many!.skipped).toHaveLength(2);
  });
  it("gives up (so plain speech is used) when a voice does not return WAV or there is nothing to mix", async () => {
    expect(await speakMixed("a [sfx:ding] b", async () => ({ audio: Buffer.from("ID3...."), mimeType: "audio/mpeg", voice: "v", model: "m" }))).toBeNull();
    expect(await speakMixed("no tags here", async () => speech(1))).toBeNull();
    expect(await speakMixed("[sfx:ding]", async () => speech(1))).toBeNull();
  });
  it("keeps the mix from clipping", async () => {
    const loud = { ...speech(1), audio: pcmToWav(Buffer.from(new Int16Array(RATE).fill(32000).buffer), RATE) };
    const m = await speakMixed("a [sfx:buzzer over vol=2] b", async () => loud);
    const pcm = parseWav(m!.spoken.audio)!.pcm; let peak = 0;
    for (let i = 0; i < pcm.length; i += 2) peak = Math.max(peak, Math.abs(pcm.readInt16LE(i)));
    expect(peak).toBeLessThanOrEqual(32767);
  });
});

describe("canMix and the writer's help", () => {
  it("mixes only WAV voices", () => {
    expect(canMix("gemini")).toBe(true);
    expect(canMix("openrouter", "google/gemini-2.5-flash-preview-tts")).toBe(true);
    expect(canMix("openrouter", "hexgrad/kokoro-82m")).toBe(false);
    expect(canMix("openrouter", "elevenlabs/eleven_flash_v2_5")).toBe(false);
    expect(canMix(null)).toBe(false);
  });
  it("lists the names the writer may use", () => {
    expect(sfxHelp(["ding", "phone"])).toContain("ding, phone");
  });
});

describe("background, intro and outro from the library", () => {
  const wav = (sec: number, rate = RATE) => pcmToWav(Buffer.alloc(Math.round(sec * rate) * 2, 2), rate);
  const setup = () => { clips.clear(); clips.set("music/bed", wav(1)); clips.set("intro/hello", wav(2)); clips.set("outro/bye", wav(3, 12000)); };

  it("parses the new tags with their options", () => {
    expect(parsePieces("[intro:hello vol=0.5] hi [music:bed vol=0.1] there [outro:bye]")).toEqual([
      { type: "intro", name: "hello", vol: 0.5 }, { type: "speech", text: "hi" }, { type: "music", name: "bed", vol: 0.1 }, { type: "speech", text: "there" }, { type: "outro", name: "bye", vol: 1 },
    ]);
    expect(parsePieces("a [intro:hello over] b").some((p) => p.type === "intro")).toBe(false);   // an option it does not take: the tag is left out
    expect(stripTags("[intro:x] hi [outro:y]")).toBe("hi");
  });

  it("plays the intro first, the outro last, and the bed under the words with a lead and a tail", async () => {
    setup();
    const m = await speakMixed("[intro:hello] hi [music:bed vol=0.2] there [outro:bye]", async () => speech(1));
    expect(m!.applied).toEqual(["intro:hello", "music:bed", "outro:bye"]);
    expect(m!.skipped).toEqual([]);
    expect(m!.scriptText).toBe("hi there");
    expect(seconds(m!.spoken.audio)).toBeCloseTo(2 + (0.8 + 2 + 1.5) + 3, 1);    // intro + (lead + two words + tail) + outro (resampled to the voice's rate)
  });

  it("uses only the first intro, outro and bed, and reports a missing file", async () => {
    setup();
    const m = await speakMixed("[intro:hello] [intro:hello] hi [outro:nope]", async () => speech(1));
    expect(m!.applied).toEqual(["intro:hello"]);
    expect(m!.skipped).toEqual(["intro:hello (only one intro per clip)", "outro:nope (outro not found, or not a WAV file)"]);
  });

  it("turns the audio choices into tags, and ignores unsafe names", () => {
    expect(withAudio("Hello.", { intro: "hello", bed: "bed", bedVol: 0.2, outro: "bye" })).toBe("[intro:hello] [music:bed vol=0.2] Hello. [outro:bye]");
    expect(withAudio("Hello.", undefined)).toBe("Hello.");
    expect(sanitizeAudio({ bed: "Bed", bedVol: 5, intro: "../x", outro: "bye]" })).toEqual({ bed: "bed", bedVol: 1 });
    expect(sanitizeAudio({})).toBeUndefined();
    expect(sanitizeAudio("x")).toBeUndefined();
  });
});
