// Audio treatments for previews, done in the browser (no ffmpeg). The station applies the real ffmpeg presets with the same
// names (chips-voice/googleTextToSpeech1/lib/fx.js); these are close enough to choose by ear, not identical.
// All functions take and return mono Float32Array samples at RATE.
import { RATE } from './mixer.js';

const TAU = 2 * Math.PI;

// RBJ biquad filters.
function biquad(x, type, f, q = 0.707) {
  const w = TAU * Math.min(f, RATE / 2 - 100) / RATE; const alpha = Math.sin(w) / (2 * q); const cos = Math.cos(w);
  let b0; let b1; let b2;
  if (type === 'lp') { b0 = (1 - cos) / 2; b1 = 1 - cos; b2 = (1 - cos) / 2; } else { b0 = (1 + cos) / 2; b1 = -(1 + cos); b2 = (1 + cos) / 2; }
  const a0 = 1 + alpha; const a1 = -2 * cos; const a2 = 1 - alpha;
  const out = new Float32Array(x.length);
  let x1 = 0; let x2 = 0; let y1 = 0; let y2 = 0;
  for (let i = 0; i < x.length; i++) {
    const y = (b0 * x[i] + b1 * x1 + b2 * x2 - a1 * y1 - a2 * y2) / a0;
    x2 = x1; x1 = x[i]; y2 = y1; y1 = y; out[i] = y;
  }
  return out;
}
const lowpass = (x, f) => biquad(x, 'lp', f);
const highpass = (x, f) => biquad(x, 'hp', f);
const band = (x, lo, hi) => lowpass(highpass(x, lo), hi);

// Echo with feedback; the tail extends the clip.
function echo(x, ms, feedback, mixAmount, tailSeconds = 0.6) {
  const delay = Math.round(ms / 1000 * RATE);
  const out = new Float32Array(x.length + Math.round(tailSeconds * RATE));
  for (let i = 0; i < out.length; i++) {
    const dry = i < x.length ? x[i] : 0;
    out[i] = dry + (i >= delay ? out[i - delay] * feedback * mixAmount : 0);
  }
  return out;
}
const soft = (x, drive) => x.map((v) => Math.tanh(v * drive) / Math.tanh(drive));
const ringMod = (x, f, amount) => x.map((v, i) => v * (1 - amount) + v * Math.sin(TAU * f * i / RATE) * amount);
const noise = (x, amp) => x.map((v) => v + (Math.random() * 2 - 1) * amp);
// Plays back faster or slower: changes pitch and length together.
function resample(x, ratio) {
  const out = new Float32Array(Math.max(1, Math.floor(x.length / ratio)));
  for (let i = 0; i < out.length; i++) {
    const pos = i * ratio; const i0 = Math.floor(pos); const frac = pos - i0;
    out[i] = (x[i0] || 0) * (1 - frac) + (x[i0 + 1] || 0) * frac;
  }
  return out;
}
const chorus = (x) => {
  const out = new Float32Array(x.length);
  for (let i = 0; i < x.length; i++) {
    const d1 = Math.round((0.020 + 0.004 * Math.sin(TAU * 0.7 * i / RATE)) * RATE); const d2 = Math.round((0.032 + 0.005 * Math.sin(TAU * 0.5 * i / RATE + 1)) * RATE);
    out[i] = x[i] * 0.6 + (x[i - d1] || 0) * 0.35 + (x[i - d2] || 0) * 0.3;
  }
  return out;
};

export const FX_PREVIEWS = {
  telephone: { label: 'Telephone', run: (x) => soft(band(x, 300, 3400), 2.5) },
  radio: { label: 'Radio', run: (x) => soft(band(x, 250, 5000), 1.6) },
  walkie: { label: 'Walkie-talkie', run: (x) => noise(soft(band(x, 400, 2800), 4), 0.01) },
  megaphone: { label: 'Megaphone', run: (x) => soft(band(x, 500, 4000), 6) },
  robot: { label: 'Robot', run: (x) => echo(ringMod(x, 55, 0.7), 18, 0.35, 1, 0.2) },
  alien: { label: 'Alien', run: (x) => ringMod(resample(x, 1.1), 130, 0.55) },
  cave: { label: 'Cave', run: (x) => echo(echo(x, 130, 0.5, 1, 1.2), 270, 0.35, 1, 0.5) },
  underwater: { label: 'Underwater', run: (x) => lowpass(x.map((v, i) => v * (0.8 + 0.2 * Math.sin(TAU * 3 * i / RATE))), 700) },
  deep: { label: 'Deep voice', run: (x) => resample(x, 0.82) },
  demon: { label: 'Demon', run: (x) => echo(soft(resample(x, 0.7), 2), 70, 0.4, 1, 0.5) },
  chipmunk: { label: 'Chipmunk', run: (x) => resample(x, 1.35) },
  chorus: { label: 'Chorus', run: (x) => chorus(x) },
  hull: { label: 'Ship hull (CHIP)', run: (x) => noise(echo(lowpass(highpass(x, 90), 7500), 45, 0.18, 1, 0.3), 0.003) },
  underground: { label: 'Underground (KRAP)', run: (x) => noise(echo(soft(band(x, 85, 9000), 1.8), 60, 0.12, 1, 0.3), 0.005) },
};
export const fxNames = () => Object.keys(FX_PREVIEWS);

// Applies a preset by name; an unknown or empty name returns the audio unchanged. Output is scaled to avoid clipping.
export function applyFx(samples, name) {
  const fx = FX_PREVIEWS[name];
  if (!fx) return samples;
  const out = fx.run(samples);
  let peak = 0;
  for (let i = 0; i < out.length; i++) peak = Math.max(peak, Math.abs(out[i]));
  if (peak > 0.98) for (let i = 0; i < out.length; i++) out[i] *= 0.98 / peak;
  return out;
}
