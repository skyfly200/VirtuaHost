import { getStore } from "@netlify/blobs";
import { randomBytes } from "node:crypto";
import { BUILTIN_PERSONAS, ID, normalizePersona, slugify, type Persona } from "./personas.js";
import { SEED_PERSONAS } from "./persona-seeds.js";

// Strong consistency: a read right after a save returns the saved version, not the one from before (Blobs is otherwise eventually consistent).
const store = () => getStore({ name: "dj-personas", consistency: "strong" });
const key = (id: string) => `personas/${id}.json`;
const seedKey = (id: string) => `seeds/${id}`;
const isExample = (id: string) => BUILTIN_PERSONAS.some((p) => p.id === id);

// An example persona that an admin has edited is stored under the example's own id; it replaces the original everywhere until it is reset.
const edited = (p: Persona): Persona => ({ ...normalizePersona(p), builtin: true, edited: true });

// Seeds (lib/persona-seeds.ts) become ordinary stored personas the first time they are needed, once: the marker stops a deleted one coming back.
const seeded = new Set<string>();
async function ensureSeed(seed: Persona): Promise<void> {
  if (seeded.has(seed.id)) return;
  if (!(await store().get(seedKey(seed.id)))) {
    if (!(await store().get(key(seed.id)))) await store().setJSON(key(seed.id), { ...seed, builtin: undefined, updatedAt: new Date().toISOString() });
    await store().setJSON(seedKey(seed.id), { at: new Date().toISOString() });
  }
  seeded.add(seed.id);
}

export async function listPersonas(): Promise<Persona[]> {
  for (const seed of SEED_PERSONAS) await ensureSeed(seed);
  const { blobs } = await store().list({ prefix: "personas/" });
  const stored = (await Promise.all(blobs.map(({ key: k }) => store().get(k, { type: "json" }) as Promise<Persona | null>))).filter((p): p is Persona => Boolean(p));
  const overrides = new Map(stored.filter((p) => isExample(p.id)).map((p) => [p.id, p]));
  const own = stored.filter((p) => !isExample(p.id));
  own.sort((a, b) => a.name.localeCompare(b.name));
  return [...BUILTIN_PERSONAS.map((b) => (overrides.has(b.id) ? edited(overrides.get(b.id)!) : b)), ...own.map(normalizePersona)];
}

export async function getPersona(id: string): Promise<Persona | null> {
  const builtin = BUILTIN_PERSONAS.find((p) => p.id === id);
  if (builtin) {
    const override = (await store().get(key(id), { type: "json" })) as Persona | null;
    return override ? edited(override) : builtin;
  }
  if (!ID.test(id)) return null;
  let found = ((await store().get(key(id), { type: "json" })) as Persona | null) ?? null;
  const seed = SEED_PERSONAS.find((s) => s.id === id);
  if (!found && seed) { await ensureSeed(seed); found = ((await store().get(key(id), { type: "json" })) as Persona | null) ?? null; }
  return found ? normalizePersona(found) : null;
}

// A new id from the name (slug plus a short random suffix so two "Night Owl" personas never collide).
export const newPersonaId = (name: string): string => `${slugify(name) || "persona"}-${randomBytes(3).toString("hex")}`;

export async function savePersona(persona: Persona): Promise<void> {
  await store().setJSON(key(persona.id), { ...persona, builtin: undefined, edited: undefined, updatedAt: new Date().toISOString() });
}

/** Deletes a stored persona. For an example persona this removes the admin's edits (the original comes back). */
export async function deletePersona(id: string): Promise<boolean> {
  if (!ID.test(id) || !(await store().get(key(id)))) return false;
  await store().delete(key(id));
  return true;
}
