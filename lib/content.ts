import type { ModelPrice } from "./openrouter.js";

// Does a model filter or soften strong language? Shown next to every model so you can pick one that will say what you write.
//   filtered   hosted frontier models with safety training and/or provider moderation: they may refuse, bleep or soften profanity
//   light      models with some safety tuning that usually still go along with profanity in a character (and ElevenLabs, which reads it
//              but has a usage policy)
//   open       models built to say what they are given (small open speech models, community "uncensored" fine-tunes)
//   unknown    nobody checked: try it
// The ONLY live signal is OpenRouter's `is_moderated` flag on a model's main provider (true => filtered). Everything else is a
// best-effort hint from the model's name and what is publicly known, NOT a test of the actual model: it can be wrong, models change, and
// providers differ. Generate a line with the language you need before relying on a model.
export type Filtering = "filtered" | "light" | "open" | "unknown";
export interface ContentInfo { level: Filtering; live: boolean; note: string }

const HINTS: Array<[RegExp, Filtering, string]> = [
  [/dolphin|uncensored|abliterated|lumimaid|euryale|magnum|mythomax|hermes/i, "open", "A community fine-tune made to follow instructions without refusing; it should go along with strong language."],
  [/^hexgrad\/kokoro/i, "open", "A small open speech model with no content filter: it reads whatever text it is given."],
  [/^elevenlabs\//i, "light", "Reads profanity, but ElevenLabs has a usage policy and can block some content."],
  [/^(openai|anthropic|google|x-ai|amazon|microsoft|cohere)\//i, "filtered", "A hosted model with safety training: it may refuse, soften or bleep strong language."],
  [/^(meta-llama|mistralai|qwen|deepseek|nvidia|nousresearch)\//i, "light", "Some safety tuning, but usually goes along with strong language when the character calls for it."],
];

export function contentFilter(model: string, price?: Pick<ModelPrice, "moderated">): ContentInfo {
  if (price?.moderated === true) return { level: "filtered", live: true, note: "OpenRouter reports this model's provider moderates content, so strong language may be refused or softened." };
  const hint = HINTS.find(([re]) => re.test(model));
  const note = hint ? `${hint[2]} (A hint, not a test: try it.)` : "Not checked. Try it with the language you need.";
  return { level: hint ? hint[1] : price?.moderated === false ? "light" : "unknown", live: false, note };
}
