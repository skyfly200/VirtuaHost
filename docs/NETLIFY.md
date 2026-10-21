# Deploying on Netlify

One Netlify site does everything the web side needs: it makes the clips (the AI), shows the UI (Generate, Flier, Personas, Schedules, Library, Voice Lab, Stations and Users tabs), and signs people in.
The radio side (the Chips Voice server, the hub, the RadioDJ agent) runs on your own machines, because Netlify cannot run long-lived processes or reach a local RadioDJ.
You can ignore the radio side until you have it: the Voice Lab and Stations tabs simply show "not connected yet" until you add its address and key.

Menu names below are as Netlify usually labels them; if a screen differs, the setting names are what matter.

## Before you start

- **Everything that Netlify talks to must be on HTTPS** (`STATION_URL`, `HUB_URL`, `VOICE_URL`): put those servers behind Caddy or nginx with a certificate (`chips-voice/docs/DEPLOY-VPS.md`).
- **Sign-in protects the whole site's API.** `/api/*` refuses anyone who is not signed in (401), and answers 503 if no sign-in is configured, so the site is never open by accident. A request that is not signed in is rejected before the AI is called, so it costs nothing. The login page itself is public and holds no secrets.
- **Function time limits.** AI speech can take several seconds. Check your Netlify plan's current function time limit, and test a long `mode: "ai"` request after deploying.

## 1. Create the site

Netlify: Add new site, Import an existing project, choose GitHub and the repository (or your fork: see the last section). Leave Base directory empty. The build command (`npm run build`), the publish folder (`public`) and the functions folder come from `netlify.toml`.

## 2. Make logins

Each person gets a username and a password. The site stores only a hash of the password, in an environment variable.

1. On your computer, in a clone of the repository: `npm install`, then `npm run hash-password -- alice` and type a password (it is not shown). It prints a line like `alice:scrypt.9f2c....`
2. For several people, make one line each and join them with commas: `alice:scrypt.aaa...,bob:scrypt.bbb...`
3. Make a signing secret: `openssl rand -hex 32` (any random string of 32 or more characters).

Add these to the site's environment variables:

| Variable | Value |
|----------|-------|
| `LOGIN_USERS` | the `name:hash` lines from step 1 or 2 |
| `SESSION_SECRET` | the secret from step 3. Changing it signs everyone out |
| `SESSION_HOURS` | optional, how long a login lasts (default 12) |

`LOGIN_USERS` is only for your first admin(s). After you sign in, add everyone else in the **Users** tab (no redeploy needed; see [USERS.md](USERS.md)). Removing someone from `LOGIN_USERS` signs them out on their next request. Failed sign-ins are slowed down: after 8 wrong attempts from one address, that address is blocked for ten minutes.

`ACCESS_KEY` still works, now as an optional key for scripts and `curl` (`x-api-key: <key>`), and the login page offers "Use an access key instead" while it is set. Once everyone has a login you can delete `ACCESS_KEY` so passwords are the only way in.

## 3. Add the AI key and the other settings

| Variable | Value | Needed |
|----------|-------|--------|
| `OPENROUTER_API_KEY` | from openrouter.ai/keys. **One AI key is required: this one (recommended) or `GEMINI_API_KEY`.** With OpenRouter you choose the writing and voice models in the UI | yes (or Gemini) |
| `GEMINI_API_KEY` | from Google AI Studio; used directly (fixed models) only when there is no OpenRouter key | alternative |
| `OPENROUTER_TEXT_MODEL`, `OPENROUTER_SPEECH_MODEL` | default writing and speech models (slugs from openrouter.ai/models) | no |
| `OPENROUTER_TEXT_MODELS`, `OPENROUTER_SPEECH_MODELS` | comma lists shown in the UI; a speech entry can carry its default voice as `slug\|Voice` | no |
| `OPENROUTER_VOICE` | voice to use when the model entry has none | no |
| `OPENROUTER_ALLOW_ANY_MODEL` | `true` lets any signed-in person type any model slug (they could pick costly ones) | no |
| `PROVIDER` | `openrouter` or `gemini` to force one when both keys are set | no |
| `STATION_NAME` | e.g. `Way High Radio` (used in the DJ prompt and the examples) | no |
| `GEMINI_TTS_VOICE` | a Gemini voice name (default `Kore`) | no |
| `SECRETS_KEY` | 32+ random characters that encrypt AI keys people and stations save in the app (`openssl rand -hex 32`). Falls back to `SESSION_SECRET`, but then changing that makes saved keys unreadable. Set it once and keep it | recommended |
| `ELEVENLABS_API_KEY`, `ELEVENLABS_VOICES` | ElevenLabs for voice clones (the site's key; people and stations can save their own). `ELEVENLABS_VOICES` is optional names, `Rocky=<voice id>,Britta=<voice id>` | no |
| `QUOTA_DAILY_AI`, `QUOTA_MONTHLY_AI`, `QUOTA_MAX_CLIPS`, `QUOTA_MAX_SCHEDULES` | default limits for regular users with none of their own (empty = no limit; admins are never limited) | no |
| `LOG_LEVEL` | `debug`, `info` (default), `warn`, `error` or `silent`: how much the functions write to Netlify's function logs (one JSON line per event) | no |
| `OPENROUTER_BASE_URL` | point at another OpenAI-compatible router instead of OpenRouter | no |
| `STATION_URL` | `https://your-chips-voice-server`, to hand every generated clip to the station | later |
| `STATION_INGEST_TOKEN` | the server's `INGEST_TOKEN` | with `STATION_URL` |
| `STATION_AUTOPLAY` | `true` puts every generated clip on air | no |
| `STATION_PREEMPT` | `true` lets it cut in over a live DJ | no |
| `STATION_FX` | e.g. `underground` or `hull` (applied by the station) | no |

Mark `LOGIN_USERS`, `SESSION_SECRET`, `SECRETS_KEY`, `ACCESS_KEY`, `OPENROUTER_API_KEY`, `GEMINI_API_KEY`, `ELEVENLABS_API_KEY` and `STATION_INGEST_TOKEN` as secret values if Netlify offers that option. Netlify Blobs (where clips are stored) needs no setting: it is provided by the Netlify runtime.

## 4. Deploy and check

1. Deploy. Open the site and sign in. The Generate tab should load with the model lists.
2. If a clip fails with "GEMINI_API_KEY is not set" or "No AI provider is configured", no AI key reached the function: add `OPENROUTER_API_KEY` (or `GEMINI_API_KEY`), make sure its scope includes Functions, and trigger a new deploy (variables apply on the next deploy).
3. Make a clip and play it. From a terminal (needs `ACCESS_KEY`): `curl -X POST https://<site>/api/generate -H "x-api-key: $ACCESS_KEY" -H 'content-type: application/json' -d '{"mode":"say","text":"Hello"}'`. The same call without the header should return 401.
4. Models: the lists come from `OPENROUTER_TEXT_MODELS` / `OPENROUTER_SPEECH_MODELS` (defaults are built in; speech models OpenRouter itself lists, with their voices, are added to the dropdown automatically). The speech request format could not be tested against OpenRouter itself, so if a model or voice is rejected the UI shows OpenRouter's own message: adjust the model, voice or list and try again.
5. With `STATION_URL` set, the response includes a `handoff` field. A station error is reported there but the request still succeeds (the clip is stored).
6. Scripts sent here may contain `[sfx:name]` tags; they are stripped (these voices do not mix effects). To get sound effects mixed in, speak through the Chips Voice server (Voice Lab).

## 5. Later: connect the radio side

Voice Lab, Personas, Flier, Schedules and Library need no extra server. To run several stations from one screen, run the hub (see `docs/HUB.md`), add these and redeploy; the Stations tab turns on by itself:

| Variable | Value | Turns on |
|----------|-------|----------|
| `VOICE_URL`, `VOICE_KEY` | a Chips Voice server's https address and its `API_KEY` | nothing in the UI any more: **Voice Lab runs on the site itself**. Only the hub (broadcast a clip by id) can still use it. |
| `HUB_URL`, `HUB_KEY` | the hub's https address and its `HUB_KEY` | Stations |

Who calls whom:

| Who calls | Needs to reach | How it is protected |
|-----------|----------------|---------------------|
| You (browser) | this site | username and password |
| This site's functions | Chips Voice `/ingest` (the hand-off) | `INGEST_TOKEN` (audio only), HTTPS |
| This site's functions | the voice server and the hub (the tabs) | server keys kept in the site's variables, HTTPS |
| The hub | each station / agent | per-station key kept in the hub; the RadioDJ agent behind a VPN or HTTPS proxy |

Uploads through the site (a broadcast file, a sound effect) are capped at about 5 MB by Netlify's function limits.

## If you cannot connect the GitHub repository

Netlify needs admin rights on a repository (or an owner's approval of its GitHub app) to link it. If you are only a collaborator: fork the repository to your own account and connect the fork (pull updates with GitHub's Sync fork), or deploy from your computer with the Netlify CLI (`netlify link`, then `netlify deploy --build --prod`). CLI deploys are manual.

## Vercel instead?

VirtuaHost is written for Netlify Functions and Netlify Blobs, so it stays on Netlify.

## Updating

Push to the connected branch and Netlify redeploys. Environment variable changes apply on the next deploy.
