import { getStore } from "@netlify/blobs";
import { randomBytes } from "node:crypto";
import { BUILTIN_PERSONAS, ID, normalizePersona, slugify, type Persona } from "./personas.js";

const store = () => getStore("dj-personas");
const key = (id: string) => `personas/${id}.json`;

export async function listPersonas(): Promise<Persona[]> {
  const { blobs } = await store().list({ prefix: "personas/" });
  const stored = (await Promise.all(blobs.map(({ key: k }) => store().get(k, { type: "json" }) as Promise<Persona | null>))).filter((p): p is Persona => Boolean(p));
  stored.sort((a, b) => a.name.localeCompare(b.name));
  return [...BUILTIN_PERSONAS, ...stored.map(normalizePersona)];
}

export async function getPersona(id: string): Promise<Persona | null> {
  const builtin = BUILTIN_PERSONAS.find((p) => p.id === id);
  if (builtin) return builtin;
  if (!ID.test(id)) return null;
  const found = ((await store().get(key(id), { type: "json" })) as Persona | null) ?? null;
  return found ? normalizePersona(found) : null;
}

// A new id from the name (slug plus a short random suffix so two "Night Owl" personas never collide).
export const newPersonaId = (name: string): string => `${slugify(name) || "persona"}-${randomBytes(3).toString("hex")}`;

export async function savePersona(persona: Persona): Promise<void> {
  await store().setJSON(key(persona.id), { ...persona, builtin: undefined, updatedAt: new Date().toISOString() });
}

export async function deletePersona(id: string): Promise<boolean> {
  if (!ID.test(id) || !(await store().get(key(id)))) return false;
  await store().delete(key(id));
  return true;
}
