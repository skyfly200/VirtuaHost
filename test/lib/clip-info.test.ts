import { describe, it, expect } from "vitest";
import { execFileSync, spawnSync } from "node:child_process";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { embedTags, isExpired, readId3, readWavInfo, sanitizeInfo, stripId3, writeId3 } from "../../lib/clip-info.js";
import { pcmToWav } from "../../lib/wav.js";

const info = sanitizeInfo({
  title: "Spring Fling", kind: "promo", tags: ["Event", "event", "Party"], persona: "sunny-sam", source: "flier",
  event: { name: "Spring Fling", startsAt: "2030-04-12T19:00:00Z", endsAt: "2030-04-12T23:00:00Z", venue: "The Barn", performers: ["Ada", "The Engines"], bogus: "x" },
  expiresAt: "2030-04-12T23:00:00Z", extra: { "ticket link": "https://x.test/t", junk: "" }, notAField: 1,
});

describe("clip info", () => {
  it("keeps only known, bounded fields", () => {
    expect(info).toEqual({
      title: "Spring Fling", kind: "promo", persona: "sunny-sam", source: "flier", tags: ["event", "party"],
      event: { name: "Spring Fling", venue: "The Barn", startsAt: "2030-04-12T19:00:00.000Z", endsAt: "2030-04-12T23:00:00.000Z", performers: ["Ada", "The Engines"] },
      expiresAt: "2030-04-12T23:00:00.000Z", extra: { ticket_link: "https://x.test/t" },
    });
    expect(sanitizeInfo("nope")).toEqual({});
    expect(sanitizeInfo({ event: { venue: "no name" } }).event).toBeUndefined();
    expect(sanitizeInfo({ expiresAt: "not a date" }).expiresAt).toBeUndefined();
  });

  it("knows when a clip has expired", () => {
    expect(isExpired({ expiresAt: "2030-01-01T00:00:00Z" }, Date.parse("2030-01-01T00:00:01Z"))).toBe(true);
    expect(isExpired({ expiresAt: "2030-01-01T00:00:00Z" }, Date.parse("2029-12-31T00:00:00Z"))).toBe(false);
    expect(isExpired({}, Date.now())).toBe(false);
    expect(isExpired(undefined)).toBe(false);
  });

  it("writes ID3 tags that read back, and replaces an old tag instead of stacking", () => {
    const audio = Buffer.concat([Buffer.from([0xff, 0xfb, 0x90, 0x00]), Buffer.alloc(200, 1)]);
    const once = writeId3(audio, info, { script: "Join us Friday", createdAt: "2030-01-01T10:00:00.000Z", clipId: "abc", station: "Radio X" });
    const tags = readId3(once);
    expect(tags.text).toMatchObject({ TIT2: "Spring Fling", TPE1: "Radio X", TCON: "promo", TDRC: "2030-01-01T10:00:00", COMM: "Join us Friday" });
    expect(tags.txxx).toMatchObject({ expires: "2030-04-12T23:00:00.000Z", kind: "promo", persona: "sunny-sam", event: "Spring Fling", clip_id: "abc" });
    expect(JSON.parse(tags.txxx.virtuahost)).toEqual(info);
    expect(stripId3(once).equals(audio)).toBe(true);
    const twice = writeId3(once, { title: "Other" }, {});
    expect(readId3(twice).text.TIT2).toBe("Other");
    expect(stripId3(twice).equals(audio)).toBe(true);
  });

  it("writes WAV tags that read back and leave a valid file", () => {
    const wav = pcmToWav(Buffer.alloc(4800, 1));
    const tagged = embedTags(wav, "audio/wav", info, { script: "Join us", createdAt: "2030-01-01T10:00:00.000Z", clipId: "abc", station: "Radio X" });
    expect(tagged.readUInt32LE(4)).toBe(tagged.length - 8);
    const read = readWavInfo(tagged);
    expect(read.info).toMatchObject({ INAM: "Spring Fling", IART: "Radio X", IGNR: "promo", ICMT: "Join us", ISFT: "VirtuaHost" });
    expect(read.json).toMatchObject({ expiresAt: "2030-04-12T23:00:00.000Z", clipId: "abc" });
    expect(embedTags(Buffer.from("not audio"), "audio/wav", info)).toEqual(Buffer.from("not audio"));
    expect(embedTags(wav, "audio/ogg", info)).toBe(wav);
  });

  const ffprobe = spawnSync("ffprobe", ["-version"]).status === 0;
  it.skipIf(!ffprobe)("is understood by ffprobe (a real tag reader) for both formats", () => {
    const dir = mkdtempSync(join(tmpdir(), "tags-"));
    const wav = embedTags(pcmToWav(Buffer.alloc(4800, 1)), "audio/wav", info, { script: "Join us", station: "Radio X" });
    writeFileSync(join(dir, "a.wav"), wav);
    const mp3Path = join(dir, "base.mp3");
    execFileSync("ffmpeg", ["-y", "-loglevel", "error", "-f", "lavfi", "-i", "sine=frequency=440:duration=1", "-c:a", "libmp3lame", mp3Path]);
    const mp3 = embedTags(Buffer.from(execFileSync("cat", [mp3Path])), "audio/mpeg", info, { script: "Join us", station: "Radio X" });
    writeFileSync(join(dir, "a.mp3"), mp3);
    for (const file of ["a.wav", "a.mp3"]) {
      const out = JSON.parse(execFileSync("ffprobe", ["-v", "error", "-show_format", "-of", "json", join(dir, file)]).toString()) as { format: { duration: string; tags?: Record<string, string> } };
      const tags = Object.fromEntries(Object.entries(out.format.tags ?? {}).map(([k, v]) => [k.toLowerCase(), v]));
      expect(Number(out.format.duration), file).toBeGreaterThanOrEqual(0.09);
      expect(tags.title, file).toBe("Spring Fling");
      expect(tags.artist, file).toBe("Radio X");
    }
  });
});
