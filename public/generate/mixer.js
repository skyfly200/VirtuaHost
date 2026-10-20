// Mixes a previewed clip in the browser: speech pieces plus [sfx:name] sound effects become one WAV, so what you hear in
// the preview is exactly what gets saved. The effects are synthesised here (no files, no copyright questions); they are
// close to, not identical to, the ffmpeg versions the Chips Voice server and the premix Action use.
//
//   [sfx:ding]            between the speech before and after the tag
//   [sfx:whoosh over]     over the start of the speech that follows
//   [sfx:crowd vol=0.5]   quieter (0 to 2)         [sfx:beep wait=0.5]   then pause (0 to 5 seconds)
export const RATE = 44100;

const TAG = /\[\s*sfx\s*:\s*([a-z0-9_-]{1,40})((?:\s+[a-z]+(?:=[0-9.]+)?){0,4})\s*\]/gi;
const clamp = (n, lo, hi) => Math.min(hi, Math.max(lo, n));

// Text with tags -> alternating { type: 'speech', text } and { type: 'sfx', name, vol, over, wait }.
export function parseTags(text) {
  const pieces = [];
  let last = 0;
  for (const m of text.matchAll(TAG)) {
    if (m.index > last) pieces.push({ type: 'speech', text: text.slice(last, m.index) });
    const opts = { type: 'sfx', name: m[1].toLowerCase(), vol: 1, over: false, wait: 0 };
    for (const tok of m[2].trim().split(/\s+/).filter(Boolean)) {
      const [key, val] = tok.toLowerCase().split('=');
      const num = Number(val);
      if (key === 'over' && val === undefined) opts.over = true;
      else if (key === 'vol' && val !== undefined && Number.isFinite(num)) opts.vol = clamp(num, 0, 2);
      else if (key === 'wait' && val !== undefined && Number.isFinite(num)) opts.wait = clamp(num, 0, 5);
      else throw new Error(`Unknown sound effect option "${tok}" in [sfx:${m[1]}] (use over, vol=0-2, wait=0-5)`);
    }
    pieces.push(opts);
    last = m.index + m[0].length;
  }
  if (last < text.length) pieces.push({ type: 'speech', text: text.slice(last) });
  const out = pieces.map((p) => (p.type === 'speech' ? { ...p, text: p.text.trim() } : p)).filter((p) => p.type === 'sfx' || p.text);
  for (const p of out) if (p.type === 'speech' && /\[\s*sfx\s*:/i.test(p.text)) throw new Error('A sound effect tag is malformed (use [sfx:name], for example [sfx:ding])');
  return out;
}

// ----- synthesised effects -----
const make = (seconds, fn) => { const out = new Float32Array(Math.round(seconds * RATE)); for (let i = 0; i < out.length; i++) out[i] = fn(i / RATE); return out; };
const noise = (seconds, amp, color = 'white') => {
  let b0 = 0; let b1 = 0; let b2 = 0; let brown = 0;
  return make(seconds, () => {
    const w = Math.random() * 2 - 1;
    if (color === 'pink') { b0 = 0.99765 * b0 + w * 0.099046; b1 = 0.963 * b1 + w * 0.2965164; b2 = 0.57 * b2 + w * 1.0526913; return amp * 0.3 * (b0 + b1 + b2 + w * 0.1848); }
    if (color === 'brown') { brown = (brown + 0.02 * w) / 1.02; return amp * 3.5 * brown; }
    return amp * w;
  });
};
const lowpass = (x, fc) => { const a = 1 - Math.exp(-2 * Math.PI * fc / RATE); let y = 0; return x.map((v) => (y += a * (v - y))); };
const highpass = (x, fc) => { const low = lowpass(x, fc); return x.map((v, i) => v - low[i]); };
const shape = (x, fn) => x.map((v, i) => v * fn(i / RATE, x.length / RATE));
const fadeIn = (d) => (t) => Math.min(1, t / d);
const fadeOut = (d) => (t, len) => clamp((len - t) / d, 0, 1);
const both = (a, b) => (t, len) => a(t, len) * b(t, len);
const gain = (x, g) => x.map((v) => v * g);
const sine = (f, d, amp = 1) => make(d, (t) => amp * Math.sin(2 * Math.PI * f * t));
const mod = (a, b) => ((a % b) + b) % b;

export const EFFECTS = {
  ding: () => gain(shape(sine(1320, 1.2), (t) => Math.exp(-4 * t)), 0.7),
  chime: () => gain(make(1.6, (t) => 0.5 * Math.sin(2 * Math.PI * 880 * t) * Math.exp(-4 * t) + (t >= 0.25 ? 0.4 * Math.sin(2 * Math.PI * 1320 * t) * Math.exp(-3 * t) : 0)), 0.9),
  beep: () => gain(shape(sine(1000, 0.25), both(fadeIn(0.01), (t, len) => fadeOut(0.05)(t, len))), 0.5),
  buzzer: () => shape(make(0.7, (t) => 0.35 * Math.sin(2 * Math.PI * 120 * t) + 0.2 * Math.sin(2 * Math.PI * 240 * t) + 0.1 * Math.sin(2 * Math.PI * 360 * t)), fadeOut(0.1)),
  whoosh: () => gain(shape(highpass(lowpass(noise(1.4, 0.6), 2500), 200), both(fadeIn(0.6), fadeOut(0.8))), 0.8),
  riser: () => shape(make(2, (t) => 0.4 * Math.sin(2 * Math.PI * (220 + 500 * t) * t)), both(fadeIn(1.2), fadeOut(0.2))),
  fall: () => shape(make(1.5, (t) => 0.4 * Math.sin(2 * Math.PI * (1200 - 500 * t) * t)), fadeOut(0.4)),
  laser: () => shape(make(0.4, (t) => 0.5 * Math.sin(2 * Math.PI * (2000 - 4000 * t) * t)), fadeOut(0.1)),
  static: () => gain(shape(lowpass(highpass(noise(1, 0.5), 2000), 4000), fadeOut(0.3)), 0.8),
  click: () => shape(highpass(noise(0.06, 0.7), 1000), (t) => Math.exp(-t / 0.015)),
  heartbeat: () => gain(make(1.8, (t) => 0.9 * Math.sin(2 * Math.PI * 60 * t) * (Math.exp(-20 * mod(t, 0.8)) + 0.7 * Math.exp(-20 * mod(t + 0.55, 0.8)))), 0.9),
  alarm: () => shape(make(2, (t) => 0.4 * Math.sin(2 * Math.PI * (900 + (mod(t, 0.5) < 0.25 ? 400 : 0)) * t)), fadeOut(0.2)),
  phone: () => shape(make(2, (t) => (mod(t, 2) < 0.4 ? 0.35 * (Math.sin(2 * Math.PI * 440 * t) + Math.sin(2 * Math.PI * 480 * t)) : 0)), fadeOut(0.1)),
  drumroll: () => gain(shape(lowpass(noise(2, 0.9, 'brown'), 900), (t) => fadeIn(1)(t) * (0.55 + 0.45 * Math.sin(2 * Math.PI * 22 * t))), 2),
  crowd: () => gain(shape(lowpass(highpass(noise(3, 0.7, 'pink'), 800), 6000), (t, len) => fadeIn(0.3)(t) * fadeOut(1)(t, len) * (0.75 + 0.25 * Math.sin(2 * Math.PI * 9 * t))), 0.9),
};
export const effectNames = () => Object.keys(EFFECTS);

// ----- assembling -----
// items: { kind: 'speech', samples } | { kind: 'sfx', name, vol, over, wait }; speech is mono Float32Array at RATE.
export function mix(items) {
  const parts = [];
  let over = [];
  items.forEach((item, i) => {
    const samples = item.kind === 'speech' ? item.samples : gain(EFFECTS[item.name](), item.vol);
    if (item.kind === 'sfx' && item.over && i < items.length - 1) { over.push(samples); return; }
    let slot = samples;
    if (over.length) {
      const len = Math.max(samples.length, ...over.map((o) => o.length));
      slot = new Float32Array(len);
      for (const src of [samples, ...over]) for (let n = 0; n < src.length; n++) slot[n] += src[n];
      over = [];
    }
    parts.push(slot);
    if (item.kind === 'sfx' && item.wait > 0) parts.push(new Float32Array(Math.round(item.wait * RATE)));
  });
  const out = new Float32Array(parts.reduce((n, p) => n + p.length, 0));
  let at = 0;
  for (const p of parts) { out.set(p, at); at += p.length; }
  let peak = 0;
  for (let n = 0; n < out.length; n++) peak = Math.max(peak, Math.abs(out[n]));
  if (peak > 0.98) for (let n = 0; n < out.length; n++) out[n] *= 0.98 / peak;
  return out;
}

// 16-bit mono WAV.
export function toWav(samples) {
  const view = new DataView(new ArrayBuffer(44 + samples.length * 2));
  const text = (at, s) => { for (let i = 0; i < s.length; i++) view.setUint8(at + i, s.charCodeAt(i)); };
  text(0, 'RIFF'); view.setUint32(4, 36 + samples.length * 2, true); text(8, 'WAVE'); text(12, 'fmt ');
  view.setUint32(16, 16, true); view.setUint16(20, 1, true); view.setUint16(22, 1, true);
  view.setUint32(24, RATE, true); view.setUint32(28, RATE * 2, true); view.setUint16(32, 2, true); view.setUint16(34, 16, true);
  text(36, 'data'); view.setUint32(40, samples.length * 2, true);
  for (let i = 0; i < samples.length; i++) view.setInt16(44 + i * 2, Math.round(clamp(samples[i], -1, 1) * 32767), true);
  return new Uint8Array(view.buffer);
}
