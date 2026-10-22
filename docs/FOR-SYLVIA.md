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

The VirtuaHost web site itself grew a lot too: several logins with roles and limits, your own ElevenLabs/OpenRouter/Gemini keys (so Rocky and Britta can be used straight from the site), placeholders like `{{time}}` and `{{weather}}` in drops, cost estimates before anything is spent, and downloads of every clip. Those are summarised in [Added later: the VirtuaHost site](#added-later-the-virtuahost-site-netlify) at the end.

Full setup and environment variables: [INTEGRATION.md](INTEGRATION.md). Per-feature details: `chips-voice/docs/CLOUD-AND-AI.md`.

## Your script to the server feature

| You have | The server now has | Where |
|----------|--------------------|-------|
| `virtual_host.py --watch` | The same loop, following Icecast instead of RadioDJ: `lib/host.js`, `GET/PUT /host`, a card in the UI | `chips-voice/googleTextToSpeech1/lib/host.js` |
| `virtual_host.py --say A T [--dry-run]` | `POST /host/say {artist, title, dryRun, play}` | `routes/api.js` |
| `TEMPLATES`, `TIME_LINES`, `SKIP_ARTISTS` | Copied exactly as defaults in `lib/host.js` (`TEMPLATES`, `TIME_LINES`, `DEFAULT_SKIP`); editable at runtime via `PUT /host`. The Netlify site has its own, more general placeholders (`{{time}}`, `{{daypart}}`, `{{weather}}`, `{{artist}}`...): see [DROPS.md](DROPS.md) | `lib/host.js`, `lib/drop-template.ts` |
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

- **Voice ids are per account.** `ELEVENLABS_VOICES` maps names to ids. Cloned voices are not reachable through OpenRouter, only with the ElevenLabs key. The Netlify site now takes an ElevenLabs key too (site, station or personal) and offers your account's voices, clones first, by name: see [KEYS.md](KEYS.md).
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

Playing the link exactly as the track ends (needs remaining time from Liquidsoap), Britta in the links, and a calendar view for schedules. (More than one login is done on the Netlify site: see below.)

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

## Added later: the hub, the RadioDJ agent and the Voice Lab and Stations tabs

- `chips-voice/agent-radiodj/agent.js` lets a hub put clips on RadioDJ the way your `virtual_host.py` does: write `current_link.mp3`, fire a cart with `PlayCartByNumber` (same REST commands as `radiodj_api.sh`). It does not touch your scripts.
- Skip and volume for RadioDJ are off until the REST plugin's command names are set (`RADIODJ_CMD_SKIP`, `RADIODJ_CMD_VOLUME`); I could not confirm them. If you know them, that is the most useful thing to add.
- Everything else (hub, the site's Voice Lab and Stations tabs, playlist sync): [HUB.md](HUB.md).

## Added later: the VirtuaHost site (Netlify)

Nothing in `krap-station/` changed. These are all on the web site (`public/`, `lib/`, `netlify/functions/`) and are separate from the Chips Voice server above.

**Logins and limits** ([USERS.md](USERS.md)). More than one login is done: the first admin comes from the environment (`LOGIN_USERS`, `SESSION_SECRET`), then admins add people in the **Users** tab. Roles are admin and user; users see their own clips, personas and schedules plus the station's shared ones; admins also manage stations, the host settings and the Control tab. Each person can have limits (AI requests per day and month, saved clips, schedules).

**Your own keys, and Rocky and Britta on the site** ([KEYS.md](KEYS.md)). Anyone can save their own OpenRouter, Gemini or **ElevenLabs** key in the card at the top of the page; an admin can save one per station. Keys are encrypted and never shown again (only the last four characters). With an ElevenLabs key in place the speech-model list gains `elevenlabs/eleven_flash_v2_5`, `eleven_turbo_v2_5` and `eleven_multilingual_v2`, and the voice box suggests the voices on that account with **cloned voices first**: type `Rocky`, or a voice id. `ELEVENLABS_VOICES="Rocky=<id>,Britta=<id>"` works here too (same format). What is different from `gen.py` / the Chips Voice server: the site speaks one voice per line (no two-voice dialogue and no `underground` filter chain; send the text to the Chips Voice `/speak` for those, or use the `fx` options when sending a clip to the station), and ElevenLabs models ignore tone and `[laughs]`-style tags. Writing the words still needs an OpenRouter or Gemini key. **Not verified against the real ElevenLabs service.**

**Placeholders in drops** ([DROPS.md](DROPS.md)). Your `TEMPLATES` use `{artist}` and `{title}`; the site's drops can use `{{time}}`, `{{greeting}}`, `{{daypart}}`, `{{weather}}`, `{{station}}`, `{{dj}}`, `{{artist}}`, `{{title}}`, target length, and any `{{name}}` you define per station (a sponsor, a hotline), with `{{name|fallback}}` and `{{pick: a | b | c}}`. They are filled in after the AI writes and before the voice speaks, and the AI is told which ones exist and not to invent the values. Scheduled drops and the site's virtual-host links fill them in fresh each time. The Chips Voice server's own host (`lib/host.js`) still uses your original templates; the two systems do not interfere (single braces versus double).

**Spending less, and knowing before you spend** ([KEYS.md](KEYS.md)). Before writing, speaking, or reading a flier, the page shows an estimate (about 4 characters a token; dollars where OpenRouter lists a price; ElevenLabs in characters of credits) and asks first for premium, unpriced or much dearer models. The defaults are the cheap ones: `openai/gpt-4o-mini` to write and Kokoro to speak (Kokoro has no tone or tags: pick a Google speech model for those). Models are labelled with a price tier and whether they filter strong language, and *Allow strong language* hides the filtered ones and tells the writer not to censor. The "filtered" labels are hints from model names unless OpenRouter reports moderation itself, so try a line before relying on one.

**Download.** Every generated clip, sample and preview has a Download menu: as saved, WAV, or MP3 (converted in the browser).

**Where is the station?** In the Stations tab, type a town ("Houston, TX") and press Find: coordinates and time zone are filled in. That location drives weather, US weather alerts ([ALERTS.md](ALERTS.md)), `{{place}}`, and ranking which stations an event is near ([COVERAGE.md](COVERAGE.md)).

**Coverage estimate.** Enter a station's power, antenna and height in the Stations tab and it draws a rough circle or ellipse for where it is heard (it ignores terrain). The reference setup is a quarter-wave ground plane 50 ft up on Mapleton Hill in Boulder. It decides which stations an event is near and which alerts to follow: [COVERAGE.md](COVERAGE.md).

**Weather alerts (US).** `{{alert}}` placeholders on the site, and in the hub (`chips-voice/hub/alerts.js`) watches that record or broadcast National Weather Service alerts. It is not the Emergency Alert System; read [ALERTS.md](ALERTS.md) first.

**An AI agent can run it.** The site has an MCP endpoint (`/api/mcp`) so an assistant, yours or ours, can manage stations; anything that reaches the public stream or deletes needs a person's yes: [MCP.md](MCP.md).

**Your next steps** (hub on the IONOS server, RadioDJ at Way High and Greenlight, and the questions about your scripts and scheduling layer): [GREENLIGHT-AND-IONOS.md](GREENLIGHT-AND-IONOS.md).

**Verified here:** the logic behind all of the above is covered by the root `npm test` with mocked services (about 290 tests). **Not verified live:** OpenRouter's current model names (the list checks them against OpenRouter's own list when it can), Open-Meteo weather, ElevenLabs, and the exact prices (only OpenRouter's own listed prices are used; a small built-in table is marked "approx").
