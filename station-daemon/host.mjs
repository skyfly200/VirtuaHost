// The virtual host's loop, on the station: watches what Icecast is playing, asks the site to write and voice a link for the
// track that just started, and plays it as the NEXT track begins ("That was ..."), with Liquidsoap ducking the music.
// Same behaviour as chips-voice's server-side host: skips spots (skip list), never talks over a live DJ unless allowed,
// a link after every Nth track, never more often than minGapSeconds. The site decides what to say and how it sounds.

// "Artist - Title" or separate fields, as Icecast reports them.
export function parseNowPlaying(source) {
  if (!source) return { artist: "", title: "" };
  const title = String(source.title || "").trim();
  if (source.artist) return { artist: String(source.artist).trim(), title };
  const i = title.indexOf(" - ");
  return i > 0 ? { artist: title.slice(0, i).trim(), title: title.slice(i + 3).trim() } : { artist: "", title };
}

const sourcesOf = (status) => {
  const s = status && status.icestats && status.icestats.source;
  return Array.isArray(s) ? s : s ? [s] : [];
};
const onMount = (source, mount) => String(source.listenurl || "").replace(/\?.*$/, "").endsWith(mount);

// Reads Icecast's status-json.xsl. `url` is the full address of that file.
export function icecastReaders({ url, mount = "/stream", liveMount = "/live", fetchImpl = fetch }) {
  const read = async () => {
    const res = await fetchImpl(url, { signal: AbortSignal.timeout(5000) });
    if (!res.ok) throw new Error(`icecast returned ${res.status}`);
    return res.json();
  };
  return {
    nowPlaying: async () => parseNowPlaying(sourcesOf(await read()).find((s) => onMount(s, mount))),
    isLive: async () => sourcesOf(await read()).some((s) => onMount(s, liveMount)),
  };
}

export function createHostLoop({ api, nowPlaying, isLive, deliver, now = Date.now, log = console.log, configEveryMs = 20_000, statusEveryMs = 30_000 }) {
  const state = { current: null, ready: null, tracksSince: 0, lastLinkAt: 0, last: null, error: "", counters: { prepared: 0, played: 0, skipped: 0, failed: 0 } };
  let config = null;
  let configAt = 0;
  let statusAt = 0;
  let dirty = true;
  let busy = false;

  const isSkipped = (artist, title) => !title || config.skipArtists.map((a) => a.toLowerCase()).includes(String(artist).toLowerCase());
  const touch = () => { dirty = true; };

  async function refreshConfig() {
    if (config && now() - configAt < configEveryMs) return;
    config = (await api("/api/station/host")).config;
    configAt = now();
  }

  async function reportStatus() {
    if (!dirty && now() - statusAt < statusEveryMs) return;
    dirty = false; statusAt = now();
    await api("/api/station/host/status", {
      current: state.current && { artist: state.current.artist, title: state.current.title },
      ready: state.ready && { text: state.ready.text, about: `${state.ready.artist} - ${state.ready.title}`, source: state.ready.source },
      last: state.last, counters: state.counters, error: state.error,
    }).catch((err) => log(`could not report host status: ${err.message}`));
  }

  async function playReady(ready) {
    await deliver({ id: ready.clipId, title: ready.text, audioUrl: ready.audioUrl, fx: ready.fx, play: true, preempt: ready.preempt });
    state.last = { at: new Date(now()).toISOString(), text: ready.text, about: `${ready.artist} - ${ready.title}`, played: true };
    state.counters.played += 1; state.lastLinkAt = now();
  }

  // One look at what is playing. Never throws; safe to call on a timer.
  async function tick() {
    if (busy) return "busy";
    busy = true;
    try {
      await refreshConfig();
      if (!config.enabled) { if (state.ready) { state.ready = null; touch(); } await reportStatus(); return "off"; }

      const np = await nowPlaying();
      const key = `${np.artist}|${np.title}`;
      if (state.current && state.current.key === key) { await reportStatus(); return "same"; }

      const previous = state.current;
      const ready = state.ready;
      state.current = { key, artist: np.artist, title: np.title };
      state.ready = null;
      touch();

      // The track that just ended has a link waiting: say it over the start of this one, unless this one is a spot.
      if (previous && ready && ready.about === previous.key) {
        const quiet = isSkipped(np.artist, np.title) || (now() - state.lastLinkAt) / 1000 < config.minGapSeconds;
        if (quiet || (await isLive() && !ready.preempt)) state.counters.skipped += 1;
        else await playReady(ready).catch((err) => { state.counters.failed += 1; state.error = `could not play the link: ${err.message}`.slice(0, 200); });
      }

      // Ask the site for a link about this track, to be said when it ends.
      if (!isSkipped(np.artist, np.title)) {
        state.tracksSince += 1;
        if (state.tracksSince >= config.every && !(await isLive())) {
          state.tracksSince = 0;
          try {
            const made = await api("/api/station/host/link", { artist: np.artist, title: np.title });
            state.ready = { ...made, artist: np.artist, title: np.title, about: key };
            state.counters.prepared += 1; state.error = made.note || "";
          } catch (err) {
            state.counters.failed += 1; state.error = `could not prepare a link: ${err.message}`.slice(0, 200);
          }
        }
      }
      touch();
      await reportStatus();
      return "changed";
    } catch (err) {
      state.error = `host loop: ${err.message}`.slice(0, 200);
      touch();
      return "error";
    } finally {
      busy = false;
    }
  }

  return { tick, state };
}
