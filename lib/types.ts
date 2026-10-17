export type GenerateMode = "say" | "ai";

export interface GenerateRequest {
  mode: GenerateMode;
  text?: string;
  prompt?: string;
  /** Put the clip on air via the station server. Defaults to STATION_AUTOPLAY. */
  play?: boolean;
  /** Let it interrupt a live DJ. Defaults to STATION_PREEMPT. */
  preempt?: boolean;
  /** Set false to skip sending the clip to the station at all. */
  handoff?: boolean;
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
}
