# Station profiles

A **station profile** is data about a station kept on the site: you can set one up before it has any server. Open the **Stations** tab, add
a station, and choose **Work on this station** (or pick it in the header). Every other tab then uses it.

| Field | Used for |
|---|---|
| Name, tagline | AI-written lines say the station's name ("You are the on-air DJ for ...") and know its tagline; `{station}` in a persona's lines becomes the name. |
| Time zone | The default for schedules (daily at 07:30 means 07:30 *there*) and for flier promos (dates and the expiry are in the station's clock). |
| Default persona, speech model, voice | New clips for this station use them when the request names none (a request, then a persona, then the station). |
| Audio treatment | The fx preset the station applies to queued clips (for example `hull`). |
| Skip list | Spots and relays the virtual host says nothing over or about. |
| Call sign, frequency, genres, city, links, contact, notes | Shown on the card and available to other tools; nothing depends on them. |
| Connection | A note of what the station will connect to later (Chips Voice, RadioDJ, Icecast, a hub id). Nothing connects. |

## What gets tagged with the station

Clips made while a station is active carry `info.station` (its id, also an ID3 `station` frame), schedules and flier repeats record
`stationId`, and queue items carry it. A station daemon started with `STATION_ID=<id>` collects only its own station's items (and items
with no station), so several stations can share one site.

The Stations tab shows, for each station, what the site holds for it: clips, promos, schedules (and the next run), items waiting for its
daemon, and when its virtual host last reported.

## API

`GET/POST /api/stations`, `GET/PUT/DELETE /api/stations/:id`, `GET /api/stations/:id/summary`. `POST /api/generate`, `/api/flier/*`
accept `station` (an id); `GET /api/options?station=<id>` fills the examples with that station's name. With no stations made, the API
offers one placeholder named from `STATION_NAME`.

## Connecting a real station later

Nothing here changes: start the daemon with `STATION_ID` (see `station-daemon/README.md`) and the site's queue, host and schedules for that
station start flowing to it. The old hub controls (several live stations on one screen) are the **Control** tab.
