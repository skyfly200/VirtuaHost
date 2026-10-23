// Audio files people upload themselves, kept in Netlify Blobs and offered to the sound library like the cloud folders: a background (music bed),
// an intro or outro clip, or a sound effect. They are used by name in tags ([music:name vol=0.2], [intro:name], [outro:name], [sfx:name]) wherever
// audio is mixed (the Studio, schedules, /api/generate). Shared across the station: anyone signed in can use a file; only its owner or an admin
// changes or deletes it. The browser converts uploads to WAV first (public/shared/uploader.js), so the server can mix them too.
import { getStore } from "@netlify/blobs";
import { createLogger } from "../log.js";
import { KINDS, MAX_FETCH_BYTES, nameOf, type LibraryItem, type LibraryKind, type LibrarySource } from "./types.js";

const log = createLogger("uploads");
// Strong consistency: a file just uploaded is in the very next listing.
const store = () => getStore({ name: "dj-uploads", consistency: "strong" });
const KEY = "files/";

export interface UploadMeta {
  id: string;
  /** The name used in tags: lowercase letters, numbers and dashes. */
  name: string;
  kind: LibraryKind;
  /** The file name it was uploaded as. */
  file: string;
  mimeType: string;
  size: number;
  /** Length in seconds when the browser measured it. */
  seconds?: number;
  ownerId?: string;
  createdAt: string;
}

export const isKind = (v: unknown): v is LibraryKind => typeof v === "string" && (KINDS as readonly string[]).includes(v);
const toArrayBuffer = (b: Buffer): ArrayBuffer => b.buffer.slice(b.byteOffset, b.byteOffset + b.byteLength) as ArrayBuffer;

export async function listUploads(): Promise<UploadMeta[]> {
  const { blobs } = await store().list({ prefix: KEY });
  const metas = await Promise.all(blobs.map(async ({ key }) => (await store().getMetadata(key))?.metadata as unknown as UploadMeta | undefined));
  return metas.filter((m): m is UploadMeta => Boolean(m && m.id && m.name && isKind(m.kind))).sort((a, b) => a.name.localeCompare(b.name));
}
export async function getUploadMeta(id: string): Promise<UploadMeta | null> {
  return ((await store().getMetadata(`${KEY}${id}`))?.metadata as unknown as UploadMeta | undefined) ?? null;
}
export async function saveUpload(meta: UploadMeta, audio: Buffer): Promise<void> {
  await store().set(`${KEY}${meta.id}`, toArrayBuffer(audio), { metadata: meta as unknown as Record<string, unknown> });
}
export async function updateUpload(meta: UploadMeta): Promise<void> {
  const current = await store().getWithMetadata(`${KEY}${meta.id}`, { type: "arrayBuffer" });
  if (!current) return;
  await store().set(`${KEY}${meta.id}`, current.data, { metadata: meta as unknown as Record<string, unknown> });
}
export async function deleteUpload(id: string): Promise<void> { await store().delete(`${KEY}${id}`); }

/** A tag-safe name for a new file, made unique among the files of its kind and the built-in effects. */
export function uniqueName(wanted: string, taken: Iterable<string>): string {
  const used = new Set(taken);
  const base = nameOf(wanted) || "upload";
  if (!used.has(base)) return base;
  for (let n = 2; n < 1000; n++) { const next = `${base.slice(0, 36)}-${n}`; if (!used.has(next)) return next; }
  return `${base.slice(0, 30)}-${Date.now() % 100000}`;
}

export const uploads: LibrarySource = {
  id: "uploads",
  label: "Uploaded",
  kinds: () => [...KINDS],
  async list(kind) {
    try {
      return (await listUploads()).filter((u) => u.kind === kind).map((u): LibraryItem => ({ source: "uploads", kind, name: u.name, file: u.file, size: u.size, ref: u.id }));
    } catch (err) {
      log.warn("could not list uploads", { err });   // the other library sources still work
      return [];
    }
  },
  async fetch(item) {
    const meta = await getUploadMeta(item.ref);
    if (!meta || meta.size > MAX_FETCH_BYTES) throw new Error("That file is not available");
    const got = await store().get(`${KEY}${item.ref}`, { type: "arrayBuffer" });
    if (!got) throw new Error("That file is not available");
    return { data: got, mimeType: meta.mimeType };
  },
};
