// The clip catalogue: every announcement that has been generated, keyed by a hash of what it says
// and how it is spoken, so repeating one never pays for another synthesis.
const crypto = require('crypto');
const fs = require('fs');
const path = require('path');
const fxLib = require('./fx');

const FORMATS = ['OGG_OPUS', 'MP3', 'LINEAR16'];
const clamp = (n, lo, hi, fallback) => (Number.isFinite(Number(n)) ? Math.min(hi, Math.max(lo, Number(n))) : fallback);

class SpecError extends Error {}

// Multi-voice scripts: [{ voice, text }, ...]. Total length is capped separately from single-voice text.
function normalizeTurns(raw, { maxDialogue = 10000 }) {
  if (!Array.isArray(raw) || raw.length === 0) return null;
  if (raw.length > 60) throw new SpecError('a dialogue can have at most 60 lines');
  const turns = raw.map((t) => ({ voice: String((t && t.voice) || '').trim().slice(0, 200), text: String((t && t.text) || '').trim() }));
  if (turns.some((t) => !t.voice || !t.text)) throw new SpecError('every dialogue line needs a voice and text');
  if (turns.some((t) => t.text.length > 1500)) throw new SpecError('a dialogue line is too long (max 1500 characters)');
  if (new Set(turns.map((t) => t.voice)).size > 10) throw new SpecError('a dialogue can use at most 10 different voices');
  if (turns.reduce((n, t) => n + t.text.length, 0) > maxDialogue) throw new SpecError(`dialogue is too long (max ${maxDialogue} characters in total)`);
  return turns;
}

// A written script, one line per turn: "Rocky: Hello there." Speaker names are looked up in `voices`
// (for example { Rocky: "5amD...", R: "Rocky" }); a name that is not in the map is used as the voice itself.
function parseScript(script, voices) {
  const map = voices && typeof voices === 'object' && !Array.isArray(voices) ? voices : {};
  const lines = String(script).split(/\r?\n/).map((l) => l.trim()).filter(Boolean);
  return lines.map((line, i) => {
    const m = line.match(/^([^:]{1,40}):\s*(.+)$/);
    if (!m) throw new SpecError(`script line ${i + 1} needs a speaker, like "Rocky: Hello there."`);
    const speaker = m[1].trim();
    const voice = Object.prototype.hasOwnProperty.call(map, speaker) ? String(map[speaker]) : speaker;
    return { voice, text: m[2].trim() };
  });
}

function normalizeFxSpec(raw) {
  try {
    return fxLib.normalizeFx(raw) || undefined;
  } catch (err) {
    if (err instanceof fxLib.FxError) throw new SpecError(err.message);
    throw err;
  }
}

function normalizeSpec(raw = {}, { maxText = 500, maxSsml = 2000, maxDialogue = 10000 } = {}) {
  const provider = raw.provider ? String(raw.provider).toLowerCase() : '';
  if (provider && !/^[a-z0-9_-]{1,40}$/.test(provider)) throw new SpecError('invalid provider');
  const fx = normalizeFxSpec(raw.fx);
  const rawTurns = Array.isArray(raw.turns) && raw.turns.length ? raw.turns
    : (typeof raw.script === 'string' && raw.script.trim() ? parseScript(raw.script, raw.voices) : null);
  const turns = normalizeTurns(rawTurns, { maxDialogue });
  if (turns) {
    const format = FORMATS.includes(raw.format) ? raw.format : 'OGG_OPUS';
    return {
      ssmlMode: false, text: turns.map((t) => t.text).join(' '), ssml: '', turns, voice: '', language: '', gender: undefined,
      format, rate: 1, pitch: 0, gain: 3, provider: provider || undefined, fx,
    };
  }
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
    provider: provider || undefined,
    fx,
  };
}

function specId(spec, provider) {
  const key = JSON.stringify([spec.ssmlMode, spec.text || spec.ssml, spec.voice, spec.format, spec.rate, spec.pitch, spec.gain, spec.turns || null, spec.fx || null, provider]);
  return crypto.createHash('sha256').update(key).digest('hex').slice(0, 24);
}

function createClips({ store, tts, dir, maxBytes = 500e6, now = Date.now, fx = fxLib }) {
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
      .filter((c) => c.id !== keepId && !c.favorite && !c.external && exists(c))
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
    if (spec.fx) {                              // voice changer / audio treatment after the speech is made
      result.audio = await fx.apply(result.audio, spec.fx);
      result.ext = 'mp3';
    }
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
      if (spec.provider && tts.has && !tts.has(spec.provider)) {
        throw new SpecError(`speech provider "${spec.provider}" is not enabled (enabled: ${tts.names.join(', ')})`);
      }
      const id = specId(spec, spec.provider || (tts.names ? tts.names[0] : 'tts'));
      const existing = clips[id];
      if (existing && exists(existing)) return { clip: existing, reused: true };
      if (!inflight.has(id)) {
        inflight.set(id, generate(spec, id).finally(() => inflight.delete(id)));
      }
      return { clip: await inflight.get(id), reused: false };
    },

    // Audio made elsewhere (for example by the Netlify generator). It is stored as-is and cannot be regenerated,
    // so it is never evicted. The id is a hash of the audio, so sending the same file twice reuses the entry.
    addExternal({ buffer, ext, title, text, source, derivedFrom, tags }) {
      const id = crypto.createHash('sha256').update(buffer).digest('hex').slice(0, 24);
      const existing = clips[id];
      if (existing && exists(existing)) return { clip: existing, reused: true };
      const file = `${id}.${ext}`;
      fs.writeFileSync(path.join(dir, file), buffer);
      const said = String(text || title || 'Imported clip').trim();
      clips[id] = {
        id, title: String(title || said).trim().slice(0, 120) || 'Imported clip', text: said.slice(0, 2000),
        spec: null, external: true, provider: 'import', source: String(source || '').slice(0, 60), derivedFrom: derivedFrom || undefined,
        ext, file, bytes: buffer.length, tags: (existing && existing.tags) || (tags || []).slice(0, 10), favorite: !!(existing && existing.favorite),
        createdAt: (existing && existing.createdAt) || now(), lastPlayedAt: (existing && existing.lastPlayedAt) || 0,
        playCount: (existing && existing.playCount) || 0, cloud: existing && existing.cloud,
      };
      store.save();
      evict(id);
      return { clip: clips[id], reused: false };
    },

    // A processed copy of an existing clip (voice changer on something already made). The original is kept.
    async applyFx(id, rawFx) {
      const clip = clips[id];
      if (!clip) return null;
      if (!exists(clip)) throw new SpecError('the clip audio is not on disk; play it once to regenerate it');
      const settings = normalizeFxSpec(rawFx);
      if (!settings) throw new SpecError('choose an effect, pitch, speed or tighten');
      const buffer = await fx.apply(fs.readFileSync(fileOf(clip)), settings);
      const label = settings.preset !== 'none' ? settings.preset : (settings.pitch ? `pitch ${settings.pitch}` : 'edited');
      return this.addExternal({
        buffer, ext: 'mp3', title: `${clip.title} (${label})`.slice(0, 120), text: clip.text,
        source: `fx:${settings.preset}`, derivedFrom: id, tags: clip.tags,
      });
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
