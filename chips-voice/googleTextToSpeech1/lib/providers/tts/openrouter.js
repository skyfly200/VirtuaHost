// OpenRouter's speech endpoint (OpenAI-compatible /audio/speech). One key, several speech models.
//   OPENROUTER_API_KEY
//   OPENROUTER_TTS_MODEL   a speech model id copied from https://openrouter.ai/models (required)
//   OPENROUTER_TTS_VOICES  comma list of voices for that model (voices differ per model); first is the default
//   OPENROUTER_BASE_URL    default https://openrouter.ai/api/v1
// Output is MP3. Speed is only honoured by some models. These are OpenRouter's models, not ElevenLabs:
// ElevenLabs voice clones belong to your ElevenLabs account, so use the `elevenlabs` provider for those.
const { request } = require('../http');

function create(env) {
  const base = (env.OPENROUTER_BASE_URL || 'https://openrouter.ai/api/v1').replace(/\/+$/, '');
  const voices = (env.OPENROUTER_TTS_VOICES || '').split(',').map((s) => s.trim()).filter(Boolean);
  return {
    name: 'openrouter',
    capabilities: { ssml: false, pitch: false, rate: true, gain: false },
    defaultVoice: env.OPENROUTER_TTS_VOICE || voices[0] || '',

    async listVoices() {
      return voices.map((id) => ({ id, language: '', gender: '' }));
    },

    // Speech models available on OpenRouter, for choosing OPENROUTER_TTS_MODEL.
    async listModels() {
      const res = await request(`${base}/models?output_modalities=speech`, {});
      return (res.data || []).map((m) => ({ id: m.id, name: m.name }));
    },

    async synthesize(req) {
      if (!env.OPENROUTER_API_KEY) throw new Error('OPENROUTER_API_KEY is not set');
      if (!env.OPENROUTER_TTS_MODEL) throw new Error('set OPENROUTER_TTS_MODEL to a speech model id');
      if (req.ssmlMode) throw new Error('openrouter speech does not support SSML');
      const voice = req.voice || this.defaultVoice;
      const body = { model: env.OPENROUTER_TTS_MODEL, input: req.text, response_format: 'mp3' };
      if (voice) body.voice = voice;
      if (req.rate && req.rate !== 1) body.speed = Math.min(4, Math.max(0.25, req.rate));
      const audioBytes = await request(`${base}/audio/speech`, {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${env.OPENROUTER_API_KEY}`,
          ...(env.OPENROUTER_REFERER ? { 'HTTP-Referer': env.OPENROUTER_REFERER } : {}),
          'X-Title': env.OPENROUTER_TITLE || 'Chips Voice',
        },
        body,
        binary: true,
      });
      return { audio: audioBytes, ext: 'mp3' };
    },
  };
}

module.exports = { create };
