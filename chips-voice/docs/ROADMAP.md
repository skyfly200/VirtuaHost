# Architecture and roadmap

## What exists

```
Browser (Netlify / Vercel)  [original UI; the Voice Lab and Stations tabs in the root public/ folder are the newer ones]   VPS
┌──────────────────────────┐   HTTPS + login token   ┌─────────────────────────────────────────┐
│ Vue 2 + Vuetify UI       │ ───────────────────>│ nginx (TLS) -> Express backend :3000     │
│  Login screen            │
│  Now playing card        │                     │                                         │
│  Announcement composer   │                     │  /synth /speak /play     text -> clip   │
│  (Schedule: not built)   │                     │  /music/*                 control       │
└──────────────────────────┘                     │        │                    │           │
                                                 │  Google Cloud TTS     Liquidsoap        │
                                                 │  (fixed provider)     telnet :1234      │
                                                 │        │                    │           │
                                                 │  clips/clip-<ts>.ogg ──> announce queue │
                                                 │  /srv/music <── rotate_music.py <─ cloud│
                                                 │                             │           │
                                                 │  Icecast :8000  <───────────┘ /stream   │
                                                 │        ^ /live (BUTT from desktop)      │
                                                 └─────────────────────────────────────────┘
```

## Status

Built (see [CLOUD-AND-AI.md](CLOUD-AND-AI.md) and [../../docs/](../../docs/)): swappable speech providers (Google, OpenAI,
ElevenLabs, OpenRouter, Piper) and AI providers (OpenRouter, Anthropic, OpenAI, Ollama) with fallback chains and per-request model and tone; the
clip library with reuse, favorites, tags and a disk cap; schedules; signed stream links; sharing to Google Drive
(rclone) and ownCloud; AI drafting (text and conversations); rate limits and length caps; login and API keys; ffmpeg effects; sound effects
(`[sfx:name]`); multi-voice dialogue; the server-side virtual host with personas (CHIP); hand-off from Netlify (`/ingest`); chat (Twilio, Telegram) and MCP control;
the multi-station hub, the RadioDJ agent and the Voice Lab / Stations tabs of the site ([../../docs/HUB.md](../../docs/HUB.md)).
Automated tests: 135 (server), 15 (hub), 6 (RadioDJ agent), 39 (VirtuaHost root).

Still open:

| Area | Item |
|------|------|
| Untested against real services | Liquidsoap script (including saved `list:` playlists), live RadioDJ (`/npjson`, skip and volume command names), Google, OpenRouter (native dialogue field names), ElevenLabs, Google Drive, ownCloud, Twilio and Telegram delivery, Netlify/Vercel deploys. |
| RadioDJ | Skip and volume need the REST plugin command names (`RADIODJ_CMD_SKIP`, `RADIODJ_CMD_VOLUME`); playlists are not driven from the agent. |
| Hub | Simultaneous start is "together" within network latency, not sample-accurate; timed broadcasts are held in the hub for at most 24 h; no per-user accounts (one hub key). |
| Playback | VLC mode `fadeTo` bug; legacy `/hook`, `/midi`, `/learn*`. |
| Accounts | One login only. |
| Scheduling | No calendar view, no "run now", no time-of-day recurrence (only fixed intervals). |
| Library | Evicted clips are regenerated, not restored from the cloud copy. |
| Package | Still named `express-locallibrary-tutorial`. |
| Old UI | The Vue UI in `tts-ui/` has not been changed to use the hub; the Voice Lab and Stations tabs of the site's UI (`public/`) are the multi-station and voice-tuning front ends. |

The sections below are the original design notes; they now describe what was built.

## 1. Interchangeable speech and LLM providers

Put each provider behind one small interface and choose it by configuration, so
nothing outside the adapter knows which vendor is used.

```
backend/providers/tts/   google.js  openai.js  elevenlabs.js  piper.js (local)
backend/providers/llm/   anthropic.js  openai.js  ollama.js
backend/providers/index.js   picks adapters from TTS_PROVIDER / LLM_PROVIDER
```

```js
// tts adapter: returns audio bytes in a format Liquidsoap can read
{ name, capabilities: { ssml, pitch, rate, voices },
  listVoices(): [{ id, language, gender }],
  synthesize({ text | ssml, voice, rate, pitch, gain, format }): { audio: Buffer, ext, mime } }

// llm adapter
{ name, generate({ system, prompt, maxTokens }): string }
```

- **One request shape.** The UI sends neutral options (`voice`, `rate`, `pitch`,
  `ssml`). Each adapter maps them to its vendor's fields and ignores what it
  cannot do, reporting that through `capabilities` so the UI can hide SSML or
  pitch controls.
- **Voices differ per vendor**, so `GET /tts/voices` returns the active
  provider's list and the UI builds its picker from it, instead of the hardcoded
  Google voice names in `AnnouncementForm.vue`.
- **Fallback chain.** `TTS_PROVIDER=google,piper` tries the next one on an
  error or quota failure. Piper runs locally for free and is a good last
  resort, though voices are lower quality and 1 GB of RAM on the VPS is tight.
- **Keys and cost.** Each adapter reads its own credentials from the
  environment. Store which provider and voice made each clip (see below) so
  costs can be tracked.
- **LLM use.** The LLM turns a short prompt ("Announce that the 6pm show is
  cancelled, friendly tone") into announcement text, which then goes through
  the normal text-to-speech path. Add `POST /announcements/draft` returning
  text for a human to review and edit; do not auto-play model output to a
  public stream without approval, at least at first.
- **First step.** Move the existing Google code in `app.js` into
  `providers/tts/google.js` unchanged, with no behaviour change, then add a
  second adapter.

## 2. Tracking and reusing clips

Store every generated clip in a small catalogue so repeated text is never
synthesized (and paid for) twice.

SQLite is enough. Node 22 has `node:sqlite` built in, so it needs no native
build on the VPS.

```sql
clips(
  id TEXT PRIMARY KEY,         -- sha256 of normalized text + provider + voice + settings
  text TEXT, ssml INTEGER,     -- what was said
  provider TEXT, voice TEXT, settings TEXT,   -- JSON: rate, pitch, gain
  format TEXT, file TEXT, bytes INTEGER, duration REAL,
  title TEXT, tags TEXT, favorite INTEGER DEFAULT 0,
  created_at TEXT, last_played_at TEXT, play_count INTEGER DEFAULT 0,
  cloud_path TEXT              -- set once backed up to your cloud
)
```

- **Reuse.** `/speak` computes the id first. If the row and file exist it
  skips the TTS call and plays the saved clip; otherwise it synthesizes and
  inserts. This also makes repeating a schedule free.
- **API.** `GET /clips?q=&tag=&favorite=` for search, `POST /clips/:id/play`,
  `PATCH /clips/:id` (title, tags, favorite), `DELETE /clips/:id`.
- **UI.** A Clips card with search, a play button, a star for favorites, and
  "use as template" which fills the form. The scheduler picks from the same list.
- **Disk limit.** Disk is the scarce resource, so set a cap (for example
  500 MB). When it is exceeded, delete the least recently played
  non-favorites, but keep the database row so the clip can be re-fetched from
  the cloud or re-synthesized.
- **Backup.** Copy favorites to the cloud with rclone (`cloud:Clips`) and save
  `cloud_path`, so a clip that was evicted locally can be restored.

## 3. Generate an audio file and share it through your cloud

Two parts: make a file without playing it, then publish it.

- **Generate only.** `POST /synth` already writes a file without playing it. With
  the catalogue it also records the clip and returns its `id`.
- **Upload.** `POST /clips/:id/share` copies the file to the cloud folder with
  `rclone copyto` (`cloud:Shared/<title>.<ext>`) and stores `cloud_path`.
- **Link.** Return a share link from `rclone link cloud:Shared/<file>`. This
  works for Nextcloud/ownCloud, Google Drive, Dropbox and OneDrive, but not for
  every storage type, so confirm which cloud you use before relying on it.
- **No-cloud alternative.** `GET /clips/:id/file?exp=...&sig=...` serves the
  file straight from the VPS with a time-limited HMAC-signed URL, so you can
  hand someone a link without exposing the API key. Bandwidth comes from the
  VPS, so use it for occasional sharing, not distribution.
- **UI.** In the form, a "Generate and share" button that shows the link with a
  copy button; in the Clips list, a share action on each clip.

## Suggested order

1. Get the repo pushed, then run the Liquidsoap and Icecast setup on the VPS
   end to end (everything else builds on this).
2. Provider interfaces with the Google adapter moved over unchanged.
3. Clip catalogue with reuse by hash, plus the Clips card.
4. Share to cloud.
5. LLM drafting.
6. Scheduler, which can pick from the catalogue.
7. Rate limits, tests and cleanup, alongside each step.
