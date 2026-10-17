const test = require('node:test');
const assert = require('node:assert');
const http = require('http');
const { createTts } = require('../lib/providers/tts');
const { chunkTurns, parsePresets } = require('../lib/providers/tts/elevenlabs');
const { createClips, normalizeSpec, SpecError } = require('../lib/clips');
const { createStore } = require('../lib/store');
const fs = require('fs');
const os = require('os');
const path = require('path');

function mock(reply) {
  const seen = [];
  const server = http.createServer((req, res) => {
    let body = '';
    req.on('data', (d) => { body += d; });
    req.on('end', () => {
      seen.push({ method: req.method, url: req.url, headers: req.headers, body });
      const r = reply(req, body, seen.length);
      res.writeHead(r.status || 200, { 'Content-Type': r.type || 'audio/mpeg' });
      res.end(r.raw !== undefined ? r.raw : JSON.stringify(r.json));
    });
  });
  return new Promise((resolve) => server.listen(0, '127.0.0.1', () =>
    resolve({ url: `http://127.0.0.1:${server.address().port}`, seen, close: () => server.close() })));
}

const VOICES = 'Rocky=ROCKYID, Britta=BRITTAID';

test('elevenlabs: named voices resolve to ids, settings are sent, names lead the voice list', async (t) => {
  const api = await mock((req) => (req.url.startsWith('/v1/voices')
    ? { type: 'application/json', json: { voices: [{ voice_id: 'ROCKYID', name: 'dup' }, { voice_id: 'OTHER', name: 'Narrator' }] } }
    : { raw: 'MP3DATA' }));
  t.after(() => api.close());
  const tts = createTts({ TTS_PROVIDER: 'elevenlabs', ELEVENLABS_API_KEY: 'k', ELEVENLABS_BASE_URL: api.url, ELEVENLABS_VOICES: VOICES, ELEVENLABS_STABILITY: '0.3' });
  assert.deepStrictEqual(parsePresets(VOICES), { Rocky: 'ROCKYID', Britta: 'BRITTAID' });
  assert.deepStrictEqual((await tts.listVoices()).map((v) => v.id), ['Rocky', 'Britta', 'OTHER']);   // clone id not listed twice
  assert.strictEqual(tts.providers[0].defaultVoice, 'Rocky');
  const out = await tts.synthesize({ text: '[softly] Hello', voice: 'Britta' });
  assert.strictEqual(out.audio.toString(), 'MP3DATA');
  const call = api.seen[1];
  assert.ok(call.url.startsWith('/v1/text-to-speech/BRITTAID?output_format=mp3_44100_128'));
  assert.deepStrictEqual(JSON.parse(call.body), { text: '[softly] Hello', model_id: 'eleven_v3', voice_settings: { stability: 0.3 } });
  api.close();
});

test('elevenlabs dialogue: one request with named voices; long scripts are split and joined', async (t) => {
  const api = await mock(() => ({ raw: 'PART' }));
  const joined = [];
  const join = async (parts) => { if (parts.length === 1) return parts[0]; joined.push(parts.length); return Buffer.from(parts.map(String).join('+')); };
  const { create } = require('../lib/providers/tts/elevenlabs');
  const el = create({ ELEVENLABS_API_KEY: 'k', ELEVENLABS_BASE_URL: api.url, ELEVENLABS_VOICES: VOICES, ELEVENLABS_DIALOGUE_CHUNK: '30' }, { concatMp3: join });
  const turns = [{ voice: 'Rocky', text: 'Britta, what are we listening to?' }, { voice: 'Britta', text: 'No idea. That is the beauty.' }, { voice: 'Rocky', text: 'Pirate radio.' }];
  const out = await el.synthesizeDialogue({ turns });
  assert.strictEqual(out.ext, 'mp3');
  const first = JSON.parse(api.seen[0].body);
  assert.strictEqual(api.seen[0].url, '/v1/text-to-dialogue?output_format=mp3_44100_128');
  assert.deepStrictEqual(first.inputs, [{ text: turns[0].text, voice_id: 'ROCKYID' }]);   // 30-char limit: one line per request
  assert.strictEqual(api.seen.length, 3);
  assert.deepStrictEqual(joined, [3]);
  assert.deepStrictEqual(chunkTurns(turns, 10000).map((g) => g.length), [3]);
  await assert.rejects(el.synthesizeDialogue({ turns: [{ voice: '', text: 'x' }] }), /needs a voice/);
  api.close();
});

test('elevenlabs dialogue falls back to line by line when the dialogue endpoint refuses', async (t) => {
  const api = await mock((req) => (req.url.startsWith('/v1/text-to-dialogue') ? { status: 422, type: 'application/json', json: { detail: 'no' } } : { raw: 'LINE' }));
  const { create } = require('../lib/providers/tts/elevenlabs');
  const el = create({ ELEVENLABS_API_KEY: 'k', ELEVENLABS_BASE_URL: api.url, ELEVENLABS_VOICES: VOICES }, { concatMp3: async (parts) => (parts.length === 1 ? parts[0] : Buffer.from(`joined:${parts.length}`)) });
  const out = await el.synthesizeDialogue({ turns: [{ voice: 'Rocky', text: 'One.' }, { voice: 'Britta', text: 'Two.' }] });
  assert.strictEqual(out.audio.toString(), 'joined:2');   // the two single lines were joined into one part
  assert.deepStrictEqual(api.seen.map((s) => s.url.split('?')[0]), ['/v1/text-to-dialogue', '/v1/text-to-speech/ROCKYID', '/v1/text-to-speech/BRITTAID']);
  api.close();
});

test('openrouter speech: model and voice are sent, models are listed, setup errors are clear', async (t) => {
  const api = await mock((req) => (req.url.startsWith('/models') ? { type: 'application/json', json: { data: [{ id: 'vendor/tts-mini', name: 'TTS Mini' }] } } : { raw: 'MP3' }));
  const env = { TTS_PROVIDER: 'openrouter', OPENROUTER_API_KEY: 'k', OPENROUTER_BASE_URL: api.url, OPENROUTER_TTS_MODEL: 'vendor/tts-mini', OPENROUTER_TTS_VOICES: 'alloy, nova', OPENROUTER_REFERER: 'https://radio.example' };
  const tts = createTts(env);
  assert.deepStrictEqual((await tts.listVoices()).map((v) => v.id), ['alloy', 'nova']);
  assert.deepStrictEqual(await tts.listModels(), [{ id: 'vendor/tts-mini', name: 'TTS Mini' }]);
  assert.strictEqual(api.seen[0].url, '/models?output_modalities=speech');
  const out = await tts.synthesize({ text: 'Hi there', rate: 1.25 });
  assert.deepStrictEqual([out.audio.toString(), out.ext, out.provider], ['MP3', 'mp3', 'openrouter']);
  const sent = JSON.parse(api.seen[1].body);
  assert.deepStrictEqual(sent, { model: 'vendor/tts-mini', input: 'Hi there', response_format: 'mp3', voice: 'alloy', speed: 1.25 });
  assert.strictEqual(api.seen[1].url, '/audio/speech');
  assert.strictEqual(api.seen[1].headers.authorization, 'Bearer k');
  await assert.rejects(createTts({ TTS_PROVIDER: 'openrouter', OPENROUTER_API_KEY: 'k' }).synthesize({ text: 'x' }), /OPENROUTER_TTS_MODEL/);
  api.close();
});

test('choosing a provider per request: used alone, no fallback; unknown provider is refused; dialogue without ffmpeg needs a native provider', async () => {
  const calls = [];
  const fake = (name, extra = {}) => ({ name, capabilities: {}, defaultVoice: `${name}-v`, listVoices: async () => [{ id: name }],
    synthesize: async (r) => { calls.push([name, r.voice]); if (extra.fail) throw new Error('down'); return { audio: Buffer.from(name), ext: 'mp3' }; }, ...extra });
  const tts = createTts({ TTS_PROVIDER: 'google,openai,elevenlabs' }, { google: fake('google', { fail: true }), openai: fake('openai'), elevenlabs: fake('elevenlabs', { synthesizeDialogue: async () => ({ audio: Buffer.from('dlg'), ext: 'mp3' }) }) }, { ffmpegAvailable: () => false });
  assert.strictEqual((await tts.synthesize({ text: 'x', voice: 'g-voice' })).provider, 'openai');            // google failed, fell back
  assert.deepStrictEqual(calls, [['google', 'g-voice'], ['openai', undefined]]);                              // voice id not sent to the fallback
  assert.strictEqual((await tts.synthesize({ text: 'x', provider: 'elevenlabs', voice: 'e' })).provider, 'elevenlabs');
  await assert.rejects(tts.synthesize({ text: 'x', provider: 'google' }), /google: down/);                    // explicit choice: no fallback
  await assert.rejects(tts.synthesize({ text: 'x', provider: 'piper' }), /not enabled/);
  const d = await tts.synthesize({ turns: [{ voice: 'a', text: 'b' }] });
  assert.deepStrictEqual([d.provider, d.audio.toString()], ['elevenlabs', 'dlg']);                            // skips providers without dialogue
  assert.deepStrictEqual((await tts.listVoices('openai')).map((v) => v.id), ['openai']);
  assert.deepStrictEqual(tts.providers.map((p) => p.name), ['google', 'openai', 'elevenlabs']);
});

test('clip specs: dialogue turns are validated, provider is part of the clip id', async () => {
  const turn = (voice, text) => ({ voice, text });
  const spec = normalizeSpec({ turns: [turn('Rocky', ' Hi '), turn('Britta', 'Hello')], provider: 'ElevenLabs' });
  assert.deepStrictEqual([spec.turns, spec.provider, spec.text], [[turn('Rocky', 'Hi'), turn('Britta', 'Hello')], 'elevenlabs', 'Hi Hello']);
  assert.throws(() => normalizeSpec({ turns: [turn('', 'x')] }), SpecError);
  assert.throws(() => normalizeSpec({ turns: [turn('a', 'x'.repeat(1501))] }), /too long/);
  assert.throws(() => normalizeSpec({ turns: Array.from({ length: 61 }, () => turn('a', 'x')) }), /at most 60/);
  assert.throws(() => normalizeSpec({ turns: Array.from({ length: 11 }, (_, i) => turn(`v${i}`, 'x')) }), /10 different voices/);
  assert.throws(() => normalizeSpec({ text: 'x', provider: '../evil' }), /invalid provider/);

  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'dlg-'));
  const calls = [];
  const tts = { names: ['elevenlabs', 'openrouter'], has: (n) => ['elevenlabs', 'openrouter'].includes(n),
    synthesize: async (s) => { calls.push(s); return { audio: Buffer.from('a'), ext: 'mp3', provider: s.provider || 'elevenlabs' }; } };
  const clips = createClips({ store: createStore(path.join(dir, 'db.json'), { clips: {} }), tts, dir: path.join(dir, 'a') });
  const a = await clips.getOrCreate({ text: 'Same words' });
  const b = await clips.getOrCreate({ text: 'Same words', provider: 'openrouter' });
  const c = await clips.getOrCreate({ turns: [turn('Rocky', 'Hi'), turn('Britta', 'Yo')] });
  const c2 = await clips.getOrCreate({ turns: [turn('Rocky', 'Hi'), turn('Britta', 'Yo')] });
  assert.notStrictEqual(a.clip.id, b.clip.id);
  assert.deepStrictEqual([c.reused, c2.reused, calls.length], [false, true, 3]);
  assert.deepStrictEqual(calls[2].turns.map((t) => t.voice), ['Rocky', 'Britta']);
  await assert.rejects(clips.getOrCreate({ text: 'x', provider: 'piper' }), /not enabled/);
});

test('dialogue works with any provider by voicing each line and joining the parts', async () => {
  const lines = [];
  const plain = { name: 'plain', capabilities: { rate: true }, defaultVoice: 'a', listVoices: async () => [],
    synthesize: async (r) => { lines.push([r.voice, r.text, r.format]); return { audio: Buffer.from(`[${r.voice}:${r.text}]`), ext: r.voice === 'wavvoice' ? 'wav' : 'mp3' }; } };
  const converted = [];
  const deps = { ffmpegAvailable: () => true, toMp3: async (b) => { converted.push(b.toString()); return Buffer.from(`mp3(${b})`); },
    concatMp3: async (parts, gap) => Buffer.from(`${parts.map(String).join('+')}@${gap}`) };
  const tts = createTts({ TTS_PROVIDER: 'plain' }, { plain }, deps);
  assert.deepStrictEqual([tts.capabilities.dialogue, tts.capabilities.dialogueNative], [true, false]);
  const out = await tts.synthesize({ turns: [{ voice: 'v1', text: 'Hi' }, { voice: 'wavvoice', text: 'Yo' }], rate: 1.1 });
  assert.deepStrictEqual([out.ext, out.provider, out.audio.toString()], ['mp3', 'plain', '[v1:Hi]+mp3([wavvoice:Yo])@0.35']);
  assert.deepStrictEqual(lines, [['v1', 'Hi', 'MP3'], ['wavvoice', 'Yo', 'MP3']]);        // each line asked for MP3 so parts join cleanly
  assert.deepStrictEqual(converted, ['[wavvoice:Yo]']);                                   // non-MP3 parts are converted first
  const native = createTts({ TTS_PROVIDER: 'el' }, { el: { name: 'el', capabilities: {}, defaultVoice: '', listVoices: async () => [], synthesizeDialogue: async () => ({ audio: Buffer.from('n'), ext: 'mp3' }) } }, deps);
  assert.deepStrictEqual([native.capabilities.dialogue, native.capabilities.dialogueNative], [true, true]);
  const noFfmpeg = createTts({ TTS_PROVIDER: 'plain' }, { plain }, { ffmpegAvailable: () => false });
  assert.strictEqual(noFfmpeg.capabilities.dialogue, false);
  await assert.rejects(noFfmpeg.synthesize({ turns: [{ voice: 'a', text: 'b' }] }), /needs ffmpeg/);
});

test('written scripts become dialogue turns; speakers map to voices', () => {
  const spec = normalizeSpec({ script: 'R: Britta, what are we listening to?\nB: [laughs] No idea: that is the beauty.\n\nNarrator: Pirate radio.', voices: { R: 'Rocky', B: 'Britta' } });
  assert.deepStrictEqual(spec.turns, [
    { voice: 'Rocky', text: 'Britta, what are we listening to?' },
    { voice: 'Britta', text: '[laughs] No idea: that is the beauty.' },     // only the first colon splits speaker from text
    { voice: 'Narrator', text: 'Pirate radio.' },                            // unmapped speaker is used as the voice itself
  ]);
  assert.throws(() => normalizeSpec({ script: 'Rocky: ok\nthis line has no speaker' }), /line 2 needs a speaker/);
  assert.deepStrictEqual(normalizeSpec({ turns: [{ voice: 'a', text: 'b' }], script: 'x: y' }).turns, [{ voice: 'a', text: 'b' }]);   // explicit turns win
  assert.ok(Object.keys(normalizeSpec({ script: '__proto__: hi', voices: {} }).turns[0]).length === 2);
});

test('effects are part of the clip: validated, hashed, applied after speech, and reusable as processed copies', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'fxclip-'));
  const applied = [];
  const fakeFx = { apply: async (buf, settings) => { applied.push(settings.preset); return Buffer.from(`fx(${settings.preset}):${buf}`); } };
  const tts = { names: ['x'], synthesize: async () => ({ audio: Buffer.from('raw'), ext: 'ogg', provider: 'x' }) };
  const clips = createClips({ store: createStore(path.join(dir, 'db.json'), { clips: {} }), tts, dir: path.join(dir, 'a'), fx: fakeFx });
  const plain = await clips.getOrCreate({ text: 'Same words' });
  const robot = await clips.getOrCreate({ text: 'Same words', fx: 'robot' });
  const again = await clips.getOrCreate({ text: 'Same words', fx: { preset: 'robot' } });
  assert.notStrictEqual(plain.clip.id, robot.clip.id);                                   // effect changes the clip id
  assert.deepStrictEqual([again.reused, robot.clip.ext, plain.clip.ext], [true, 'mp3', 'ogg']);
  assert.strictEqual(fs.readFileSync(clips.fileOf(robot.clip), 'utf8'), 'fx(robot):raw');
  assert.strictEqual(robot.clip.spec.fx.preset, 'robot');
  await assert.rejects(clips.getOrCreate({ text: 'x', fx: 'nonsense' }), /unknown effect/);
  // a processed copy of an existing clip
  const copy = await clips.applyFx(plain.clip.id, { preset: 'deep' });
  assert.deepStrictEqual([copy.clip.title, copy.clip.derivedFrom, copy.clip.external, copy.clip.source], ['Same words (deep)', plain.clip.id, true, 'fx:deep']);
  assert.strictEqual(fs.readFileSync(clips.fileOf(copy.clip), 'utf8'), 'fx(deep):raw');
  assert.ok(clips.get(plain.clip.id) && clips.exists(plain.clip));                         // original kept
  await assert.rejects(clips.applyFx(plain.clip.id, {}), /choose an effect/);
  assert.strictEqual(await clips.applyFx('nope', 'robot'), null);
});
