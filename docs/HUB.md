# Several stations, two web apps: the hub, the agents, the Voice Lab and the Control Panel

```
 Voice Lab (browser) ───────────────────────────► Chips Voice server (voices, personas, clips)
                                                      ▲
 Control Panel (browser) ──► HUB ──────────────────── │ clip audio (signed link)
                              │ one API per station
          ┌───────────────────┼────────────────────┐
          ▼                   ▼                    ▼
   Chips Voice server    Chips Voice server    RadioDJ agent  ──► RadioDJ (Windows)
   + Liquidsoap/Icecast  + Liquidsoap/Icecast
```

- **Station agent**: anything that answers the small HTTP API below. A Chips Voice server in front of Liquidsoap already does. The
  **RadioDJ agent** (`chips-voice/agent-radiodj/`) does it for RadioDJ on Windows.
- **Hub** (`chips-voice/hub/`): keeps the list of stations, polls them, and does what needs more than one: broadcasts that start together,
  playlists pushed to several stations, host settings copied between them. No dependencies; Node 18+.
- **Voice Lab** and **Control Panel** (`chips-voice/web/`): two static web apps sharing one small kit (`web/shared/`). No build step. They run in
  the browser and talk to your servers; the page host stores nothing.

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
| `HUB_KEY` | required, 12+ characters. The Control Panel exchanges it for a 12-hour token |
| `HUB_PORT`, `HUB_HOST` | default 3200, 0.0.0.0 |
| `HUB_DATA` | JSON file for stations, playlists and timed broadcasts (default `hub/data/hub.json`, mode 600 because it holds station keys) |
| `VOICE_URL`, `VOICE_KEY` | a Chips Voice server, only needed to broadcast a clip by id (the hub asks it for a signed link; set its `STREAM_SECRET`) |
| `HUB_CORS_ORIGIN` | the web apps' address when they are hosted elsewhere (default `*`; the apps send no cookies, only a token) |
| `HUB_STATIC` | a folder to serve at `/`, e.g. `../web`, so the hub serves the two apps itself |

Put it behind HTTPS (Caddy or nginx, as in `docs/DEPLOY-VPS.md`). Add stations in the Control Panel or `POST /stations {name,url,key,site}`.
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
set the REST plugin command names, which I could not confirm from public documentation; until then the Control Panel greys those buttons. RadioDJ playlists
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

## 5. Deploy the web apps

The apps are plain files in `chips-voice/web/` (`index.html`, `lab/`, `panel/`, `shared/`). Pick one:

- **Hub serves them**: `HUB_STATIC=../web`. Open `https://hub.example.com/panel/`. Same origin, no CORS to set up.
- **Netlify**: new site from this repo, Base directory `chips-voice/web`, Publish directory `.`, no build command. (The repository root's own `netlify.toml` belongs to VirtuaHost, so use a separate site.)
- **Vercel**: new project, Root Directory `chips-voice/web`, Framework "Other", no build command.
- **Anywhere static** (a LAN box, GitHub Pages, your own nginx).

When hosted away from the servers, set `HUB_CORS_ORIGIN` on the hub and `CORS_ORIGIN` on each Chips Voice server to the apps' address. The first screen asks for a server
address and a key (the Voice Lab also takes a username and password). Tokens are kept for the tab, or on the device if you tick "keep me signed in"; the long-lived key is never stored.

## 6. Voice Lab

Write or draft a script (one voice, or a conversation with "Name: line" per line and "Name (direction): line" for delivery), click sound effects to insert
`[sfx:name]`, choose up to four variants (provider, voice, model, tone, effect) and **Generate all** to hear them side by side. "Keep" favorites a clip. The persona section lists the server's
host personas (such as CHIP): edit the tone, effect, persona text and templates, hear any link template, station ID or time-of-day line with your voice, and **Apply to the station host**.
Nothing in the Lab goes on air.

## What is verified, and what is not

Verified by automated tests: the hub's API against fake stations (auth, status, group actions, playlists, broadcasts, timed jobs, host copy), the hub
driving the real RadioDJ agent with a stand-in RadioDJ, the agent's own API, the music library code (path safety), and the two web apps driven in a real browser
(sign-in, adding stations, skip, broadcast, playlists, voice generation, persona audition) against stub servers.

Not verified: a live RadioDJ (the `/npjson` format and the skip/volume command names), a live Liquidsoap playing a `list:` playlist (the m3u is written and selected with
`music.uri`; check it on your server), real speech providers in the Lab, and simultaneous start across real Icecast streams.
