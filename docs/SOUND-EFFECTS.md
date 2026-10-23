# Sound effects in generated audio

`[sfx:name]` tags in a line or script become real sound between the spoken words.

```
Host: [sfx:phone wait=0.6] Green Light Radio, you're on the air.
Caller: [sfx:static over] Hey, it's Dale!
```

| Tag | Meaning |
|---|---|
| `[sfx:ding]` | the effect, between the words before and after |
| `[sfx:whoosh over]` | laid over the start of the words that follow |
| `[sfx:crowd vol=0.5]` | quieter or louder (0 to 2) |
| `[sfx:beep wait=0.5]` | then a pause (0 to 5 seconds) |
| `[music:name vol=0.2]` | a background bed under all the speech (0 to 1, default 0.25), 0.8 s lead in, 1.5 s fade out, looped if short; one per clip |
| `[intro:name vol=1]` | a clip played before everything else; one per clip |
| `[outro:name vol=1]` | a clip played after everything else; one per clip |

Built-in effects (synthesised, no files, no copyright questions): `ding chime beep buzzer whoosh riser fall laser static click heartbeat alarm phone drumroll crowd`. A name that is not built in is looked up in the sound library (`docs/LIBRARY.md`): files you **upload** (below) and the cloud folders. On the server only **WAV** library files can be used; uploads are always WAV (the browser converts them).

## Where it works

| Where | How |
|---|---|
| Studio (preview and save) | mixed in the browser (effects, background, intro, outro) |
| `POST /api/generate` (say, ai, script), schedules, host links, hub slots | mixed on the server by `lib/sfx-mix.ts` (effects, background, intro, outro) |

On the server each stretch of words is spoken separately (one speech call per stretch, so a line with two effects costs three calls) and the effects are mixed between them at the voice's sample rate. At most 8 effects per clip.

**Limits.** The voice has to return WAV: Gemini and Google speech models on OpenRouter do. MP3 voices (ElevenLabs, most other OpenRouter models) cannot be mixed on the server, so their tags are removed and the response says so. Unknown names (or library files that are not WAV) are skipped and reported. Not verified against live providers.

The response (`POST /api/generate`, preview and saved) carries `sfx: { applied: [...], skipped: [...] }`. `sfxTagsRemoved: true` appears only when no effects were mixed.

## Letting the AI choose

Send `sfx: true` with `mode: "ai"` on `/api/generate`, or on `/api/scripts/draft`, or tick **AI may add sound effects** in the Studio (and in a schedule's AI brief, `content.sfx`). The writer is told the available names (built-in plus library) and to use at most two per line, between sentences. Without it the writer is told to write no cues. The hub's just-in-time slots do not ask for effects, and a fixed script with tags going through the hub's text checks has not been tried.

## Uploading your own background, intro and outro

Library tab > Music, Intros, Outros or Sound effects > **Upload**, or the **Upload a file** button in the Studio's *Background, intro and outro* section or a schedule's form.

- Any audio your browser plays (mp3, wav, m4a, ogg, flac). The browser converts it to mono 32 kHz WAV before upload (so the server can mix it), and keeps at most 30 s of an effect, 60 s of an intro or outro and 80 s of music (the upload limit is about 5 MB).
- The file gets a tag-safe name from its file name (`My Show Intro.mp3` becomes `my-show-intro`; a clash gets `-2`). Built-in effect names are never reused.
- Files are shared by the whole station. Its owner or an admin can rename or delete it (Library tab). Non-admins can keep `UPLOAD_MAX_PER_USER` files (default 50).
- Stored in Netlify Blobs (store `dj-uploads`), listed by `GET /api/uploads`, offered through `GET /api/library` as source `uploads`. API: `POST /api/uploads` (audio body, `x-upload-meta` URI-encoded JSON `{kind, name?, file?, seconds?}`), `PATCH` and `DELETE /api/uploads/:id`.

## Choosing them

- **Studio**: pick from the lists (or upload) and the choices are written into the script as `[intro:x] [music:y vol=0.2] ... [outro:z]` (in a conversation: on the first and last spoken line), so they are saved with the script. Pick *None* to remove them.
- **Schedules** (text and AI lines): the same pickers; stored as `content.audio` (`{ bed, bedVol, intro, outro }`) and wrapped around the line each run. Not for saved-script or saved-clip schedules, which carry their own audio.
- **API**: `audio: { bed, bedVol, intro, outro }` on `POST /api/generate` (say and ai modes).
