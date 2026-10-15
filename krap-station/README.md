# KRAP Virtual Host (work in progress)

Tools for K.R.A.P. 97.7FM's AI host: scripted spots and talks voiced with ElevenLabs
voice clones (Rocky + Britta), post-processed with ffmpeg, and a small RadioDJ REST helper.

## Layout
- `krap/scripts.py` - spot and talk scripts (R = Rocky, B = Britta; "Apo-jee-uh" for Apogaea)
- `krap/gen.py` - generate audio via ElevenLabs text-to-dialogue (needs `KRAP_ELEVENLABS_API_KEY` in env, ffmpeg on PATH or at ~/.local/bin/ffmpeg)
- `krap/process.py` - re-process raw takes: tempo, pause trimming, "underground" texture, loudness
- `radiodj/radiodj_api.sh` - call RadioDJ's REST plugin (password read from ~/.config/radiodj/rest-pass)

## Live host v1 (`host/virtual_host.py`)
Reads RadioDJ's Status, and near the end of each track writes a short link (template lines, artist + title only),
voices it in the Rocky clone, and saves it as `C:\KRAP\Links\current_link.mp3`. With `--cart N` it triggers
RadioDJ cart N as the track ends, so set cart N in RadioDJ to play that file once.
Test with: `--say "Artist" "Title" --dry-run` (text only) or without `--dry-run` (uses ElevenLabs credits).

## Not built yet
Smarter lines (an LLM writing links), Britta in the links, ducking over intros, and a live safety check that never talks over a spot.

## Secrets
No keys are stored in this repo. Never commit API keys or passwords.
