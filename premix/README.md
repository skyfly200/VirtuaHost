# Pre-mixed audio

Each `<name>.txt` here becomes `<name>.mp3` when the **Premix** workflow runs (or `node scripts/premix.mjs`).

- Header lines `# voice:`, `# tone:`, `# speechModel:` and `# loudness:` (LUFS, default -16, `off` to skip) come first.
- `# send: air` or `# send: library` (with `--publish` and the site in `STATION_MODE=queue`) queues the finished file for the station daemon to play or keep.
- Tags: `[sfx:ding]`, `[sfx:whoosh over]` (over the following speech), `[sfx:crowd vol=0.5]`, `[sfx:beep wait=0.5]`.
- With `SITE_URL` and `ACCESS_KEY` set, library sounds work too, and `[music:name vol=0.2]` adds a music bed from the library under the whole script.
- Sound effects are the built-ins (`ding`, `chime`, `whoosh`, `riser`, ...) plus any `sfx/<name>.mp3|wav|ogg` you add here.
- `node scripts/premix.mjs --dry-run` checks every tag without calling the site.
- `--publish` (or the workflow's "publish" input, or the repository variable `PREMIX_PUBLISH=true`) saves each finished file to the site's clip library.
