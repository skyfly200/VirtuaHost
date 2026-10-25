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

import { apiKey, currentScope, keySource } from "./credentials.js";
import { ELEVEN_MODELS, ELEVEN_PREFIX, isElevenModel, listVoices } from "./elevenlabs.js";

import { cuesFor } from "./cues.js";
import { RETIRED_MODELS } from "./model-health.js";

// Candidates, cheapest-first. When OpenRouter's model list can be read (allTextModels), any of these it does not list is left out, so a
// slug that has been renamed or retired never shows up as a choice. Use OPENROUTER_TEXT_MODELS to pin your own list.
const DEFAULT_TEXT_MODELS = [
  "openai/gpt-4o-mini",
  "anthropic/claude-haiku-5.5",
  "google/gemini-3.6-flash",
  "deepseek/deepseek-chat",
  "meta-llama/llama-3.1-8b-instruct",
];
// Providers like Kokoro reject a request with no voice, so every built-in model carries one (the UI can still override it).
// Only models known to exist are built in. Everything else OpenRouter offers is found by asking it (allSpeechModels below), and when
// that list can be read, a built-in model that is not on it is hidden instead of failing later with "does not exist".
// The first entry is the default, so the cheapest comes first. Kokoro is an open model that costs a fraction of the others but does not
// perform delivery tags or tone (lib/cues.ts); pick the Google model for those.
const DEFAULT_SPEECH_MODELS = [
  "hexgrad/kokoro-82m|af_heart",
  "google/gemini-3.1-flash-tts-preview|Kore",
];
export const MODEL_SLUG = /^[A-Za-z0-9][A-Za-z0-9._:/-]{0,99}$/;

export interface SpeechModel {
  id: string;
  voice?: string;
  /** Voices the model accepts, when OpenRouter reports them (its `supported_voices`). */
  voices?: string[];
}

const list = (value: string | undefined): string[] => (value ?? "").split(",").map((s) => s.trim()).filter(Boolean);

export const configured = (): boolean => Boolean(apiKey("openrouter"));
// Any model slug is allowed with OPENROUTER_ALLOW_ANY_MODEL, or when the person is paying with their own key, unless the station limits the models.
export const allowAnyModel = (): boolean => {
  const scope = currentScope();
  if (scope?.textModels || scope?.speechModels) return false;
  return process.env.OPENROUTER_ALLOW_ANY_MODEL === "true" || keySource("openrouter") === "user";
};

// Retired slugs (lib/model-health.ts) are never offered, even if an env list or a station's list still names them.
export function textModels(): string[] {
  const live = (models: string[]) => models.filter((m) => !RETIRED_MODELS[m]);
  const limited = currentScope()?.textModels;
  if (limited) return live(limited);
  const fromEnv = list(process.env.OPENROUTER_TEXT_MODELS);
  const all = live(fromEnv.length ? fromEnv : DEFAULT_TEXT_MODELS);
  const def = process.env.OPENROUTER_TEXT_MODEL?.trim();
  return def && !RETIRED_MODELS[def] && !all.includes(def) ? [def, ...all] : all;
}
export const defaultTextModel = (): string => {
  const def = process.env.OPENROUTER_TEXT_MODEL?.trim();
  return def && textModels().includes(def) ? def : textModels()[0];
};

// ElevenLabs models are offered whenever an ElevenLabs key is in scope (the site's, the station's or the person's).
const elevenModels = (): SpeechModel[] => (apiKey("elevenlabs") ? ELEVEN_MODELS.map((m) => ({ id: `${ELEVEN_PREFIX}${m}` })) : []);

export function speechModels(): SpeechModel[] {
  const limited = currentScope()?.speechModels;
  if (limited) return limited.map((entry) => { const [id, voice] = entry.split("|").map((s) => s.trim()); return { id, ...(voice ? { voice } : {}) }; });
  const fromEnv = list(process.env.OPENROUTER_SPEECH_MODELS);
  const all = (fromEnv.length ? fromEnv : DEFAULT_SPEECH_MODELS).map((entry) => {
    const [id, voice] = entry.split("|").map((s) => s.trim());
    return { id, ...(voice ? { voice } : {}) };
  });
  const withEleven = [...all, ...elevenModels().filter((e) => !all.some((m) => m.id === e.id))];
  const def = process.env.OPENROUTER_SPEECH_MODEL?.trim();
  return def && !withEleven.some((m) => m.id === def) ? [{ id: def }, ...withEleven] : withEleven;
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
  const shared = keySource("openrouter") === "site";                         // a person's or station's key may see other models: do not share the cache
  if (shared && discovered && Date.now() - discovered.at < DISCOVERY_TTL_MS) return discovered.models;
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
  if (shared) discovered = { at: Date.now(), models };
  return models;
}

// The configured list plus whatever OpenRouter reports; configured entries keep their own default voice.
// ElevenLabs entries list the voices on the account (clones first), so the voice box can suggest them by name.
async function withElevenVoices(models: SpeechModel[]): Promise<SpeechModel[]> {
  if (!models.some((m) => isElevenModel(m.id))) return models;
  const names = (await listVoices()).map((v) => v.name);
  return models.map((m) => (isElevenModel(m.id) && names.length ? { ...m, voices: names } : m));
}

export async function allSpeechModels(): Promise<SpeechModel[]> {
  if (currentScope()?.speechModels) return withElevenVoices(speechModels());   // the station limits the choice: nothing else is offered
  return withElevenVoices(await allSpeechModelsUnlimited());
}

async function allSpeechModelsUnlimited(): Promise<SpeechModel[]> {
  const configuredList = speechModels();
  const extra = await discoverSpeechModels();
  // With no list of your own (OPENROUTER_SPEECH_MODELS), the built-in models OpenRouter does not list are left out.
  const builtInOnly = list(process.env.OPENROUTER_SPEECH_MODELS).length === 0;
  const pinned = process.env.OPENROUTER_SPEECH_MODEL?.trim();
  const kept = builtInOnly && extra.length ? configuredList.filter((m) => m.id === pinned || isElevenModel(m.id) || extra.some((x) => x.id === m.id)) : configuredList;
  const merged = kept.map((m) => {
    const live = extra.find((x) => x.id === m.id);
    return live?.voices ? { ...m, voices: live.voices } : m;
  });
  return [...merged, ...extra.filter((x) => !kept.some((m) => m.id === x.id))];
}

// An unknown model is the most common way speech fails; say what to do about it.
export const MODEL_GONE = /does not exist|No endpoints found|not a valid model|model not found/i;

// Resolves a requested model against the allowed list; returns an error message when it is not allowed.
export function pickTextModel(requested: string | undefined): { model: string } | { error: string } {
  if (!requested) return { model: defaultTextModel() };
  if (RETIRED_MODELS[requested]) return { error: `The writing model "${requested.slice(0, 60)}" has been retired. ${RETIRED_MODELS[requested]}` };
  if (textModels().includes(requested) || isListedFree(requested) || (allowAnyModel() && MODEL_SLUG.test(requested))) return { model: requested };
  return { error: `Unknown writing model "${requested.slice(0, 60)}". Allowed: ${textModels().join(", ")}` };
}
// The writing model for something that has preferences (a request, then a persona, then a station): the request is checked strictly (a
// bad name is an error), while a preference that is no longer on the list just falls through to the next one and finally the default.
export function resolveTextModel(requested: string | undefined, preferred: Array<string | undefined> = []): { model: string } | { error: string } {
  if (requested) return pickTextModel(requested);
  for (const p of preferred) {
    if (!p) continue;
    const picked = pickTextModel(p);
    if ("model" in picked) return picked;
  }
  return { model: defaultTextModel() };
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
  const key = apiKey("openrouter");
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

// Token budgets. "Thinking" models (Gemini 3.x, Claude with reasoning, DeepSeek R1...) spend part of max_tokens on reasoning BEFORE the
// answer, so a small cap gives empty or cut-off text even for a one-line drop. The budget is generous (you only pay for what is
// generated), reasoning effort is asked to be low, and an empty or cut-off reply is retried once with a bigger budget.
export const WRITE_MAX_TOKENS = 3000;
export const IMAGE_MAX_TOKENS = 2000;

interface Choice { message?: { content?: unknown; reasoning?: unknown }; finish_reason?: string }

// A reply's text: a string, or (some models) an array of parts.
function textOf(content: unknown): string {
  if (typeof content === "string") return content.trim();
  if (Array.isArray(content)) return content.map((p) => (p && typeof p === "object" && typeof (p as { text?: unknown }).text === "string" ? (p as { text: string }).text : "")).join("").trim();
  return "";
}

// A one-word reply is a model that stopped early (some "thinking" models end the visible text after a few words when reasoning
// shares the budget), not a line anyone wanted: it is retried like an empty one. The retries ask for less reasoning, then none.
const REASONING_LADDER: Array<Record<string, unknown>> = [{ effort: "low" }, { effort: "minimal" }, { enabled: false }];
const tooShort = (text: string): boolean => text.split(/\s+/).filter(Boolean).length < 2;

async function complete(model: string, messages: unknown[], maxTokens: number, timeoutMs: number, hint: string, minWords = true): Promise<string> {
  let budget = maxTokens;
  let last: { text: string; cutOff: boolean; reasoning: boolean } = { text: "", cutOff: false, reasoning: false };
  for (let attempt = 0; attempt < REASONING_LADDER.length; attempt += 1) {
    const res = await fetch(`${base()}/chat/completions`, {
      method: "POST",
      headers: headers(),
      body: JSON.stringify({ model, max_tokens: budget, reasoning: REASONING_LADDER[attempt], messages }),
      signal: AbortSignal.timeout(timeoutMs),
    });
    if (!res.ok) throw new Error(await errorMessage(res));
    const choice = ((await res.json()) as { choices?: Choice[] }).choices?.[0];
    const text = textOf(choice?.message?.content);
    const cutOff = choice?.finish_reason === "length";
    last = { text, cutOff, reasoning: Boolean(choice?.message?.reasoning) };
    if (text && !cutOff && !(minWords && tooShort(text))) return text;
    budget = Math.min(budget * 2, 16000);                                  // ran out of tokens (reasoning), stopped early or came back empty: again, with room
  }
  if (last.text && last.cutOff) throw new Error(`${model} was cut off before it finished (it spends many tokens thinking). Try another writing model.`);
  if (last.text) throw new Error(`${model} only returned "${last.text.slice(0, 40)}" (it stops after a few words). Try another writing model.`);
  throw new Error(`${model} returned no text${hint}${last.reasoning ? " (it used its whole budget thinking; try another writing model)" : ""}`);
}

export async function chat(options: { model: string; system: string; prompt: string; maxTokens?: number }): Promise<string> {
  return complete(options.model, [{ role: "system", content: options.system }, { role: "user", content: options.prompt }], options.maxTokens ?? WRITE_MAX_TOKENS, 40_000, "");
}

// A chat completion that also looks at one image (a data: URL). The model must accept images; OPENROUTER_VISION_MODEL picks it
// (default openai/gpt-4o-mini).
export const visionModel = (): string => {
  const wanted = process.env.OPENROUTER_VISION_MODEL?.trim();
  return wanted && MODEL_SLUG.test(wanted) ? wanted : "openai/gpt-4o-mini";
};

export async function chatWithImage(options: { model: string; system: string; prompt: string; image: string; maxTokens?: number }): Promise<string> {
  return complete(options.model, [
    { role: "system", content: options.system },
    { role: "user", content: [{ type: "text", text: options.prompt }, { type: "image_url", image_url: { url: options.image } }] },
  ], options.maxTokens ?? IMAGE_MAX_TOKENS, 50_000, " (does it accept images?)");
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
  if (!res.ok || (res.headers.get("content-type") ?? "").includes("json")) {
    const message = await errorMessage(res);
    throw new Error(MODEL_GONE.test(message) ? `${message}. That speech model is not available on OpenRouter right now: pick another in the Speech model list.` : message);
  }
  const audio = Buffer.from(await res.arrayBuffer());
  if (!audio.length) throw new Error(`${options.model} returned no audio`);
  return { audio, format };
}

// ---- prices ----
// What OpenRouter lists for each model (USD per token, as strings): used for cost estimates before a request is made (lib/pricing.ts).
// Best effort and cached for an hour; a person's own key may see different models, so only the site's key shares the cache.
export interface ModelPrice { promptPerToken: number; completionPerToken: number; /** Listed under speech models. */ speech?: boolean; /** OpenRouter's `top_provider.is_moderated`, when it says. */ moderated?: boolean }
let priced: { at: number; prices: Map<string, ModelPrice> } | undefined;
export const resetPriceCache = (): void => { priced = undefined; };
const PRICE_TTL_MS = 60 * 60_000;

export async function modelPrices(): Promise<Map<string, ModelPrice>> {
  const shared = keySource("openrouter") === "site";
  if (shared && priced && Date.now() - priced.at < PRICE_TTL_MS) return priced.prices;
  const prices = new Map<string, ModelPrice>();
  for (const [path, speech] of [["/models", false], ["/models?output_modalities=speech", true]] as const) {
    try {
      const res = await fetch(`${base()}${path}`, { headers: headers(), signal: AbortSignal.timeout(6_000) });
      if (!res.ok) continue;
      const body = (await res.json()) as { data?: Array<{ id?: unknown; pricing?: { prompt?: unknown; completion?: unknown }; top_provider?: { is_moderated?: unknown } }> };
      for (const m of body.data ?? []) {
        const p = Number(m.pricing?.prompt);
        const c = Number(m.pricing?.completion);
        if (typeof m.id === "string" && Number.isFinite(p) && p >= 0) prices.set(m.id, { promptPerToken: p, completionPerToken: Number.isFinite(c) && c >= 0 ? c : 0, ...(speech ? { speech: true } : {}), ...(typeof m.top_provider?.is_moderated === "boolean" ? { moderated: m.top_provider.is_moderated } : {}) });
      }
    } catch {
      // unreachable or not JSON: estimates fall back to the built-in table
    }
  }
  if (shared && prices.size) priced = { at: Date.now(), prices };
  return prices;
}

// ---- the writing models to offer ----
// The configured list, checked against what OpenRouter lists (a built-in candidate it does not list is hidden; a list you set yourself in
// OPENROUTER_TEXT_MODELS is kept as written), plus the free models OpenRouter lists (ids ending in ":free", capped). Free models are
// rate limited and may log prompts, so they are labelled and not the default. When the listing cannot be read, the configured list is used.
export const FREE_MODEL = /:free$/;
const MAX_FREE_LISTED = 40;

export async function allTextModels(): Promise<string[]> {
  const base = textModels();
  if (currentScope()?.textModels) return base;                                // the station limits the choice
  const listed = await modelPrices().catch(() => new Map<string, ModelPrice>());
  const chat = [...listed.entries()].filter(([, p]) => !p.speech).map(([id]) => id);
  if (!chat.length) return base;
  const custom = list(process.env.OPENROUTER_TEXT_MODELS).length > 0;
  const pinned = process.env.OPENROUTER_TEXT_MODEL?.trim();
  const kept = custom ? base : base.filter((id) => id === pinned || chat.includes(id));
  const free = chat.filter((id) => FREE_MODEL.test(id)).sort().slice(0, MAX_FREE_LISTED);
  return [...kept, ...free.filter((id) => !kept.includes(id))];
}

// A free model OpenRouter lists can be chosen even when it is not on the configured list: it costs nothing, so there is nothing to protect.
// `modelPrices` is cached, so this is a cheap call; it makes sure the listing is loaded before a request names a free model.
export async function ensureListed(model: string | undefined): Promise<void> {
  if (model && FREE_MODEL.test(model) && !textModels().includes(model)) await modelPrices().catch(() => undefined);
}
const isListedFree = (model: string): boolean => FREE_MODEL.test(model) && Boolean(priced?.prices.has(model));
