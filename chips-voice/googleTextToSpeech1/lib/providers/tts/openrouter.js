// OpenRouter's speech endpoint (OpenAI-compatible /audio/speech). One key, several speech models.
//   OPENROUTER_API_KEY
//   OPENROUTER_TTS_MODEL    the default speech model id, copied from https://openrouter.ai/models (required)
//   OPENROUTER_TTS_MODELS   comma list of further models a request may choose with `model`
//                           (the default is always allowed), for example
//                           "openai/gpt-4o-mini-tts-2025-12-15,google/gemini-3.8-flash-tts"
//   OPENROUTER_TTS_VOICES   comma list of voices; voices differ per model, the first is the default
//   OPENROUTER_TTS_DIALOGUE "emulate" (default) or "native"
//   OPENROUTER_BASE_URL     default https://openrouter.ai/api/v1
//
// Tone: `tone` is sent as the top-level `instructions` field (delivery guidance such as pacing or emotion). OpenRouter
// documents it for OpenAI gpt-4o-mini-tts, Gemini TTS and Fish Audio models; other models ignore it.
//
// Conversation: "emulate" voices each line with its own call and joins the parts with ffmpeg, which works with any model.
// "native" sends all the lines in one request as a list of turns, which OpenRouter documents for Gemini TTS models
// (at most two voices) and some Fish Audio models. The exact per-turn field names are NOT confirmed from the docs
// (we send text, voice and instructions); if a model rejects it, switch back to "emulate".
//
// Output: Gemini TTS models return raw PCM only (we assume 24 kHz, 16-bit, mono), every other model is asked for MP3.
// These are OpenRouter's models, not ElevenLabs: ElevenLabs voice clones need the `elevenlabs` provider.
const { request } = require('../http');
const audio = require('../../audio');

const isPcmModel = (model) => /^google\//.test(model);

function create(env, deps = {}) {
  const base = (env.OPENROUTER_BASE_URL || 'https://openrouter.ai/api/v1').replace(/\/+$/, '');
  const voices = (env.OPENROUTER_TTS_VOICES || '').split(',').map((s) => s.trim()).filter(Boolean);
  const list = (s) => String(s || '').split(',').map((x) => x.trim()).filter(Boolean);
  const defaultModel = env.OPENROUTER_TTS_MODEL || '';
  const models = [...new Set([defaultModel, ...list(env.OPENROUTER_TTS_MODELS)].filter(Boolean))];
  const native = env.OPENROUTER_TTS_DIALOGUE === 'native';
  const pcmToMp3 = deps.pcmToMp3 || audio.pcmToMp3;

  const headers = () => ({
    Authorization: `Bearer ${env.OPENROUTER_API_KEY}`,
    ...(env.OPENROUTER_REFERER ? { 'HTTP-Referer': env.OPENROUTER_REFERER } : {}),
    'X-Title': env.OPENROUTER_TITLE || 'Chips Voice',
  });

  function pickModel(requested) {
    if (!env.OPENROUTER_API_KEY) throw new Error('OPENROUTER_API_KEY is not set');
    if (!defaultModel) throw new Error('set OPENROUTER_TTS_MODEL to a speech model id');
    const model = requested || defaultModel;
    if (!models.includes(model)) throw new Error(`speech model "${model}" is not enabled (set OPENROUTER_TTS_MODELS; enabled: ${models.join(', ')})`);
    return model;
  }

  async function speak(body, model) {
    const raw = await request(`${base}/audio/speech`, { method: 'POST', headers: headers(), body, binary: true, timeoutMs: 120000 });
    return { audio: isPcmModel(model) ? await pcmToMp3(raw, { rate: 24000 }) : raw, ext: 'mp3' };
  }

  const provider = {
    name: 'openrouter',
    capabilities: { ssml: false, pitch: false, rate: true, gain: false, tone: true },
    defaultVoice: env.OPENROUTER_TTS_VOICE || voices[0] || '',
    models,
    dialogueMode: native ? 'native' : 'emulate',

    async listVoices() {
      return voices.map((id) => ({ id, language: '', gender: '' }));
    },

    // Speech models available on OpenRouter right now, each marked with whether this server allows it.
    async listModels() {
      const res = await request(`${base}/models?output_modalities=speech`, {});
      return (res.data || []).map((m) => ({ id: m.id, name: m.name, enabled: models.includes(m.id) }));
    },

    async synthesize(req) {
      const model = pickModel(req.model);
      if (req.ssmlMode) throw new Error('openrouter speech does not support SSML');
      const voice = req.voice || this.defaultVoice;
      const body = { model, input: req.text, response_format: isPcmModel(model) ? 'pcm' : 'mp3' };
      if (voice) body.voice = voice;
      if (req.tone) body.instructions = req.tone;
      if (req.rate && req.rate !== 1) body.speed = Math.min(4, Math.max(0.25, req.rate));
      return speak(body, model);
    },
  };

  if (native) {
    // All lines in one request (Gemini TTS models). See the note above about the unconfirmed turn field names.
    provider.synthesizeDialogue = async function synthesizeDialogue(req) {
      const model = pickModel(req.model);
      const speakers = new Set(req.turns.map((t) => t.voice));
      if (speakers.size > 2) throw new Error('native dialogue allows at most two voices (use OPENROUTER_TTS_DIALOGUE=emulate for more)');
      const body = {
        model,
        response_format: isPcmModel(model) ? 'pcm' : 'mp3',
        input: req.turns.map((t) => ({ text: t.text, voice: t.voice, ...((t.tone || req.tone) ? { instructions: t.tone || req.tone } : {}) })),
      };
      return speak(body, model);
    };
  }
  return provider;
}

module.exports = { create };
