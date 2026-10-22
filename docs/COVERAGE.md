# Coverage areas: where a station is heard

Why: to know **which stations an event is relevant to**, which alerts matter to a station, and eventually how many people a drop reaches. This page is the design and what exists today.

## What exists today: the quick model

Enter a station's **transmitter power, antenna and height** in the Stations tab (*Transmitter and antenna*) and the site draws a **circle (omni antenna) or rough ellipse (directional)** around its location for three signal levels. It is a planning estimate for questions like *is this alert or event inside where we are heard*, not a coverage study. **It ignores terrain.**

How it works (`lib/propagation.ts`; every step is a plain formula):

1. **ERP** = transmitter power x antenna gain (dB over a half-wave dipole) less cable loss. If you know the ERP (a datasheet or your own figure), enter it and it wins.
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

Terrain and clutter beyond a flat allowance, ground conductivity, antenna vertical pattern and tilt, polarization, the receiver's real sensitivity, interference from other stations, and night-time and weather effects. If you need a more exact picture, use terrain-aware software (below).

## These are FM stations

Way High and Greenlight are **FM broadcast** stations, so the model's choices are FM ones: the planning levels (70, 60 and 48 dBuV/m) are the usual FM-style steps, the receiver is a car or portable radio at 1.5 m, and the frequency you enter should be on the 88 to 108 MHz band. The 5 W in the examples is only an illustration: enter the station's real power. The quick model uses one antenna height and a simple formula, so it will not match a terrain-aware prediction (the standard FM contour methods use height above average terrain over several radials); that is the gap the Nautel import below closes.

## Adding a Nautel (or any terrain-aware) coverage map later

The quick model is a stand-in. When you have a real prediction from Nautel's tool (or SPLAT!, Radio Mobile, or another terrain-aware program), the plan is to **store its contours on the station instead of the estimate**, and everything that uses coverage (which stations an event is near, which alerts to follow) switches to them automatically. **The import itself is not built yet**; this is what to prepare so it is a quick job when it is, and what it will do.

### 1. Make the prediction and save what went into it

Run it for each station with the **real** numbers, and write these down next to the file (they go in the station's notes, and later in the import):

| Record | Why |
|---|---|
| Station and frequency | which map is which |
| ERP (and where it came from), antenna type and pattern file, antenna height above ground **and HAAT**, transmitter site coordinates | so a number can be traced and redone |
| The terrain data and propagation model the tool used (and its version), receiver height, the date | predictions change with these |
| The **signal levels** of each contour (for FM usually 70, 60, 54 or 48 dBu: whatever the tool drew) | each polygon needs its level |

### 2. Export the contours as vector shapes, not a picture

You want **polygons**, one per signal level, not a screenshot. Look in the tool's export or share menu for **KML/KMZ**, **GeoJSON**, or a **shapefile** (and "contour" or "coverage polygon" rather than "image" or "heat map"). **I could not confirm which formats Nautel's tool exports**; if it only offers an image or a PDF, ask Nautel support for the contour polygons (KML is the common one), or trace the outline over a map by hand as in step 4.

### 3. Convert to GeoJSON if needed

The import will take **GeoJSON**: a `FeatureCollection` of `Polygon` or `MultiPolygon` features, coordinates as `[longitude, latitude]` in **WGS84** (ordinary GPS coordinates), with each feature's properties naming its level:

```json
{ "type": "FeatureCollection", "features": [
  { "type": "Feature", "properties": { "level": "good", "dbu": 60 },
    "geometry": { "type": "Polygon", "coordinates": [[[-105.31, 40.0], [-105.2, 40.05], "..."]] } }
] }
```

To convert from KML or a shapefile: open it in [geojson.io](https://geojson.io) and copy the JSON, or use `ogr2ogr -f GeoJSON out.geojson in.kml` (GDAL) or `mapshaper in.kml -o out.geojson`. If a KMZ, unzip it first (it is a zip holding a KML). If the file is not in WGS84 (a shapefile with a projection), convert with `ogr2ogr -t_srs EPSG:4326`.

Name the levels the way the app does so they line up with the quick model: `strong` (about 70 dBu), `good` (60) and `fringe` (about 48 to 54). A different set of levels is fine; keep the `dbu` number on each feature and say which one should count as "good" (the one used for "is this inside our coverage").

### 4. If you only have a picture

Open the map image in [geojson.io](https://geojson.io), trace each contour with the polygon tool over the satellite or street map (zoom in; a contour traced with 30 to 100 points is plenty), set the properties as above, and note in the station that it was traced by hand.

### 5. Keep it small

Simplify each ring to roughly 500 points or fewer (mapshaper's `-simplify 10%` keeps the shape; the station profile is stored in the site's database and large shapes slow every page that lists stations). Files over about 1 MB will be rejected.

### What the import will do (planned)

- A box on the station page (**Coverage: import a map**) accepts the GeoJSON, shows it on the ring diagram next to the quick estimate, and asks which level counts as "good".
- It is saved on the station with where it came from (Nautel, the date, the inputs from step 1), and **replaces the quick estimate** wherever coverage is used. The estimate stays available to compare against.
- "Is this point covered" becomes a point-in-polygon test; the alert probes (the centre plus points around the edge) are taken from the polygon's actual boundary, so ridges that block the signal are respected.
- Population served (Census data) and overlap between stations, from [the ladder below](#the-model-so-it-can-grow), build on the same polygons.
- The MCP `station_coverage` tool will report which source is in use.

Until then nothing is lost by waiting: keep the exported files and the inputs in step 1 somewhere safe (and out of the repo if they contain details you would rather not publish).

## The model, so it can grow

A station's coverage is meant to be a small object that callers never look inside, so the shape can improve without changing them. The ladder:

1. **Circle or rough ellipse from power and antenna** (done, above): good enough for "is the event or alert in range".
1b. **Imported contour** (next, cheapest accurate step): upload a KML/GeoJSON contour from a terrain-aware tool (Nautel's, SPLAT!, Radio Mobile) and store it on the station in place of the estimate: [how to prepare it](#adding-a-nautel-or-any-terrain-aware-coverage-map-later).
2. **Contour polygon:** a GeoJSON polygon, drawn by hand or imported (for an FM station, a terrain-aware prediction; for an internet stream, the *audience* area you choose: a city, a county list, a region).
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

- Do we model **transmitter contours** (FM/AM), **audience areas** (internet), or both on one station?
- County/zone lists versus drawn polygons as the main way to edit (a map editor needs a map library and tile source: a deliberate choice, since the site has no build step and no map today).
- Which population data to use (Census is public domain; check any other source's terms).
- Where the geometry lives (the station profile in Blobs is fine for hundreds of points, not for large polygons; simplify, or store polygons as separate blobs).
