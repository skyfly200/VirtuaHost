// Joins separately spoken lines into one clip. Only formats that can be joined without re-encoding:
//   WAV (same format)  -> samples are joined, with real silence between lines
//   MP3 (any bitrate)  -> frames are joined (ID3 tags in later parts are dropped); no gap can be added without an encoder
// Mixed formats (for example Gemini WAV with an MP3 voice) cannot be joined here: the Voice Lab joins those in the browser.
import { pcmToWav } from "./wav.js";

export interface Part { audio: Buffer; mimeType: string }
export interface Joined { audio: Buffer; mimeType: string; gapApplied: boolean }

interface Wav { sampleRate: number; channels: number; bits: number; pcm: Buffer }

export function parseWav(buf: Buffer): Wav | null {
  if (buf.length < 44 || buf.toString("latin1", 0, 4) !== "RIFF" || buf.toString("latin1", 8, 12) !== "WAVE") return null;
  let pos = 12; let fmt: { channels: number; sampleRate: number; bits: number } | null = null;
  while (pos + 8 <= buf.length) {
    const id = buf.toString("latin1", pos, pos + 4); const size = buf.readUInt32LE(pos + 4); const body = pos + 8;
    if (id === "fmt " && size >= 16 && buf.readUInt16LE(body) === 1) fmt = { channels: buf.readUInt16LE(body + 2), sampleRate: buf.readUInt32LE(body + 4), bits: buf.readUInt16LE(body + 14) };
    if (id === "data") return fmt ? { ...fmt, pcm: buf.subarray(body, Math.min(buf.length, body + size)) } : null;
    pos = body + size + (size % 2);
  }
  return null;
}

// An ID3v2 tag at the start of an MP3, so it is not repeated mid-stream.
function stripId3(buf: Buffer): Buffer {
  if (buf.length > 10 && buf.toString("latin1", 0, 3) === "ID3") {
    const size = ((buf[6] & 0x7f) << 21) | ((buf[7] & 0x7f) << 14) | ((buf[8] & 0x7f) << 7) | (buf[9] & 0x7f);
    return buf.subarray(10 + size);
  }
  return buf;
}
const isWav = (p: Part) => /wav/.test(p.mimeType) || p.audio.toString("latin1", 0, 4) === "RIFF";
const isMp3 = (p: Part) => /mpeg|mp3/.test(p.mimeType) || p.audio.toString("latin1", 0, 3) === "ID3" || (p.audio[0] === 0xff && (p.audio[1] & 0xe0) === 0xe0);

export function joinAudio(parts: Part[], gapSeconds = 0): Joined {
  if (!parts.length) throw new Error("There is no audio to join");
  if (parts.length === 1) return { audio: parts[0].audio, mimeType: parts[0].mimeType, gapApplied: false };
  if (parts.every(isWav)) {
    const wavs = parts.map((p) => parseWav(p.audio));
    if (wavs.some((w) => !w)) throw new Error("One of the spoken lines is not a WAV file this site can read");
    const first = wavs[0]!;
    if (wavs.some((w) => w!.sampleRate !== first.sampleRate || w!.channels !== first.channels || w!.bits !== first.bits)) throw new Error("The voices returned WAV audio in different formats (sample rates), so the lines cannot be joined here");
    if (first.bits !== 16) throw new Error("Only 16-bit WAV audio can be joined here");
    const silence = Buffer.alloc(Math.round(gapSeconds * first.sampleRate) * first.channels * 2);
    const chunks: Buffer[] = [];
    wavs.forEach((w, i) => { if (i && silence.length) chunks.push(silence); chunks.push(w!.pcm); });
    const out = pcmToWav(Buffer.concat(chunks), first.sampleRate);
    if (first.channels !== 1) { out.writeUInt16LE(first.channels, 22); out.writeUInt32LE(first.sampleRate * first.channels * 2, 28); out.writeUInt16LE(first.channels * 2, 32); }
    return { audio: out, mimeType: "audio/wav", gapApplied: silence.length > 0 };
  }
  if (parts.every(isMp3)) return { audio: Buffer.concat(parts.map((p, i) => (i ? stripId3(p.audio) : p.audio))), mimeType: "audio/mpeg", gapApplied: false };
  throw new Error("The voices returned different audio formats (for example WAV and MP3), so the lines cannot be joined here. Pick voices from the same provider, or join them in the Voice Lab");
}
