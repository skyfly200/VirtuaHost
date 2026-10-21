// One place that decides which service writes and voices a clip.
//
//   PROVIDER            "openrouter" or "gemini" to force one; otherwise OpenRouter when OPENROUTER_API_KEY is set,
//                       else Gemini when GEMINI_API_KEY is set
//
// With OpenRouter the writing model and speech model can be chosen per request (lib/openrouter.ts). Gemini is used
// directly with its fixed models.
import { apiKey, keySource } from "./credentials.js";
import { writeDjLine, describeImage, synthesizeSpeech as geminiSpeech, DEFAULT_VOICE } from "./gemini.js";
import * as openrouter from "./openrouter.js";
import { pcmToWav } from "./wav.js";
import { elevenSpeech, isElevenModel } from "./elevenlabs.js";
import { buildSystemPrompt, type DjFormat } from "./formats.js";

export type ProviderName = "openrouter" | "gemini";

// A key a person or station brought (lib/credentials.ts) is used before the site's, whichever provider it is for; PROVIDER only
// chooses between the site's own keys.
export function activeProvider(): ProviderName | null {
  for (const p of ["openrouter", "gemini"] as const) if (keySource(p) !== "site") return p;
  const forced = process.env.PROVIDER?.trim().toLowerCase();
  if (forced === "openrouter" && apiKey("openrouter")) return "openrouter";
  if (forced === "gemini" && apiKey("gemini")) return "gemini";
  if (forced === "openrouter" || forced === "gemini") return null; // forced to a provider whose key is missing
  if (apiKey("openrouter")) return "openrouter";
  if (apiKey("gemini")) return "gemini";
  return null;
}

export const NO_PROVIDER_MESSAGE =
  "No AI provider is configured: set OPENROUTER_API_KEY (recommended, lets you choose models) or GEMINI_API_KEY in the site's environment variables, then redeploy";

export interface WriteOptions {
  prompt: string;
  provider: ProviderName;
  textModel?: string;
  tone?: string;
  format?: DjFormat;
  /** A persona's character brief, from lib/personas.ts. */
  persona?: string;
  /** Allow profanity and strong language (the model may still refuse; see lib/content.ts). */
  explicit?: boolean;
  /** Instructions about the {{placeholders}} the engine will fill in (lib/drop-template.ts promptHelp). */
  placeholders?: string;
  /** About how long the line should run when spoken. */
  targetSeconds?: number;
  /** The station the line is for (its name and tagline go into the prompt); defaults to STATION_NAME. */
  station?: { name: string; tagline?: string };
}

export async function writeScript(options: WriteOptions): Promise<{ text: string; model: string }> {
  const system = buildSystemPrompt({ station: options.station?.name || process.env.STATION_NAME || "the station", tagline: options.station?.tagline, tone: options.tone, format: options.format, persona: options.persona, explicit: options.explicit, placeholders: options.placeholders, targetSeconds: options.targetSeconds });
  if (options.provider === "openrouter") {
    const model = options.textModel ?? openrouter.defaultTextModel();
    return { text: await openrouter.chat({ model, system, prompt: options.prompt }), model };
  }
  return { text: await writeDjLine(options.prompt, system), model: "gemini-3.6-flash" };
}

// A free-form completion (used to draft personas): the same two providers as writeScript, with a larger reply budget.
export async function complete(options: { system: string; prompt: string; provider: ProviderName; textModel?: string }): Promise<string> {
  if (options.provider === "openrouter") {
    return openrouter.chat({ model: options.textModel ?? openrouter.defaultTextModel(), system: options.system, prompt: options.prompt, maxTokens: 1200 });
  }
  return writeDjLine(options.prompt, options.system);
}

// Looks at one image (a data: URL) and answers the prompt: used to read fliers.
export async function readImage(options: { system: string; prompt: string; image: string; provider: ProviderName; model?: string }): Promise<string> {
  if (options.provider === "openrouter") {
    return openrouter.chatWithImage({ model: options.model ?? openrouter.visionModel(), system: options.system, prompt: options.prompt, image: options.image });
  }
  const m = /^data:(image\/[a-z+]+);base64,(.+)$/i.exec(options.image);
  if (!m) throw new Error("The image must be a base64 data URL");
  return describeImage(options.prompt, options.system, m[1], m[2]);
}

export interface SpeakOptions {
  text: string;
  provider: ProviderName;
  speechModel?: openrouter.SpeechModel;
  voice?: string;
  tone?: string;
}

export interface Spoken {
  audio: Buffer;
  mimeType: string;
  voice: string;
  model: string;
}

export async function speak(options: SpeakOptions): Promise<Spoken> {
  // An ElevenLabs model (voice clones) is spoken by ElevenLabs itself, whichever service writes the words.
  if (isElevenModel(options.speechModel?.id)) {
    const out = await elevenSpeech({ model: options.speechModel!.id, voice: options.voice, text: options.text });
    return { audio: out.audio, mimeType: "audio/mpeg", voice: out.voice, model: options.speechModel!.id };
  }
  if (options.provider === "openrouter") {
    const model = options.speechModel ?? openrouter.defaultSpeechModel();
    const voice = openrouter.voiceFor(model, options.voice);
    const out = await openrouter.speech({ model: model.id, voice, text: options.text, tone: options.tone });
    return out.format === "pcm"
      ? { audio: pcmToWav(out.audio), mimeType: "audio/wav", voice: voice ?? "", model: model.id }
      : { audio: out.audio, mimeType: "audio/mpeg", voice: voice ?? "", model: model.id };
  }
  const voice = options.voice?.trim() || process.env.GEMINI_TTS_VOICE || DEFAULT_VOICE;
  // Gemini speech takes a style direction written into the text itself.
  const input = options.tone ? `Say in a ${options.tone} tone: ${options.text}` : options.text;
  const { pcm } = await geminiSpeech(input, voice);
  return { audio: pcmToWav(pcm), mimeType: "audio/wav", voice, model: "gemini-3.1-flash-tts-preview" };
}
