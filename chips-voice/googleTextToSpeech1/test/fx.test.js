const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawnSync } = require('child_process');
const fx = require('../lib/fx');
const audio = require('../lib/audio');
const { sniff } = require('../lib/ingest');

const HAVE_FFMPEG = audio.ffmpegAvailable();
const tmp = () => fs.mkdtempSync(path.join(os.tmpdir(), 'fxtest-'));

// A speech-like test signal: tone bursts, optionally with a long silence between them.
function makeSpeechLike(seconds = 3, withPauses = false) {
  const out = path.join(tmp(), 'in.wav');
  const args = withPauses
    ? ['-f', 'lavfi', '-i', 'sine=frequency=220:duration=1', '-f', 'lavfi', '-i', 'anullsrc=r=24000:cl=mono:d=2',
      '-f', 'lavfi', '-i', 'sine=frequency=330:duration=1', '-filter_complex', '[0:a]aresample=24000[a];[2:a]aresample=24000[c];[a][1:a][c]concat=n=3:v=0:a=1']
    : ['-f', 'lavfi', '-i', `sine=frequency=220:duration=${seconds}`];
  const r = spawnSync('ffmpeg', ['-y', '-loglevel', 'error', ...args, '-ar', '24000', '-ac', '1', out]);
  if (r.status !== 0) throw new Error(String(r.stderr));
  return fs.readFileSync(out);
}
function duration(buf) {
  const f = path.join(tmp(), 'x.mp3'); fs.writeFileSync(f, buf);
  const r = spawnSync('ffprobe', ['-v', 'error', '-show_entries', 'format=duration', '-of', 'csv=p=0', f], { encoding: 'utf8' });
  return parseFloat(r.stdout);
}

test('settings are validated and canonical; nothing to do means null', () => {
  assert.strictEqual(fx.normalizeFx(undefined), null);
  assert.strictEqual(fx.normalizeFx(''), null);
  assert.strictEqual(fx.normalizeFx({ preset: 'none' }), null);
  assert.deepStrictEqual(fx.normalizeFx('underground'), { preset: 'underground', pitch: 0, speed: 1, tighten: false, normalize: true });
  assert.deepStrictEqual(fx.normalizeFx({ pitch: 99, speed: 9 }), { preset: 'none', pitch: 12, speed: 2, tighten: false, normalize: false });   // clamped
  assert.deepStrictEqual(fx.normalizeFx({ speed: 0.1, tighten: 'true', normalize: 'true' }), { preset: 'none', pitch: 0, speed: 0.5, tighten: true, normalize: true });
  assert.throws(() => fx.normalizeFx('nope'), /unknown effect/);
  assert.throws(() => fx.normalizeFx({ preset: 'underground;rm -rf /' }), /unknown effect/);          // no filter injection
  assert.throws(() => fx.normalizeFx({ preset: '__proto__' }), /unknown effect/);
  assert.throws(() => fx.normalizeFx({ pitch: 'high' }), /pitch must be a number/);
  assert.throws(() => fx.normalizeFx([1]), /preset name or an object/);
  assert.deepStrictEqual(fx.fxFromQuery({ fx: 'robot', pitch: '2' }), { preset: 'robot', pitch: 2, speed: 1, tighten: false, normalize: true });
  assert.strictEqual(fx.fxFromQuery({}), null);
  assert.ok(fx.describe().length >= 10 && fx.describe().every((p) => p.name && p.label && p.description));
});

test('the underground preset is the KRAP chain, with tempo and pause trimming available as options', () => {
  const g = fx.buildGraph(fx.normalizeFx({ preset: 'underground', tighten: true, speed: 1.08 }));
  // Same filters as krap-station/krap/gen.py (TEXTURE) and process.py (PRE)
  for (const part of ['silenceremove=stop_periods=-1:stop_duration=0.18:stop_threshold=-45dB:stop_silence=0.10', 'atempo=1.08',
    'afftdn=nr=10:nf=-45,highpass=f=85,lowpass=f=9000,equalizer=f=220:t=q:w=1:g=2,equalizer=f=4500:t=q:w=1:g=-2,acompressor=threshold=-20dB:ratio=3:attack=5:release=80:makeup=3,aecho=0.85:0.7:18:0.10',
    'anoisesrc=c=pink:a=0.0045:r=44100,lowpass=f=6000', 'amix=inputs=2:duration=first:normalize=0', 'loudnorm=I=-16:TP=-1.5:LRA=11']) {
    assert.ok(g.includes(part), `missing: ${part}`);
  }
  assert.ok(!fx.buildGraph(fx.normalizeFx({ pitch: 2 })).includes('loudnorm'));
  assert.match(fx.buildGraph(fx.normalizeFx({ pitch: 12 })), /asetrate=88200,aresample=44100,atempo=0\.5/);
});

for (const name of Object.keys(fx.PRESETS).filter((n) => n !== 'none')) {
  test(`preset "${name}" runs on real audio (ffmpeg)`, { skip: !HAVE_FFMPEG && 'ffmpeg not installed' }, async () => {
    const out = await fx.apply(makeSpeechLike(3), fx.normalizeFx(name));
    assert.strictEqual(sniff(out), 'mp3');
    const d = duration(out);
    assert.ok(d > 1.5 && d < 5, `unexpected duration ${d}`);
  });
}

test('speed, pitch and pause trimming do what they say (ffmpeg)', { skip: !HAVE_FFMPEG && 'ffmpeg not installed' }, async () => {
  const input = makeSpeechLike(4);
  const base = duration(await fx.apply(input, fx.normalizeFx({ pitch: 0.001 })));       // tiny shift just to force processing
  const fast = duration(await fx.apply(input, fx.normalizeFx({ speed: 2 })));
  assert.ok(Math.abs(fast - base / 2) < 0.5, `speed 2: ${fast} vs ${base}`);
  const shifted = duration(await fx.apply(input, fx.normalizeFx({ pitch: 7 })));        // pitch changes without changing length
  assert.ok(Math.abs(shifted - base) < 0.5, `pitch: ${shifted} vs ${base}`);
  const pauses = makeSpeechLike(0, true);
  const kept = duration(await fx.apply(pauses, fx.normalizeFx({ speed: 1.001 })));
  const tightened = duration(await fx.apply(pauses, fx.normalizeFx({ tighten: true })));
  assert.ok(tightened < kept - 0.5, `tighten: ${tightened} vs ${kept}`);
});

test('bad audio fails with a clear error', { skip: !HAVE_FFMPEG && 'ffmpeg not installed' }, async () => {
  await assert.rejects(fx.apply(Buffer.from('not audio at all'), fx.normalizeFx('robot')), /ffmpeg failed/);
});

test('silent or tiny audio still gets the effect (loudness step is skipped if it breaks)', { skip: !HAVE_FFMPEG && 'ffmpeg not installed' }, async () => {
  const silent = path.join(tmp(), 's.wav');
  const r = spawnSync('ffmpeg', ['-y', '-loglevel', 'error', '-f', 'lavfi', '-i', 'anullsrc=r=24000:cl=mono', '-t', '0.05', silent]);
  assert.strictEqual(r.status, 0);
  const out = await fx.apply(fs.readFileSync(silent), fx.normalizeFx('robot'));
  assert.strictEqual(sniff(out), 'mp3');
});
