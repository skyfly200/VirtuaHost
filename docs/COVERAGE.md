# Coverage areas: where a station is heard

Why: to know **which stations an event is relevant to**, which alerts matter to a station, and eventually how many people a drop reaches. This page is the design and what exists today.

## What exists today

- A station has a **place** (found by name in the Stations tab: town, state, country; coordinates and time zone are filled in) and optionally a **coverage radius** in km. The place is a point, the coverage is a circle around it.
- `lib/coverage.ts`: `distanceKm` (great circle) and `stationsNear(stations, point)`, which returns the stations that have a location nearest first, each with `distanceKm` and `covers` (the point is inside the circle; `null` when no radius is set).
- **API:** `GET /api/stations?near=<lat>,<lon>` returns the usual `stations` plus `near: [{ id, name, distanceKm, covers }]`. The MCP tool `list_stations` takes `lat` and `lon` for the same thing, and `find_place` turns "Houston, TX" into coordinates first. So an agent can ask: *"There is a festival in Austin: which of our stations should run a promo?"*
- The **place** is also available to drops (`{{place}}`, `{{state}}`, `{{city}}`), to weather and to alerts.

## The model, so it can grow

A station's coverage is meant to be a small object that callers never look inside, so the shape can improve without changing them. The ladder:

1. **Circle** (done): location plus radius. Good enough for "is the event in range".
2. **Contour polygon:** a GeoJSON polygon, drawn by hand or imported. For a licensed FM/AM station, the FCC publishes service contours (FCC Media Bureau data); an internet stream has no contour, so it is the *audience* area you choose (a city, a county list, a region).
3. **Named areas:** a list of counties or NWS zones (UGC codes like `TXC201`). This is the cleanest link to alerts, because NWS alerts are issued by zone and county.
4. **Population served:** intersect the area with a population grid (US Census block/tract data, or a global grid such as WorldPop) to get "about N people", for ranking stations and for population-weighted decisions.
5. **Audience reality:** for an internet stream, blend the geographic model with where listeners actually are (Icecast/Liquidsoap listener IPs, geolocated; aggregate and anonymised, never stored per person).

## What it will drive (planned, not built)

| Use | How |
|---|---|
| **Which stations run a drop for an event** | score = overlap of the event location (point or area) with each station's coverage, weighted by population; rank and suggest, with `covers` and `distanceKm` shown. Flier tool: after reading a flier's venue, suggest the stations to promote it on. |
| **Which alerts matter** | an NWS alert's polygon or zones against the station's coverage; relevant if they overlap, severity weighted by population affected. Replaces "a single point" watches in the hub ([ALERTS.md](ALERTS.md)). |
| **Population and reach modelling** | people served per station, overlap between stations (do two stations cover the same listeners?), reach of a campaign across stations. |
| **Hub grouping** | "broadcast to every station that covers this county". |

## Decisions we should make before building the next rung

- Do we model **licensed contours** (FM/AM), **audience areas** (internet), or both on one station?
- County/zone lists versus drawn polygons as the main way to edit (a map editor needs a map library and tile source: a deliberate choice, since the site has no build step and no map today).
- Which population data and licence (Census is public domain; check any other source's terms).
- Where the geometry lives (the station profile in Blobs is fine for hundreds of points, not for large polygons; simplify, or store polygons as separate blobs).
