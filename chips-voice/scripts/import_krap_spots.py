#!/usr/bin/env python3
"""Load the KRAP station spots into the Chips Voice clip library as Rocky/Britta dialogue clips.

Reads krap-station/krap/scripts.py (SPOTS, SPOTS_FUN and TALK, lists of ("R" | "B", "line") turns) and asks the
Chips Voice server to voice each one with ElevenLabs text-to-dialogue. Clips are named, tagged and reused: running
this again does not pay for anything that already exists (the library is keyed by what was said and how).

    CHIPS_VOICE_URL=https://radio.example.com CHIPS_VOICE_KEY=<api key> \\
      python3 chips-voice/scripts/import_krap_spots.py --dry-run
    ... import_krap_spots.py                      # all spots
    ... import_krap_spots.py --only 01_station_id_rocky 04_no_playlist_duo
    ... import_krap_spots.py --talk               # also the long pirate-radio talk

The server needs ELEVENLABS_API_KEY and ELEVENLABS_VOICES="Rocky=<voice id>,Britta=<voice id>" (see
chips-voice/docs/CLOUD-AND-AI.md). Nothing secret is read from, or written to, the KRAP scripts.
"""
import argparse
import json
import os
import runpy
import sys
import urllib.error
import urllib.request

HERE = os.path.dirname(os.path.abspath(__file__))
DEFAULT_SCRIPTS = os.path.normpath(os.path.join(HERE, "..", "..", "krap-station", "krap", "scripts.py"))


def load_scripts(path):
    # The file only defines data (dicts and lists), but it is still code: run it with the interpreter's
    # isolated mode on (python3 -I) if you do not trust the checkout.
    ns = runpy.run_path(path)
    return {"spots": ns.get("SPOTS", {}), "fun": ns.get("SPOTS_FUN", {}), "talk": ns.get("TALK")}


def call(base, key, method, path, body=None):
    data = json.dumps(body).encode() if body is not None else None
    req = urllib.request.Request(base.rstrip("/") + path, data=data, method=method,
                                 headers={"Content-Type": "application/json", "x-api-key": key})
    try:
        with urllib.request.urlopen(req, timeout=600) as res:
            return json.loads(res.read().decode())
    except urllib.error.HTTPError as err:
        detail = err.read().decode()[:300]
        raise SystemExit(f"{method} {path} failed: {err.code} {detail}")


def to_turns(turns, voices):
    out = []
    for speaker, text in turns:
        if speaker not in voices:
            raise SystemExit(f'speaker "{speaker}" has no voice; pass --voices {speaker}=<name>')
        out.append({"voice": voices[speaker], "text": text})
    return out


def main():
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("--scripts", default=DEFAULT_SCRIPTS, help="path to krap/scripts.py")
    ap.add_argument("--url", default=os.environ.get("CHIPS_VOICE_URL", "http://localhost:3000"))
    ap.add_argument("--voices", nargs="*", default=["R=Rocky", "B=Britta"], metavar="X=NAME",
                    help="speaker letter to a voice name from ELEVENLABS_VOICES (default R=Rocky B=Britta)")
    ap.add_argument("--provider", default="elevenlabs")
    ap.add_argument("--only", nargs="*", help="only these spot names")
    ap.add_argument("--fun", action="store_true", help="also import SPOTS_FUN")
    ap.add_argument("--talk", action="store_true", help="also import the long TALK script")
    ap.add_argument("--tag", default="krap")
    ap.add_argument("--dry-run", action="store_true", help="list what would be sent, call nothing")
    args = ap.parse_args()

    voices = dict(v.split("=", 1) for v in args.voices)
    found = load_scripts(args.scripts)
    jobs = dict(found["spots"])
    if args.fun:
        jobs.update({f"fun_{k}": v for k, v in found["fun"].items()})
    if args.talk and found["talk"]:
        jobs["pirate_radio_talk"] = found["talk"]
    if args.only:
        jobs = {k: v for k, v in jobs.items() if k in args.only}
    if not jobs:
        raise SystemExit("nothing to import (check --only and the scripts path)")

    key = os.environ.get("CHIPS_VOICE_KEY", "")
    if not key and not args.dry_run:
        raise SystemExit("set CHIPS_VOICE_KEY to the server's API key")

    for name, turns in jobs.items():
        chars = sum(len(t) for _, t in turns)
        print(f"{name}: {len(turns)} lines, {chars} characters")
        if args.dry_run:
            continue
        made = call(args.url, key, "POST", "/synth", {"turns": to_turns(turns, voices), "provider": args.provider})
        clip = made["clip"]
        call(args.url, key, "PATCH", f"/clips/{clip['id']}", {"title": name.replace("_", " "), "tags": [args.tag]})
        print(f"  -> {'already in library' if made['reused'] else 'created'} {clip['id']}")


if __name__ == "__main__":
    main()
