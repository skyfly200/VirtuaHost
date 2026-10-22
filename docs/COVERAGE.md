# Coverage areas: where a station is heard

Why: to know **which stations an event is relevant to**, which alerts matter to a station, and eventually how many people a drop reaches. This page is the design and what exists today.

## What exists today: the quick model

Enter a station's **transmitter power, antenna and height** in the Stations tab (*Transmitter and antenna*) and the site draws a **circle (omni antenna) or rough ellipse (directional)** around its location for three signal levels. It is a planning estimate for questions like *is this alert or event inside where we are heard*, not a coverage study. **It ignores terrain.**

How it works (`lib/propagation.ts`; every step is a plain formula):

1. **ERP** = transmitter power x antenna gain (dB over a half-wave dipole) less cable loss. If you know the licensed/datasheet ERP, enter it and it wins.
2. **Free-space field strength** at distance d: `E = 106.92 + 10 log10(ERP in kW) - 20 log10(d in km)` dB(uV/m).
3. **Radio horizon** `d_h = 4.12 (sqrt(h_tx) + sqrt(h_rx))` km (heights in metres, receiver 1.5 m). Beyond it the field falls **40 dB per decade** instead of 20.
4. **Surroundings** allowance: open 0 dB, suburban 8 dB, dense city 16 dB (plus any extra loss you enter).
5. **Levels** (the distance where the field falls to): **strong 70**, **good 60**, **fringe 48** dBuV/m: usual FM-style planning levels. "Good" is the one used to decide whether something is inside the coverage area.
6. **Pattern**: omni = the same distance in every direction. Directional: `loss(angle) = min(front-to-back, 3 dB x (angle off the beam / half the beamwidth)^2)`, so -3 dB at the beamwidth edge and never weaker than front-to-back; the distance for each direction uses the ERP reduced by that loss.

Frequency does not change free-space field strength, so it is recorded but not used.

### The reference setup

A **quarter-wave ground-plane antenna, 50 ft above ground, on Mapleton Hill in Boulder** (about 40.0225 N, 105.285 W; approximate: the place finder gives the town, so enter the exact latitude and longitude by hand if you want the hill). Gain is taken as 0 dB over a dipole (typical for a ground plane; set the real figure if the antenna's data sheet says otherwise). Reach in km to each level, receiver at 1.5 m, 50 ft antenna, radio horizon about 21 km:

| Transmitter power | Surroundings | Strong (70) | Good (60) | Fringe (48) |
|---|---|---|---|---|
| 1 W | open | 2.2 | 7.0 | 24.3 |
| 1 W | suburban | 0.9 | 2.8 | 11.1 |
| 5 W | open | 5.0 | 15.7 | 36.3 |
| 5 W | **suburban** | **2.0** | **6.2** | **22.9** |
| 20 W | suburban | 3.9 | 12.5 | 32.4 |
| 100 W | suburban | 8.8 | 24.3 | 48.5 |
| 5 W | dense city | 0.8 | 2.5 | 9.9 |

**Boulder is exactly where a no-terrain model is weakest.** Mapleton Hill is at the foot of the Flatirons: the ridges to the west block the signal far more than this model assumes, and the hill's elevation above the plains to the east helps far more than "50 ft above ground" says. Enter **height above average terrain (HAAT)** if you know it (it replaces the height above ground and usually raises the reach to the east), and treat the western half of any circle as an over-estimate. For a real picture of Boulder, import a terrain-aware contour (below).

### Where it is used

- **Events and broadcasts:** `GET /api/stations?near=<lat>,<lon>` (and the MCP `list_stations` tool with `lat`/`lon`) ranks stations by distance and says whether the point is inside each station's **good** coverage, in the direction of the point (so a directional antenna counts correctly), with the `strong`/`good`/`fringe` reach. With no transmitter it uses a plain radius if you typed one, otherwise `covers` is `null` (unknown).
- **Alerts:** a station asks the National Weather Service about its own spot **and eight points around the edge of its good coverage**, so a warning for the edge of the area counts, not only one over the antenna (`{{alert}}` placeholders, `GET /api/alerts`). A hub watch can do the same with `radiusKm` ([ALERTS.md](ALERTS.md)).
- **API:** `GET /api/coverage?station=<id>` (the model with GeoJSON rings and the assumptions), `POST /api/coverage {lat, lon, transmitter}` (preview while editing), and the MCP `station_coverage` tool.
- The **place** also feeds weather, `{{place}}`, `{{state}}`.

### Not in the quick model (so do not read more into it)

Terrain and clutter beyond a flat allowance, ground conductivity, antenna vertical pattern and tilt, polarization, the receiver's real sensitivity, interference from other stations, night-time and weather effects, and any licensing or regulatory meaning. If you need a result you can defend, use terrain-aware software and, for filings, the regulator's own method.

## The model, so it can grow

A station's coverage is meant to be a small object that callers never look inside, so the shape can improve without changing them. The ladder:

1. **Circle or rough ellipse from power and antenna** (done, above): good enough for "is the event or alert in range".
1b. **Imported contour** (next, cheapest accurate step): upload a KML/GeoJSON contour from a terrain-aware tool (Nautel's, SPLAT!, Radio Mobile) and store it on the station in place of the estimate.
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
