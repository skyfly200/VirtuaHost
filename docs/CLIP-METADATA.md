# Clip metadata (passing details along with a clip)

Every clip carries a small set of details so other systems (RadioDJ, Liquidsoap, an Icecast now-playing page, your own scripts)
can use it without asking the site: what it is, who it is about, and **when it expires**. The same data is kept in four places.

| Where | How to read it |
|---|---|
| **Inside the audio** | MP3: ID3v2.4. WAV: `LIST/INFO` plus a `vhmd` chunk with the full JSON. Any tag reader works (`ffprobe -show_format`, Mp3tag, ...). |
| **Beside the audio** | `GET /api/clips/:id/meta` returns JSON. The station daemon also writes `<id>.json` next to each clip it receives. |
| **In the queue** | Each item the station daemon collects carries `info` and `expiresAt`. |
| **On air** | The daemon passes it to Liquidsoap as `annotate:` metadata, so it appears in the stream's now-playing. |

## Fields

| Field | Meaning |
|---|---|
| `title`, `artist`, `album` | Display fields. `artist` defaults to `STATION_NAME`; `title` to the event name or the first words spoken. |
| `kind` | `promo`, `station-id`, `link`, `drop`, ... (also the genre tag) |
| `tags`, `persona`, `station`, `source` | Free tags, the persona id that voiced it, the station profile id it is for (docs/STATIONS.md), where it came from (`flier`, `host`, `schedule`, `generate`, `browser`). |
| `event` | `{ name, startsAt, endsAt, venue, address, price, performers[], url, phone, description }` for event promos. |
| `expiresAt` | ISO 8601 instant. **Nothing plays a clip after this.** |
| `extra` | Up to 12 short text pairs for your own systems. |

## ID3 frames (MP3)

`TIT2` title, `TPE1` artist, `TALB` album, `TCON` kind, `TDRC` created, `COMM` the spoken words, and `TXXX` frames named
`expires`, `kind`, `persona`, `event`, `event_starts`, `clip_id`, and `virtuahost` (the whole JSON).

## WAV

`LIST/INFO`: `INAM` title, `IART` artist, `IPRD` album, `IGNR` kind, `ICMT` spoken words, `ICRD` date, `ISFT` "VirtuaHost".
A custom `vhmd` chunk holds the full JSON (players ignore chunks they do not know).

## Liquidsoap annotate keys

`title`, `artist`, `album`, `genre` (the kind), `comment` (the spoken words), `expires`, `event`, `persona`, `source`.
Read them in a Liquidsoap script as `m["expires"]`, or from Icecast's `status-json.xsl` as the track's title/artist.

## Expiry

A clip with `expiresAt` in the past is **not sent, not queued, not scheduled and not played**:

- the site refuses to queue or send it, and the queue skips an item that expires while it waits;
- the station daemon rechecks at the moment it would play it and reports the item `skipped: expired`;
- a schedule has an `until` date: it makes clips that expire then, and stops running after it;
- the Studio and the Flier tab show an "expires" chip, and "expired" once it has passed.

The daemon uses its own clock for the last check, so keep the station's time correct (NTP).

## Setting it

- **API**: `POST /api/generate` takes `info`; `POST /api/clips` takes `info` inside the `x-clip-meta` header JSON;
  `POST /api/schedules` takes `until` and `info`.
- **Premix scripts**: a `# expires:` header (ISO 8601) and `# kind:` set them for `--publish`.
- **Flier tool**: fills it in from the event on the flier, with the event's end as the expiry.
