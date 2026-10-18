# For Sylvia: what was added, and how it relates to your KRAP tools

Read this first. It is written so you can get up to speed in a few minutes. Nothing in `krap-station/` was changed:
`virtual_host.py`, `gen.py`, `process.py`, `scripts.py` and `radiodj_api.sh` are exactly as you left them. Everything below is new code
next to them, in `chips-voice/` (a Node server that runs beside Icecast/Liquidsoap) and in VirtuaHost's `lib/`.

## The one-paragraph picture

VirtuaHost (Netlify) generates DJ audio with Gemini and now hands each clip to the **Chips Voice server** (`chips-voice/`), which runs on
the Icecast box. That server keeps a clip library, can voice text with ElevenLabs (your Rocky and Britta clones), OpenRouter, Google and
others, can post-process audio with ffmpeg (your "underground" sound and voice-changer effects), can do two-voice dialogue, and plays
clips through Liquidsoap with the music ducked. It also contains a **server-side copy of your live host** that follows Icecast instead of RadioDJ.

```
VirtuaHost (Netlify, Gemini) --POST /ingest--> Chips Voice server --telnet--> Liquidsoap --> Icecast /stream
KRAP scripts / curl ---------POST /synth etc -->   (library, voices, ffmpeg effects, virtual host, schedules)
```

Full setup and environment variables: [INTEGRATION.md](INTEGRATION.md). Per-feature details: `chips-voice/docs/CLOUD-AND-AI.md`.

## Your script to the server feature

| You have | The server now has | Where |
|----------|--------------------|-------|
| `virtual_host.py --watch` | The same loop, following Icecast instead of RadioDJ: `lib/host.js`, `GET/PUT /host`, a card in the UI | `chips-voice/googleTextToSpeech1/lib/host.js` |
| `virtual_host.py --say A T [--dry-run]` | `POST /host/say {artist, title, dryRun, play}` | `routes/api.js` |
| `TEMPLATES`, `TIME_LINES`, `SKIP_ARTISTS` | Copied exactly as defaults in `lib/host.js` (`TEMPLATES`, `TIME_LINES`, `DEFAULT_SKIP`); editable at runtime via `PUT /host` | `lib/host.js` |
| `gen.py` text-to-dialogue (R and B voices) | `turns` (or a pasted `script`) on `/speak` and `/synth`; Dialogue mode in the UI; same chunking and per-line fallback | `lib/providers/tts/elevenlabs.js` |
| Voice ids `R` and `B` | `ELEVENLABS_VOICES="Rocky=5amD...,Britta=DOg6..."` (names are used everywhere) | env |
| `TEXTURE` filter chain in `gen.py` | Effect preset `underground` (byte-for-byte the same filters, plus the pink-noise bed and loudnorm) | `lib/fx.js` |
| `process.py` (tempo, trim pauses, texture) | `fx: { preset: "underground", speed: 1.08, tighten: true }` | `lib/fx.js` |
| `scripts.py` SPOTS, SPOTS_FUN, TALK | `chips-voice/scripts/import_krap_spots.py` loads them into the library as dialogue clips | `chips-voice/scripts/` |
| RadioDJ cart plays `current_link.mp3` | Liquidsoap `announce` queue plays the clip over the music, ducked | `radio.liq`, `app.js` |
| `radiodj_api.sh` | Not replaced. RadioDJ stays yours; the server side does not talk to RadioDJ | n/a |

### How the server-side host differs from `virtual_host.py` (read this before comparing behaviour)

- **Timing.** RadioDJ tells you seconds remaining; Icecast does not. So the server prepares the link while a track plays and plays it as
  the next track starts ("That was ..."), with Liquidsoap ducking the music. Your version plays it as the track ends.
- **Never over a spot.** If the new track's artist is in the skip list (your three names, case-insensitive) it stays quiet and prepares nothing.
  It also stays quiet and spends no voice credits while a live DJ is on air (`preempt` can override).
- **Cost control.** `every` (a link every Nth song, default 1), `minGapSeconds` (default 45), and links are cached by content, so a repeated line is free.
- **Smarter lines.** `lines: "llm"` asks the configured language model (OpenRouter etc.) for the link and falls back to your templates on any error.
- **Defaults.** Voice from `HOST_VOICE` (set it to `Rocky`), finish `underground`, provider = first enabled.
- It is **off by default** and only runs when enabled (UI switch, or `PUT /host {"enabled": true}`, or the saved setting on restart).

## Things you can do right now

```sh
# Listen to a line without spending credits (your --dry-run)
curl -s -H "x-api-key: $KEY" -H 'content-type: application/json' \
  -d '{"artist":"Boards of Canada","title":"Roygbiv","dryRun":true}' $STATION/host/say

# Voice a two-person bit, finished with the KRAP sound
curl -s -H "x-api-key: $KEY" -H 'content-type: application/json' $STATION/speak -d '{
  "provider":"elevenlabs", "fx":"underground",
  "script":"Rocky: Britta, what are we listening to?\nBritta: [laughs] Honestly? No idea.",
  "voices":{"Rocky":"Rocky","Britta":"Britta"} }'

# Push audio you made yourself (a link, a spot) onto the station and play it
curl -X POST -H "Authorization: Bearer $INGEST_TOKEN" -H "Content-Type: audio/mpeg" \
  --data-binary @link.mp3 "$STATION/ingest?title=Link&play=true&fx=underground"

# Load all your spots into the library (dry run first)
CHIPS_VOICE_URL=$STATION CHIPS_VOICE_KEY=$KEY python3 chips-voice/scripts/import_krap_spots.py --dry-run
```

## New API pieces (all need the API key or a login, except `/ingest` which takes `INGEST_TOKEN`)

| Call | Does |
|------|------|
| `POST /speak`, `POST /synth` | Voice text, SSML, `turns` or a `script`; optional `provider`, `voice`, `fx`. `/speak` also plays it |
| `GET /fx/presets` | The effect list: underground, telephone, radio, walkie, megaphone, robot, whisper, cave, underwater, chorus, chipmunk, deep, alien, demon |
| `POST /clips/:id/fx` | A processed copy of an existing clip (the voice changer on something already made) |
| `POST /ingest`, `/ingest/url` | Receive finished audio, optionally `fx` applied on arrival |
| `GET/PUT /host`, `POST /host/say` | The virtual host |
| `GET /clips`, `POST /clips/:id/play` | The library and replay |

**Effects** are structured, not raw ffmpeg: `{ preset, pitch (-12..12 semitones), speed (0.5..2), tighten, normalize }`. They are
validated, so a request cannot inject filter text. Needs ffmpeg on the server; without it the effect controls are hidden.

**Dialogue** works with every provider. ElevenLabs does it natively (text-to-dialogue, split into several requests above 2,000 characters and joined).
Other providers voice each line with that speaker's voice and the parts are joined with ffmpeg. Voices in `turns` belong to the chosen provider.

## Practical notes and gotchas

- **Voice ids are per account.** `ELEVENLABS_VOICES` maps names to ids. Cloned voices are not reachable through OpenRouter, only with the ElevenLabs key.
- **`TTS_PROVIDER` is a list.** First is the default, the rest are fallbacks. A request can pick one with `provider` (then no fallback).
- **The clip library de-duplicates.** The same text, voice, settings and effect is generated once. Changing any of them makes a new clip.
- **Imported audio is never evicted** (it cannot be regenerated); generated clips are evicted oldest-first past `CLIP_CACHE_MB` unless favorited.
- **MP3 everywhere.** Effects, dialogue and imports produce 128k MP3, the stream bitrate.
- **Secrets.** None are stored in the repo. The ingest token can only deliver audio. Do not put keys in scripts or commit `.env`.
- **Tests.** `cd chips-voice/googleTextToSpeech1 && npm test` (Node's test runner; uses real ffmpeg where it can). VirtuaHost root: `npm test`. The root
  lint and vitest ignore `chips-voice/`.

## What is verified, and what is not

Verified here with local stand-ins: all tests; every effect preset on real audio with ffmpeg; the host loop end to end (a link about song one was
voiced through a mock ElevenLabs, finished with `underground`, and pushed to a fake Liquidsoap when song two began; a spot got nothing);
dialogue chunking and joining; the ingest hand-off.

**Not verified against the real services:** ElevenLabs, OpenRouter, Gemini, Liquidsoap, Icecast. Specifically unconfirmed: how your Liquidsoap
reports metadata (the host reads Icecast's `title`/`artist` for the `/stream` mount, so check `GET /host` shows the right track), and the actual
ducking sound. Try the host on a quiet stream first.

## Not built yet

Playing the link exactly as the track ends (needs remaining time from Liquidsoap), Britta in the links, a calendar view for schedules, and more than one login.

## Where to look in the code

- `chips-voice/googleTextToSpeech1/lib/host.js` is the virtual host; `test/host.test.js` shows its behaviour as examples.
- `lib/fx.js` is the effects; `test/fx.test.js`.
- `lib/providers/tts/` are the voices; `lib/clips.js` is the library; `lib/ingest.js` is receiving audio; `routes/api.js` is the HTTP surface.
- `lib/handoff.ts` (VirtuaHost root) is the Netlify to station push.

## Added later: sound effects, tone, chat and MCP

- **Sound effects**: put `[sfx:name]` in any script (`over`, `vol=`, `wait=` options). Built-ins are generated by ffmpeg; uploads via `POST /sfx`. Your KRAP scripts are untouched; to get effects, send the text to `/speak` or `/synth`.
- **Tone and models**: `tone` and `model` fields (and `Name (direction): text` lines in pasted scripts) work with OpenRouter speech and OpenAI `gpt-4o-mini-tts`.
- **Chat and MCP**: the station can be run from WhatsApp/Telegram/MCP assistants. On-air actions ask for a YES first.
- Setup for all use cases: [SETUP.md](SETUP.md). Not verified live: OpenRouter native dialogue field names, real Twilio/Telegram delivery.
