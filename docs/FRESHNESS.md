# Freshness: which drops can be reused and which must be made on the spot

Written 2026-10-25 from the chat between Skyler and Sylvia. Status of each part is marked **built**, **built, untested live** or **to do**.
The code that exists is `chips-voice/hub/freshness.js`, `chips-voice/hub/jev.js`, their tests and fixtures, and `scripts/eval-second-opinion.js`.

## Goal

Generate a line once and play it all week when it stays true, and generate it shortly before air only when it depends on something that changes.
The decision is made from the script text alone, before any speech is paid for.

## The four tiers

| Tier | Meaning | When it is made | Cache key |
|------|---------|-----------------|-----------|
| `static` | Nothing in it changes. Station IDs, "no ads, no sponsors", generic drops. | Once. Kept in the pool and replayed. | hash of text + voice + model |
| `daypart` | True for one part of the day ("good morning"). | Once per daypart; usable inside that daypart only. | text hash + daypart |
| `refreshable` | Uses values that change rarely (a show name or start time, a promo). | Again only when those values change. | hash of the **filled-in** text |
| `live` | Uses values that change constantly (time, weather, the song before or after, an event now). | Shortly before air, every time, with a planned fallback. | hash of the filled-in text, per slot |

`{{station}}`, `{{tagline}}` and `{{callsign}}` are fully **static** placeholders (a rename changes the hash and regenerates by itself).

## Layer 1: rules (built)

`classify(text)` in `hub/freshness.js` returns `{ freshness, reasons, needs, classifierVersion }`.
- Placeholders first: static (`station`, `tagline`, `callsign`), refreshable (`showName`, `hostName`, `nextShow`, `nextHost`), volatile (`time`, `date`, `weather`, `temperature`, `nowPlaying`, `nextSong`, `lastSong`, `event`, `listeners`). Unknown means live.
- Then word patterns: now/latest, song or track references, weather words, clock times, day and date words, schedule claims, phone numbers and prices, daypart wording.
- The tier only goes up. One signal is enough to leave `static`. A false "live" costs a little reuse; a false "static" puts a stale line on air all week, so the tests target that.
- `test/fixtures/glr-scripts.json` holds 101 Green Light scripts and must match the Python version in the station scripts.

## Layer 2: Jev, only for scripts the rules called static (built, untested live)

Some lines are time-sensitive in ways a pattern cannot see ("Hope your day's going well", "Stick around, there's more after this", "Our brand new show").
`classifyWithSecondOpinion(text, ask)` asks a small classifier about scripts that came out `static` and can only **demote** them. It never raises a script's tier above what the rules said and is never asked about a script the rules already flagged.

`hub/jev.js` asks TypeSafe's Jev, in one request, seven atomic questions and combines them in code:

| Question | Type | Argues for |
|----------|------|-----------|
| `assumes_now`: assumes the present moment | yes/no | live |
| `surrounding_content`: only makes sense next to specific content around it | yes/no | live |
| `changing_fact`: states a fact that can go stale | yes/no | refreshable |
| `seasonal_or_dated`: tied to a season, holiday, weather, year or date | yes/no | refreshable |
| `promises_later`: announces something later or refers to a schedule | yes/no | refreshable |
| `horizon`: years / months / weeks / days / hours | choice | hours = live; days or weeks = refreshable |
| `daypart`: any / morning / afternoon / evening / night | choice | not "any" = daypart |

Thresholds: 0.6 for a yes/no question, 0.5 for the combined horizon probabilities. **These are guesses**; tune them with the eval script (below).
Every demoted script is stored with `needsReview: true` and a reason listing the questions that fired with their scores. A failed call, an unreadable answer or low confidence also sets `needsReview` and leaves the tier alone.

**Unverified:** the request follows TypeSafe's documented native API (`POST https://api.typesafe.ai/v1/systemone`, a separate TypeSafe key). OpenRouter lists Jev as `typesafe/jev-router` but documents only a chat shape for it; whether it accepts these question types is **not known**. TypeSafe's own test (parallel.ai, Sept 2026) found Jev weaker than their specialised models on query-freshness classification, which is why it is a second layer and not the main check.

### Measuring it

`TYPESAFE_API_KEY=... node chips-voice/hub/scripts/eval-second-opinion.js` runs `test/fixtures/sneaky-lines.json` (16 lines the rules call static: 12 time-sensitive, 4 genuine evergreens) and prints caught, missed and false alarms. Do this before turning the layer on. Grow the fixture whenever a stale line gets through.

## Where it plugs in (to do)

1. **On save.** Classify every script when it is saved (Studio, persona line banks, schedules, dynamic slots). Store the result next to the script.
2. **Before speech.** In the hub's validation step (HUB.md section 10, step 2) run both layers; speech is only paid for after the tier is known.
3. **Plan files.** `GLR YYYY-MM-DD.json` items carry `freshness`. Baked clips are `static`, dynamic slots `live`, songs `n/a` (the station-side builder already writes this).
4. **Library.** Clips keep the tag, so the picker can filter "reusable" versus "made for a slot" and so a `static` pool exists for fallbacks.
5. **UI.** A badge on each script and clip, a popover with the reasons, a review queue for `needsReview` items, and a manual override that records who changed it.

Stored per script or clip: `freshness`, `reasons[]`, `needs[]`, `validFor` (daypart or date window), `classifierVersion`, `needsReview`, `reviewedBy`. Recompute when `classifierVersion` changes.

## Lead time for live slots (to do)

- Working lead is **5 minutes** (`leadSeconds` 300) for the text, speech, download and processing.
- Measure it to the **swap deadline**, not the slot start: the agent refuses a swap when the planned clip is the immediately-next item (`agent-radiodj/agent.js` `/queue/insert`), so the deadline is the moment the item before the slot starts playing.
- `leadSeconds` per slot = 300 + the duration of the item before it. The station-side `glr_plan.py --lead 300` already writes that. The hub default of 600 should become the same rule, computed from the queue.
- The hub's own "too late" check is 60 s before the slot start (`safetyMarginSeconds`). It should also fail open once the swap deadline has passed instead of waiting for the agent to refuse.
- Measure real generation time in shadow mode first. If the slowest runs take over about 3.5 minutes, raise the working lead.

## Rollout

1. Merge the rules layer. Show badges, store the tag. No behaviour change. *Done when:* every saved script has a tier and reasons; the fixtures pass.
2. Run the eval script with a key. Tune thresholds. Enable Jev as a second layer in shadow: store its verdict and `needsReview`, change nothing. *Done when:* agreement and false-alarm rates are written down.
3. Use the tiers: reuse `static` clips, regenerate `refreshable` only on value change, queue `live` slots with a planned fallback. Honour `needsReview` by holding the clip out of the reusable pool until a person approves it.
4. Lead-time rule in the hub and agent (above).

## Open questions

- Which key does Jev use: a TypeSafe key, or the OpenRouter key? Confirm the route before building the UI around it.
- Per-call cost of Jev is not visible (OpenRouter lists it as variable). Show it in the cost estimate.
- Scripts are sent to a third party (TypeSafe) for the second layer: only script text, never keys or listener data. Make the layer opt-in per site.
