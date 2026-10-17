// Pick text-to-speech providers by name. TTS_PROVIDER lists the providers that are enabled; the first is the
// default and later ones are fallbacks (for example "elevenlabs,openrouter,google"). A request can name one
// of the enabled providers; it is then used alone, with no fallback.
const factories = {
  google: require('./google').create,
  openai: require('./openai').create,
  elevenlabs: require('./elevenlabs').create,
  openrouter: require('./openrouter').create,
  piper: require('./piper').create,
};

class ProviderError extends Error {}

function createTts(env = process.env, overrides = {}) {
  const names = (env.TTS_PROVIDER || 'google').split(',').map((s) => s.trim()).filter(Boolean);
  const providers = names.map((name) => {
    if (overrides[name]) return overrides[name];
    if (!factories[name]) throw new Error(`unknown TTS_PROVIDER "${name}" (known: ${Object.keys(factories).join(', ')})`);
    return factories[name](env);
  });
  const byName = Object.fromEntries(providers.map((p) => [p.name, p]));
  const primary = providers[0];

  function pick(name) {
    if (!name) return null;
    if (!byName[name]) throw new ProviderError(`speech provider "${name}" is not enabled (enabled: ${names.join(', ')})`);
    return byName[name];
  }

  return {
    names,
    primary,
    capabilities: primary.capabilities,
    ProviderError,

    // What the UI needs to build its pickers.
    providers: providers.map((p) => ({ name: p.name, capabilities: p.capabilities, defaultVoice: p.defaultVoice })),
    has: (name) => !!byName[name],

    listVoices: (name) => (pick(name) || primary).listVoices(),
    listModels: async (name) => {
      const p = pick(name) || providers.find((x) => x.listModels);
      return p && p.listModels ? p.listModels() : [];
    },

    async synthesize(req) {
      const chosen = pick(req.provider);
      const chain = chosen ? [chosen] : providers;
      const wantsDialogue = Array.isArray(req.turns) && req.turns.length > 0;
      const errors = [];
      for (const provider of chain) {
        if (wantsDialogue && !provider.synthesizeDialogue) {
          errors.push(`${provider.name}: does not support multi-voice dialogue`);
          continue;
        }
        // A voice id only means something to the provider it was chosen from.
        const first = provider === (chosen || primary);
        const attempt = first ? req : { ...req, voice: undefined, language: undefined, turns: req.turns };
        try {
          const result = wantsDialogue ? await provider.synthesizeDialogue(attempt) : await provider.synthesize(attempt);
          return { ...result, provider: provider.name };
        } catch (err) {
          errors.push(`${provider.name}: ${err.message}`);
        }
      }
      throw new Error(`speech synthesis failed (${errors.join('; ')})`);
    },
  };
}

module.exports = { createTts, factories, ProviderError };
