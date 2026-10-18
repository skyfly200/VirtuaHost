#!/usr/bin/env node
// Station agent for RadioDJ on Windows. It speaks the same small HTTP API as a Chips Voice server running Liquidsoap, so the hub
// (../hub) can control both the same way. No dependencies: Node 18+ only.
//
//   GET  /agent/info                 what this agent can do
//   GET  /music/now                  { title, artist, remainingSeconds, raw }  (read from the RadioDJ REST plugin)
//   POST /music/skip                 needs RADIODJ_CMD_SKIP
//   POST /music/volume {volume 0-1}  needs RADIODJ_CMD_VOLUME
//   GET  /music/playlists            []  (RadioDJ playlists live in its database; not driven from here)
//   GET  /music/library              files under MUSIC_DIR, if set
//   POST /ingest?play=1&title=...    audio body; saved as the one file a RadioDJ cart plays; play=1 fires that cart
//   POST /clips/:id/play             fire the cart for a clip that was ingested without play=1
//
// How a clip reaches the air: like krap-station/host/virtual_host.py, the clip is written to a FIXED file name
// (LINKS_DIR/CLIP_FILE) and a RadioDJ cart that plays that file is triggered with PlayCartByNumber. So you need one cart in RadioDJ
// pointing at that file. (Those RadioDJ commands are the ones krap-station/radiodj/radiodj_api.sh already uses.)
//
// NOT VERIFIED against a live RadioDJ: the shape of /npjson (the parser looks for artist/title keys and falls back to /np text), and the
// names of the skip and volume commands, which is why those are settings instead of defaults. Find them in the REST plugin's documentation.
//
// Env: AGENT_KEY (required), AGENT_PORT=3100, AGENT_HOST=0.0.0.0, STATION_NAME, RADIODJ_URL=http://127.0.0.1:8080, RADIODJ_PASS,
//      LINKS_DIR, CLIP_FILE=current_link.mp3, CLIP_CART, RADIODJ_CMD_SKIP, RADIODJ_CMD_VOLUME, VOLUME_SCALE=100, MUSIC_DIR, MAX_CLIP_MB=25
const http = require('http');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const AUDIO = /\.(mp3|ogg|oga|opus|flac|wav|m4a|aac|wma)$/i;

function createAgent(options = {}) {
  const o = {
    key: '', name: 'RadioDJ', radiodjUrl: 'http://127.0.0.1:8080', radiodjPass: '', linksDir: '', clipFile: 'current_link.mp3', clipCart: '',
    cmdSkip: '', cmdVolume: '', volumeScale: 100, musicDir: '', maxClipBytes: 25e6, fetchImpl: globalThis.fetch, timeoutMs: 8000, ...options,
  };
  if (!o.key) throw new Error('AGENT_KEY is required: the agent controls what goes on air');
  const safeEq = (a, b) => { const x = Buffer.from(String(a)); const y = Buffer.from(String(b)); return x.length === y.length && crypto.timingSafeEqual(x, y); };
  const state = { staged: new Map() };      // clip id -> { title, at }

  async function radiodj(pathname, params = {}) {
    const url = new URL(pathname, o.radiodjUrl);
    url.searchParams.set('auth', o.radiodjPass);
    for (const [k, v] of Object.entries(params)) url.searchParams.set(k, v);
    const res = await o.fetchImpl(url, { signal: AbortSignal.timeout(o.timeoutMs) });
    const text = await res.text();
    if (!res.ok) throw new Error(`RadioDJ answered ${res.status}`);
    return text;
  }
  const command = (name, arg = '') => radiodj('/opt', { command: name, arg: String(arg) });

  // Looks for artist/title anywhere in whatever JSON the plugin returns; otherwise "Artist - Title" text.
  function parseNow(text) {
    const pick = (obj, names) => {
      if (!obj || typeof obj !== 'object') return undefined;
      for (const [k, v] of Object.entries(obj)) {
        if (names.includes(k.toLowerCase()) && (typeof v === 'string' || typeof v === 'number')) return String(v);
      }
      for (const v of Object.values(obj)) { const found = pick(v, names); if (found !== undefined) return found; }
      return undefined;
    };
    let artist; let title; let remaining;
    try {
      const json = JSON.parse(text);
      artist = pick(json, ['artist', 'trackartist']);
      title = pick(json, ['title', 'tracktitle', 'song']);
      remaining = pick(json, ['playingtrackremainingseconds', 'remainingseconds']);
    } catch (err) {
      const m = String(text).trim().match(/^(.+?)\s+-\s+(.+)$/);
      if (m) { artist = m[1]; title = m[2]; } else if (String(text).trim()) title = String(text).trim();
    }
    return { artist: artist || '', title: title || '', remaining: remaining !== undefined && Number.isFinite(Number(remaining)) ? Number(remaining) : null };
  }

  function listTracks() {
    const out = [];
    const walk = (dir, rel) => {
      let entries; try { entries = fs.readdirSync(dir, { withFileTypes: true }); } catch (err) { return; }
      for (const e of entries) {
        if (out.length >= 50000 || e.name.startsWith('.')) continue;
        const r = rel ? `${rel}/${e.name}` : e.name;
        if (e.isDirectory()) walk(path.join(dir, e.name), r);
        else if (e.isFile() && AUDIO.test(e.name)) out.push({ path: r, size: fs.statSync(path.join(dir, e.name)).size });
      }
    };
    if (o.musicDir) walk(o.musicDir, '');
    return out.sort((a, b) => a.path.localeCompare(b.path));
  }

  const caps = () => ({
    skip: !!o.cmdSkip, volume: !!o.cmdVolume, playlists: false, library: !!o.musicDir, definePlaylist: false, clip: !!(o.linksDir && o.clipCart),
  });

  async function readBody(req, limit) {
    const chunks = []; let size = 0;
    for await (const chunk of req) {
      size += chunk.length;
      if (size > limit) { const err = new Error('body is too large'); err.status = 413; throw err; }
      chunks.push(chunk);
    }
    return Buffer.concat(chunks);
  }

  async function fire(id) {
    await command('PlayCartByNumber', o.clipCart);
    state.staged.delete(id);
  }

  async function route(req, res, url) {
    const send = (status, body) => { const text = JSON.stringify(body); res.writeHead(status, { 'content-type': 'application/json', 'content-length': Buffer.byteLength(text) }); res.end(text); };
    const m = req.method;
    const p = url.pathname;
    if (m === 'GET' && p === '/agent/info') return send(200, { kind: 'radiodj', name: o.name, capabilities: caps() });
    if (m === 'GET' && p === '/music/now') {
      let text;
      try { text = await radiodj('/npjson'); } catch (err) { try { text = await radiodj('/np'); } catch (e2) { return send(502, { error: `cannot reach RadioDJ: ${e2.message}` }); } }
      const now = parseNow(text);
      return send(200, { title: now.artist ? `${now.artist} - ${now.title}` : now.title || null, artist: now.artist, track: now.title, remainingSeconds: now.remaining, listeners: null, live: false });
    }
    if (m === 'POST' && p === '/music/skip') {
      if (!o.cmdSkip) return send(501, { error: 'skip is not configured (set RADIODJ_CMD_SKIP to the REST plugin command that skips)' });
      return send(200, { reply: (await command(o.cmdSkip)).slice(0, 200) });
    }
    if (m === 'POST' && p === '/music/volume') {
      if (!o.cmdVolume) return send(501, { error: 'volume is not configured (set RADIODJ_CMD_VOLUME to the REST plugin command that sets it)' });
      const body = JSON.parse((await readBody(req, 2000)).toString() || '{}');
      const volume = Number(body.volume);
      if (!Number.isFinite(volume)) return send(400, { error: 'volume must be a number' });
      const clamped = Math.min(1, Math.max(0, volume));
      return send(200, { volume: clamped, reply: (await command(o.cmdVolume, Math.round(clamped * o.volumeScale))).slice(0, 200) });
    }
    if (m === 'GET' && p === '/music/playlists') return send(200, []);
    if (m === 'GET' && p === '/music/library') return send(200, { tracks: listTracks() });
    if (m === 'PUT' && p.startsWith('/music/playlists/')) return send(501, { error: 'RadioDJ playlists live in its database; this agent cannot define them' });
    if (m === 'POST' && p === '/ingest') {
      if (!o.linksDir || !o.clipCart) return send(501, { error: 'set LINKS_DIR and CLIP_CART to play clips' });
      const body = await readBody(req, o.maxClipBytes);
      if (!body.length) return send(400, { error: 'send the audio as the request body' });
      const id = crypto.createHash('sha1').update(body).digest('hex').slice(0, 12);
      fs.mkdirSync(o.linksDir, { recursive: true });
      const target = path.join(o.linksDir, o.clipFile);
      fs.writeFileSync(`${target}.tmp`, body);
      fs.renameSync(`${target}.tmp`, target);                  // a fixed name, like virtual_host.py: one cart always plays "the current clip"
      state.staged.clear();
      state.staged.set(id, { title: url.searchParams.get('title') || '', at: Date.now() });
      const play = ['1', 'true'].includes(url.searchParams.get('play'));
      if (play) await fire(id);
      return send(play ? 200 : 201, { clip: { id, title: url.searchParams.get('title') || '' }, played: play });
    }
    const play = p.match(/^\/clips\/([A-Za-z0-9]+)\/play$/);
    if (m === 'POST' && play) {
      if (!state.staged.has(play[1])) return send(404, { error: 'that clip is not the one waiting on this agent (a newer clip replaced it)' });
      await fire(play[1]);
      return send(200, { played: true });
    }
    return send(404, { error: 'not found' });
  }

  const server = http.createServer(async (req, res) => {
    const url = new URL(req.url, 'http://agent');
    const given = req.headers['x-api-key'] || String(req.headers.authorization || '').replace(/^Bearer\s+/i, '');
    if (!safeEq(given, o.key)) { res.writeHead(401, { 'content-type': 'application/json' }); return res.end('{"error":"unauthorized"}'); }
    try {
      await route(req, res, url);
    } catch (err) {
      if (res.headersSent) return res.end();
      const status = err.status || (err instanceof SyntaxError ? 400 : 502);
      res.writeHead(status, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ error: status === 502 ? `RadioDJ call failed: ${err.message}` : err.message }));
    }
  });

  return { server, parseNow, caps };
}

function fromEnv(env = process.env) {
  return {
    key: env.AGENT_KEY || '', name: env.STATION_NAME || 'RadioDJ', radiodjUrl: env.RADIODJ_URL || 'http://127.0.0.1:8080', radiodjPass: env.RADIODJ_PASS || '',
    linksDir: env.LINKS_DIR || '', clipFile: env.CLIP_FILE || 'current_link.mp3', clipCart: env.CLIP_CART || '',
    cmdSkip: env.RADIODJ_CMD_SKIP || '', cmdVolume: env.RADIODJ_CMD_VOLUME || '', volumeScale: parseFloat(env.VOLUME_SCALE || '100'),
    musicDir: env.MUSIC_DIR || '', maxClipBytes: parseFloat(env.MAX_CLIP_MB || '25') * 1e6,
  };
}

if (require.main === module) {
  const { server } = createAgent(fromEnv());
  const port = parseInt(process.env.AGENT_PORT || '3100', 10);
  server.listen(port, process.env.AGENT_HOST || '0.0.0.0', () => console.error(`RadioDJ agent listening on ${port}`));
}

module.exports = { createAgent, fromEnv };
