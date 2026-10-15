# Running the station on the stream server (IONOS VPS)

This moves music playback off the desktop. The desktop (BUTT + RadioDJ) becomes
an optional live-DJ source; the VPS keeps the stream up on its own.

```
 desktop (optional)                         IONOS VPS
 RadioDJ -> BUTT ── /live ──┐   ┌──────────────────────────────────────┐
                            ├──>│ Icecast 2                            │
                            │   │   ^ /live        │ /stream           │
                            │   │   │              v                   │
                            │   │ Liquidsoap: live DJ, else auto-DJ    │
                            │   │   ^ music files, announcement queue  │
                            │   │   │ telnet 127.0.0.1:1234            │
                            │   │ Node backend (this repo) + web UI    │
                            │   └──────────────────────────────────────┘
                            └ listeners always use /stream
```

- **Desktop off:** Liquidsoap plays the server-side music on `/stream`.
- **Desktop on and BUTT connected to `/live`:** the live DJ takes over
  immediately; when BUTT disconnects, the music resumes.
- **Announcements** from the web UI duck the server-side music. While a live DJ
  is on air they are skipped by default (not queued, so they don't play late).
  Tick "Interrupt live DJ" in the UI, or send `"preempt": true`, to cut in over
  the DJ; the DJ comes back when the clip ends. Set `PREEMPT_LIVE=true` to make
  that the default.

## Sizing: the $2/month IONOS plan

The $2/month plan is IONOS **VPS Linux XS**: 1 vCore, 1 GB RAM, 10 GB NVMe,
unlimited traffic (sources and caveats in the chat summary; check IONOS's own
page for current terms and the renewal price). That is enough to run the
station but tight:

- **Disk (10 GB):** the OS, Icecast, Liquidsoap, Node and ffmpeg take roughly
  3-5 GB, leaving about 4-6 GB for music. At 128 kbps MP3 that is about 1 MB per
  minute, so around 70-100 hours (1,000-1,500 songs). A larger library does not
  fit.
- **RAM (1 GB):** Liquidsoap, Icecast and the Node backend together should fit
  in roughly 400-600 MB, but add a 1-2 GB swap file. The UI is built and hosted on
  Netlify or Vercel, so nothing UI-related needs to be installed on the VPS.
- **CPU (1 vCore):** one 128k MP3 encode plus decoding is fine. Transcoding many
  formats at once is not.
- **Bandwidth:** each listener costs 128 kbps (about 56 MB per hour). With a
  1 Gbit link, listener count is limited by CPU and Icecast config, not traffic.

If the library will not fit, rotate a subset from your cloud ([MUSIC-ROTATION.md](MUSIC-ROTATION.md)) or move to the next IONOS tier (VPS S, 2 vCores / 2 GB /
80 GB) is the simple fix. Do not rely on the XS's longevity: one price listing
marks it as deprecated.

## 1. Install

Debian/Ubuntu on the VPS:

```sh
sudo apt install icecast2 liquidsoap ffmpeg nodejs npm nginx
```

Check `liquidsoap --version` is 2.x; the script in `radio.liq` uses 2.x syntax.
Distro packages can be old, in which case use the Liquidsoap release `.deb`
from the project's GitHub releases.

## 2. Icecast mounts

Your Icecast already exists. What changes is who feeds which mount:

| Mount     | Fed by                       | Used by |
|-----------|------------------------------|---------|
| `/stream` | Liquidsoap (always on)       | listeners |
| `/live`   | BUTT from the desktop (when on) | Liquidsoap only |

Change BUTT's mount from `/stream` to `/live`. If your listeners currently use
`/live`, swap the two names in `radio.liq` (`mount=` and the `input.http` URL).

Hide `/live` from public listing in `icecast.xml` if you don't want listeners
tuning to it directly, and keep the **source** password out of the web UI and
repo.

## 3. Music files

Copy the library to the VPS, one sub-directory per playlist:

```sh
rsync -av --progress /path/to/music/ user@vps:/srv/music/
```

Subfolders such as `/srv/music/Chill` show up in the UI's playlist menu. If the whole library does not fit, keep it in your cloud storage and rotate a subset onto the VPS on a schedule: see [MUSIC-ROTATION.md](MUSIC-ROTATION.md). Needs
disk space: check the VPS plan size against the library. `reload_mode="watch"`
picks up new files automatically.

## 4. Liquidsoap

```sh
sudo cp googleTextToSpeech1/radio.liq /etc/liquidsoap/radio.liq
sudo nano /etc/liquidsoap/radio.liq     # set icecast_password and music_dir
sudo systemctl enable --now liquidsoap  # or run: liquidsoap /etc/liquidsoap/radio.liq
```

The Debian package runs scripts in `/etc/liquidsoap/` as the `liquidsoap` user,
which must be able to read `/srv/music` and the clips directory.

## 5. Backend (VPS) and web UI (Netlify or Vercel)

The VPS only runs the backend API. The web UI is a static site, so it is hosted
on Netlify or Vercel instead, which saves disk and RAM on the VPS.

```sh
cd googleTextToSpeech1 && npm install --omit=dev
```

Run the backend as a service, for example `/etc/systemd/system/chipsvoice.service`:

```ini
[Unit]
Description=Chips Voice backend
After=network.target

[Service]
WorkingDirectory=/opt/chipsvoice/googleTextToSpeech1
Environment=PLAYER=liquidsoap
Environment=ADMIN_USER=admin
Environment=ADMIN_PASSWORD_HASH=scrypt$...paste the output of: npm run hash-password
Environment=SESSION_SECRET=put-a-long-random-string-here   # openssl rand -hex 32
# Environment=API_KEY=...             # optional, for scripts; not needed for the web UI
# Environment=PREEMPT_LIVE=true       # let announcements cut in over the live DJ by default
Environment=CORS_ORIGIN=https://your-site.netlify.app   # where the UI is hosted (comma-separate several)
Environment=GOOGLE_APPLICATION_CREDENTIALS=/etc/chipsvoice/tts-creds.json
# Library, links, AI drafting and cloud sharing: see googleTextToSpeech1/.env.example and CLOUD-AND-AI.md
Environment=DATA_DIR=/var/lib/chipsvoice
Environment=PUBLIC_URL=https://api.example.com
Environment=CLIP_CACHE_MB=300
Environment=MUSIC_DIR=/srv/music
Environment=CLIPS_DIR=/srv/clips
Environment=STREAM_MOUNT=/stream
Environment=ICECAST_STATUS_URL=http://127.0.0.1:8000/status-json.xsl
ExecStart=/usr/bin/node ./bin/www
Restart=always
User=chipsvoice

[Install]
WantedBy=multi-user.target
```

The web UI has a **login screen**. Set it up with:

```sh
cd googleTextToSpeech1
npm run hash-password            # type the password (10+ characters); paste the output into ADMIN_PASSWORD_HASH
openssl rand -hex 32             # use this for SESSION_SECRET
```

The password is stored only as a salted scrypt hash. A successful login returns
a signed session token (12 hours by default, `SESSION_HOURS` to change) that the
UI keeps in that browser and sends on every request. Repeated wrong passwords
from one address are blocked for 15 minutes. Changing `SESSION_SECRET` signs
everyone out. `API_KEY` is optional and only for scripts (`x-api-key: <key>`).
In Liquidsoap mode the backend refuses to start without a login or an API key.
There is one account; multiple users would need a user store.

Because the UI is served over HTTPS, the browser will only call an **HTTPS**
API (mixed content is blocked). That needs a hostname pointing at the VPS, for
example `api.example.com` (any DNS provider, or a free dynamic-DNS name), and a
certificate. Put nginx in front, proxying to the backend on localhost, and never
expose port 3000 directly:

```nginx
server {
  server_name api.example.com;                   # your API hostname
  # listen 443 ssl; ... run: sudo certbot --nginx -d api.example.com
  location / { proxy_pass http://127.0.0.1:3000/; }
}
```

### Hosting the UI

The repo includes `netlify.toml` (repo root) and `googleTextToSpeech1/tts-ui/vercel.json`.
In both cases set one environment variable, then deploy from the repo:

| Setting | Value |
|---------|-------|
| `VUE_APP_API` | `https://api.example.com` (the backend URL above, no trailing slash) |

- **Netlify:** New site from Git, pick the repo. Build settings come from `netlify.toml`.
- **Vercel:** Import the repo and set **Root Directory** to `googleTextToSpeech1/tts-ui`.

Then set `CORS_ORIGIN` on the VPS to the site's URL. If the UI shows network
errors, check this first. `VUE_APP_API` is read at build time, so redeploy after
changing it. Both free tiers are enough for this; the site is a few hundred KB.

Anyone can open the hosted page, but it only shows the login screen; every API
call needs a session, so nothing can be controlled or read without signing in. If
you want the page itself private too, use Netlify or Vercel's password
protection (paid tiers).

Also firewall (IONOS Cloud Firewall Policy or `ufw`) so only the Icecast port
(8000, or 80/443 if proxied) and SSH are reachable from outside. Liquidsoap's
telnet port 1234 must stay on localhost.

The backend writes clips to `CLIPS_DIR`, which Liquidsoap must be able to read. Clip names from requests are reduced to a file name inside that directory.

## 6. Check it

1. `curl http://127.0.0.1:8000/status-json.xsl`: `/stream` is listed.
2. Open `http://<vps>:8000/stream` in a player: music plays.
3. Web UI: Skip changes the track; Volume changes the level.
4. Send an announcement: the music ducks, the clip plays, the music returns.
5. Start BUTT to `/live`: the stream switches to the DJ; stop BUTT: music resumes.

## Limits and things to know

- **Preempting the live DJ** replaces the DJ's audio while the clip plays (the
  DJ is not heard under it). It checks `/live` on Icecast to decide.
- **Now playing / skip** apply to the auto-DJ only. They have no effect while the
  live DJ is on.
- **RadioDJ's** library, jingles and scheduling do not move to the VPS.
  Liquidsoap only plays the files and a random or ordered playlist. Rotation
  rules, jingles every N songs and a timetable can be added to `radio.liq`.
- **Format:** `radio.liq` encodes MP3 128k. Match this to what listeners and
  players already expect.
- **Untested here:** the Liquidsoap script and telnet commands (`music.skip`,
  `music.uri`, `music.reload`, `var.set`) were written against Liquidsoap 2.x
  docs but not run, so check them on the server first.
