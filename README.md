# VirtuaHost — AI DJ audio pipeline

Generates and stores AI DJ audio clips for an online radio station, built on
Netlify Functions (compute) and Netlify Blobs (storage), with Google Gemini
doing both the script writing and the text-to-speech.

This is the core pipeline. Triggering it from WhatsApp and scheduling
announcements are not built yet — they're expected to call `POST /api/generate`.
Getting clips onto a live Icecast/Liquidsoap stream is done by the Chips Voice
server in `chips-voice/`: set `STATION_URL` and `STATION_INGEST_TOKEN` and each
generated clip is handed over automatically. See [docs/INTEGRATION.md](docs/INTEGRATION.md). Working on the KRAP side? Start with [docs/FOR-SYLVIA.md](docs/FOR-SYLVIA.md).

## Documentation

| Read | For |
|------|-----|
| [docs/SETUP.md](docs/SETUP.md) | Setup paths: scripts, API, stream-server AutoDJ, chat and MCP, several stations |
| [docs/FOR-SYLVIA.md](docs/FOR-SYLVIA.md) | Start here for the KRAP side: what replaces each script, what is verified |
| [docs/INTEGRATION.md](docs/INTEGRATION.md) | Netlify to the station hand-off, voices, effects, dialogue, the virtual host |
| [docs/NETLIFY.md](docs/NETLIFY.md) | Deploying on Netlify: logins, the AI key, every environment variable |
| [docs/HUB.md](docs/HUB.md) | The hub, the RadioDJ agent, and the Voice Lab and Stations tabs |
| [docs/PERSONA-CHIP.md](docs/PERSONA-CHIP.md) | CHIP, the computer DJ persona of Way High Radio |
| [chips-voice/README.md](chips-voice/README.md) | The Chips Voice server: API, playback backends, Icecast and Liquidsoap |

## Setup

1. `npm install`
2. `netlify link` (or `netlify init`) to connect this directory to a Netlify
   site — this is what makes Netlify Blobs available locally.
3. Copy `.env.example` to `.env` and set an AI key and a sign-in (`LOGIN_USERS` + `SESSION_SECRET`, or `ACCESS_KEY`). The AI key is `OPENROUTER_API_KEY`
   (recommended: one key, choose the writing and voice models yourself) or `GEMINI_API_KEY`
   (from [Google AI Studio](https://aistudio.google.com/), fixed models). `STATION_NAME` and `GEMINI_TTS_VOICE` are optional.
   For quick local experiments only, `AUTH_DISABLED=true` turns the key check off.
4. `netlify dev`

## Signing in

The site's API needs a sign-in on every request. People sign in with a username and password (`LOGIN_USERS` and
`SESSION_SECRET`; make a password hash with `npm run hash-password -- alice`). Scripts can use the optional
`ACCESS_KEY` instead, sent as `x-api-key: <key>` or `Authorization: Bearer <key>`. With neither configured the API
answers `503` instead of being open to the internet; a missing or wrong credential gets `401`. Wrong passwords are
throttled. Set these as site environment variables on Netlify (see [docs/NETLIFY.md](docs/NETLIFY.md)).

```
curl -X POST https://your-site.netlify.app/api/generate \
  -H "x-api-key: $ACCESS_KEY" -H "content-type: application/json" \
  -d '{"mode":"say","text":"Hello"}'
```

## The web UI

`public/` is a single page with these tabs, all running on the site itself (no other server):
**Generate** (write or have the AI write a line, hear it with effects and music mixed in, then save it),
**Voice Lab** (compare voices, models, tone and effects side by side; conversations),
**Personas** (host characters with ten examples, a sample explorer, and the virtual host settings),
**Flier** (turn an event flier into a promo clip that stops airing when the event is over), **Promos** (every promo, whether it can still play, and what repeats it),
**Schedules** (things that happen on a timetable), and **Library** (your saved clips, plus sound effects and music from OwnCloud or Google Drive).
**Stations** holds station profiles you can set up before any server exists (name, time zone, defaults); the one you work on is used by every tab (`docs/STATIONS.md`). **Control** (several live stations on one screen) stays switched off until the site is connected to the hub (`HUB_URL`, `HUB_KEY`).
The station itself needs only the small daemon in `station-daemon/` (see its README). Open the site's root URL (e.g. `https://your-site.netlify.app/` or `http://localhost:8888/`
under `netlify dev`) and sign in. The page itself is public and contains no secrets.

## API

### `POST /api/generate`

```json
{ "mode": "say", "text": "Coming up, the top of the hour news." }
```

or

```json
{ "mode": "ai", "prompt": "hype up the next song, it's a summer anthem" }
```

`mode: "say"` speaks the given `text` verbatim. `mode: "ai"` sends `prompt`
to the writing model first to write a DJ line, then synthesizes that. Optional fields:

| Field | Meaning |
|-------|---------|
| `textModel`, `speechModel` | OpenRouter model slugs from `GET /api/options` (only with `OPENROUTER_API_KEY`; others get 400) |
| `voice` | a voice the speech model understands (default: the model's own, or `OPENROUTER_VOICE`) |
| `tone` | how it should sound, up to 100 characters, e.g. `warm, slow, a little tired` |
| `format` | `station-id`, `song-intro`, `back-announce`, `promo`, `time-check`, `shoutout`: shapes AI-written lines |

Response:

```json
{ "id": "...", "scriptText": "...", "audioUrl": "/api/clips/...", "provider": "openrouter", "speechModel": "...", "textModel": "..." }
```

### `GET /api/options`

The provider in use, selectable models, tones, and the script formats with structure hints and examples (what the test console shows).

### `GET /api/clips`

Returns `{ "clips": [ClipMetadata, ...] }`, newest first.

### `GET /api/clips/:id`

Returns the clip's audio as `audio/wav`.

## Scripts

- `npm run dev` — `netlify dev`, runs the functions locally
- `npm run build` — typecheck (`tsc --noEmit`)
- `npm test` — run the unit tests (`vitest`, 39 tests); no credentials required, Gemini
  and Blobs are mocked. The Chips Voice server, hub and RadioDJ agent have their own suites (see `chips-voice/README.md`)
- `npm run lint` — `eslint .`
