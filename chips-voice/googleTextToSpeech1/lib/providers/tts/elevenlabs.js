// ElevenLabs, including your voice clones and multi-speaker dialogue.
//   ELEVENLABS_API_KEY
//   ELEVENLABS_VOICES   named voices: "Rocky=5amD...,Britta=DOg6..." (the names appear in the voice picker and in dialogue)
//   ELEVENLABS_VOICE_ID default voice (a name above or a raw voice id)
//   ELEVENLABS_MODEL    default eleven_v3 (audio tags like [softly] and [laughs] work in text)
//   ELEVENLABS_STABILITY 0-1, default 0.5
//   ELEVENLABS_BASE_URL
// Output is MP3. Dialogue uses /v1/text-to-dialogue; scripts longer than the API limit are split into parts and joined with ffmpeg.
const { request } = require('../http');
const audio = require('../../audio');

const FORMAT = 'mp3_44100_128';

function parsePresets(text) {
  const map = {};
  for (const pair of String(text || '').split(',')) {
    const i = pair.indexOf('=');
    if (i > 0) map[pair.slice(0, i).trim()] = pair.slice(i + 1).trim();
  }
  return map;
}

// Groups turns so each request stays under the API's character limit.
function chunkTurns(turns, limit) {
  const groups = [];
  let current = [];
  let size = 0;
  for (const turn of turns) {
    if (current.length && size + turn.text.length > limit) { groups.push(current); current = []; size = 0; }
    current.push(turn);
    size += turn.text.length;
  }
  if (current.length) groups.push(current);
  return groups;
}

function create(env, deps = {}) {
  const base = (env.ELEVENLABS_BASE_URL || 'https://api.elevenlabs.io').replace(/\/+$/, '');
  const presets = parsePresets(env.ELEVENLABS_VOICES);
  const model = env.ELEVENLABS_MODEL || 'eleven_v3';
  const stability = Number(env.ELEVENLABS_STABILITY || 0.5);
  const chunkLimit = Number(env.ELEVENLABS_DIALOGUE_CHUNK || 2000);
  const join = deps.concatMp3 || audio.concatMp3;
  const headers = () => ({ 'xi-api-key': env.ELEVENLABS_API_KEY, Accept: 'audio/mpeg' });
  const resolve = (voice) => presets[voice] || voice;
  const requireKey = () => { if (!env.ELEVENLABS_API_KEY) throw new Error('ELEVENLABS_API_KEY is not set'); };

  async function speakLine(voice, text) {
    return request(`${base}/v1/text-to-speech/${encodeURIComponent(resolve(voice))}?output_format=${FORMAT}`, {
      method: 'POST', headers: headers(), binary: true, timeoutMs: 300000,
      body: { text, model_id: model, voice_settings: { stability } },
    });
  }

  async function dialogueChunk(turns) {
    return request(`${base}/v1/text-to-dialogue?output_format=${FORMAT}`, {
      method: 'POST', headers: headers(), binary: true, timeoutMs: 300000,
      body: { model_id: model, inputs: turns.map((t) => ({ text: t.text, voice_id: resolve(t.voice) })), settings: { stability } },
    });
  }

  return {
    name: 'elevenlabs',
    capabilities: { ssml: false, pitch: false, rate: false, gain: false, dialogue: true },
    defaultVoice: env.ELEVENLABS_VOICE_ID || Object.keys(presets)[0] || '',
    presets,

    async listVoices() {
      const named = Object.keys(presets).map((name) => ({ id: name, name, language: '', gender: '' }));
      if (!env.ELEVENLABS_API_KEY) return named;
      const res = await request(`${base}/v1/voices`, { headers: headers() });
      const own = (res.voices || []).map((v) => ({ id: v.voice_id, name: v.name, language: '', gender: '' }));
      return [...named, ...own.filter((v) => !Object.values(presets).includes(v.id))];
    },

    async synthesize(req) {
      requireKey();
      if (req.ssmlMode) throw new Error('elevenlabs does not support SSML (use audio tags like [softly] in the text)');
      const voice = req.voice || this.defaultVoice;
      if (!voice) throw new Error('choose an ElevenLabs voice (or set ELEVENLABS_VOICES / ELEVENLABS_VOICE_ID)');
      return { audio: await speakLine(voice, req.text), ext: 'mp3' };
    },

    // turns: [{ voice, text }]; the voice may be a name from ELEVENLABS_VOICES or a raw voice id.
    async synthesizeDialogue(req) {
      requireKey();
      const turns = req.turns;
      const unknown = turns.find((t) => !t.voice);
      if (unknown) throw new Error('every dialogue line needs a voice');
      const parts = [];
      for (const group of chunkTurns(turns, chunkLimit)) {
        try {
          parts.push(await dialogueChunk(group));
        } catch (err) {
          // Same fallback as the KRAP scripts: if the dialogue endpoint refuses, voice each line on its own.
          const lines = [];
          for (const t of group) lines.push(await speakLine(t.voice, t.text));
          parts.push(await join(lines, 0.25));
        }
      }
      return { audio: await join(parts, 0.5), ext: 'mp3' };
    },
  };
}

module.exports = { create, chunkTurns, parsePresets };
