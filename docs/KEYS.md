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

## ElevenLabs (voice clones)

Add an ElevenLabs key the same way (Account card, or a station's editor for admins; the site's `ELEVENLABS_API_KEY` is the fallback). While a key is in scope, the speech-model lists include `elevenlabs/eleven_flash_v2_5`, `eleven_turbo_v2_5` and `eleven_multilingual_v2`, and their voice box suggests the voices on that account, **cloned voices first**. Type a voice name or paste a voice id. `ELEVENLABS_VOICES="Rocky=<id>,Britta=<id>"` adds named voices (same format as the Chips Voice server).

ElevenLabs only speaks: the words are still written by OpenRouter or Gemini, so one of those keys is still needed. These models ignore tone and inline tags (tags are removed before speaking). The request shape is not verified against the live service. Usage is billed in ElevenLabs credits (about one per character; the estimate shows characters, not dollars).

## Costs, warnings and defaults

Before each AI step the app shows an estimate (tokens, and dollars when OpenRouter lists a price for the model) and asks you to confirm when the model is premium, has no known price, or costs 5x or more than the default. The numbers are estimates: tokens are guessed at 4 characters each, speech models bill in different ways (so a speech cost is shown only when a price is listed), and flier images are counted as a fixed 1,100 tokens. Defaults are the cheap choices: `openai/gpt-4o-mini` for writing and `hexgrad/kokoro-82m` for speech (cheap, but no tone or delivery tags: choose a Google speech model when you need them).

## Writing models, free models and content filtering

- **Built-in writing models** (cheapest first): `openai/gpt-4o-mini`, `anthropic/claude-haiku-5.5`, `google/gemini-3.6-flash`, `deepseek/deepseek-chat`, `meta-llama/llama-3.1-8b-instruct`. These are candidates: when OpenRouter's model list can be read, any it does not list is hidden, so a renamed or retired slug never shows up. **The Haiku 5.5, Gemini and DeepSeek slugs follow OpenRouter's naming but could not be checked against the live service while this was written.** If one is missing from the picker, find its exact slug at openrouter.ai/models and put it in `OPENROUTER_TEXT_MODELS` (a list you set yourself is kept exactly as written).
- **Free models:** OpenRouter's models whose names end in `:free` (up to 40) are added to the writing picker, marked `[free]`. They can be chosen even without `OPENROUTER_ALLOW_ANY_MODEL`, because they cost nothing. They are rate limited and the provider may log what you send, so they are never the default.
- **Other routers:** any OpenAI-compatible router can stand in for OpenRouter by setting `OPENROUTER_BASE_URL` (and `OPENROUTER_API_KEY`); price and free-model discovery only work if it serves OpenRouter's `/models` shape.
- **Content filtering:** every model in the pickers is labelled `filtered`, `light filter` or `unfiltered` (nothing shown means nobody has checked it). OpenRouter's own `is_moderated` flag is used when it reports one; otherwise the label is a hint from the model's name and what is publicly known (hosted OpenAI, Anthropic and Google models are treated as filtered; Kokoro and community "uncensored" fine-tunes as unfiltered; Llama, Mistral, DeepSeek, Qwen as light). **A hint is not a test:** models change and providers differ, so generate a line with the language you need before relying on one.
- **Strong language:** the Generate tab has an *Allow strong language* switch. It tells the writer not to censor, bleep or soften, hides models marked `filtered`, and the estimate warns if a filtered model is still selected. Speech models read what they are given, but a few (notably some hosted ones) may refuse or alter it too; Kokoro is unfiltered.
