import { describe, it, expect, vi, beforeEach } from "vitest";
import type { ProviderName } from "../../lib/ai.js";
import type { Persona } from "../../lib/personas.js";
import type { Station } from "../../lib/station-profile.js";

vi.mock("../../lib/ai.js", () => ({ complete: vi.fn() }));

import { complete } from "../../lib/ai.js";
import { buildDraft, draftScript, parseDraft, type DraftContext } from "../../lib/script-draft.js";
import { contextFor } from "../../lib/drop-template.js";

const EXAMPLE = "Nothing like a cold one after a long shift, folks.";
const rocky = {
  id: "rocky", name: "Rocky", description: "", instructions: `A grumpy old host who loves the late shift. Says things like "${EXAMPLE}"`,
  tone: "gruff", templates: [], stationIds: [], tags: [], promos: [], signOffs: [],
} as unknown as Persona;
const station = { id: "krap", name: "KRAP", tagline: "Loud and proud", tz: "UTC", genres: [], links: [], skipArtists: [] } as unknown as Station;
const personas = new Map([["rocky", rocky]]);
const template = contextFor({ station });
const ctx = (over: Partial<DraftContext> = {}): DraftContext => ({ provider: "openrouter" as ProviderName, station, personas, template, ...over });

beforeEach(() => {
  vi.mocked(complete).mockReset();
});

describe("buildDraft", () => {
  it("puts the cast, each persona's brief and role, and the rules into the system prompt", () => {
    const { system, prompt } = buildDraft(
      {
        kind: "conversation", topic: "the late shift", seconds: 30, names: ["Dolly Parton"], facts: ["Doors open at nine"],
        cast: [{ name: "Rocky", personaId: "rocky", role: "host" }, { name: "Dale", role: "skeptical caller" }],
      },
      ctx(),
    );
    expect(system).toContain("on-air voices of KRAP");
    expect(system).toContain("- Rocky (host): A grumpy old host");
    expect(system).toContain("Tone: gruff.");
    expect(system).toContain("- Dale (skeptical caller)");
    expect(system).toContain("ONLY these names");
    expect(system).toContain("at most 10 lines");
    expect(system).toContain("The station's tagline is \"Loud and proud\".");
    expect(system).toContain("Length: about 30 seconds when spoken, roughly 75 words in total.");
    expect(system).toContain("You may name only these songs, artists or people: Dolly Parton. Name nothing else.");
    expect(system).toContain("Facts you may use: Doors open at nine.");
    expect(prompt).toBe("the late shift");
  });

  it("asks a single voice for its own words only, with no names list", () => {
    const { system, prompt } = buildDraft({ kind: "single", topic: "", cast: [{ name: "Rocky", personaId: "rocky" }] }, ctx());
    expect(system).toContain("Write what Rocky says.");
    expect(system).not.toContain("ONLY these names");
    expect(system).not.toContain("Length:");
    expect(prompt).toBe("A short on-air line.");
  });
});

describe("parseDraft", () => {
  const cast = [{ name: "Rocky" }, { name: "Dale" }];
  const reply = "```text\nrocky: Hi there folks.\nDALE: Hmm, **really**?\nSam: Who is this?\nRocky: Second line\n```";

  it("keeps only cast speakers (matched without case), strips ** markdown and code fences, and counts what it dropped", () => {
    expect(parseDraft(reply, cast, 10)).toEqual({
      lines: [
        { speaker: "Rocky", text: "Hi there folks." },
        { speaker: "Dale", text: "Hmm, really?" },
        { speaker: "Rocky", text: "Second line" },
      ],
      dropped: 1,
    });
  });

  it("respects maxLines and counts the lines past it as dropped", () => {
    expect(parseDraft(reply, cast, 2)).toEqual({
      lines: [{ speaker: "Rocky", text: "Hi there folks." }, { speaker: "Dale", text: "Hmm, really?" }],
      dropped: 2,
    });
  });
});

describe("draftScript", () => {
  it("retries once when a speaker copies an example line from its persona, then uses the fresh attempt", async () => {
    vi.mocked(complete)
      .mockResolvedValueOnce(`Rocky: ${EXAMPLE}\nDale: Sure thing.`)
      .mockResolvedValueOnce("Rocky: Fresh words for the crowd tonight.\nDale: Sure thing.");
    const out = await draftScript({ kind: "conversation", topic: "night", cast: [{ name: "Rocky", personaId: "rocky" }, { name: "Dale" }] }, ctx());
    expect(vi.mocked(complete)).toHaveBeenCalledTimes(2);
    expect(vi.mocked(complete).mock.calls[1][0].prompt).toContain("repeated an example line");
    expect(out.copied).toEqual([]);
    expect(out.text).toBe("Rocky: Fresh words for the crowd tonight.\nDale: Sure thing.");
  });

  it("reports the copied speaker when the retry still copies the example", async () => {
    vi.mocked(complete).mockResolvedValue(`Rocky: ${EXAMPLE}\nDale: Sure thing.`);
    const out = await draftScript({ kind: "conversation", topic: "night", cast: [{ name: "Rocky", personaId: "rocky" }, { name: "Dale" }] }, ctx());
    expect(vi.mocked(complete)).toHaveBeenCalledTimes(2);
    expect(out.copied).toEqual(["Rocky"]);
  });

  it("retries once when only one speaker spoke in a conversation", async () => {
    vi.mocked(complete)
      .mockResolvedValueOnce("Rocky: Hi there friends.")
      .mockResolvedValueOnce("Rocky: Hi.\nDale: Hello back to you.");
    const out = await draftScript({ kind: "conversation", topic: "hello", cast: [{ name: "Rocky" }, { name: "Dale" }] }, ctx());
    expect(vi.mocked(complete)).toHaveBeenCalledTimes(2);
    expect(new Set(out.lines.map((l) => l.speaker))).toEqual(new Set(["Rocky", "Dale"]));
  });

  it("throws a clear error when both attempts give nothing usable", async () => {
    vi.mocked(complete).mockResolvedValue("Sorry, I cannot help with that.");
    await expect(draftScript({ kind: "conversation", topic: "x", cast: [{ name: "Rocky" }, { name: "Dale" }] }, ctx())).rejects.toThrow(/did not return a script/);
    expect(vi.mocked(complete)).toHaveBeenCalledTimes(2);
  });

  it("returns one line for a single voice, stripping a leading name", async () => {
    vi.mocked(complete).mockResolvedValue("Rocky: Good morning, folks.");
    const out = await draftScript({ kind: "single", topic: "morning", cast: [{ name: "Rocky" }] }, ctx());
    expect(out.lines).toEqual([{ speaker: "Rocky", text: "Good morning, folks." }]);
    expect(out.text).toBe("Good morning, folks.");
    expect(out.raw).toBe("Good morning, folks.");
  });

  it("fills placeholders such as {{station}} after the words are written", async () => {
    vi.mocked(complete).mockResolvedValue("Rocky: Welcome to {{station}}, the loudest voice on the coast.");
    const out = await draftScript({ kind: "single", topic: "welcome", cast: [{ name: "Rocky" }] }, ctx());
    expect(out.text).toBe("Welcome to KRAP, the loudest voice on the coast.");
    expect(out.raw).toContain("{{station}}");
  });
});
