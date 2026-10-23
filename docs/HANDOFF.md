# Handoff: where everything stands, and what is not written down anywhere else

Written so a new session (or a new person) can pick this up cold. Read `docs/ROADMAP.md` for what is planned, `docs/HUB.md` sections 10 and 11 for the just-in-time system, `docs/SCRIPTS.md` for scripts and the Studio, and `docs/FOR-SYLVIA.md` (top note) for what the playout side owes us. This file adds the rest: decisions, setup, how to work in the repo, and every known gap that is not on the roadmap.

## Where the code is

- Repo: `skyfly200/VirtuaHost` (GitHub shows a redirect to that capitalisation). `main` has everything through the Studio, scripts, the grouped menu and the roadmap (PRs #12 and #13). A later branch adds the dropdown navbar, quieter controls (popover menus, a one-icon download), cleaner Personas, collapsible Stations editor, the logo concepts and "VirtuaHost" as the app name, plus this file; check `git log origin/main` for whether it has merged.
- `publicdata/chipsvoice` (the checkout this work started in) is an unrelated Google text-to-speech app and was never changed. `syndicationintegration/VirtuaHost` is a second repo with the same name; it was not touched. Confirm which one Netlify deploys.
- Tests: `npm test` (vitest, about 384), `npm run build` (typecheck), `npm run lint`, `node --test test/*.test.js` inside `chips-voice/hub/` (61) and `chips-voice/agent-radiodj/` (56), `npm run test:daemon` (18). All use fakes. There are **no browser tests in the repo**: the UI was checked by hand with throwaway Playwright scripts (not committed) against stubbed APIs.
- A local clone made by an agent had a fetch setting that only tracked `main`; if `git branch -vv` shows no upstream for a pushed branch, run `git config remote.origin.fetch '+refs/heads/*:refs/remotes/origin/*'`.

## Decisions already made (so they are not re-litigated)

- Generated clips **preempt** the planned (evergreen) clip; the planned clip plays only when the swap does not happen. Never touch the immediately-next queue item; minimum two ahead.
- Shadow mode is the default everywhere (hub per station, agent). Nothing goes live until Rocky approves the shadow review and a live single-item test. Approval of each line is on by default.
- `broadcastTz` (the station, America/Denver) and `machineTz` (the PC, America/Chicago) are separate settings and are never mixed.
- Conversations: at most 4 speakers. Scripts are saved and reusable in the Studio, schedules and dynamic slots.
- Relay shows preempt all other automated programming, including automatically brought-in requests. Requests are shared with the audience. Google Calendar: one-offs four weeks ahead, recurring shows as open-ended recurring events. A real database and a chat platform come later and are not needed yet.
- The pull model (the PC calls the hub) is the design for NAT; the agent defaults to `127.0.0.1`.
- "VirtuaHost" is the app name (no "DJ"). Five logo concepts are in `public/brand/` (open `brand/index.html`); the header uses voice-bars (`public/shared/brand.js`).

## Setup checklist (nothing here is done by the code)

Site (Netlify): `ACCESS_KEY` or `SESSION_SECRET` + `LOGIN_USERS`; `OPENROUTER_API_KEY` (or `GEMINI_API_KEY`); `SECRETS_KEY`; `HUB_URL` + `HUB_KEY` to turn on the Dynamic and Control tabs; `SERVICE_KEYS="glr-hub@rocky:generate+stations.read+personas.read+scripts.read:<key>"`; Rocky saves his ElevenLabs key in the Account card (it is used by the hub's calls through the `@rocky` run-as). Create the station profile with its city (for weather) and `broadcastTz`.
Hub: `HUB_KEY`, optionally `HUB_READ_KEY`, `SITE_URL` + `SITE_KEY` (the service key above), `HUB_DATA` (it also keeps `audio/` next to the data file). Create a station with `connection: pull`, set `siteStationId`, copy the pull key (shown once).
Agent (the PC): `chips-voice/agent-radiodj/.env.example`; at least `AGENT_CONTROL_KEY`, `BROADCAST_TZ`, `MACHINE_TZ`, `HUB_URL`, `HUB_STATION_ID`, `HUB_STATION_KEY`, `SCHEDULE_DIR`, `ICECAST_URL`, and Sylvia's scripts (`INSERT_EXEC`, `LOAD_EXEC`). Keep `AGENT_SHADOW=true` until the live test.

## Known gaps that are NOT on the roadmap (decide or add them)

Correctness and safety
- **Legal station IDs.** A generated station-ID slot replaces the planned clip. Nothing checks that the generated line says the call sign and city the law requires. Add a per-station required-phrase check for `station-id` slots (the validator already has a blocklist; this is a "must contain" rule), and make sure planned clips keep the legal ID.
- **Sound effects: what is still missing.** `[sfx:]` tags are now mixed on the server too (`docs/SOUND-EFFECTS.md`), but only for voices that return WAV (Gemini, Google speech models on OpenRouter), only WAV library files, and `[music:]` beds are browser-only. ElevenLabs and most OpenRouter voices still lose their effects (no MP3 decoder or ffmpeg on Netlify): either mix on the Chips Voice server, or say so in the UI. Not tested against live providers. Hub just-in-time slots do not ask the writer for effects, and a fixed script with tags going through the hub's validator is untested. A Studio effect (`fx`) is a browser preview only. Uploads (background, intro, outro, sfx) are untested against real Blobs, real MP3/M4A decoding in browsers other than Chromium, and uploads are station-wide with no per-person privacy; the server cannot mix an MP3 or other non-WAV library file, so cloud-folder MP3s work in the Studio but are skipped (and reported) in schedules and API calls. Backgrounds, intros and outros are not available for saved-script and saved-clip schedules.
- **Scripts and the MCP endpoint.** `lib/mcp-tools.ts` has no tools for scripts, so an AI agent cannot list, draft or schedule them.
- **Quotas.** A conversation costs one AI-request charge however many lines it speaks. Per-line charging or a per-script limit is undecided.
- **Mixed audio formats** in a conversation (a WAV voice with an MP3 voice) are refused server-side; only the browser Studio can join them. MP3 joins have no gap.
- **Validator limits.** The invented-facts check is a heuristic (quoted titles, "by Name", numbers, web addresses, phone numbers). Per-persona language policy exists in the hub settings API (`personaPolicies`) but has no UI. Text-model spend is not metered (only speech characters are capped).
- **Kill switches do not propagate.** The hub kill stops handing out clips; it does not touch the agent's own kill switch. The agent's kill can only be cleared on the PC by design. There is no "stop everything everywhere" button.

Operations
- No monitoring or alerting that the hub, the agent heartbeat or the stream is down (the UI shows it only when someone looks). The watchdog is Sylvia's. Needs an owner and a notification channel.
- The agent has no Windows service wrapper or auto-start, no log rotation for `audit.jsonl`, no backup of `state.json`. Windows paths and `execFile` quoting have not been run on Windows.
- The hub is one process with one JSON file and in-memory provider-health state; no backups, no high availability. Audio retention is 7 days after last use.
- Secrets: a rotation procedure for `HUB_KEY`, `SERVICE_KEYS`, pull keys and `SECRETS_KEY` is not written. The hub read key cannot be rotated without a restart.
- Netlify Blobs strong consistency, the scheduled-function time budget (about 30 s; conversations are spoken three lines at a time) and real speech/LLM provider behaviour are unverified.

Product
- **Public pieces need abuse protection.** A public request page, embed or calendar feed means unauthenticated endpoints: rate limits, CAPTCHA or similar, blocklists and moderation, and a privacy rule for requester names and contacts. Not designed.
- **DJ accounts for relay shows** (who may start a relay, how a DJ authenticates to the relay source) are undecided.
- **Music licensing and AI disclosure.** Reporting obligations for what airs, and any disclosure that voices are synthetic (and the record of Rocky's permission to use his voice), are not documented anywhere.
- **Listener-facing site and player**, now-playing widget, analytics, and a "what is on now and next" page are not planned.
- **Studio gaps:** it is checked only against stubs, not the real API; there is no list of recent clips in it (use the Library tab); effect and tone choices are not remembered between visits; a script cannot be shared between users except by being admin-owned (shared) records.
- **Dynamic tab gaps:** the slot form's script picker was never exercised in a browser; there is no calendar view of slots; approvals have no notification.
- **Front-end tests** do not exist (see above).

## Work done by Haiku subagents, and how it was checked

Tests for scripts (`test/lib/scripts*.test.ts`, `audio-join`, `script-draft`, `test/functions/scripts.test.ts`), the grouped menu and phone layout (`public/app.js`, `app.css`, `kit.css`), the Schedules UI (`public/schedules/schedules.js`), and the cast and line editors (`public/shared/casteditor.js`, `lineeditor.js`). Each was read, run and re-tested here; two real bugs came out of that review (bold speaker labels, name matching across sentences) and were fixed with tests.
