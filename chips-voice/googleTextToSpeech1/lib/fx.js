// Audio treatment and voice-changer effects, applied with ffmpeg. Options are structured and validated
// (never raw filter strings), so a request cannot inject arbitrary ffmpeg arguments.
//
//   fx = { preset, pitch, speed, tighten, normalize }
//     preset    one of the names in PRESETS ("underground" is the KRAP station sound)
//     pitch     semitones, -12..12 (voice changer); added to the preset's own pitch shift
//     speed     tempo multiplier, 0.5..2, pitch unchanged
//     tighten   trim long pauses (the KRAP "tempo + silence trimming" pass)
//     normalize loudness to -16 LUFS (the KRAP finish); default true for presets
const { spawn } = require('child_process');
const fs = require('fs');
const os = require('os');
const path = require('path');

class FxError extends Error {}

const TEXTURE = 'afftdn=nr=10:nf=-45,highpass=f=85,lowpass=f=9000,equalizer=f=220:t=q:w=1:g=2,'
  + 'equalizer=f=4500:t=q:w=1:g=-2,acompressor=threshold=-20dB:ratio=3:attack=5:release=80:makeup=3,aecho=0.85:0.7:18:0.10';
const SPECTRAL = (re, im) => `afftfilt=real='${re}':imag='${im}':win_size=512:overlap=0.75`;

// chain: ffmpeg audio filters. pitch: extra semitones the preset applies. noise: background hiss mixed in.
const PRESETS = {
  none: { label: 'None', description: 'No effect (use pitch, speed or tighten on their own).', chain: '' },
  underground: {
    label: 'Underground (KRAP)', description: 'The KRAP station sound: noise-reduced, band-limited, warm, compressed, light echo and pink-noise bed.',
    chain: TEXTURE, noise: { color: 'pink', amp: 0.0045, lowpass: 6000 },
  },
  hull: {
    label: 'Ship hull', description: 'Warm tape-and-radio tone, a faint hull echo and a barely-there flutter. Subtle: the voice stays natural.',
    chain: 'highpass=f=90,lowpass=f=7500,equalizer=f=220:t=q:w=1:g=2,vibrato=f=4:d=0.03,acompressor=threshold=-18dB:ratio=3:attack=8:release=120:makeup=3,aecho=0.8:0.6:45|90:0.14|0.08',
    noise: { color: 'pink', amp: 0.002, lowpass: 5000 },
  },
  telephone: { label: 'Telephone', description: 'Narrow phone-line band.', chain: 'highpass=f=300,lowpass=f=3400,acompressor=threshold=-18dB:ratio=4:attack=5:release=60:makeup=4' },
  radio: {
    label: 'AM radio', description: 'Mid-heavy, squeezed, a little hiss.',
    chain: 'highpass=f=180,lowpass=f=4800,equalizer=f=1800:t=q:w=1:g=4,acompressor=threshold=-16dB:ratio=5:attack=3:release=50:makeup=4',
    noise: { color: 'white', amp: 0.003, lowpass: 5000 },
  },
  walkie: {
    label: 'Walkie-talkie', description: 'Crunchy two-way radio.',
    chain: 'highpass=f=400,lowpass=f=2800,acrusher=bits=8:mix=0.4:mode=log,acompressor=threshold=-14dB:ratio=6:attack=2:release=40:makeup=6',
    noise: { color: 'white', amp: 0.006, lowpass: 3000 },
  },
  megaphone: { label: 'Megaphone', description: 'Loud hailer.', chain: 'highpass=f=500,lowpass=f=4000,acrusher=bits=12:mix=0.5,acompressor=threshold=-20dB:ratio=8:makeup=8,alimiter=limit=0.9' },
  robot: { label: 'Robot', description: 'Metallic, monotone.', chain: SPECTRAL('hypot(re,im)*cos(0)', 'hypot(re,im)*sin(0)') },
  whisper: { label: 'Whisper', description: 'Breathy, unvoiced.', chain: SPECTRAL('hypot(re,im)*cos(random(0)*2*PI)', 'hypot(re,im)*sin(random(0)*2*PI)') },
  cave: { label: 'Cave', description: 'Big hollow echo.', chain: 'aecho=0.8:0.88:60|120|240:0.5|0.4|0.3' },
  underwater: { label: 'Underwater', description: 'Muffled and wobbling.', chain: 'lowpass=f=700,vibrato=f=5:d=0.3,aecho=0.8:0.7:40:0.3' },
  chorus: { label: 'Chorus', description: 'Thicker, like several voices.', chain: 'chorus=0.5:0.9:50|60|40:0.4|0.32|0.3:0.25|0.4|0.3:2|2.3|1.3' },
  chipmunk: { label: 'Chipmunk', description: 'Small and squeaky.', chain: '', pitch: 7 },
  deep: { label: 'Deep voice', description: 'Lower, bigger.', chain: 'equalizer=f=120:t=q:w=1:g=3', pitch: -5 },
  alien: { label: 'Alien', description: 'Higher with a warble.', chain: 'vibrato=f=7:d=0.5,aecho=0.6:0.4:20:0.5', pitch: 4 },
  demon: { label: 'Demon', description: 'Low with a menacing echo.', chain: 'aecho=0.8:0.7:30|60:0.4|0.3', pitch: -7 },
};

const clamp = (n, lo, hi) => Math.min(hi, Math.max(lo, n));

// Returns the canonical effect settings, or null when there is nothing to do. Throws FxError on bad input.
function normalizeFx(raw) {
  if (raw === undefined || raw === null || raw === '' || raw === false) return null;
  const input = typeof raw === 'string' ? { preset: raw } : raw;
  if (typeof input !== 'object' || Array.isArray(input)) throw new FxError('fx must be a preset name or an object');
  const preset = input.preset === undefined || input.preset === '' ? 'none' : String(input.preset);
  if (!Object.prototype.hasOwnProperty.call(PRESETS, preset)) {
    throw new FxError(`unknown effect "${preset.slice(0, 40)}" (known: ${Object.keys(PRESETS).join(', ')})`);
  }
  const number = (v, name, lo, hi, fallback) => {
    if (v === undefined || v === null || v === '') return fallback;
    const n = Number(v);
    if (!Number.isFinite(n)) throw new FxError(`${name} must be a number`);
    return clamp(n, lo, hi);
  };
  const flag = (v) => v === true || v === 'true' || v === '1' || v === 1;
  const fx = {
    preset,
    pitch: number(input.pitch, 'pitch', -12, 12, 0),
    speed: number(input.speed, 'speed', 0.5, 2, 1),
    tighten: flag(input.tighten),
    normalize: input.normalize === undefined ? preset !== 'none' : flag(input.normalize),
  };
  const idle = fx.preset === 'none' && fx.pitch === 0 && fx.speed === 1 && !fx.tighten && !fx.normalize;
  return idle ? null : fx;
}

const trim = (n) => String(Number(n.toFixed(5)));

// The ffmpeg -filter_complex string for these settings (input is stream 0, output is MP3).
function buildGraph(fx) {
  const def = PRESETS[fx.preset];
  const steps = ['aresample=44100'];
  if (fx.tighten) steps.push('silenceremove=stop_periods=-1:stop_duration=0.18:stop_threshold=-45dB:stop_silence=0.10');
  if (fx.speed !== 1) steps.push(`atempo=${trim(fx.speed)}`);
  const semitones = clamp(fx.pitch + (def.pitch || 0), -12, 12);
  if (semitones !== 0) {
    const f = 2 ** (semitones / 12);
    // Resample to shift pitch (and speed), then undo the speed change with atempo.
    steps.push(`asetrate=${Math.round(44100 * f)}`, 'aresample=44100', `atempo=${trim(1 / f)}`);
  }
  if (def.chain) steps.push(def.chain);

  let graph = `[0:a]${steps.join(',')}[v]`;
  let last = '[v]';
  if (def.noise) {
    const n = def.noise;
    graph += `;anoisesrc=c=${n.color}:a=${n.amp}:r=44100,lowpass=f=${n.lowpass}[n];[v][n]amix=inputs=2:duration=first:normalize=0[m]`;
    last = '[m]';
  }
  graph += fx.normalize ? `;${last}loudnorm=I=-16:TP=-1.5:LRA=11` : `;${last}anull`;
  return graph;
}

function run(args) {
  return new Promise((resolve, reject) => {
    const child = spawn(process.env.FFMPEG_BIN || 'ffmpeg', ['-y', '-loglevel', 'error', ...args], { stdio: ['ignore', 'ignore', 'pipe'] });
    let stderr = '';
    child.stderr.on('data', (d) => { stderr += d; });
    child.on('error', (err) => reject(err.code === 'ENOENT' ? new Error('ffmpeg is not installed (set FFMPEG_BIN)') : err));
    child.on('close', (code) => (code === 0 ? resolve() : reject(new Error(`ffmpeg failed: ${stderr.slice(0, 300)}`))));
  });
}

// Any audio buffer in, MP3 (128 kbps, the stream bitrate) out.
async function apply(buffer, fx) {
  try {
    return await render(buffer, fx);
  } catch (err) {
    // Loudness normalising can break on silent or extremely short audio (the MP3 encoder then asserts).
    // The effect itself is fine, so fall back to the same settings without the normalising step.
    if (!fx.normalize) throw err;
    return render(buffer, { ...fx, normalize: false });
  }
}

async function render(buffer, fx) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'cv-fx-'));
  try {
    fs.writeFileSync(path.join(dir, 'in'), buffer);
    await run(['-i', path.join(dir, 'in'), '-filter_complex', buildGraph(fx), '-ar', '44100', '-ac', '1', '-c:a', 'libmp3lame', '-b:a', '128k', path.join(dir, 'out.mp3')]);
    return fs.readFileSync(path.join(dir, 'out.mp3'));
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
}

// Effect settings from a URL query (?fx=underground&pitch=2&speed=1.1&tighten=true).
function fxFromQuery(q = {}) {
  if (!q.fx && q.pitch === undefined && q.speed === undefined && q.tighten === undefined) return null;
  return normalizeFx({ preset: q.fx, pitch: q.pitch, speed: q.speed, tighten: q.tighten, normalize: q.normalize });
}

const describe = () => Object.entries(PRESETS).map(([name, p]) => ({ name, label: p.label, description: p.description }));

module.exports = { normalizeFx, buildGraph, apply, fxFromQuery, describe, PRESETS, FxError };
