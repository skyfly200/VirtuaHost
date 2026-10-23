import type { ClipInfo } from "./clip-info.js";

export type GenerateMode = "say" | "ai" | "script";

export interface GenerateRequest {
  mode: GenerateMode;
  text?: string;
  prompt?: string;
  /** OpenRouter writing model (mode "ai"). Defaults to OPENROUTER_TEXT_MODEL. */
  textModel?: string;
  /** OpenRouter speech model. Defaults to OPENROUTER_SPEECH_MODEL. */
  speechModel?: string;
  /** About how long the spoken line should run, in seconds (3 to 90). The writer is told, and {{target_seconds}} / {{target_words}} are filled in. */
  seconds?: number;
  /** ISO time the line will be heard (up to 3 hours ahead): {{time}}, {{daypart}} and {{greeting}} are filled in for that moment instead of now. For lines written a few minutes before they air. */
  at?: string;
  /** mode "ai": allow profanity and strong language in the written line. Pair with a model not marked "filtered" (GET /api/options). */
  explicit?: boolean;
  /** mode "ai": let the writer add [sfx:name] sound effect tags. */
  sfx?: boolean;
  /** A background bed, intro and outro from the sound library, by name: { bed, bedVol, intro, outro }. */
  audio?: { bed?: string; bedVol?: number; intro?: string; outro?: string };
  /** A voice the chosen model understands. */
  voice?: string;
  /** How it should sound, for example "warm, slow, a little tired" (up to 100 characters). */
  tone?: string;
  /** mode "script": a saved script to speak (scriptId), or an inline `cast` (up to 4 speakers) with the `text` ("Name: line" per line). Each speaker uses their persona's voice; the lines are joined into one clip. */
  scriptId?: string;
  cast?: unknown;
  gapSeconds?: number;
  /** One of the script formats from GET /api/options (station-id, song-intro, ...). Shapes AI-written lines. */
  format?: string;
  /** Put the clip on air via the station server. Defaults to STATION_AUTOPLAY. */
  play?: boolean;
  /** Let it interrupt a live DJ. Defaults to STATION_PREEMPT. */
  preempt?: boolean;
  /** Set false to skip sending the clip to the station at all. */
  handoff?: boolean;
  /** A station profile id from GET /api/stations: its name and tagline go into AI-written lines, and its defaults (persona, voice, speech model) apply. */
  station?: string;
  /** A persona id from GET /api/personas: its character shapes AI-written lines and its tone, voice and speech model are the defaults. */
  persona?: string;
  /** mode "ai" only: return the written line and stop, before any speech service is called. The UI shows it for editing first. */
  textOnly?: boolean;
  /** Metadata to attach to the clip (title, kind, event, expiresAt, ...); saved with it and written into the audio file. */
  info?: unknown;
  /** Return the audio without saving it or sending it to the station; the Generate tab uses this to preview a clip. */
  preview?: boolean;
  /** Audio treatment or voice changer the station applies on arrival. Defaults to STATION_FX. */
  fx?: string | { preset?: string; pitch?: number; speed?: number; tighten?: boolean };
}

export interface ClipMetadata {
  id: string;
  /** Who made it (a username). Unset for the station's own clips (made by an admin or the access key), which everyone can see. */
  ownerId?: string;
  createdAt: string;
  mode: GenerateMode;
  input: string;
  scriptText: string;
  voice: string;
  mimeType: string;
  byteSize: number;
  provider?: string;
  textModel?: string;
  speechModel?: string;
  tone?: string;
  format?: string;
  /** Sound effects mixed in before the clip was saved (Generate tab). */
  effects?: string[];
  /** What other systems may want to know about the clip; also written into the audio file (lib/clip-info.ts). */
  info?: ClipInfo;
}
