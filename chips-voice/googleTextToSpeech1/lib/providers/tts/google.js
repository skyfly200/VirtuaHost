// Google Cloud Text-to-Speech. Uses GOOGLE_APPLICATION_CREDENTIALS.
const ENCODINGS = { OGG_OPUS: 'ogg', MP3: 'mp3', LINEAR16: 'wav' };

function create(env, deps = {}) {
  let client = deps.client;
  const getClient = () => {
    if (!client) client = new (require('@google-cloud/text-to-speech').TextToSpeechClient)();
    return client;
  };

  return {
    name: 'google',
    capabilities: { ssml: true, pitch: true, rate: true, gain: true },
    defaultVoice: env.GOOGLE_TTS_VOICE || 'en-US-Wavenet-A',

    async listVoices() {
      const [res] = await getClient().listVoices({});
      return (res.voices || []).map((v) => ({
        id: v.name, language: (v.languageCodes || [])[0] || '', gender: v.ssmlGender || '',
      }));
    },

    async synthesize(req) {
      const format = ENCODINGS[req.format] ? req.format : 'OGG_OPUS';
      const voice = {
        languageCode: req.language || (req.voice || '').slice(0, 5) || 'en-US',
        name: req.voice || this.defaultVoice,
      };
      if (req.gender) voice.ssmlGender = req.gender;
      const input = req.ssmlMode ? { ssml: req.ssml } : { text: req.text };
      const [response] = await getClient().synthesizeSpeech({
        input,
        voice,
        audioConfig: {
          audioEncoding: format,
          speakingRate: req.rate || 1.0,
          pitch: req.pitch === undefined ? 0 : req.pitch,
          volumeGainDb: req.gain === undefined ? 3.0 : req.gain,
        },
      });
      return { audio: Buffer.from(response.audioContent, 'binary'), ext: ENCODINGS[format] };
    },
  };
}

module.exports = { create };
