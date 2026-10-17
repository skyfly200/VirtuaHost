// HTTP API for clips, providers, drafting, sharing and schedules.
// createApi() returns two routers: `publicRouter` (signed audio links, no login) and `router` (login required).
const express = require('express');
const bodyParser = require('body-parser');   // express.raw needs express 4.17+; this works on the installed 4.16
const { SpecError } = require('../lib/clips');
const { ScheduleError } = require('../lib/scheduler');
const { verify, signedUrl } = require('../lib/signing');
const { createLimiter } = require('../lib/ratelimit');
const { IngestError } = require('../lib/ingest');
const crypto = require('crypto');

const MIME = { ogg: 'audio/ogg', mp3: 'audio/mpeg', wav: 'audio/wav' };

function createApi({ clips, tts, llm, storage, scheduler, play, streamSecret, publicUrl, limits = {}, rateLimit = {}, ingest, ingestToken = '', authenticate = (req, res, next) => next(), ingestMaxBytes = 25e6 }) {
  const maxText = limits.maxText || 500;
  const maxPrompt = limits.maxPrompt || 1000;
  const costly = createLimiter({ windowMs: rateLimit.windowMs || 60000, max: rateLimit.max || 30 });

  const wrap = (fn) => async (req, res) => {
    try {
      await fn(req, res);
    } catch (err) {
      if (err instanceof SpecError || err instanceof ScheduleError) return res.status(400).json({ error: err.message });
      if (err instanceof IngestError) return res.status(err.status).json({ error: err.message });
      if (tts.ProviderError && err instanceof tts.ProviderError) return res.status(400).json({ error: err.message });
      console.error(`${req.method} ${req.path}:`, err.message);
      res.status(502).json({ error: err.message });
    }
  };

  const view = (clip) => clip && ({ ...clip, available: clips.exists(clip) });

  // Make sure the clip's audio is on disk; an evicted clip is regenerated from its saved settings.
  async function ensureFile(clip) {
    if (clips.exists(clip)) return clip;
    if (clip.external) throw new Error('the imported audio file is missing');
    return (await clips.getOrCreate(clip.spec, limits)).clip;
  }

  async function playAndRecord(clip, preempt) {
    const result = (await play(clip, { preempt })) || {};
    if (result.played !== false) clips.markPlayed(clip.id);
    return result;
  }

  // ---- public: signed links that media players can stream ----
  const publicRouter = express.Router();
  publicRouter.get('/a/:id/:name', (req, res) => {
    const { exp, sig } = req.query;
    if (!verify(streamSecret, req.params.id, exp, sig)) return res.status(403).json({ error: 'link is invalid or has expired' });
    const clip = clips.get(req.params.id);
    if (!clip || !clips.exists(clip)) return res.status(404).json({ error: 'clip is no longer available' });
    res.sendFile(clips.fileOf(clip), {
      headers: {
        'Content-Type': MIME[clip.ext] || 'application/octet-stream',
        'Cache-Control': 'private, max-age=300',
        'Content-Disposition': 'inline',
        'Access-Control-Allow-Origin': '*',
      },
    });
  });

  // ---- authenticated ----
  const router = express.Router();

  router.get('/providers', (req, res) => res.json({
    tts: { names: tts.names, capabilities: tts.capabilities, providers: tts.providers },
    llm: { enabled: llm.enabled, names: llm.names },
    storage: { enabled: storage.enabled, targets: storage.targets },
    links: { enabled: !!streamSecret },
    limits: { maxText, maxSsml: limits.maxSsml || 2000, maxPrompt },
  }));

  const voiceCache = new Map();
  router.get('/tts/voices', wrap(async (req, res) => {
    const key = String(req.query.provider || '');
    const hit = voiceCache.get(key);
    if (!hit || Date.now() - hit.at > 10 * 60000) {
      voiceCache.set(key, { at: Date.now(), value: await tts.listVoices(req.query.provider) });
    }
    res.json(voiceCache.get(key).value);
  }));
  router.get('/tts/models', wrap(async (req, res) => res.json(await tts.listModels(req.query.provider))));

  router.get('/llm/models', wrap(async (req, res) => res.json(await llm.listModels())));

  router.post('/announcements/draft', costly, wrap(async (req, res) => {
    const prompt = String((req.body || {}).prompt || '').trim();
    if (!prompt) return res.status(400).json({ error: 'prompt is required' });
    if (prompt.length > maxPrompt) return res.status(400).json({ error: `prompt is too long (max ${maxPrompt} characters)` });
    const tone = String((req.body || {}).tone || '').slice(0, 60);
    const out = await llm.generate({
      system: `You write short announcements for a radio station, to be read aloud by a text-to-speech voice. `
        + `Reply with only the announcement text: plain sentences, no markdown, no quotation marks, no stage directions, `
        + `under ${Math.floor(maxText * 0.8)} characters.${tone ? ` Tone: ${tone}.` : ''}`,
      prompt,
      maxTokens: 300,
    });
    res.json({ text: out.text.slice(0, maxText), provider: out.provider, model: out.model });
  }));

  router.post('/synth', costly, wrap(async (req, res) => {
    const { clip, reused } = await clips.getOrCreate(req.body, limits);
    res.json({ clip: view(clip), file: clips.fileOf(clip), reused });
  }));

  router.post('/speak', costly, wrap(async (req, res) => {
    const { clip, reused } = await clips.getOrCreate(req.body, limits);
    const result = await playAndRecord(clip, (req.body || {}).preempt);
    res.json({ clip: view(clips.get(clip.id)), file: clips.fileOf(clip), reused, ...result });
  }));

  router.get('/clips', (req, res) => res.json(clips.list({
    q: req.query.q,
    tag: req.query.tag,
    favorite: req.query.favorite === undefined ? undefined : req.query.favorite === 'true',
  })));

  router.patch('/clips/:id', (req, res) => {
    const clip = clips.update(req.params.id, req.body || {});
    clip ? res.json(view(clip)) : res.status(404).json({ error: 'clip not found' });
  });

  router.delete('/clips/:id', (req, res) => (clips.remove(req.params.id)
    ? res.json({ ok: true }) : res.status(404).json({ error: 'clip not found' })));

  router.post('/clips/:id/play', wrap(async (req, res) => {
    const found = clips.get(req.params.id);
    if (!found) return res.status(404).json({ error: 'clip not found' });
    const clip = await ensureFile(found);
    res.json(await playAndRecord(clip, (req.body || {}).preempt));
  }));

  // A link a media player can stream: signed, expires, supports seeking (HTTP Range).
  router.post('/clips/:id/link', wrap(async (req, res) => {
    if (!streamSecret) return res.status(503).json({ error: 'set STREAM_SECRET (or SESSION_SECRET) to create audio links' });
    const found = clips.get(req.params.id);
    if (!found) return res.status(404).json({ error: 'clip not found' });
    const clip = await ensureFile(found);
    const hours = Math.min(24 * 30, Math.max(1, Number((req.body || {}).hours) || 24));
    const base = publicUrl || `${req.protocol}://${req.get('host')}`;
    const link = signedUrl({ base, secret: streamSecret, id: clip.id, ext: clip.ext, title: clip.title, ttlSeconds: hours * 3600 });
    res.json({ ...link, expiresInHours: hours });
  }));

  // Upload to the configured cloud (Google Drive via rclone, ownCloud, ...) and return a share link.
  router.post('/clips/:id/share', wrap(async (req, res) => {
    const found = clips.get(req.params.id);
    if (!found) return res.status(404).json({ error: 'clip not found' });
    const clip = await ensureFile(found);
    const shared = await storage.share(clip, clips.fileOf(clip), (req.body || {}).target);
    clips.setCloud(clip.id, { ...shared, at: Date.now() });
    res.json(shared);
  }));

  router.get('/schedules', (req, res) => res.json(scheduler.list()));
  router.post('/schedules', wrap(async (req, res) => res.status(201).json(scheduler.add(req.body || {}))));
  router.patch('/schedules/:id', (req, res) => {
    const s = scheduler.update(req.params.id, req.body || {});
    s ? res.json(s) : res.status(404).json({ error: 'schedule not found' });
  });
  router.delete('/schedules/:id', (req, res) => (scheduler.remove(req.params.id)
    ? res.json({ ok: true }) : res.status(404).json({ error: 'schedule not found' })));

  // ---- audio from another system (the Netlify generator) ----
  // Accepts INGEST_TOKEN (a key that can do nothing else) or a normal login/API key.
  const ingestRouter = express.Router();
  const ingestLimit = createLimiter({ windowMs: 60000, max: rateLimit.ingestMax || 60 });
  function ingestGuard(req, res, next) {
    const bearer = (req.get('authorization') || '').replace(/^Bearer\s+/i, '');
    const given = Buffer.from(String(req.get('x-ingest-token') || bearer));
    const wanted = Buffer.from(ingestToken);
    if (ingestToken && given.length === wanted.length && crypto.timingSafeEqual(given, wanted)) return next();
    return authenticate(req, res, next);
  }

  const asBool = (v) => v === true || v === 'true' || v === '1';
  async function finishIngest(res, { clip, reused }, opts) {
    const out = { clip: view(clip), reused, played: false };
    if (opts.play) Object.assign(out, await playAndRecord(clip, asBool(opts.preempt)));
    out.clip = view(clips.get(clip.id));
    res.status(reused ? 200 : 201).json(out);
  }

  if (ingest) {
    // Push: the sender posts the audio bytes. Metadata goes in the query string or x-* headers.
    ingestRouter.post('/ingest', ingestLimit, ingestGuard,
      bodyParser.raw({ type: ['audio/*', 'application/octet-stream'], limit: ingestMaxBytes }),
      wrap(async (req, res) => {
        if (!Buffer.isBuffer(req.body) || !req.body.length) throw new IngestError('send the audio as the request body (Content-Type: audio/wav)', 400);
        const q = req.query;
        const header = (n) => (req.get(n) ? decodeURIComponent(req.get(n)) : undefined);
        const result = await ingest.importBuffer(req.body, {
          title: q.title || header('x-title'), text: q.text || header('x-text'), source: q.source || header('x-source'),
        });
        await finishIngest(res, result, { play: asBool(q.play || req.get('x-play')), preempt: q.preempt || req.get('x-preempt') });
      }));

    // Pull: the sender gives a link; only hosts listed in INGEST_ALLOWED_HOSTS are fetched.
    ingestRouter.post('/ingest/url', ingestLimit, ingestGuard, wrap(async (req, res) => {
      const body = req.body || {};
      if (!body.url) throw new IngestError('url is required', 400);
      const buffer = await ingest.fetchAudio(body.url);
      const result = await ingest.importBuffer(buffer, { title: body.title, text: body.text, source: body.source || 'link' });
      await finishIngest(res, result, { play: asBool(body.play), preempt: body.preempt });
    }));
  }

  // Body-parser failures (too large, aborted upload) should be JSON like every other answer.
  ingestRouter.use((err, req, res, next) => {
    if (!err || !err.status) return next(err);
    res.status(err.status).json({ error: err.type === 'entity.too.large' ? 'audio is too large' : (err.message || 'bad request') });
  });

  return { router, publicRouter, ingestRouter };
}

module.exports = { createApi };
