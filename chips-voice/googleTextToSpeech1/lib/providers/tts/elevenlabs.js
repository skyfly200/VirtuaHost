// ElevenLabs. ELEVENLABS_API_KEY, ELEVENLABS_BASE_URL, ELEVENLABS_MODEL (default eleven_multilingual_v2),
// ELEVENLABS_VOICE_ID (default voice). Output is always MP3.
const { request } = require('../http');

function create(env) {
  const base = (env.ELEVENLABS_BASE_URL || 'https://api.elevenlabs.io').replace(/\/+$/, '');
  const headers = () => ({ 'xi-api-key': env.ELEVENLABS_API_KEY });
  return {
    name: 'elevenlabs',
    capabilities: { ssml: false, pitch: false, rate: false, gain: false },
    defaultVoice: env.ELEVENLABS_VOICE_ID || '',

    async listVoices() {
      if (!env.ELEVENLABS_API_KEY) throw new Error('ELEVENLABS_API_KEY is not set');
      const res = await request(`${base}/v1/voices`, { headers: headers() });
      return (res.voices || []).map((v) => ({ id: v.voice_id, name: v.name, language: '', gender: '' }));
    },

    async synthesize(req) {
      if (!env.ELEVENLABS_API_KEY) throw new Error('ELEVENLABS_API_KEY is not set');
      if (req.ssmlMode) throw new Error('elevenlabs TTS does not support SSML');
      const voice = req.voice || this.defaultVoice;
      if (!voice) throw new Error('choose an ElevenLabs voice (or set ELEVENLABS_VOICE_ID)');
      const audio = await request(`${base}/v1/text-to-speech/${encodeURIComponent(voice)}?output_format=mp3_44100_128`, {
        method: 'POST',
        headers: headers(),
        body: { text: req.text, model_id: env.ELEVENLABS_MODEL || 'eleven_multilingual_v2' },
        binary: true,
      });
      return { audio, ext: 'mp3' };
    },
  };
}

module.exports = { create };
