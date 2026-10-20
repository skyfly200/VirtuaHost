# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## What this is

An AI DJ audio-generation pipeline for an online radio station, deployed as
Netlify Functions with Netlify Blobs for storage. Google Gemini both writes
DJ script lines and synthesizes them to speech. This is deliberately just
the generation/storage core — a webhook (e.g. WhatsApp via Twilio),
scheduling are future work that will call `POST /api/generate`. Getting clips onto a live
Icecast/Liquidsoap stream is handled by the separate Chips Voice server in `chips-voice/`:
`lib/handoff.ts` posts each generated clip to its `/ingest` endpoint (or, with `STATION_MODE=queue`, the station daemon collects it) (see `docs/INTEGRATION.md`).
`krap-station/` holds the KRAP ElevenLabs voice scripts and RadioDJ helper (Sylvia's; leave them as they are).

**New to this repo, especially Sylvia: read `docs/FOR-SYLVIA.md` first.** It maps each KRAP script to the server-side feature
that replicates it (virtual host, ElevenLabs dialogue, the "underground" audio treatment, spot import) and lists what is verified.

## Commands

- `npm install` — install dependencies
- `netlify link` — connect this directory to a Netlify site (required once,
  locally, for `netlify dev` to provide Netlify Blobs)
- `npm run dev` — `netlify dev`, runs the functions locally against
  `/api/*`; needs `GEMINI_API_KEY` set (see `.env.example`)
- `npm run build` — typecheck only (`tsc --noEmit`); Netlify bundles
  functions itself at deploy time via esbuild, there is no separate build
  output
- `npm test` — `vitest run`; Gemini and Netlify Blobs are mocked, so this
  needs no credentials and no `netlify link`
  - single test file: `npx vitest run test/lib/wav.test.ts`
  - single test by name: `npx vitest run -t "rejects invalid JSON bodies"`
- `npm run lint` — `eslint .` (flat config in `eslint.config.js`)

## Architecture

```
public/                    the web UI (static, no build step): sign-in, Generate, Voice Lab and Stations tabs
netlify/functions/*.mts   thin Netlify Function adapters (routing/config only)
        |
lib/handlers/*.ts         request handling logic, framework-agnostic (Request -> Response)
        |
lib/gemini.ts             Gemini client: writeDjLine() (text model), synthesizeSpeech() (TTS model)
lib/wav.ts                 wraps Gemini's raw PCM in a WAV header
lib/handoff.ts             optional push of each generated clip to the station server (Chips Voice /ingest)
lib/store.ts               Netlify Blobs wrapper: saveClip/getClip/listClips
```

- **Functions are thin on purpose.** `netlify/functions/generate.mts` and
  `clips.mts` only wire up routing (`config.path`) and Netlify's request
  context; all real logic lives in `lib/handlers/*.ts` as plain functions
  taking a `Request` and returning a `Response`. This is what makes the
  handlers unit-testable with `vitest` directly, without spinning up
  `netlify dev` — see `test/functions/*.test.ts` for the pattern (mock
  `lib/gemini.js` and `lib/store.js`, call the handler function directly).
- **Provider choice (OpenRouter or Gemini).** `lib/ai.ts` picks the provider: OpenRouter when `OPENROUTER_API_KEY` is set
  (`lib/openrouter.ts`: chat completions for writing, `/audio/speech` for voice; writing and speech models are chosen per
  request from `OPENROUTER_TEXT_MODELS` / `OPENROUTER_SPEECH_MODELS`, or any slug with `OPENROUTER_ALLOW_ANY_MODEL=true`),
  else Gemini directly via `lib/gemini.ts`. `PROVIDER` forces one; with neither key the API answers 503 with instructions.
  `lib/formats.ts` holds the tones and script formats (structure hints and examples) that shape AI-written lines and that
  `GET /api/options` serves to the test console. Google speech models on OpenRouter return raw PCM (wrapped to WAV);
  others return MP3. The speech request shape is NOT verified against the live service (see the header of `lib/openrouter.ts`).
- **Gemini client (direct provider), two models.** `lib/gemini.ts` lazily constructs a
  single `GoogleGenAI` client from `GEMINI_API_KEY` and uses it for both
  `writeDjLine()` (a `gemini-3.6-flash`-class text model, for `mode: "ai"`
  requests) and `synthesizeSpeech()` (a Gemini TTS model with
  `responseModalities: ["AUDIO"]`). `mode: "say"` requests skip
  `writeDjLine()` entirely and synthesize the given text verbatim.
- **Gemini TTS returns headerless PCM** (16-bit, mono, 24kHz by default) —
  `lib/wav.ts#pcmToWav()` wraps it in a minimal RIFF/WAVE header so stored
  clips are directly playable files, not raw samples.
- **Storage has no separate database.** `lib/store.ts` keeps a single
  Netlify Blobs store (`dj-clips`) where each clip's audio bytes are keyed
  `clips/{id}.wav`, with its `ClipMetadata` (input text/prompt, generated
  script, voice, timestamps, etc.) attached via Blobs' per-blob metadata
  feature rather than a second store or JSON file. `listClips()` lists blob
  keys under that prefix and fetches each one's metadata individually — fine
  at single-station scale, would need a real index if clip volume grew a
  lot.
- **Error handling convention**: handlers return `502` (not `500`) when a
  Gemini call itself fails (script generation or speech synthesis), and
  `400` for malformed/missing request fields — this distinguishes "your
  request was bad" from "the upstream model call failed" for callers.
- **Sign-in.** `lib/auth.ts#checkAuth` guards every `/api/*` function (called first in each handler, so adapters cannot skip it).
  Two ways in, either is enough: a login session token (`Authorization: Bearer`, from `POST /api/login`; users in `LOGIN_USERS`
  as `name:scrypt.<salt>.<hash>`, tokens signed with `SESSION_SECRET`, stateless HMAC in `lib/session.ts`, wrong passwords
  throttled through Netlify Blobs in `lib/throttle.ts`) or the optional machine key `ACCESS_KEY` (`x-api-key` or Bearer). With
  neither configured the API answers 503 rather than being open; `AUTH_DISABLED=true` is the explicit local-dev opt-out.
  `npm run hash-password -- <user>` makes an entry. There are no roles: every login can do everything.
- **The UI and its proxy.** `public/index.html` is one page (`app.js`): login, then tabs. `generate/`, `lab/` and `panel/` are
  ES modules that draw into a tab, using clients from `shared/kit.js`. Voice Lab and Stations talk to this site's
  `/api/voice/*` and `/api/hub/*`, which `lib/handlers/proxy.ts` forwards (after the auth check, with `VOICE_KEY` / `HUB_KEY`,
  https only, same-origin paths, 5 MB body cap) to the Chips Voice server and the hub in `chips-voice/`. The tabs are switched off
  (a "not connected" card) until `VOICE_URL`+`VOICE_KEY` / `HUB_URL`+`HUB_KEY` are set; `GET /api/options` reports `features`.
  The page itself is public and holds no secrets; the session credential lives in `sessionStorage`.
- **Write first, then speak; preview before saving.** `mode: "ai"` with `textOnly: true` returns just the written line; the UI shows it for
  editing, then speaks it as plain "say" text with `preview: true` (audio returned, nothing stored). `[sfx:name]` and `[music:name vol=0.2]`
  tags are mixed in the browser (`public/generate/mixer.js`: synthesised built-in effects, library files, a music bed), and the mixed WAV is saved
  with `POST /api/clips` (raw audio body, details in the `x-clip-meta` header). Per-model tone and tag support is in `lib/cues.ts` (`docs/CUES.md`).
- **Personas** (`lib/personas.ts`, `lib/persona-store.ts`, `/api/personas`, Personas tab): character brief, tone, voice, speech model; CHIP is built in.
  `POST /api/personas/generate` drafts one with the writing model; `persona` on `/api/generate` shapes the AI-written line and sets default delivery.
- **Sound library** (`lib/library/`, `/api/library`, Library tab, `docs/LIBRARY.md`): sfx and music folders read from OwnCloud (WebDAV) and/or Google
  Drive (service account), read-only. Files are only fetched by name from a fresh listing, never by a client-supplied path. The premix script reads it too (with `SITE_URL`/`ACCESS_KEY`).
- **Premix** (`scripts/premix.mjs`, `.github/workflows/premix.yml`, `premix/`): scripts with `[sfx:]` tags mixed with ffmpeg in GitHub Actions.
- **Station queue and daemon** (`lib/queue-store.ts`, `lib/station-send.ts`, `/api/queue`, `/api/station/*`, `station-daemon/`): with `STATION_MODE=queue`
  every saved clip is queued in Blobs; the zero-dependency daemon on the streaming server polls with `STATION_KEY`, downloads, applies the Chips Voice fx
  preset (ffmpeg), pushes to Liquidsoap's `announce`/`announce_live` queue and acks. Outbound-only from the station. Leases expire after 90 s (3 attempts).
  Tests: `npm run test:daemon`. `scripts/premix.mjs --publish` can save premixed files (and queue them with `# send: air|library`).
- **Station hand-off is optional and never fails a generation.** When `STATION_URL` and
  `STATION_INGEST_TOKEN` are set, `handleGenerate` posts the WAV to the station after
  `saveClip`. A station error is reported in the response's `handoff` field but the request
  still returns `201`, because the clip is already generated and stored. Requests can set
  `play`, `preempt` or `handoff: false`.
- **Sound-effect tags.** `[sfx:name]` in a script is mixed in by the Chips Voice server; `handleGenerate`
  strips them before Gemini speaks (`sfxTagsRemoved`). Setup for script/API/AutoDJ/chat/MCP: `docs/SETUP.md`.
- **Several stations.** `chips-voice/hub/` (zero-dependency Node) controls stations that speak the agent API (a Chips Voice server, or `chips-voice/agent-radiodj/` for RadioDJ);
  Their UI is the Voice Lab and Stations tabs in `public/` (see above). Tests: `node --test test/*.test.js` inside `hub/` and `agent-radiodj/`. See `docs/HUB.md`.
