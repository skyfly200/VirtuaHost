# Several stations: the hub, the agents, and the Voice Lab and Stations tabs of the site

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
- **The site's UI** (`public/`): one page with three tabs, **Generate** (always on), **Voice Lab** (needs a Chips Voice server) and **Stations** (needs the hub).
  The last two stay switched off, with a short "what to set" card, until the site is connected to them. You sign in once, to the site; the site talks to the
  voice server and the hub for you, so their keys never reach the browser.

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

The Voice Lab and Stations tabs turn on when the site has the address and key of what they need. In the site's environment variables (Netlify: Site configuration, Environment variables):

| Variable | Value |
|----------|-------|
| `HUB_URL`, `HUB_KEY` | the hub's public https address and its `HUB_KEY`. Turns on **Stations** |
| `VOICE_URL`, `VOICE_KEY` | a Chips Voice server's https address and its `API_KEY`. Turns on **Voice Lab** |

Redeploy afterwards. Notes:

- **https is required** (the keys travel in a header); plain `http://localhost` is accepted only for local testing.
- The site forwards `/api/hub/*` and `/api/voice/*` to those servers after you sign in, replacing your sign-in with the server key. Everyone who can sign in can do whatever those keys allow, so treat a login like an admin account.
- **Size limits:** Netlify functions take request bodies up to about 6 MB, so uploads through the site (a broadcast file, a sound effect) are capped at 5 MB. Larger files: use the hub or voice server API directly.
- **Time limits:** a function call that takes longer than your Netlify plan allows is cut off. Speech generation and large library listings are the slow ones.
- If the hub is down or the key is wrong, the tab shows a plain message ("rejected this site's key: check HUB_URL and HUB_KEY") instead of failing silently.

Everything about signing in to the site itself (`LOGIN_USERS`, `SESSION_SECRET`) is in [NETLIFY.md](NETLIFY.md).

## 6. Voice Lab

Write or draft a script (one voice, or a conversation with "Name: line" per line and "Name (direction): line" for delivery), click sound effects to insert
`[sfx:name]`, choose up to four variants (provider, voice, model, tone, effect) and **Generate all** to hear them side by side. "Keep" favorites a clip. The persona section lists the server's
host personas (such as CHIP): edit the tone, effect, persona text and templates, hear any link template, station ID or time-of-day line with your voice, and **Apply to the station host**.
Nothing in the Lab goes on air.

## 7. Stations tab

Stations grouped by site with now playing, skip, volume and playlist; select several and skip them together, **broadcast** one file to all of them at the same moment (or at a chosen time), manage shared playlists (coverage, push, import from a folder), and copy host settings from one station to others.

## What is verified, and what is not

Verified by automated tests: the hub's API against fake stations (auth, status, group actions, playlists, broadcasts, timed jobs, host copy), the hub
driving the real RadioDJ agent with a stand-in RadioDJ, the agent's own API, the music library code (path safety), and the site's UI driven in a real browser
against the real site handlers (sign-in with a password and with the access key, generating with a stand-in OpenRouter, the Voice Lab and Stations tabs through the proxy, and the "not connected" cards).

Not verified: a live RadioDJ (the `/npjson` format and the skip/volume command names), a live Liquidsoap playing a `list:` playlist (the m3u is written and selected with
`music.uri`; check it on your server), real speech providers in the Lab, and simultaneous start across real Icecast streams.
