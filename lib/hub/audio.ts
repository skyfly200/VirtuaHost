import { getStore } from "@netlify/blobs";

// Finished clips by content hash. The hub's jit.js wants a synchronous store (has/get/put/remove), so a run works on this in-memory view:
// it knows which hashes already exist (listed once), keeps new audio in memory, and commit() writes the new files and removals to the
// real store afterwards. Commit BEFORE saving the hub's records, so a queue row never points at audio that is not there yet.
export interface AudioBlobs {
  list(): Promise<string[]>;
  set(hash: string, bytes: Buffer, mime: string): Promise<void>;
  delete(hash: string): Promise<void>;
}

export function netlifyAudioBlobs(): AudioBlobs {
  const store = () => getStore({ name: "hub-audio", consistency: "strong" });
  return {
    list: async () => (await store().list()).blobs.map((b) => b.key),
    set: async (hash, bytes, mime) => {
      await store().set(hash, new Uint8Array(bytes).buffer, { metadata: { mime } });
    },
    delete: async (hash) => {
      await store().delete(hash);
    },
  };
}

export interface RunAudio {
  has(hash: string): boolean;
  get(hash: string): { buffer: Buffer; mime: string } | null;
  put(hash: string, buffer: Buffer, mime?: string): void;
  remove(hash: string): void;
  list(): string[];
  commit(): Promise<{ stored: number; removed: number }>;
}

const HASH = /^[0-9a-f]{64}$/;

export async function openAudio(blobs: AudioBlobs): Promise<RunAudio> {
  const existing = new Set(await blobs.list());
  const added = new Map<string, { buffer: Buffer; mime: string }>();
  const removed = new Set<string>();
  return {
    has: (hash) => HASH.test(hash) && !removed.has(hash) && (existing.has(hash) || added.has(hash)),
    get: (hash) => (HASH.test(hash) && !removed.has(hash) ? added.get(hash) ?? null : null),
    put(hash, buffer, mime = "audio/mpeg") {
      if (!HASH.test(hash)) throw new Error("bad audio hash");
      removed.delete(hash);
      if (!existing.has(hash)) added.set(hash, { buffer, mime });
    },
    remove(hash) {
      if (!HASH.test(hash)) return;
      added.delete(hash);
      if (existing.has(hash)) removed.add(hash);
    },
    list: () => [...new Set([...existing, ...added.keys()])].filter((h) => !removed.has(h)),
    async commit() {
      for (const [hash, a] of added) await blobs.set(hash, a.buffer, a.mime);
      for (const hash of removed) await blobs.delete(hash);
      return { stored: added.size, removed: removed.size };
    },
  };
}
