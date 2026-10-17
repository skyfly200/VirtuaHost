# Chips Voice

A small text-to-speech announcement tool. A Vue UI lets you type text (or SSML),
pick a Google Cloud voice, and either save the clip or play it immediately. When
a clip plays, background music is faded down over MIDI and faded back up
afterwards.

```
googleTextToSpeech1/        Express backend (app.js, port 3000)
googleTextToSpeech1/tts-ui/ Vue 2 + Vuetify + TypeScript frontend
```

## How it works today

1. The UI posts the text and voice options to the backend.
2. The backend calls Google Cloud Text-to-Speech and writes the audio to a file.
3. For `/speak` and `/play`, the backend sends MIDI CC messages to the
   `loopMIDI Port 1` virtual port to fade the music down, plays the clip in VLC,
   and fades the music back up 2 seconds after VLC exits.

The music itself is not part of this project. Something else (a DAW or mixer)
listens to the MIDI port and owns the music fader.

## Requirements

- Node.js and npm
- A Google Cloud service-account key with the Text-to-Speech API enabled
- [VLC](https://www.videolan.org/) on the `PATH`
- VLC mode only: a virtual MIDI port named `loopMIDI Port 1` (loopMIDI on Windows); `easymidi` is an optional dependency

## Setup

Backend:

```sh
cd googleTextToSpeech1
npm install
export GOOGLE_APPLICATION_CREDENTIALS=tts-creds.json   # Windows: see set-env.cmd
npm run dev                                             # nodemon, port 3000
```

Frontend:

```sh
cd googleTextToSpeech1/tts-ui
npm install
npm run serve
```

Credentials files (`tts-creds.json`, `ccrn-site-*.json`) and audio files are
git-ignored. Do not commit them.

## Playback backends (VLC or Liquidsoap)

`/speak` and `/play` hand the clip to a player chosen by the `PLAYER` environment variable.

| `PLAYER`      | Behaviour |
|---------------|-----------|
| `vlc` (default) | Fade the music down over MIDI, play in VLC, fade back up. |
| `liquidsoap`  | Push the clip onto a Liquidsoap request queue. Liquidsoap ducks the music and streams to Icecast. No MIDI or VLC needed. |

Security: the UI has a login. Set `ADMIN_USER`, `ADMIN_PASSWORD_HASH` (from `npm run hash-password`) and `SESSION_SECRET`; optionally `API_KEY` for scripts (`x-api-key` or `Authorization: Bearer`). Some authentication is required when `PLAYER=liquidsoap`; with none configured in VLC mode the API is open and logs a warning. `CORS_ORIGIN` (comma-separated) restricts browser origins. Run the tests with `npm test`.

Preempting a live DJ: `/speak` and `/play` accept `"preempt": true`; the default is off (`PREEMPT_LIVE=true` flips it). With a live DJ on air and no preempt, the clip is skipped and the response says `"played": false`.

Liquidsoap settings (all optional): `LIQUIDSOAP_HOST` (`127.0.0.1`), `LIQUIDSOAP_PORT` (`1234`), `LIQUIDSOAP_QUEUE` (`announce`).

```sh
liquidsoap googleTextToSpeech1/radio.liq          # edit music path and Icecast password first
PLAYER=liquidsoap npm run dev                      # in googleTextToSpeech1
```

`radio.liq` is the example script from the Icecast section below. Liquidsoap
must be able to read the clip path the backend sends, so run both on the same
machine or share the volume. The clip files are still named by `outputFile`, so
clips are written to `CLIPS_DIR` (default `googleTextToSpeech1/clips`) with a unique name unless the request sets `outputFile`.

**Running on a server instead of the desktop:** see [docs/DEPLOY-VPS.md](docs/DEPLOY-VPS.md) (UI on Netlify/Vercel, backend on the VPS) and [docs/MUSIC-ROTATION.md](docs/MUSIC-ROTATION.md) (keep a rotating subset of a big cloud library on a small disk) (Icecast + Liquidsoap auto-DJ, live-DJ takeover via `/live`, web music controls).

## API

Everything except `/auth/login` and signed `/a/...` links needs a login token (or the API key).

| Method | Path | Purpose |
|--------|------|---------|
| POST | `/auth/login` | `{ username, password }` returns a session token. |
| GET | `/providers` | Active speech, AI and storage providers and their capabilities. |
| GET | `/tts/voices`, `/llm/models` | Voices for the active speech provider; models for the active AI provider. |
| POST | `/announcements/draft` | `{ prompt, tone }` returns drafted text from the AI provider. |
| GET | `/tts/models` | Models for the active provider (OpenRouter speech). |
| POST | `/ingest` | Receive finished audio (WAV, MP3, Ogg) from another system. `INGEST_TOKEN`, `?play=true&preempt=true`. |
| POST | `/ingest/url` | Same, but the server fetches a link from a host in `INGEST_ALLOWED_HOSTS`. |
| POST | `/synth` | Generate a clip without playing it (reuses an identical one). |
| POST | `/speak` | Generate (or reuse) and play. `preempt: true` interrupts a live DJ. |
| GET | `/clips` | Library; `q`, `tag`, `favorite` filters. |
| PATCH, DELETE | `/clips/:id` | Edit title, tags, favorite; delete. |
| POST | `/clips/:id/play` | Play a saved clip. |
| POST | `/clips/:id/link` | `{ hours }` creates a signed stream link. |
| POST | `/clips/:id/share` | `{ target }` uploads to Google Drive or ownCloud and returns links. |
| GET | `/a/:id/:name?exp&sig` | The signed audio link (no login; supports range requests). |
| GET, POST | `/schedules` | List, create. Body: `{ clipId or text..., startAt, intervalSec, count, preempt }`. |
| PATCH, DELETE | `/schedules/:id` | Enable or disable; delete. |
| GET | `/music/playlists`, `/music/now` | Liquidsoap mode: playlists, now playing. |
| POST | `/music/skip`, `/music/volume`, `/music/playlist` | Liquidsoap mode controls. |
| GET | `/midi`, `/learnmute`, `/learnfade` | VLC mode MIDI helpers. |

Speech body fields: `text` or `ssml` with `ssmlMode` (or `turns` for multi-voice dialogue), `provider`, `voice`, `format`
(`OGG_OPUS`, `MP3`, `LINEAR16`), `rate`, `pitch`, `gain`. Providers, drafting,
the library, links and cloud sharing are described in
[docs/CLOUD-AND-AI.md](docs/CLOUD-AND-AI.md); all settings are in
`googleTextToSpeech1/.env.example`.

## Known issues

- VLC mode: `fadeTo` always steps 10 times regardless of the target level.
- One login account only.
- The Liquidsoap script, real speech and AI vendors, Google Drive, ownCloud and the Netlify/Vercel
  deploys have not been run against the real services (see docs/CLOUD-AND-AI.md).

---

## Integrating with Icecast 2 and playing music

### Goal

Stream music and spoken announcements to listeners through the Icecast 2
server, with the music ducking under each announcement.

Icecast only distributes a stream. It does not mix or play anything. Something
must act as the **source client** and push one continuous audio stream to it.
Today that job would fall to whatever DAW or mixer you route VLC and the music
through. There are three ways to do it.

### Option A: keep the current setup and add a source client

Route the mixer or DAW output (music plus VLC) into a source client such as
BUTT, Mixxx's broadcast feature, or a DAW plugin, and point that at Icecast.

- No code changes.
- Needs a desktop machine running all the time with an audio loopback.
- Ducking stays on MIDI, which is fragile and not reproducible on a server.

Good as a stopgap. Not recommended as the end state.

### Option B (recommended): Liquidsoap as the source client

[Liquidsoap](https://www.liquidsoap.info/) is a scriptable audio engine that
connects to Icecast as a source. It plays a music playlist, accepts announcement
clips on a queue, ducks the music while a clip plays, and sends the result to
Icecast. This replaces VLC and the MIDI fades.

```
UI -> Express -> Google TTS -> clip file
                                  |
                       Liquidsoap telnet: announce.push <file>
                                  |
     music playlist ---> smooth_add (duck) ---> output.icecast ---> Icecast 2 ---> listeners
```

Example `radio.liq` (Liquidsoap 2.x; adjust host, password and paths):

```liquidsoap
settings.server.telnet := true
settings.server.telnet.bind_addr := "127.0.0.1"
settings.server.telnet.port := 1234

music    = playlist(mode="randomize", reload_mode="watch", "/srv/music")
announce = request.queue(id="announce")

# Music drops to 20% while an announcement plays, with a short smooth fade.
radio = smooth_add(delay=0.8, p=0.2, normal=music, special=announce)
radio = mksafe(radio)

output.icecast(
  %mp3(bitrate=128),
  host="localhost", port=8000, password="CHANGE_ME",
  mount="/stream",
  radio
)
```

Adding a clip to the queue over the telnet server:

```
announce.push /abs/path/to/clip.mp3
```

Backend changes needed:

1. Add `POST /announce` (or change `/speak` with a config flag). It synthesizes
   the clip, then opens a TCP connection to `127.0.0.1:1234` using Node's `net`
   module and writes `announce.push <absolute path>\n`.
2. Write each clip to a unique file name (for example a timestamp) in a clips
   directory. Today every clip defaults to `output.mp3`, so a second clip would
   overwrite one that is still queued.
3. Keep the TTS audio format at MP3 or Ogg Opus. Liquidsoap decodes both.
4. Put the Liquidsoap host, port and clips directory in environment variables
   rather than hardcoding them. Liquidsoap and the backend need to see the same
   clips path, so run them on one machine or share the volume.
5. Keep the telnet port bound to localhost. It has no authentication.

The existing MIDI and VLC code can stay behind a flag until Option B is proven,
then be removed.

Music control (skip, pause, change playlist) can be added later through the same
telnet server, for example `music.skip` once the playlist has an `id`.

### Option C: ffmpeg direct to Icecast

`ffmpeg -re -i ... -f mp3 icecast://source:pass@host:8000/stream` can stream a
file, but it cannot mix or duck, and switching inputs drops the stream. Only
suitable for a music-only test.

### Suggested order of work

1. Install Liquidsoap and confirm the music plays on the Icecast mount.
2. Push a hand-made clip with `announce.push` and confirm the ducking sounds right.
3. Add the backend announce endpoint and unique clip names.
4. Point the UI "Speak Now" button at it.
5. Build the scheduler on top, since the announce endpoint is the thing a
   schedule would call.

### Questions to settle first

- What currently plays the music: a DAW, Mixxx, something else?
- Where does Icecast run, and is it on the same machine as this backend?
- Is the stream format fixed (MP3 or Ogg, bitrate) by existing listeners?
- Should music still be controllable from a local app, or only from the web UI?
