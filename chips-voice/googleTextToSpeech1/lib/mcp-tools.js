// The MCP tools: what a chat assistant (Claude and others) can do with the station. Every tool calls the Chips Voice
// HTTP API through the station client, so the same login and validation rules apply.
//
// Tools that put audio on the PUBLIC STREAM say so in their description. Set readOnly to register only the tools that
// look but do not touch (MCP_READ_ONLY=true).
const { z } = require('zod');

const text = (value) => ({ content: [{ type: 'text', text: typeof value === 'string' ? value : JSON.stringify(value, null, 2) }] });
const failure = (err) => ({ isError: true, content: [{ type: 'text', text: `Error: ${err.message}` }] });

// Wraps a handler so any failure comes back as a tool error instead of crashing the session.
const safe = (fn) => async (args) => {
  try {
    return text(await fn(args || {}));
  } catch (err) {
    return failure(err);
  }
};

const fxSchema = z.object({
  preset: z.string().optional().describe('effect preset name; see list_effects (for example underground, robot, telephone)'),
  pitch: z.number().min(-12).max(12).optional().describe('voice changer, semitones'),
  speed: z.number().min(0.5).max(2).optional(),
  tighten: z.boolean().optional().describe('trim long pauses'),
}).describe('audio effect / voice changer settings');

const speechShape = {
  text: z.string().max(10000).optional().describe('what to say. May contain [sfx:name] sound effect tags and audio tags like [laughs]'),
  script: z.string().max(10000).optional().describe('a conversation, one line per turn: "Rocky: Hello" or "Rocky (dry, sleepy): Hello". Use instead of text'),
  voices: z.record(z.string()).optional().describe('maps names used in script to voices, for example {"R":"Rocky"}'),
  voice: z.string().optional().describe('voice name or id (see list_voices)'),
  provider: z.string().optional().describe('speech provider, one of the enabled ones; default is the first'),
  model: z.string().optional().describe('speech model, for providers that offer several (OpenRouter)'),
  tone: z.string().max(300).optional().describe('delivery direction such as "warm, slow, a little tired" (models that support it)'),
  fx: z.union([z.string(), fxSchema]).optional().describe('effect preset name or settings'),
};

function registerTools(server, client, { readOnly = false } = {}) {
  const ro = { readOnlyHint: true, openWorldHint: false };
  const act = { readOnlyHint: false, destructiveHint: false, openWorldHint: true };
  const air = { readOnlyHint: false, destructiveHint: false, openWorldHint: true };

  // ---------- look ----------
  server.registerTool('station_status', {
    title: 'Station status',
    description: 'What is on the stream right now (track, listeners, live DJ), the virtual host state, and which speech/AI/storage providers are enabled.',
    annotations: ro,
  }, safe(() => client.status()));

  server.registerTool('now_playing', {
    title: 'Now playing', description: 'The current track and listener count, and whether a live DJ is on air.', annotations: ro,
  }, safe(() => client.nowPlaying()));

  server.registerTool('list_voices', {
    title: 'List voices', description: 'Voices for a speech provider (default: the first enabled), including named voice clones.',
    inputSchema: { provider: z.string().optional() }, annotations: ro,
  }, safe(({ provider }) => client.voices(provider)));

  server.registerTool('list_effects', {
    title: 'List audio effects', description: 'Audio effect and voice-changer presets, with the pitch and speed ranges.', annotations: ro,
  }, safe(() => client.fxPresets()));

  server.registerTool('list_sound_effects', {
    title: 'List sound effects',
    description: 'Sound effects that can be tagged in text as [sfx:name] (options: over, vol=0-2, wait=0-5).', annotations: ro,
  }, safe(() => client.sfx()));

  server.registerTool('list_clips', {
    title: 'List clips', description: 'Search the clip library (everything announced so far, reusable without paying for speech again).',
    inputSchema: { query: z.string().optional(), tag: z.string().optional(), favorite: z.boolean().optional() }, annotations: ro,
  }, safe(async ({ query, tag, favorite }) => (await client.clips({ q: query, tag, favorite })).slice(0, 50)
    .map((c) => ({ id: c.id, title: c.title, text: c.text, provider: c.provider, plays: c.playCount, favorite: c.favorite, tags: c.tags, available: c.available }))));

  server.registerTool('list_schedules', {
    title: 'List schedules', description: 'Announcements scheduled to play on their own.', annotations: ro,
  }, safe(() => client.schedules()));

  server.registerTool('host_status', {
    title: 'Virtual host status', description: 'Whether the virtual host is on, what link it has ready, what it last played, and its settings.', annotations: ro,
  }, safe(() => client.host()));

  server.registerTool('list_personas', {
    title: 'List host personas', description: 'Ready-made virtual-host personas (for example "chip", the computer DJ of Way High Radio). Apply one with host_configure preset.', annotations: ro,
  }, safe(() => client.personas()));

  server.registerTool('preview_host_line', {
    title: 'Preview a host link', description: 'Write the link the virtual host would say about a track, without voicing or playing it (no cost).',
    inputSchema: { artist: z.string(), title: z.string() }, annotations: ro,
  }, safe(({ artist, title }) => client.hostSay({ artist, title, dryRun: true })));

  if (readOnly) return;

  // ---------- write: library only (nothing goes on air) ----------
  server.registerTool('draft_announcement', {
    title: 'Draft an announcement',
    description: 'Have the configured AI model write an announcement, or a short conversation between speakers (format "dialogue", which can use tone directions and, with sfx true, sound effects). Returns text only: nothing is voiced or played.',
    inputSchema: {
      prompt: z.string().max(1000).describe('what it is about'),
      tone: z.string().optional(), format: z.enum(['text', 'dialogue']).optional(),
      speakers: z.array(z.string()).max(4).optional().describe('speaker names for a dialogue, for example ["Rocky","Britta"]'),
      sfx: z.boolean().optional().describe('let a dialogue include [sfx:name] lines'),
      model: z.string().optional().describe('an AI model enabled on this server (OpenRouter)'),
    }, annotations: act,
  }, safe((a) => client.draft(a)));

  server.registerTool('make_clip', {
    title: 'Make a clip (not played)',
    description: 'Voice text or a script and save it in the library without playing it. Identical requests reuse the saved clip. Returns the clip id for play_clip, schedule_announcement or share_clip.',
    inputSchema: speechShape, annotations: act,
  }, safe((a) => client.synth(a)));

  server.registerTool('apply_effect', {
    title: 'Apply an effect to a clip', description: 'Make a processed copy of an existing clip (voice changer, KRAP "underground" sound, robot, telephone ...). The original is kept.',
    inputSchema: { id: z.string(), fx: z.union([z.string(), fxSchema]) }, annotations: act,
  }, safe(({ id, fx }) => client.applyFx(id, fx)));

  server.registerTool('update_clip', {
    title: 'Rename or tag a clip', description: 'Change a clip title, tags or favorite flag.',
    inputSchema: { id: z.string(), title: z.string().optional(), tags: z.array(z.string()).optional(), favorite: z.boolean().optional() }, annotations: act,
  }, safe(({ id, ...patch }) => client.updateClip(id, patch)));

  server.registerTool('stream_link', {
    title: 'Create a stream link', description: 'A signed link to a clip that any media player can open, valid for up to 30 days.',
    inputSchema: { id: z.string(), hours: z.number().min(1).max(720).optional() }, annotations: act,
  }, safe(({ id, hours }) => client.clipLink(id, hours)));

  server.registerTool('share_clip', {
    title: 'Upload a clip to the cloud', description: 'Upload to Google Drive or ownCloud (whichever is configured) and return a public link.',
    inputSchema: { id: z.string(), target: z.string().optional().describe('rclone or owncloud') }, annotations: act,
  }, safe(({ id, target }) => client.shareClip(id, target)));

  server.registerTool('host_configure', {
    title: 'Configure the virtual host',
    description: 'Turn the virtual host on or off and change its settings. Turning it on makes it speak between songs on the PUBLIC STREAM.',
    inputSchema: {
      enabled: z.boolean().optional(), every: z.number().int().min(1).max(50).optional().describe('a link after every Nth song'),
      lines: z.enum(['template', 'llm']).optional(), voice: z.string().optional(), provider: z.string().optional(),
      fx: z.string().optional().describe('effect preset, empty for none'), minGapSeconds: z.number().min(0).max(3600).optional(),
      preempt: z.boolean().optional().describe('allow it to interrupt a live DJ'),
      preset: z.string().optional().describe('apply a persona preset such as "chip" (sets its lines, tone and effect; not the voice)'),
      tone: z.string().optional().describe('delivery direction for models that support it'),
    }, annotations: air,
  }, safe((a) => client.hostUpdate(a)));

  // ---------- on the air ----------
  server.registerTool('say_on_air', {
    title: 'Announce on air',
    description: 'Voice text or a conversation script and play it on the PUBLIC STREAM right now, ducking the music. Confirm with the user before using this. If a live DJ is on air it is skipped unless preempt is true.',
    inputSchema: { ...speechShape, preempt: z.boolean().optional().describe('interrupt a live DJ') }, annotations: air,
  }, safe((a) => client.speak(a)));

  server.registerTool('play_clip', {
    title: 'Play a saved clip on air', description: 'Play a clip from the library on the PUBLIC STREAM. Confirm with the user first.',
    inputSchema: { id: z.string(), preempt: z.boolean().optional() }, annotations: air,
  }, safe(({ id, preempt }) => client.playClip(id, preempt)));

  server.registerTool('schedule_announcement', {
    title: 'Schedule an announcement',
    description: 'Schedule a saved clip (clipId) or new text (text/script) to play on the PUBLIC STREAM at a time, once or repeating.',
    inputSchema: {
      clipId: z.string().optional(), ...speechShape,
      startAt: z.string().describe('ISO 8601 date and time with offset, for example 2026-10-20T18:30:00-06:00'),
      intervalMinutes: z.number().min(0.5).optional().describe('repeat every this many minutes (omit for once)'),
      count: z.number().int().min(0).max(10000).optional().describe('stop after this many runs (0 = no limit)'),
      preempt: z.boolean().optional(), name: z.string().optional(),
    }, annotations: air,
  }, safe(({ clipId, startAt, intervalMinutes, count, preempt, name, ...spec }) => client.schedule({
    clipId, name, spec: clipId ? undefined : spec, startAt, intervalSec: intervalMinutes ? Math.round(intervalMinutes * 60) : 0, count, preempt,
  })));

  server.registerTool('cancel_schedule', {
    title: 'Cancel a schedule', description: 'Delete a schedule by id (see list_schedules).', inputSchema: { id: z.string() }, annotations: act,
  }, safe(({ id }) => client.deleteSchedule(id)));

  server.registerTool('skip_track', {
    title: 'Skip the current track', description: 'Skip to the next music track on the PUBLIC STREAM (auto-DJ only).', annotations: air,
  }, safe(() => client.skip()));

  server.registerTool('set_music_volume', {
    title: 'Set music volume', description: 'Music level for the auto-DJ, 0 to 100.',
    inputSchema: { percent: z.number().min(0).max(100) }, annotations: air,
  }, safe(({ percent }) => client.setVolume(percent / 100)));

  server.registerTool('set_playlist', {
    title: 'Switch playlist', description: 'Switch the auto-DJ to a playlist (a folder of the music library); empty string for all music.',
    inputSchema: { name: z.string() }, annotations: air,
  }, safe(({ name }) => client.setPlaylist(name)));

  server.registerTool('station_id', {
    title: 'Station ID in the persona\'s style',
    description: 'Make a station ID from the active host persona (apply one first with host_configure preset). Set play true to put it on the PUBLIC STREAM; otherwise it is only saved to the library.',
    inputSchema: { play: z.boolean().optional() }, annotations: air,
  }, safe(({ play }) => client.stationId(play === true)));

  server.registerTool('host_say', {
    title: 'Voice a host link for a track',
    description: 'Write and voice a virtual-host link about a track. Set play true to put it on the PUBLIC STREAM.',
    inputSchema: { artist: z.string(), title: z.string(), play: z.boolean().optional() }, annotations: air,
  }, safe(({ artist, title, play }) => client.hostSay({ artist, title, play: play === true })));
}

module.exports = { registerTools };
