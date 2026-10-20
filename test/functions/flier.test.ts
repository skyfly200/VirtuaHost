import { describe, it, expect, vi, beforeEach } from "vitest";

vi.mock("../../lib/gemini.js", () => ({ writeDjLine: vi.fn(), synthesizeSpeech: vi.fn(), describeImage: vi.fn(), DEFAULT_VOICE: "Kore" }));
vi.mock("../../lib/ai.js", async (importOriginal) => ({ ...(await importOriginal<typeof import("../../lib/ai.js")>()), complete: vi.fn(), readImage: vi.fn() }));
vi.mock("../../lib/persona-store.js", async () => {
  const { BUILTIN_PERSONAS } = await import("../../lib/personas.js");
  return { getPersona: vi.fn(async (id: string) => BUILTIN_PERSONAS.find((p) => p.id === id) ?? null) };
});

import { complete, readImage } from "../../lib/ai.js";
import { handleFlier } from "../../lib/handlers/flier.js";
import { normalizeEvent, parseJsonObject, parseVariants, spokenWhen } from "../../lib/flier.js";

const KEY = "test-access-key-0123456789";
const call = (path: string, body: unknown) =>
  handleFlier(new Request(`http://localhost/api/flier/${path}`, { method: "POST", headers: { "x-api-key": KEY, "content-type": "application/json" }, body: JSON.stringify(body) }));
const IMG = "data:image/jpeg;base64,/9j/4AAQSkZJRg==";

beforeEach(() => {
  vi.clearAllMocks();
  vi.stubEnv("ACCESS_KEY", KEY);
  vi.stubEnv("OPENROUTER_API_KEY", "or-key");
  for (const n of ["PROVIDER", "GEMINI_API_KEY", "OPENROUTER_TEXT_MODELS", "OPENROUTER_TEXT_MODEL", "OPENROUTER_ALLOW_ANY_MODEL", "STATION_NAME"]) vi.stubEnv(n, "");
});

describe("flier helpers", () => {
  it("says dates the way a host would", () => {
    expect(spokenWhen("2030-04-12T23:30:00Z", "America/New_York")).toBe("Friday the twelfth of April at seven thirty p.m.");
    expect(spokenWhen("2030-04-12T16:00:00Z", "UTC")).toBe("Friday the twelfth of April at four p.m.");
    expect(spokenWhen("2030-04-13T00:05:00Z", "UTC")).toBe("Saturday the thirteenth of April at twelve oh five a.m.");
    expect(spokenWhen("2030-04-12T12:00:00Z", "UTC")).toContain("at noon");
  });

  it("turns local times on the flier into instants, with an assumed end", () => {
    const out = normalizeEvent({ name: "Spring Fling", startsAtLocal: "2030-04-12T19:30", venue: "The Barn" }, "America/New_York", Date.parse("2030-04-01T00:00:00Z"));
    expect(out).toMatchObject({ event: { name: "Spring Fling", startsAt: "2030-04-12T23:30:00.000Z", endsAt: "2030-04-13T02:30:00.000Z", expiresAt: "2030-04-13T02:30:00.000Z", endGuessed: true, tz: "America/New_York" } });
    const given = normalizeEvent({ name: "X", startsAtLocal: "2030-04-12T19:30", endsAtLocal: "2030-04-12T23:00" }, "America/New_York", 0);
    expect(given).toMatchObject({ event: { expiresAt: "2030-04-13T03:00:00.000Z" } });
    expect((given as { event: { endGuessed?: boolean } }).event.endGuessed).toBeUndefined();
  });

  it("refuses an event that is over, ends before it starts, or has no name", () => {
    expect(normalizeEvent({ name: "Old", startsAtLocal: "2001-01-01T10:00" }, "UTC")).toMatchObject({ error: expect.stringContaining("already over") });
    expect(normalizeEvent({ name: "Odd", startsAtLocal: "2030-04-12T19:00", endsAtLocal: "2030-04-12T18:00" }, "UTC", 0)).toMatchObject({ error: expect.stringContaining("ends before") });
    expect(normalizeEvent({ venue: "x" }, "UTC")).toMatchObject({ error: expect.stringContaining("name") });
    expect(normalizeEvent({ name: "No time" }, "UTC")).toMatchObject({ event: { name: "No time" } });     // allowed: no expiry yet
  });

  it("parses model replies", () => {
    expect(parseJsonObject('Here:\n```json\n{"name":"A"}\n```')).toEqual({ name: "A" });
    expect(parseJsonObject("nothing")).toBeNull();
    expect(parseVariants('```json\n["One.", " Two. "]\n```')).toEqual(["One.", "Two."]);
    expect(parseVariants("Just a plain spot.")).toEqual(["Just a plain spot."]);
    expect(parseVariants("")).toEqual([]);
  });
});

describe("flier endpoints", () => {
  it("reads a picture into event details", async () => {
    vi.mocked(readImage).mockResolvedValue('{"name":"Spring Fling","startsAtLocal":"2030-04-12T19:30","venue":"The Barn","price":"$10","performers":["Ada"],"notes":["No end time on the flier"]}');
    const res = await call("read", { image: IMG, tz: "America/New_York" });
    expect(res.status).toBe(200);
    const { event } = (await res.json()) as { event: Record<string, unknown> };
    expect(event).toMatchObject({ name: "Spring Fling", startsAt: "2030-04-12T23:30:00.000Z", venue: "The Barn", price: "$10", performers: ["Ada"], endGuessed: true, notes: ["No end time on the flier"] });
    expect(vi.mocked(readImage).mock.calls[0][0].system).toContain("America/New_York");
  });

  it("reads pasted text with the writing model", async () => {
    vi.mocked(complete).mockResolvedValue('{"name":"Open Mic","startsAtLocal":"2030-05-03T20:00","endsAtLocal":"2030-05-03T23:00"}');
    expect(((await (await call("read", { text: "Open mic night, May 3, 8pm" })).json()) as { event: { expiresAt: string } }).event.expiresAt).toBe("2030-05-03T23:00:00.000Z");
    expect(readImage).not.toHaveBeenCalled();
  });

  it("rejects bad input and model failures", async () => {
    expect((await call("read", {})).status).toBe(400);
    expect((await call("read", { image: "data:text/html;base64,AAAA" })).status).toBe(400);
    expect((await call("read", { image: IMG + "A".repeat(4_600_000) })).status).toBe(400);
    vi.mocked(readImage).mockResolvedValue("I cannot read that.");
    expect((await call("read", { image: IMG })).status).toBe(502);
    vi.mocked(readImage).mockRejectedValue(new Error("model has no vision"));
    expect(((await (await call("read", { image: IMG })).json()) as { error: string }).error).toMatch(/Could not read the flier: model has no vision/);
  });

  it("writes spots from the confirmed facts in the persona's voice", async () => {
    vi.mocked(complete).mockResolvedValue('["Spring Fling is Friday the twelfth of April at seven thirty p.m. at The Barn!", "Be at The Barn on Friday the twelfth."]');
    const res = await call("promo", { event: { name: "Spring Fling", startsAtLocal: "2030-04-12T19:30", endsAtLocal: "2030-04-12T23:00", venue: "The Barn", price: "$10" }, tz: "America/New_York", personaId: "sunny-sam", count: 2 });
    expect(res.status).toBe(200);
    const body = (await res.json()) as { variants: string[]; event: { expiresAt: string } };
    expect(body.variants).toHaveLength(2);
    expect(body.event.expiresAt).toBe("2030-04-13T03:00:00.000Z");
    const sent = vi.mocked(complete).mock.calls[0][0];
    expect(sent.prompt).toContain("Friday the twelfth of April at seven thirty p.m.");
    expect(sent.prompt).toContain("Price: $10");
    expect(sent.system).toContain("Sunny Sam");
    expect(sent.system).toContain("never use relative words like tonight");
  });

  it("will not write a promo for a finished event", async () => {
    expect((await call("promo", { event: { name: "Old", startsAtLocal: "2001-01-01T10:00" } })).status).toBe(400);
    expect(complete).not.toHaveBeenCalled();
    expect((await call("promo", { event: { name: "X", startsAtLocal: "2999-01-01T10:00" }, personaId: "nobody" })).status).toBe(400);
  });
});
