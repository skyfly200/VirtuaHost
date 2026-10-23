import { describe, it, expect, vi, beforeEach } from "vitest";

vi.mock("../../lib/gemini.js", () => ({ writeDjLine: vi.fn(), synthesizeSpeech: vi.fn(), DEFAULT_VOICE: "Kore" }));
vi.mock("../../lib/ai.js", async (importOriginal) => ({ ...(await importOriginal<typeof import("../../lib/ai.js")>()), complete: vi.fn() }));
vi.mock("../../lib/persona-store.js", async () => {
  const personas = await import("../../lib/personas.js");
  const saved = new Map<string, unknown>();
  return {
    // Like the real store: an example persona that was saved over comes back marked edited.
    listPersonas: vi.fn(async () => [...personas.BUILTIN_PERSONAS.map((b) => (saved.has(b.id) ? { ...(saved.get(b.id) as object), builtin: true, edited: true } : b)), ...[...saved.values()].filter((p) => !personas.BUILTIN_PERSONAS.some((b) => b.id === (p as { id: string }).id))]),
    getPersona: vi.fn(async (id: string) => { const b = personas.BUILTIN_PERSONAS.find((p) => p.id === id); return b ? (saved.has(id) ? { ...(saved.get(id) as object), builtin: true, edited: true } : b) : saved.get(id) ?? null; }),
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
  it("lists the built-in examples and creates, edits and deletes your own", async () => {
    const made = await call("POST", undefined, { name: "Night Owl", instructions: "A sleepy jazz host.", tone: "low, slow", templates: ["Next: {title}.", ""], extra: "ignored" });
    expect(made.status).toBe(201);
    const { persona } = (await made.json()) as { persona: { id: string; templates: string[] } };
    expect(persona.id).toBe("night-owl-abc123");
    expect(persona.templates).toEqual(["Next: {title}."]);

    const list = (await (await call("GET")).json()) as { personas: Array<{ id: string; builtin?: boolean }> };
    expect(list.personas.map((p) => p.id)).toContain("night-owl");
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

  it("sends back the model's reply when a persona draft cannot be read", async () => {
    vi.mocked(complete).mockResolvedValue("I would love to, but here is a story instead. Once upon a time...");
    const res = await call("POST", "generate", { description: "a sleepy jazz host" });
    expect(res.status).toBe(502);
    expect(await res.json()).toMatchObject({ error: expect.stringContaining("did not return a persona"), reply: expect.stringContaining("Once upon a time") });
  });

  it("lets an admin edit an example (it comes back marked edited), reset it, and rejects an empty persona", async () => {
    const original = ((await (await call("GET", "night-owl")).json()) as { persona: { name: string; edited?: boolean } }).persona;
    expect(original.edited).toBeUndefined();
    expect((await call("DELETE", "night-owl")).status).toBe(409);                       // nothing to reset yet
    const saved = await call("PUT", "night-owl", { name: "Night Owl", emoji: "☢️", instructions: "Changed brief." });
    expect(saved.status).toBe(200);
    expect(((await saved.json()) as { persona: { builtin: boolean; edited: boolean } }).persona).toMatchObject({ builtin: true, edited: true, emoji: "☢️" });
    const list = (await (await call("GET")).json()) as { personas: Array<{ id: string; emoji?: string; edited?: boolean }> };
    expect(list.personas.filter((p) => p.id === "night-owl")).toEqual([expect.objectContaining({ emoji: "☢️", edited: true })]);   // replaced, not duplicated
    expect((await call("DELETE", "night-owl")).status).toBe(204);
    expect(((await (await call("GET", "night-owl")).json()) as { persona: { emoji: string } }).persona.emoji).not.toBe("☢️");
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
