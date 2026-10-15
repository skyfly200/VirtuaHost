# Chips Voice inside VirtuaHost

This folder is a self-contained copy of the Chips Voice project, kept here for now so the two can be
integrated later. It is independent of the VirtuaHost code in the repository root: its own
`package.json` files, its own tests, and nothing in the root imports from it.

- **Run it:** see [README.md](README.md). The backend is `googleTextToSpeech1/` (Express), the web UI is
  `googleTextToSpeech1/tts-ui/` (Vue). Backend tests: `cd googleTextToSpeech1 && npm test` (Node's built-in test runner).
- **Root tooling skips this folder:** `eslint.config.js` ignores `chips-voice/**` and `vitest.config.ts` excludes it,
  so `npm run lint` and `npm test` at the root only cover VirtuaHost. `tsc` already only includes `lib`, `netlify` and `test`.
- **`netlify.toml` here is not active.** Netlify reads only the root file. It records the build settings for hosting the
  Chips Voice UI as its own Netlify site.

## Where the two overlap (for the integration)

| VirtuaHost | Chips Voice |
|------------|-------------|
| Gemini writes DJ lines and Gemini TTS speaks them (`lib/gemini.ts`) | Swappable speech providers (`lib/providers/tts`) and AI providers (`lib/providers/llm`); no Gemini adapter yet |
| Clips stored in Netlify Blobs (`lib/store.ts`) | Clip library in a JSON file plus audio files on the VPS (`lib/clips.js`), reuse by content hash |
| `POST /api/generate`, `GET /api/clips`, no auth | Login, signed audio links, schedules, cloud sharing, Icecast/Liquidsoap playback |
| Injecting clips into the stream listed as future work | Already done: Liquidsoap queue, live-DJ preemption (`app.js`, `radio.liq`) |

Natural first steps: a `gemini` adapter in `lib/providers/tts` and `llm`, and having Chips Voice call
`POST /api/generate` (or share one clip store).
