# CHIP, the computer DJ of Way High Radio

CHIP is the old gravelly computer-captain who runs the transmitter on the haunted interdimensional pirate ship that carries
Way High Radio. Grumbles about the machinery and the fog, secretly fond of the crew and the music. Tagline: **"We're taking radio higher."**
CHIP is a separate voice from Rocky and Britta, part of the same wider pirate crew. The text lives in `chips-voice/googleTextToSpeech1/lib/personas.js`.

## Turn it on

1. Pick or design a voice (an old, low, weathered voice; do not clone a real actor or a famous character). With ElevenLabs add it to
   `ELEVENLABS_VOICES="...,CHIP=<voice id>"`.
2. Apply the preset and your voice: `PUT /host {"preset":"chip","voice":"CHIP","enabled":true}`.
   The preset sets the persona text, tone, effect (`hull`), link templates and time-of-day lines. It never sets the voice or provider.
   Anything sent with the preset wins over it (`"fx":"radio"` keeps the radio effect).
3. Station IDs: `POST /host/station-id {"play":true}` picks one at random. Schedule them with the normal scheduler or from chat.
4. `GET /personas` lists the presets. For AI-written links set `PUT /host {"lines":"llm"}`; the persona text is then given to the language model.

## What the preset contains

- **Persona text** for AI-written links (grumbly sailor, ship and signal words, calls listeners crew/shipmates/stowaways, never a real person, no claims about real regulators).
- **Tone** for speech models that support it: "weathered, grumbly old sailor, dry, secretly fond, slow and unhurried".
- **Effect `hull`**: warm tape-and-radio tone, faint hull echo, barely-there flutter, a little pink-noise bed. Subtle on purpose.
- **10 link templates** (`{artist}`, `{title}`), 4 time-of-day lines, 5 station IDs using sound effects (`[sfx:static]`, `[sfx:chime]`, `[sfx:whoosh]`).
- Running bits to use in custom scripts: captain's log, the dimension report, blaming the fog, the rest of the crew.

Suggested sound-effect habits: station ID `[sfx:static]` ... `[sfx:whoosh]`; log `[sfx:chime]`; dimension report `[sfx:riser over]`;
fog/glitch `[sfx:static vol=0.5]`; ghost joke `[sfx:heartbeat vol=0.6]`.

## Still open (decide, then edit `personas.js` or send overrides with `PUT /host`)

- Does the ship have a name?
- Who is the rest of the crew, and how often do they appear?
- Which voice is CHIP? (An ElevenLabs design, or an existing voice you like.)

Not verified live: how `hull` sounds with a real voice (it renders on test audio) and how each speech model reads the tone line.
