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

## Voice and models: who speaks and who writes

A **persona**, the **virtual host**, a **station** and a **flier promo** can each carry a *speech model and voice* (what speaks) and a
*writing model* (what writes the words). A blank means "use the next one down", and the pickers show what that is:

> request (or a choice on the promo/host) → the persona's → the station's defaults → the site's default

So CHIP can always speak with one voice and be written by one model, while a promo for that persona can still choose another voice for
one night. Each picker has a play button to hear the result, and picking a different speech model clears the voice (voices differ per
model). A writing model that is no longer on your list falls through to the next one; one you ask for by name that is not offered is an error.

## Settings that belong to each station

Open a saved station in the Stations tab (Edit) and you get its own:

- **Sending clips**: put new clips on air as soon as they arrive, and may cut in over a live DJ. A request, a schedule or a button press still wins; with no station these come from `STATION_AUTOPLAY` / `STATION_PREEMPT`.
- **Defaults** for how new clips sound (persona, speech model, voice) and the audio treatment the station applies (`defaultFx`).
- **Virtual host**: on/off, how often, persona, lines (example lines or the AI), audio treatment, skip list, whether it may cut in over a live DJ. It starts from the station's own persona, voice, treatment and skip list; what you save on top wins. Its status (now playing, the waiting link, counters) is reported per station.

A daemon started with `STATION_ID=<id>` reads and reports exactly that station's host settings; another station's daemon never sees them.

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
