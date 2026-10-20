# Pre-mixed audio

Each `<name>.txt` here becomes `<name>.mp3` when the **Premix** workflow runs (or `node scripts/premix.mjs`).

- Header lines `# voice:`, `# tone:`, `# speechModel:` and `# loudness:` (LUFS, default -16, `off` to skip) come first.
- Tags: `[sfx:ding]`, `[sfx:whoosh over]` (over the following speech), `[sfx:crowd vol=0.5]`, `[sfx:beep wait=0.5]`.
- Sound effects are the built-ins (`ding`, `chime`, `whoosh`, `riser`, ...) plus any `sfx/<name>.mp3|wav|ogg` you add here.
- `node scripts/premix.mjs --dry-run` checks every tag without calling the site.
