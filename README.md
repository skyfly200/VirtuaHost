# VirtuaHost — AI DJ audio pipeline

Generates and stores AI DJ audio clips for an online radio station, built on
Netlify Functions (compute) and Netlify Blobs (storage). OpenRouter (any writing and speech model, including free ones) or Google Gemini
writes the lines and speaks them, and ElevenLabs can speak them in your cloned voices. Several people can sign in, each with their own
clips, keys and limits.

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
| [docs/USERS.md](docs/USERS.md) | Users, roles, who sees what, and per-person limits |
| [docs/KEYS.md](docs/KEYS.md) | Your own AI keys (per person or station), ElevenLabs voice clones, model lists, costs and warnings, free models, content filtering |
| [docs/DROPS.md](docs/DROPS.md) | Placeholders for drops (`{{time}}`, `{{weather}}`, `{{dj}}`...) and the templating engine |
| [docs/STATIONS.md](docs/STATIONS.md) | Station profiles, their defaults, finding the place by name, own placeholders and allowed models |
| [docs/ALERTS.md](docs/ALERTS.md) | US weather alerts from the National Weather Service: placeholders, and watches in the hub (not the Emergency Alert System) |
| [docs/COVERAGE.md](docs/COVERAGE.md) | Coverage areas: which stations an event or alert is relevant to, and the plan for population modelling |
| [docs/MCP.md](docs/MCP.md) | The MCP endpoint: let an AI agent manage stations, with confirm-before-air safety |
| [docs/GREENLIGHT-AND-IONOS.md](docs/GREENLIGHT-AND-IONOS.md) | The hub on the IONOS server, RadioDJ at Way High and Greenlight, and the questions for Sylvia |
| [docs/CUES.md](docs/CUES.md) | What each speech model does with tone and tags |
| [docs/SCRIPTS.md](docs/SCRIPTS.md) | Scripts, conversations (up to 4 speakers) and the Studio |
| [docs/ROADMAP.md](docs/ROADMAP.md) | What is built, what is next (requests, relay shows, Google Calendar) |
| [docs/HUB.md](docs/HUB.md) | The hub, the RadioDJ agent, and the Studio and Stations tabs |
| [docs/FRESHNESS.md](docs/FRESHNESS.md) | Which drops can be reused and which must be made on the spot (rules, the Jev second layer, lead time) |
| [docs/GREEN-LIGHT-PARITY.md](docs/GREEN-LIGHT-PARITY.md) | What the Green Light Radio scripts do that the app does not yet (call-ins, promos, recaps, placement, rotation) |
| [docs/PERSONA-CHIP.md](docs/PERSONA-CHIP.md) | CHIP, the computer DJ persona of Way High Radio |
| [chips-voice/README.md](chips-voice/README.md) | The Chips Voice server: API, playback backends, Icecast and Liquidsoap |

## Setup

1. `npm install`
2. `netlify link` (or `netlify init`) to connect this directory to a Netlify
   site — this is what makes Netlify Blobs available locally.
3. Copy `.env.example` to `.env` and set an AI key and a sign-in (a first admin in `LOGIN_USERS` + `SESSION_SECRET`, or `ACCESS_KEY`; add `SECRETS_KEY` if people will save their own AI keys). The AI key is `OPENROUTER_API_KEY`
   (recommended: one key, choose the writing and voice models yourself) or `GEMINI_API_KEY`
   (from [Google AI Studio](https://aistudio.google.com/), fixed models). `STATION_NAME` and `GEMINI_TTS_VOICE` are optional.
   For quick local experiments only, `AUTH_DISABLED=true` turns the key check off.
4. `netlify dev`

## Signing in

The site's API needs a sign-in on every request. People sign in with a username and password. Your first admin comes from the
environment (`LOGIN_USERS` and `SESSION_SECRET`; make a password hash with `npm run hash-password -- alice`); that admin then adds everyone
else in the **Users** tab, with a role (admin or user) and optional limits ([docs/USERS.md](docs/USERS.md)). Scripts can use the optional
`ACCESS_KEY` instead (it acts as an admin), sent as `x-api-key: <key>` or `Authorization: Bearer <key>`. With neither configured the API
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
**Studio** (compare voices, models, tone and effects side by side; conversations),
**Personas** (host characters with nine examples, a sample explorer, and the virtual host settings),
**Flier** (turn an event flier into a promo clip that stops airing when the event is over), **Promos** (every promo, whether it can still play, and what repeats it),
**Schedules** (things that happen on a timetable), and **Library** (your saved clips, plus sound effects and music from OwnCloud or Google Drive). **Users** (admins) manages people and their limits.
Every piece of generated audio has a **Download** menu (as saved, WAV or MP3), and before each AI step the page shows an estimate of what it will use (tokens, and dollars where a price is known) and asks first if the model is premium, unpriced or much dearer than the default. Models are labelled by price tier and by whether they filter strong language; *Allow strong language* hides the ones that do. Drops can carry placeholders such as `{{time}}`, `{{weather}}` and `{{dj}}` that are filled in just before the voice speaks ([docs/DROPS.md](docs/DROPS.md)).
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
| `seconds` | about how long the spoken line should be (3 to 90); the writer is told, and `{{target_seconds}}` / `{{target_words}}` are filled in |
| `explicit` | `true` allows profanity: the writer is told not to censor. Pair with a model not marked `filtered` in `GET /api/options` |
| `station`, `persona` | ids from `GET /api/stations` and `/api/personas`; their name, tagline, defaults and the DJ's name feed the writing and the placeholders |

Response:

```json
{ "id": "...", "scriptText": "...", "audioUrl": "/api/clips/...", "provider": "openrouter", "speechModel": "...", "textModel": "..." }
```

### `GET /api/options`

The provider in use, selectable models (with `models.info`: price tier, USD per million tokens when known, and a content-filter label for each), tones, and the script formats with structure hints and examples (what the test console shows).

### `POST /api/estimate`, `GET|POST /api/template`, `GET /api/places`, `GET /api/alerts`, `POST /api/mcp`, `/api/users`, `/api/keys`

Before-you-spend estimates for `write`, `speak`, `flier-read` and `flier-promo` (nothing is sent to an AI); the list of `{{placeholders}}` with today's values, and a way to render a text; user management (admins) and your own account; and saving or removing your own AI keys (write-only). Details in the docs above.

### `GET /api/clips`

Returns `{ "clips": [ClipMetadata, ...] }`, newest first. Regular users see their own clips plus the station's shared ones; admins see everything.

### `GET /api/clips/:id`

Returns the clip's audio as `audio/wav`.

## Scripts

- `npm run dev` — `netlify dev`, runs the functions locally
- `npm run build` — typecheck (`tsc --noEmit`)
- `npm test` — run the unit tests (`vitest`); no credentials required, the AI services
  and Blobs are mocked. The Chips Voice server, hub and RadioDJ agent have their own suites (see `chips-voice/README.md`)
- `npm run lint` — `eslint .`
