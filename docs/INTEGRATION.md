# How VirtuaHost, Chips Voice and the KRAP tools fit together

```
 Netlify                                         Your Icecast server
┌────────────────────────────┐   POST /ingest   ┌──────────────────────────────────────────────┐
│ VirtuaHost                 │  (audio + token) │ Chips Voice server                           │
│  /api/generate             │ ───────────────> │  clip library, schedules, login, web UI      │
│  Gemini: DJ line + speech  │   or a link it   │  voices: ElevenLabs (your clones),           │
│  Netlify Blobs: copy       │   fetches        │          OpenRouter speech, Google, ...      │
└────────────────────────────┘                  │        │ telnet 127.0.0.1                    │
        ^                                       │   Liquidsoap ── ducks music, plays the clip  │
        │ later: WhatsApp, schedules            │        │                                     │
                                                │   Icecast  /stream   <- live DJ on /live     │
 KRAP scripts (Sylvia)  ───────────────────────>│  (import_krap_spots.py voices her scripts)   │
                                                └──────────────────────────────────────────────┘
```

Liquidsoap and Icecast run on your own server. Netlify only generates audio. It never touches Liquidsoap:
it hands the finished file to the Chips Voice server, which puts it in its library and onto the air.

## 1. Netlify to the station (the hand-off)

**On the station server** set an ingest token. It can deliver audio and do nothing else:

```
INGEST_TOKEN=<a long random string>       # openssl rand -hex 32
INGEST_MAX_MB=25                          # optional size cap
```

The station must be reachable over **https** from Netlify (see `chips-voice/docs/DEPLOY-VPS.md` for nginx and a certificate).

**On Netlify** (Site settings, Environment variables):

```
STATION_URL=https://radio.example.com
STATION_INGEST_TOKEN=<the same string>
STATION_AUTOPLAY=true       # put every generated clip on air; leave unset to only store them
STATION_PREEMPT=false       # true: interrupt a live DJ instead of skipping
```

Then `POST /api/generate` works as before, and the response gains a `handoff` field:

```json
{ "id": "...", "scriptText": "...", "audioUrl": "/api/clips/...",
  "handoff": { "sent": true, "clipId": "ab12...", "played": true } }
```

- Per request: `"play": true|false`, `"preempt": true|false`, `"handoff": false` (skip the station entirely).
- If a live DJ is on air and the request did not ask to preempt, the clip is stored but not played:
  `"played": false, "reason": "live DJ on air"`.
- If the station is down the request still succeeds (the clip is saved on Netlify) and `handoff.sent` is `false` with the reason.
- `STATION_URL` must be https (plain http is accepted only for localhost), because the token travels in a header.
- The station converts Gemini's WAV to MP3 at the stream bitrate with ffmpeg (about a third of the size). Install ffmpeg on the
  station, or set `INGEST_TRANSCODE=false` to keep WAV.
- The same clip sent twice is stored once.

### The link alternative

If you would rather give a link than push bytes, the station can fetch it:

```
POST https://radio.example.com/ingest/url      Authorization: Bearer <INGEST_TOKEN>
{ "url": "https://your-site.netlify.app/api/clips/<id>", "title": "...", "play": true }
```

Only https hosts listed in `INGEST_ALLOWED_HOSTS=your-site.netlify.app` are fetched, with no redirects and a size cap,
so the endpoint cannot be used to reach other machines. VirtuaHost's `/api/clips/:id` now needs the `ACCESS_KEY`, and `/ingest/url`
cannot send it, so this pull alternative no longer works against a protected VirtuaHost: use the push hand-off above (the default), which is unaffected.

## 2. Voices: Chips Voice speaking for you

Enable several providers; the first is the default and the others are fallbacks. A request or the UI can pick one:

```
TTS_PROVIDER=elevenlabs,openrouter,google
```

**ElevenLabs (your voice clones).** This needs an ElevenLabs API key. Clones belong to your ElevenLabs account, so they cannot
be reached through OpenRouter.

```
ELEVENLABS_API_KEY=...
ELEVENLABS_VOICES="Rocky=5amDDTRPktSyYIB9MtzS,Britta=DOg6sHAvvPBmlN73L7CI"   # names shown in the UI
ELEVENLABS_MODEL=eleven_v3        # default; audio tags like [softly] and [laughs] work
```

The voice ids above are the ones in `krap-station/krap/gen.py`. The UI's **Dialogue** mode (or `turns` in the API) voices
Rocky and Britta talking to each other with ElevenLabs text-to-dialogue, split into several requests if the script is long and
joined with ffmpeg, with the same per-line fallback Sylvia's script uses.

**OpenRouter speech.** OpenRouter exposes an OpenAI-compatible `/audio/speech` endpoint with several speech models. It is not
ElevenLabs and has no voice clones. Pricing and any free allowance depend on the model; check the model's page.

```
OPENROUTER_API_KEY=...
OPENROUTER_TTS_MODEL=<a speech model id from openrouter.ai/models>
OPENROUTER_TTS_VOICES=alloy,nova       # voices differ per model
```

`GET /tts/models?provider=openrouter` lists the speech models OpenRouter currently offers. OpenRouter text models for
AI drafting use `LLM_PROVIDER=openrouter` as before.

## 3. Sylvia's scripts

- **Spots and talk.** `chips-voice/scripts/import_krap_spots.py` reads `krap-station/krap/scripts.py` and voices every spot (and,
  with `--talk`, the long pirate-radio talk) through the Chips Voice server as Rocky/Britta dialogue. The clips land in the
  library, tagged `krap`, where they can be played, scheduled, shared or sent to Liquidsoap. Re-running pays for nothing that
  already exists.

  ```sh
  CHIPS_VOICE_URL=https://radio.example.com CHIPS_VOICE_KEY=<API_KEY of the station> \
    python3 chips-voice/scripts/import_krap_spots.py --dry-run      # list first
  python3 chips-voice/scripts/import_krap_spots.py --talk           # then do it
  ```

- **Her audio finishing.** `gen.py` and `process.py` post-process with ffmpeg ("underground" texture, loudness). That is not
  built into Chips Voice yet. Her output files can already be pushed to the station as they are:
  `curl -X POST -H "Authorization: Bearer $INGEST_TOKEN" -H "Content-Type: audio/mpeg" --data-binary @link.mp3 "$STATION/ingest?title=Link&play=true"`.
- **`virtual_host.py` (the live link host).** Still Sylvia's, for RadioDJ on Windows. Replacing it with a server-side version
  (read now-playing from Icecast, an LLM writes the link, Liquidsoap plays it over the music) is the next step and is not built.

## 4. Effects and voice changer

Chips Voice post-processes audio with ffmpeg: the KRAP `underground` sound (the exact filter chain from `gen.py`), telephone, radio, walkie-talkie,
megaphone, robot, whisper, cave, underwater, chorus, chipmunk, deep, alien and demon, plus `pitch` (-12..12 semitones), `speed` (0.5..2)
and `tighten` (trim long pauses, as in `process.py`). Ask for it on any speech request (`"fx": "underground"` or
`"fx": {"preset":"robot","pitch":2}`), on an existing clip (`POST /clips/:id/fx`, which makes a processed copy), or on arrival from VirtuaHost
(`STATION_FX=underground` or `"fx"` in the generate request, which becomes `?fx=` on `/ingest`). Needs ffmpeg on the station.

## 5. Conversational dialogue

`turns: [{ "voice": "Rocky", "text": "..." }, ...]`, or a written `script` ("Rocky: ...", one line per turn) with a `voices` map, on `/speak` and `/synth`.
ElevenLabs voices it natively as one conversation; every other provider voices each line and joins them with ffmpeg. The UI has a Dialogue mode with a
"Paste a script" box.

## 6. The server-side virtual host

A copy of `krap-station/host/virtual_host.py` that follows Icecast instead of RadioDJ (the original is untouched): it writes a link about each song from the
same templates, voices it as Rocky, finishes it with `underground`, and plays it as the next song starts, ducked over the music. It stays quiet for spots and
live DJs. Off by default: turn it on in the UI ("Virtual host" card) or `PUT /host {"enabled": true}`. Settings, differences from the script, and the cost
controls are in [FOR-SYLVIA.md](FOR-SYLVIA.md). Environment defaults: `HOST_VOICE=Rocky`, `HOST_FX=underground`, `HOST_EVERY`, `HOST_LINES`, `HOST_SKIP_ARTISTS`, `HOST_PERSONA`.

## What was and was not verified

Run here, against local stand-ins for the outside services:

- Every test suite (VirtuaHost 39 tests; Chips Voice server 135; hub 15; RadioDJ agent 6) and a clean UI build, including real ffmpeg conversion, effects, sound effects and joining.
- The virtual host end to end: a link about one song was voiced, finished with `underground`, and pushed to a fake Liquidsoap when the next song began; a spot got nothing.
- A real round trip: VirtuaHost's `handleGenerate` pushed a clip to a running Chips Voice server, which converted, stored and
  played it (through a fake Liquidsoap). A wrong token was refused.
- The KRAP import against a mock ElevenLabs: 10 spots plus the 59-line talk (split into 4 requests and joined).

Not run: real ElevenLabs, OpenRouter, Gemini, Liquidsoap, Icecast, or a Netlify deploy. Try each once with real credentials.

## 7. Sound effects, chat, MCP and personas

See [SETUP.md](SETUP.md) for the setup paths (script, API, stream server AutoDJ), sound effects, OpenRouter tone and models, and the chat/MCP integrations. The CHIP persona is in [PERSONA-CHIP.md](PERSONA-CHIP.md).

## 8. Several stations

One hub can control several Chips Voice/Liquidsoap servers and RadioDJ machines, start a broadcast on all of them together, share playlists and copy host settings; two web apps (Voice Lab, Control Panel) sit in front of it. See [HUB.md](HUB.md).
