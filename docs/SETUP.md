# Setup guide: pick your use case

Three ways to use this system. They share one server (`chips-voice/`), so you can start with one and add the others.

| I want to... | Use case | Needs |
|--------------|----------|-------|
| Keep running Sylvia's KRAP scripts, but with server voices/effects | [A. Script](#a-script-krap-station-and-curl) | Chips Voice server reachable by URL + API key |
| Have an app (VirtuaHost on Netlify, a webhook, another service) generate clips | [B. API](#b-api-virtuahost-and-other-callers) | Server URL, `INGEST_TOKEN` or API key |
| Run music, the AI host and announcements on the stream server with no desktop | [C. Stream server AutoDJ](#c-stream-server-autodj-icecast--liquidsoap) | VPS with Icecast, Liquidsoap, ffmpeg, Node 22 |
| Control any of the above from chat or an AI assistant | [D. Chat and MCP](#d-chat-and-mcp) | Use case B or C running |
| Run several stations (Liquidsoap and/or RadioDJ) from one screen, or tune voices in a browser | [E. Hub and web apps](HUB.md) | The hub, plus an agent per station |

Common to all: Node 22, `cd chips-voice/googleTextToSpeech1 && npm install`, copy `.env.example` to `.env`. ffmpeg is needed for
effects, sound effects, dialogue joining and MP3 conversion (`FFMPEG_BIN` to override the path). Start with `npm start`
(`node bin/www`). Everything below is verified by the test suite unless marked "not verified live".

## A. Script (KRAP station and curl)

`krap-station/` is left as Sylvia wrote it. Her scripts can keep generating audio themselves, or call the server instead.

1. Start the server (above). Set `API_KEY=<random>` (`openssl rand -hex 32`). Callers send it as `x-api-key`.
2. Voices: set `ELEVENLABS_API_KEY` and `ELEVENLABS_VOICES="Rocky=<id>,Britta=<id>"` (names are then used everywhere).
3. Check it: `curl -H "x-api-key: $KEY" $URL/providers` lists speech providers, models, effects, sounds.
4. Make a clip (not played on air): `curl -X POST $URL/synth -H "x-api-key: $KEY" -H 'content-type: application/json' -d '{"text":"Hello [sfx:ding]","voice":"Rocky","fx":{"preset":"underground"}}'`
5. Dialogue: send `script` ("Rocky: Hi.\nBritta (dry): Hello.") with `voices`, or `turns`.
6. Load Sylvia's spots into the library: `chips-voice/scripts/import_krap_spots.py` (see `docs/FOR-SYLVIA.md`).

## B. API (VirtuaHost and other callers)

1. On the server set `INGEST_TOKEN` (audio-only delivery, safer to hand to Netlify than the API key) and `PUBLIC_URL=https://your-host`.
2. On Netlify set `STATION_URL` and `STATION_INGEST_TOKEN` (see `docs/INTEGRATION.md` section 1) plus `GEMINI_API_KEY`.
3. Call VirtuaHost `POST /api/generate`; each clip is posted to the server's `/ingest` and a failure never fails the generation.
4. Scripts may contain `[sfx:name]` tags. VirtuaHost strips them before Gemini speaks (Gemini voices don't mix effects) and reports
   `sfxTagsRemoved`. To get effects mixed in, speak through the Chips Voice server (`/speak`, `/synth`) instead.
5. Tone and model: `tone` (e.g. "warm, slow") and `model` work on providers that support them (`/providers` shows `capabilities.tone`
   and `models`). OpenAI `gpt-4o-mini-tts` and OpenRouter speech models take tone as instructions.

OpenRouter speech: set `OPENROUTER_API_KEY`, `OPENROUTER_TTS_MODEL`, optionally `OPENROUTER_TTS_MODELS=a,b` (allowed list the UI/API may choose),
`OPENROUTER_TTS_VOICES`. `OPENROUTER_TTS_DIALOGUE=emulate` (default; one call per line, joined with ffmpeg) or `native` (one call with per-turn
voices; max 2 voices). Not verified live: the native per-turn field names (`text`, `voice`, `instructions`) are from OpenRouter's docs summary,
so emulate is the safe default. `google/*` models return 24 kHz PCM that is converted to MP3. AI scripts: `OPENROUTER_LLM_MODELS=a,b` picks which models
callers may name; `OPENROUTER_FALLBACK_MODELS` is the retry order.

### Sound effects

- Syntax: `[sfx:name]` inline. Options: `over` (mix over the following speech instead of before it), `vol=0.5` (0-2), `wait=1` (seconds of silence after, 0-5).
  Example: `Breaking news [sfx:riser over] the show starts now [sfx:whoosh vol=0.6 wait=0.5]`
- A line may contain only tags in a script (`[sfx:drumroll]`); it attaches to the neighbouring speaker.
- Built in (generated with ffmpeg, nothing to download): `GET /sfx` lists them (ding, chime, beep, buzzer, whoosh, riser, laser, static, click, heartbeat, alarm, phone, drumroll, crowd...).
- Upload your own: `POST /sfx?name=jingle` with the raw audio body (≤ `SFX_MAX_MB`, default 5; stored mono MP3). An upload with a built-in name overrides it.
  `DELETE /sfx/:name` removes uploads. `SFX_DIR` sets where they live (default `DATA_DIR/sfx`).
- Unknown names, malformed tags, more than 20 tags, SSML mode, or tags with no speech are rejected with 400 before any speech is paid for.
- The web UI has a "Sound effect" menu and a manager (preview, upload, delete).

## C. Stream server AutoDJ (Icecast + Liquidsoap)

Full walkthrough: `chips-voice/docs/DEPLOY-VPS.md` and `chips-voice/README.md` ("Option B"). Checklist:

1. Install on the VPS: `icecast2 liquidsoap ffmpeg nodejs(22)`. Mount `/stream` (music + announcements) and `/live` (live DJ).
2. Put music in the folder `radio.liq` points at (rotation: `chips-voice/docs/MUSIC-ROTATION.md`). 128 kbps MP3 is the configured rate.
3. Run Liquidsoap with `chips-voice/.../radio.liq`; it exposes a telnet port the server pushes `announce` / `announce_live` clips to.
4. Env: `STATION_PLAYBACK=liquidsoap`, the Liquidsoap host/port, `ICECAST_URL` (for now-playing), `API_KEY`, `SESSION_SECRET`, `PUBLIC_URL`.
5. Virtual host: configure in the UI card or `PUT /host` (voice, effects, every N tracks, `template` or `llm` lines, skip list); `HOST_*` env sets defaults.
   Test without audio: `POST /host/say {"artist":"A","title":"T","dryRun":true}`.
6. Run it under systemd (see `chips-voice/docs/DEPLOY-VPS.md`) behind HTTPS (Caddy/nginx). `/mcp` and `/chat/*` must also be on HTTPS.
7. Verify: `curl $URL/health`-style check via the UI "Now playing", `skip`, then `say` something and hear the music duck.

## D. Chat and MCP

### Chat (WhatsApp/SMS via Twilio, Telegram, or any bot)

Commands (send `help` to see them): `now`, `skip`, `volume 40`, `say [as Rocky] [with underground] [tone dry]: text`, `draft <brief>`, `clips`,
`play N`, `host on|off|status`, `host line <artist - title>`, `host persona [name] [as Voice]`, `id`, `schedule 09:00 | in 2h | every 1h: text`, `schedules`, `cancel N`, `fx`, `sfx`.
Anything that goes on air or schedules asks you to reply `YES` within 2 minutes (`CHAT_CONFIRM=false` disables this; not recommended).

1. `CHAT_ALLOWED=whatsapp:+15551234567,+15551234567,telegram:123456789` (comma list). Strangers get no reply at all. Empty list = nobody allowed.
2. Twilio: set `TWILIO_AUTH_TOKEN` and `PUBLIC_URL` exactly as Twilio sees it (signature is checked against it). Webhook URL: `$PUBLIC_URL/chat/twilio` (POST).
3. Telegram: `TELEGRAM_BOT_TOKEN`, `TELEGRAM_WEBHOOK_SECRET`; register webhook `$PUBLIC_URL/chat/telegram` with `secret_token` set to the same secret.
4. Anything else: `POST /chat/message {"from":"id","text":"now"}` with the API key. The key already authorizes everything, so `from` is not allowlist-checked there.
5. Limits: 12 messages per minute per sender. Not verified live: real Twilio/Telegram delivery (the signature code is checked against Twilio's published example).

### MCP (Claude Desktop, Claude Code, other MCP clients)

Tools: status/now-playing/voices/effects/sounds/clips/schedules/host (read), draft/make clip/apply effect/share link (write, nothing on air),
and say_on_air/play_clip/schedule/skip/volume/host_say (on air; their descriptions say PUBLIC STREAM so the assistant confirms first).

- stdio (local): `{"mcpServers":{"station":{"command":"node","args":["/path/chips-voice/googleTextToSpeech1/mcp/stdio.js"],"env":{"CHIPS_VOICE_URL":"https://your-host","CHIPS_VOICE_KEY":"<API_KEY>"}}}}`
- HTTP: connect a client to `$URL/mcp` with header `x-api-key`. Stateless; JSON responses.
- Safe mode: `MCP_READ_ONLY=true` (server env, applies to both) registers only read tools.

## Persona: CHIP

Way High Radio's computer DJ is a one-step preset on the virtual host: `PUT /host {"preset":"chip","voice":"<your voice>"}`. See [PERSONA-CHIP.md](PERSONA-CHIP.md).

## Troubleshooting

- `502 speech synthesis failed`: provider credentials missing; check `/providers`.
- 400 "unknown sound effect": `GET /sfx`; names are lower-case.
- Effects/sfx/dialogue unavailable: install ffmpeg (`/providers` shows `fx.available`, `sfx.available`).
- Twilio replies empty / 403: `PUBLIC_URL` differs from what Twilio calls (scheme, host, path), or sender is not in `CHAT_ALLOWED`.
- Server won't start on a headless box with `Failed to initialise RtMidi`: that is the existing MIDI output probe in `app.js`; install `libasound2` or run with a real ALSA device. Unrelated to these features.
