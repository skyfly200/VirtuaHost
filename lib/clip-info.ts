// Metadata that travels with a clip (a "drop") so other systems can use it: what it is, who it is about, when it expires.
//
// It is kept in three places, all from the same data:
//   * inside the audio: ID3v2.4 tags in an MP3 (title, artist, genre, comment, and TXXX frames "expires", "kind", "event",
//     "virtuahost" holding the full JSON); a RIFF LIST/INFO block plus a "vhmd" JSON chunk in a WAV;
//   * beside the audio: GET /api/clips/:id/meta (and the queue item the station daemon receives) as JSON;
//   * on air: the station daemon passes it to Liquidsoap as annotate metadata and writes a .json file next to the clip.
// See docs/CLIP-METADATA.md for the field list.

export interface EventInfo {
  name: string;
  /** ISO 8601 instants. */
  startsAt?: string;
  endsAt?: string;
  venue?: string;
  address?: string;
  price?: string;
  performers?: string[];
  url?: string;
  phone?: string;
  description?: string;
}

export interface ClipInfo {
  title?: string;
  artist?: string;
  album?: string;
  /** What kind of clip: promo, station-id, link, drop, ... */
  kind?: string;
  tags?: string[];
  persona?: string;
  /** The station profile id this clip is for (lib/station-profile.ts). */
  station?: string;
  /** Where it came from: "flier", "host", "schedule", "generate", ... */
  source?: string;
  event?: EventInfo;
  /** Do not play after this instant (ISO 8601). */
  expiresAt?: string;
  /** Anything else other systems want, up to 12 short text pairs. */
  extra?: Record<string, string>;
}

const text = (v: unknown, max: number): string => (typeof v === "string" ? v.replace(/[\u0000-\u001f\u007f]/g, " ").replace(/\s+/g, " ").trim().slice(0, max) : "");
const iso = (v: unknown): string => {
  const t = typeof v === "string" ? Date.parse(v) : NaN;
  return Number.isFinite(t) ? new Date(t).toISOString() : "";
};
const strings = (v: unknown, count: number, max: number): string[] => (Array.isArray(v) ? v.map((x) => text(x, max)).filter(Boolean).slice(0, count) : []);

export function sanitizeEvent(raw: unknown): EventInfo | undefined {
  if (!raw || typeof raw !== "object") return undefined;
  const r = raw as Record<string, unknown>;
  const name = text(r.name, 120);
  if (!name) return undefined;
  const out: EventInfo = { name };
  for (const [key, max] of [["venue", 120], ["address", 200], ["price", 80], ["url", 200], ["phone", 40], ["description", 400]] as const) {
    const v = text(r[key], max);
    if (v) out[key] = v;
  }
  const startsAt = iso(r.startsAt); if (startsAt) out.startsAt = startsAt;
  const endsAt = iso(r.endsAt); if (endsAt) out.endsAt = endsAt;
  const performers = strings(r.performers, 12, 80); if (performers.length) out.performers = performers;
  return out;
}

// Reduces anything a client sends to known fields of bounded size.
export function sanitizeInfo(raw: unknown): ClipInfo {
  const r = (raw && typeof raw === "object" ? raw : {}) as Record<string, unknown>;
  const info: ClipInfo = {};
  for (const [key, max] of [["title", 160], ["artist", 120], ["album", 120], ["kind", 40], ["persona", 60], ["station", 60], ["source", 40]] as const) {
    const v = text(r[key], max);
    if (v) info[key] = v;
  }
  const tags = strings(r.tags, 12, 30).map((t) => t.toLowerCase()); if (tags.length) info.tags = [...new Set(tags)];
  const event = sanitizeEvent(r.event); if (event) info.event = event;
  const expiresAt = iso(r.expiresAt); if (expiresAt) info.expiresAt = expiresAt;
  if (r.extra && typeof r.extra === "object") {
    const extra: Record<string, string> = {};
    for (const [k, v] of Object.entries(r.extra as Record<string, unknown>).slice(0, 12)) {
      const key = text(k, 30).replace(/[^A-Za-z0-9_.-]/g, "_");
      const val = text(v, 200);
      if (key && val) extra[key] = val;
    }
    if (Object.keys(extra).length) info.extra = extra;
  }
  return info;
}

export const isExpired = (info: { expiresAt?: string } | undefined, now = Date.now()): boolean => {
  const at = info?.expiresAt ? Date.parse(info.expiresAt) : NaN;
  return Number.isFinite(at) && at <= now;
};

// ----- writing tags into the audio -----
const syncsafe = (n: number) => Buffer.from([(n >> 21) & 0x7f, (n >> 14) & 0x7f, (n >> 7) & 0x7f, n & 0x7f]);
const unsyncsafe = (b: Buffer, at: number) => ((b[at] & 0x7f) << 21) | ((b[at + 1] & 0x7f) << 14) | ((b[at + 2] & 0x7f) << 7) | (b[at + 3] & 0x7f);

const frame = (id: string, body: Buffer) => Buffer.concat([Buffer.from(id, "latin1"), syncsafe(body.length), Buffer.from([0, 0]), body]);
const textFrame = (id: string, value: string) => frame(id, Buffer.concat([Buffer.from([3]), Buffer.from(value, "utf8")]));
const txxx = (name: string, value: string) => frame("TXXX", Buffer.concat([Buffer.from([3]), Buffer.from(name, "utf8"), Buffer.from([0]), Buffer.from(value, "utf8")]));
const comm = (value: string) => frame("COMM", Buffer.concat([Buffer.from([3]), Buffer.from("eng", "latin1"), Buffer.from([0]), Buffer.from(value, "utf8")]));

export interface TagContext {
  /** The spoken words, stored as the comment. */
  script?: string;
  createdAt?: string;
  clipId?: string;
  station?: string;
}

// What every system reads from a clip: the fixed fields, with the station name as the artist when none is given.
export const tagFields = (info: ClipInfo, ctx: TagContext) => ({
  title: info.title ?? info.event?.name ?? "",
  artist: info.artist ?? ctx.station ?? "",
  album: info.album ?? "",
  genre: info.kind ?? "",
  comment: (ctx.script ?? "").slice(0, 500),
});

export function writeId3(audio: Buffer, info: ClipInfo, ctx: TagContext): Buffer {
  const f = tagFields(info, ctx);
  const frames: Buffer[] = [];
  if (f.title) frames.push(textFrame("TIT2", f.title));
  if (f.artist) frames.push(textFrame("TPE1", f.artist));
  if (f.album) frames.push(textFrame("TALB", f.album));
  if (f.genre) frames.push(textFrame("TCON", f.genre));
  if (ctx.createdAt) frames.push(textFrame("TDRC", ctx.createdAt.slice(0, 19)));
  if (f.comment) frames.push(comm(f.comment));
  if (info.expiresAt) frames.push(txxx("expires", info.expiresAt));
  if (info.kind) frames.push(txxx("kind", info.kind));
  if (info.persona) frames.push(txxx("persona", info.persona));
  if (info.station) frames.push(txxx("station", info.station));
  if (info.event?.startsAt) frames.push(txxx("event_starts", info.event.startsAt));
  if (info.event?.name) frames.push(txxx("event", info.event.name));
  if (ctx.clipId) frames.push(txxx("clip_id", ctx.clipId));
  frames.push(txxx("virtuahost", JSON.stringify(info)));
  const body = Buffer.concat(frames);
  const header = Buffer.concat([Buffer.from("ID3", "latin1"), Buffer.from([4, 0, 0]), syncsafe(body.length)]);
  return Buffer.concat([header, body, stripId3(audio)]);
}

// The audio without a leading ID3v2 tag, so ours replaces it instead of stacking.
export function stripId3(audio: Buffer): Buffer {
  if (audio.length < 10 || audio.subarray(0, 3).toString("latin1") !== "ID3") return audio;
  const footer = (audio[5] & 0x10) !== 0 ? 10 : 0;
  return audio.subarray(10 + unsyncsafe(audio, 6) + footer);
}

const padEven = (b: Buffer) => (b.length % 2 ? Buffer.concat([b, Buffer.from([0])]) : b);
const chunk = (id: string, data: Buffer) => {
  const size = Buffer.alloc(4); size.writeUInt32LE(data.length);
  return Buffer.concat([Buffer.from(id, "latin1"), size, padEven(data)]);
};
const infoItem = (id: string, value: string) => (value ? chunk(id, Buffer.concat([Buffer.from(value, "utf8"), Buffer.from([0])])) : Buffer.alloc(0));

export function writeWavTags(audio: Buffer, info: ClipInfo, ctx: TagContext): Buffer {
  if (audio.length < 12 || audio.subarray(0, 4).toString("latin1") !== "RIFF" || audio.subarray(8, 12).toString("latin1") !== "WAVE") return audio;
  const f = tagFields(info, ctx);
  const list = chunk("LIST", Buffer.concat([
    Buffer.from("INFO", "latin1"),
    infoItem("INAM", f.title), infoItem("IART", f.artist), infoItem("IPRD", f.album), infoItem("IGNR", f.genre), infoItem("ICMT", f.comment),
    infoItem("ICRD", ctx.createdAt?.slice(0, 10) ?? ""), infoItem("ISFT", "VirtuaHost"),
  ]));
  const meta = chunk("vhmd", Buffer.from(JSON.stringify({ ...info, ...(ctx.clipId ? { clipId: ctx.clipId } : {}) }), "utf8"));
  const out = Buffer.concat([audio, list, meta]);
  out.writeUInt32LE(out.length - 8, 4);
  return out;
}

// The WAV without the tag chunks this file writes (LIST/INFO and vhmd), so new ones replace them instead of piling up.
export function stripWavTags(audio: Buffer): Buffer {
  if (audio.length < 12 || audio.subarray(0, 4).toString("latin1") !== "RIFF" || audio.subarray(8, 12).toString("latin1") !== "WAVE") return audio;
  const kept: Buffer[] = [audio.subarray(0, 12)];
  let at = 12;
  while (at + 8 <= audio.length) {
    const id = audio.subarray(at, at + 4).toString("latin1");
    const size = audio.readUInt32LE(at + 4);
    const end = Math.min(audio.length, at + 8 + size + (size % 2));
    const isInfo = id === "LIST" && audio.subarray(at + 8, at + 12).toString("latin1") === "INFO";
    if (!isInfo && id !== "vhmd") kept.push(audio.subarray(at, end));
    at = end;
  }
  const out = Buffer.concat(kept);
  out.writeUInt32LE(out.length - 8, 4);
  return out;
}

// Replaces the tags in a file that already has some (a clip whose details were edited).
export function retag(audio: Buffer, mimeType: string, info: ClipInfo, ctx: TagContext = {}): Buffer {
  return embedTags(mimeType === "audio/wav" ? stripWavTags(audio) : audio, mimeType, info, ctx);
}

export function embedTags(audio: Buffer, mimeType: string, info: ClipInfo, ctx: TagContext = {}): Buffer {
  if (mimeType === "audio/mpeg") return writeId3(audio, info, ctx);
  if (mimeType === "audio/wav") return writeWavTags(audio, info, ctx);
  return audio;
}

// ----- reading them back (to check a file, or to import a clip someone else tagged) -----
export function readId3(audio: Buffer): { text: Record<string, string>; txxx: Record<string, string> } {
  const out = { text: {} as Record<string, string>, txxx: {} as Record<string, string> };
  if (audio.length < 10 || audio.subarray(0, 3).toString("latin1") !== "ID3") return out;
  const end = 10 + unsyncsafe(audio, 6);
  let at = 10;
  while (at + 10 <= end && audio[at] !== 0) {
    const id = audio.subarray(at, at + 4).toString("latin1");
    const size = unsyncsafe(audio, at + 4);
    const body = audio.subarray(at + 10, at + 10 + size);
    const value = body.subarray(1);
    if (id === "TXXX") { const z = value.indexOf(0); out.txxx[value.subarray(0, z).toString("utf8")] = value.subarray(z + 1).toString("utf8"); }
    else if (id === "COMM") out.text.COMM = value.subarray(4).toString("utf8");
    else if (id.startsWith("T")) out.text[id] = value.toString("utf8");
    at += 10 + size;
  }
  return out;
}

export function readWavInfo(audio: Buffer): { info: Record<string, string>; json?: ClipInfo } {
  const out: { info: Record<string, string>; json?: ClipInfo } = { info: {} };
  let at = 12;
  while (at + 8 <= audio.length) {
    const id = audio.subarray(at, at + 4).toString("latin1");
    const size = audio.readUInt32LE(at + 4);
    const body = audio.subarray(at + 8, at + 8 + size);
    if (id === "LIST" && body.subarray(0, 4).toString("latin1") === "INFO") {
      let p = 4;
      while (p + 8 <= body.length) {
        const sub = body.subarray(p, p + 4).toString("latin1");
        const len = body.readUInt32LE(p + 4);
        out.info[sub] = body.subarray(p + 8, p + 8 + len).toString("utf8").replace(/\0+$/, "");
        p += 8 + len + (len % 2);
      }
    } else if (id === "vhmd") {
      try { out.json = JSON.parse(body.toString("utf8")) as ClipInfo; } catch { /* ignore a damaged chunk */ }
    }
    at += 8 + size + (size % 2);
  }
  return out;
}
