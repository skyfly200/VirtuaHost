// OpenAI text-to-speech (also any server that implements /audio/speech).
//   OPENAI_API_KEY, OPENAI_BASE_URL (default https://api.openai.com/v1), OPENAI_TTS_MODEL (default tts-1)
const { request } = require('../http');

const FORMATS = { MP3: ['mp3', 'mp3'], OGG_OPUS: ['opus', 'ogg'], LINEAR16: ['wav', 'wav'] };
const VOICES = ['alloy', 'echo', 'fable', 'onyx', 'nova', 'shimmer'];

function create(env) {
  const base = (env.OPENAI_BASE_URL || 'https://api.openai.com/v1').replace(/\/+$/, '');
  return {
    name: 'openai',
    capabilities: { ssml: false, pitch: false, rate: true, gain: false },
    defaultVoice: env.OPENAI_TTS_VOICE || 'alloy',

    async listVoices() {
      return VOICES.map((id) => ({ id, language: '', gender: '' }));
    },

    async synthesize(req) {
      if (!env.OPENAI_API_KEY) throw new Error('OPENAI_API_KEY is not set');
      if (req.ssmlMode) throw new Error('openai TTS does not support SSML');
      const [responseFormat, ext] = FORMATS[req.format] || FORMATS.MP3;
      const audio = await request(`${base}/audio/speech`, {
        method: 'POST',
        headers: { Authorization: `Bearer ${env.OPENAI_API_KEY}` },
        body: {
          model: env.OPENAI_TTS_MODEL || 'tts-1',
          voice: req.voice || this.defaultVoice,
          input: req.text,
          response_format: responseFormat,
          speed: Math.min(4, Math.max(0.25, req.rate || 1)),
        },
        binary: true,
      });
      return { audio, ext };
    },
  };
}

module.exports = { create };
