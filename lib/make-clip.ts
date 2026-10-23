// Turns finished text into a saved clip, for the parts of the site that speak on their own (the virtual host, schedules).
// Same rules as POST /api/generate: sound-effect tags are removed (these speech models cannot mix them), delivery tags are
// removed for models that would read them aloud, and tone is sent the way the model takes it.
import { randomUUID } from "node:crypto";
import { embedTags, sanitizeInfo, type ClipInfo } from "./clip-info.js";
import { activeProvider, speak, NO_PROVIDER_MESSAGE, type Spoken } from "./ai.js";
import { cuesFor, stripDeliveryTags, GEMINI_DIRECT_CUES } from "./cues.js";
import { cleanTone } from "./formats.js";
import { defaultSpeechModel, discoverSpeechModels, pickSpeechModel, speechModels, type SpeechModel } from "./openrouter.js";
import { saveClip } from "./store.js";
import { createLogger } from "./log.js";
import { elevenConfigured, isElevenModel } from "./elevenlabs.js";
import { renderTemplate, type TemplateContext } from "./drop-template.js";
import { canMix, hasTags, speakMixed } from "./sfx-mix.js";
import type { ClipMetadata } from "./types.js";

const log = createLogger("make-clip");

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
  /** The person this clip belongs to (a username); leave out for the station's own. */
  ownerId?: string;
  /** Fill in {{placeholders}} (time, weather, station, DJ, song...) before speaking. Without it, placeholders are still removed. */
  templateContext?: TemplateContext;
}

export type MadeClip = { ok: true; id: string; scriptText: string; mimeType: string; speechModel: string; voice: string } | { ok: false; status: number; error: string };

/** `sfx` is present when the text had effect tags: which were mixed in and which were not. */
export interface SfxReport { applied: string[]; skipped: string[] }
export type Spoke = { ok: true; spoken: Spoken; scriptText: string; provider: string; tone: string; sfx?: SfxReport } | { ok: false; status: number; error: string };

/** The speaking half of makeClip: placeholders filled, tags removed as the model needs, then spoken. Nothing is saved. Used for each line of a script too. */
export async function speakText(options: Pick<MakeClipOptions, "text" | "tone" | "voice" | "speechModel" | "templateContext">): Promise<Spoke> {
  const provider = activeProvider();
  if (!provider) return { ok: false, status: 503, error: NO_PROVIDER_MESSAGE };

  let speechModel: SpeechModel | undefined;
  if (provider === "openrouter") {
    const wanted = options.speechModel || undefined;
    const listed = !wanted || speechModels().some((m) => m.id === wanted);
    const picked = pickSpeechModel(wanted, listed ? [] : await discoverSpeechModels());
    if ("error" in picked) return { ok: false, status: 400, error: picked.error };
    speechModel = picked.model;
  } else if (isElevenModel(options.speechModel) && elevenConfigured()) {
    speechModel = { id: options.speechModel! };
  }

  const filled = await renderTemplate(options.text, options.templateContext ?? {});
  if (filled.missing.length) log.warn("template values missing", { missing: filled.missing });
  let scriptText = filled.text.replace(SFX_TAG, " ").replace(/\s{2,}/g, " ").trim();
  const cues = provider === "openrouter" || isElevenModel(speechModel?.id) ? cuesFor((speechModel ?? defaultSpeechModel()).id) : GEMINI_DIRECT_CUES;
  if (cues.tags === false) scriptText = stripDeliveryTags(scriptText).text;
  if (!scriptText) return { ok: false, status: 400, error: "There is nothing to say once tags are removed" };

  const tone = cleanTone(options.tone);
  // Sound effects: when the voice returns WAV, each stretch of words is spoken on its own and the effects are mixed between them.
  let sfx: SfxReport | undefined;
  if (hasTags(filled.text)) {
    if (canMix(provider, speechModel?.id)) {
      try {
        const mixed = await speakMixed(filled.text, (words) => speak({ text: cues.tags === false ? stripDeliveryTags(words).text : words, provider, speechModel, voice: options.voice || undefined, tone }));
        if (mixed) return { ok: true, spoken: mixed.spoken, scriptText: mixed.scriptText, provider, tone, sfx: { applied: mixed.applied, skipped: mixed.skipped } };
      } catch (err) {
        log.error("speech synthesis failed", { err });
        return { ok: false, status: 502, error: `Speech synthesis failed: ${(err as Error).message}` };
      }
    }
    sfx = { applied: [], skipped: ["this voice does not return WAV audio, so effects cannot be mixed here"] };
  }
  try {
    return { ok: true, spoken: await speak({ text: scriptText, provider, speechModel, voice: options.voice || undefined, tone }), scriptText, provider, tone, ...(sfx ? { sfx } : {}) };
  } catch (err) {
    log.error("speech synthesis failed", { err });
    return { ok: false, status: 502, error: `Speech synthesis failed: ${(err as Error).message}` };
  }
}

export async function makeClip(options: MakeClipOptions): Promise<MadeClip> {
  const said = await speakText(options);
  if (!said.ok) return said;
  const { spoken, scriptText, provider, tone } = said;
  const id = randomUUID();
  const createdAt = new Date().toISOString();
  const info = sanitizeInfo({ title: scriptText.slice(0, 60), source: "make-clip", ...(options.info ?? {}) });
  const audio = embedTags(spoken.audio, spoken.mimeType, info, { script: scriptText, createdAt, clipId: id, station: process.env.STATION_NAME });
  const metadata: ClipMetadata = {
    id, ...(options.ownerId ? { ownerId: options.ownerId } : {}), createdAt, mode: options.mode ?? "say", input: options.input.slice(0, 2000), scriptText, voice: spoken.voice,
    mimeType: spoken.mimeType, byteSize: audio.length, provider, speechModel: spoken.model, info,
    ...(options.textModel ? { textModel: options.textModel } : {}), ...(tone ? { tone } : {}), ...(options.format ? { format: options.format } : {}),
  };
  await saveClip(id, audio, metadata);
  return { ok: true, id, scriptText, mimeType: spoken.mimeType, speechModel: spoken.model, voice: spoken.voice };
}
