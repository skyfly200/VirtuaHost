// A small client for the Chips Voice HTTP API. The MCP server, the chat commands and the built-in /mcp endpoint
// all go through it, so there is one tested surface and every action passes the same authentication.
class StationError extends Error {
  constructor(message, status) { super(message); this.status = status; }
}

function createStationClient({ baseUrl, key, fetchImpl = fetch, timeoutMs = 120000 }) {
  const base = String(baseUrl || '').replace(/\/+$/, '');
  if (!base) throw new Error('CHIPS_VOICE_URL is not set');

  async function call(method, path, { query, body } = {}) {
    const url = new URL(base + path);
    for (const [k, v] of Object.entries(query || {})) if (v !== undefined && v !== null && v !== '') url.searchParams.set(k, String(v));
    let res;
    try {
      res = await fetchImpl(url, {
        method,
        headers: { ...(key ? { 'x-api-key': key } : {}), ...(body !== undefined ? { 'Content-Type': 'application/json' } : {}) },
        body: body !== undefined ? JSON.stringify(body) : undefined,
        signal: AbortSignal.timeout(timeoutMs),
      });
    } catch (err) {
      throw new StationError(`cannot reach the station at ${base}: ${err.message}`, 0);
    }
    const text = await res.text();
    let json = null;
    try { json = text ? JSON.parse(text) : null; } catch (e) { /* not JSON */ }
    if (!res.ok) throw new StationError((json && json.error) || `the station answered ${res.status}`, res.status);
    return json;
  }

  const soft = (p) => p.catch((err) => ({ error: err.message }));

  return {
    call,
    // What is happening right now: music, host, and what the server can do.
    status: async () => {
      const [now, host, providers] = await Promise.all([soft(call('GET', '/music/now')), soft(call('GET', '/host')), soft(call('GET', '/providers'))]);
      return { now, host, providers };
    },
    nowPlaying: () => call('GET', '/music/now'),
    skip: () => call('POST', '/music/skip'),
    setVolume: (volume) => call('POST', '/music/volume', { body: { volume } }),
    playlists: () => call('GET', '/music/playlists'),
    setPlaylist: (name) => call('POST', '/music/playlist', { body: { name } }),

    speak: (spec) => call('POST', '/speak', { body: spec }),
    synth: (spec) => call('POST', '/synth', { body: spec }),
    draft: (body) => call('POST', '/announcements/draft', { body }),

    clips: (query) => call('GET', '/clips', { query }),
    playClip: (id, preempt) => call('POST', `/clips/${encodeURIComponent(id)}/play`, { body: { preempt } }),
    updateClip: (id, patch) => call('PATCH', `/clips/${encodeURIComponent(id)}`, { body: patch }),
    applyFx: (id, fx) => call('POST', `/clips/${encodeURIComponent(id)}/fx`, { body: { fx } }),
    clipLink: (id, hours) => call('POST', `/clips/${encodeURIComponent(id)}/link`, { body: { hours } }),
    shareClip: (id, target) => call('POST', `/clips/${encodeURIComponent(id)}/share`, { body: { target } }),

    schedules: () => call('GET', '/schedules'),
    schedule: (body) => call('POST', '/schedules', { body }),
    updateSchedule: (id, patch) => call('PATCH', `/schedules/${encodeURIComponent(id)}`, { body: patch }),
    deleteSchedule: (id) => call('DELETE', `/schedules/${encodeURIComponent(id)}`),

    host: () => call('GET', '/host'),
    hostUpdate: (patch) => call('PUT', '/host', { body: patch }),
    hostSay: (body) => call('POST', '/host/say', { body }),

    voices: (provider) => call('GET', '/tts/voices', { query: { provider } }),
    fxPresets: () => call('GET', '/fx/presets'),
    sfx: () => call('GET', '/sfx'),
    providers: () => call('GET', '/providers'),
  };
}

module.exports = { createStationClient, StationError };
