// The virtual host: between songs it says a short link about the track that just played ("That was X with Y").
// It replicates krap-station/host/virtual_host.py and chips-voice's server-side host, split in two:
//   * this site writes and voices each link (a persona's lines or the writing model) and keeps the settings;
//   * the station daemon (station-daemon/host.mjs) watches what Icecast is playing, asks for the link, and puts it on air.

export const FX_PRESETS = ["none", "underground", "hull", "telephone", "radio", "walkie", "megaphone", "robot", "whisper", "cave", "underwater", "chorus", "chipmunk", "deep", "alien", "demon"] as const;

export interface HostConfig {
  enabled: boolean;
  /** A link after every Nth track. */
  every: number;
  /** Never more often than this many seconds. */
  minGapSeconds: number;
  /** "template" picks from the persona's example lines; "llm" asks the writing model, falling back to a template. */
  lines: "template" | "llm";
  personaId: string;
  /** Override the persona's own delivery. */
  voice: string;
  speechModel: string;
  /** The writing model for AI-written links (blank: the persona's, then the station's, then the site's default). */
  textModel: string;
  tone: string;
  /** Audio treatment the station applies (a preset name from FX_PRESETS, or empty for none). */
  fx: string;
  /** May cut in over a live DJ. Normally the host stays quiet while someone is live. */
  preempt: boolean;
  /** Artists (case-insensitive) that are spots or relays: nothing is said over or about them. */
  skipArtists: string[];
}

export const DEFAULT_SKIP = ["", "syndicate empire radio", "way high radio", "k.r.a.p. relay"];

export const HOST_DEFAULTS: HostConfig = {
  enabled: false, every: 1, minGapSeconds: 45, lines: "template", personaId: "chip", voice: "", speechModel: "", textModel: "", tone: "", fx: "", preempt: false, skipArtists: DEFAULT_SKIP,
};

export const TEMPLATES = [
  "That was {artist} with {title}. You're listening to {station}.",
  "{artist}, {title}. Mm. Stay right here on {station}.",
  "That was {title} by {artist}. More coming up, right here on {station}.",
  "{title}, from {artist}. This is {station}.",
];
export const TIME_LINES: Record<string, string> = {
  morning: " Good morning, wherever you are.",
  afternoon: "",
  evening: " Hope your evening's treating you well.",
  night: " Late night, just us and the music.",
};
export const daypart = (hour: number): string => (hour >= 5 && hour < 12 ? "morning" : hour < 17 ? "afternoon" : hour < 22 ? "evening" : "night");

const clamp = (n: number, lo: number, hi: number) => Math.min(hi, Math.max(lo, n));
const text = (value: unknown, max: number) => (typeof value === "string" ? value.trim().slice(0, max) : undefined);

// Merges a partial update into a config, ignoring anything of the wrong type or out of range.
export function applyHostPatch(current: HostConfig, patch: unknown): HostConfig {
  const p = (patch && typeof patch === "object" ? patch : {}) as Record<string, unknown>;
  const next = { ...current };
  if (typeof p.enabled === "boolean") next.enabled = p.enabled;
  if (p.every !== undefined) next.every = clamp(Math.floor(Number(p.every)) || 1, 1, 50);
  if (p.minGapSeconds !== undefined) next.minGapSeconds = clamp(Number(p.minGapSeconds) || 0, 0, 3600);
  if (p.lines === "template" || p.lines === "llm") next.lines = p.lines;
  for (const [key, max] of [["personaId", 60], ["voice", 60], ["speechModel", 100], ["textModel", 100], ["tone", 100]] as const) {
    const v = text(p[key], max);
    if (v !== undefined) next[key] = v;
  }
  const fx = text(p.fx, 40);
  if (fx !== undefined) {
    if (fx && !(FX_PRESETS as readonly string[]).includes(fx)) throw new Error(`unknown effect "${fx}" (known: ${FX_PRESETS.join(", ")})`);
    next.fx = fx === "none" ? "" : fx;
  }
  if (typeof p.preempt === "boolean") next.preempt = p.preempt;
  if (Array.isArray(p.skipArtists)) next.skipArtists = p.skipArtists.map((a) => String(a).trim().slice(0, 100)).slice(0, 100);
  return next;
}

// A station's own profile fills in the host's starting settings (its persona, voice, treatment and skip list); anything saved on top wins.
export function hostDefaultsFor(station: { defaultPersonaId?: string; defaultVoice?: string; defaultSpeechModel?: string; defaultTextModel?: string; defaultFx?: string; skipArtists?: string[]; preempt?: boolean } | null | undefined): Partial<HostConfig> {
  if (!station) return {};
  return {
    ...(station.defaultPersonaId ? { personaId: station.defaultPersonaId } : {}),
    ...(station.defaultVoice ? { voice: station.defaultVoice } : {}),
    ...(station.defaultSpeechModel ? { speechModel: station.defaultSpeechModel } : {}),
    ...(station.defaultTextModel ? { textModel: station.defaultTextModel } : {}),
    ...(station.defaultFx ? { fx: station.defaultFx } : {}),
    ...(station.skipArtists && station.skipArtists.length ? { skipArtists: station.skipArtists } : {}),
    ...(typeof station.preempt === "boolean" ? { preempt: station.preempt } : {}),
  };
}

export const isSkipped = (artist: string, title: string, config: HostConfig): boolean =>
  !title || config.skipArtists.map((a) => a.toLowerCase()).includes(artist.toLowerCase());

const fill = (line: string, vars: Record<string, string>) => line.replace(/\{(artist|title|station)\}/g, (_, k: string) => vars[k]);

export interface LineContext {
  artist: string;
  title: string;
  station: string;
  hour: number;
  rng?: () => number;
  /** The persona's example lines, when it has any. */
  templates?: string[];
  /** The persona's time-of-day lines; the defaults are used when it has none. */
  timeLines?: Partial<Record<string, string>>;
}

// A link from the example lines; 30% of the time a time-of-day line is added, like the original script.
export function templateLine(ctx: LineContext): string {
  const rng = ctx.rng ?? Math.random;
  const pool = ctx.templates && ctx.templates.length ? ctx.templates : TEMPLATES;
  let line = fill(pool[Math.floor(rng() * pool.length)], { artist: ctx.artist, title: ctx.title, station: ctx.station });
  if (rng() < 0.3) line += fill(ctx.timeLines?.[daypart(ctx.hour)] ?? TIME_LINES[daypart(ctx.hour)] ?? "", { artist: ctx.artist, title: ctx.title, station: ctx.station });
  return line;
}

export const LINK_SYSTEM_PROMPT = (station: string, persona: string | undefined): string =>
  `You are the on-air host of ${station}, between songs. Write ONE short link (one or two sentences, under 220 characters) about the song that just played, ` +
  "to be read aloud. Plain text only: no quotation marks, no emoji, no hashtags, no stage directions. You may use a single audio tag such as [chuckles] or [softly]. " +
  "Mention the artist and title." + (persona ? ` Your character: ${persona}` : "");

export const linkPrompt = (artist: string, title: string, hour: number): string => `That song was "${title}" by ${artist}. It is ${daypart(hour)}.`;
export const cleanLink = (raw: string): string => raw.replace(/\s+/g, " ").trim().slice(0, 400);

// The daemon's status report, reduced to known fields of bounded size.
export function sanitizeStatus(raw: unknown): { current?: { artist: string; title: string }; ready?: { text: string; about: string; source: string }; last?: { at: string; text: string; about: string; played: boolean; reason?: string }; counters?: { prepared: number; played: number; skipped: number; failed: number }; error?: string } {
  const r = (raw && typeof raw === "object" ? raw : {}) as Record<string, any>; // eslint-disable-line @typescript-eslint/no-explicit-any
  const str = (v: unknown, max = 300) => (typeof v === "string" ? v.slice(0, max) : "");
  const num = (v: unknown) => (Number.isFinite(Number(v)) ? Math.max(0, Math.floor(Number(v))) : 0);
  return {
    ...(r.current ? { current: { artist: str(r.current.artist, 200), title: str(r.current.title, 200) } } : {}),
    ...(r.ready ? { ready: { text: str(r.ready.text, 400), about: str(r.ready.about, 300), source: str(r.ready.source, 20) } } : {}),
    ...(r.last ? { last: { at: str(r.last.at, 40), text: str(r.last.text, 400), about: str(r.last.about, 300), played: r.last.played === true, ...(r.last.reason ? { reason: str(r.last.reason, 100) } : {}) } } : {}),
    ...(r.counters ? { counters: { prepared: num(r.counters.prepared), played: num(r.counters.played), skipped: num(r.counters.skipped), failed: num(r.counters.failed) } } : {}),
    ...(r.error ? { error: str(r.error, 300) } : {}),
  };
}
