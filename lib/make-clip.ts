// Turns finished text into a saved clip, for the parts of the site that speak on their own (the virtual host, schedules).
// Same rules as POST /api/generate: sound-effect tags are removed (these speech models cannot mix them), delivery tags are
// removed for models that would read them aloud, and tone is sent the way the model takes it.
import { randomUUID } from "node:crypto";
import { embedTags, sanitizeInfo, type ClipInfo } from "./clip-info.js";
import { activeProvider, speak, NO_PROVIDER_MESSAGE } from "./ai.js";
import { cuesFor, stripDeliveryTags, GEMINI_DIRECT_CUES } from "./cues.js";
import { cleanTone } from "./formats.js";
import { defaultSpeechModel, discoverSpeechModels, pickSpeechModel, speechModels, type SpeechModel } from "./openrouter.js";
import { saveClip } from "./store.js";
import type { ClipMetadata } from "./types.js";

const SFX_TAG = /\[\s*(sfx|music)\s*:[^\]]*\]/gi;

export interface MakeClipOptions {
  text: string;
  /** What this clip is, for the library ("host link", "schedule: morning news"). */
  input: string;
  mode?: "say" | "ai";
  tone?: string;
  voice?: string;
  speechModel?: string;
  textModel?: string;
  format?: string;
  /** Metadata for other systems (kind, event, expiresAt, ...). Embedded in the audio and kept with the clip. */
  info?: ClipInfo;
}

export type MadeClip = { ok: true; id: string; scriptText: string; mimeType: string; speechModel: string; voice: string } | { ok: false; status: number; error: string };

export async function makeClip(options: MakeClipOptions): Promise<MadeClip> {
  const provider = activeProvider();
  if (!provider) return { ok: false, status: 503, error: NO_PROVIDER_MESSAGE };

  let speechModel: SpeechModel | undefined;
  if (provider === "openrouter") {
    const wanted = options.speechModel || undefined;
    const listed = !wanted || speechModels().some((m) => m.id === wanted);
    const picked = pickSpeechModel(wanted, listed ? [] : await discoverSpeechModels());
    if ("error" in picked) return { ok: false, status: 400, error: picked.error };
    speechModel = picked.model;
  }

  let scriptText = options.text.replace(SFX_TAG, " ").replace(/\s{2,}/g, " ").trim();
  const cues = provider === "openrouter" ? cuesFor((speechModel ?? defaultSpeechModel()).id) : GEMINI_DIRECT_CUES;
  if (cues.tags === false) scriptText = stripDeliveryTags(scriptText).text;
  if (!scriptText) return { ok: false, status: 400, error: "There is nothing to say once tags are removed" };

  const tone = cleanTone(options.tone);
  let spoken;
  try {
    spoken = await speak({ text: scriptText, provider, speechModel, voice: options.voice || undefined, tone });
  } catch (err) {
    return { ok: false, status: 502, error: `Speech synthesis failed: ${(err as Error).message}` };
  }

  const id = randomUUID();
  const createdAt = new Date().toISOString();
  const info = sanitizeInfo({ title: scriptText.slice(0, 60), source: "make-clip", ...(options.info ?? {}) });
  const audio = embedTags(spoken.audio, spoken.mimeType, info, { script: scriptText, createdAt, clipId: id, station: process.env.STATION_NAME });
  const metadata: ClipMetadata = {
    id, createdAt, mode: options.mode ?? "say", input: options.input.slice(0, 2000), scriptText, voice: spoken.voice,
    mimeType: spoken.mimeType, byteSize: audio.length, provider, speechModel: spoken.model, info,
    ...(options.textModel ? { textModel: options.textModel } : {}), ...(tone ? { tone } : {}), ...(options.format ? { format: options.format } : {}),
  };
  await saveClip(id, audio, metadata);
  return { ok: true, id, scriptText, mimeType: spoken.mimeType, speechModel: spoken.model, voice: spoken.voice };
}
