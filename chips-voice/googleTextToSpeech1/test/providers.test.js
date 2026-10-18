const test = require('node:test');
const assert = require('node:assert');
const http = require('http');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { createTts } = require('../lib/providers/tts');
const { createLlm } = require('../lib/providers/llm');

// A mock HTTP API: records requests and answers with whatever `reply` returns.
function mock(reply) {
  const seen = [];
  const server = http.createServer((req, res) => {
    let body = '';
    req.on('data', (d) => { body += d; });
    req.on('end', () => {
      seen.push({ method: req.method, url: req.url, headers: req.headers, body });
      const r = reply(req, body);
      res.writeHead(r.status || 200, { 'Content-Type': r.type || 'application/json' });
      res.end(r.raw !== undefined ? r.raw : JSON.stringify(r.json));
    });
  });
  return new Promise((resolve) => server.listen(0, '127.0.0.1', () =>
    resolve({ url: `http://127.0.0.1:${server.address().port}`, seen, close: () => server.close() })));
}

test('openrouter: sends model, fallbacks and attribution headers; returns the text', async () => {
  const api = await mock(() => ({ json: { choices: [{ message: { content: '  Welcome to the show!  ' } }] } }));
  const llm = createLlm({ LLM_PROVIDER: 'openrouter', OPENROUTER_API_KEY: 'k', OPENROUTER_BASE_URL: api.url,
    OPENROUTER_MODEL: 'anthropic/claude-3.5-sonnet', OPENROUTER_FALLBACK_MODELS: 'openai/gpt-4o-mini, meta-llama/llama-3.1-8b-instruct',
    OPENROUTER_REFERER: 'https://radio.example', OPENROUTER_TITLE: 'Radio' });
  const out = await llm.generate({ system: 'Be brief.', prompt: 'Announce the show', maxTokens: 50 });
  assert.deepStrictEqual([out.text, out.provider], ['Welcome to the show!', 'openrouter']);
  const sent = api.seen[0];
  const body = JSON.parse(sent.body);
  assert.strictEqual(sent.url, '/chat/completions');
  assert.strictEqual(sent.headers.authorization, 'Bearer k');
  assert.strictEqual(sent.headers['http-referer'], 'https://radio.example');
  assert.strictEqual(sent.headers['x-title'], 'Radio');
  assert.strictEqual(body.model, 'anthropic/claude-3.5-sonnet');
  assert.deepStrictEqual(body.models, ['anthropic/claude-3.5-sonnet', 'openai/gpt-4o-mini', 'meta-llama/llama-3.1-8b-instruct']);
  assert.deepStrictEqual(body.messages.map((m) => m.role), ['system', 'user']);
  api.close();
});

test('openrouter: lists models; no fallback list means no "models" field', async () => {
  const api = await mock((req) => (req.url === '/models'
    ? { json: { data: [{ id: 'a/b', name: 'AB', context_length: 8000 }] } }
    : { json: { choices: [{ message: { content: 'ok' } }] } }));
  const llm = createLlm({ LLM_PROVIDER: 'openrouter', OPENROUTER_API_KEY: 'k', OPENROUTER_BASE_URL: api.url });
  assert.deepStrictEqual(await llm.listModels(), [{ id: 'a/b', name: 'AB', contextLength: 8000 }]);
  await llm.generate({ prompt: 'x' });
  assert.strictEqual(JSON.parse(api.seen[1].body).models, undefined);
  api.close();
});

test('anthropic adapter uses the messages API', async () => {
  const api = await mock(() => ({ json: { content: [{ type: 'text', text: 'Hello listeners' }] } }));
  const llm = createLlm({ LLM_PROVIDER: 'anthropic', ANTHROPIC_API_KEY: 'sk', ANTHROPIC_BASE_URL: api.url, ANTHROPIC_MODEL: 'm1' });
  assert.strictEqual((await llm.generate({ system: 's', prompt: 'p' })).text, 'Hello listeners');
  assert.strictEqual(api.seen[0].url, '/v1/messages');
  assert.strictEqual(api.seen[0].headers['x-api-key'], 'sk');
  assert.strictEqual(JSON.parse(api.seen[0].body).system, 's');
  api.close();
});

test('LLM fallback chain: first provider fails, second answers; no provider means disabled', async () => {
  const bad = await mock(() => ({ status: 500, json: { error: 'down' } }));
  const good = await mock(() => ({ json: { choices: [{ message: { content: 'from ollama' } }] } }));
  const llm = createLlm({ LLM_PROVIDER: 'openrouter,ollama', OPENROUTER_API_KEY: 'k', OPENROUTER_BASE_URL: bad.url,
    OLLAMA_BASE_URL: good.url, OLLAMA_MODEL: 'llama3' });
  const out = await llm.generate({ prompt: 'x' });
  assert.deepStrictEqual([out.text, out.provider], ['from ollama', 'ollama']);
  assert.ok(!createLlm({}).enabled);
  await assert.rejects(createLlm({}).generate({ prompt: 'x' }), /no LLM provider/);
  assert.throws(() => createLlm({ LLM_PROVIDER: 'nope' }), /unknown LLM_PROVIDER/);
  await assert.rejects(createLlm({ LLM_PROVIDER: 'openrouter' }).generate({ prompt: 'x' }), /API key is not set/);
  bad.close(); good.close();
});

test('openai tts maps options and returns audio bytes', async () => {
  const api = await mock(() => ({ type: 'audio/mpeg', raw: 'AUDIOBYTES' }));
  const tts = createTts({ TTS_PROVIDER: 'openai', OPENAI_API_KEY: 'k', OPENAI_BASE_URL: api.url });
  const out = await tts.synthesize({ text: 'Hi', voice: 'nova', rate: 9, format: 'OGG_OPUS' });
  assert.deepStrictEqual([out.audio.toString(), out.ext, out.provider], ['AUDIOBYTES', 'ogg', 'openai']);
  const body = JSON.parse(api.seen[0].body);
  assert.deepStrictEqual([body.voice, body.response_format, body.speed, body.input], ['nova', 'opus', 4, 'Hi']);
  assert.strictEqual(tts.capabilities.ssml, false);
  await assert.rejects(tts.synthesize({ ssmlMode: true, ssml: '<speak/>' }), /SSML/);
  api.close();
});

test('elevenlabs tts and voice list', async () => {
  const api = await mock((req) => (req.url.startsWith('/v1/voices')
    ? { json: { voices: [{ voice_id: 'v1', name: 'Rachel' }] } } : { type: 'audio/mpeg', raw: 'MP3' }));
  const tts = createTts({ TTS_PROVIDER: 'elevenlabs', ELEVENLABS_API_KEY: 'k', ELEVENLABS_BASE_URL: api.url });
  assert.deepStrictEqual(await tts.listVoices(), [{ id: 'v1', name: 'Rachel', language: '', gender: '' }]);
  const out = await tts.synthesize({ text: 'Hi', voice: 'v1' });
  assert.deepStrictEqual([out.audio.toString(), out.ext], ['MP3', 'mp3']);
  assert.ok(api.seen[1].url.startsWith('/v1/text-to-speech/v1?'));
  assert.strictEqual(api.seen[1].headers['xi-api-key'], 'k');
  await assert.rejects(tts.synthesize({ text: 'x' }), /choose an ElevenLabs voice/);
  api.close();
});

test('google adapter maps options (client stubbed)', async () => {
  let sent;
  const client = { synthesizeSpeech: async (r) => { sent = r; return [{ audioContent: 'abc' }]; } };
  const tts = createTts({ TTS_PROVIDER: 'google' }, { google: require('../lib/providers/tts/google').create({}, { client }) });
  const out = await tts.synthesize({ text: 'Hi', voice: 'en-GB-Wavenet-B', format: 'MP3', rate: 1.2, pitch: -2, gain: 0 });
  assert.deepStrictEqual([out.ext, out.provider], ['mp3', 'google']);
  assert.deepStrictEqual(sent.voice, { languageCode: 'en-GB', name: 'en-GB-Wavenet-B' });
  assert.deepStrictEqual([sent.audioConfig.audioEncoding, sent.audioConfig.speakingRate, sent.audioConfig.pitch, sent.audioConfig.volumeGainDb], ['MP3', 1.2, -2, 0]);
  assert.deepStrictEqual(sent.input, { text: 'Hi' });
});

test('piper runs the local command; fallback chain drops the primary voice id', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'piperbin-'));
  const bin = path.join(dir, 'piper');
  fs.writeFileSync(bin, '#!/bin/sh\nwhile [ "$1" != "--output_file" ]; do shift; done\ncat > "$2"\n', { mode: 0o755 });
  const calls = [];
  const failing = { name: 'google', capabilities: {}, listVoices: async () => [], synthesize: async (r) => { calls.push(['google', r.voice]); throw new Error('quota'); } };
  const tts = createTts({ TTS_PROVIDER: 'google,piper', PIPER_BIN: bin, PIPER_MODELS: 'en.onnx' }, { google: failing });
  const out = await tts.synthesize({ text: 'spoken words', voice: 'en-US-Wavenet-A' });
  assert.deepStrictEqual([out.audio.toString(), out.ext, out.provider], ['spoken words', 'wav', 'piper']);
  assert.deepStrictEqual(calls, [['google', 'en-US-Wavenet-A']]);
  const onlyBad = createTts({ TTS_PROVIDER: 'google' }, { google: failing });
  await assert.rejects(onlyBad.synthesize({ text: 'x' }), /speech synthesis failed \(google: quota\)/);
  assert.throws(() => createTts({ TTS_PROVIDER: 'nope' }), /unknown TTS_PROVIDER/);
});

test('LLM: a request can pick another enabled model (for example a conversational or tone-aware one), and only an enabled one', async (t) => {
  const api = await mock(() => ({ json: { choices: [{ message: { content: 'Rocky: Hi.' } }] } })); t.after(() => api.close());
  const llm = createLlm({ LLM_PROVIDER: 'openrouter', OPENROUTER_API_KEY: 'k', OPENROUTER_BASE_URL: api.url,
    OPENROUTER_MODEL: 'openai/gpt-4o-mini', OPENROUTER_LLM_MODELS: 'anthropic/claude-3.5-sonnet, meta-llama/llama-3.1-70b-instruct', OPENROUTER_FALLBACK_MODELS: 'openai/gpt-4o-mini' });
  assert.deepStrictEqual(llm.models, [{ provider: 'openrouter', default: 'openai/gpt-4o-mini', models: ['openai/gpt-4o-mini', 'anthropic/claude-3.5-sonnet', 'meta-llama/llama-3.1-70b-instruct'] }]);
  const out = await llm.generate({ prompt: 'x', model: 'anthropic/claude-3.5-sonnet' });
  assert.deepStrictEqual([out.model, out.provider], ['anthropic/claude-3.5-sonnet', 'openrouter']);
  const body = JSON.parse(api.seen[0].body);
  assert.deepStrictEqual([body.model, body.models], ['anthropic/claude-3.5-sonnet', ['anthropic/claude-3.5-sonnet', 'openai/gpt-4o-mini']]);
  await assert.rejects(llm.generate({ prompt: 'x', model: 'evil/model' }), /not enabled on any provider/);
  assert.strictEqual(api.seen.length, 1);
  await llm.generate({ prompt: 'y' });
  assert.strictEqual(JSON.parse(api.seen[1].body).model, 'openai/gpt-4o-mini');
});
