#!/usr/bin/env node
// Station agent for RadioDJ on Windows. It speaks the same small HTTP API as a Chips Voice server running Liquidsoap, so the hub
// (../hub) can control both the same way. No dependencies: Node 18+ only. Full reference: docs/HUB.md and docs/INTEGRATION.md.
//
// Read key (GET only)                              Control key (everything)
//   GET  /agent/info                 what this agent can do, and the two clocks (machineTz, broadcastTz)
//   GET  /agent/status               stream up/down, listeners, loaded playlist, now playing + next N, watchdog, mode, shadow, kill switch
//   GET  /schedule?date=YYYY-MM-DD   the day's plan (song, drop, interlude, segment, host-break, dynamic-slot), read-only
//   GET  /agent/audit?limit=         the tail of the audit log
//   GET  /music/now                  { title, artist, remainingSeconds, elapsedSeconds, durationSeconds, ... }
//   GET  /music/playlists | /music/library
//   POST /ingest?play=1&title=...    audio body; saved under a hash-based file name; play=1 fires it (see below)
//   POST /clips/:id/play             fire a clip that was ingested without play=1
//   POST /queue/insert {clip, ahead} put an ingested clip at least 2 items ahead of the current track      (NEEDS LIVE VERIFICATION)
//   POST /playlist/load {name}       load a playlist named "GLR YYYY-MM-DD*"                              (NEEDS LIVE VERIFICATION)
//   POST /music/skip | /music/volume only when their commands are configured; skip also needs RADIODJ_SKIP_VERIFIED=true
//   POST /agent/kill {on:true}       kill switch on (switching it off is done on the PC: delete the flag file)
//   POST /agent/mode {mode:"live-show"}   enter live-show (leaving it is done on the PC)
//
// Every control call: checks the control key, rate limit, kill switch, live-show, the action allowlist, shadow mode (for generated clips), then
// runs, then is appended to the audit log. Nothing here is reachable from outside unless AGENT_HOST says so; default 127.0.0.1.
//
// How a clip reaches the air: it is saved under LINKS_DIR/<sha256 prefix>.<ext> (a name that is never reused, so Windows holding an old file
// open cannot block it). Then either the legacy fixed-cart way (a copy goes to CLIP_FILE and PlayCartByNumber fires CLIP_CART, like
// krap-station/host/virtual_host.py) or a command/script you configure (PLAY_EXEC, INSERT_EXEC, RADIODJ_CMD_INSERT).
//
// NOT VERIFIED against a live RadioDJ: the "Playlist" shape of /npjson, the time unit of its fields, and every command beyond
// PlayCartByNumber/EnableAutoDJ/ClearPlaylist. Insert, playlist load, skip and volume use commands or scripts that YOU name; none is guessed.
const http = require('http');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { execFile } = require('child_process');
const tz = require('./tz');
const { createRadioDJ, parseNow, parsePlaylist } = require('./radiodj');
const { createAudit, createRateLimit } = require('./audit');
const { createSchedule } = require('./schedule');

const AUDIO = /\.(mp3|ogg|oga|opus|flac|wav|m4a|aac|wma)$/i;
const EXT_BY_TYPE = { 'audio/mpeg': 'mp3', 'audio/mp3': 'mp3', 'audio/wav': 'wav', 'audio/x-wav': 'wav', 'audio/wave': 'wav', 'audio/ogg': 'ogg', 'audio/opus': 'opus', 'audio/flac': 'flac', 'audio/mp4': 'm4a', 'audio/aac': 'aac' };
const ACTIONS = ['ingest', 'play-clip', 'insert', 'load-playlist', 'skip', 'volume'];
const DEFAULT_PLAYLIST_PATTERN = '^GLR \\d{4}-\\d{2}-\\d{2}( [A-Za-z0-9 ._-]{1,40})?$';
const isLoopback = (h) => ['127.0.0.1', '::1', 'localhost'].includes(String(h));

// A command line as program + arguments (double quotes group words); it is run WITHOUT a shell.
function splitCommand(line) {
  const out = [];
  const re = /"([^"]*)"|(\S+)/g;
  let m;
  while ((m = re.exec(String(line || '')))) out.push(m[1] !== undefined ? m[1] : m[2]);
  return out;
}

function createAgent(options = {}) {
  const defaultDir = process.platform === 'win32' ? 'C:\\GreenLightRadio' : path.join(process.cwd(), 'GreenLightRadio');
  const o = {
    key: '', readKey: '', controlKey: '', keys: [], name: 'RadioDJ', radiodjUrl: 'http://127.0.0.1:8080', radiodjPass: '', linksDir: path.join(defaultDir, 'clips'), clipFile: '', clipCart: '',
    cmdSkip: '', skipVerified: false, cmdVolume: '', volumeScale: 100, musicDir: '', maxClipBytes: 25e6, fetchImpl: globalThis.fetch, timeoutMs: 8000,
    broadcastTz: '', machineTz: '', dataDir: path.join(defaultDir, 'agent'), killFile: '', modeFile: '', auditFile: '', scheduleDir: '',
    icecastUrl: '', icecastMount: '/stream', watchdogFile: '', loadedPlaylistFile: '',
    shadow: true, allow: ACTIONS, rateControlPerMin: 30, rateReadPerMin: 240,
    insertCommand: '', insertArg: '{path}', insertExec: '', loadCommand: '', loadArg: '{name}', loadExec: '', playExec: '', playlistPattern: DEFAULT_PLAYLIST_PATTERN,
    confirmSeconds: 6, confirmPollMs: 500, upNext: 5, execImpl: execFile, now: Date.now, sleep: (ms) => new Promise((r) => setTimeout(r, ms)), ...options,
  };
  if (!o.clipFile) o.clipFile = 'current_link.mp3';
  const keys = [...(o.keys || [])];
  if (o.key) keys.push({ id: 'default', scopes: ['read', 'control'], key: o.key });
  if (o.readKey) keys.push({ id: 'default', scopes: ['read'], key: o.readKey });
  if (o.controlKey) keys.push({ id: 'default', scopes: ['read', 'control'], key: o.controlKey });
  if (!keys.length) throw new Error('AGENT_KEY is required (or AGENT_CONTROL_KEY and AGENT_READ_KEY): the agent controls what goes on air');
  if (o.machineTz && !tz.validTimeZone(o.machineTz)) throw new Error(`MACHINE_TZ "${o.machineTz}" is not a time zone name (use something like America/Chicago)`);
  if (o.broadcastTz && !tz.validTimeZone(o.broadcastTz)) throw new Error(`BROADCAST_TZ "${o.broadcastTz}" is not a time zone name (use something like America/Denver)`);
  const broadcastTz = o.broadcastTz || o.machineTz || 'UTC';
  const machineTz = o.machineTz || broadcastTz;
  const allow = new Set(o.allow);

  const digest = (v) => crypto.createHash('sha256').update(String(v)).digest();
  const identify = (given) => {
    if (!given) return null;
    let found = null;
    for (const k of keys) if (crypto.timingSafeEqual(digest(given), digest(k.key)) && !found) found = k;     // every key is compared: the time does not reveal which
    return found ? { hub: found.id, scopes: new Set(found.scopes) } : null;
  };

  const radiodj = createRadioDJ({ url: o.radiodjUrl, pass: o.radiodjPass, fetchImpl: o.fetchImpl, timeoutMs: o.timeoutMs });
  const file = (name, given) => given || (o.dataDir ? path.join(o.dataDir, name) : '');
  const killFile = file('KILL', o.killFile);
  const modeFile = file('mode', o.modeFile);
  const audit = createAudit({ file: file('audit.jsonl', o.auditFile), now: o.now });
  const schedule = createSchedule({ dir: o.scheduleDir, broadcastTz, now: o.now });
  const controlLimit = createRateLimit({ max: o.rateControlPerMin, now: o.now });
  const readLimit = createRateLimit({ max: o.rateReadPerMin, now: o.now });
  const authFail = createRateLimit({ max: 10, now: o.now });
  const stateFile = file('state.json');
  const state = { staged: new Map(), inserted: {}, loadedPlaylist: null, killMemory: null, modeMemory: null, lastAuthLog: 0 };       // staged: clip id -> clip
  try {
    if (stateFile) { const saved = JSON.parse(fs.readFileSync(stateFile, 'utf8')); state.inserted = saved.inserted || {}; state.loadedPlaylist = saved.loadedPlaylist || null; }
  } catch (err) { /* first run */ }
  const saveState = () => {
    if (!stateFile) return;
    try {
      const keep = Object.entries(state.inserted).sort((a, b) => (b[1].at || 0) - (a[1].at || 0)).slice(0, 500);
      fs.mkdirSync(path.dirname(stateFile), { recursive: true });
      fs.writeFileSync(`${stateFile}.tmp`, JSON.stringify({ inserted: Object.fromEntries(keep), loadedPlaylist: state.loadedPlaylist }), { mode: 0o600 });
      fs.renameSync(`${stateFile}.tmp`, stateFile);
    } catch (err) { /* state is a convenience (idempotency across restarts); never stop the air for it */ }
  };

  // ---------- switches ----------
  const kill = () => {
    if (killFile) { try { const st = fs.statSync(killFile); return { on: true, reason: fs.readFileSync(killFile, 'utf8').trim().slice(0, 200), at: new Date(st.mtimeMs).toISOString() }; } catch (err) { /* no flag file */ } }
    return state.killMemory ? { on: true, ...state.killMemory } : { on: false };
  };
  const mode = () => {
    if (modeFile) { try { return fs.readFileSync(modeFile, 'utf8').trim().toLowerCase() === 'live-show' ? 'live-show' : 'automation'; } catch (err) { /* no file */ } }
    return state.modeMemory === 'live-show' ? 'live-show' : 'automation';
  };

  // ---------- RadioDJ, the configurable ways ----------
  const run = (line, extra, timeout = 20000) => new Promise((resolve, reject) => {
    const [program, ...args] = splitCommand(line);
    if (!program) return reject(new Error('the script setting is empty'));
    o.execImpl(program, [...args, ...extra], { timeout, windowsHide: true, shell: false }, (err, stdout, stderr) => (err ? reject(new Error(`${path.basename(program)} failed: ${String(stderr || err.message).trim().slice(0, 200)}`)) : resolve(String(stdout).trim().slice(0, 300))));
  });
  const fill = (template, values) => String(template).replace(/\{(\w+)\}/g, (m, k) => (values[k] === undefined ? '' : String(values[k])));

  // ---------- reading ----------
  async function streamStatus() {
    if (!o.icecastUrl) return { up: null, listeners: null, note: 'ICECAST_URL is not set' };
    try {
      const res = await o.fetchImpl(new URL('/status-json.xsl', o.icecastUrl), { signal: AbortSignal.timeout(3000) });
      if (!res.ok) return { up: false, listeners: null, error: `Icecast answered ${res.status}` };
      const stats = (await res.json()).icestats || {};
      const sources = [].concat(stats.source || []);
      const mount = sources.find((s) => String(s.listenurl || '').endsWith(o.icecastMount));
      return mount ? { up: true, listeners: Number.isFinite(Number(mount.listeners)) ? Number(mount.listeners) : null, mount: o.icecastMount } : { up: false, listeners: null, mount: o.icecastMount, error: `no source on ${o.icecastMount}` };
    } catch (err) { return { up: false, listeners: null, error: `Icecast is not reachable: ${err.message}` }; }
  }
  function fileInfo(p) {
    if (!p) return null;
    try {
      const text = fs.readFileSync(p, 'utf8').trim();
      try { return JSON.parse(text); } catch (err) { return { raw: text.slice(0, 200) }; }
    } catch (err) { return null; }
  }
  const clocks = () => {
    const t = o.now();
    const pcOffsetMinutes = tz.localOffsetMinutes(new Date(t));
    return { machineTz, broadcastTz, machineNow: tz.formatIso(t, machineTz), broadcastNow: tz.formatIso(t, broadcastTz), pcOffsetMinutes, warnings: tz.zoneWarnings({ machineTz, broadcastTz, pcOffsetMinutes, now: t }) };
  };
  const caps = () => ({
    skip: !!o.cmdSkip && !!o.skipVerified, volume: !!o.cmdVolume, playlists: !!(o.loadCommand || o.loadExec), library: !!o.musicDir, definePlaylist: false,
    clip: !!((o.linksDir && o.clipCart) || o.playExec || o.insertCommand || o.insertExec), queueInsert: !!(o.insertCommand || o.insertExec), playlistLoad: !!(o.loadCommand || o.loadExec),
    status: true, schedule: !!o.scheduleDir, shadow: true, killSwitch: true,
  });
  const NEEDS_LIVE_VERIFICATION = ['queueInsert', 'playlistLoad', 'skip', 'playlistShape(/npjson)', 'playConfirm'];

  async function status(next = o.upNext) {
    const [stream, nowText] = await Promise.all([streamStatus(), radiodj.nowText().then((t) => ({ ok: true, text: t }), (e) => ({ ok: false, error: e.message }))]);
    const out = { name: o.name, kind: 'radiodj', time: new Date(o.now()).toISOString(), stream, nowPlaying: null, next: [], reachable: nowText.ok, mode: mode(), shadow: o.shadow, killSwitch: kill(), capabilities: caps(), ...clocks() };
    if (nowText.ok) {
      const n = parseNow(nowText.text);
      out.nowPlaying = { artist: n.artist, title: n.title, elapsedSeconds: n.elapsed, remainingSeconds: n.remaining, durationSeconds: n.duration };
      out.next = parsePlaylist(nowText.text).slice(0, Math.max(0, Math.min(20, next)));
    } else out.error = `cannot reach RadioDJ: ${nowText.error}`;
    const loaded = fileInfo(o.loadedPlaylistFile);
    out.playlist = { loaded: (loaded && (loaded.name || loaded.raw)) || state.loadedPlaylist || null, source: loaded ? 'file' : state.loadedPlaylist ? 'agent' : 'unknown' };
    out.lastWatchdogRestart = fileInfo(o.watchdogFile);
    out.needsLiveVerification = NEEDS_LIVE_VERIFICATION;
    return out;
  }

  // ---------- playing a clip ----------
  async function readBody(req, limit) {
    const chunks = []; let size = 0;
    for await (const chunk of req) {
      size += chunk.length;
      if (size > limit) { const err = new Error('body is too large'); err.status = 413; throw err; }
      chunks.push(chunk);
    }
    return Buffer.concat(chunks);
  }
  const fail = (status, message, extra = {}) => Object.assign(new Error(message), { status, extra });

  function saveClip(body, contentType, title) {
    const sha256 = crypto.createHash('sha256').update(body).digest('hex');
    const id = crypto.createHash('sha1').update(body).digest('hex').slice(0, 12);
    const ext = EXT_BY_TYPE[String(contentType || '').split(';')[0].trim().toLowerCase()] || 'mp3';
    fs.mkdirSync(o.linksDir, { recursive: true });
    const target = path.join(o.linksDir, `${sha256.slice(0, 16)}.${ext}`);       // the hash is the name: same audio = same file, different audio never collides
    if (!fs.existsSync(target) || fs.statSync(target).size !== body.length) { fs.writeFileSync(`${target}.tmp`, body); fs.renameSync(`${target}.tmp`, target); }
    return { id, sha256, path: target, title, bytes: body.length, at: o.now() };
  }
  // Legacy fixed-cart playing: a copy goes to the one file the cart plays. Windows may still hold the old copy open, so it is retried and, if it
  // stays busy, reported instead of failing the whole request.
  async function copyToFixed(clip) {
    const target = path.join(o.linksDir, o.clipFile);
    for (let i = 0; i < 4; i += 1) {
      try { fs.copyFileSync(clip.path, `${target}.tmp`); fs.renameSync(`${target}.tmp`, target); return; } catch (err) {
        if (i === 3) throw fail(409, `the fixed clip file ${o.clipFile} is busy (${err.code || err.message}); the unique copy ${path.basename(clip.path)} was kept`);
        await o.sleep(150);
      }
    }
  }
  async function fire(clip) {
    if (o.playExec) await run(o.playExec, [clip.path, clip.title || '']);
    else if (o.clipCart) { await copyToFixed(clip); await radiodj.command('PlayCartByNumber', o.clipCart); }
    else throw fail(501, 'set CLIP_CART (the cart that plays CLIP_FILE) or PLAY_EXEC to play clips');
    state.staged.delete(clip.id);
  }
  // After firing: did RadioDJ really start it? Matches the track name or file name, or a change of track near its start. `null` = could not tell.
  async function confirmPlaying(clip, before) {
    if (!o.confirmSeconds) return null;
    const deadline = o.now() + o.confirmSeconds * 1000;
    const key = (n) => `${n.artist}|${n.title}`;
    const wanted = [clip.title, path.basename(clip.path), path.basename(clip.path, path.extname(clip.path)), o.clipFile].filter(Boolean).map((s) => s.toLowerCase());
    let seen = false;
    do {
      try {
        const n = await radiodj.now(); seen = true;
        const hay = `${n.artist} ${n.title}`.toLowerCase();
        if (wanted.some((w) => hay.includes(w)) || (key(n) !== key(before) && (n.elapsed === null || n.elapsed < 20))) return true;
      } catch (err) { /* keep trying until the deadline */ }
      await o.sleep(o.confirmPollMs);
    } while (o.now() < deadline);
    return seen ? false : null;
  }

  async function doIngest(req, url) {
    const q = url.searchParams;
    const generated = ['1', 'true'].includes(q.get('generated'));
    const play = ['1', 'true'].includes(q.get('play'));
    const haveWay = !!(o.clipCart || o.playExec || o.insertCommand || o.insertExec);
    if (!haveWay) throw fail(501, 'set CLIP_CART (the cart that plays CLIP_FILE), PLAY_EXEC or an insert setting to play clips');
    const body = await readBody(req, o.maxClipBytes);
    if (!body.length) throw fail(400, 'send the audio as the request body');
    const title = q.get('title') || '';
    const clip = saveClip(body, req.headers['content-type'], title);
    if (q.get('sha256') && q.get('sha256').toLowerCase() !== clip.sha256) throw fail(400, 'the audio does not match the sha256 you sent (it was damaged on the way)');
    if (o.clipCart && !o.playExec) state.staged.clear();                                   // the fixed cart file is replaced by a newer clip: older ones are stale
    state.staged.set(clip.id, clip);
    const shown = { id: clip.id, sha256: clip.sha256, title, file: path.basename(clip.path) };
    if (!play) return { status: 201, body: { clip: shown, played: false, fired: false } };
    if (generated && o.shadow) return { status: 202, body: { clip: shown, played: false, fired: false, shadow: true, executed: false } };
    const before = await radiodj.now().catch(() => ({ artist: '', title: '' }));
    await fire(clip);
    const confirm = q.get('confirm') !== null ? ['1', 'true'].includes(q.get('confirm')) : generated;       // generated clips are confirmed by default
    const confirmed = confirm ? await confirmPlaying(clip, before) : true;
    return { status: 200, body: { clip: shown, fired: true, played: confirmed, ...(confirm && confirmed === null ? { note: 'fired, but RadioDJ could not be read to confirm it' } : {}), unverified: confirm ? ['playConfirm'] : [] } };
  }

  async function doInsert(req) {
    const b = JSON.parse((await readBody(req, 4000)).toString() || '{}');
    const clip = [...state.staged.values()].find((c) => c.id === b.clip || c.sha256 === b.clip || (b.sha256 && c.sha256 === b.sha256));
    const known = (b.sha256 && state.inserted[b.sha256]) || (clip && state.inserted[clip.sha256]) || (typeof b.clip === 'string' && state.inserted[b.clip]);
    if (known) return { status: 200, body: { inserted: true, duplicate: true, position: known.position, clip: { sha256: known.sha256 } } };                // idempotent by clip hash
    if (!clip) throw fail(404, 'that clip is not on this agent: ingest it first (POST /ingest) and use the id it returns');
    const ahead = b.ahead === undefined ? 2 : Number(b.ahead);
    if (!Number.isInteger(ahead) || ahead < 2) throw fail(400, 'ahead must be a whole number of at least 2: the immediately-next item may already be loaded by RadioDJ');
    if (!o.insertCommand && !o.insertExec) throw fail(501, 'insert is not configured (set INSERT_EXEC, or RADIODJ_CMD_INSERT to the REST plugin command that does it)');
    const upcoming = await radiodj.upcoming();
    if (upcoming.length < ahead - 1) throw fail(409, `not enough items are queued ahead (${upcoming.length} visible, ${ahead - 1} needed): the clip was not inserted and the planned content plays`, { reason: 'queue-too-short', visible: upcoming.length });
    if (o.shadow) return { status: 202, body: { shadow: true, executed: false, position: ahead, clip: { id: clip.id, sha256: clip.sha256 } } };
    const values = { path: clip.path, position: ahead, replace: b.replace || '', title: clip.title || '', sha256: clip.sha256 };
    let reply;
    if (o.insertExec) reply = await run(o.insertExec, [clip.path, String(ahead), String(b.replace || '')]);
    else reply = (await radiodj.command(o.insertCommand, fill(o.insertArg, values))).slice(0, 200);
    const after = await radiodj.upcoming();
    const names = [clip.title, path.basename(clip.path)].filter(Boolean).map((s) => s.toLowerCase());
    const where = after.findIndex((x) => names.some((n) => `${x.title} ${x.path || ''}`.toLowerCase().includes(n)));
    const verified = after.length ? where >= 0 : null;                                      // null: the queue could not be read back
    state.inserted[clip.sha256] = { sha256: clip.sha256, position: ahead, at: o.now(), verified };
    saveState();
    return { status: 200, body: { inserted: true, position: ahead, verified, ...(where >= 0 ? { seenAt: where + 1 } : {}), reply, unverified: ['queueInsert'] } };
  }

  async function doLoadPlaylist(req) {
    const b = JSON.parse((await readBody(req, 2000)).toString() || '{}');
    const name = typeof b.name === 'string' ? b.name.trim() : '';
    if (!new RegExp(o.playlistPattern).test(name)) throw fail(400, `only playlists named like "GLR YYYY-MM-DD" can be loaded (got "${name.slice(0, 60)}")`);
    if (!o.loadCommand && !o.loadExec) throw fail(501, 'playlist loading is not configured (set LOAD_EXEC to the script that loads it; bulk loads through the REST plugin have thrown "Index out of range")');
    if (o.shadow) return { status: 202, body: { shadow: true, executed: false, name } };
    const reply = o.loadExec ? await run(o.loadExec, [name], 120000) : (await radiodj.command(o.loadCommand, fill(o.loadArg, { name }))).slice(0, 200);
    state.loadedPlaylist = name; saveState();
    return { status: 200, body: { loaded: name, reply, unverified: ['playlistLoad'] } };
  }

  // ---------- routing ----------
  // action: the allowlist name for control routes. scope: 'read' or 'control'. always: runs even under the kill switch / live-show.
  const routes = [];
  const add = (method, pattern, scope, handler, opts = {}) => routes.push({ method, re: new RegExp(`^${pattern}$`), scope, handler, ...opts });

  add('GET', '/agent/info', 'read', async () => ({ kind: 'radiodj', name: o.name, capabilities: caps(), ...clocks(), mode: mode(), shadow: o.shadow, killSwitch: kill(), needsLiveVerification: NEEDS_LIVE_VERIFICATION }));
  add('GET', '/agent/status', 'read', async ({ url }) => status(Number.parseInt(url.searchParams.get('next') || String(o.upNext), 10) || o.upNext));
  add('GET', '/schedule', 'read', async ({ url }) => schedule.forDate(url.searchParams.get('date') || ''));
  add('GET', '/agent/audit', 'read', async ({ url }) => ({ entries: audit.tail(Number.parseInt(url.searchParams.get('limit') || '100', 10) || 100) }));
  add('GET', '/music/now', 'read', async () => {
    let text;
    try { text = await radiodj.get('/npjson'); } catch (err) { try { text = await radiodj.get('/np'); } catch (e2) { throw fail(502, `cannot reach RadioDJ: ${e2.message}`); } }
    const now = parseNow(text);
    return { title: now.artist ? `${now.artist} - ${now.title}` : now.title || null, artist: now.artist, track: now.title, remainingSeconds: now.remaining, elapsedSeconds: now.elapsed, durationSeconds: now.duration, listeners: null, live: mode() === 'live-show' };
  });
  add('GET', '/music/playlists', 'read', async () => []);
  add('GET', '/music/library', 'read', async () => ({ tracks: listTracks() }));
  add('PUT', '/music/playlists/.+', 'control', async () => { throw fail(501, 'RadioDJ playlists live in its database; this agent cannot define them'); }, { action: 'load-playlist' });

  add('POST', '/music/skip', 'control', async () => {
    if (!o.cmdSkip) throw fail(501, 'skip is not configured (set RADIODJ_CMD_SKIP to the REST plugin command that skips)');
    if (!o.skipVerified) throw fail(501, 'skip is configured but not marked verified: test it against the real RadioDJ, then set RADIODJ_SKIP_VERIFIED=true');
    return { reply: (await radiodj.command(o.cmdSkip)).slice(0, 200) };
  }, { action: 'skip' });
  add('POST', '/music/volume', 'control', async ({ req }) => {
    if (!o.cmdVolume) throw fail(501, 'volume is not configured (set RADIODJ_CMD_VOLUME to the REST plugin command that sets it)');
    const body = JSON.parse((await readBody(req, 2000)).toString() || '{}');
    const volume = Number(body.volume);
    if (!Number.isFinite(volume)) throw fail(400, 'volume must be a number');
    const clamped = Math.min(1, Math.max(0, volume));
    return { volume: clamped, reply: (await radiodj.command(o.cmdVolume, Math.round(clamped * o.volumeScale))).slice(0, 200) };
  }, { action: 'volume' });
  add('POST', '/ingest', 'control', async ({ req, url }) => doIngest(req, url), { action: 'ingest', detail: ({ url }) => ({ title: url.searchParams.get('title') || '', play: url.searchParams.get('play') || '0', generated: url.searchParams.get('generated') || '0' }) });
  add('POST', '/clips/(?<id>[A-Za-z0-9]+)/play', 'control', async ({ params, url }) => {
    const clip = state.staged.get(params.id);
    if (!clip) throw fail(404, 'that clip is not the one waiting on this agent (a newer clip replaced it)');
    const before = await radiodj.now().catch(() => ({ artist: '', title: '' }));
    await fire(clip);
    const confirmed = url.searchParams.get('confirm') === '1' ? await confirmPlaying(clip, before) : true;
    return { played: confirmed, fired: true };
  }, { action: 'play-clip', detail: ({ params }) => ({ clip: params.id }) });
  add('POST', '/queue/insert', 'control', async ({ req }) => doInsert(req), { action: 'insert' });
  add('POST', '/playlist/load', 'control', async ({ req }) => doLoadPlaylist(req), { action: 'load-playlist' });

  // Safety switches. The kill switch can be turned ON from here; turning it OFF and leaving live-show are done on the PC, so that a
  // stolen or buggy control key can never lift them.
  add('POST', '/agent/kill', 'control', async ({ req }) => {
    const b = JSON.parse((await readBody(req, 1000)).toString() || '{}');
    if (b.on !== true) throw fail(403, `the kill switch is switched off on the PC: delete ${killFile || 'the kill flag'}`);
    const reason = String(b.reason || 'switched on through the API').slice(0, 200);
    state.killMemory = { reason, at: new Date(o.now()).toISOString() };
    if (killFile) { fs.mkdirSync(path.dirname(killFile), { recursive: true }); fs.writeFileSync(killFile, reason); }
    return { killSwitch: kill() };
  }, { always: true, action: 'kill' });
  add('POST', '/agent/mode', 'control', async ({ req }) => {
    const b = JSON.parse((await readBody(req, 1000)).toString() || '{}');
    if (b.mode !== 'live-show') throw fail(403, `leave live-show on the PC (write "automation" into ${modeFile || 'the mode file'})`);
    state.modeMemory = 'live-show';
    if (modeFile) { fs.mkdirSync(path.dirname(modeFile), { recursive: true }); fs.writeFileSync(modeFile, 'live-show'); }
    return { mode: mode() };
  }, { always: true, action: 'mode' });

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

  let chain = Promise.resolve();                                                     // control calls run one at a time
  const serialize = (fn) => { const next = chain.then(fn, fn); chain = next.catch(() => {}); return next; };

  const server = http.createServer(async (req, res) => {
    const url = new URL(req.url, 'http://agent');
    const ip = req.socket.remoteAddress || '';
    const send = (status, body, headers = {}) => { const text = JSON.stringify(body); res.writeHead(status, { 'content-type': 'application/json', 'content-length': Buffer.byteLength(text), ...headers }); res.end(text); };
    const given = req.headers['x-api-key'] || String(req.headers.authorization || '').replace(/^Bearer\s+/i, '');
    const who = identify(given);
    if (!who) {
      const limited = !authFail.allow(`auth:${ip}`).ok;
      if (limited || o.now() - state.lastAuthLog > 60000) { state.lastAuthLog = o.now(); audit.record({ hub: '?', action: 'auth', detail: { ip, path: url.pathname }, result: 'refused', status: limited ? 429 : 401 }); }
      return limited ? send(429, { error: 'too many failed attempts, wait a minute' }, { 'retry-after': '60' }) : send(401, { error: 'unauthorized' });
    }
    const route = routes.find((r) => r.method === req.method && r.re.test(url.pathname));
    if (!route) return send(404, { error: 'not found' });
    const ctx = { req, url, params: route.re.exec(url.pathname).groups || {}, who };
    const detail = () => (route.detail ? route.detail(ctx) : {});
    const refuse = (status, error, extra = {}) => { audit.record({ hub: who.hub, action: route.action || url.pathname, detail: detail(), result: 'refused', status, reason: error }); return send(status, { error, ...extra }); };

    if (route.scope === 'control' && !who.scopes.has('control')) return refuse(403, 'this key can only read; a control key is needed for that');
    const limit = (route.scope === 'control' ? controlLimit : readLimit).allow(`${route.scope}:${who.hub}`);
    if (!limit.ok) return send(429, { error: 'rate limit reached, slow down' }, { 'retry-after': String(limit.retryAfterSeconds) });

    try {
      if (route.scope === 'control') {
        if (!route.always) {
          const k = kill();
          if (k.on) return refuse(423, `the kill switch is on${k.reason ? ` (${k.reason})` : ''}: all control calls are refused`, { killSwitch: true });
          if (mode() === 'live-show') return refuse(409, 'a live show is on air: control calls are refused until it ends', { mode: 'live-show' });
          if (route.action && !allow.has(route.action)) return refuse(403, `the action "${route.action}" is not on this agent's allowlist`);
        }
        const out = await serialize(() => route.handler(ctx));
        const status = out && out.status && out.body ? out.status : 200;
        const body = out && out.status && out.body ? out.body : out;
        audit.record({ hub: who.hub, action: route.action || url.pathname, detail: detail(), result: body && body.shadow ? 'shadow' : 'ok', status });
        return send(status, body);
      }
      return send(200, await route.handler(ctx));
    } catch (err) {
      const status = err.status || (err instanceof SyntaxError ? 400 : 502);
      if (route.scope === 'control') audit.record({ hub: who.hub, action: route.action || url.pathname, detail: detail(), result: 'error', status, reason: err.message });
      if (res.headersSent) return res.end();
      return send(status, { error: status === 502 ? `RadioDJ call failed: ${err.message}` : err.message, ...(err.extra || {}) });
    }
  });

  return { server, parseNow, caps, audit, status, schedule, kill, mode, clocks, state };
}

function keysFromEnv(env) {
  const keys = [];
  // AGENT_KEYS="hubA:read:xxxx,hubA:control:yyyy": one read and one control key per hub, so each hub can be cut off on its own
  for (const entry of String(env.AGENT_KEYS || '').split(',')) {
    const [id, scope, ...rest] = entry.trim().split(':');
    if (id && ['read', 'control'].includes(scope) && rest.length) keys.push({ id, scopes: scope === 'control' ? ['read', 'control'] : ['read'], key: rest.join(':') });
  }
  return keys;
}

function fromEnv(env = process.env) {
  const flag = (v, d) => (v === undefined || v === '' ? d : ['1', 'true', 'yes', 'on'].includes(String(v).toLowerCase()));
  const out = {
    key: env.AGENT_KEY || '', readKey: env.AGENT_READ_KEY || '', controlKey: env.AGENT_CONTROL_KEY || '', keys: keysFromEnv(env),
    name: env.STATION_NAME || 'RadioDJ', radiodjUrl: env.RADIODJ_URL || 'http://127.0.0.1:8080', radiodjPass: env.RADIODJ_PASS || '',
    clipFile: env.CLIP_FILE || '', clipCart: env.CLIP_CART || '',
    cmdSkip: env.RADIODJ_CMD_SKIP || '', skipVerified: flag(env.RADIODJ_SKIP_VERIFIED, false), cmdVolume: env.RADIODJ_CMD_VOLUME || '', volumeScale: parseFloat(env.VOLUME_SCALE || '100'),
    musicDir: env.MUSIC_DIR || '', maxClipBytes: parseFloat(env.MAX_CLIP_MB || '25') * 1e6,
    broadcastTz: env.BROADCAST_TZ || '', machineTz: env.MACHINE_TZ || '', killFile: env.KILL_FILE || '', modeFile: env.MODE_FILE || '', auditFile: env.AUDIT_LOG || '', scheduleDir: env.SCHEDULE_DIR || '',
    icecastUrl: env.ICECAST_URL || '', icecastMount: env.ICECAST_MOUNT || '/stream', watchdogFile: env.WATCHDOG_FILE || '', loadedPlaylistFile: env.LOADED_PLAYLIST_FILE || '',
    shadow: flag(env.AGENT_SHADOW, true), rateControlPerMin: parseInt(env.RATE_CONTROL_PER_MIN || '30', 10), rateReadPerMin: parseInt(env.RATE_READ_PER_MIN || '240', 10),
    insertCommand: env.RADIODJ_CMD_INSERT || '', insertArg: env.RADIODJ_INSERT_ARG || '{path}', insertExec: env.INSERT_EXEC || '', loadCommand: env.RADIODJ_CMD_LOAD_PLAYLIST || '', loadArg: env.RADIODJ_LOAD_ARG || '{name}', loadExec: env.LOAD_EXEC || '', playExec: env.PLAY_EXEC || '',
    confirmSeconds: parseFloat(env.CONFIRM_SECONDS || '6'),
  };
  if (env.LINKS_DIR) out.linksDir = env.LINKS_DIR;
  if (env.AGENT_DATA_DIR) out.dataDir = env.AGENT_DATA_DIR;
  if (env.AGENT_ALLOW) out.allow = env.AGENT_ALLOW.split(',').map((s) => s.trim()).filter((s) => ACTIONS.includes(s));
  return out;
}

// Where to listen: loopback unless the operator names another address.
function listenConfig(env = process.env) {
  return { host: env.AGENT_HOST || '127.0.0.1', port: parseInt(env.AGENT_PORT || '3100', 10) };
}

if (require.main === module) {
  const config = fromEnv();
  const agent = createAgent(config);
  const { host, port } = listenConfig();
  agent.server.listen(port, host, () => {
    console.error(`RadioDJ agent listening on ${host}:${port}`);
    if (!isLoopback(host)) console.error('WARNING: AGENT_HOST exposes this agent beyond this PC over plain HTTP. Prefer the pull model (HUB_URL) or a tunnel such as Tailscale/Cloudflare.');
    if (config.shadow) console.error('Shadow mode is ON: generated clips, inserts and playlist loads are accepted and logged but not executed. Set AGENT_SHADOW=false to go live.');
  });
  if (process.env.HUB_URL) {
    const { createPuller } = require('./puller');
    const control = config.controlKey || config.key || (config.keys.find((k) => k.scopes.includes('control')) || {}).key || '';
    createPuller({
      hubUrl: process.env.HUB_URL, stationId: process.env.HUB_STATION_ID || '', key: process.env.HUB_STATION_KEY || '', localUrl: `http://127.0.0.1:${port}`, localKey: control,
      intervalMs: parseInt(process.env.HUB_POLL_SECONDS || '15', 10) * 1000,
    }).start();
  }
}

module.exports = { createAgent, fromEnv, listenConfig, splitCommand, ACTIONS };
