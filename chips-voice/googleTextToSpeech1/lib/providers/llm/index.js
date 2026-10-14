// Pick language-model providers by name. LLM_PROVIDER is a comma list with fallbacks, for example
// "openrouter,anthropic". With LLM_PROVIDER unset, drafting is simply unavailable.
const { createChat } = require('./openai');

const factories = {
  openrouter: require('./openrouter').create,
  anthropic: require('./anthropic').create,
  openai: (env) => createChat({
    name: 'openai',
    baseUrl: env.OPENAI_BASE_URL || 'https://api.openai.com/v1',
    apiKey: env.OPENAI_API_KEY,
    model: env.OPENAI_LLM_MODEL || 'gpt-4o-mini',
  }),
  // Local models through Ollama's OpenAI-compatible endpoint; no key needed.
  ollama: (env) => createChat({
    name: 'ollama',
    baseUrl: env.OLLAMA_BASE_URL || 'http://127.0.0.1:11434/v1',
    model: env.OLLAMA_MODEL,
    requireKey: false,
  }),
};

function createLlm(env = process.env, overrides = {}) {
  const names = (env.LLM_PROVIDER || '').split(',').map((s) => s.trim()).filter(Boolean);
  const providers = names.map((name) => {
    if (overrides[name]) return overrides[name];
    if (!factories[name]) throw new Error(`unknown LLM_PROVIDER "${name}" (known: ${Object.keys(factories).join(', ')})`);
    return factories[name](env);
  });

  return {
    names,
    enabled: providers.length > 0,
    primary: providers[0],

    async generate(req) {
      if (!providers.length) throw new Error('no LLM provider configured (set LLM_PROVIDER)');
      const errors = [];
      for (const provider of providers) {
        try {
          return { text: await provider.generate(req), provider: provider.name, model: provider.model };
        } catch (err) {
          errors.push(`${provider.name}: ${err.message}`);
        }
      }
      throw new Error(`text generation failed (${errors.join('; ')})`);
    },

    async listModels() {
      const p = providers.find((x) => x.listModels);
      return p ? p.listModels() : [];
    },
  };
}

module.exports = { createLlm, factories };
