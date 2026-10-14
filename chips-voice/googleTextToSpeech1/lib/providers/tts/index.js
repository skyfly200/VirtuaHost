// Pick text-to-speech providers by name. TTS_PROVIDER is a comma list; later entries are
// fallbacks tried when an earlier one fails (for example "google,piper").
const factories = {
  google: require('./google').create,
  openai: require('./openai').create,
  elevenlabs: require('./elevenlabs').create,
  piper: require('./piper').create,
};

function createTts(env = process.env, overrides = {}) {
  const names = (env.TTS_PROVIDER || 'google').split(',').map((s) => s.trim()).filter(Boolean);
  const providers = names.map((name) => {
    if (overrides[name]) return overrides[name];
    if (!factories[name]) throw new Error(`unknown TTS_PROVIDER "${name}" (known: ${Object.keys(factories).join(', ')})`);
    return factories[name](env);
  });
  const primary = providers[0];

  return {
    names,
    primary,
    capabilities: primary.capabilities,

    // Voices come from the primary provider so the UI picker matches what will be used.
    listVoices: () => primary.listVoices(),

    async synthesize(req) {
      const errors = [];
      for (const provider of providers) {
        // A voice id only means something to the provider it was chosen from.
        const attempt = provider === primary ? req : { ...req, voice: undefined, language: undefined };
        try {
          const result = await provider.synthesize(attempt);
          return { ...result, provider: provider.name };
        } catch (err) {
          errors.push(`${provider.name}: ${err.message}`);
        }
      }
      throw new Error(`speech synthesis failed (${errors.join('; ')})`);
    },
  };
}

module.exports = { createTts, factories };
