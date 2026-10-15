var createError = require('http-errors');
var express = require('express');
var path = require('path');
const fs = require('fs');
var cookieParser = require('cookie-parser');
var cors = require('cors')
var logger = require('morgan');
const { spawn, exec } = require('child_process');
const { promisify } = require('util')
const net = require('net');
const http = require('http');
const { createAuth } = require('./auth');
const { createStore } = require('./lib/store');
const { createClips } = require('./lib/clips');
const { createScheduler } = require('./lib/scheduler');
const { createStorage } = require('./lib/storage');
const { createTts } = require('./lib/providers/tts');
const { createLlm } = require('./lib/providers/llm');
const { createApi } = require('./routes/api');

const sleep = promisify(setTimeout);

// Playback backend: "vlc" (local VLC + MIDI ducking) or "liquidsoap"
// (push to a Liquidsoap request queue that feeds Icecast).
const PLAYER = (process.env.PLAYER || 'vlc').toLowerCase();
const LIQUIDSOAP_HOST = process.env.LIQUIDSOAP_HOST || '127.0.0.1';
const LIQUIDSOAP_PORT = parseInt(process.env.LIQUIDSOAP_PORT || '1234', 10);
const CLIPS_DIR = path.resolve(process.env.CLIPS_DIR || path.join(__dirname, 'clips'));
const MUSIC_DIR = path.resolve(process.env.MUSIC_DIR || '/srv/music');
const ICECAST_STATUS_URL = process.env.ICECAST_STATUS_URL || 'http://127.0.0.1:8000/status-json.xsl';
const STREAM_MOUNT = process.env.STREAM_MOUNT || '/stream';
const LIQUIDSOAP_QUEUE = process.env.LIQUIDSOAP_QUEUE || 'announce';
const LIQUIDSOAP_LIVE_QUEUE = process.env.LIQUIDSOAP_LIVE_QUEUE || 'announce_live';
const LIVE_MOUNT = process.env.LIVE_MOUNT || '/live';
// Whether announcements cut in over a live DJ when the request doesn't say.
const PREEMPT_LIVE_DEFAULT = process.env.PREEMPT_LIVE === 'true';

// Authentication: a login (ADMIN_USER + ADMIN_PASSWORD_HASH + SESSION_SECRET) for the web UI,
// and/or a static API_KEY for scripts. See auth.js.
const auth = createAuth({
  user: process.env.ADMIN_USER,
  passwordHash: process.env.ADMIN_PASSWORD_HASH,
  secret: process.env.SESSION_SECRET,
  apiKey: process.env.API_KEY,
  sessionHours: parseFloat(process.env.SESSION_HOURS || '12'),
});
if (!auth.enabled) {
  if (PLAYER === 'liquidsoap') {
    console.error('Set ADMIN_PASSWORD_HASH and SESSION_SECRET (login) and/or API_KEY when PLAYER=liquidsoap; refusing to start without authentication.');
    process.exit(1);
  }
  console.warn('WARNING: no authentication configured; the API is open.');
} else if (process.env.ADMIN_PASSWORD_HASH && !process.env.SESSION_SECRET) {
  console.error('SESSION_SECRET is required for login.');
  process.exit(1);
}

// MIDI is only used by the VLC player (to duck an external mixer). On a server running
// Liquidsoap it is not needed, and easymidi (a native module) may not even be installed.
var output = { send: () => { throw new Error('MIDI is not available with PLAYER=liquidsoap'); } };
if (PLAYER !== 'liquidsoap') {
  var easymidi = require('easymidi');
  var midiOutputName = 'loopMIDI Port 1';
  var devices = easymidi.getOutputs();
  try {
    output = new easymidi.Output(midiOutputName);
  } catch (err) {
    const fallback = devices[devices.length - 1];
    console.log(`Selected default midi (last in list): ${fallback}`)
    output = new easymidi.Output(fallback);
  }
}

// ---- Clip library, providers, scheduler (see lib/ and routes/api.js) ----
const DATA_DIR = path.resolve(process.env.DATA_DIR || path.join(__dirname, 'data'));
const limits = {
  maxText: parseInt(process.env.MAX_TEXT_CHARS || '500', 10),
  maxSsml: parseInt(process.env.MAX_SSML_CHARS || '2000', 10),
  maxPrompt: parseInt(process.env.MAX_PROMPT_CHARS || '1000', 10),
};
const tts = createTts(process.env);
const llm = createLlm(process.env);
const storage = createStorage(process.env);
const store = createStore(path.join(DATA_DIR, 'library.json'), { clips: {}, schedules: {} });
const clips = createClips({
  store, tts, dir: CLIPS_DIR,
  maxBytes: parseFloat(process.env.CLIP_CACHE_MB || '500') * 1e6,
});

// Plays a catalogue clip on the active player; the result says whether it was played or skipped.
async function playClip(clip, options) {
  return (await playFile(clips.fileOf(clip), options)) || { played: true };
}

const scheduler = createScheduler({ store, clips, play: playClip, limits });
scheduler.start();
process.on('SIGTERM', () => { store.flush(); process.exit(0); });
process.on('SIGINT', () => { store.flush(); process.exit(0); });

// Signing key for audio links: its own secret if set, otherwise derived from the login secret.
const STREAM_SECRET = process.env.STREAM_SECRET || process.env.SESSION_SECRET || process.env.API_KEY || '';
const api = createApi({
  clips, tts, llm, storage, scheduler, play: playClip, limits,
  streamSecret: STREAM_SECRET,
  publicUrl: process.env.PUBLIC_URL,
  rateLimit: { max: parseInt(process.env.RATE_LIMIT_PER_MIN || '30', 10) },
});

var indexRouter = require('./routes/index');
var usersRouter = require('./routes/users');

var unity = 50;
var volume = unity;

var app = express()

// view engine setup
app.set('views', path.join(__dirname, 'views'));
app.set('view engine', 'pug');

app.use(cors(process.env.CORS_ORIGIN ? { origin: process.env.CORS_ORIGIN.split(',') } : undefined));

app.use(logger('dev'));
app.use(express.json({ limit: '100kb' }));

// cors() answers preflight requests itself, so only real requests reach the lines below.
app.set('trust proxy', 'loopback'); // behind nginx on the same machine: req.ip is the real client
app.use(api.publicRouter);          // signed audio links work without a login
app.post('/auth/login', auth.login);
app.use(auth.requireAuth);
app.get('/auth/me', (req, res) => res.json({ ok: true }));
app.use(api.router);
app.use(express.urlencoded({ extended: false }));
app.use(cookieParser());
app.use(express.static(path.join(__dirname, 'public')));

app.use('/', indexRouter);
app.use('/users', usersRouter);


app.post("/hook", (req, res) => {
  console.log(req.body) // Call your action on the request here
  res.status(200).end() // Responding is important
})

app.get("/midi", (req, res) => {
  output.send('cc', {
    controller: 0,
    value: 1,
    channel: 3,
  });
  res.status(200).end() // Responding is important
})

app.get("/learnmute", (req, res) => {
  learnMute();
  res.status(200).end() // Responding is important
})

app.get("/learnfade", (req, res) => {
  learnFade();
  res.status(200).end() // Responding is important
})

// ---- Music controls (Liquidsoap backend) ----

// Playlists are the sub-directories of MUSIC_DIR (the root counts as "/").
app.get("/music/playlists", async (req, res) => {
  try {
    const entries = await promisify(fs.readdir)(MUSIC_DIR, { withFileTypes: true });
    res.json(entries.filter((e) => e.isDirectory() && !e.name.startsWith('.')).map((e) => e.name));
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
})

// Now playing, read from Icecast so it reflects what listeners actually hear.
app.get("/music/now", async (req, res) => {
  try {
    const src = (await icecastSources()).find((x) => (x.listenurl || '').endsWith(STREAM_MOUNT)) || {};
    res.json({ title: src.title || null, listeners: src.listeners || 0, live: await liveActive() });
  } catch (err) {
    res.status(502).json({ error: err.message });
  }
})

app.post("/music/skip", async (req, res) => {
  try {
    res.json({ reply: await liquidsoapCommand('music.skip') });
  } catch (err) {
    res.status(502).json({ error: err.message });
  }
})

// { "volume": 0..1 } scales the music (announcement ducking is applied on top).
app.post("/music/volume", async (req, res) => {
  const volume = Number(req.body.volume);
  if (!Number.isFinite(volume)) return res.status(400).json({ error: 'volume must be a number' });
  const clamped = Math.min(1, Math.max(0, volume));
  try {
    res.json({ volume: clamped, reply: await liquidsoapCommand(`var.set music_volume = ${clamped}`) });
  } catch (err) {
    res.status(502).json({ error: err.message });
  }
})

// { "name": "<sub-directory of MUSIC_DIR>" } switches playlist; "" or "/" is the whole library.
app.post("/music/playlist", async (req, res) => {
  const name = String(req.body.name || '').replace(/^\/+$/, '');
  if (!/^[A-Za-z0-9 _.-]*$/.test(name) || name.startsWith('.')) {
    return res.status(400).json({ error: 'invalid playlist name' });
  }
  const dir = path.join(MUSIC_DIR, name);
  try {
    await liquidsoapCommand(`music.uri ${dir}`);
    res.json({ playlist: name || '/', reply: await liquidsoapCommand('music.reload') });
  } catch (err) {
    res.status(502).json({ error: err.message });
  }
})

// catch 404 and forward to error handler
app.use(function(req, res, next) {
  next(createError(404));
});


// error handler
app.use(function(err, req, res, next) {
  // set locals, only providing error in development
  res.locals.message = err.message;
  res.locals.error = req.app.get('env') === 'development' ? err : {};

  // render the error page
  res.status(err.status || 500);
  res.render('error');
});

// Active Icecast sources, from its status-json.xsl.
function icecastSources() {
  return new Promise((resolve, reject) => {
    http.get(ICECAST_STATUS_URL, (r) => {
      let body = '';
      r.on('data', (d) => { body += d; });
      r.on('end', () => {
        try {
          const sources = JSON.parse(body).icestats.source || [];
          resolve(Array.isArray(sources) ? sources : [sources]);
        } catch (err) {
          reject(new Error('bad icecast status'));
        }
      });
    }).on('error', reject);
  });
}

// Is a live DJ connected to the live mount right now?
async function liveActive() {
  try {
    return (await icecastSources()).some((x) => (x.listenurl || '').endsWith(LIVE_MOUNT));
  } catch (err) {
    return false;
  }
}

// Send one command to Liquidsoap's telnet server and resolve with its reply.
function liquidsoapCommand(command) {
  return new Promise((resolve, reject) => {
    const socket = net.connect(LIQUIDSOAP_PORT, LIQUIDSOAP_HOST);
    let reply = '';
    socket.setTimeout(5000, () => socket.destroy(new Error('liquidsoap timeout')));
    socket.on('connect', () => socket.write(`${command}\nexit\n`));
    socket.on('data', (data) => { reply += data; });
    socket.on('error', reject);
    socket.on('close', () => resolve(reply.replace(/\r?\nBye!\r?\n?$/, '').trim()));
  });
}

// Returns a result object for the liquidsoap player ({ played, reason? }); VLC returns nothing.
async function playFile(file, options = {}) {
  if (PLAYER === 'liquidsoap') {
    // Liquidsoap ducks the music itself, so no MIDI fades here.
    const absolute = path.resolve(file);
    const preempt = options.preempt === undefined ? PREEMPT_LIVE_DEFAULT : options.preempt === true;
    let queue = LIQUIDSOAP_QUEUE;
    if (await liveActive()) {
      // A queued clip would sit unheard until the DJ leaves, so skip it unless it may cut in.
      if (!preempt) return { played: false, reason: 'live DJ on air' };
      queue = LIQUIDSOAP_LIVE_QUEUE;
    }
    const reply = await liquidsoapCommand(`${queue}.push ${absolute}`);
    console.log(`liquidsoap: ${reply}`);
    return { played: true, queue };
  }
  //console.log(req.body) // Call your action on the request here
  var duration = 2000; // time between fades in milliseconds
  fadeOut();
  const vlc = exec(`vlc --one-instance ${file}`);
  vlc.stdout.on('data', (data) => {
    console.log(`stdout: ${data}`);
  });
  vlc.stderr.on('data', (data) => {
    console.error(`stderr: ${data}`);
  });
  vlc.on('close', (code) => {
    console.log(`child process exited with code ${code}`);
    setTimeout(fadeIn, duration);
  });
}

async function fadeTo(level) {
  var diff = level - volume;
  var fadeDelay = 10;
  for (var i=0; i<10; i++) {
    await sleep(fadeDelay);
    if (diff > 0) volume++
    else volume--
    console.log(volume);
    output.send('cc', {
      controller: 0,
      value: volume,
      channel: 3
    });
  }
}

function fadeOut() {
  fadeTo(0);
}

function fadeIn() {
  fadeTo(unity);
}

function mute() {
  output.send('cc', {
    controller: 0,
    value: 1,
    channel: 4
  });
}

function learnMute() {
  output.send('cc', {
    controller: 0,
    value: 1,
    channel: 4
  });
}

function learnFade() {
  output.send('cc', {
    controller: 0,
    value: unity-1,
    channel: 3
  })
  output.send('cc', {
    controller: 0,
    value: unity,
    channel: 3
  });
}

module.exports = app;
