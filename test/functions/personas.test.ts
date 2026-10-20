import { describe, it, expect, vi, beforeEach } from "vitest";

vi.mock("../../lib/gemini.js", () => ({ writeDjLine: vi.fn(), synthesizeSpeech: vi.fn(), DEFAULT_VOICE: "Kore" }));
vi.mock("../../lib/ai.js", async (importOriginal) => ({ ...(await importOriginal<typeof import("../../lib/ai.js")>()), complete: vi.fn() }));
vi.mock("../../lib/persona-store.js", async () => {
  const personas = await import("../../lib/personas.js");
  const saved = new Map<string, unknown>();
  return {
    listPersonas: vi.fn(async () => [...personas.BUILTIN_PERSONAS, ...saved.values()]),
    getPersona: vi.fn(async (id: string) => personas.BUILTIN_PERSONAS.find((p) => p.id === id) ?? saved.get(id) ?? null),
    savePersona: vi.fn(async (p: { id: string }) => { saved.set(p.id, p); }),
    deletePersona: vi.fn(async (id: string) => saved.delete(id)),
    newPersonaId: (name: string) => `${personas.slugify(name)}-abc123`,
  };
});

import { complete } from "../../lib/ai.js";
import { handlePersonas } from "../../lib/handlers/personas.js";

const KEY = "test-access-key-0123456789";
const call = (method: string, id?: string, body?: unknown) =>
  handlePersonas(new Request(`http://localhost/api/personas${id ? `/${id}` : ""}`, { method, headers: { "x-api-key": KEY, "content-type": "application/json" }, ...(body === undefined ? {} : { body: JSON.stringify(body) }) }), id);

beforeEach(() => {
  vi.stubEnv("ACCESS_KEY", KEY);
  vi.stubEnv("OPENROUTER_API_KEY", "or-key");
  vi.stubEnv("PROVIDER", "");
  vi.stubEnv("OPENROUTER_TEXT_MODELS", "");
  vi.stubEnv("OPENROUTER_TEXT_MODEL", "");
  vi.stubEnv("OPENROUTER_ALLOW_ANY_MODEL", "");
  vi.mocked(complete).mockReset();
});

describe("personas", () => {
  it("lists the built-in CHIP and creates, edits and deletes your own", async () => {
    const made = await call("POST", undefined, { name: "Night Owl", instructions: "A sleepy jazz host.", tone: "low, slow", templates: ["Next: {title}.", ""], extra: "ignored" });
    expect(made.status).toBe(201);
    const { persona } = (await made.json()) as { persona: { id: string; templates: string[] } };
    expect(persona.id).toBe("night-owl-abc123");
    expect(persona.templates).toEqual(["Next: {title}."]);

    const list = (await (await call("GET")).json()) as { personas: Array<{ id: string; builtin?: boolean }> };
    expect(list.personas.map((p) => p.id)).toContain("chip");
    expect(list.personas.filter((p) => !p.builtin).map((p) => p.id)).toEqual(["night-owl-abc123"]);

    expect((await call("PUT", persona.id, { name: "Night Owl 2", instructions: "Still sleepy." })).status).toBe(200);
    expect((await call("DELETE", persona.id)).status).toBe(204);
    expect((await call("GET", persona.id)).status).toBe(404);
  });

  it("ships well-formed example personas", async () => {
    const { BUILTIN_PERSONAS, sanitizePersona } = await import("../../lib/personas.js");
    expect(BUILTIN_PERSONAS.length).toBeGreaterThanOrEqual(10);
    expect(new Set(BUILTIN_PERSONAS.map((p) => p.id)).size).toBe(BUILTIN_PERSONAS.length);
    for (const p of BUILTIN_PERSONAS) {
      expect(sanitizePersona(p), p.id).toHaveProperty("persona");
      expect(p.templates.length, p.id).toBeGreaterThanOrEqual(5);
      expect(p.stationIds.length, p.id).toBeGreaterThanOrEqual(3);
      expect(p.tags.length, p.id).toBeGreaterThan(0);
      expect(p.emoji, p.id).toBeTruthy();
      expect(Object.keys(p.timeLines ?? {}), p.id).toEqual(["morning", "afternoon", "evening", "night"]);
      for (const line of [...p.templates, ...p.stationIds, ...p.promos, ...p.signOffs, ...Object.values(p.timeLines ?? {})]) {
        expect(line.replace(/\{(artist|title|station)\}/g, ""), `${p.id}: ${line}`).not.toMatch(/[{}\[\]]/);   // only known placeholders, no tags to read aloud
        expect(line.length).toBeLessThanOrEqual(300);
      }
      expect(p.templates.some((l) => l.includes("{artist}") || l.includes("{title}")), p.id).toBe(true);
    }
  });

  it("keeps the new fields when saving, and loads older personas without them", async () => {
    const { sanitizePersona, normalizePersona } = await import("../../lib/personas.js");
    const out = sanitizePersona({ name: "Zed", instructions: "x", emoji: "🎧", tags: ["Jazz", "jazz", " Chill "], tagline: "Hi", promos: ["Promo"], signOffs: ["Bye"], timeLines: { morning: "Morning!" } });
    expect(out).toMatchObject({ persona: { emoji: "🎧", tags: ["jazz", "chill"], tagline: "Hi", promos: ["Promo"], signOffs: ["Bye"], timeLines: { morning: " Morning!" } } });
    expect(normalizePersona({ id: "old", name: "Old", description: "", instructions: "x", tone: "", templates: [], stationIds: [] } as never)).toMatchObject({ tags: [], promos: [], signOffs: [] });
  });

  it("refuses to change a built-in persona and rejects an empty one", async () => {
    expect((await call("PUT", "chip", { name: "x", instructions: "y" })).status).toBe(403);
    expect((await call("DELETE", "chip")).status).toBe(403);
    expect((await call("POST", undefined, { name: "No instructions" })).status).toBe(400);
  });

  it("drafts a persona from a description, tolerating code fences, without saving it", async () => {
    vi.mocked(complete).mockResolvedValue('Here you go:\n```json\n{"name":"Dusty","description":"A cowboy","instructions":"You are Dusty.","tone":"dry","templates":["{artist}. Yep."],"stationIds":["Dusty Radio."]}\n```');
    const res = await call("POST", "generate", { description: "a lonesome cowboy" });
    expect(res.status).toBe(200);
    expect(((await res.json()) as { persona: { name: string } }).persona.name).toBe("Dusty");
    expect(vi.mocked(complete).mock.calls[0][0].prompt).toContain("a lonesome cowboy");
  });

  it("reports a model that returns something else as a 502", async () => {
    vi.mocked(complete).mockResolvedValue("Sorry, I cannot.");
    expect((await call("POST", "generate", { description: "x" })).status).toBe(502);
    expect((await call("POST", "generate", {})).status).toBe(400);
  });
});
