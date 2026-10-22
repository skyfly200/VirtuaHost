# Several stations: the hub, the agents, and the Studio and Stations tabs of the site

```
 Browser ──sign in──► the site (Netlify: UI + /api)
                          │  /api/voice/*  (VOICE_URL + VOICE_KEY)        /api/hub/*  (HUB_URL + HUB_KEY)
                          ▼                                                    ▼
              Chips Voice server (voices, personas, clips)                    HUB ── one API per station
                                                              ┌────────────────┼───────────────────┐
                                                              ▼                ▼                   ▼
                                                     Chips Voice server  Chips Voice server  RadioDJ agent ──► RadioDJ (Windows)
                                                     + Liquidsoap/Icecast + Liquidsoap/Icecast
```

- **Station agent**: anything that answers the small HTTP API below. A Chips Voice server in front of Liquidsoap already does. The
  **RadioDJ agent** (`chips-voice/agent-radiodj/`) does it for RadioDJ on Windows.
- **Hub** (`chips-voice/hub/`): keeps the list of stations, polls them, and does what needs more than one: broadcasts that start together,
  playlists pushed to several stations, host settings copied between them. No dependencies; Node 18+.
- **The site's UI** (`public/`): one page with tabs for **Generate**, **Personas**, **Flier**, **Promos**, **Schedules**, **Library**, **Studio**, **Stations** and **Users** (all on the site itself), and **Control**, which needs the hub (`HUB_URL`, `HUB_KEY`) and is admin-only.
  Control stays switched off, with a short "what to set" card, until the site is connected to the hub. You sign in once, to the site; the site talks to the
  hub for you, so its key never reaches the browser.

**Where does what run?** The hub is just a small coordinator. It does not play audio and it does not run RadioDJ. Put it anywhere that can reach your stations and is
reachable over HTTPS by the site: usually on the same VPS as Icecast. RadioDJ and the other Windows software stay on their Windows machine, with a small **RadioDJ agent**
beside them that the hub talks to (section 3).

## 1. The agent API (the contract)

Every request carries `x-api-key: <station key>`. A station may support only part of it; `GET /agent/info` says which parts, and the hub never
calls what is not supported (it answers "does not support skip" itself).

| Call | Purpose |
|------|---------|
| `GET /agent/info` | `{ kind, name, capabilities: { skip, volume, playlists, library, definePlaylist, clip, host } }` |
| `GET /music/now` | `{ title, listeners?, live? }` |
| `POST /music/skip`, `POST /music/volume {volume 0-1}` | controls |
| `GET /music/playlists`, `POST /music/playlist {name}` | playlists the station can switch to (`list:<name>` = a saved hub playlist) |
| `GET /music/library` | `{ tracks: [{ path, size }] }` the files this station has |
| `PUT /music/playlists/:name {items:[path]}` | save a playlist from the tracks this station has; reports the rest as `missing` |
| `POST /ingest?play=0&title=` (audio body), then `POST /clips/:id/play` | put a clip on the station, then start it |
| `GET /host`, `PUT /host` | virtual host settings (Chips Voice servers only) |

## 2. Run the hub

```
cd chips-voice/hub
HUB_KEY=$(openssl rand -hex 24)  HUB_PORT=3200  VOICE_URL=https://voice.example.com  VOICE_KEY=<voice server API_KEY>  node server.js
```

| Env | Meaning |
|-----|---------|
| `HUB_KEY` | required, 12+ characters. The site's `HUB_KEY` setting must match it |
| `HUB_PORT`, `HUB_HOST` | default 3200, 0.0.0.0 |
| `HUB_DATA` | JSON file for stations, playlists and timed broadcasts (default `hub/data/hub.json`, mode 600 because it holds station keys) |
| `VOICE_URL`, `VOICE_KEY` | a Chips Voice server, only needed to broadcast a clip by id (the hub asks it for a signed link; set its `STREAM_SECRET`) |
| `ALERTS_CONTACT`, `ALERTS_POLL_SECONDS` | an email or URL for the National Weather Service User-Agent (set it), and how often to poll (default 120; 0 turns alerts off): [ALERTS.md](ALERTS.md) |
| `HUB_CORS_ORIGIN` | only if a browser calls the hub directly (the site's UI goes through its own `/api/hub` proxy, so this is normally not needed) |

Put it behind HTTPS (Caddy or nginx, as in `chips-voice/docs/DEPLOY-VPS.md`). Add stations in the Stations tab or `POST /stations {name,url,key,site}`.
Station keys stay in the hub; they are never sent to the browser.

## 3. Add each kind of station

**Chips Voice server with Liquidsoap (Icecast box).** Nothing new to install. Set `API_KEY` on it; in the hub the station URL is its public
address and the key is that `API_KEY`. `STATION_NAME` sets the display name. Saved playlists are written under `PLAYLIST_DIR`
(default `DATA_DIR/playlists`) and appear as `list:<name>`.

**RadioDJ on Windows.** Run `chips-voice/agent-radiodj/agent.js` on the same machine (Node 18+, no install step):

1. In RadioDJ make one cart that plays the fixed file `LINKS_DIR\current_link.mp3` (the same idea as `krap-station/host/virtual_host.py`). Note its number.
2. Set `AGENT_KEY` (required), `RADIODJ_URL` (default `http://127.0.0.1:8080`), `RADIODJ_PASS` (the REST plugin password), `LINKS_DIR`, `CLIP_CART`.
3. Optional: `MUSIC_DIR` so the hub can see the library; `RADIODJ_CMD_SKIP` and `RADIODJ_CMD_VOLUME` (see below); `AGENT_PORT` (default 3100).
4. `node agent.js`, then open that port to the hub only (Windows firewall rule or a VPN such as Tailscale). The agent speaks plain HTTP: do not expose it
   to the internet; put it behind the VPN or an HTTPS reverse proxy.

What the RadioDJ agent can do: now playing, put a clip on air (write the file, fire the cart), and list its library. Skip and volume work **only if** you
set the REST plugin command names, which I could not confirm from public documentation; until then the Stations tab greys those buttons. RadioDJ playlists
live in its database, so the agent does not define or switch them (the hub shows "does not support").

## 4. What the hub does

- **Status**: `GET /stations` polls every station (4 s cache). One offline station never blocks the rest.
- **Group actions**: `POST /group/skip|volume|playlist {stations|site, ...}`.
- **Broadcast**: `POST /broadcast` (`clipId`, `url`) or `POST /broadcast/upload` (audio body). The audio is first put on every target **without playing**,
  then all targets are told to start together; the hub reports the spread (milliseconds between the first and last request, on a normal network
  well under a second). It is "together", not sample-accurate: each player has its own buffering. `at` (a time, or seconds from now, up to 24 h) stages now and
  fires later; `DELETE /jobs/:id` cancels. A RadioDJ agent holds one waiting clip, so a newer broadcast replaces an older waiting one.
- **Playlists**: a hub playlist is a list of relative track paths. `GET /playlists/:name/coverage` shows how many each station has; `POST /playlists/:name/push`
  writes it to the stations that support it (`apply: true` also switches them). Files are **not** copied between stations, only the list. Paths must match
  between stations (same folder layout) for coverage to be full. `POST /playlists/import {station, prefix, name}` builds one from a station's folder.
- **Host settings**: `POST /sync/host {from, to, fields}` copies persona, tone, effect, templates and timing; voice and provider only if you list them.

## 5. Connect the site to the hub and the voice server

The Studio and Stations tabs turn on when the site has the address and key of what they need. In the site's environment variables (Netlify: Site configuration, Environment variables):

| Variable | Value |
|----------|-------|
| `HUB_URL`, `HUB_KEY` | the hub's public https address and its `HUB_KEY`. Turns on **Stations** |
| `VOICE_URL`, `VOICE_KEY` | a Chips Voice server's https address and its `API_KEY`. Turns on **Studio** |

Redeploy afterwards. Notes:

- **https is required** (the keys travel in a header); plain `http://localhost` is accepted only for local testing.
- The site forwards `/api/hub/*` and `/api/voice/*` to those servers after you sign in, replacing your sign-in with the server key. Everyone who can sign in can do whatever those keys allow, so treat a login like an admin account.
- **Size limits:** Netlify functions take request bodies up to about 6 MB, so uploads through the site (a broadcast file, a sound effect) are capped at 5 MB. Larger files: use the hub or voice server API directly.
- **Time limits:** a function call that takes longer than your Netlify plan allows is cut off. Speech generation and large library listings are the slow ones.
- If the hub is down or the key is wrong, the tab shows a plain message ("rejected this site's key: check HUB_URL and HUB_KEY") instead of failing silently.

Everything about signing in to the site itself (`LOGIN_USERS`, `SESSION_SECRET`) is in [NETLIFY.md](NETLIFY.md).

## 6. Studio

Write or draft a script (one voice, or a conversation with "Name: line" per line and "Name (direction): line" for delivery), click sound effects to insert
`[sfx:name]`, choose up to four variants (provider, voice, model, tone, effect) and **Generate all** to hear them side by side. "Keep" favorites a clip. The persona section lists the server's
host personas (such as CHIP): edit the tone, effect, persona text and templates, hear any link template, station ID or time-of-day line with your voice, and **Apply to the station host**.
Nothing in the Lab goes on air.

## 7. Stations tab

Stations grouped by site with now playing, skip, volume and playlist; select several and skip them together, **broadcast** one file to all of them at the same moment (or at a chosen time), manage shared playlists (coverage, push, import from a folder), and copy host settings from one station to others.

## 8. Weather alerts (US)

The hub can watch the US National Weather Service for alerts in an area and either record them (`notify`, the default) or have the voice server speak them and broadcast the clip to chosen stations (`broadcast`). It polls every `ALERTS_POLL_SECONDS` (default 120; `0` = off) and sets the NWS-required `User-Agent` from `ALERTS_CONTACT`. A watch can include `radiusKm` to also listen around the edge of that circle (the station's good coverage reach from `GET /api/coverage` on the site). Routes: `GET /alerts`, `POST|PUT|DELETE /alerts/watches`, `POST /alerts/check[?dry=1]`, `GET /alerts/active`. This is a relay of NWS alerts, **not** the Emergency Alert System. Everything about it, including what is said, the safety defaults and what is planned (coverage-aware relevance): [ALERTS.md](ALERTS.md).

## 9. Putting the hub on the server, and RadioDJ at Greenlight

The plan for co-locating the hub on the IONOS server with the web-based DJ for Way High Radio, and adding RadioDJ-based stations for Way High and Greenlight, with the questions that decide the RadioDJ agent's schedule endpoint: [GREENLIGHT-AND-IONOS.md](GREENLIGHT-AND-IONOS.md). An AI agent can drive the hub through the site's MCP endpoint: [MCP.md](MCP.md).

## What is verified, and what is not

Verified by automated tests: the hub's API against fake stations (auth, status, group actions, playlists, broadcasts, timed jobs, host copy), the hub
driving the real RadioDJ agent with a stand-in RadioDJ, the agent's own API, the music library code (path safety), and the site's UI driven in a real browser
against the real site handlers (sign-in with a password and with the access key, generating with a stand-in OpenRouter, the Studio and Stations tabs through the proxy, and the "not connected" cards).

Not verified: a live RadioDJ (the `/npjson` format and the skip/volume command names), a live Liquidsoap playing a `list:` playlist (the m3u is written and selected with
`music.uri`; check it on your server), real speech providers in the Lab, and simultaneous start across real Icecast streams.

## 10. Just-in-time (JIT) drops, shadow mode and the pull model

Pre-baked drops stay the default. Every dynamic spot has a planned ("evergreen") clip in the nightly playlist; the hub may write and speak a fresher line a few minutes before it airs, and **whenever anything fails the planned clip simply plays**. Code: `hub/jit.js`, `hub/validate.js`, UI: the **Dynamic** tab (admin, needs the hub).

### Two clocks, never mixed

| Setting | Meaning | Used for |
|---------|---------|----------|
| `broadcastTz` (`tz` on a site profile) | The station's wall clock (`America/Denver`) | `{{time}}`, schedules, "tonight at 7", event reminders, weather and alert wording, the broadcast day |
| `machineTz` | The RadioDJ PC's own clock (currently Central) | Only reading timestamps that come from the PC |

Both are on the site's station profile, the hub's station record and `GET /agent/info`. The UI warns when they differ, when the PC's real UTC offset (reported by the agent) does not match `machineTz`, and when the agent's declared zones differ from the hub record. `chips-voice/agent-radiodj/tz.js` (copied to `hub/tz.js`, and twinned in `lib/timezones.ts`) is tested for Central-machine/Denver-broadcast, DST edges (2026-03-08, 2026-11-01) and midnight rollover.

### Keys and scopes

| Key | Can |
|-----|-----|
| `HUB_KEY` | Everything (control) |
| `HUB_READ_KEY` (optional) | GET routes only: stations, slots, items, audit |
| per-station key (`POST /stations/:id/pullkey`, shown once, stored as a hash) | Only that station's `heartbeat`, `queue`, `queue/:id/audio`, `queue/:id/ack` and `slots` |

Login tokens carry their scope. The site's proxy forwards the signed-in person as `x-actor`, so approvals and the **audit log** (`GET /audit`, append-only, capped, no keys) say who did what. Unattended jobs call the site with a scoped `SERVICE_KEYS` entry (docs/KEYS.md), not a 12-hour session token.

### The pull model (a PC behind home NAT)

The agent (`HUB_URL`, `HUB_STATION_ID`, `HUB_STATION_KEY`) makes only outbound calls, every 15 s: `POST /stations/:id/heartbeat` (its `/agent/status`), `PUT /stations/:id/slots` (the dynamic slots of today and tomorrow from its schedule), `GET /stations/:id/queue`, download, `POST .../ack`. A station record with `connection: "pull"` needs no URL; it is online while heartbeats arrive. Every clip goes through the **local** agent's own checks (kill switch, live show, shadow, allowlist, two items ahead).

### The worker, per slot

Slot = `{ id, stationId, kind (time-check|weather|event-reminder|host-break|station-id|promo), startsAt (broadcastTz), leadSeconds (600), personaId, fallbackClipId, constraints }`. When a slot is inside its lead window:

1. Write the text with `/api/generate` `textOnly` (with `at` = the air time, so `{{time}}` is right when it airs). The hub uses **`filledIn`**, never `scriptText`/`raw`.
2. Validate before any speech spend: length, blocklist, language policy per persona, placeholders resolved, no markdown/stage directions, no invented songs, artists, numbers, web addresses or phone numbers (a heuristic: only names and facts passed in `constraints` are allowed), and the site's own `copiedExample`/`templateMissing` flags. One retry with a nudge, then fall back.
3. Check the daily cap, then speak (`preview: true`, nothing saved in the site library). Cached by content hash: a line that is the same for several stations is spoken (and billed) once.
4. **Shadow mode (the default)**: store what would have aired; queue nothing. Live: wait for approval (default), then queue for the station to pull.
5. Any error, timeout, cap, missing or tiny audio, kill switch or live show: a recorded reason, nothing queued, the planned clip plays.

Controls: global and per-station kill switch (`POST /jit/kill`), per-day character cap (per station and global, counted in each station's broadcast day), `POST /jit/estimate` before spending, retry with backoff on 5xx/429/network errors, a circuit breaker per provider (3 failures, 5 min pause), suppression while the agent reports `live-show`. `POST /jit/broadcast` writes and speaks once and gives the same audio to many stations; stations whose zone/city/coordinates differ get their own line, identical lines still share the audio.

Routes: `GET /jit/status`, `GET|PUT /jit/settings`, `POST /jit/kill`, `GET|POST /jit/slots`, `PUT|DELETE /jit/slots/:id`, `PUT /stations/:id/jit`, `GET /jit/items[?state=review]`, `GET /jit/items/:id[/audio]`, `POST /jit/items/:id/approve|reject`, `POST /jit/estimate`, `POST /jit/run` (needs `confirm: true`), `POST /jit/broadcast`, `GET /jit/alerts`. **Emergency alerts are not built**: the hook always refuses and the UI shows a disabled "planned" card.

Env: `HUB_READ_KEY`, `SITE_URL`, `SITE_KEY` (a `SERVICE_KEYS` key with `generate`, `stations.read`, `personas.read`).

## 11. The RadioDJ agent, JIT edition

New in `chips-voice/agent-radiodj/` (read key = GET only; control key = everything; `AGENT_KEYS="hubA:read:..,hubA:control:.."` for one pair per hub):

- `GET /agent/status`: stream up/down + listeners (Icecast `status-json.xsl`), loaded playlist, now playing with elapsed/remaining, next N (default 5), last watchdog restart, `machineTz`/`broadcastTz`, mode (live-show/automation), shadow, kill switch.
- `GET /schedule?date=`: read-only day plan from `GLR YYYY-MM-DD*.json` in `SCHEDULE_DIR` (written by the nightly builder; shape in `schedule.js`). The default date is the broadcast date, not the PC's.
- `POST /queue/insert {clip, ahead}`: at least 2 ahead (never the immediately-next item), idempotent by clip hash, refuses when fewer than `ahead-1` items are queued.
- `POST /ingest`: hash-named file per clip in `LINKS_DIR` (default `C:\GreenLightRadio\clips`), `sha256` check, `generated=1` clips are held in shadow mode and, when fired, confirmed through `/npjson` (`played: true|false|null`).
- `POST /playlist/load {name}`: only `GLR YYYY-MM-DD*` names; `skip` only with `RADIODJ_SKIP_VERIFIED=true`.
- Safety: kill switch (`KILL` flag file, or `POST /agent/kill`; **only the PC can clear it**), live-show refusal (`mode` file; entering is remote, leaving is local), action allowlist (`AGENT_ALLOW`), per-hub rate limits, append-only audit log (`audit.jsonl`: who, what, when, result; no secrets), listens on `127.0.0.1` unless `AGENT_HOST` says otherwise. Shadow is on by default (`AGENT_SHADOW=false` to go live).
- `/music/now` also returns `elapsedSeconds`/`durationSeconds` and reads `CurrentTrack.Remaining`.

### Needs live verification on a real RadioDJ (do not claim any of these works until it has been)

1. `/npjson` "Playlist" shape and the unit of `Elapsed`/`Remaining`/`Duration` (seconds assumed; `m:ss` also read).
2. How a clip is inserted two ahead **and the planned clip removed** (see "The generated clip preempts the planned one" below): set `INSERT_EXEC` (Sylvia's script, receives `<file> <position> <replace-id>`) or `RADIODJ_CMD_INSERT`/`RADIODJ_INSERT_ARG`. **No command name is guessed.** 
3. Playlist loading (`LOAD_EXEC`; bulk REST loads have thrown "Index out of range").
4. Skip (`RADIODJ_CMD_SKIP`), volume, and `played` confirmation by track match.
5. The `GLR YYYY-MM-DD.json` plan file and the watchdog/loaded-playlist files (`WATCHDOG_FILE`, `LOADED_PLAYLIST_FILE`).
6. Strong consistency on Netlify Blobs (see KEYS.md), and the new model-failure handling against real OpenRouter.

**Nothing goes on the live station until the owner (Rocky) approves the shadow review and a live single-item test.**

### The generated clip preempts the planned one

Decided: the nightly playlist keeps a planned (evergreen) clip at every dynamic slot, and a generated clip **takes its place**; the planned clip plays only if the swap does not happen. The agent enforces it on `POST /queue/insert {clip, replace: "<planned clip id>"}` (the hub sends the slot's `fallbackClipId` as `replace`):

- The planned clip must be **visible in the queue and at least 2 items ahead**. Not found (`planned-clip-not-found`) or immediately next (`planned-clip-is-next`): HTTP 409, nothing is touched, the planned clip plays.
- The generated clip goes to the planned clip's position; your `INSERT_EXEC` is called `<file> <position> <replace-id>` and must remove the planned item as part of the same step.
- Afterwards the agent reads the queue back: `replaced: true` (new clip there, planned clip gone), `false` (both queued: the hub marks the item as failed rather than inserted, because both would air), or `null` (could not read the queue).
- The mechanism that removes or swaps the item is still the unverified part (it lives in `INSERT_EXEC` or a REST command you have tested).

### Slots that use a saved script

A dynamic slot may carry `script: {id, mode}` (a saved script from the site; docs/SCRIPTS.md): `fixed` says its saved text with placeholders filled for the air time, `draft` has the AI write a fresh version from the script's topic and cast (using the slot's allowed names and facts). The speaker labels are not counted when the words are validated; the hub speaks it through `POST /api/generate` `mode: "script"` (one voice per speaker, joined into one clip). The Dynamic tab's slot form has a **Saved script** picker. The service key (`SITE_KEY`) needs the scopes `generate` and `scripts.read`. Roadmap items that build on this (song requests, relay shows, Google Calendar): [ROADMAP.md](ROADMAP.md).
