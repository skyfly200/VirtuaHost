const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawnSync } = require('child_process');
const { createSfx, parseTags, hasTags, stripTags, BUILTIN, SfxError } = require('../lib/sfx');
const { createClips, SpecError } = require('../lib/clips');
const { createStore } = require('../lib/store');
const audio = require('../lib/audio');
const { sniff } = require('../lib/ingest');

const HAVE = audio.ffmpegAvailable();
const skip = !HAVE && 'ffmpeg not installed';
const tmp = () => fs.mkdtempSync(path.join(os.tmpdir(), 'sfx-'));
const newSfx = () => createSfx({ dir: path.join(tmp(), 'lib'), builtinDir: path.join(tmp(), 'builtin') });

function tone(seconds, freq = 220) {                    // a real MP3 of known length
  const out = path.join(tmp(), 't.mp3');
  const r = spawnSync('ffmpeg', ['-y', '-loglevel', 'error', '-f', 'lavfi', '-i', `sine=frequency=${freq}:duration=${seconds}`, '-ar', '44100', '-ac', '1', out]);
  if (r.status !== 0) throw new Error(String(r.stderr));
  return fs.readFileSync(out);
}
function seconds(buf) {
  const f = path.join(tmp(), 'd.mp3'); fs.writeFileSync(f, buf);
  return parseFloat(spawnSync('ffprobe', ['-v', 'error', '-show_entries', 'format=duration', '-of', 'csv=p=0', f], { encoding: 'utf8' }).stdout);
}
const near = (a, b, tol = 0.25) => assert.ok(Math.abs(a - b) <= tol, `${a} is not within ${tol} of ${b}`);

test('tags are found, parsed with options, and stripped; other [tags] are left alone', () => {
  assert.deepStrictEqual(parseTags('Hi [sfx:ding] there'), [{ type: 'speech', text: 'Hi ' }, { type: 'sfx', name: 'ding', vol: 1, over: false, wait: 0 }, { type: 'speech', text: ' there' }]);
  const [, a, , b, , c] = parseTags('x [sfx:whoosh over vol=0.5] y [SFX: Beep wait=1.5 ] z [sfx:crowd vol=9] w');
  assert.deepStrictEqual([a.name, a.over, a.vol, b.name, b.wait, c.vol], ['whoosh', true, 0.5, 'beep', 1.5, 2]);   // vol clamped to 2
  assert.throws(() => parseTags('[sfx:ding loud]'), /unknown sound effect option "loud"/);
  assert.deepStrictEqual(parseTags('[sfx:ding vol=abc]'), [{ type: 'speech', text: '[sfx:ding vol=abc]' }]);     // not a valid tag: left as text here, refused by plan()
  assert.throws(() => newSfx().plan({ text: 'Hi [sfx:ding vol=abc] there' }), /malformed/);
  assert.strictEqual(stripTags('Hi [sfx:ding]   there [laughs] ok'), 'Hi there [laughs] ok');       // [laughs] is an ElevenLabs audio tag, not ours
  assert.deepStrictEqual([hasTags('[laughs] [softly]'), hasTags('a [SFX:Ding] b')], [false, true]);
});

test('planning: single voice, dialogue grouping, and every kind of mistake', () => {
  const sfx = newSfx();
  const single = sfx.plan({ text: 'Welcome [sfx:ding] friends [sfx:whoosh over vol=0.4] and more [sfx:beep wait=1]' });
  assert.deepStrictEqual(single, [
    { kind: 'speech', text: 'Welcome' }, { kind: 'sfx', name: 'ding', vol: 1, over: false, wait: 0 }, { kind: 'speech', text: 'friends' },
    { kind: 'sfx', name: 'whoosh', vol: 0.4, over: true, wait: 0 }, { kind: 'speech', text: 'and more' }, { kind: 'sfx', name: 'beep', vol: 1, over: false, wait: 1 }]);
  assert.strictEqual(sfx.plan({ text: 'No tags, and [laughs] is fine' }), null);
  const dlg = sfx.plan({ turns: [{ voice: 'R', text: '[sfx:chime]' }, { voice: 'R', text: 'Welcome back [sfx:ding] folks.', tone: 'warm' }, { voice: 'B', text: 'Thanks!' }, { voice: 'B', text: '[sfx:crowd]' }, { voice: 'R', text: 'Bye' }] });
  assert.deepStrictEqual(dlg.map((i) => i.kind + ':' + (i.name || i.turns.map((t) => `${t.voice}=${t.text}`).join('|'))), [
    'sfx:chime', 'speech:R=Welcome back', 'sfx:ding', 'speech:R=folks.|B=Thanks!', 'sfx:crowd', 'speech:R=Bye']);
  assert.strictEqual(dlg[1].turns[0].tone, 'warm');                                                // the line's delivery direction survives the split
  assert.throws(() => sfx.plan({ text: 'x [sfx:nosuchsound]' }), /unknown sound effect "nosuchsound" \(available: .*ding/);
  assert.throws(() => sfx.plan({ text: '[sfx:ding]' }), /needs some speech/);
  assert.throws(() => sfx.plan({ text: 'a [sfx:Ding!] b' }), /malformed/);
  assert.throws(() => sfx.plan({ ssmlMode: true, ssml: '<speak>[sfx:ding]</speak>' }), /not supported in SSML/);
  assert.throws(() => sfx.plan({ text: 'a' + ' [sfx:click]'.repeat(21) }), /too many sound effects/);
});

test('every built-in effect is synthesized into a valid, short, non-silent MP3 (real ffmpeg)', { skip }, async () => {
  const sfx = newSfx();
  assert.ok(Object.keys(BUILTIN).length >= 15);
  for (const name of Object.keys(BUILTIN)) {
    const file = await sfx.file(name);
    const buf = fs.readFileSync(file);
    assert.strictEqual(sniff(buf), 'mp3', name);
    const d = seconds(buf);
    assert.ok(d > 0.04 && d < 4, `${name}: duration ${d}`);
    // not silent: mean volume above -60 dB
    const v = spawnSync('ffmpeg', ['-i', file, '-af', 'volumedetect', '-f', 'null', '-'], { encoding: 'utf8' }).stderr;
    const mean = parseFloat((v.match(/mean_volume: (-?[\d.]+) dB/) || [])[1]);
    assert.ok(mean > -60, `${name}: mean volume ${mean}`);
  }
  assert.strictEqual(await sfx.file('ding'), await sfx.file('ding'));                              // generated once, then reused
});

test('uploaded effects: validated, converted, listed, override built-ins, removable (real ffmpeg)', { skip }, async () => {
  const sfx = newSfx();
  await assert.rejects(sfx.put('Bad Name!', tone(1)), /name must be/);
  await assert.rejects(sfx.put('x', Buffer.from('not audio, definitely just text here')), /unsupported audio/);
  await assert.rejects(sfx.put('x', Buffer.alloc(0)), /no audio/);
  await assert.rejects(createSfx({ dir: path.join(tmp(), 'l'), builtinDir: tmp(), maxBytes: 100 }).put('x', tone(1)), /too large/);
  const saved = await sfx.put('Station-Jingle', tone(2));
  assert.deepStrictEqual(saved.name, 'station-jingle');
  const listed = sfx.list();
  assert.deepStrictEqual(listed.find((e) => e.name === 'station-jingle'), { name: 'station-jingle', source: 'uploaded', label: 'station-jingle', overridesBuiltin: false });
  assert.strictEqual(listed.find((e) => e.name === 'ding').source, 'built-in');
  await sfx.put('ding', tone(0.5, 900));                                                            // an upload replaces the built-in of that name
  assert.deepStrictEqual([sfx.list().find((e) => e.name === 'ding').source, sfx.list().find((e) => e.name === 'ding').overridesBuiltin], ['uploaded', true]);
  near(seconds(fs.readFileSync(await sfx.file('ding'))), 0.5, 0.15);
  assert.ok(sfx.remove('ding') && !sfx.remove('ding'));
  assert.strictEqual(sfx.list().find((e) => e.name === 'ding').source, 'built-in');                // built-in is back
  assert.strictEqual(sfx.remove('station-jingle'), true);
  assert.strictEqual(sfx.has('station-jingle'), false);
});

test('mixing: effects go between the speech, over the start of the next piece, or with a pause (real ffmpeg)', { skip }, async () => {
  const sfx = newSfx();
  const beep = await sfx.file('beep');                                                              // 0.25 s
  const speech = (s) => ({ kind: 'speech', buffer: tone(s) });
  const inline = await sfx.assemble([speech(1), { kind: 'sfx', path: beep, vol: 1, over: false, wait: 0 }, speech(1)]);
  assert.strictEqual(sniff(inline), 'mp3');
  near(seconds(inline), 2.25);                                                                      // 1 + 0.25 + 1
  const paused = await sfx.assemble([speech(1), { kind: 'sfx', path: beep, vol: 1, over: false, wait: 0.5 }, speech(1)]);
  near(seconds(paused), 2.75);                                                                      // plus the half-second pause
  const over = await sfx.assemble([{ kind: 'sfx', path: beep, vol: 1, over: true, wait: 0 }, speech(1)]);
  near(seconds(over), 1);                                                                           // mixed in, no extra time
  const intro = await sfx.assemble([{ kind: 'sfx', path: beep, vol: 0.2, over: false, wait: 0 }, speech(1)]);
  near(seconds(intro), 1.25);
  const outroOver = await sfx.assemble([speech(1), { kind: 'sfx', path: beep, vol: 1, over: true, wait: 0 }]);   // nothing after it: plays after
  near(seconds(outroOver), 1.25);
  const solo = await sfx.assemble([speech(1.5)]);
  near(seconds(solo), 1.5);
  // volume really changes the level
  const loud = await sfx.assemble([{ kind: 'sfx', path: beep, vol: 2, over: false, wait: 0 }]);
  const quiet = await sfx.assemble([{ kind: 'sfx', path: beep, vol: 0.1, over: false, wait: 0 }]);
  const mean = (b) => { const f = path.join(tmp(), 'm.mp3'); fs.writeFileSync(f, b); return parseFloat((spawnSync('ffmpeg', ['-i', f, '-af', 'volumedetect', '-f', 'null', '-'], { encoding: 'utf8' }).stderr.match(/mean_volume: (-?[\d.]+)/) || [])[1]); };
  assert.ok(mean(loud) > mean(quiet) + 10, `loud ${mean(loud)} vs quiet ${mean(quiet)}`);
});

function setupClips() {
  const dir = tmp();
  const sfx = newSfx();
  const calls = [];
  const tts = { names: ['fake'], synthesize: async (spec) => {
    calls.push({ text: spec.text, turns: spec.turns && spec.turns.map((t) => `${t.voice}:${t.text}`), ssml: spec.ssmlMode });
    const len = spec.turns ? 1.5 : 1;
    return { audio: tone(len), ext: 'mp3', provider: 'fake' };
  } };
  const clips = createClips({ store: createStore(path.join(dir, 'db.json'), { clips: {} }), tts, dir: path.join(dir, 'a'), sfx });
  return { clips, calls, sfx };
}

test('clips: tagged speech is voiced in pieces and mixed with the effects (real ffmpeg)', { skip }, async () => {
  const { clips, calls } = setupClips();
  const tagged = await clips.getOrCreate({ text: 'Welcome back [sfx:beep] to the show.' });
  assert.deepStrictEqual(calls.map((c) => c.text), ['Welcome back', 'to the show.']);               // tags are never spoken
  assert.strictEqual(tagged.clip.text, 'Welcome back to the show.');
  near(seconds(fs.readFileSync(clips.fileOf(tagged.clip))), 2.25);
  assert.strictEqual(tagged.clip.provider, 'fake');
  const plain = await clips.getOrCreate({ text: 'Welcome back to the show.' });
  assert.notStrictEqual(plain.clip.id, tagged.clip.id);                                             // different clip
  assert.strictEqual((await clips.getOrCreate({ text: 'Welcome back [sfx:beep] to the show.' })).reused, true);
});

test('clips: dialogue with effects, effects before effects, and the effect treatment applied to the whole mix (real ffmpeg)', { skip }, async () => {
  const { clips, calls } = setupClips();
  const made = await clips.getOrCreate({ script: 'Rocky: Hello Britta. [sfx:ding] Ready?\nBritta: Always.', fx: { preset: 'telephone' } });
  assert.deepStrictEqual(calls.map((c) => c.turns), [['Rocky:Hello Britta.'], ['Rocky:Ready?', 'Britta:Always.']]);
  assert.strictEqual(made.clip.spec.fx.preset, 'telephone');
  assert.strictEqual(sniff(fs.readFileSync(clips.fileOf(made.clip))), 'mp3');
  near(seconds(fs.readFileSync(clips.fileOf(made.clip))), 1.5 + 1.2 + 1.5, 0.6);                    // two speech pieces and the 1.2 s ding
});

test('clips: mistakes are refused before any speech is paid for', async () => {
  const { clips, calls } = setupClips();
  await assert.rejects(clips.getOrCreate({ text: 'Hi [sfx:nosuchsound] there' }), (e) => e instanceof SpecError && /unknown sound effect/.test(e.message));
  await assert.rejects(clips.getOrCreate({ ssmlMode: true, ssml: '<speak>Hi [sfx:ding]</speak>' }), /not supported in SSML/);
  await assert.rejects(clips.getOrCreate({ text: '[sfx:ding]' }), /needs some speech/);
  assert.strictEqual(calls.length, 0);
});

test('scripts: a line with only sound effect tags needs no speaker', () => {
  const { normalizeSpec } = require('../lib/clips');
  const spec = normalizeSpec({ script: '[sfx:chime]\nRocky: Welcome back.\n[sfx:ding] [sfx:whoosh over]\nBritta: Thanks!\n[sfx:crowd vol=0.4]', voices: { Rocky: 'R1' } });
  assert.deepStrictEqual(spec.turns.map((t) => `${t.voice}|${t.text}`), ['R1|[sfx:chime]', 'R1|Welcome back.', 'R1|[sfx:ding] [sfx:whoosh over]', 'Britta|Thanks!', 'Britta|[sfx:crowd vol=0.4]']);
  assert.throws(() => normalizeSpec({ script: 'Rocky: ok\nthis line has no speaker' }), /line 2 needs a speaker/);
  const plan = newSfx().plan(spec);
  assert.deepStrictEqual(plan.map((i) => i.kind === 'sfx' ? `sfx:${i.name}` : i.turns.map((t) => t.voice).join(',')), ['sfx:chime', 'R1', 'sfx:ding', 'sfx:whoosh', 'Britta', 'sfx:crowd']);
});
