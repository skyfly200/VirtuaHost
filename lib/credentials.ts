import { AsyncLocalStorage } from "node:async_hooks";

// Which AI provider keys and models a request may use. The site's own keys come from the environment (OPENROUTER_API_KEY,
// GEMINI_API_KEY); a station or a person can bring their own (lib/provider-keys.ts), which win, in this order:
//   the person's key  >  the station's key  >  the site's key
// A handler resolves that once (async, from storage) and runs the rest of the request inside runWithScope, so the provider code
// (lib/openrouter.ts, lib/gemini.ts, lib/ai.ts) can stay synchronous and simply ask apiKey(). Outside a scope only the site keys exist.
export type KeyProvider = "openrouter" | "gemini" | "elevenlabs";
export type KeySource = "user" | "station" | "site";

export interface KeyScope {
  keys: Partial<Record<KeyProvider, string>>;
  source: Partial<Record<KeyProvider, "user" | "station">>;
  /** A station's allowed models (OpenRouter slugs). When set, requests are limited to these, even with your own key. */
  textModels?: string[];
  speechModels?: string[];
}

const als = new AsyncLocalStorage<KeyScope>();
export const runWithScope = <T>(scope: KeyScope, fn: () => T): T => als.run(scope, fn);
export const currentScope = (): KeyScope | undefined => als.getStore();

const ENV: Record<KeyProvider, string> = { openrouter: "OPENROUTER_API_KEY", gemini: "GEMINI_API_KEY", elevenlabs: "ELEVENLABS_API_KEY" };

export const apiKey = (provider: KeyProvider): string | undefined => als.getStore()?.keys[provider] || process.env[ENV[provider]] || undefined;
export const keySource = (provider: KeyProvider): KeySource => (als.getStore()?.keys[provider] ? als.getStore()!.source[provider] ?? "site" : "site");
/** True when the request is being paid for by the person who made it (their own key). */
export const usingOwnKey = (provider: KeyProvider | null): boolean => provider !== null && keySource(provider) === "user";
