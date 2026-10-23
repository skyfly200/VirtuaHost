import { describe, it, expect } from "vitest";
import { linesOf, MAX_CAST, MAX_LINES, MAX_TEXT, parseDialogue, sanitizeCast, sanitizeScript, speakersOf } from "../../lib/scripts.js";

const rocky = { name: "Rocky" };
const dale = { name: "Dale" };

describe("sanitizeCast", () => {
  it("accepts up to four speakers and refuses a fifth", () => {
    const four = ["A", "B", "C", "D"].map((name) => ({ name }));
    expect(sanitizeCast(four)).toEqual({ cast: four });
    const five = [...four, { name: "E" }];
    expect(MAX_CAST).toBe(4);
    expect(sanitizeCast(five)).toEqual({ error: expect.stringContaining("at most 4") });
  });

  it("refuses duplicate names regardless of case", () => {
    expect(sanitizeCast([{ name: "Rocky" }, { name: "rocky" }])).toEqual({ error: expect.stringContaining('both called "rocky"') });
  });

  it("refuses a name with a colon, and keeps only the optional fields that are set", () => {
    expect(sanitizeCast([{ name: "Ro:cky" }])).toEqual({ error: expect.stringContaining("not a usable speaker name") });
    expect(sanitizeCast([{ name: "Rocky", role: "host", voice: "Kore", personaId: "", speechModel: "x/y" }])).toEqual({
      cast: [{ name: "Rocky", role: "host", voice: "Kore", speechModel: "x/y" }],
    });
  });

  it("treats a missing cast as empty and refuses a non-list", () => {
    expect(sanitizeCast(undefined)).toEqual({ cast: [] });
    expect(sanitizeCast("Rocky")).toEqual({ error: "cast must be a list of speakers" });
  });
});

describe("sanitizeScript", () => {
  it("refuses a single-voice script with two cast members", () => {
    expect(sanitizeScript({ name: "x", kind: "single", cast: [rocky, dale], text: "Hi." })).toEqual({ error: expect.stringContaining("one speaker") });
  });

  it("refuses a conversation with fewer than two cast members", () => {
    expect(sanitizeScript({ name: "x", kind: "conversation", cast: [rocky], text: "Rocky: Hi." })).toEqual({ error: expect.stringContaining("at least two speakers") });
  });

  it("names the stray speaker when the text has a line from someone not in the cast", () => {
    const out = sanitizeScript({ name: "x", kind: "conversation", cast: [rocky, dale], text: "Rocky: Hello.\nSam: Who is this?" });
    expect(out).toEqual({ error: expect.stringContaining('"Sam"') });
    expect(out).toEqual({ error: expect.stringContaining("not in the cast") });
  });

  it("refuses text over the limit and says by how much", () => {
    const out = sanitizeScript({ name: "x", kind: "single", cast: [rocky], text: "a".repeat(MAX_TEXT + 10) });
    expect(MAX_TEXT).toBe(6000);
    expect(out).toEqual({ error: expect.stringContaining("Shorten it by 10") });
  });

  it("refuses more than 40 lines", () => {
    const text = Array.from({ length: MAX_LINES + 1 }, (_, i) => `Rocky: Line ${i}.`).join("\n");
    expect(MAX_LINES).toBe(40);
    expect(sanitizeScript({ name: "x", kind: "conversation", cast: [rocky, dale], text })).toEqual({ error: expect.stringContaining("at most 40 lines (this has 41)") });
  });

  it("accepts a valid conversation and clamps the gap to 0..3 seconds (default 0.3)", () => {
    const base = { name: "  Morning  show ", kind: "conversation", cast: [rocky, dale], text: "Rocky: Hello.\r\nDale: Hi there." };
    const long = sanitizeScript({ ...base, gapSeconds: 9 });
    expect(long).toHaveProperty("script");
    if (!("script" in long)) throw new Error("unreachable");
    expect(long.script).toMatchObject({ name: "Morning show", kind: "conversation", text: "Rocky: Hello.\nDale: Hi there.", gapSeconds: 3 });
    expect(sanitizeScript({ ...base, gapSeconds: -2 })).toMatchObject({ script: { gapSeconds: 0 } });
    expect(sanitizeScript(base)).toMatchObject({ script: { gapSeconds: 0.3 } });
  });

  it("keeps the seconds only within 3..180 and normalises tags", () => {
    const out = sanitizeScript({ name: "x", cast: [rocky], text: "Hi.", seconds: 2, tags: ["Jazz", "jazz", " Late Night "] });
    expect(out).toMatchObject({ script: { kind: "single", tags: ["jazz", "late night"] } });
    expect(out).not.toHaveProperty("script.seconds");
    expect(sanitizeScript({ name: "x", cast: [rocky], text: "Hi.", seconds: 45 })).toMatchObject({ script: { seconds: 45 } });
  });

  it("needs a name and a JSON object", () => {
    expect(sanitizeScript({ cast: [rocky] })).toEqual({ error: "A script needs a name" });
    expect(sanitizeScript(null)).toEqual({ error: "Send the script as a JSON object" });
  });
});

describe("parseDialogue", () => {
  it("continues a line that has no name onto the previous one, and ignores a parenthesised note after the name", () => {
    const lines = parseDialogue("Rocky: Hello there.\nthis is still Rocky talking\nDale (laughing): Ha, nice.");
    expect(lines).toEqual([
      { speaker: "Rocky", text: "Hello there. this is still Rocky talking" },
      { speaker: "Dale", text: "Ha, nice." },
    ]);
  });

  it("drops a line that has a name but no words, and lines before any name", () => {
    expect(parseDialogue("orphan text\nRocky:   \nDale: Yes.")).toEqual([{ speaker: "Dale", text: "Yes." }]);
  });

  it("lists each speaker once, in order", () => {
    expect(speakersOf("Rocky: a\nDale: b\nRocky: c")).toEqual(["Rocky", "Dale"]);
  });
});

describe("linesOf", () => {
  it("gives a single-voice script one line, spoken by its one speaker", () => {
    const cast = [{ name: "Rocky", voice: "Kore" }];
    expect(linesOf({ kind: "single", cast, text: "Good morning.\nIt is nine." })).toEqual([
      { speaker: "Rocky", text: "Good morning.\nIt is nine.", member: cast[0] },
    ]);
    expect(linesOf({ kind: "single", cast, text: "   " })).toEqual([]);
  });

  it("matches conversation lines to cast members without regard to case", () => {
    const cast = [{ name: "Rocky" }, { name: "Dale", role: "caller" }];
    const lines = linesOf({ kind: "conversation", cast, text: "rocky: Hi.\nDALE: Hello." });
    expect(lines.map((l) => [l.speaker, l.member?.name])).toEqual([["rocky", "Rocky"], ["DALE", "Dale"]]);
  });
});

describe("bold speaker labels from AI writers", () => {
  it("reads **Name:** and **Name**: as the speaker", () => {
    expect(parseDialogue("**Dale:** Ha, nice.\n**Rocky**: Thanks.\nDale: Plain.")).toEqual([{ speaker: "Dale", text: "Ha, nice." }, { speaker: "Rocky", text: "Thanks." }, { speaker: "Dale", text: "Plain." }]);
  });
});
