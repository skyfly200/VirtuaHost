# Roadmap

What exists, what is being built, and what is planned. Anything that touches a real RadioDJ, ElevenLabs, OpenRouter or Netlify Blobs is **not verified live** until it says so (the lists are in [HUB.md](HUB.md#needs-live-verification-on-a-real-radiodj-do-not-claim-any-of-these-works-until-it-has-been)).

## Built (tested against fakes)

- Two clocks (`broadcastTz`, `machineTz`) everywhere, with warnings. Scoped service keys (`SERVICE_KEYS`).
- RadioDJ agent: status, schedule, insert two ahead and preempt the planned clip, hash-named ingest, kill switch, live-show refusal, audit log, pull loop for a PC behind NAT.
- Hub: just-in-time drops (shadow mode default, approval queue, caps, breaker, fail open), pull endpoints, audit log. See [HUB.md](HUB.md) sections 10 and 11.
- Dynamic tab: status, clocks, review and approve, slots (with saved scripts), spend, audit.
- Scripts and the Studio ([SCRIPTS.md](SCRIPTS.md)): casting up to four speakers, AI drafting from persona briefs, saved scripts, conversations in schedules and dynamic slots, save and schedule from the Studio. Weather report format and placeholders in generation and schedules.
- Grouped menu, mobile layout.

## Next

1. **Song-neutral evergreens.** A planned clip at a dynamic slot may not name a song, an artist or "the next song" (it may be a station ID, time check, generic break, promo or weather). A `songNeutral` flag on slots and an audit of the baked drops. Needed before requests, because a requested song changes what plays next.
2. **Song requests.** A channel-agnostic request (`source`: `ui` now; web form, email, chat later): song, requester first name, optional dedication, state (pending, matched, approved, queued, played, rejected, failed). A Requests panel in the Dynamic tab takes a request by hand, matches it to the library, and a person approves it. The song is inserted at least two ahead (same insert mechanism, with a library file) and the neighbouring host break is written with exactly the names that really play (`constraints.names`), thanking the requester by first name. Rate limits, a blocklist and the language checks apply to every requester-supplied word; contact details are kept apart from what the writer sees. Needs from Sylvia: a way to find a song in RadioDJ's library by artist and title, and the insert script.
3. **Relay shows.** A `Show` (name, host, recurring time in `broadcastTz`, relay source such as an Icecast mount or URL, grace window) drives four things from one schedule: its **promos** (a site schedule that stops when the show starts and expires with it), a dynamic **intro and outro** slot, an **agent watch** that switches to the relay only once the source has been up for a few seconds and back when it drops or the show ends plus the grace period, and **Dynamic/Control** status with manual "go to relay now" and "return to automation". A `relay` agent mode, like `live-show`, suppresses dynamic drops and refuses insertions. How the stream actually switches (RadioDJ, Liquidsoap or Icecast fallback mounts) is the unverified part: it will be a hook like insert. Open questions: what the relay source is, how DJs authenticate, what happens if the DJ never shows (wait the grace window, then skip and replay the promo?).
4. **Google Calendar.** Publish the schedule for the audience: shows, relay shows and promoted events become calendar events, updated automatically when a show is created, moved or cancelled. Plan: a station calendar (a service account that owns it, with the calendar id on the station); events carry the show name, host, an explicit time zone (`broadcastTz`), a listen link and a description; each event is keyed by a stable id derived from the show and its date so an update edits the same event and a cancellation deletes it; an `.ics` feed (`/api/calendar/<station>.ics`) is the zero-account way for listeners to subscribe, and a public calendar embed goes on the website. One direction only (the site writes, nothing reads back). Needs: a Google Cloud service account and the calendar shared with it, API quota awareness (batch the nightly sync), and a decision on how far ahead to publish (suggest 4 weeks). *Planned, not built.*
5. **Intake adapters for requests and messages:** a web form on the site, email, and chat apps, each a small source with its own scoped key posting to the same request endpoint.

## Later

- Emergency alerts: official National Weather Service text verbatim, area-filtered, human approval, kill switch, off by default. Today only a refusing hook exists.
- A real database for the hub (it is one JSON file now, fine for one station).
- Conversation drops that are generated per station group with different casts.
