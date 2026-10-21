# Drops, placeholders and the templating engine

A **drop** is a short line the station says: a station ID, a time check, a promo, a link between songs. Drops can contain **placeholders** such as `{{time}}` or `{{weather}}`. The engine fills them in with real values **after the words are written and before they are spoken**:

```
you / the AI writes   ->   engine fills in {{placeholders}}   ->   voice speaks   ->   clip saved
"{{greeting}}, it's {{time}} on {{callsign}}! {{weather|Lovely out there}}."
                      ->   "Good afternoon, it's 3:45 PM on KRAP! 62 degrees and cloudy."
```

Why it matters: an AI never has to guess the time or the temperature (it is told not to), and the **same line is right whenever it is made**, so a schedule that runs every hour says the correct time each run.

## Where it runs

- **Generate tab** (`POST /api/generate`): text you type in *Say verbatim*, and lines the AI writes. With *Ask the AI to write it*, the line you review is already filled in (what you see is what will be said); type `{{placeholders}}` into it yourself if you want them filled in again when the audio is made. For a line that should stay a template (a schedule), save the AI's `template` field or write the text with placeholders.
- **Schedules**: every run fills in fresh values (a daily "time check" is correct each day).
- **Virtual host links** (`lib/host-link.ts`): `{{artist}}` and `{{title}}` of the song, plus everything else.
- Not applied to: the Voice Lab, the older persona line banks' `{artist}` / `{title}` / `{station}` (single braces; those still work as before), or flier promos.

## Syntax

| Write | Gives |
|---|---|
| `{{name}}` | the value of a variable, e.g. `{{time}}` -> `3:45 PM` |
| `{{name\|fallback}}` | the fallback when there is no value, e.g. `{{weather\|a lovely day}}`. **Always give a fallback for weather**: it is the one value that can be unavailable |
| `{{pick: first \| second \| third}}` | one of the choices, at random each time |

Names are case-insensitive. A placeholder with no value and no fallback is removed (the response lists it in `templateMissing`, and the server logs it). Anything that still looks like `{{...}}` is stripped, so it can never be read aloud.

## Variables

| Group | Names | Example value |
|---|---|---|
| station | `station`, `callsign`, `frequency`, `tagline`, `city`, `place`, `state`, `website` (`place` and `state` come from the place found by name in the Stations tab) | Way High Radio, KRAP, 97.7 FM |
| time (in the station's time zone) | `time`, `time_24`, `hour`, `daypart`, `greeting`, `weekday`, `date`, `month`, `day`, `year` | 3:45 PM, 15:45, afternoon, Good afternoon, Wednesday, Wednesday October 21 |
| weather | `weather`, `temp`, `conditions` | 62 degrees and overcast, 62 degrees, overcast |
| alerts (US) | `alert`, `alert_headline`, `alert_area`, `alert_count`: the most serious active National Weather Service alert at the station's location. **Empty when there is none, so always give a fallback**: `{{alert\|No weather alerts right now}}`. See [ALERTS.md](ALERTS.md) | Tornado Warning, Harris TX |
| DJ | `dj`, `dj_tagline` (the persona speaking) | DJ Midnight |
| length | `target_seconds`, `target_words` (from the *Length* choice) | 10, 25 |
| song | `artist`, `title` (host links, song intros) | Ada Lovelace, Analytical Love |
| your own | whatever you define for the station | Joe's Pizza |

`greeting` is "Good morning" (5-11), "Good afternoon" (12-16), "Good evening" (17-20) and "Hello, night owls" (21-4). A variable only exists when the context can fill it: `dj` needs a persona, `weather` needs a station location, `artist`/`title` need a song.

The **Placeholders** panel under the text box in Generate lists what is available right now with today's values; click one to insert it, or press *Preview my text with today's values*. `GET /api/template` returns the same list and `POST /api/template {text, station?, persona?, seconds?}` renders a text (neither calls an AI).

## Telling the AI

When the AI writes a line it is given instructions listing only the placeholders that can be filled in that context (name, meaning, example), the syntax, and the rule *never guess or invent the time, date, weather, names or numbers; use a placeholder*. This costs about 200 more input tokens per request (the cost estimate includes it). Models that ignore the instructions simply write plain text; nothing breaks.

## Length

The Generate tab's **Length** choice (about 5 to 60 seconds) is sent as `seconds`. The writer is told to aim for that many seconds and roughly `seconds x 2.5` words (about 150 words a minute), and `{{target_seconds}}` / `{{target_words}}` are filled in. It is a target: measure the real clip after speaking. Without it the writer keeps to two or three sentences.

## Setting up a station for it

In **Stations -> edit a station**, section *Placeholders for drops*:

- **Where is it?** Find the place by name ("Houston, TX"): the coordinates and time zone are filled in. (Or enter latitude and longitude by hand; with neither, the city is looked up each time.) The same location feeds weather and alerts.
- **Temperature unit**: automatic (Fahrenheit when the station's time zone is in the Americas, otherwise Celsius), or choose.
- **Your own placeholders**, one per line as `name=text`, for example `sponsor=Joe's Pizza` then `{{sponsor}}` in any drop. Names are lowercase words; built-in names (like `time`) cannot be replaced; up to 20.

Weather comes from [Open-Meteo](https://open-meteo.com/) (free, no key), is cached for 10 minutes, and is only requested when a drop actually uses a weather placeholder. **Not verified against the live service**: the requests follow Open-Meteo's public documentation. If it cannot be reached the placeholder uses its fallback or is dropped; a drop never fails because of weather.

## API summary

| Where | Field |
|---|---|
| `POST /api/generate` | `seconds` (3-90); the response's `scriptText` is the filled-in text, `templateMissing` lists unfilled names; with `textOnly`, `scriptText` is also filled in (so no braces ever show) and `template` is the writer's original with its placeholders |
| `GET /api/template` | `?station=&persona=&seconds=` -> variables with values |
| `POST /api/template` | `{ text, station?, persona?, seconds?, artist?, title? }` -> `{ text, used, missing }` |
| Station profile | `lat`, `lon`, `tempUnit` (`F`/`C`), `variables` (`{name: text}` or `name=text` lines) |

Code: `lib/drop-template.ts` (engine, variable list, writer instructions), `lib/handlers/template.ts`, `test/lib/drop-template.test.ts`.
