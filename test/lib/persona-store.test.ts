import { describe, it, expect, vi, beforeEach } from "vitest";

const blobs = vi.hoisted(() => new Map<string, unknown>());
vi.mock("@netlify/blobs", () => ({
  getStore: () => ({
    list: async ({ prefix = "" } = {}) => ({ blobs: [...blobs.keys()].filter((k) => k.startsWith(prefix)).map((key) => ({ key })) }),
    get: async (key: string) => blobs.get(key) ?? null,
    setJSON: async (key: string, value: unknown) => { blobs.set(key, JSON.parse(JSON.stringify(value))); },
    delete: async (key: string) => { blobs.delete(key); },
  }),
}));

import { listPersonas, getPersona, savePersona, deletePersona } from "../../lib/persona-store.js";
import { BUILTIN_PERSONAS } from "../../lib/personas.js";

// A fresh module for each test, so the "already seeded" memory does not leak between them.
const fresh = async () => { vi.resetModules(); return import("../../lib/persona-store.js"); };
beforeEach(() => blobs.clear());

describe("the persona store", () => {
  it("creates CHIP as a real, ordinary persona the first time, and only once", async () => {
    const store = await fresh();
    const first = (await store.listPersonas()).find((p) => p.id === "chip")!;
    expect(first).toMatchObject({ name: "CHIP (Way High Radio)", emoji: "🛰️" });
    expect(first.builtin).toBeUndefined();
    expect(blobs.has("personas/chip.json")).toBe(true);
    // Edit it like any persona, then delete it: it stays gone.
    await store.savePersona({ ...first, emoji: "☢️" });
    expect((await store.getPersona("chip"))!.emoji).toBe("☢️");
    expect(await store.deletePersona("chip")).toBe(true);
    const again = await fresh();
    expect((await again.listPersonas()).some((p) => p.id === "chip")).toBe(false);
    expect(await again.getPersona("chip")).toBeNull();
  });

  it("seeds on a direct lookup too (for example when the virtual host asks for it first)", async () => {
    const store = await fresh();
    expect((await store.getPersona("chip"))?.name).toContain("CHIP");
  });

  it("an edited example replaces the original everywhere, and deleting the edit restores it", async () => {
    const owl = BUILTIN_PERSONAS.find((p) => p.id === "night-owl")!;
    await savePersona({ ...owl, emoji: "☢️", name: "Owl, changed", builtin: undefined });
    const list = await listPersonas();
    expect(list.filter((p) => p.id === "night-owl")).toEqual([expect.objectContaining({ name: "Owl, changed", emoji: "☢️", builtin: true, edited: true })]);
    expect((await getPersona("night-owl"))).toMatchObject({ builtin: true, edited: true, emoji: "☢️" });
    expect(await deletePersona("night-owl")).toBe(true);
    expect((await getPersona("night-owl"))).toEqual(owl);
    expect(await deletePersona("night-owl")).toBe(false);
  });
});
