# VirtuaHost — AI DJ audio pipeline

Generates and stores AI DJ audio clips for an online radio station, built on
Netlify Functions (compute) and Netlify Blobs (storage), with Google Gemini
doing both the script writing and the text-to-speech.

This is the core pipeline. Triggering it from WhatsApp and scheduling
announcements are not built yet — they're expected to call `POST /api/generate`.
Getting clips onto a live Icecast/Liquidsoap stream is done by the Chips Voice
server in `chips-voice/`: set `STATION_URL` and `STATION_INGEST_TOKEN` and each
generated clip is handed over automatically. See [docs/INTEGRATION.md](docs/INTEGRATION.md).

## Setup

1. `npm install`
2. `netlify link` (or `netlify init`) to connect this directory to a Netlify
   site — this is what makes Netlify Blobs available locally.
3. Copy `.env.example` to `.env` and set `GEMINI_API_KEY` (from
   [Google AI Studio](https://aistudio.google.com/)). `STATION_NAME` and
   `GEMINI_TTS_VOICE` are optional.
4. `netlify dev`

## Test console

`index.html` is a small static page served alongside the functions — open
the site's root URL (e.g. `https://your-site.netlify.app/` or
`http://localhost:8888/` under `netlify dev`) to generate clips and play
back everything in `/api/clips` from a browser, without needing `curl`.

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
to Gemini first to write a DJ line, then synthesizes that. Response:

```json
{ "id": "...", "scriptText": "...", "audioUrl": "/api/clips/..." }
```

### `GET /api/clips`

Returns `{ "clips": [ClipMetadata, ...] }`, newest first.

### `GET /api/clips/:id`

Returns the clip's audio as `audio/wav`.

## Scripts

- `npm run dev` — `netlify dev`, runs the functions locally
- `npm run build` — typecheck (`tsc --noEmit`)
- `npm test` — run the unit tests (`vitest`); no credentials required, Gemini
  and Blobs are mocked
- `npm run lint` — `eslint .`
