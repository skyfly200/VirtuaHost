// OwnCloud (and Nextcloud: same WebDAV layout) as a sound library.
//
//   OWNCLOUD_URL         https://cloud.example.com   (the server root, no /remote.php)
//   OWNCLOUD_USER        the account name
//   OWNCLOUD_PASSWORD    an app password (Settings > Security), not the login password
//   OWNCLOUD_SFX_PATH    folder of sound effects, for example /VirtuaHost/sfx
//   OWNCLOUD_MUSIC_PATH  folder of music beds, for example /VirtuaHost/music
import { AUDIO_FILE, MAX_FETCH_BYTES, mimeOf, nameOf, type LibraryItem, type LibraryKind, type LibrarySource } from "./types.js";

const env = (name: string) => process.env[name]?.trim() ?? "";
const folderFor = (kind: LibraryKind) => env(kind === "sfx" ? "OWNCLOUD_SFX_PATH" : "OWNCLOUD_MUSIC_PATH");

const root = () => `${env("OWNCLOUD_URL").replace(/\/+$/, "")}/remote.php/dav/files/${encodeURIComponent(env("OWNCLOUD_USER"))}`;
const auth = () => ({ authorization: `Basic ${Buffer.from(`${env("OWNCLOUD_USER")}:${env("OWNCLOUD_PASSWORD")}`).toString("base64")}` });
const encodePath = (path: string) => path.split("/").map((seg) => encodeURIComponent(seg)).join("/");
const folderUrl = (kind: LibraryKind) => `${root()}/${encodePath(folderFor(kind).replace(/^\/+|\/+$/g, ""))}`;

// The few fields we need out of a PROPFIND multistatus reply. Namespace prefixes differ between servers (d:, D:, none).
export function parseListing(xml: string): Array<{ href: string; size?: number; collection: boolean }> {
  const out: Array<{ href: string; size?: number; collection: boolean }> = [];
  for (const block of xml.match(/<(?:\w+:)?response[\s>][\s\S]*?<\/(?:\w+:)?response>/g) ?? []) {
    const href = /<(?:\w+:)?href>([^<]*)<\/(?:\w+:)?href>/.exec(block)?.[1];
    if (!href) continue;
    const len = /<(?:\w+:)?getcontentlength>(\d+)<\/(?:\w+:)?getcontentlength>/.exec(block)?.[1];
    out.push({ href: decodeURIComponent(href.replace(/&amp;/g, "&")), ...(len ? { size: Number(len) } : {}), collection: /<(?:\w+:)?collection\s*\/?>/.test(block) });
  }
  return out;
}

export const owncloud: LibrarySource = {
  id: "owncloud",
  label: "OwnCloud",
  kinds: () => (env("OWNCLOUD_URL") && env("OWNCLOUD_USER") && env("OWNCLOUD_PASSWORD") ? (["sfx", "music"] as const).filter((k) => folderFor(k)) : []),

  async list(kind) {
    const res = await fetch(folderUrl(kind), {
      method: "PROPFIND",
      headers: { ...auth(), depth: "1", "content-type": "application/xml" },
      body: '<?xml version="1.0"?><d:propfind xmlns:d="DAV:"><d:prop><d:getcontentlength/><d:resourcetype/></d:prop></d:propfind>',
      signal: AbortSignal.timeout(15_000),
    });
    if (res.status === 401) throw new Error("OwnCloud rejected the user or app password");
    if (res.status === 404) throw new Error(`OwnCloud folder not found: ${folderFor(kind)}`);
    if (!res.ok && res.status !== 207) throw new Error(`OwnCloud returned ${res.status}`);
    const items: LibraryItem[] = [];
    for (const entry of parseListing(await res.text())) {
      const file = entry.href.replace(/\/+$/, "").split("/").pop() ?? "";
      if (entry.collection || !AUDIO_FILE.test(file) || !nameOf(file)) continue;
      items.push({ source: "owncloud", kind, name: nameOf(file), file, ...(entry.size !== undefined ? { size: entry.size } : {}), ref: file });
    }
    return items;
  },

  async fetch(item) {
    if (item.size !== undefined && item.size > MAX_FETCH_BYTES) throw new Error("File is too large to pass through the site (about 5 MB at most)");
    const res = await fetch(`${folderUrl(item.kind)}/${encodeURIComponent(item.ref)}`, { headers: auth(), signal: AbortSignal.timeout(25_000) });
    if (!res.ok) throw new Error(`OwnCloud returned ${res.status}`);
    const data = await res.arrayBuffer();
    if (data.byteLength > MAX_FETCH_BYTES) throw new Error("File is too large to pass through the site (about 5 MB at most)");
    return { data, mimeType: mimeOf(item.file) };
  },
};
