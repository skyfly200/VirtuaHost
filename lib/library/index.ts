import { gdrive } from "./gdrive.js";
import { owncloud } from "./owncloud.js";
import { KINDS, type LibraryItem, type LibraryKind, type LibrarySource } from "./types.js";
import { uploads } from "./uploads.js";

// Earlier sources win when two files share a name.
const SOURCES: LibrarySource[] = [owncloud, gdrive, uploads];

export const configuredSources = (): LibrarySource[] => SOURCES.filter((s) => s.kinds().length > 0);
export const libraryFeatures = () => ({
  sources: configuredSources().map((s) => ({ id: s.id, label: s.label, kinds: s.kinds() })),
  sfx: configuredSources().some((s) => s.kinds().includes("sfx")),
  music: configuredSources().some((s) => s.kinds().includes("music")),
  intro: true,
  outro: true,
  uploads: true,
});

// Listings are cached briefly: a mix can need the same list several times, and Drive and OwnCloud are slow compared to us.
const TTL_MS = 60_000;
const cache = new Map<string, { at: number; items: LibraryItem[]; errors: string[] }>();
export const clearLibraryCache = () => cache.clear();   // also called after an upload or delete, so the new file shows at once

export async function listLibrary(kind: LibraryKind): Promise<{ items: LibraryItem[]; errors: string[] }> {
  const hit = cache.get(kind);
  if (hit && Date.now() - hit.at < TTL_MS) return hit;
  const items: LibraryItem[] = [];
  const errors: string[] = [];
  for (const source of configuredSources().filter((s) => s.kinds().includes(kind))) {
    try {
      for (const item of await source.list(kind)) if (!items.some((i) => i.name === item.name)) items.push(item);
    } catch (err) {
      errors.push(`${source.label}: ${(err as Error).message}`);
    }
  }
  items.sort((a, b) => a.name.localeCompare(b.name));
  const entry = { at: Date.now(), items, errors };
  if (!errors.length) cache.set(kind, entry);
  return entry;
}

export async function fetchLibraryItem(sourceId: string, kind: LibraryKind, name: string): Promise<{ data: ArrayBuffer; mimeType: string } | null> {
  if (!KINDS.includes(kind)) return null;
  const source = configuredSources().find((s) => s.id === sourceId);
  if (!source) return null;
  const item = (await listLibrary(kind)).items.find((i) => i.source === sourceId && i.name === name);
  return item ? source.fetch(item) : null;
}
