# Live conditions, conditional drops and station context

Three pieces that work together. None of it has been verified against the live Open-Meteo or National Weather Service services.

## 1. Station context (the "area" layer)

Stations tab, "About the area": a free-text description plus **key roads** (name | other names | lat,lon | note).
It is added to every AI writing prompt for that station (Studio drafts, schedules, flier promos, conditional drops), so a brief like
"road conditions" already means the listed roads. The writer is told not to name roads that are not listed. It is the `context`
object on the station profile (`lib/station-context.ts`), so copying it to another station (for example Green Light Radio) is
copy and paste of that object.

Example for Way High Radio:

- About: Way High Radio is in Ward, Colorado, in the foothills above Boulder. Listeners cross the canyon and the mountain highway daily.
- Roads: `Left Hand Canyon Drive | Left Hand Canyon, the canyon | 40.1,-105.38 | the main road down to Boulder` and `Peak to Peak Highway | Peak to Peak`

(Check the coordinates on a map: they are the points whose weather is used for each road.)

## 2. Live inputs for AI drafts vs placeholders

- **Placeholders** (`{{time}}`, `{{weather}}`, `{{alert}}`) are for values that change between writing and air time; filled in just before speaking.
- **Use current conditions** (Studio checkbox next to "Draft with AI"; `live: true` on `POST /api/generate` and `/api/scripts/draft`; "Give the AI the current weather..." on an AI schedule) puts a "right now" block in the prompt: weather, active NWS alerts, and road ice/snow risk. The writer is told to use only those facts and to use a placeholder where a value may change before air.
- `GET /api/live?station=<id>` shows exactly what the writer and the conditions see.

## 3. Conditional drops

On any schedule, "Only run when a condition is true". It is checked each time the schedule comes due, so use "Every so often" for the check cadence (minimum 5 minutes). The scheduler already runs every minute.

Conditions: ice or snow likely on a road (at least watch/high, one road or any), an NWS alert (types, minimum severity), temperature at or below/above a line, raining or snowing.

- **Road risk is an estimate from the weather at the road's point** (freezing with precipitation, snow, freezing rain, looking 4 hours ahead). It is not a road sensor, DOT feed or closure report, and the writer is told not to claim closures or crashes.
- **Fails closed**: if weather or alerts cannot be read, the condition is not met and nothing runs.
- **Dry run by default**: the schedule records "dry run: would have run (reason)" and makes nothing. Untick "Dry run" to go live.
- **Cooldown**: at least N minutes between runs (default 180).
- A check that does not fire is not a run: it does not count toward "stop after N runs". The result is shown under the schedule.
- Not yet: active-hours windows and a real road feed (a state DOT source would be a new input in `lib/live-inputs.ts`).
