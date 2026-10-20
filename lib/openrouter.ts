// OpenRouter as the one key for both writing and speech, so the model behind each can be changed without code changes.
//
//   OPENROUTER_API_KEY          the key (enables this provider)
//   OPENROUTER_TEXT_MODEL       default writing model            (default openai/gpt-4o-mini)
//   OPENROUTER_TEXT_MODELS      comma list offered in the UI     (default: a few common chat models)
//   OPENROUTER_SPEECH_MODEL     default speech model             (default google/gemini-3.1-flash-tts-preview)
//   OPENROUTER_SPEECH_MODELS    comma list; an entry may carry its default voice as "slug|Voice"
//   OPENROUTER_VOICE            voice used when the model entry has none
//   OPENROUTER_ALLOW_ANY_MODEL  "true" lets a request name any model slug, not only the listed ones
//   OPENROUTER_BASE_URL         default https://openrouter.ai/api/v1
//   OPENROUTER_REFERER          optional HTTP-Referer header (shows your site in OpenRouter's stats)
//
// NOT VERIFIED against the live service (it could not be reached while this was written): the speech request body
// (`model`, `input`, `voice`, `response_format`, `instructions`) follows OpenRouter's OpenAI-compatible audio endpoint as
// documented in public summaries, and `google/*` models are asked for raw 24 kHz PCM. Errors from OpenRouter are passed
// through to the caller so a wrong voice or model name is visible.

import { cuesFor } from "./cues.js";

const DEFAULT_TEXT_MODELS = ["openai/gpt-4o-mini", "anthropic/claude-3.5-haiku", "meta-llama/llama-3.1-8b-instruct"];
// Providers like Kokoro reject a request with no voice, so every built-in model carries one (the UI can still override it).
const DEFAULT_SPEECH_MODELS = [
  "google/gemini-3.1-flash-tts-preview|Kore",
  "openai/gpt-4o-mini-tts-2025-12-15|alloy",
  "mistralai/voxtral-mini-tts-2603",
  "hexgrad/kokoro-82m|af_heart",
];
export const MODEL_SLUG = /^[A-Za-z0-9][A-Za-z0-9._:/-]{0,99}$/;

export interface SpeechModel {
  id: string;
  voice?: string;
  /** Voices the model accepts, when OpenRouter reports them (its `supported_voices`). */
  voices?: string[];
}

const list = (value: string | undefined): string[] => (value ?? "").split(",").map((s) => s.trim()).filter(Boolean);

export const configured = (): boolean => Boolean(process.env.OPENROUTER_API_KEY);
export const allowAnyModel = (): boolean => process.env.OPENROUTER_ALLOW_ANY_MODEL === "true";

export function textModels(): string[] {
  const fromEnv = list(process.env.OPENROUTER_TEXT_MODELS);
  const all = fromEnv.length ? fromEnv : DEFAULT_TEXT_MODELS;
  const def = process.env.OPENROUTER_TEXT_MODEL?.trim();
  return def && !all.includes(def) ? [def, ...all] : all;
}
export const defaultTextModel = (): string => process.env.OPENROUTER_TEXT_MODEL?.trim() || textModels()[0];

export function speechModels(): SpeechModel[] {
  const fromEnv = list(process.env.OPENROUTER_SPEECH_MODELS);
  const all = (fromEnv.length ? fromEnv : DEFAULT_SPEECH_MODELS).map((entry) => {
    const [id, voice] = entry.split("|").map((s) => s.trim());
    return { id, ...(voice ? { voice } : {}) };
  });
  const def = process.env.OPENROUTER_SPEECH_MODEL?.trim();
  return def && !all.some((m) => m.id === def) ? [{ id: def }, ...all] : all;
}
export const defaultSpeechModel = (): SpeechModel => {
  const def = process.env.OPENROUTER_SPEECH_MODEL?.trim();
  return speechModels().find((m) => m.id === def) ?? speechModels()[0];
};

export function voiceFor(model: SpeechModel, requested?: string): string | undefined {
  return requested?.trim() || model.voice || process.env.OPENROUTER_VOICE?.trim() || model.voices?.[0] || undefined;
}

// Speech models OpenRouter itself lists (GET /models?output_modalities=speech), cached for a few minutes. Best effort: the
// response shape (notably `supported_voices`) is not verified, and any failure just means the built-in list is used alone.
let discovered: { at: number; models: SpeechModel[] } | undefined;
const DISCOVERY_TTL_MS = 10 * 60_000;

export async function discoverSpeechModels(): Promise<SpeechModel[]> {
  if (discovered && Date.now() - discovered.at < DISCOVERY_TTL_MS) return discovered.models;
  let models: SpeechModel[] = [];
  try {
    const res = await fetch(`${base()}/models?output_modalities=speech`, { headers: headers(), signal: AbortSignal.timeout(8_000) });
    if (res.ok) {
      const body = (await res.json()) as { data?: Array<{ id?: unknown; supported_voices?: unknown }> };
      models = (body.data ?? []).flatMap((m) => {
        if (typeof m.id !== "string" || !MODEL_SLUG.test(m.id)) return [];
        const voices = Array.isArray(m.supported_voices) ? m.supported_voices.filter((v): v is string => typeof v === "string" && v.length > 0 && v.length < 80).slice(0, 200) : [];
        return [{ id: m.id, ...(voices.length ? { voices } : {}) }];
      });
    }
  } catch {
    // unreachable or not JSON: fall back to the built-in list
  }
  discovered = { at: Date.now(), models };
  return models;
}

// The configured list plus whatever OpenRouter reports; configured entries keep their own default voice.
export async function allSpeechModels(): Promise<SpeechModel[]> {
  const configuredList = speechModels();
  const extra = await discoverSpeechModels();
  const merged = configuredList.map((m) => {
    const live = extra.find((x) => x.id === m.id);
    return live?.voices ? { ...m, voices: live.voices } : m;
  });
  return [...merged, ...extra.filter((x) => !configuredList.some((m) => m.id === x.id))];
}

// Resolves a requested model against the allowed list; returns an error message when it is not allowed.
export function pickTextModel(requested: string | undefined): { model: string } | { error: string } {
  if (!requested) return { model: defaultTextModel() };
  if (textModels().includes(requested) || (allowAnyModel() && MODEL_SLUG.test(requested))) return { model: requested };
  return { error: `Unknown writing model "${requested.slice(0, 60)}". Allowed: ${textModels().join(", ")}` };
}
export function pickSpeechModel(requested: string | undefined, extra: SpeechModel[] = []): { model: SpeechModel } | { error: string } {
  if (!requested) return { model: defaultSpeechModel() };
  const found = speechModels().find((m) => m.id === requested) ?? extra.find((m) => m.id === requested);
  if (found) return { model: found };
  if (allowAnyModel() && MODEL_SLUG.test(requested)) return { model: { id: requested } };
  return { error: `Unknown speech model "${requested.slice(0, 60)}". Allowed: ${speechModels().map((m) => m.id).join(", ")}` };
}

const base = () => (process.env.OPENROUTER_BASE_URL || "https://openrouter.ai/api/v1").replace(/\/+$/, "");

function headers(): Record<string, string> {
  const key = process.env.OPENROUTER_API_KEY;
  if (!key) throw new Error("OPENROUTER_API_KEY is not set");
  return {
    authorization: `Bearer ${key}`,
    "content-type": "application/json",
    "x-title": process.env.STATION_NAME || "VirtuaHost",
    ...(process.env.OPENROUTER_REFERER ? { "http-referer": process.env.OPENROUTER_REFERER } : {}),
  };
}

async function errorMessage(res: Response): Promise<string> {
  try {
    const body = (await res.json()) as { error?: { message?: string } | string };
    const detail = typeof body.error === "string" ? body.error : body.error?.message;
    if (detail) return `${detail} (OpenRouter ${res.status})`;
  } catch {
    // not JSON
  }
  return `OpenRouter returned ${res.status}`;
}

export async function chat(options: { model: string; system: string; prompt: string; maxTokens?: number }): Promise<string> {
  const res = await fetch(`${base()}/chat/completions`, {
    method: "POST",
    headers: headers(),
    body: JSON.stringify({
      model: options.model,
      max_tokens: options.maxTokens ?? 300,
      messages: [
        { role: "system", content: options.system },
        { role: "user", content: options.prompt },
      ],
    }),
    signal: AbortSignal.timeout(25_000),
  });
  if (!res.ok) throw new Error(await errorMessage(res));
  const body = (await res.json()) as { choices?: Array<{ message?: { content?: string } }> };
  const text = body.choices?.[0]?.message?.content?.trim();
  if (!text) throw new Error(`${options.model} returned no text`);
  return text;
}

export interface OpenRouterSpeech {
  audio: Buffer;
  /** "pcm" must be wrapped in a WAV header; "mp3" is a finished file. */
  format: "pcm" | "mp3";
}

// Google's speech models are asked for raw PCM (their native output); the others for MP3.
export const speechFormat = (model: string): "pcm" | "mp3" => (model.startsWith("google/") ? "pcm" : "mp3");

// How tone reaches the voice depends on the model (lib/cues.ts): Gemini speech models take a natural-language direction in
// the text itself, gpt-4o-mini-tts takes an `instructions` field, and fixed-voice models (Kokoro, Voxtral) take nothing.
export function applyTone(model: string, text: string, tone: string): { input: string; instructions?: string } {
  if (!tone) return { input: text };
  const mode = cuesFor(model).tone;
  if (mode === "text") return { input: `Say in a ${tone} tone: ${text}` };
  if (mode === "instructions") return { input: text, instructions: `Speak in a ${tone} tone.` };
  return { input: text };
}

export async function speech(options: { model: string; voice?: string; text: string; tone?: string }): Promise<OpenRouterSpeech> {
  const format = speechFormat(options.model);
  const { input, instructions } = applyTone(options.model, options.text, options.tone ?? "");
  const res = await fetch(`${base()}/audio/speech`, {
    method: "POST",
    headers: headers(),
    body: JSON.stringify({
      model: options.model,
      input,
      ...(options.voice ? { voice: options.voice } : {}),
      response_format: format,
      ...(instructions ? { instructions } : {}),
    }),
    signal: AbortSignal.timeout(40_000),
  });
  if (!res.ok) throw new Error(await errorMessage(res));
  if ((res.headers.get("content-type") ?? "").includes("json")) throw new Error(await errorMessage(res));
  const audio = Buffer.from(await res.arrayBuffer());
  if (!audio.length) throw new Error(`${options.model} returned no audio`);
  return { audio, format };
}
