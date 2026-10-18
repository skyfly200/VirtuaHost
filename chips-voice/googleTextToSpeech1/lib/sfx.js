// Sound effects that scripts can tag and that get mixed into the finished clip.
//
//   [sfx:ding]                 play "ding" here, between the speech before and after the tag
//   [sfx:whoosh over]          play it over the start of the speech that follows (instead of after the speech before)
//   [sfx:crowd vol=0.5]        quieter (0 to 2, default 1)
//   [sfx:beep wait=0.5]        then pause half a second (0 to 5 seconds)
//
// In a dialogue a tag can sit inside a line or on a line of its own ("[sfx:ding]" or "Rocky: [sfx:ding] Welcome!").
// Effects come from two places: a small set of built-in effects synthesized with ffmpeg (no copyright issues), and
// files you upload to SFX_DIR (uploads override a built-in of the same name). Tags are not spoken: they are cut out
// before the text goes to a speech provider, and the speech is generated in separate pieces around them.
const fs = require('fs');
const path = require('path');
const audioLib = require('./audio');
const { sniff } = require('./ingest');

class SfxError extends Error {}

const NAME = /^[a-z0-9_-]{1,40}$/;
const TAG = /\[sfx:\s*([a-z0-9_-]{1,40})((?:\s+[a-z]+(?:=[0-9.]+)?){0,4})\s*\]/gi;
const MAX_TAGS = 20;

// Built-in effects: an ffmpeg source plus filters. All are mono, normalised to sit under speech at default volume.
const chirp = (expr, d) => `aevalsrc='${expr}':d=${d}:s=44100`;
const BUILTIN = {
  ding: { src: 'sine=frequency=1320:duration=1.2:sample_rate=44100', af: 'afade=t=out:st=0:d=1.2:curve=exp,volume=0.7', label: 'Bell ding' },
  chime: { src: chirp('0.5*sin(2*PI*880*t)*exp(-4*t)+0.4*sin(2*PI*1320*t)*exp(-3*t)*gte(t,0.25)', 1.6), af: 'volume=0.9', label: 'Two-note chime' },
  beep: { src: 'sine=frequency=1000:duration=0.25:sample_rate=44100', af: 'afade=t=in:d=0.01,afade=t=out:st=0.2:d=0.05,volume=0.5', label: 'Short beep' },
  buzzer: { src: chirp('0.35*sin(2*PI*120*t)+0.2*sin(2*PI*240*t)+0.1*sin(2*PI*360*t)', 0.7), af: 'afade=t=out:st=0.6:d=0.1', label: 'Wrong-answer buzzer' },
  whoosh: { src: 'anoisesrc=color=white:duration=1.4:amplitude=0.6:sample_rate=44100', af: 'lowpass=f=2500,highpass=f=200,afade=t=in:d=0.6,afade=t=out:st=0.6:d=0.8,volume=0.8', label: 'Air whoosh' },
  riser: { src: chirp('0.4*sin(2*PI*(220+500*t)*t)', 2), af: 'afade=t=in:d=1.2,afade=t=out:st=1.8:d=0.2', label: 'Rising sweep' },
  fall: { src: chirp('0.4*sin(2*PI*(1200-500*t)*t)', 1.5), af: 'afade=t=out:st=1.1:d=0.4', label: 'Falling sweep' },
  laser: { src: chirp('0.5*sin(2*PI*(2000-4000*t)*t)', 0.4), af: 'afade=t=out:st=0.3:d=0.1', label: 'Laser zap' },
  static: { src: 'anoisesrc=color=white:duration=1:amplitude=0.5:sample_rate=44100', af: 'bandpass=f=3000:width_type=h:w=2000,afade=t=out:st=0.7:d=0.3,volume=0.8', label: 'Radio static' },
  click: { src: 'anoisesrc=color=white:duration=0.06:amplitude=0.7:sample_rate=44100', af: 'afade=t=out:st=0:d=0.06:curve=exp,highpass=f=1000', label: 'Click' },
  heartbeat: { src: chirp('0.9*sin(2*PI*60*t)*(exp(-20*mod(t,0.8))+0.7*exp(-20*mod(t+0.55,0.8)))', 1.8), af: 'volume=0.9', label: 'Heartbeat' },
  alarm: { src: chirp('0.4*sin(2*PI*(900+400*lt(mod(t,0.5),0.25))*t)', 2), af: 'afade=t=out:st=1.8:d=0.2', label: 'Two-tone alarm' },
  phone: { src: chirp('0.35*(sin(2*PI*440*t)+sin(2*PI*480*t))*lt(mod(t,2),0.4)', 2), af: 'afade=t=out:st=1.9:d=0.1', label: 'Phone ring' },
  drumroll: { src: 'anoisesrc=color=brown:duration=2:amplitude=0.9:sample_rate=44100', af: 'tremolo=f=22:d=0.9,lowpass=f=900,afade=t=in:d=1,volume=2', label: 'Drum roll' },
  crowd: { src: 'anoisesrc=color=pink:duration=3:amplitude=0.7:sample_rate=44100', af: 'highpass=f=800,lowpass=f=6000,tremolo=f=9:d=0.5,afade=t=in:d=0.3,afade=t=out:st=2:d=1,volume=0.9', label: 'Crowd noise (synthetic)' },
};

const clamp = (n, lo, hi) => Math.min(hi, Math.max(lo, n));

// "[sfx:name opts]" tags in a piece of text -> alternating speech and effect pieces.
function parseTags(text) {
  const pieces = [];
  let last = 0;
  let m;
  const re = new RegExp(TAG.source, 'gi');
  while ((m = re.exec(text)) !== null) {
    if (m.index > last) pieces.push({ type: 'speech', text: text.slice(last, m.index) });
    const opts = { name: m[1].toLowerCase(), vol: 1, over: false, wait: 0 };
    for (const tok of m[2].trim().split(/\s+/).filter(Boolean)) {
      const [key, val] = tok.toLowerCase().split('=');
      if (key === 'over' && val === undefined) opts.over = true;
      else if (key === 'vol' && val !== undefined && Number.isFinite(Number(val))) opts.vol = clamp(Number(val), 0, 2);
      else if (key === 'wait' && val !== undefined && Number.isFinite(Number(val))) opts.wait = clamp(Number(val), 0, 5);
      else throw new SfxError(`unknown sound effect option "${tok}" in [sfx:${m[1]}] (use over, vol=0-2, wait=0-5)`);
    }
    pieces.push({ type: 'sfx', ...opts });
    last = m.index + m[0].length;
  }
  if (last < text.length) pieces.push({ type: 'speech', text: text.slice(last) });
  return pieces;
}

const hasTags = (text) => new RegExp(TAG.source, 'i').test(String(text || ''));
const stripTags = (text) => String(text || '').replace(new RegExp(TAG.source, 'gi'), ' ').replace(/\s{2,}/g, ' ').trim();

function createSfx({ dir, builtinDir, maxBytes = 5e6, audio = audioLib }) {
  fs.mkdirSync(dir, { recursive: true });
  fs.mkdirSync(builtinDir, { recursive: true });
  const libFile = (name) => path.join(dir, `${name}.mp3`);
  const builtinFile = (name) => path.join(builtinDir, `${name}.mp3`);
  const uploaded = () => fs.readdirSync(dir).filter((f) => /\.mp3$/.test(f)).map((f) => f.slice(0, -4)).filter((n) => NAME.test(n));

  const api = {
    SfxError,
    BUILTIN,

    names() { return [...new Set([...Object.keys(BUILTIN), ...uploaded()])].sort(); },
    has(name) { return Object.prototype.hasOwnProperty.call(BUILTIN, name) || fs.existsSync(libFile(name)); },

    list() {
      const mine = new Set(uploaded());
      return api.names().map((name) => ({
        name,
        source: mine.has(name) ? 'uploaded' : 'built-in',
        label: !mine.has(name) && BUILTIN[name] ? BUILTIN[name].label : name,
        overridesBuiltin: mine.has(name) && !!BUILTIN[name],
      }));
    },

    // Path to the effect's audio file; built-ins are synthesized the first time they are needed.
    async file(name) {
      if (!NAME.test(name)) throw new SfxError('invalid sound effect name');
      if (fs.existsSync(libFile(name))) return libFile(name);
      if (!BUILTIN[name]) throw new SfxError(`unknown sound effect "${name}" (available: ${api.names().join(', ')})`);
      const out = builtinFile(name);
      if (!fs.existsSync(out)) {
        const tmp = `${out}.tmp.mp3`;
        await audio.run(['-f', 'lavfi', '-i', BUILTIN[name].src, '-af', BUILTIN[name].af, '-ar', '44100', '-ac', '1', '-c:a', 'libmp3lame', '-b:a', '128k', tmp]);
        fs.renameSync(tmp, out);
      }
      return out;
    },

    // Store an uploaded effect as a short mono MP3.
    async put(name, buffer) {
      const clean = String(name || '').toLowerCase();
      if (!NAME.test(clean)) throw new SfxError('name must be 1-40 characters: letters, digits, - and _');
      if (!buffer || !buffer.length) throw new SfxError('no audio received');
      if (buffer.length > maxBytes) throw new SfxError(`file is too large (max ${Math.round(maxBytes / 1e6)} MB)`);
      if (!sniff(buffer)) throw new SfxError('unsupported audio (send WAV, MP3 or Ogg)');
      const mp3 = await audio.withTempDir(async (tmp) => {
        fs.writeFileSync(path.join(tmp, 'in'), buffer);
        await audio.run(['-i', path.join(tmp, 'in'), '-vn', '-t', '30', '-ar', '44100', '-ac', '1', '-c:a', 'libmp3lame', '-b:a', '128k', path.join(tmp, 'out.mp3')]);
        return fs.readFileSync(path.join(tmp, 'out.mp3'));
      });
      fs.writeFileSync(libFile(clean), mp3);
      return { name: clean, bytes: mp3.length };
    },

    remove(name) {
      if (!NAME.test(name) || !fs.existsSync(libFile(name))) return false;
      fs.rmSync(libFile(name));
      return true;
    },

    // Splits a clip spec into speech and effect items, or returns null when it has no tags.
    // Speech items carry `text` (single voice) or `turns` (dialogue); the spec's other settings apply to every piece.
    plan(spec) {
      const texts = spec.turns ? spec.turns.map((t) => t.text) : [spec.ssmlMode ? spec.ssml : spec.text];
      // Anything that looks like an effect tag, well-formed or not, is checked (a typo must not be read aloud).
      if (!texts.some((t) => hasTags(t) || /\[\s*sfx\s*:/i.test(t))) return null;
      if (spec.ssmlMode) throw new SfxError('sound effects are not supported in SSML mode');
      const items = [];
      let tags = 0;
      const pushSpeech = (turn) => {
        const last = items[items.length - 1];
        if (spec.turns) {
          if (last && last.kind === 'speech') last.turns.push(turn); else items.push({ kind: 'speech', turns: [turn] });
        } else {
          items.push({ kind: 'speech', text: turn.text });
        }
      };
      const sources = spec.turns || [{ text: spec.text }];
      for (const turn of sources) {
        for (const piece of parseTags(turn.text)) {
          if (piece.type === 'speech') {
            if (/\[\s*sfx\s*:/i.test(piece.text)) throw new SfxError('a sound effect tag is malformed (use [sfx:name], for example [sfx:ding])');
            const text = piece.text.trim();
            if (text) pushSpeech({ ...turn, text });
          } else {
            tags += 1;
            if (tags > MAX_TAGS) throw new SfxError(`too many sound effects (max ${MAX_TAGS} per clip)`);
            if (!api.has(piece.name)) throw new SfxError(`unknown sound effect "${piece.name}" (available: ${api.names().join(', ')})`);
            items.push({ kind: 'sfx', name: piece.name, vol: piece.vol, over: piece.over, wait: piece.wait });
          }
        }
      }
      if (!items.some((i) => i.kind === 'speech')) throw new SfxError('a clip needs some speech as well as sound effects');
      return items;
    },

    // items: { kind:'speech', buffer } and { kind:'sfx', path, vol, over, wait } in order. Returns one MP3.
    async assemble(items) {
      return audio.withTempDir(async (dir) => {
        const args = [];
        const prep = [];
        items.forEach((item, i) => {
          const file = item.kind === 'speech' ? path.join(dir, `speech${i}.mp3`) : item.path;
          if (item.kind === 'speech') fs.writeFileSync(file, item.buffer);
          args.push('-i', file);
          prep.push(`[${i}:a]aresample=44100,aformat=channel_layouts=mono${item.kind === 'sfx' && item.vol !== 1 ? `,volume=${item.vol}` : ''}[a${i}]`);
        });
        // Sequence: an "over" effect is mixed into the next item instead of getting its own slot.
        const nodes = [];
        const extra = [];
        let over = [];
        items.forEach((item, i) => {
          if (item.kind === 'sfx' && item.over && i < items.length - 1) { over.push(i); return; }
          if (over.length) {
            extra.push(`[a${i}]${over.map((o) => `[a${o}]`).join('')}amix=inputs=${over.length + 1}:duration=longest:normalize=0[m${i}]`);
            nodes.push(`[m${i}]`);
            over = [];
          } else {
            nodes.push(`[a${i}]`);
          }
          if (item.kind === 'sfx' && item.wait > 0) {
            extra.push(`anullsrc=r=44100:cl=mono,atrim=0:${item.wait}[w${i}]`);
            nodes.push(`[w${i}]`);
          }
        });
        const tail = nodes.length === 1 ? `${nodes[0]}anull` : `${nodes.join('')}concat=n=${nodes.length}:v=0:a=1`;
        const graph = [...prep, ...extra, tail].join(';');
        await audio.run([...args, '-filter_complex', graph, '-ar', '44100', '-ac', '1', '-c:a', 'libmp3lame', '-b:a', '128k', path.join(dir, 'out.mp3')]);
        return fs.readFileSync(path.join(dir, 'out.mp3'));
      });
    },
  };
  return api;
}

module.exports = { createSfx, parseTags, hasTags, stripTags, SfxError, BUILTIN, MAX_TAGS };
