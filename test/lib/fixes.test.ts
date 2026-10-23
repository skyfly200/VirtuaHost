import { describe, expect, it, beforeEach } from "vitest";
import { sanitizePersona, parsePersonaReply, INSTRUCTIONS_MAX } from "../../lib/personas.js";
import { copiedExample, exampleLines, overlap } from "../../lib/copy-guard.js";
import { modelFlag, recordModelResult, resetModelHealth, RETIRED_MODELS } from "../../lib/model-health.js";

describe("persona instructions limit (no silent truncation)", () => {
  it("refuses a brief over the limit with the exact overage, and accepts one at the limit", () => {
    const over = sanitizePersona({ name: "Rocky", instructions: "a".repeat(INSTRUCTIONS_MAX + 37) });
    expect(over).toEqual({ error: expect.stringContaining("1537 characters; the limit is 1500. Shorten them by 37") });
    expect(sanitizePersona({ name: "Rocky", instructions: "a".repeat(INSTRUCTIONS_MAX) })).toHaveProperty("persona.instructions.length", INSTRUCTIONS_MAX);
  });
  it("an AI-drafted persona is cut at a sentence instead of being refused", () => {
    const long = `${"Rocky talks slow. ".repeat(120)}`;
    const out = parsePersonaReply(JSON.stringify({ name: "Rocky", instructions: long }));
    expect(out).toHaveProperty("persona.instructions");
    const text = (out as { persona: { instructions: string } }).persona.instructions;
    expect(text.length).toBeLessThanOrEqual(INSTRUCTIONS_MAX);
    expect(text.endsWith(".")).toBe(true);
  });
});

describe("copy guard (writers that echo the persona's example lines)", () => {
  const brief = 'Rocky is gruff. Examples: "Nothing like a cold one after a long shift, folks." and "That was Boards of Canada, still older than your couch."';
  it("finds quoted example lines", () => {
    expect(exampleLines(brief, ["Next up: {title}, from the shelf."])).toHaveLength(3);
    expect(exampleLines(brief)).toHaveLength(2);
  });
  it("flags a near-verbatim copy but not a fresh line", () => {
    const ex = exampleLines(brief);
    expect(copiedExample("Nothing like a cold one after a long shift, friends.", ex)).toContain("cold one");
    expect(copiedExample("That was Boards of Canada, still older than your couch!", ex)).toContain("older than your couch");
    expect(copiedExample("Eight o'clock in Denver and the coffee is already cold.", ex)).toBeUndefined();
    expect(overlap("hi", "short")).toBe(0);
  });
});

describe("model health", () => {
  beforeEach(() => resetModelHealth());
  it("retired slugs are flagged with a reason", () => {
    expect(modelFlag("anthropic/claude-3.5-haiku")).toMatchObject({ status: "retired" });
    expect(Object.keys(RETIRED_MODELS)).toContain("anthropic/claude-3.5-haiku");
  });
  it("two failures in a row flag a model as failing; a success clears it; old failures expire", () => {
    recordModelResult("x/y", false, "returned no text", 1000);
    expect(modelFlag("x/y", 1500)).toBeUndefined();
    recordModelResult("x/y", false, "returned no text", 2000);
    expect(modelFlag("x/y", 2500)).toMatchObject({ status: "failing", note: expect.stringContaining("returned no text") });
    expect(modelFlag("x/y", 2000 + 7 * 3600e3)).toBeUndefined();
    recordModelResult("x/y", true, undefined, 3000);
    expect(modelFlag("x/y", 3500)).toBeUndefined();
  });
});
