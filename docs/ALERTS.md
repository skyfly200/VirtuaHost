# Weather and emergency alerts (United States)

VirtuaHost can listen to the **US National Weather Service (NWS)** for alerts in a station's area, put them in drops, and (in the hub) say them on air. It is built so it belongs to the **hub**: the hub is the thing that stays running next to the stations, so it is the thing that watches and acts. The site gets a read-only side (placeholders and a lookup) that uses the same data.

> **What this is.** A relay of the alerts the National Weather Service publishes, spoken in plain voice and labelled as National Weather Service alerts. It does not decode EAS/SAME messages and does not play the EAS attention tones: it reads the NWS web service, not the EAS chain.

## Where the data comes from

[`api.weather.gov`](https://www.weather.gov/documentation/services-web-api): free, no key, but it asks every client to send a `User-Agent` that says who you are. Set `ALERTS_CONTACT` (an email or URL) on the hub and on the site. It does not push, so we poll (the hub every 2 minutes by default; the site caches a minute).

Only **real** alerts are used: `status` must be `Actual` (never Test or Exercise), cancellations are ignored, and expired alerts are dropped. **Not verified against the live service** (it could not be reached while this was written): the request and response follow the NWS documentation (`features[].properties`: `id`, `event`, `severity`, `headline`, `instruction`, `areaDesc`, `expires`, `status`, `messageType`).

## On the site (read-only)

- **Placeholders** in drops ([DROPS.md](DROPS.md)): `{{alert}}` (the most serious active alert's event, e.g. "Tornado Warning"), `{{alert_headline}}`, `{{alert_area}}`, `{{alert_count}}`. They are **empty when there is no alert**, so always give a fallback: `{{alert|No weather alerts right now}}`. Needs a station location. Minimum severity is Moderate (`ALERT_MIN_SEVERITY` changes it).
- **`GET /api/alerts?station=<id>[&min=Severe]`**: the active alerts for that station's location, most serious first.
- **MCP**: the `active_alerts` tool ([MCP.md](MCP.md)).

## In the hub (watches and actions)

A **watch** says where to listen and what to do. The hub keeps its watches in its data file, checks them every `ALERTS_POLL_SECONDS` (default 120; `0` turns polling off), and handles each alert **once per watch**.

| Field | Meaning |
|---|---|
| `name` | a label |
| `lat`, `lon` (+ optional `radiusKm`, 0 to 300: also listen around the edge) **or** `zone` (like `TXZ213`) **or** `area` (a state like `TX`) | where to listen |
| `minSeverity` | `Unknown`, `Minor`, `Moderate`, `Severe` (default) or `Extreme` |
| `events` | optional list ("Tornado Warning", "Flash Flood Warning"); empty = any |
| `action` | `notify` (default): only record it. `broadcast`: speak it and play it |
| `stations` | hub station ids to play on (default all); only for `broadcast` |
| `preempt` | let it cut in over a live DJ |
| `prefix`, `suffix` | optional words before and after, e.g. "Weather alert." |

**Nothing airs unless a watch is set to `broadcast`**, and `broadcast` needs the hub connected to a Chips Voice server (`VOICE_URL`, `VOICE_KEY`) to make the audio. What is said is deterministic and short: your prefix, the NWS **headline** ("Tornado Warning issued October 21 at 4:00PM CDT until 5:00PM CDT by NWS Houston/Galveston TX"), the **first sentence of the NWS instruction** ("Take cover now!"), your suffix. Nothing is added that the NWS did not say, and no AI writes it. A broadcast that fails (a station offline) is retried on the next poll rather than lost.

Hub API (same key as the rest of the hub; also reachable through the site's `/api/hub/*` proxy and the MCP `hub_*` tools):

| Call | Does |
|---|---|
| `GET /alerts` | the watches and the recent log |
| `POST /alerts/watches`, `PUT /alerts/watches/:id`, `DELETE /alerts/watches/:id` | manage watches |
| `POST /alerts/check[?dry=1]` | check now; `dry=1` shows what would be handled and records nothing |
| `GET /alerts/active?lat=&lon=` (or `zone=`, `area=`) | what is active at a place, no state kept |

Start with `notify`, look at the log for a few days (`POST /alerts/check?dry=1` any time), then switch one watch to `broadcast`. Keep `minSeverity` at Severe or above and list the events you really want on air.

## Listening across the whole coverage area

A point only catches alerts over that exact spot. If the station has a transmitter (or a coverage radius), the site asks the NWS about its own spot **and eight points around the edge of where it is heard** (the "good" coverage reach, [COVERAGE.md](COVERAGE.md)), keeps each alert once, and uses the most serious. A hub watch does the same when you give it `radiusKm`: use the station's good reach from `GET /api/coverage?station=` (about 6 km for the reference 5 W setup). The probes are cached for a minute, so a station with coverage costs nine small NWS requests per minute at most.

## Making a watch from a station

A station's location (set by name in the Stations tab: [STATIONS.md](STATIONS.md)) gives the watch its `lat` and `lon`. Today you create the watch with those numbers (the `find_place` MCP tool, or `GET /api/stations`, gives them to you). **Planned:** a "Weather alerts" card on the station page that creates the hub watch for you, and, once stations have coverage areas ([COVERAGE.md](COVERAGE.md)), watches by coverage area instead of a single point, so an alert is relevant if its polygon overlaps where the station is heard.

## Planned, not built

- Coverage-aware relevance (alert polygons against station coverage; `geometry` is in the NWS response) and population-weighted severity.
- A repeat policy (say it again every N minutes while in force) and quiet hours.
- Canada (Alert Ready / NAAD) and other countries, behind the same watch shape.
- An operator approval step in the Stations tab before a `broadcast` watch goes live for a new event type.
