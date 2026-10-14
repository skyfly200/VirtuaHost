// The clip catalogue: every announcement that has been generated, keyed by a hash of what it says
// and how it is spoken, so repeating one never pays for another synthesis.
const crypto = require('crypto');
const fs = require('fs');
const path = require('path');

const FORMATS = ['OGG_OPUS', 'MP3', 'LINEAR16'];
const clamp = (n, lo, hi, fallback) => (Number.isFinite(Number(n)) ? Math.min(hi, Math.max(lo, Number(n))) : fallback);

class SpecError extends Error {}

function normalizeSpec(raw = {}, { maxText = 500, maxSsml = 2000 } = {}) {
  const ssmlMode = raw.ssmlMode === true;
  const content = String(ssmlMode ? raw.ssml || '' : raw.text || '').trim();
  if (!content) throw new SpecError(ssmlMode ? 'ssml is required' : 'text is required');
  if (content.length > (ssmlMode ? maxSsml : maxText)) {
    throw new SpecError(`${ssmlMode ? 'ssml' : 'text'} is too long (max ${ssmlMode ? maxSsml : maxText} characters)`);
  }
  const voice = String(raw.voice || raw.voiceName || '').slice(0, 200);
  if (/[\u0000-\u001f]/.test(voice)) throw new SpecError('invalid voice');
  const format = FORMATS.includes(raw.format) ? raw.format : 'OGG_OPUS';
  return {
    ssmlMode,
    text: ssmlMode ? '' : content,
    ssml: ssmlMode ? content : '',
    voice,
    language: voice ? voice.slice(0, 5) : String(raw.language || '').slice(0, 10),
    gender: ['MALE', 'FEMALE', 'NEUTRAL'].includes(raw.gender) ? raw.gender : undefined,
    format,
    rate: clamp(raw.rate, 0.25, 4, 1),
    pitch: clamp(raw.pitch, -20, 20, 0),
    gain: clamp(raw.gain, -96, 16, 3),
  };
}

function specId(spec, provider) {
  const key = JSON.stringify([spec.ssmlMode, spec.text || spec.ssml, spec.voice, spec.format, spec.rate, spec.pitch, spec.gain, provider]);
  return crypto.createHash('sha256').update(key).digest('hex').slice(0, 24);
}

function createClips({ store, tts, dir, maxBytes = 500e6, now = Date.now }) {
  if (!store.data.clips) store.data.clips = {};
  const clips = store.data.clips;
  const inflight = new Map();
  fs.mkdirSync(dir, { recursive: true });

  const fileOf = (clip) => (clip.file ? path.join(dir, clip.file) : null);
  const exists = (clip) => { const f = fileOf(clip); return !!f && fs.existsSync(f); };

  function usedBytes() {
    return Object.values(clips).reduce((sum, c) => sum + (exists(c) ? c.bytes : 0), 0);
  }

  // Free space by deleting the least recently played files that are not favorites.
  // The catalogue row stays, so the clip can be regenerated or restored later.
  function evict(keepId) {
    let used = usedBytes();
    if (used <= maxBytes) return [];
    const victims = Object.values(clips)
      .filter((c) => c.id !== keepId && !c.favorite && exists(c))
      .sort((a, b) => (a.lastPlayedAt || a.createdAt) - (b.lastPlayedAt || b.createdAt));
    const evicted = [];
    for (const clip of victims) {
      if (used <= maxBytes) break;
      fs.rmSync(fileOf(clip), { force: true });
      used -= clip.bytes;
      clip.file = null;
      evicted.push(clip.id);
    }
    if (evicted.length) store.save();
    return evicted;
  }

  async function generate(spec, id) {
    const result = await tts.synthesize(spec);
    const file = `${id}.${result.ext}`;
    fs.writeFileSync(path.join(dir, file), result.audio);
    const previous = clips[id] || {};
    const text = spec.ssmlMode ? spec.ssml.replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ').trim() : spec.text;
    const clip = {
      id,
      title: previous.title || text.slice(0, 60),
      text,
      spec,
      provider: result.provider,
      ext: result.ext,
      file,
      bytes: result.audio.length,
      tags: previous.tags || [],
      favorite: !!previous.favorite,
      createdAt: previous.createdAt || now(),
      lastPlayedAt: previous.lastPlayedAt || 0,
      playCount: previous.playCount || 0,
      cloud: previous.cloud,
    };
    clips[id] = clip;
    store.save();
    evict(id);
    return clip;
  }

  return {
    normalizeSpec,
    SpecError,

    // Returns { clip, reused }. A catalogue hit with its file still on disk costs nothing.
    async getOrCreate(rawSpec, limits) {
      const spec = normalizeSpec(rawSpec, limits);
      const id = specId(spec, tts.names ? tts.names[0] : 'tts');
      const existing = clips[id];
      if (existing && exists(existing)) return { clip: existing, reused: true };
      if (!inflight.has(id)) {
        inflight.set(id, generate(spec, id).finally(() => inflight.delete(id)));
      }
      return { clip: await inflight.get(id), reused: false };
    },

    get: (id) => clips[id] || null,
    fileOf,
    exists,
    usedBytes,
    evict,

    list({ q, tag, favorite, limit = 200 } = {}) {
      const needle = (q || '').toLowerCase();
      return Object.values(clips)
        .filter((c) => (!needle || c.title.toLowerCase().includes(needle) || c.text.toLowerCase().includes(needle))
          && (!tag || c.tags.includes(tag))
          && (favorite === undefined || c.favorite === favorite))
        .sort((a, b) => (b.lastPlayedAt || b.createdAt) - (a.lastPlayedAt || a.createdAt))
        .slice(0, limit)
        .map((c) => ({ ...c, available: exists(c) }));
    },

    update(id, patch = {}) {
      const clip = clips[id];
      if (!clip) return null;
      if (typeof patch.title === 'string') clip.title = patch.title.trim().slice(0, 120) || clip.title;
      if (typeof patch.favorite === 'boolean') clip.favorite = patch.favorite;
      if (Array.isArray(patch.tags)) {
        clip.tags = [...new Set(patch.tags.map((t) => String(t).trim().toLowerCase().slice(0, 30)).filter(Boolean))].slice(0, 10);
      }
      store.save();
      return clip;
    },

    setCloud(id, cloud) {
      if (clips[id]) { clips[id].cloud = cloud; store.save(); }
    },

    markPlayed(id) {
      const clip = clips[id];
      if (clip) { clip.lastPlayedAt = now(); clip.playCount += 1; store.save(); }
    },

    remove(id) {
      const clip = clips[id];
      if (!clip) return false;
      if (exists(clip)) fs.rmSync(fileOf(clip), { force: true });
      delete clips[id];
      store.save();
      return true;
    },
  };
}

module.exports = { createClips, normalizeSpec, specId, SpecError };
