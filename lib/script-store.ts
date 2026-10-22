import { getStore } from "@netlify/blobs";
import { randomBytes } from "node:crypto";
import { slugify } from "./personas.js";
import type { Script } from "./scripts.js";

// Strong consistency: a read right after a save returns the saved version.
const store = () => getStore({ name: "dj-scripts", consistency: "strong" });
const key = (id: string) => `scripts/${id}.json`;
export const SCRIPT_ID = /^[a-z0-9][a-z0-9-]{0,59}$/;

export async function listScripts(): Promise<Script[]> {
  const { blobs } = await store().list({ prefix: "scripts/" });
  const all = (await Promise.all(blobs.map(({ key: k }) => store().get(k, { type: "json" }) as Promise<Script | null>))).filter((s): s is Script => Boolean(s));
  return all.sort((a, b) => (b.updatedAt ?? "").localeCompare(a.updatedAt ?? ""));
}
export async function getScript(id: string): Promise<Script | null> {
  if (!SCRIPT_ID.test(id)) return null;
  return ((await store().get(key(id), { type: "json" })) as Script | null) ?? null;
}
export const newScriptId = (name: string): string => `${slugify(name) || "script"}-${randomBytes(3).toString("hex")}`;
export async function saveScript(s: Script): Promise<Script> {
  const saved = { ...s, createdAt: s.createdAt ?? new Date().toISOString(), updatedAt: new Date().toISOString() };
  await store().setJSON(key(s.id), saved);
  return saved;
}
export async function deleteScript(id: string): Promise<boolean> {
  if (!SCRIPT_ID.test(id) || !(await store().get(key(id)))) return false;
  await store().delete(key(id));
  return true;
}
