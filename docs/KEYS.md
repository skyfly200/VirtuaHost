# AI keys and models per person and per station

By default every request uses the site's key (`OPENROUTER_API_KEY` or `GEMINI_API_KEY`). Two things change that:

- **A person's own key** (Account card -> *My AI key*): their requests use it, are billed to them, and do **not** count toward their AI limits. With their own key and no station limit they may name any OpenRouter model.
- **A station's key** (Stations tab -> edit a station -> *AI key for this station*, admins only): requests made for that station use it when the person has no key of their own.

Order: person's key, then the station's, then the site's. A person's Gemini key is used even when the site is configured for OpenRouter (and the other way round), because an own key always wins.

## Limiting models per station

Stations -> edit -> *Allowed models*. One OpenRouter model per line for writing and for speech (a speech line may carry a default voice: `hexgrad/kokoro-82m|af_heart`). When set, that station can only use those models, **even with a personal key**, and the pickers only offer them. Empty means the site's list.

## How keys are stored

Encrypted with AES-256-GCM in Netlify Blobs (store `secrets`). The encryption secret is `SECRETS_KEY` (32+ characters), falling back to `SESSION_SECRET`; set `SECRETS_KEY` so rotating `SESSION_SECRET` does not make saved keys unreadable. A key is write-only: the app only ever shows that one is set and its last four characters. An unreadable key (wrong secret) is treated as not set, so requests fall back to the next level.

## Scheduled runs and the virtual host

A schedule runs with its owner's key (then the station's, then the site's). Host links for a station use the station's key.
