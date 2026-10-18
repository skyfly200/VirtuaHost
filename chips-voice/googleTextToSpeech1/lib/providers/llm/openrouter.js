// OpenRouter: one API key, hundreds of models.
//   OPENROUTER_API_KEY, OPENROUTER_MODEL (default openai/gpt-4o-mini; any id from https://openrouter.ai/models),
//   OPENROUTER_FALLBACK_MODELS (comma list tried in order if the first model fails),
//   OPENROUTER_LLM_MODELS (comma list of further models a request may pick, for example a conversational or
//   tone-aware one for drafting dialogue),
//   OPENROUTER_REFERER and OPENROUTER_TITLE (optional attribution headers), OPENROUTER_BASE_URL.
const { createChat } = require('./openai');
const { request } = require('../http');

function create(env) {
  const base = env.OPENROUTER_BASE_URL || 'https://openrouter.ai/api/v1';
  const fallbacks = (env.OPENROUTER_FALLBACK_MODELS || '').split(',').map((s) => s.trim()).filter(Boolean);
  const model = env.OPENROUTER_MODEL || 'openai/gpt-4o-mini';
  const chat = createChat({
    name: 'openrouter',
    baseUrl: base,
    apiKey: env.OPENROUTER_API_KEY,
    model,
    headers: {
      ...(env.OPENROUTER_REFERER ? { 'HTTP-Referer': env.OPENROUTER_REFERER } : {}),
      'X-Title': env.OPENROUTER_TITLE || 'Chips Voice',
    },
    // OpenRouter routes through this list in order when the chosen model is unavailable.
    fallbackModels: fallbacks,
    // Models a request may choose with `model` (the default is always allowed).
    allowedModels: (env.OPENROUTER_LLM_MODELS || '').split(',').map((s) => s.trim()).filter(Boolean),
  });
  return {
    ...chat,
    // Models the user can choose from (public endpoint).
    async listModels() {
      const res = await request(`${base.replace(/\/+$/, '')}/models`, {});
      return (res.data || []).map((m) => ({ id: m.id, name: m.name, contextLength: m.context_length }));
    },
  };
}

module.exports = { create };
