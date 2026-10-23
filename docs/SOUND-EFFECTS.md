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

Built-in effects (synthesised, no files, no copyright questions): `ding chime beep buzzer whoosh riser fall laser static click heartbeat alarm phone drumroll crowd`. A name that is not built in is looked up in the connected sound library (`docs/LIBRARY.md`); on the server only **WAV** library files can be used.

## Where it works

| Where | How |
|---|---|
| Studio (preview and save) | mixed in the browser, plus `[music:]` beds |
| `POST /api/generate` (say, ai, script), schedules, host links, hub slots | mixed on the server by `lib/sfx-mix.ts` |

On the server each stretch of words is spoken separately (one speech call per stretch, so a line with two effects costs three calls) and the effects are mixed between them at the voice's sample rate. At most 8 effects per clip.

**Limits.** The voice has to return WAV: Gemini and Google speech models on OpenRouter do. MP3 voices (ElevenLabs, most other OpenRouter models) cannot be mixed on the server, so their tags are removed and the response says so. `[music:name]` beds are not mixed on the server (removed and reported); use the Studio. Unknown names are skipped and reported. Not verified against live providers.

The response (`POST /api/generate`, preview and saved) carries `sfx: { applied: [...], skipped: [...] }`. `sfxTagsRemoved: true` appears only when no effects were mixed.

## Letting the AI choose

Send `sfx: true` with `mode: "ai"` on `/api/generate`, or on `/api/scripts/draft`, or tick **AI may add sound effects** in the Studio (and in a schedule's AI brief, `content.sfx`). The writer is told the available names (built-in plus library) and to use at most two per line, between sentences. Without it the writer is told to write no cues. The hub's just-in-time slots do not ask for effects, and a fixed script with tags going through the hub's text checks has not been tried.
