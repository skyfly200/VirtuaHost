# Plan: the hub on the IONOS server, and Greenlight Radio on RadioDJ

For **Sylvia**, who will log in to the IONOS server and has read access to this repo. Written so you can work from it without anyone explaining. Questions for you are in [Part 2](#part-2-questions-for-sylvia-send-the-answers-back); the work is in [Part 3](#part-3-the-work-in-order).

## Part 1: what we are building

Three stations, one hub, one site:

```
                     Netlify site (UI, AI, schedules, MCP)  ── /api/hub/* ──┐
                                                                            ▼
 IONOS server (already set up)                                            HUB  (small Node app, no database)
 ┌────────────────────────────────────────────┐                             │  one API per station
 │ Icecast + Liquidsoap + Chips Voice         │ <───────────────────────────┤
 │   = Way High Radio "web-based DJ"          │                             │
 │ the hub (new, co-located)                  │                             │   (VPN or HTTPS)
 └────────────────────────────────────────────┘                             ▼
                                                              ┌─────────────┴──────────────┐
                                                              ▼                            ▼
                                            Way High: RadioDJ machine           Greenlight: RadioDJ machine
                                            + RadioDJ agent                     + RadioDJ agent
```

| Station | What plays | How the hub talks to it |
|---|---|---|
| **Way High Radio (web-based DJ)** | Liquidsoap on the IONOS server (music files, the announcement queue, the virtual host) | The Chips Voice server's own agent API, on the same machine |
| **Way High Radio (RadioDJ)** | RadioDJ on a Windows machine | `chips-voice/agent-radiodj/agent.js` next to RadioDJ |
| **Greenlight Radio (RadioDJ)** | RadioDJ on its own Windows machine | the same agent, **built from what Sylvia's scripts do** |

The hub is a small coordinator: it keeps the list of stations, shows what is playing, skips, sets volume, broadcasts one clip to several stations at the same moment, and (planned) watches US weather alerts ([ALERTS.md](ALERTS.md)). It does not play audio and does not run RadioDJ. Read [HUB.md](HUB.md) first (the agent API is its section 1), then `chips-voice/docs/DEPLOY-VPS.md` and [INTEGRATION.md](INTEGRATION.md) for what already runs on the IONOS box.

An AI agent can also run all of this through the site's MCP endpoint ([MCP.md](MCP.md)); that is for later, once the hub and agents are up.

## Part 2: questions for Sylvia (send the answers back)

You already have Python scripts that talk to RadioDJ and a scheduling layer. The point of these questions is to **build the RadioDJ agent around what already works for you**, not around guesses. `krap-station/` and your scripts are not touched. Answer in any form (a message, a pasted file); short is fine. Say "not sure" where you are not; that is useful.

### A. The scripts running on Greenlight Radio now

For each script (or group): 
1. Name, where it lives (host, folder), and language/version.
2. **What starts it**: cron, systemd, Windows Task Scheduler, run by hand, or RadioDJ itself?
3. **What it does**, in a sentence (for example "writes the hourly station ID file and fires cart 12").
4. **What it reads and writes**: files, folders, a database, network calls.
5. Is it safe to run twice, and what happens if it is down for an hour?

### B. How they reach RadioDJ

6. Do you use RadioDJ's **REST/HTTP plugin**? Its address, port and how the password is sent. Which **commands** do you call (the exact names, for example the one that loads and plays a cart, skips, sets volume)? Paste a working example request and what it returns.
7. Do you ever use RadioDJ's **database** directly (MariaDB/MySQL)? Which tables (for example the events/schedule tables, the history), read or write, and with what account?
8. How do you read **now playing**? (For example `/npjson`, a text file, the database.) Paste an example of the output.
9. RadioDJ **version**, plugin versions, and Windows version.
10. Folder layout: music library path, the folder `current_link.mp3`-style files go in, and the **cart numbers** you use for spots, links and IDs.

### C. The scheduling layer

11. **How do schedules get into RadioDJ today?** Through its REST API, by writing database rows (the events/schedule tables), by clock/rotation templates, or something else? Which part is yours (Python) and which is RadioDJ's own?
12. What does **one schedule item** look like (the fields you set: time, type, what it plays, repeat rule, days)? An example or two is ideal.
13. Time zone, and how you handle daylight saving.
14. Can your scheduler **add, change and remove** items safely while RadioDJ is running? Is there anything that must not be done during a show?

### D. The machine and the network

15. Where does Greenlight's RadioDJ machine live (home, studio, a server), and does it have a stable address? Can it make **outbound** connections (to the IONOS server)? Can anything connect **in** to it?
16. Are you willing to use a **VPN** (Tailscale or WireGuard) between the machines? It is the safest way for the hub to reach the RadioDJ agents without opening ports to the internet.
17. How does Greenlight get to listeners (Icecast, SHOUTcast, BUTT, SAM)? Where is the stream encoded?
18. Same questions 9 to 17 for **Way High's RadioDJ machine**, if it differs.

### E. What you want the hub to do for Greenlight

19. Rank these: now playing, skip, volume, switch playlist/rotation, put a spot or link on air now, schedule an item, read the schedule, read the history/log, alert on silence.
20. What should the hub **never** do on its own (so we build the guard rails first)?

### F. The IONOS server (so the work is quick)

21. Which plan/size, and what is already running (Icecast, Liquidsoap, Chips Voice, a web server)? How much RAM is free (`free -m`) and disk (`df -h`)?
22. How are things run (systemd units? Docker? screen/tmux)? Is there a reverse proxy (Caddy, nginx) and which domain names point at it?

## Part 3: the work, in order

Each step lists what "done" looks like. Do them in order; tell us when a step is done or blocked.

### 0. Get set up (once)

- [ ] Log in with your key (the person who owns the server adds your **public key** to a **non-root deploy user's** `~/.ssh/authorized_keys`; your private key never leaves your machine and is never put in the repo or sent in chat).
- [ ] Read this page, [HUB.md](HUB.md), [INTEGRATION.md](INTEGRATION.md), `chips-voice/docs/DEPLOY-VPS.md`, [FOR-SYLVIA.md](FOR-SYLVIA.md) (end to end), and [ALERTS.md](ALERTS.md).
- [ ] Record what is on the server (Part 2, F) and send it back. **Do not change anything yet.**

Server hygiene we want from the start: key-only SSH (no password logins), no direct root login, a firewall that allows only SSH and the web ports, `fail2ban`, automatic security updates, secrets in `/etc/virtuahost/*.env` (mode 600, owned by the service user) and **never in the repo**, and a service user for each app instead of running as your login.

### 1. Check there is room for the hub

The hub is plain Node with no dependencies and holds its data in one JSON file (mode 600; it contains station keys). It is small, but the IONOS plan we sized earlier is **1 vCore, 1 GB RAM**, shared with Icecast, Liquidsoap, Chips Voice and ffmpeg. 

- [ ] `free -m` while the station is playing. If less than about 150 MB is free, add swap (a 1 to 2 GB swapfile) before continuing, and tell us.
- [ ] Node 18+ is installed (`node -v`).

Done = a note of the numbers.

### 2. Run the hub on the IONOS server

Follow [HUB.md section 2](HUB.md#2-run-the-hub) and `chips-voice/docs/DEPLOY-VPS.md` for the pattern. In short:

- [ ] Put the repo's `chips-voice/hub/` on the server (a `git clone` with read access is fine; update with `git pull`).
- [ ] A systemd unit running `node server.js` as its own user, with `EnvironmentFile=/etc/virtuahost/hub.env`:
  `HUB_KEY` (new, random, 12+ characters: `openssl rand -hex 24`), `HUB_PORT=3200`, `HUB_HOST=127.0.0.1` (**listen on localhost only**; the reverse proxy is the way in), `HUB_DATA=/var/lib/virtuahost/hub.json`, `VOICE_URL=http://127.0.0.1:<chips-voice port>` and `VOICE_KEY` (so it can broadcast clips and, later, speak alerts), `ALERTS_CONTACT=<an email>`.
- [ ] Reverse proxy with HTTPS (Caddy is simplest): a hostname (for example `hub.<your domain>`) forwarding to `127.0.0.1:3200`. The site and MCP need **https** (keys travel in a header).
- [ ] `curl https://hub.<domain>/health` returns `{"ok":true,...}`.
- [ ] Tell the site owner the hub URL and `HUB_KEY` **in person or a password manager, not in chat or the repo**; they set `HUB_URL` and `HUB_KEY` on Netlify, which turns on the Control tab.

Done = Control tab shows, with no stations yet.

### 3. Add Way High's web-based DJ station

- [ ] In the hub, add the Chips Voice server on the same machine as a station: URL `http://127.0.0.1:<port>` and its `API_KEY` (`POST /stations {name:"Way High Radio (web)", url, key, site:"Way High"}`, or the Control tab).
- [ ] It should show **online**, with now playing and skip/volume working ([HUB.md section 4](HUB.md#4-what-the-hub-does)).

### 4. The RadioDJ agents

Use `chips-voice/agent-radiodj/agent.js` as the starting point ([HUB.md section 3](HUB.md#3-add-each-kind-of-station)). It already can: report now playing, put a clip on air (write the file, fire the cart), list the library. It **cannot yet**: skip, volume, playlists, or anything about schedules, because the command names were never confirmed. Your answers in Part 2 decide this.

- [ ] **Way High RadioDJ**, on its machine: install the agent, set `AGENT_KEY`, `RADIODJ_URL`, `RADIODJ_PASS`, `LINKS_DIR`, `CLIP_CART`, `MUSIC_DIR`; the cart that plays the fixed file `current_link.mp3` exists. Reach it from the IONOS server over a **VPN**, not an open port (the agent speaks plain HTTP).
- [ ] Add it to the hub as a station; it shows online.
- [ ] **Greenlight RadioDJ**: same, but first fill in the real command names from your scripts (`RADIODJ_CMD_SKIP`, `RADIODJ_CMD_VOLUME`) and send us an example of each. **Send us the scripts' behaviour (Part 2 A to C) before we write the scheduling endpoints** so the agent matches what you already run, and so nothing it does conflicts with your scheduler (for example two things writing the same schedule rows).
- [ ] Add it to the hub as a station.

### 5. The scheduling endpoint (after your answers)

We will extend the agent API with a small, optional **schedule** capability (read the day's schedule, add, change and remove items) implemented the way **your scheduler already does it**, so it is one path, not two. Until then the hub does not touch RadioDJ's schedule. The proposal, to be confirmed against Part 2 C:

| Call | Purpose |
|---|---|
| `GET /schedule?from=&to=` | items in a window |
| `POST /schedule` | add an item (time, what to play, repeat) |
| `PUT /schedule/:id`, `DELETE /schedule/:id` | change, remove |
| `capabilities.schedule` in `GET /agent/info` | so the hub only offers it where it works |

### 6. Make it the daily setup

- [ ] Services restart on reboot (`systemctl enable`), logs go to the journal, a one-line health check you can run, and a note of how to update (`git pull`, restart) and roll back.
- [ ] A short `RUNBOOK` for the server: what runs, where, which ports, who to call. We will turn it into a doc in the repo.

### 7. Then, together

- Weather alert watches in the hub ([ALERTS.md](ALERTS.md)), starting with `notify`.
- Stations' locations and coverage ([COVERAGE.md](COVERAGE.md)), so alerts and event drops go to the right stations.
- The MCP endpoint ([MCP.md](MCP.md)), so an AI agent can help run all of it.

## What is verified, and what is not

The hub, the agent API, and the agent with a **stand-in** RadioDJ are covered by automated tests (`cd chips-voice/hub && node --test test/*.test.js`; `cd chips-voice/agent-radiodj && node --test test/*.test.js`). **Nothing here has been run against a real RadioDJ, the real IONOS server, or Greenlight's machine.** The RadioDJ REST command names for skip and volume, the `/npjson` format, and everything about its schedule tables are unconfirmed; they are what Part 2 is for.
