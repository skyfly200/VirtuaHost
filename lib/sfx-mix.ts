// Sound effects dropped into a spoken line on the server: [sfx:name] tags are turned into real audio and mixed between the speech, so scheduled
// clips, hub drops, scripts and API generations get them too (the Studio mixes the same tags in the browser, public/generate/mixer.js).
//   [sfx:ding]            between the speech before and after the tag      [sfx:whoosh over]    over the start of the speech that follows
//   [sfx:crowd vol=0.5]   quieter (0 to 2)                                 [sfx:beep wait=0.5]  then a pause (0 to 5 seconds)
//   [music:name vol=0.2]  a background bed under the whole speech (0 to 1, default 0.25), fading in and out, looped if short
//   [intro:name vol=1]    a clip played before the speech          [outro:name vol=1]   a clip played after it
// What it can do: effects are synthesised here (no files), and any other name is looked up in the sound library (uploads and cloud folders; WAV files
// only: there is no MP3 decoder on the site, which is why the browser converts uploads to WAV). Beds, intros and outros always come from the library.
// It needs the voice to return WAV (Gemini, and Google speech models on OpenRouter); MP3 voices (ElevenLabs, most OpenRouter models) cannot be
// mixed here, so their tags are removed and the clip says so.
import { parseWav } from "./audio-join.js";
import { pcmToWav } from "./wav.js";
import { isElevenModel } from "./elevenlabs.js";
import { fetchLibraryItem, listLibrary } from "./library/index.js";
import type { Spoken } from "./ai.js";

export const MAX_SFX = 8;
const TAG = /\[\s*(sfx|music|intro|outro)\s*:\s*([a-z0-9_-]{1,40})((?:\s+[a-z]+(?:=[0-9.]+)?){0,4})\s*\]/gi;
const ANY_TAG = /\[\s*(sfx|music|intro|outro)\s*:[^\]]*\]/gi;
const clamp = (n: number, lo: number, hi: number) => Math.min(hi, Math.max(lo, n));

export const hasTags = (text: string): boolean => new RegExp(ANY_TAG.source, "i").test(text);
export const stripTags = (text: string): string => text.replace(ANY_TAG, " ").replace(/\s{2,}/g, " ").trim();

export type Piece = { type: "speech"; text: string } | { type: "sfx"; name: string; vol: number; over: boolean; wait: number }
  | { type: "music"; name: string; vol: number } | { type: "intro"; name: string; vol: number } | { type: "outro"; name: string; vol: number };

/** Text with tags -> speech and effect pieces. A tag with an option it does not know is left out (never read aloud, never an error). */
export function parsePieces(text: string): Piece[] {
  const out: Piece[] = [];
  let last = 0;
  const speech = (s: string) => { const t = stripTags(s); if (t) out.push({ type: "speech", text: t }); };
  for (const m of text.matchAll(TAG)) {
    speech(text.slice(last, m.index));
    last = m.index! + m[0].length;
    const name = m[2].toLowerCase();
    const type = m[1].toLowerCase() as "sfx" | "music" | "intro" | "outro";
    const fx = { type, name, vol: type === "music" ? 0.25 : 1, over: false, wait: 0 };
    let ok = true;
    for (const tok of m[3].trim().split(/\s+/).filter(Boolean)) {
      const [key, val] = tok.toLowerCase().split("=");
      const num = Number(val);
      if (type === "sfx" && key === "over" && val === undefined) fx.over = true;
      else if (key === "vol" && val !== undefined && Number.isFinite(num)) fx.vol = clamp(num, 0, type === "music" ? 1 : 2);
      else if (type === "sfx" && key === "wait" && val !== undefined && Number.isFinite(num)) fx.wait = clamp(num, 0, 5);
      else ok = false;
    }
    if (ok) out.push(type === "sfx" ? (fx as Piece) : { type, name, vol: fx.vol } as Piece);
  }
  speech(text.slice(last));
  return out;
}

// ----- synthesised effects (the same recipes as the browser mixer, at any sample rate; noise is seeded so a clip is repeatable) -----
function rng(seed: number) { let a = seed >>> 0; return () => { a = (a + 0x6d2b79f5) >>> 0; let t = a; t = Math.imul(t ^ (t >>> 15), t | 1); t ^= t + Math.imul(t ^ (t >>> 7), t | 61); return ((t ^ (t >>> 14)) >>> 0) / 4294967296; }; }

export function synthesize(name: string, RATE: number): Float32Array | null {
  const random = rng(name.split("").reduce((n, c) => n * 31 + c.charCodeAt(0), 7));
  const make = (seconds: number, fn: (t: number) => number) => { const o = new Float32Array(Math.round(seconds * RATE)); for (let i = 0; i < o.length; i++) o[i] = fn(i / RATE); return o; };
  const noise = (seconds: number, amp: number, color: "white" | "pink" | "brown" = "white") => {
    let b0 = 0, b1 = 0, b2 = 0, brown = 0;
    return make(seconds, () => {
      const w = random() * 2 - 1;
      if (color === "pink") { b0 = 0.99765 * b0 + w * 0.099046; b1 = 0.963 * b1 + w * 0.2965164; b2 = 0.57 * b2 + w * 1.0526913; return amp * 0.3 * (b0 + b1 + b2 + w * 0.1848); }
      if (color === "brown") { brown = (brown + 0.02 * w) / 1.02; return amp * 3.5 * brown; }
      return amp * w;
    });
  };
  const lowpass = (x: Float32Array, fc: number) => { const a = 1 - Math.exp(-2 * Math.PI * fc / RATE); let y = 0; return x.map((v) => (y += a * (v - y))); };
  const highpass = (x: Float32Array, fc: number) => { const low = lowpass(x, fc); return x.map((v, i) => v - low[i]); };
  type Env = (t: number, len: number) => number;
  const shape = (x: Float32Array, fn: Env) => x.map((v, i) => v * fn(i / RATE, x.length / RATE));
  const fadeIn = (d: number): Env => (t) => Math.min(1, t / d);
  const fadeOut = (d: number): Env => (t, len) => clamp((len - t) / d, 0, 1);
  const both = (a: Env, b: Env): Env => (t, len) => a(t, len) * b(t, len);
  const gain = (x: Float32Array, g: number) => x.map((v) => v * g);
  const sine = (f: number, d: number, amp = 1) => make(d, (t) => amp * Math.sin(2 * Math.PI * f * t));
  const mod = (a: number, b: number) => ((a % b) + b) % b;
  const fx: Record<string, () => Float32Array> = {
    ding: () => gain(shape(sine(1320, 1.2), (t) => Math.exp(-4 * t)), 0.7),
    chime: () => gain(make(1.6, (t) => 0.5 * Math.sin(2 * Math.PI * 880 * t) * Math.exp(-4 * t) + (t >= 0.25 ? 0.4 * Math.sin(2 * Math.PI * 1320 * t) * Math.exp(-3 * t) : 0)), 0.9),
    beep: () => gain(shape(sine(1000, 0.25), both(fadeIn(0.01), fadeOut(0.05))), 0.5),
    buzzer: () => shape(make(0.7, (t) => 0.35 * Math.sin(2 * Math.PI * 120 * t) + 0.2 * Math.sin(2 * Math.PI * 240 * t) + 0.1 * Math.sin(2 * Math.PI * 360 * t)), fadeOut(0.1)),
    whoosh: () => gain(shape(highpass(lowpass(noise(1.4, 0.6), 2500), 200), both(fadeIn(0.6), fadeOut(0.8))), 0.8),
    riser: () => shape(make(2, (t) => 0.4 * Math.sin(2 * Math.PI * (220 + 500 * t) * t)), both(fadeIn(1.2), fadeOut(0.2))),
    fall: () => shape(make(1.5, (t) => 0.4 * Math.sin(2 * Math.PI * (1200 - 500 * t) * t)), fadeOut(0.4)),
    laser: () => shape(make(0.4, (t) => 0.5 * Math.sin(2 * Math.PI * (2000 - 4000 * t) * t)), fadeOut(0.1)),
    static: () => gain(shape(lowpass(highpass(noise(1, 0.5), 2000), Math.min(4000, RATE / 2 - 100)), fadeOut(0.3)), 0.8),
    click: () => shape(highpass(noise(0.06, 0.7), 1000), (t) => Math.exp(-t / 0.015)),
    heartbeat: () => gain(make(1.8, (t) => 0.9 * Math.sin(2 * Math.PI * 60 * t) * (Math.exp(-20 * mod(t, 0.8)) + 0.7 * Math.exp(-20 * mod(t + 0.55, 0.8)))), 0.9),
    alarm: () => shape(make(2, (t) => 0.4 * Math.sin(2 * Math.PI * (900 + (mod(t, 0.5) < 0.25 ? 400 : 0)) * t)), fadeOut(0.2)),
    phone: () => shape(make(2, (t) => (mod(t, 2) < 0.4 ? 0.35 * (Math.sin(2 * Math.PI * 440 * t) + Math.sin(2 * Math.PI * 480 * t)) : 0)), fadeOut(0.1)),
    drumroll: () => gain(shape(lowpass(noise(2, 0.9, "brown"), 900), (t) => fadeIn(1)(t, 0) * (0.55 + 0.45 * Math.sin(2 * Math.PI * 22 * t))), 2),
    crowd: () => gain(shape(lowpass(highpass(noise(3, 0.7, "pink"), 800), Math.min(6000, RATE / 2 - 100)), (t, len) => fadeIn(0.3)(t, len) * fadeOut(1)(t, len) * (0.75 + 0.25 * Math.sin(2 * Math.PI * 9 * t))), 0.9),
  };
  return fx[name] ? fx[name]() : null;
}
export const SFX_NAMES = ["ding", "chime", "beep", "buzzer", "whoosh", "riser", "fall", "laser", "static", "click", "heartbeat", "alarm", "phone", "drumroll", "crowd"];

// ----- samples <-> WAV -----
function wavSamples(audio: Buffer): { samples: Float32Array; rate: number } | null {
  const w = parseWav(audio);
  if (!w || w.bits !== 16) return null;
  const n = Math.floor(w.pcm.length / (2 * w.channels));
  const out = new Float32Array(n);
  for (let i = 0; i < n; i++) out[i] = w.pcm.readInt16LE(i * 2 * w.channels) / 32768;   // first channel
  return { samples: out, rate: w.sampleRate };
}
function resample(x: Float32Array, from: number, to: number): Float32Array {
  if (from === to) return x;
  const out = new Float32Array(Math.round(x.length * to / from));
  for (let i = 0; i < out.length; i++) { const p = i * from / to; const a = Math.floor(p); const f = p - a; out[i] = x[a] * (1 - f) + (x[Math.min(a + 1, x.length - 1)] ?? 0) * f; }
  return out;
}
function toWav(x: Float32Array, rate: number): Buffer {
  const pcm = Buffer.alloc(x.length * 2);
  for (let i = 0; i < x.length; i++) pcm.writeInt16LE(Math.round(clamp(x[i], -1, 1) * 32767), i * 2);
  return pcmToWav(pcm, rate);
}

async function libraryClip(kind: "sfx" | "music" | "intro" | "outro", name: string, rate: number): Promise<Float32Array | null> {
  try {
    const item = (await listLibrary(kind)).items.find((i) => i.name === name);
    if (!item) return null;
    const got = await fetchLibraryItem(item.source, kind, name);
    const w = got && wavSamples(Buffer.from(got.data));
    return w ? resample(w.samples, w.rate, rate) : null;
  } catch { return null; }
}

/** Can this voice's output be mixed here (does it return WAV)? */
export function canMix(provider: string | null, speechModelId?: string): boolean {
  if (provider === "gemini") return true;
  if (provider === "openrouter") return !isElevenModel(speechModelId) && /^google\//.test(speechModelId ?? "");
  return false;
}

export interface Mixed { spoken: Spoken; scriptText: string; applied: string[]; skipped: string[] }

const BED_LEAD = 0.8;   // seconds of music before the first word
const BED_TAIL = 1.5;   // seconds of music after the last word, fading out

/**
 * Speaks `text` with its sound tags mixed in (effects between the words, a background bed under them, an intro before and an outro after).
 * `speakPiece` speaks one stretch of plain words (the caller adds its own voice, tone and cue rules).
 * Returns null when there is nothing to mix (no usable tags) so the caller speaks the text the ordinary way.
 */
export async function speakMixed(text: string, speakPiece: (words: string) => Promise<Spoken>): Promise<Mixed | null> {
  const pieces = parsePieces(text);
  if (!pieces.some((p) => p.type !== "speech") || !pieces.some((p) => p.type === "speech")) return null;
  const skipped: string[] = [];
  // One bed, one intro and one outro per clip: the first of each counts.
  const seen = new Set<string>();
  const keep = pieces.filter((p) => {
    if (p.type === "music" || p.type === "intro" || p.type === "outro") { if (seen.has(p.type)) { skipped.push(`${p.type}:${p.name} (only one ${p.type} per clip)`); return false; } seen.add(p.type); }
    return true;
  });
  const spokenPieces = new Map<number, Spoken>();
  let first: Spoken | undefined;
  for (let i = 0; i < keep.length; i++) {
    const p = keep[i];
    if (p.type !== "speech") continue;
    const s = await speakPiece(p.text);
    if (!parseWav(s.audio)) return null;                     // not WAV after all: the caller falls back to plain speech
    spokenPieces.set(i, s); first ??= s;
  }
  const rate = wavSamples(first!.audio)?.rate;
  if (!rate) return null;

  const applied: string[] = []; let count = 0;
  const timeline: Float32Array[] = []; let over: Float32Array[] = [];
  let bed: { samples: Float32Array; vol: number } | undefined; let intro: Float32Array | undefined; let outro: Float32Array | undefined;
  for (let i = 0; i < keep.length; i++) {
    const p = keep[i];
    if (p.type === "music" || p.type === "intro" || p.type === "outro") {
      const clip = await libraryClip(p.type, p.name, rate);
      if (!clip) { skipped.push(`${p.type}:${p.name} (${p.type} not found, or not a WAV file)`); continue; }
      applied.push(`${p.type}:${p.name}`);
      if (p.type === "music") bed = { samples: clip, vol: p.vol }; else if (p.type === "intro") intro = clip.map((v) => v * p.vol); else outro = clip.map((v) => v * p.vol);
      continue;
    }
    let samples: Float32Array | null;
    if (p.type === "speech") {
      const w = wavSamples(spokenPieces.get(i)!.audio);
      if (!w) return null;
      samples = resample(w.samples, w.rate, rate);
    } else {
      if (++count > MAX_SFX) { skipped.push(`${p.name} (too many effects)`); continue; }
      const raw = synthesize(p.name, rate) ?? await libraryClip("sfx", p.name, rate);
      if (!raw) { skipped.push(`${p.name} (not found)`); continue; }
      samples = raw.map((v) => v * p.vol);
      applied.push(p.name);
      if (p.over && i < keep.length - 1) { over.push(samples); continue; }
      if (p.wait > 0) { timeline.push(samples, new Float32Array(Math.round(p.wait * rate))); continue; }
    }
    if (over.length && p.type === "speech") {
      const len = Math.max(samples.length, ...over.map((o) => o.length));
      const slot = new Float32Array(len);
      for (const src of [samples, ...over]) for (let n = 0; n < src.length; n++) slot[n] += src[n];
      over = []; timeline.push(slot);
    } else timeline.push(samples);
  }
  const body = timeline.reduce((n, t) => n + t.length, 0);
  const lead = bed ? Math.round(BED_LEAD * rate) : 0; const tail = bed ? Math.round(BED_TAIL * rate) : 0;
  const core = new Float32Array(lead + body + tail); let at = lead;
  for (const t of timeline) { core.set(t, at); at += t.length; }
  if (bed && bed.samples.length) {
    const fadeInLen = Math.round(0.5 * rate); const fadeOutLen = Math.max(1, tail);
    for (let n = 0; n < core.length; n++) core[n] += bed.samples[n % bed.samples.length] * bed.vol * Math.min(1, n / fadeInLen) * Math.min(1, (core.length - n) / fadeOutLen);
  }
  const out = new Float32Array((intro?.length ?? 0) + core.length + (outro?.length ?? 0));
  if (intro) out.set(intro, 0);
  out.set(core, intro?.length ?? 0);
  if (outro) out.set(outro, (intro?.length ?? 0) + core.length);
  let peak = 0; for (let n = 0; n < out.length; n++) peak = Math.max(peak, Math.abs(out[n]));
  if (peak > 0.98) for (let n = 0; n < out.length; n++) out[n] *= 0.98 / peak;
  const words = keep.filter((p) => p.type === "speech").map((p) => (p as { text: string }).text).join(" ");
  return { spoken: { ...first!, audio: toWav(out, rate), mimeType: "audio/wav" }, scriptText: words, applied, skipped };
}

/** The audio choices a schedule or request carries: a background bed, an intro and an outro, by library name. */
export interface AudioChoice { bed?: string; bedVol?: number; intro?: string; outro?: string }
const NAME = /^[a-z0-9_-]{1,40}$/;
export function sanitizeAudio(raw: unknown): AudioChoice | undefined {
  if (!raw || typeof raw !== "object") return undefined;
  const r = raw as Record<string, unknown>;
  const pick = (v: unknown) => (typeof v === "string" && NAME.test(v.trim().toLowerCase()) ? v.trim().toLowerCase() : undefined);
  const vol = typeof r.bedVol === "number" && Number.isFinite(r.bedVol) ? clamp(r.bedVol, 0, 1) : undefined;
  const out: AudioChoice = { ...(pick(r.bed) ? { bed: pick(r.bed) } : {}), ...(vol !== undefined && pick(r.bed) ? { bedVol: vol } : {}), ...(pick(r.intro) ? { intro: pick(r.intro) } : {}), ...(pick(r.outro) ? { outro: pick(r.outro) } : {}) };
  return Object.keys(out).length ? out : undefined;
}
/** The text with the tags for those choices around it (what the mixer then acts on). */
export const withAudio = (text: string, audio?: AudioChoice): string => (!audio ? text
  : [audio.intro ? `[intro:${audio.intro}]` : "", audio.bed ? `[music:${audio.bed}${audio.bedVol !== undefined ? ` vol=${audio.bedVol}` : ""}]` : "", text, audio.outro ? `[outro:${audio.outro}]` : ""].filter(Boolean).join(" "));

/** Names the writer may use: the built-in effects plus the library's, when one is connected. */
export async function effectNames(): Promise<string[]> {
  const names = [...SFX_NAMES];
  try { for (const i of (await listLibrary("sfx")).items) if (!names.includes(i.name)) names.push(i.name); } catch { /* the built-in list is enough */ }
  return names.slice(0, 60);
}

/** The writer's instructions when effects are allowed. */
export const sfxHelp = (names: string[]): string =>
  `You may add a few sound effects, at most 2 per spoken line and only where they really fit (a phone ringing, a chime, a whoosh): write each as a tag such as [sfx:chime] inside the spoken text between sentences (after a speaker's \"Name:\" label when there is one), never on a line of its own and never before a label. `
  + `Use only these names: ${names.join(", ")}. Never describe a sound in words and never invent a name. Everything else you write is spoken aloud.`;
