// Server-side virtual host: a replication of krap-station/host/virtual_host.py that runs next to Liquidsoap.
// The original script is left untouched; it follows RadioDJ on a Windows machine, this follows Icecast.
//
// What it does, matching the script's "live host v1":
//   - watches what is playing (artist and title);
//   - writes a short link about the track that just played, from the same template lines (30% of the time
//     with a time-of-day line added), skipping station spots and relay audio;
//   - voices it in the host's voice (Rocky by default) through the normal speech providers, then finishes the
//     audio with the KRAP "underground" treatment;
//   - puts it on air.
//
// What differs, on purpose:
//   - Timing. RadioDJ reports seconds remaining, Icecast does not. So the link for a track is prepared while that
//     track plays, and is played as the NEXT track begins ("That was ...") with Liquidsoap ducking the music.
//     This is the "ducking over intros" item on the script's not-built list.
//   - Never talks over a spot: nothing is played over a track whose artist is in the skip list, and nothing is
//     generated or played while a live DJ is on air.
//   - "Smarter lines": lines can be written by the configured language model, falling back to the templates.
const TEMPLATES = [
  "That was {artist} with {title}. You're listening to K.R.A.P., ninety-seven point seven.",
  '{artist}, {title}. Mm. Stay right here on K.R.A.P.',
  '[chuckles] That was {title} by {artist}. More coming up, right here on K.R.A.P.',
  '{title}, from {artist}. This is K.R.A.P., the official radio of Apo-jee-uh.',
];
const TIME_LINES = {
  morning: ' Good morning, wherever you are.',
  afternoon: '',
  evening: " Hope your evening's treating you well.",
  night: ' Late night, just us and the music.',
};
const DEFAULT_SKIP = ['', 'syndicate empire radio', 'way high radio', 'k.r.a.p. relay'];

const daypart = (h) => (h >= 5 && h < 12 ? 'morning' : h < 17 ? 'afternoon' : h < 22 ? 'evening' : 'night');

// "Artist - Title" or separate fields, as Icecast reports them.
function parseNowPlaying(source) {
  if (!source) return { artist: '', title: '' };
  const title = String(source.title || '').trim();
  if (source.artist) return { artist: String(source.artist).trim(), title };
  const i = title.indexOf(' - ');
  return i > 0 ? { artist: title.slice(0, i).trim(), title: title.slice(i + 3).trim() } : { artist: '', title };
}

const DEFAULTS = {
  enabled: false,
  every: 1,                 // a link after every Nth track
  minGapSeconds: 45,        // never more often than this
  lines: 'template',        // template | llm (falls back to template)
  voice: '',                // a voice name from the speech provider ("Rocky"); empty means the provider default
  provider: '',             // speech provider name; empty means the first enabled one
  fx: 'underground',        // audio treatment preset; empty means none
  preempt: false,           // may interrupt a live DJ (normally it just stays quiet)
  skipArtists: DEFAULT_SKIP,
  templates: TEMPLATES,
  persona: '',              // extra instructions for language-model lines
};

function createHost({ store, clips, llm, play, nowPlaying, isLive = async () => false, now = Date.now, rng = Math.random, pollMs = 2000, limits = {}, defaults = {}, stationName = 'the station' }) {
  if (!store.data.host) store.data.host = {};
  const base = { ...DEFAULTS, ...defaults };
  const settings = () => ({ ...base, ...store.data.host });

  const state = {
    running: false, current: null, ready: null, preparing: false,
    tracksSince: 0, lastLinkAt: 0, last: null, error: '', counters: { prepared: 0, played: 0, skipped: 0, failed: 0 },
  };
  let timer = null;
  let busy = false;

  const isSkipped = (artist, title, cfg) => !title || cfg.skipArtists.map((a) => a.toLowerCase()).includes(String(artist).toLowerCase());

  function composeTemplate(artist, title, cfg) {
    const pool = cfg.templates && cfg.templates.length ? cfg.templates : TEMPLATES;
    let line = pool[Math.floor(rng() * pool.length)].replace(/\{artist\}/g, artist).replace(/\{title\}/g, title);
    if (rng() < 0.3) line += TIME_LINES[daypart(new Date(now()).getHours())];
    return line;
  }

  async function compose(artist, title, cfg = settings()) {
    if (cfg.lines === 'llm' && llm && llm.enabled) {
      try {
        const out = await llm.generate({
          system: `You are the on-air host of ${stationName}, between songs. Write ONE short link (one or two sentences, under 220 characters) `
            + 'about the song that just played, to be read aloud. Plain text only: no quotation marks, no emoji, no hashtags, no stage directions. '
            + 'You may use a single audio tag such as [chuckles] or [softly]. Mention the artist and title.'
            + (cfg.persona ? ` ${cfg.persona}` : ''),
          prompt: `That song was "${title}" by ${artist}. It is ${daypart(new Date(now()).getHours())}.`,
          maxTokens: 120,
        });
        const text = out.text.replace(/\s+/g, ' ').trim().slice(0, 400);
        if (text) return { text, source: 'llm' };
      } catch (err) {
        state.error = `language model failed, used a template: ${err.message}`.slice(0, 200);
      }
    }
    return { text: composeTemplate(artist, title, cfg), source: 'template' };
  }

  function specFor(text, cfg) {
    const spec = { text, voice: cfg.voice || undefined, provider: cfg.provider || undefined, fx: cfg.fx || undefined, format: 'MP3' };
    return spec;
  }

  // Writes and voices the link for a track (not played yet).
  async function prepare(artist, title, cfg) {
    const line = await compose(artist, title, cfg);
    const { clip, reused } = await clips.getOrCreate(specFor(line.text, cfg), limits);
    return { artist, title, text: line.text, source: line.source, clipId: clip.id, reused, at: now() };
  }

  async function playReady(ready, cfg) {
    const clip = clips.get(ready.clipId);
    if (!clip) throw new Error('prepared link was deleted');
    const result = (await play(clip, { preempt: cfg.preempt })) || { played: true };
    state.last = { at: now(), text: ready.text, about: `${ready.artist} - ${ready.title}`, played: result.played !== false, reason: result.reason || '' };
    if (result.played === false) state.counters.skipped += 1; else { state.counters.played += 1; state.lastLinkAt = now(); }
  }

  // One look at what is playing. Safe to call on a timer; never throws.
  async function tick() {
    if (busy) return;
    busy = true;
    try {
      const cfg = settings();
      const np = await nowPlaying();
      const key = `${np.artist}|${np.title}`;
      if (state.current && state.current.key === key) return;            // same track still playing

      const previous = state.current;
      const ready = state.ready;
      state.current = { key, artist: np.artist, title: np.title };
      state.ready = null;

      // The track that just ended has a link waiting: play it over the start of this one, unless this one is a spot.
      if (previous && ready && ready.about === previous.key) {
        const quiet = isSkipped(np.artist, np.title, cfg) || (now() - state.lastLinkAt) / 1000 < cfg.minGapSeconds;
        if (quiet) state.counters.skipped += 1;
        else if (await isLive() && !cfg.preempt) state.counters.skipped += 1;
        else await playReady(ready, cfg).catch((err) => { state.counters.failed += 1; state.error = `could not play the link: ${err.message}`.slice(0, 200); });
      }

      // Prepare the link for this track, to be played when it ends.
      if (!isSkipped(np.artist, np.title, cfg)) {
        state.tracksSince += 1;
        if (state.tracksSince >= cfg.every && !(await isLive())) {
          state.tracksSince = 0;
          state.preparing = true;
          try {
            const made = await prepare(np.artist, np.title, cfg);
            state.ready = { ...made, about: key };
            state.counters.prepared += 1;
            state.error = '';
          } catch (err) {
            state.counters.failed += 1;
            state.error = `could not prepare a link: ${err.message}`.slice(0, 200);
          } finally {
            state.preparing = false;
          }
        }
      }
    } catch (err) {
      state.error = `could not read what is playing: ${err.message}`.slice(0, 200);
    } finally {
      busy = false;
    }
  }

  const api = {
    DEFAULTS, TEMPLATES, TIME_LINES, parseNowPlaying,
    settings,
    compose: (artist, title) => compose(artist, title),

    status() {
      return {
        running: state.running, settings: settings(),
        current: state.current && { artist: state.current.artist, title: state.current.title },
        ready: state.ready && { text: state.ready.text, about: `${state.ready.artist} - ${state.ready.title}`, source: state.ready.source },
        preparing: state.preparing, last: state.last, error: state.error, counters: { ...state.counters },
      };
    },

    update(patch = {}) {
      const next = { ...store.data.host };
      if (typeof patch.enabled === 'boolean') next.enabled = patch.enabled;
      if (patch.every !== undefined) next.every = Math.min(50, Math.max(1, Math.floor(Number(patch.every)) || 1));
      if (patch.minGapSeconds !== undefined) next.minGapSeconds = Math.min(3600, Math.max(0, Number(patch.minGapSeconds) || 0));
      if (['template', 'llm'].includes(patch.lines)) next.lines = patch.lines;
      for (const key of ['voice', 'provider', 'fx']) if (typeof patch[key] === 'string') next[key] = patch[key].trim().slice(0, 200);
      if (typeof patch.preempt === 'boolean') next.preempt = patch.preempt;
      if (typeof patch.persona === 'string') next.persona = patch.persona.slice(0, 500);
      if (Array.isArray(patch.skipArtists)) next.skipArtists = patch.skipArtists.map((a) => String(a).trim().slice(0, 100)).slice(0, 100);
      if (Array.isArray(patch.templates)) {
        const t = patch.templates.map((x) => String(x).trim().slice(0, 300)).filter(Boolean).slice(0, 50);
        if (t.length) next.templates = t;
      }
      store.data.host = next;
      store.save();
      if (next.enabled) api.start(); else api.stop();
      return api.status();
    },

    // Like `virtual_host.py --say ARTIST TITLE [--dry-run]`: one link now. It is only played if asked to.
    async say({ artist, title, dryRun = false, play: playIt = false }) {
      const cfg = settings();
      if (!title) throw new Error('title is required');
      if (dryRun) return { ...(await compose(String(artist || ''), String(title), cfg)), dryRun: true };
      const made = await prepare(String(artist || ''), String(title), cfg);
      if (playIt) await playReady(made, cfg);
      return { ...made, played: playIt && state.last ? state.last.played : false };
    },

    tick,

    start() {
      if (timer) return;
      state.running = true;
      timer = setInterval(() => tick(), pollMs);
      if (timer.unref) timer.unref();
    },
    stop() {
      if (timer) { clearInterval(timer); timer = null; }
      state.running = false;
    },
  };
  return api;
}

module.exports = { createHost, parseNowPlaying, TEMPLATES, TIME_LINES, DEFAULT_SKIP };
