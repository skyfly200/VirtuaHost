// Talking to RadioDJ's REST plugin, and reading what it says.
//
// Known to exist (used by krap-station/radiodj/radiodj_api.sh): /np, /npjson, /p, and /opt?command=<name>&arg=<value> with the commands
// EnableAutoDJ, PlayCartByNumber and ClearPlaylist. Nothing else is assumed: any other command is a setting the operator supplies.
//
// /npjson as seen on the live setup: { "CurrentTrack": { "Artist", "Title", "Duration", "Elapsed", "Remaining", "Position", ... }, "Playlist": ... }
// The shape of "Playlist" and the unit of the time fields have NOT been confirmed (seconds are assumed; "m:ss" text is also read).

// Seconds from 42, "42", "3:05" or "1:02:03"; null otherwise.
function seconds(v) {
  if (typeof v === 'number') return Number.isFinite(v) ? v : null;
  if (typeof v !== 'string' || !v.trim()) return null;
  const s = v.trim();
  if (/^\d+(\.\d+)?$/.test(s)) return Number(s);
  const m = s.match(/^(?:(\d+):)?(\d{1,2}):(\d{2})(?:\.\d+)?$/);
  return m ? (Number(m[1] || 0) * 3600) + (Number(m[2]) * 60) + Number(m[3]) : null;
}

function pick(obj, names) {
  if (!obj || typeof obj !== 'object') return undefined;
  for (const [k, v] of Object.entries(obj)) {
    if (names.includes(k.toLowerCase()) && (typeof v === 'string' || typeof v === 'number')) return v;
  }
  for (const v of Object.values(obj)) { const found = pick(v, names); if (found !== undefined) return found; }
  return undefined;
}
const entryOf = (obj, name) => { for (const [k, v] of Object.entries(obj || {})) if (k.toLowerCase() === name && v && typeof v === 'object' && !Array.isArray(v)) return v; return null; };

// { artist, title, remaining, elapsed, duration } from /npjson (CurrentTrack first, any nesting otherwise) or "Artist - Title" text from /np.
function parseNow(text) {
  let artist; let title; let remaining; let elapsed; let duration;
  try {
    const json = JSON.parse(text);
    const scope = entryOf(json, 'currenttrack') || json;
    artist = pick(scope, ['artist', 'trackartist']);
    title = pick(scope, ['title', 'tracktitle', 'song']);
    remaining = seconds(pick(scope, ['playingtrackremainingseconds', 'remainingseconds', 'remaining']));
    elapsed = seconds(pick(scope, ['elapsed', 'elapsedseconds']));
    duration = seconds(pick(scope, ['duration', 'durationseconds']));
  } catch (err) {
    const m = String(text).trim().match(/^(.+?)\s+-\s+(.+)$/);
    if (m) { artist = m[1]; title = m[2]; } else if (String(text).trim()) title = String(text).trim();
  }
  if (remaining === null || remaining === undefined) remaining = duration !== null && duration !== undefined && elapsed !== null && elapsed !== undefined ? Math.max(0, duration - elapsed) : null;
  return { artist: artist === undefined ? '' : String(artist), title: title === undefined ? '' : String(title), remaining: remaining ?? null, elapsed: elapsed ?? null, duration: duration ?? null };
}

// The upcoming items from /npjson's "Playlist" (an array, or an object holding one). SHAPE NOT CONFIRMED: anything unrecognised gives [].
function parsePlaylist(text) {
  let json;
  try { json = JSON.parse(text); } catch (err) { return []; }
  let list = null;
  for (const [k, v] of Object.entries(json || {})) if (k.toLowerCase() === 'playlist') list = v;
  if (list && !Array.isArray(list) && typeof list === 'object') list = Object.values(list).find(Array.isArray) || null;
  if (!Array.isArray(list)) return [];
  return list.filter((x) => x && typeof x === 'object').map((x) => ({
    artist: pick(x, ['artist']) === undefined ? '' : String(pick(x, ['artist'])), title: pick(x, ['title']) === undefined ? '' : String(pick(x, ['title'])),
    duration: seconds(pick(x, ['duration', 'durationseconds'])), path: pick(x, ['path', 'file', 'filename']) === undefined ? undefined : String(pick(x, ['path', 'file', 'filename'])),
  }));
}

function createRadioDJ({ url, pass = '', fetchImpl = globalThis.fetch, timeoutMs = 8000 }) {
  async function get(pathname, params = {}) {
    const u = new URL(pathname, url);
    u.searchParams.set('auth', pass);
    for (const [k, v] of Object.entries(params)) u.searchParams.set(k, v);
    const res = await fetchImpl(u, { signal: AbortSignal.timeout(timeoutMs) });
    const text = await res.text();
    if (!res.ok) throw new Error(`RadioDJ answered ${res.status}`);
    return text;
  }
  const command = (name, arg = '') => get('/opt', { command: name, arg: String(arg) });
  // The raw /npjson (or /np when that is missing) text.
  async function nowText() {
    try { return await get('/npjson'); } catch (err) { return get('/np'); }
  }
  return { get, command, nowText, async now() { return parseNow(await nowText()); }, async upcoming() { try { return parsePlaylist(await get('/npjson')); } catch (err) { return []; } } };
}

module.exports = { createRadioDJ, parseNow, parsePlaylist, seconds };
