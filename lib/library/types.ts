// A sound library kept in someone's cloud storage: sound effects and music beds the DJ tools can use by name.
// Each source lists the audio files in its configured folder for a kind and can fetch one. Only listed files can be fetched
// (the HTTP layer never builds a provider path from request input).

export type LibraryKind = "sfx" | "music";
export const KINDS: readonly LibraryKind[] = ["sfx", "music"];

export interface LibraryItem {
  source: string;
  kind: LibraryKind;
  /** Lowercase name used in tags, from the file name: "Big Ding.mp3" -> "big-ding". */
  name: string;
  file: string;
  size?: number;
  /** Provider reference (a path or file id), never sent to the browser. */
  ref: string;
}

export interface LibrarySource {
  id: string;
  label: string;
  /** Kinds this source has a folder configured for. */
  kinds(): LibraryKind[];
  list(kind: LibraryKind): Promise<LibraryItem[]>;
  fetch(item: LibraryItem): Promise<{ data: ArrayBuffer; mimeType: string }>;
}

export const AUDIO_FILE = /\.(mp3|wav|ogg|m4a|aac|flac)$/i;
export const nameOf = (file: string): string => file.replace(/\.[^.]+$/, "").toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "").slice(0, 40);

export const MIME_BY_EXT: Record<string, string> = { mp3: "audio/mpeg", wav: "audio/wav", ogg: "audio/ogg", m4a: "audio/mp4", aac: "audio/aac", flac: "audio/flac" };
export const mimeOf = (file: string): string => MIME_BY_EXT[file.split(".").pop()?.toLowerCase() ?? ""] ?? "application/octet-stream";

/** Largest file the site will pass through (Netlify function responses are limited to about 6 MB). */
export const MAX_FETCH_BYTES = 5_500_000;
