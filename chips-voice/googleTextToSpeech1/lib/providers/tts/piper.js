// Piper: free, offline neural TTS run as a local command.
//   PIPER_BIN (default "piper"), PIPER_MODELS = comma list of model files (first is the default voice).
// Output is WAV. Speed maps to --length_scale.
const { spawn } = require('child_process');
const fs = require('fs');
const os = require('os');
const path = require('path');

function create(env) {
  const models = (env.PIPER_MODELS || '').split(',').map((s) => s.trim()).filter(Boolean);
  const bin = env.PIPER_BIN || 'piper';
  return {
    name: 'piper',
    capabilities: { ssml: false, pitch: false, rate: true, gain: false },
    defaultVoice: models[0] || '',

    async listVoices() {
      return models.map((id) => ({ id, language: '', gender: '' }));
    },

    async synthesize(req) {
      const model = req.voice || this.defaultVoice;
      if (!model) throw new Error('set PIPER_MODELS to at least one .onnx voice file');
      if (!models.includes(model)) throw new Error('unknown piper voice');
      if (req.ssmlMode) throw new Error('piper does not support SSML');
      const out = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'piper-')), 'out.wav');
      const args = ['--model', model, '--output_file', out, '--length_scale', String(1 / Math.min(4, Math.max(0.25, req.rate || 1)))];
      await new Promise((resolve, reject) => {
        const child = spawn(bin, args, { stdio: ['pipe', 'ignore', 'pipe'] });
        let stderr = '';
        child.stderr.on('data', (d) => { stderr += d; });
        child.on('error', reject);
        child.on('close', (code) => (code === 0 ? resolve() : reject(new Error(`piper exited ${code}: ${stderr.slice(0, 200)}`))));
        child.stdin.end(req.text);
      });
      try {
        return { audio: fs.readFileSync(out), ext: 'wav' };
      } finally {
        fs.rmSync(path.dirname(out), { recursive: true, force: true });
      }
    },
  };
}

module.exports = { create };
