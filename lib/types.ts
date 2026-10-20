export type GenerateMode = "say" | "ai";

export interface GenerateRequest {
  mode: GenerateMode;
  text?: string;
  prompt?: string;
  /** OpenRouter writing model (mode "ai"). Defaults to OPENROUTER_TEXT_MODEL. */
  textModel?: string;
  /** OpenRouter speech model. Defaults to OPENROUTER_SPEECH_MODEL. */
  speechModel?: string;
  /** A voice the chosen model understands. */
  voice?: string;
  /** How it should sound, for example "warm, slow, a little tired" (up to 100 characters). */
  tone?: string;
  /** One of the script formats from GET /api/options (station-id, song-intro, ...). Shapes AI-written lines. */
  format?: string;
  /** Put the clip on air via the station server. Defaults to STATION_AUTOPLAY. */
  play?: boolean;
  /** Let it interrupt a live DJ. Defaults to STATION_PREEMPT. */
  preempt?: boolean;
  /** Set false to skip sending the clip to the station at all. */
  handoff?: boolean;
  /** Audio treatment or voice changer the station applies on arrival. Defaults to STATION_FX. */
  fx?: string | { preset?: string; pitch?: number; speed?: number; tighten?: boolean };
}

export interface ClipMetadata {
  id: string;
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
}
