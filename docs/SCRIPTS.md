# Scripts, the Studio and conversations

The **Studio** tab replaces the old Generate and Voice Lab tabs. It is one page: write a script, cast it, have the AI draft it, hear it in up to four voices side by side, then save it, schedule it or send it. A **script** is what is said plus who says it, and it can be reused in the Studio, in site schedules and in the hub's dynamic slots.

## The model (`lib/scripts.ts`)

| Field | Meaning |
|-------|---------|
| `kind` | `single` (one voice) or `conversation` (2 to **4** speakers) |
| `cast` | per speaker: `name` (the label in the text, up to 24 characters, no colon, unique), `personaId`, `voice`, `speechModel`, `role` (told to the AI writer: "host", "skeptical caller") |
| `text` | one voice: plain text. Conversation: `Name: line` per line, at most 40 lines, 6,000 characters. May contain `{{placeholders}}` (time, weather, station...) |
| `topic`, `format`, `seconds` | what the AI is asked to write about, the kind of script (station ID, weather report...) and the target length |
| `gapSeconds` | the pause between lines of a conversation (0 to 3) |

Saving checks the rules and says exactly what is wrong (a fifth speaker, a line from someone not in the cast, text over the limit). Placeholders are **never** filled in when saving: they are filled each time the script is used, so the time and weather are right whenever it airs.

## Casting first, then drafting

Choose the speakers (each with a persona) before the text. In a conversation you pick two to four; in one-voice mode one. **Draft with AI** (`POST /api/scripts/draft`) gives the writer every speaker's persona brief, tone and role, the topic, the format and the length, and asks for `Name: line` text in each voice. The result is checked: only cast members speak (others are dropped and counted), every speaker must speak, and a speaker that copies an example line from their own persona's brief is asked again once (the response says `copiedExample` if it still does). Bold labels like `**Dale:**` are understood. Weather in a script uses `{{weather}}`, `{{temp}}`, `{{conditions}}` and `{{city}}`: they need the station's city or coordinates (the Studio shows the station's warning when they are missing).

## Speaking it (`mode: "script"` on `POST /api/generate`)

Each line is spoken in its speaker's voice (the cast entry, else the persona, else the station default) and the lines are joined into one clip (`lib/script-clip.ts`, `lib/audio-join.ts`). Send either `scriptId` (the `text` you also send wins) or an inline `cast` and `text`; `preview: true` returns the audio without saving. Limits you should know about:

- **WAV** (for example Gemini voices): joined sample by sample with a real silent gap.
- **MP3** (most others): joined frame by frame; **no gap can be added** without an encoder.
- **Mixed formats** (WAV with MP3) are refused with a clear message. Pick voices from one provider. (The browser version in the Studio joins any mix, because it decodes first.)
- A scheduled run has about 30 seconds; lines are spoken three at a time. Keep scheduled conversations to a handful of lines. *Not verified against real speech services.*

## Using a script elsewhere

- **Studio:** the saved-script list loads one; **Save script** stores it; every take has **Save to library** and **Save and schedule**.
- **Site schedules:** content kind **Saved script** (`{kind: "script", scriptId, fresh}`). With `fresh` the AI writes a new version from the script's topic and cast on every run; without it the saved text is said with placeholders filled in fresh. The Studio's **Schedule this script** and **Save and schedule** buttons open the Schedules tab prefilled (`sessionStorage.scheduleDraft`: `{clipId}`, `{text}` or `{scriptId}`).
- **Dynamic slots (hub):** a slot may carry `script: {id, mode}`. `fixed` says the saved text filled in for the air time; `draft` has the AI write a new version (with the slot's allowed names and facts) shortly before it airs. The words (not the speaker labels) go through the same validation as every dynamic line; a fixed script's own text is trusted (a person wrote it). Speech goes through `mode: "script"`. The service key needs the scopes `generate` and `scripts.read`.

## API

`GET|POST /api/scripts`, `GET|PUT|DELETE /api/scripts/:id` (owners and admins; shared scripts are read-only to others), `POST /api/scripts/draft`, `POST /api/scripts/filled` (a saved script with placeholders filled for a moment: `{scriptId, at, station}`).
