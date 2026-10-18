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

const audioHelpers = require('../../audio');

function createTts(env = process.env, overrides = {}, deps = {}) {
  const audio = { ...audioHelpers, ...deps };
  const canJoin = audio.ffmpegAvailable();
  const names = (env.TTS_PROVIDER || 'google').split(',').map((s) => s.trim()).filter(Boolean);
  const providers = names.map((name) => {
    if (overrides[name]) return overrides[name];
    if (!factories[name]) throw new Error(`unknown TTS_PROVIDER "${name}" (known: ${Object.keys(factories).join(', ')})`);
    return factories[name](env);
  });
  const byName = Object.fromEntries(providers.map((p) => [p.name, p]));
  const primary = providers[0];

  // Providers without a native multi-voice endpoint can still do dialogue: voice each line with its speaker's
  // voice and join the parts with ffmpeg. The result is an MP3 either way.
  async function emulateDialogue(provider, req) {
    const parts = [];
    for (const turn of req.turns) {
      const part = await provider.synthesize({
        text: turn.text, voice: turn.voice, format: 'MP3', rate: req.rate, pitch: req.pitch, gain: req.gain,
        tone: turn.tone || req.tone, model: req.model,
      });
      parts.push(part.ext === 'mp3' ? part.audio : await audio.toMp3(part.audio));
    }
    return { audio: await audio.concatMp3(parts, 0.35), ext: 'mp3' };
  }
  const dialogueSupport = (p) => ({ native: !!p.synthesizeDialogue, emulated: !p.synthesizeDialogue && canJoin });
  const withDialogue = (p) => {
    const d = dialogueSupport(p);
    return { ...p.capabilities, dialogue: d.native || d.emulated, dialogueNative: d.native };
  };

  function pick(name) {
    if (!name) return null;
    if (!byName[name]) throw new ProviderError(`speech provider "${name}" is not enabled (enabled: ${names.join(', ')})`);
    return byName[name];
  }

  return {
    names,
    primary,
    capabilities: withDialogue(primary),
    ProviderError,

    // What the UI needs to build its pickers.
    providers: providers.map((p) => ({ name: p.name, capabilities: withDialogue(p), defaultVoice: p.defaultVoice, models: p.models || [] })),
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
        const support = dialogueSupport(provider);
        if (wantsDialogue && !support.native && !support.emulated) {
          errors.push(`${provider.name}: dialogue needs ffmpeg installed to join the lines`);
          continue;
        }
        // A voice id only means something to the provider it was chosen from.
        const first = provider === (chosen || primary);
        const attempt = first ? req : { ...req, voice: undefined, language: undefined, turns: req.turns };
        try {
          const result = !wantsDialogue ? await provider.synthesize(attempt)
            : support.native ? await provider.synthesizeDialogue(attempt) : await emulateDialogue(provider, attempt);
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
