import { activeProvider } from "./ai.js";
import type { ContentInfo } from "./content.js";
import { isElevenModel } from "./elevenlabs.js";
import { defaultSpeechModel, defaultTextModel, modelPrices } from "./openrouter.js";

// Rough cost estimates shown BEFORE a request is made, so nobody spends credits by surprise. These are estimates, never a bill:
//   * text: tokens are counted as characters / 4; the price is what OpenRouter lists for the model (live), else a small built-in table
//     of the default models marked "approx", else unknown.
//   * speech: length is estimated at about 15 characters a second. Speech models bill in different ways (per character, per token,
//     per second), so a cost is only shown when OpenRouter lists a price for the model, and then as "about".
//   * images (flier reading) are counted as a fixed number of tokens.
// "Premium" and "unknown" models, and anything much dearer than the default, get a warning.
export type Tier = "free" | "budget" | "standard" | "premium" | "unknown";
export interface Price { inPerM: number; outPerM: number; source: "live" | "approx" }

const APPROX: Record<string, [number, number]> = {
  "openai/gpt-4o-mini": [0.15, 0.6],
  "anthropic/claude-3.5-haiku": [0.8, 4],
  "meta-llama/llama-3.1-8b-instruct": [0.02, 0.05],
};
// Speech models that are known to be cheap / mid-priced when no price is listed.
const SPEECH_TIER: Array<[RegExp, Tier]> = [[/kokoro/i, "budget"], [/elevenlabs/i, "premium"], [/gemini.*tts|openai\/.*tts|tts/i, "standard"]];
const IMAGE_TOKENS = 1100;
export const CHARS_PER_TOKEN = 4;
export const CHARS_PER_SECOND = 15;
const DEFAULT_SYSTEM_TOKENS = 250;

export const tokensFor = (chars: number): number => Math.ceil(Math.max(0, chars) / CHARS_PER_TOKEN);

export async function priceOf(model: string): Promise<Price | null> {
  if (activeProvider() === "openrouter") {
    const live = (await modelPrices().catch(() => new Map())).get(model);
    if (live && (live.promptPerToken > 0 || live.completionPerToken > 0)) return { inPerM: live.promptPerToken * 1e6, outPerM: live.completionPerToken * 1e6, source: "live" };
  }
  const known = APPROX[model];
  return known ? { inPerM: known[0], outPerM: known[1], source: "approx" } : null;
}

export function textTier(price: Price | null): Tier {
  if (!price) return "unknown";
  if (price.inPerM === 0 && price.outPerM === 0) return "free";
  return price.outPerM <= 1 ? "budget" : price.outPerM <= 5 ? "standard" : "premium";
}
export function speechTier(model: string, price: Price | null): Tier {
  const hinted = SPEECH_TIER.find(([re]) => re.test(model));
  if (hinted) return hinted[1];
  return price ? (price.inPerM <= 1 ? "budget" : price.inPerM <= 15 ? "standard" : "premium") : "unknown";
}

export interface Estimate {
  kind: string;
  model: string;
  tier: Tier;
  tokens?: { in: number; out: number };
  seconds?: number;
  /** USD, a likely figure and a ceiling; null when no price is known. */
  costUsd: { likely: number; max: number } | null;
  priceSource?: "live" | "approx";
  /** Whether the model filters strong language (lib/content.ts), added by the estimate endpoint. */
  content?: ContentInfo;
  /** ElevenLabs bills in credits (about one per character), not dollars. */
  credits?: { provider: string; characters: number };
  /** How many times the default model's cost this is, when both prices are known. */
  timesDefault: number | null;
  warn: boolean;
  message: string;
}

const money = (n: number) => (n < 0.01 ? `$${n.toFixed(4)}` : `$${n.toFixed(2)}`);

function finish(base: Omit<Estimate, "warn" | "message">, defaultName: string): Estimate {
  const reasons: string[] = [];
  if (base.tier === "premium") reasons.push("is a premium model");
  if (base.tier === "unknown" && !base.credits) reasons.push("has no known price, so its cost cannot be estimated");
  if (base.timesDefault !== null && base.timesDefault >= 5) reasons.push(`costs about ${Math.round(base.timesDefault)}x the default (${defaultName})`);
  const warn = reasons.length > 0;
  const cost = base.tier === "free" ? "free (rate limited, and the provider may log what you send)" : base.credits ? `about ${base.credits.characters} characters of your ${base.credits.provider} credits` : base.costUsd ? `about ${money(base.costUsd.likely)}, at most ${money(base.costUsd.max)}` : "cost unknown";
  const size = base.tokens ? `~${base.tokens.in + base.tokens.out} tokens` : base.seconds ? `~${Math.max(1, Math.round(base.seconds))} s of audio` : "";
  const message = `${base.model}: ${[size, cost].filter(Boolean).join(", ")}.${warn ? ` Heads up: this model ${reasons.join(" and ")}, so it uses your credits faster.` : ""}`;
  return { ...base, warn, message };
}

async function defaultTextPrice(): Promise<Price | null> { return priceOf(defaultTextModel()); }

/** A chat request: `inputChars` of prompt (plus the system prompt), at most `maxOut` tokens back, optionally one image. */
export async function estimateText(o: { kind: string; model: string; inputChars: number; systemChars?: number; maxOut: number; expectedOut?: number; image?: boolean }): Promise<Estimate> {
  const inTokens = tokensFor(o.inputChars) + (o.systemChars !== undefined ? tokensFor(o.systemChars) : DEFAULT_SYSTEM_TOKENS) + (o.image ? IMAGE_TOKENS : 0);
  const price = await priceOf(o.model);
  const dflt = o.model === defaultTextModel() ? price : await defaultTextPrice();
  const cost = (out: number) => (price ? (inTokens * price.inPerM + out * price.outPerM) / 1e6 : null);
  const max = cost(o.maxOut);
  const likely = cost(Math.min(o.maxOut, o.expectedOut ?? o.maxOut));
  const ratio = price && dflt && dflt.outPerM > 0 ? price.outPerM / dflt.outPerM : null;
  const provider = activeProvider();
  if (provider === "gemini") {
    return finish({ kind: o.kind, model: o.model, tier: "budget", tokens: { in: inTokens, out: o.maxOut }, costUsd: null, timesDefault: null }, o.model);
  }
  return finish({ kind: o.kind, model: o.model, tier: textTier(price), tokens: { in: inTokens, out: o.maxOut }, costUsd: max !== null && likely !== null ? { likely, max } : null, ...(price ? { priceSource: price.source } : {}), timesDefault: ratio }, defaultTextModel());
}

/** Speaking `chars` characters with a speech model. */
export async function estimateSpeech(o: { model: string; chars: number }): Promise<Estimate> {
  const seconds = o.chars / CHARS_PER_SECOND;
  if (isElevenModel(o.model)) {
    // Flash and turbo models are the economical ones; multilingual (and anything newer) is the premium model.
    const tier: Tier = /flash|turbo/i.test(o.model) ? "standard" : "premium";
    return finish({ kind: "speak", model: o.model, tier, seconds, costUsd: null, credits: { provider: "ElevenLabs", characters: Math.round(o.chars) }, timesDefault: null }, defaultSpeechModel().id);
  }
  if (activeProvider() === "gemini") return finish({ kind: "speak", model: o.model, tier: "standard", seconds, costUsd: null, timesDefault: null }, o.model);
  const price = await priceOf(o.model);
  const dflt = o.model === defaultSpeechModel().id ? price : await priceOf(defaultSpeechModel().id);
  const tokens = tokensFor(o.chars);
  const cost = price ? (tokens * price.inPerM) / 1e6 : null;
  const ratio = price && dflt && dflt.inPerM > 0 ? price.inPerM / dflt.inPerM : null;
  return finish({ kind: "speak", model: o.model, tier: speechTier(o.model, price), seconds, costUsd: cost !== null ? { likely: cost, max: cost * 1.5 } : null, ...(price ? { priceSource: price.source } : {}), timesDefault: ratio }, defaultSpeechModel().id);
}
