# Deploying on Netlify

Two Netlify sites from this one repository, plus your own server for the parts Netlify cannot run.

| Site | What it is | Base directory | Publish directory | Build command |
|------|-----------|----------------|-------------------|---------------|
| **A. VirtuaHost** | Gemini DJ generator: functions `/api/generate`, `/api/clips`, test console, Netlify Blobs | (repository root) | (leave empty; the root `index.html` is served) | `npm run build` (already in `netlify.toml`) |
| **B. Web apps** | Voice Lab and Control Panel (static) | `chips-voice/web` | `.` | none |

Your server (VPS with Icecast): the Chips Voice server, the hub, and the RadioDJ agent on Windows. Netlify cannot run these (long-running processes, timers, files, a telnet link to Liquidsoap).
Menu names below are as Netlify usually labels them; if a screen differs, the setting names are what matter.

## Before you start

- **Both servers must be on HTTPS.** Sites on Netlify are HTTPS, and browsers refuse to let them call `http://` addresses. Put the Chips Voice server and the hub behind Caddy or nginx with a certificate (`chips-voice/docs/DEPLOY-VPS.md`). The same applies to `STATION_URL` for site A.
- **Site A has no login.** `/api/generate` and `/api/clips` are open to anyone who finds the URL, and each request spends your Gemini quota. Before sharing the address: keep it unpublished, add Netlify's site password protection if your plan includes it, or add auth to the functions first. The web apps (site B) are safe to publish: they hold no secrets and ask for a key on first use.
- **Function time limits.** Gemini speech can take several seconds. Check your Netlify plan's current function time limit, and test a long `mode: "ai"` request after deploying.

## Site A: VirtuaHost

1. Netlify: Add new site, Import an existing project, choose GitHub and the repository. Leave Base and Publish directories empty. The build command and functions folder come from `netlify.toml`.
2. Site configuration, Environment variables. Add:

| Variable | Value | Needed |
|----------|-------|--------|
| `GEMINI_API_KEY` | from Google AI Studio | yes |
| `STATION_NAME` | e.g. `Way High Radio` (used in the DJ prompt) | no |
| `GEMINI_TTS_VOICE` | a Gemini voice name (default `Kore`) | no |
| `STATION_URL` | `https://your-chips-voice-server` | to hand clips to the station |
| `STATION_INGEST_TOKEN` | the server's `INGEST_TOKEN` | with `STATION_URL` |
| `STATION_AUTOPLAY` | `true` puts every generated clip on air | no |
| `STATION_PREEMPT` | `true` lets it cut in over a live DJ | no |
| `STATION_FX` | e.g. `underground` or `hull` (applied by the station) | no |

   Netlify Blobs needs no setting: it is provided by the Netlify runtime.
3. Deploy. Check: open the site, use the test console to make a clip, then `curl -X POST https://<site>/api/generate -H 'content-type: application/json' -d '{"mode":"say","text":"Hello"}'`.
4. Hand-off check: with `STATION_URL` set, the response includes a `handoff` field. A station error is reported there but the request still succeeds (the clip is stored).
5. Scripts sent to this site may contain `[sfx:name]` tags; it strips them (Gemini voices do not mix effects). To get sound effects mixed in, speak through the Chips Voice server.

## Site B: Voice Lab and Control Panel

1. Add new site, same repository. Base directory `chips-voice/web`, Publish directory `.`, no build command. (`chips-voice/web/netlify.toml` documents this and adds basic security headers.)
2. Open `https://<site-b>/lab/` and `/panel/`. First screen: the server address and a key.
   - Voice Lab connects to the **Chips Voice server** (its `API_KEY`, or the admin username and password).
   - Control Panel connects to the **hub** (its `HUB_KEY`).
3. On your servers, allow the site's address:
   - Chips Voice server: `CORS_ORIGIN=https://<site-b>` (comma-separated for several).
   - Hub: `HUB_CORS_ORIGIN=https://<site-b>`.
   Without this the browser shows "Cannot reach ... check CORS".
4. Keep sites A and B separate: they have different contents and secrets. Do not put `GEMINI_API_KEY` or any server key in site B.

## Your server

Set up the Chips Voice server per `docs/SETUP.md` (use case C), then the hub and any RadioDJ agents per `docs/HUB.md`. Summary of what must be reachable:

| Who calls | Needs to reach | How it is protected |
|-----------|----------------|---------------------|
| Site A functions | Chips Voice `/ingest` | `INGEST_TOKEN` (audio only), HTTPS |
| Voice Lab (browser) | Chips Voice server | API key or login token, HTTPS, CORS |
| Control Panel (browser) | Hub | hub key exchanged for a 12 h token, HTTPS, CORS |
| Hub | Each station / agent | per-station key, kept in the hub; RadioDJ agent behind a VPN or HTTPS proxy |

## Vercel instead?

The static web apps (site B) work the same on Vercel: Root Directory `chips-voice/web`, Framework "Other", no build command. VirtuaHost itself (site A) is written for Netlify Functions and Blobs, so it stays on Netlify.

## Updating

Push to the connected branch and Netlify redeploys. Environment variable changes apply on the next deploy.
