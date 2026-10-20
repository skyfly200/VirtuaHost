# Tone and nonverbal cues by speech model

Not every speech model can act on a tone direction or an inline cue such as `[laughs]`. The app keeps a table
(`lib/cues.ts`) and uses it three ways: the Generate tab shows what the chosen model supports, a tone is sent only in the
form the model takes, and inline `[tags]` are removed for models that would read the brackets aloud
(the response says so with `cueTagsRemoved` / `toneIgnored`).

| Model | Tone direction | Inline tags (`[whispers]`, `[laughs]`, `[short pause]`) | Basis |
|---|---|---|---|
| `google/gemini-*-tts` (and direct Gemini) | yes, written into the text | performed | documented by Google and several hosts |
| `openai/gpt-4o-mini-tts-*` | yes, via `instructions` | not performed, removed | tone documented; tags assumed |
| `mistralai/voxtral-*` | none: delivery follows the chosen voice | not performed, removed | assumed from Mistral's "voice as instruction" description |
| `hexgrad/kokoro-82m` | none | not performed, removed | assumed |
| anything else | sent as an instruction | left in the text | unknown |

"Assumed" means no source confirmed it either way, so listen to a clip with a `[laughs]` and a tone before relying on it,
then correct the table in `lib/cues.ts` if the model surprises you. Gemini tag spellings vary between sources
(`[whispers]` / `[whispering]`, `[laughs]` / `[laughing]`); put a tag at the start of a sentence and never two side by side.
