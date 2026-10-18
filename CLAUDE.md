# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## What this is

An AI DJ audio-generation pipeline for an online radio station, deployed as
Netlify Functions with Netlify Blobs for storage. Google Gemini both writes
DJ script lines and synthesizes them to speech. This is deliberately just
the generation/storage core — a webhook (e.g. WhatsApp via Twilio),
scheduling are future work that will call `POST /api/generate`. Getting clips onto a live
Icecast/Liquidsoap stream is handled by the separate Chips Voice server in `chips-voice/`:
`lib/handoff.ts` posts each generated clip to its `/ingest` endpoint (see `docs/INTEGRATION.md`).
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
index.html                 static test console (no build step) for /api/generate and /api/clips
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
- **One Gemini client, two models.** `lib/gemini.ts` lazily constructs a
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
- **One shared access key.** `lib/auth.ts#checkAuth` guards `/api/generate` and `/api/clips[/:id]`
  (called first in each handler, so adapters cannot skip it). The key is the `ACCESS_KEY` env var (16+ characters),
  sent as `x-api-key` or `Authorization: Bearer`. With no key set the API answers 503 rather than being open;
  `AUTH_DISABLED=true` is the explicit local-dev opt-out. `index.html` itself is public and holds no secrets:
  it asks for the key, keeps it in `sessionStorage`, and plays audio via fetch (an `<audio src>` cannot send headers).
  There are no per-user accounts, and the eventual WhatsApp allowlist is still scoped for the command layer.
- **Station hand-off is optional and never fails a generation.** When `STATION_URL` and
  `STATION_INGEST_TOKEN` are set, `handleGenerate` posts the WAV to the station after
  `saveClip`. A station error is reported in the response's `handoff` field but the request
  still returns `201`, because the clip is already generated and stored. Requests can set
  `play`, `preempt` or `handoff: false`.
- **Sound-effect tags.** `[sfx:name]` in a script is mixed in by the Chips Voice server; `handleGenerate`
  strips them before Gemini speaks (`sfxTagsRemoved`). Setup for script/API/AutoDJ/chat/MCP: `docs/SETUP.md`.
- **Several stations.** `chips-voice/hub/` (zero-dependency Node) controls stations that speak the agent API (a Chips Voice server, or `chips-voice/agent-radiodj/` for RadioDJ);
  `chips-voice/web/` holds two static apps (Voice Lab, Control Panel). Tests: `node --test test/*.test.js` inside `hub/` and `agent-radiodj/`. See `docs/HUB.md`.
