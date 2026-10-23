# For Sylvia: what was added, and how it relates to your KRAP tools

Read this first. It is written so you can get up to speed in a few minutes. Nothing in `krap-station/` was changed:
`virtual_host.py`, `gen.py`, `process.py`, `scripts.py` and `radiodj_api.sh` are exactly as you left them. Everything below is new code
next to them, in `chips-voice/` (a Node server that runs beside Icecast/Liquidsoap) and in VirtuaHost's `lib/`.

> ## Update note for Sylvia (read this first; the rest of the file is the longer story)
>
> **What is merged and deployable:** just-in-time drops (the hub writes and speaks a line a few minutes before a dynamic slot, shadow mode by default); the RadioDJ agent with a read key and a control key, a kill switch only you can clear on the PC, live-show refusal, an audit log, a hash-named clip folder under `C:\GreenLightRadio`, and an outbound **pull** loop so the PC never needs an inbound connection; two clocks (`BROADCAST_TZ=America/Denver`, `MACHINE_TZ=America/Chicago`); conversations of up to four speakers; a Studio page that replaces Generate and Voice Lab. Everything was tested against fakes only. **Nothing has touched your RadioDJ.**
>
> **Behaviour changes you will notice:** the agent now listens on `127.0.0.1` only (set `AGENT_HOST` to expose it, or better use `HUB_URL` to pull); `AGENT_KEY` still works but separate `AGENT_READ_KEY` and `AGENT_CONTROL_KEY` are preferred; skip needs `RADIODJ_SKIP_VERIFIED=true` after you have tested it; the agent starts in **shadow mode** (`AGENT_SHADOW=true`: it accepts clips and inserts but executes nothing) until you set it to `false`; the fixed `current_link.mp3` is only written when `CLIP_CART` is set.
>
> **What I need from you, in order:**
> 1. A real `/npjson` response with a few items queued (so the agent reads the queue and the elapsed/remaining times correctly).
> 2. `INSERT_EXEC`: a script called `script <audio-file> <position> <replace-id>` that puts the file at that 1-based queue position **and removes the planned (evergreen) item with that id in the same step** (the generated clip preempts the planned one). Do your loudness and same-room processing in it. Exit non-zero on any failure. If you cannot make the swap one step, tell me: a leftover evergreen would air twice and the agent reports that as a failure.
> 3. `LOAD_EXEC` (loads `GLR YYYY-MM-DD*`), and the nightly plan file `GLR YYYY-MM-DD.json` next to each playlist (shape in `chips-voice/agent-radiodj/schedule.js`: items with `kind`, Denver `time`, and `dynamic-slot` markers carrying `slotKind`, `personaId`, `leadSeconds`, `fallbackClipId`).
> 4. Make the planned clips at dynamic slots **song-neutral** (station IDs, time checks, generic breaks, promos, weather; no "that was X" or "up next, Y"), and keep **legal station IDs** in planned clips (a generated station ID replaces them, so the generated line must still say the call sign and city: tell me the exact wording required).
> 5. For song requests: how to find a song in RadioDJ's library by artist and title, and whether the same insert script can add a requested song. For relay shows: how the stream switches between RadioDJ and a DJ's relay today, and an on/off script for it.
>
> **The live test, when 1 and 2 exist:** on a quiet stream, `AGENT_SHADOW=false`, insert one clip two ahead through the agent, and tell me what the queue looked like before and after. Nothing goes on the live station until Rocky has approved the shadow review and that single-item test.
>
> **Interfaces to keep stable:** a shared `now()` using `broadcastTz`; `tts_line(speaker, text, file)` with a backend switch (ElevenLabs direct, or this site's `POST /api/generate` with `preview: true`); the dynamic-slot markers in the plan file; the insert script contract above. Setup and every environment variable: `chips-voice/agent-radiodj/.env.example`. Roadmap: `docs/ROADMAP.md`. Everything not yet built or decided: `docs/HANDOFF.md`.

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

## Added later: the hub, the RadioDJ agent and the Studio and Stations tabs

- `chips-voice/agent-radiodj/agent.js` lets a hub put clips on RadioDJ the way your `virtual_host.py` does: write `current_link.mp3`, fire a cart with `PlayCartByNumber` (same REST commands as `radiodj_api.sh`). It does not touch your scripts.
- Skip and volume for RadioDJ are off until the REST plugin's command names are set (`RADIODJ_CMD_SKIP`, `RADIODJ_CMD_VOLUME`); I could not confirm them. If you know them, that is the most useful thing to add.
- Everything else (hub, the site's Studio and Stations tabs, playlist sync): [HUB.md](HUB.md).

## Added later: the VirtuaHost site (Netlify)

Nothing in `krap-station/` changed. These are all on the web site (`public/`, `lib/`, `netlify/functions/`) and are separate from the Chips Voice server above.

**Logins and limits** ([USERS.md](USERS.md)). More than one login is done: the first admin comes from the environment (`LOGIN_USERS`, `SESSION_SECRET`), then admins add people in the **Users** tab. Roles are admin and user; users see their own clips, personas and schedules plus the station's shared ones; admins also manage stations, the host settings and the Control tab. Each person can have limits (AI requests per day and month, saved clips, schedules).

**Your own keys, and Rocky and Britta on the site** ([KEYS.md](KEYS.md)). Anyone can save their own OpenRouter, Gemini or **ElevenLabs** key in the card at the top of the page; an admin can save one per station. Keys are encrypted and never shown again (only the last four characters). With an ElevenLabs key in place the speech-model list gains `elevenlabs/eleven_flash_v2_5`, `eleven_turbo_v2_5` and `eleven_multilingual_v2`, and the voice box suggests the voices on that account with **cloned voices first**: type `Rocky`, or a voice id. `ELEVENLABS_VOICES="Rocky=<id>,Britta=<id>"` works here too (same format). What is different from `gen.py` / the Chips Voice server: the site speaks one voice per line (no two-voice dialogue and no `underground` filter chain; send the text to the Chips Voice `/speak` for those, or use the `fx` options when sending a clip to the station), and ElevenLabs models ignore tone and `[laughs]`-style tags. Writing the words still needs an OpenRouter or Gemini key. **Not verified against the real ElevenLabs service.**

**Placeholders in drops** ([DROPS.md](DROPS.md)). Your `TEMPLATES` use `{artist}` and `{title}`; the site's drops can use `{{time}}`, `{{greeting}}`, `{{daypart}}`, `{{weather}}`, `{{station}}`, `{{dj}}`, `{{artist}}`, `{{title}}`, target length, and any `{{name}}` you define per station (a sponsor, a hotline), with `{{name|fallback}}` and `{{pick: a | b | c}}`. They are filled in after the AI writes and before the voice speaks, and the AI is told which ones exist and not to invent the values. Scheduled drops and the site's virtual-host links fill them in fresh each time. The Chips Voice server's own host (`lib/host.js`) still uses your original templates; the two systems do not interfere (single braces versus double).

**Spending less, and knowing before you spend** ([KEYS.md](KEYS.md)). Before writing, speaking, or reading a flier, the page shows an estimate (about 4 characters a token; dollars where OpenRouter lists a price; ElevenLabs in characters of credits) and asks first for premium, unpriced or much dearer models. The defaults are the cheap ones: `openai/gpt-4o-mini` to write and Kokoro to speak (Kokoro has no tone or tags: pick a Google speech model for those). Models are labelled with a price tier and whether they filter strong language, and *Allow strong language* hides the filtered ones and tells the writer not to censor. The "filtered" labels are hints from model names unless OpenRouter reports moderation itself, so try a line before relying on one.

**Download.** Every generated clip, sample and preview has a Download menu: as saved, WAV, or MP3 (converted in the browser).

**Where is the station?** In the Stations tab, type a town ("Houston, TX") and press Find: coordinates and time zone are filled in. That location drives weather, US weather alerts ([ALERTS.md](ALERTS.md)), `{{place}}`, and ranking which stations an event is near ([COVERAGE.md](COVERAGE.md)).

**Coverage estimate.** Enter a station's power, antenna and height in the Stations tab and it draws a rough circle or ellipse for where it is heard (it ignores terrain). The reference setup is a quarter-wave ground plane 50 ft up on Mapleton Hill in Boulder. It decides which stations an event is near and which alerts to follow: [COVERAGE.md](COVERAGE.md). Both stations are FM; when a Nautel (terrain-aware) coverage map is ready, how to export and prepare it for import is in the same page.

**Weather alerts (US).** `{{alert}}` placeholders on the site, and in the hub (`chips-voice/hub/alerts.js`) watches that record or broadcast National Weather Service alerts. It is not the Emergency Alert System; read [ALERTS.md](ALERTS.md) first.

**An AI agent can run it.** The site has an MCP endpoint (`/api/mcp`) so an assistant, yours or ours, can manage stations; anything that reaches the public stream or deletes needs a person's yes: [MCP.md](MCP.md).

**Your next steps** (hub on the IONOS server, RadioDJ at Way High and Greenlight, and the questions about your scripts and scheduling layer): [GREENLIGHT-AND-IONOS.md](GREENLIGHT-AND-IONOS.md).

**Verified here:** the logic behind all of the above is covered by the root `npm test` with mocked services (about 290 tests). **Not verified live:** OpenRouter's current model names (the list checks them against OpenRouter's own list when it can), Open-Meteo weather, ElevenLabs, and the exact prices (only OpenRouter's own listed prices are used; a small built-in table is marked "approx").

## Added later: just-in-time drops (what is yours, what is not)

Mine (server side): hub scheduler, validation, shadow mode, approval queue, the agent API (`/agent/status`, `/schedule`, `/queue/insert`, hash-named `/ingest`, kill switch, audit log) and the pull loop, all tested against a fake RadioDJ and fake providers. **None of it has touched a live RadioDJ.** Read [HUB.md](HUB.md#10-just-in-time-jit-drops-shadow-mode-and-the-pull-model), especially the "needs live verification" list.

Yours (please keep these stable): a shared `now()` using `broadcastTz` (America/Denver), never the PC's clock; `tts_line(speaker, text, file)` with a backend switch (ElevenLabs direct, or `POST /api/generate {mode:"say", preview:true}` on this site); the dynamic-slot markers in the nightly plan (`GLR YYYY-MM-DD.json`, shape in `chips-voice/agent-radiodj/schedule.js`) with an evergreen clip at each; local processing (loudness, same-room EQ) before insertion, which fits in `INSERT_EXEC` (called as `script <file> <position> <replace-id>`; it is run with no shell); and the queue-insert live test. Decided: the JIT clip **replaces** the evergreen item. The agent only calls your script when the evergreen is at least 2 ahead in the queue, passes its id as `<replace-id>`, and reads the queue back; your script must swap (insert the new clip at that position and remove the evergreen) as one step. If you cannot make that atomic, tell me: a leftover evergreen would air twice, which the hub reports as a failure.
The agent now defaults to `127.0.0.1`, `C:\GreenLightRadio\clips` (not `C:\KRAP`), a unique file per clip (the fixed `current_link.mp3` is only written when a cart is configured), and Windows-safe retries.

## Added later: scripts, requests and what I need from you

- **Conversations** (docs/SCRIPTS.md): the site can now speak a conversation of up to four speakers (each in their own persona's voice) as one clip, in the Studio, in schedules and in dynamic slots. Nothing changes in your scripts: the clip is just audio.
- **Evergreen drops should not name songs.** Once requests exist, a song can be inserted anywhere, so a baked "that was X" or "up next, Y" may be wrong. Planned clips at dynamic slots should be station IDs, time checks, generic breaks, promos or weather. Please tell me which of your current baked drops name songs.
- **For song requests (docs/ROADMAP.md)** I need: how to find a song in RadioDJ's library by artist and title (a table, or a folder to search); whether a requested song can be inserted with the same script (file, position); the real `/npjson` output with a few items queued.
- **Relay shows** (a DJ broadcasting onto a relay): how does the stream switch between RadioDJ and a relay today (RadioDJ, Liquidsoap, Icecast fallback mounts)? The agent will watch the relay source and call a script (on/off) you provide; it never touches RadioDJ's commands itself.
- **Google Calendar** is planned for the audience-facing schedule; nothing is needed from you yet.
