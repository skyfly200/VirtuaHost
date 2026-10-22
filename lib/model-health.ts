// Which writing models have been failing, so a model picker can flag them instead of offering a choice that only ever errors.
// In memory per server instance (a restart or a cold function forgets it): a hint, not a record. Retired slugs are known up front.

/** Slugs OpenRouter has retired (they answer 404). They are never offered and are refused with a clear message. */
export const RETIRED_MODELS: Readonly<Record<string, string>> = {
  "anthropic/claude-3.5-haiku": "Retired by its provider (OpenRouter answers 404). Use anthropic/claude-haiku-5.5 or openai/gpt-4o-mini.",
  "anthropic/claude-3-haiku": "Retired by its provider. Use anthropic/claude-haiku-5.5 or openai/gpt-4o-mini.",
};

interface Health { fails: number; ok: number; lastError?: string; lastAt: number }
const seen = new Map<string, Health>();
const WINDOW_MS = 6 * 3600e3;

export function recordModelResult(model: string, ok: boolean, error?: string, now = Date.now()): void {
  const h = seen.get(model) ?? { fails: 0, ok: 0, lastAt: now };
  if (now - h.lastAt > WINDOW_MS) { h.fails = 0; h.ok = 0; }
  if (ok) { h.ok += 1; h.fails = 0; } else { h.fails += 1; h.lastError = (error ?? "failed").slice(0, 200); }
  h.lastAt = now;
  seen.set(model, h);
}

export interface ModelFlag { status: "retired" | "failing"; note: string }

/** A flag for a model that should not be picked: retired, or failing at least twice in a row recently. */
export function modelFlag(model: string, now = Date.now()): ModelFlag | undefined {
  if (RETIRED_MODELS[model]) return { status: "retired", note: RETIRED_MODELS[model] };
  const h = seen.get(model);
  if (h && h.fails >= 2 && now - h.lastAt < WINDOW_MS) return { status: "failing", note: `Failed ${h.fails} times in a row recently: ${h.lastError ?? "no reply"}. Try another model.` };
  return undefined;
}
export const resetModelHealth = (): void => seen.clear();
