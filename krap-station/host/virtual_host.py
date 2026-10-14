#!/usr/bin/env python3 -I
"""KRAP virtual host v1: voice a short link about the track that just played.

Usage:
  virtual_host.py --say "Artist" "Title"      # make one link now (voice via ElevenLabs)
  virtual_host.py --say "Artist" "Title" --dry-run   # print the line only, no credits
  virtual_host.py --watch [--cart N]          # follow RadioDJ; near the end of each track, make a link
                                              # and (if --cart given) trigger that RadioDJ cart as the track ends

Needs: KRAP_ELEVENLABS_API_KEY in env, RadioDJ REST plugin on Windows localhost:8080,
~/.config/radiodj/rest-pass, ffmpeg at ~/.local/bin/ffmpeg. Output goes to C:\\KRAP\\Links.
The Rocky voice is only for station content.
"""
import os, re, sys, time, random, subprocess, datetime, argparse
HERE = os.path.dirname(os.path.abspath(__file__))
sys.path.insert(0, os.path.join(HERE, "..", "krap"))
CURL = "/mnt/c/Windows/System32/curl.exe"
BASE = "http://127.0.0.1:8080"
OUTDIR = "/mnt/c/KRAP/Links"
SKIP_ARTISTS = {"", "syndicate empire radio", "way high radio", "k.r.a.p. relay"}

TEMPLATES = [
    "That was {artist} with {title}. You're listening to K.R.A.P., ninety-seven point seven.",
    "{artist}, {title}. Mm. Stay right here on K.R.A.P.",
    "[chuckles] That was {title} by {artist}. More coming up, right here on K.R.A.P.",
    "{title}, from {artist}. This is K.R.A.P., the official radio of Apo-jee-uh.",
]
TIME_LINES = {
    "morning": " Good morning, wherever you are.",
    "afternoon": "",
    "evening": " Hope your evening's treating you well.",
    "night": " Late night, just us and the music.",
}

def pw():
    return open(os.path.expanduser("~/.config/radiodj/rest-pass")).read().strip()

def rest(path, **params):
    q = "&".join(f"{k}={v}" for k, v in dict(params, auth=pw()).items())
    r = subprocess.run([CURL, "-s", "-m", "8", f"{BASE}/{path}?{q}"], capture_output=True, text=True)
    return r.stdout

def tag(xml, name):
    m = re.search(rf"<{name}>(.*?)</{name}>", xml, re.S | re.I)
    return (m.group(1).strip() if m else "")

def now_playing():
    xml = rest("Status")
    return {"artist": tag(xml, "Artist"), "title": tag(xml, "Title"),
            "remaining": float(tag(xml, "PlayingTrackRemainingSeconds") or 0)}

def daypart(h):
    return "morning" if 5 <= h < 12 else "afternoon" if h < 17 else "evening" if h < 22 else "night"

def compose(artist, title):
    line = random.choice(TEMPLATES).format(artist=artist, title=title)
    if random.random() < 0.3:
        line += TIME_LINES[daypart(datetime.datetime.now().hour)]
    return line

def make_link(artist, title, dry=False):
    line = compose(artist, title)
    print("LINE:", line)
    if dry:
        return None
    import gen
    gen.OUT = OUTDIR
    stamp = datetime.datetime.now().strftime("%Y%m%d_%H%M%S")
    gen.finish(gen.dialogue([("R", line)]), f"link_{stamp}")
    path = f"{OUTDIR}/link_{stamp}.mp3"
    os.replace(path, f"{OUTDIR}/current_link.mp3")   # fixed name so one RadioDJ cart can always play it
    return f"{OUTDIR}/current_link.mp3"

def watch(cart):
    os.makedirs(OUTDIR, exist_ok=True)
    done = None
    while True:
        try:
            n = now_playing()
            key = (n["artist"], n["title"])
            real = n["artist"].lower() not in SKIP_ARTISTS and n["title"]
            if real and key != done and 0 < n["remaining"] <= 25:
                make_link(n["artist"], n["title"]); done = key
                armed = key
            if cart and real and done == key and 0 < n["remaining"] <= 2:
                rest("opt", command="PlayCartByNumber", arg=cart); done = (None, None)
        except Exception as e:
            print("watch error:", e)
        time.sleep(2)

if __name__ == "__main__":
    ap = argparse.ArgumentParser()
    ap.add_argument("--say", nargs=2, metavar=("ARTIST", "TITLE"))
    ap.add_argument("--dry-run", action="store_true")
    ap.add_argument("--watch", action="store_true")
    ap.add_argument("--cart")
    a = ap.parse_args()
    if a.say: make_link(a.say[0], a.say[1], a.dry_run)
    elif a.watch: watch(a.cart)
    else: ap.print_help()
