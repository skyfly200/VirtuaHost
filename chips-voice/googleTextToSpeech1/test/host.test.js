const test = require('node:test');
const assert = require('node:assert');
const { createHost, parseNowPlaying, TEMPLATES } = require('../lib/host');
const { createStore } = require('../lib/store');

function setup(opts = {}) {
  let t = new Date(2026, 9, 15, 14, 0, 0).getTime();               // 2pm: afternoon (no time-of-day line)
  const clock = { now: () => t, advance: (s) => { t += s * 1000; }, setHour: (h) => { t = new Date(2026, 9, 15, h, 0, 0).getTime(); } };
  let playing = { artist: '', title: '' };
  const made = []; const played = []; const specs = [];
  const clips = {
    getOrCreate: async (spec) => { specs.push(spec); if (opts.failSynth) throw new Error('quota'); const clip = { id: `c${made.length}`, text: spec.text }; made.push(clip); return { clip, reused: false }; },
    get: (id) => made.find((c) => c.id === id),
  };
  let playResult = { played: true };
  const play = async (clip, o) => { played.push([clip.text, o.preempt]); return playResult; };
  const rngValues = opts.rng || [0, 0.9];                            // first template, no time line
  let r = 0;
  const host = createHost({
    store: createStore(null, {}), clips, play, llm: opts.llm, isLive: async () => !!opts.live?.(), now: clock.now,
    rng: () => rngValues[r++ % rngValues.length], nowPlaying: async () => playing, stationName: 'KRAP', ...opts.extra,
  });
  return { host, clock, made, played, specs, setPlaying: (a, ti) => { playing = { artist: a, title: ti }; }, setResult: (v) => { playResult = v; } };
}

test('now-playing text is parsed from "Artist - Title" or separate fields', () => {
  assert.deepStrictEqual(parseNowPlaying({ title: 'Boards of Canada - Roygbiv' }), { artist: 'Boards of Canada', title: 'Roygbiv' });
  assert.deepStrictEqual(parseNowPlaying({ title: 'A - B - C' }), { artist: 'A', title: 'B - C' });
  assert.deepStrictEqual(parseNowPlaying({ artist: 'Aphex Twin', title: 'Xtal' }), { artist: 'Aphex Twin', title: 'Xtal' });
  assert.deepStrictEqual(parseNowPlaying({ title: 'No separator' }), { artist: '', title: 'No separator' });
  assert.deepStrictEqual(parseNowPlaying(null), { artist: '', title: '' });
});

test('the link about a track is prepared while it plays and played when the next track begins', async () => {
  const s = setup();
  s.setPlaying('Artist One', 'Song One'); await s.host.tick();
  assert.deepStrictEqual([s.made.length, s.played.length], [1, 0]);                      // prepared, not yet played
  assert.strictEqual(s.made[0].text, "That was Artist One with Song One. You're listening to K.R.A.P., ninety-seven point seven.");   // the script's first template
  assert.strictEqual(s.host.status().ready.about, 'Artist One - Song One');
  await s.host.tick();                                                                   // same track: nothing happens
  assert.deepStrictEqual([s.made.length, s.played.length], [1, 0]);
  s.clock.advance(200); s.setPlaying('Artist Two', 'Song Two'); await s.host.tick();
  assert.deepStrictEqual(s.played, [[s.made[0].text, false]]);                           // link about song one plays now
  assert.strictEqual(s.made.length, 2);                                                  // and song two's link is being prepared
  assert.strictEqual(s.host.status().counters.played, 1);
  assert.strictEqual(s.host.status().last.about, 'Artist One - Song One');
});

test('links use the script voice settings: Rocky-style voice, underground finish, chosen provider', async () => {
  const s = setup();
  s.host.update({ voice: 'Rocky', provider: 'elevenlabs', fx: 'underground' });
  s.setPlaying('A', 'T'); await s.host.tick();
  assert.deepStrictEqual(s.specs[0], { text: s.made[0].text, voice: 'Rocky', provider: 'elevenlabs', fx: 'underground', format: 'MP3' });
  s.host.update({ fx: '' }); s.host.stop();
  assert.strictEqual(s.host.settings().fx, '');
});

test('never talks over a spot or relay, and never during a live DJ', async () => {
  const live = { on: false };
  const s = setup({ live: () => live.on });
  s.setPlaying('Real Artist', 'Real Song'); await s.host.tick();
  s.clock.advance(100); s.setPlaying('Syndicate Empire Radio', 'Station ID'); await s.host.tick();      // a spot: case-insensitive match on the skip list
  assert.strictEqual(s.played.length, 0);
  assert.strictEqual(s.host.status().ready, null);                                                      // nothing prepared for the spot either
  s.clock.advance(100); s.setPlaying('K.R.A.P. Relay', 'Relay'); await s.host.tick();
  s.setPlaying('', ''); await s.host.tick();                                                            // no metadata: treated as not a track
  assert.strictEqual(s.made.length, 1);
  s.clock.advance(100); s.setPlaying('Next Artist', 'Next Song'); await s.host.tick();
  assert.strictEqual(s.made.length, 2);                                                                 // normal tracks resume
  live.on = true;
  s.clock.advance(100); s.setPlaying('DJ Artist', 'DJ Song'); await s.host.tick();
  assert.strictEqual(s.played.length, 0);                                                               // live DJ on air: quiet
  assert.strictEqual(s.made.length, 2);                                                                 // and no voice credits spent
  s.host.update({ preempt: true }); s.host.stop();
  live.on = false;
  s.clock.advance(100); s.setPlaying('Back', 'Again'); await s.host.tick();
  assert.strictEqual(s.made.length, 3);
});

test('every Nth track, a minimum gap, and a player that skips (live DJ) are respected', async () => {
  const s = setup();
  s.host.update({ every: 2, minGapSeconds: 120 }); s.host.stop();
  const next = async (a, t, wait = 200) => { s.clock.advance(wait); s.setPlaying(a, t); await s.host.tick(); };
  await next('A', '1'); assert.strictEqual(s.made.length, 0);                                           // 1st track: no link yet
  await next('B', '2'); assert.strictEqual(s.made.length, 1);                                           // 2nd: link prepared
  await next('C', '3'); assert.strictEqual(s.played.length, 1);                                         // played at the 3rd
  s.setResult({ played: false, reason: 'live DJ on air' });
  await next('D', '4'); await next('E', '5', 130);                                                      // prepared at 4, due at 5
  assert.deepStrictEqual([s.host.status().last.played, s.host.status().last.reason, s.host.status().counters.skipped], [false, 'live DJ on air', 1]);
  const gap = setup(); gap.host.update({ minGapSeconds: 600 }); gap.host.stop();
  gap.setPlaying('A', '1'); await gap.host.tick();
  gap.clock.advance(30); gap.setPlaying('B', '2'); await gap.host.tick();                               // first link plays (no earlier link)
  gap.clock.advance(30); gap.setPlaying('C', '3'); await gap.host.tick();                               // too soon after the last one
  assert.strictEqual(gap.played.length, 1);
});

test('time-of-day lines are added about a third of the time, from the script list', async () => {
  const s = setup({ rng: [0.5, 0.1] });                                                                 // template 3, then under 0.3: add the line
  s.clock.setHour(23);
  assert.strictEqual((await s.host.compose('Band', 'Tune')).text, '[chuckles] That was Tune by Band. More coming up, right here on K.R.A.P. Late night, just us and the music.');
  assert.strictEqual(TEMPLATES.length, 4);
});

test('language-model lines, with template fallback and an error note', async () => {
  const calls = [];
  const llm = { enabled: true, generate: async (r) => { calls.push(r); return { text: '  [chuckles] That was Band, folks.  ' }; } };
  const s = setup({ llm });
  s.host.update({ lines: 'llm', persona: 'Rocky is dry and sleepy.' }); s.host.stop();
  assert.deepStrictEqual(await s.host.compose('Band', 'Tune'), { text: '[chuckles] That was Band, folks.', source: 'llm' });
  assert.match(calls[0].system, /KRAP/); assert.match(calls[0].system, /Rocky is dry and sleepy\./);
  assert.match(calls[0].prompt, /"Tune" by Band/);
  const failing = setup({ llm: { enabled: true, generate: async () => { throw new Error('down'); } } });
  failing.host.update({ lines: 'llm' }); failing.host.stop();
  assert.strictEqual((await failing.host.compose('Band', 'Tune')).source, 'template');
  assert.match(failing.host.status().error, /language model failed/);
  const off = setup({ llm: { enabled: false } }); off.host.update({ lines: 'llm' }); off.host.stop();
  assert.strictEqual((await off.host.compose('B', 'T')).source, 'template');
});

test('say: a dry run only writes the line (like --dry-run); otherwise it voices it and plays only if asked', async () => {
  const s = setup();
  assert.deepStrictEqual(await s.host.say({ artist: 'Band', title: 'Tune', dryRun: true }), { text: "That was Band with Tune. You're listening to K.R.A.P., ninety-seven point seven.", source: 'template', dryRun: true });
  assert.strictEqual(s.made.length, 0);
  const made = await s.host.say({ artist: 'Band', title: 'Tune' });
  assert.deepStrictEqual([made.played, s.made.length, s.played.length], [false, 1, 0]);
  const aired = await s.host.say({ artist: 'Band', title: 'Tune', play: true });
  assert.deepStrictEqual([aired.played, s.played.length], [true, 1]);
  await assert.rejects(s.host.say({ artist: 'x' }), /title is required/);
});

test('failures are recorded, never thrown, and the host keeps going', async () => {
  const s = setup({ failSynth: true });
  s.setPlaying('A', '1'); await s.host.tick();
  assert.match(s.host.status().error, /could not prepare a link: quota/);
  assert.strictEqual(s.host.status().counters.failed, 1);
  const broken = createHost({ store: createStore(null, {}), clips: {}, play: async () => ({}), nowPlaying: async () => { throw new Error('icecast down'); } });
  await broken.tick();
  assert.match(broken.status().error, /could not read what is playing: icecast down/);
});

test('settings are validated and kept; enabling starts the watcher and disabling stops it', () => {
  const s = setup();
  const st = s.host.update({ enabled: true, every: 9999, minGapSeconds: -5, lines: 'nonsense', voice: ' Rocky ', templates: ['  ', '{title} again'], skipArtists: ['Spot One'], preempt: 'yes' });
  assert.deepStrictEqual([st.running, st.settings.every, st.settings.minGapSeconds, st.settings.lines, st.settings.voice], [true, 50, 0, 'template', 'Rocky']);
  assert.deepStrictEqual([st.settings.templates, st.settings.skipArtists, st.settings.preempt], [['{title} again'], ['Spot One'], false]);
  assert.strictEqual(s.host.update({ enabled: false }).running, false);
});
