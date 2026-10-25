# Green Light Radio -> VirtuaHost: feature parity spec

Written by Sylvia (Green Light Radio's playout assistant), 2026-10-23, for Skyler and his Claude.
Purpose: list what my scripts do that VirtuaHost does not yet do, and say how each should be built so the whole system can live in the app.
Text only. Nothing here spends credits, touches the live station, or contains keys. Voice ids and keys stay out of this file on purpose.

## How to read this

- **Status** is judged against VirtuaHost at commit `17e75c0` (docs/FORMATS, DROPS, SCRIPTS, HUB, ROADMAP, `lib/formats.ts`, `/fx/presets`). "In app" means a working equivalent exists, "Partial" means the pieces exist but not the behaviour, "Missing" means nothing yet.
- **Where it lives today** points at my script, so Claude can read the real implementation. Paths are under `projects/green-light-radio/` on the station PC. I can export any of them on request.
- Numbers quoted (counts, thresholds) are what the scripts do today. Treat them as defaults to make configurable, not as law.
- Everything in the tier model below depends on the freshness classifier (section 10). Build that first.

## Summary table

| # | Feature | Status in app | Priority |
|---|---------|---------------|----------|
| 1 | Simulated call-ins (DJ intro, caller, DJ reaction, phone filter) | Partial: multi-speaker scripts and a `telephone` fx exist; no call-in format, caller bank or placement | High |
| 2 | Show promos on a cadence, with rotating voices | Partial: a `promo` format exists; no cadence, next-show data or rotation | High |
| 3 | Back-announce that recaps every song, latest first, then names the next | Partial: a `back-announce` format exists for one song | High |
| 4 | Placement rules (only between two songs, never beside a break or another spot) | Missing | High |
| 5 | DJ blocks, shifts, duos and hand-off conversations | Missing | Medium |
| 6 | Taste-based rotation builder (mood pools per DJ, dayparts, seeded by date, no-repeat) | Missing | Medium |
| 7 | "Same room" voice pipeline (per-voice EQ match, shared room, gate, compression, loudness) | Partial: fx presets and loudnorm exist; no per-voice calibration | Medium |
| 8 | Spoken-name cleanup for artists and titles | Missing | High (cheap) |
| 9 | Segments and hourly features (horoscopes, morning show, hourly mission, recorded segments) | Missing | Low to medium |
| 10 | Script freshness classifier (static / daypart / refreshable / live) | Prototype in `tools/script_freshness.py` | High |
| 11 | Station operations (auto start, resume at the right point, stream watchdog, level check) | Partial: agent has kill file and watchdog hooks; nothing for start-up or level | Medium |
| 12 | Music library intake and mood tagging, clean vs explicit sorting | Missing | Low (library side) |
| 13 | Character bible and house rules as data | Partial: personas exist; no taste, shift or rule fields | Medium |
| 14 | Banter style engine (foils, running bits, version runners) | Missing | Low |
| 15 | Show-recording analysis (cut songs out of old shows) | Out of scope | Not for the app |

---

## 1. Simulated call-ins

**What it is.** A short fake phone call between a DJ and a listener. Three parts: the DJ answers the phone, the caller says one thing, the DJ reacts. About 20 to 40 seconds in total. The callers are fictional listeners.

**Where it lives today.** `hosting/block2/content.py` (the `CALLERS` list), `hosting/block2/stage2.py` (voicing, phone filter, placement), `hosting/block2/make_block2.py` (how many per block).

**What I do today (facts, not wishes)**
- Each call-in is a tuple: `(dj, caller_voice_name, dj_intro, caller_line, dj_reaction)`. 17 are written: Sparkles 4, Rocky 4, Wild Bill 3, Datura 3, Starflower 3.
- The DJ lines are in that DJ's own style (Datura is unimpressed, Sparkles is excitable, Rocky says "great, great, great", Bill is Australian).
- The caller is voiced by a different premade ElevenLabs voice each time. 17 caller voices are mapped by first name (Roger, Sarah, Laura, Charlie, George, Callum, Harry, Liam, Alice, Matilda, Will, Jessica, Eric, Chris, Brian, Daniel, Lily, Adam). A caller voice is never a station DJ's voice.
- Caller audio gets a phone filter: high-pass 380 Hz, low-pass 3300 Hz, light compression, loudness about -18 LUFS. The DJ's audio does not get the filter.
- A 12-hour block carries 12 call-ins. At most 2 spots of any kind per two-hour shift. Each call-in is used once per block (removed from the pool after use).
- Call-ins only go between two songs. Never next to a host break and never next to another spot.

**What the app already has that this needs.** `docs/SCRIPTS.md` multi-speaker scripts (`cast` with per-speaker voice and persona), `/fx/presets` including `telephone`, `docs/DROPS.md` placeholders. So much of this can be a script with a cast, not new infrastructure.

**What to build**
1. A **format** `call-in` in `lib/formats.ts`: 3 turns, speakers `host`, `caller`, `host`. The writer prompt must say: the caller is fictional, short, never a real person, never a claim of a real event, no slurs, nothing aimed at groups.
2. A **caller bank** per station: `{ callerId, name, voiceRef, filterPreset, tags }`. Voice is chosen from voices that are not any station persona's voice. Never reuse the same caller twice in a day (cooldown, configurable).
3. A per-turn **fx** field in the script model (`turn.fx = "telephone"`) so the caller turn gets the phone chain and the host turns do not. If per-turn fx does not exist yet, add it; the order of effects must be: speak, filter, then level to the target.
4. **Static or live.** A canned call-in is `static` (generate once, reuse). A call-in that mentions the time, the weather or the song is `live`. The classifier decides (section 10).
5. **Placement** through the rules in section 4. The call-in is a single clip (three turns joined with a 0.25 s gap), not three queue items.
6. **Disclosure and safety.** See "Open questions for Rocky", item 1. Until Rocky decides, call-in clips carry metadata `simulated: true` and the writer is told to use only invented, obviously-fine details (no illness, no tragedy, no real place claims beyond a city name).

**Data shape suggestion**
```json
{
  "id": "callin-0007",
  "format": "call-in",
  "host": "persona:datura",
  "caller": { "name": "Greg", "town": "Arvada", "voiceRef": "caller-voice-12", "fx": "telephone" },
  "turns": [
    { "who": "host",   "text": "The phone's ringing again. You're live on the air. Who is this?" },
    { "who": "caller", "text": "Datura, it's Greg. I'd just like to say, I hate everything about this station, and I listen every day." },
    { "who": "host",   "text": "Thank you, Greg. That's the nicest thing anyone's said to me all week." }
  ],
  "freshness": "static",
  "simulated": true
}
```

**Acceptance tests**
- A rendered call-in has the phone chain on the caller turn only (spectrum check: little energy below 300 Hz and above 3.5 kHz on the caller turn, full range on the host turns).
- Two call-ins in one day never use the same caller voice.
- The queue planner refuses to place a call-in adjacent to a break or another spot (test with a fake queue).
- A call-in whose text contains a clock time or weather word is classified `refreshable` or `live`, not `static`.

---

## 2. Show promos on a cadence

**What it is.** A short spot that says what show or DJ is coming next and when. I put one in about every 15 minutes during the 12-hour DJ block.

**Where it lives today.** `hosting/block_text.py` (the `PROMO` and `PROMO_NIGHT` template banks, `NAME`, `TASTE` per DJ), `hosting/make_dj_block.py` (cadence and voice rotation).

**What I do today**
- Templates take `{nxt}` (next DJ's name), `{when}` ("at two o'clock Mountain" or "in about twenty minutes") and `{taste}` (a one-line description of the next DJ's music).
- Promo voices rotate evenly over five voices (Rocky, Starflower, Datura, Wild Bill, Krista) so no voice dominates (Rocky's explicit rule: even variety, no Rocky-heavy output).
- A different template bank is used in the final hour, when the next thing is the regular rotation instead of a named DJ.
- A "join the station" spot (email address, spoken as letters and "at gmail dot com") goes in about every 70 minutes.
- A 12-hour block came to 47 promos and 10 join spots.

**What to build**
1. **Schedule awareness.** A promo needs "what is next, and when" from the plan file (the `GLR YYYY-MM-DD.json` the agent already reads). Add `nextShow` as a hub-supplied placeholder (`{{nextShow}}`, `{{nextHost}}`, `{{nextShowStartsIn}}`, `{{nextShowStartsAt}}`) and mark them in the placeholder registry.
2. **Freshness.** `{{station}}`, `{{tagline}}` and `{{callsign}}` are fully `static` (Skyler, 2026-10-23: a station name is a static placeholder; a rename changes the text hash and regenerates by itself). `{{nextShow}}` and `{{nextHost}}` are `refreshable`: regenerate only when the plan's value changes. `{{nextShowStartsIn}}` is `live`. Prefer the form "at 7 Mountain" (refreshable) over "in 20 minutes" (live) unless a live slot is intended.
3. **Cadence** as a station setting: every N minutes, with jitter, voices rotated evenly (weighted round-robin, with a cap on how often one voice may appear in a row).
4. **Time words.** Never use a spoken clock time unless the placeholder engine supplies it. Rocky's rule: no hand-written clock times in DJ lines, because a block drifts.
5. **Time zone.** All `{when}` values use `BROADCAST_TZ` (Denver), not the machine clock.

**Acceptance tests**
- 12 hours of a fake plan produce about 48 promos at 15 minute cadence, no two adjacent, voices within 1 of even.
- A promo for a show that was cancelled in the plan is not generated (or is replaced by the fallback).
- Changing a show's start time regenerates only the promos that mention it.

---

## 3. Back-announce that recaps every song, latest first

**What it is.** The host break. Every 2 to 3 songs the host says what just played (all of them, newest first: "that last one was C, before that B, before that A") and then names the next song. Rocky's rule, 2026-10-21.

**Where it lives today.** `hosting/make_dj_block.py`, `hosting/make_host_window.py`, `hosting/block2/content.py` (`rev_recap`, `rocky_recap`), `hosting/_spoken.py`.

**What I do today**
- The opener names the first song only. Every later break recaps all songs since the last break, newest first, then names the next one. The last break of a shift hands off to the next DJ.
- Break wording comes from templates with per-DJ quips; for Rocky the break follows his real pattern: short sentences, a "So" or "Alright" opener, a backwards recap, one outward-aimed joke, the station ID.
- Artist and title are cleaned before they are spoken (section 8).
- The break is rebuilt when the playlist changes (I had a bug on Oct 18 where a stale break named the wrong tracks; this is the single best argument for generating it just in time).

**What to build**
1. Extend `back-announce` to take **a list of songs** (`recap: [{artist,title}, ...]`, newest first) and **one next song**. The writer is given the list as data and must not add songs, spell them differently, or invent any. Validate after writing: every title and artist in the text must be in the list.
2. Source the list from the agent's `/npjson` history (`CurrentTrack`, recent plays) plus the queue (`Playlist`), not from the plan alone, so a skipped or substituted song is right.
3. Mark the break `live` (it names real songs by position), generated at the standard lead, with a fallback to a generic evergreen "you're listening to X" station drop.
4. The recap count is a station setting (2 to 3 songs between breaks by default).

**Acceptance tests**
- The text names exactly the songs given, in newest-first order, and names the next one last.
- If one song in the list is removed (skipped), the regenerated text drops it.
- A text that names a song not in the data is rejected before speech is spent.

---

## 4. Placement rules for spots

**What it is.** Rules about where non-song items may sit in a queue.

**Where it lives today.** `hosting/block2/stage2.py` (`gaps_of`, `assign`), the validation line that rejects bad sequences, `rotation/build_glr_rotation.py`.

**Rules (from Rocky, 2026-10-21, and what the code enforces)**
- Spots, facts, call-ins, promos and drops go only between two songs.
- Never right before or after a host break. Never two spots in a row.
- At most 2 spots of any kind per two-hour shift in the 12-hour block. In the 24-hour rotation, short and long drops are picked by DJ block, with a 12-item no-repeat window for drops and a 20-item window for interludes.
- A hard check after assembly: any spot whose neighbours are not both songs fails the build.
- Songs: no repeat inside a day; the same artist not within 8 plays; if the pool is empty, relax the artist rule first.
- No spoken clock times in DJ lines.

**What to build**
- A **placement validator** in the hub that takes a queue (the agent's `Playlist`) and a proposed insert, and returns accept/refuse with the rule broken. The agent's `INSERT_EXEC` should call it before touching RadioDJ, in addition to the existing "at least 2 items ahead" rule.
- A **gap finder**: given the queue, list valid gaps (song, [gap], song) with the time each starts, so dynamic slots can be matched to gaps instead of fixed positions.
- Make every rule a station setting with the values above as defaults.

**Acceptance tests**
- A synthetic queue with a break at position 5 refuses an insert at 4, 5 and 6, and accepts 7 only if positions 6 and 8 are songs.
- Two spots can never be adjacent, whatever order they are inserted in.

---

## 5. DJ blocks, shifts, duos and hand-offs

**What it is.** A 12-hour structure of two-hour DJ shifts, some solo and some duos, with live-sounding changeover conversations. Today it is a batch product; in the app it should be a plan the hub can regenerate by slot.

**Where it lives today.** `hosting/make_dj_block.py` (four DJs x 3 h), `hosting/block2/make_block2.py` (noon to midnight, six 2 h shifts), `hosting/block3/make_block3.py`, `hosting/make_handoff_chats.py` (changeover banter), `hosting/make_host_window.py` (strip a live window and insert breaks into an existing queue).

**Rules**
- Shifts are two hours (Rocky 2026-10-21), with DJs mixed: solo, then a co-host walks in, then the first leaves, and so on.
- No permanent sidekick for now (Rocky declined).
- A changeover conversation: the outgoing DJ's recap is kept, the incoming DJ walks in, they banter in character, and the incoming DJ takes the mic and names the first song. Two clips per changeover.
- No spoken clock times in any DJ line.

**What to build**
- A **shift model** on the station: `{ start, end, hosts: [personaId], mode: solo|duo }`.
- A **host-window mode**: "from 14:00 to 17:00, replace the spots with host breaks and insert a break every 2 to 3 songs" as a plan transform that produces dynamic slots, not audio.
- A **changeover slot kind** (`handoff`) whose text is a short two-persona script (the app already supports up to four speakers in a script).
- Do not copy my batch assembly (a one-off script). Express the structure as plan items and let the JIT worker fill the slots.

---

## 6. Taste-based rotation builder

**What it is.** The nightly playlist builder. Each DJ plays music matching their taste. Output is a RadioDJ playlist `GLR YYYY-MM-DD` and, now, a plan file.

**Where it lives today.** `rotation/build_glr_rotation.py`, `rotation/mood_scan.py` (energy, brightness, tempo per track), `rotation/mood.csv`, `rotation/glr_plan.py`.

**What I do today**
- Every track gets `rms_db`, `centroid_hz`, `bpm`, `flux` from 90 seconds of audio. Z-scores give an `energy` score (0.5 loudness + 0.3 flux + 0.2 tempo) and a `dark` score.
- DJ pools: Rocky plays everything; Datura plays dark and sad (high `dark`, or tags such as punk, dream, goth, trip-hop; never hip-hop); Wild Bill plays upbeat, never country, folk or bluegrass.
- 24 hours in blocks (Datura 00-03, Rocky 03-10, then a daily random swap of Rocky/Bill midday blocks, Bill 18-21, Datura 21-24). The date seeds the random generator so every day differs and a rebuild is reproducible.
- 2 to 3 songs, then a spot or segment. A segment at most every 40 minutes, a morning show once between 07 and 09, horoscopes only on Datura's blocks.
- No-repeat windows (songs per day, artist 8, drops 12, interludes 20).

**What to build**
- Treat this as **data and a plugin point**: each persona gets a `taste` (tags to include/exclude, `energy` and `dark` ranges), each station a `rotationPolicy` (block table, spacing, windows). The app should not run my scripts; it should read the same inputs.
- A **library scan** that produces the four features per track (ffmpeg-only, no ML), stored with the track record. I can supply `mood_scan.py` as the reference.
- Output a plan file (the app already reads it) with `freshness` on every item, and write the RadioDJ playlist through the agent's `LOAD_EXEC`.
- Reproducibility: seed by `(stationId, date)` and store the seed in the plan.

---

## 7. "Same room" voice pipeline

**What it is.** Characters generated by different voices should sound like they are in one studio, at one loudness.

**Where it lives today.** `tools/glr_voices.py` (`tts_line`, `process`, `concat`), room correction curves in `episodes/morning-show-pilot/room_corr*.json`, `room_ir.wav`, `ac_room_tone_loud.wav`.

**What it does, in order, per line**
1. Optional pitch shift (per voice, in semitones, speed unchanged) and tempo change (per voice).
2. Trim long silences (stop at -45 dB, 0.6 s).
3. High-pass at 85 Hz.
4. Noise gate (light) and denoise.
5. Per-voice EQ correction: a measured curve that moves each voice's spectrum toward a common target.
6. Shared room: mix a short convolution reverb (an impulse response) at low level under the dry voice.
7. Compression, then loudness normalise to -16 LUFS with a -1.5 dBTP ceiling.
8. For multi-line clips: join with a 0.25 s gap, optionally with a room-tone bed under the whole clip.

**Per-voice settings that matter:** stability, tempo, pitch, EQ curve. Examples in practice: one voice at stability 0.0 and tempo 1.05, one raised by half a semitone. These were chosen by listening, by Rocky.

**What to build**
- A **voice profile** object in the app: `{ voiceRef, stability, tempo, pitchSemitones, eqCurve, roomRef }`, applied by the server mix (the app already mixes sfx on the server, so the pattern exists).
- A **calibration tool**: given a few raw takes of a voice, compute the EQ curve against the station's reference. I can export the method (a 1/3-octave spectral average, difference to the target, clamped gain).
- Always end the chain with the loudness step, so every clip leaves at -16 LUFS / -1.5 dBTP. This is also what the stream level check relies on.
- Keep the phone chain (section 1) as a separate preset applied after the voice profile.

---

## 8. Spoken-name cleanup

**What it is.** Song and artist names from library tags are not speakable as written ("Artist feat. X - Title (Radio Edit)", "A$AP", "Curren$y", leading track numbers, `_` in titles). Without cleanup a DJ reads the junk aloud.

**Where it lives today.** `hosting/_spoken.py` (`spoken`, `lst`), which is tiny and easy to port.

**Rules it applies**
- Drop bracketed and parenthesised text, "feat./ft./featuring" parts, trailing "- radio edit / clean / explicit / original mix", leading track numbers, `_`.
- `&` becomes "and", `$` becomes "S", with a small exception list for named artists.
- Lists are phrased with a random choice of "A with T" and "T by A", joined with commas and a final "and".

**What to build.** One shared function in `lib/` used by the song-intro, back-announce and host-link code, with an editable exceptions table per station (the pronunciation fixes that Rocky tells me about). There is nothing like it in the app today.

---

## 9. Segments and hourly features

**What they are.** Recorded or generated pieces that give the station its shape: a morning show once a day, horoscopes (Datura only), an hourly "AudioMission" station promo that rotates through five variations, and short recorded segments. Several are long, produced files, not one-line drops.

**Where they live today.** RadioDJ category `GLR Segments`, `rotation/build_glr_rotation.py` (where they are scheduled), `episodes/` (for example `datura-cancer/make.py`, a horoscope), `shows/ROCKY_FLATS_SHOW_STRUCTURE.md` (templates, bit bank, running order).

**What to build.**
- A **segment** item kind in the plan with `maxPerDay`, `minGapMinutes`, `allowedHosts`, `daypart` fields (my builder hardcodes these).
- Hourly features as a **recurring slot**: `{ at: "top-of-hour", rotate: [v1..v5] }`.
- The existing app "schedules" only do fixed intervals (ROADMAP: "no time-of-day recurrence"). Top-of-hour and daypart recurrence is therefore a prerequisite for this.

---

## 10. Script freshness classifier

See `tools/script_freshness.py` (prototype, rules in plain regexes). Summary of the design agreed in the chat on 2026-10-23:
- Tiers: `static` (generate once, reuse), `daypart` (reuse within a daypart), `refreshable` (regenerate only when inputs change), `live` (generate at the lead time).
- Decide from the text alone, before any speech: placeholders first (registry with three classes: static `station`, `tagline`, `callsign`; refreshable `showName`, `hostName`, `nextShow`, `nextHost`; volatile `time`, `date`, `weather`, `nowPlaying` and so on; an unknown placeholder means live), then word patterns (now/latest, song references, weather words, clock times, day and date words, schedule claims, numbers and contacts).
- Tier can only go up; any hit takes a script out of `static`. A false "live" costs a little reuse; a false "static" would put a stale line on air all week, so tests must target false static.
- A cheap LLM check may run on scripts the rules call static, asked only "does this depend on when it is played?", and may only demote.
- Store per script: `freshness`, `reasons[]`, `needs[]`, `validFor`, `classifierVersion`.
- Use the 101 scripts I have as the first labeled test corpus; I can export them as JSON fixtures.
- Known results on my corpus: 76 static, 20 live, 3 refreshable, 2 daypart; the false positives are on the safe side ("right now someone is having a bad day" counted as live).

---

### Lead time for live slots (Skyler, 2026-10-23: 5 minutes)

- The working lead is **5 minutes** (300 s), enough for the model call, the speech call, the download and local processing.
- **Measure it to the swap deadline, not to the slot start.** The agent refuses a swap when the planned clip is the immediately-next item (RadioDJ may already have loaded it; `agent.js` `/queue/insert`). So the real deadline is the moment the item *before* the slot starts playing, which is a whole song earlier than the slot (3 to 7 minutes in my rotation). A flat "5 minutes before the slot" would leave only 1 to 2 minutes of working time.
- So `leadSeconds` per slot = 300 + the duration of the item before the slot. `rotation/glr_plan.py --lead 300` now writes exactly that: on 2026-10-23 and 24 the values run from 476 to 714 seconds, and the hub still gets 5 minutes before the deadline. (The hub's field is `leadSeconds`, range 60 to 3600; its default of 600 should become 300 working seconds plus the preceding duration, computed by the agent from the queue, so hand-written plans stay right.)
- The hub's own "too late" check is 60 s before the slot start (`safetyMarginSeconds`). It should also fail open when the swap deadline has passed, instead of waiting for the agent to refuse. Add a setting `swapDeadline: precedingItemStart`.
- Measure the real generation time in shadow mode (text, speech, download, processing) before trusting 5 minutes. If the p95 is over about 3.5 minutes, raise the working lead; failing open to the planned clip is always safe but wastes the credits already spent.

## 11. Station operations

**What it is.** Everything that keeps the station on air without a person.

**Where it lives today.**
- `rotation/glr_resume.py`: after a restart, if RadioDJ is idle, load the rest of today's playlist starting at the item for the current **broadcast** time (America/Denver), turn AutoDJ on, verify something is playing.
- `rotation/glr_stream_watchdog.sh`: every minute check the stream mount; after 2 misses restart the encoder.
- Start-up script at logon: start RadioDJ, restore the encoder's device settings from a known-good copy, start the encoder, then run the resume script.
- Stream level review: measure the live stream loudness (target about -16 LUFS, peaks below -1 dBFS) and fix it with the encoder's gain, never with the PC volume.
- Daily timers (Denver time): build tomorrow's playlist, load today's, back up.

**What to build**
- Agent endpoints: `POST /ops/resume` (same logic as my resume script, dry-run flag), `GET /ops/level` (returns LUFS and peak from a short capture of the stream), `GET /ops/watchdog` (last restart and reason). All read-only except resume, which is control-key only and refused during a live show.
- A UI card: time zones, last resume, last watchdog restart, current stream level against target.
- Keep device-specific fixes (encoder config, startup folder) out of the app. They are per-station and belong in a local runbook, not in the hub.

---

## 12. Music library intake and tagging

Out of the app's core, but the rotation builder (section 6) depends on its output.
- `music-intake/`: download, tag scan, genre classification into genre folders, organise. Resumable.
- Clean vs explicit sorting: songs that contain censored or explicit material are kept in separate "Radio-friendly" and "Uncensored" folders. When unsure, the item goes to Uncensored. This is a sort, not a content ban.
- Songs cut from recorded shows are tagged with their source show and date.
- What to build: library records with `explicit: clean|explicit|unknown`, `source`, and the four mood features; a rotation policy flag "allow explicit". No screening of lyrics or music for hate content is done or wanted (Rocky's standing instruction).

---

## 13. Character bible and house rules as data

The app's personas hold voice, tone, instructions and templates. My characters also carry data the app has no field for:
- **Taste** (what music they play), **shifts** (when they are on), **foils** (who they banter with), **catchphrases and running bits** (frequency caps), **banned words**, **speech rules** (no exclamation marks, no "vibes"), **cussing level**, **speaker code and calibration** (section 7).
- **Roster at 2026-10-23:** Rocky Flats (eclectic, plays everything), Wild Bill (Australian, upbeat, no country), Datura (dark, sad, roast comic, horoscopes), Starflower (warm, bright, upbeat), Sparkles (excitable, high energy, innuendo, uncensored), Krista (used in the promo and drop rotation). Britta is retired.
- **House rules (Rocky, 2026-10-21):** an uncensored station with more cussing, no slurs, nothing hateful aimed at groups; recaps go backwards; spots only between two songs; shifts are two hours; no spoken clock times; AI disclosure rules are Rocky's call.
- What to build: persona fields `taste`, `shiftRules`, `bannedWords`, `maxPerHour` (for bits), `speakerProfile` (section 7), and a station-level `houseRules` list rendered into every writer prompt. Keep the 1,500 character instruction cap in mind: rules that must always apply belong in the station prompt, not the persona.

---

## 14. Banter style engine (lower priority)

`shows/ROCKY_FLATS_SHOW_STRUCTURE.md` section 7 documents the engine behind the two-voice exchanges: foil casting, a bit bank, recurring "void" runner, and "version B/C" runners for duo windows and a missing-character night. It is design text, partly implemented in `hosting/block2/content.py`. It is worth building only after sections 1 to 8 work. Treat it as a script template library.

## 15. Not for the app

`tools/cut_songs_from_show.py` and the `glr_*` audio analysis tools (join detection, dips, novelty) exist to cut songs out of recorded radio shows. That is a one-off ingest job on the station PC, not a feature of the hub.

---

## Suggested build order

1. Section 10 (freshness classifier) and section 8 (spoken names): cheap and everything else uses them.
2. Section 4 (placement validator) and section 3 (recap back-announce): the safety rules must exist before anything is inserted live.
3. Section 2 (promos) and section 1 (call-ins): the features you asked about, built on the first two.
4. Section 11 (ops endpoints), section 13 (persona data), section 7 (voice profile).
5. Sections 5, 6, 9 once the plan file carries `freshness` and the agent's `INSERT_EXEC` is verified.

## Open questions for Rocky (Skyler cannot decide these)

1. **Call-in disclosure.** Callers are fictional but sound like real listeners. Should callers be obviously fictional, carry an on-air "simulated" tag, or be announced in a regular disclosure line? His show template also says "no invented callers, winners or prizes" for Rocky's own show; he asked for fake call-ins station-wide on 2026-10-21.
2. **Legal station ID.** Exact wording, call sign and city, which every planned clip must keep.
3. **Relay shows.** How he switches to a DJ relay today, so the app can match.
4. **Persona wording.** Remove "never write placeholders" from the Rocky persona so live time and weather lines can work.
5. **Spend cap.** A daily ElevenLabs credit cap for live slots.

## Appendix: where each thing is (station PC, under `projects/green-light-radio/`)

| Thing | File |
|-------|------|
| Call-ins | `hosting/block2/content.py`, `hosting/block2/stage2.py` |
| Promos, join spots | `hosting/block_text.py`, `hosting/make_dj_block.py` |
| Recap and breaks | `hosting/make_dj_block.py`, `hosting/make_host_window.py`, `hosting/_spoken.py` |
| Hand-off chats | `hosting/make_handoff_chats.py` |
| Rotation | `rotation/build_glr_rotation.py`, `rotation/mood_scan.py`, `rotation/glr_plan.py`, `rotation/glr_resume.py` |
| Voice pipeline | `tools/glr_voices.py` |
| Freshness prototype | `tools/script_freshness.py` |
| Drop text | `drops/make_drops.py` (66 lines), `interludes/interlude_text.py` |
| Characters and rules | `CHARACTERS.md`, `STATION_PLAN.md`, `shows/ROCKY_FLATS_SHOW_STRUCTURE.md` |
| Library intake | `music-intake/` |
