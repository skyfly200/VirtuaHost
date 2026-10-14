#!/usr/bin/env python3 -I
"""Generate K.R.A.P. spots/talk with ElevenLabs. Usage: gen.py spots|talk|one <name> ; key from ELEVENLABS_API_KEY env."""
import os, sys, json, subprocess, urllib.request, urllib.error, tempfile
sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
import scripts
KEY = os.environ.get("KRAP_ELEVENLABS_API_KEY") or os.environ["ELEVENLABS_API_KEY"]
V = {"R": "5amDDTRPktSyYIB9MtzS", "B": "DOg6sHAvvPBmlN73L7CI"}
FF = os.path.expanduser("~/.local/bin/ffmpeg")
OUT = os.path.expanduser(os.environ.get("KRAP_OUT", "~/.openclaw/workspace/media/outbound/krap-drops/v5"))
os.makedirs(OUT, exist_ok=True)

def post(path, body, tries=3):
    for i in range(tries):
        req = urllib.request.Request("https://api.elevenlabs.io" + path, json.dumps(body).encode(),
            {"xi-api-key": KEY, "Content-Type": "application/json", "Accept": "audio/mpeg"})
        try:
            return urllib.request.urlopen(req, timeout=300).read()
        except urllib.error.HTTPError as e:
            err = e.read().decode()[:300]
            if i == tries - 1: raise RuntimeError(f"{e.code} {err}")
        except Exception as e:
            if i == tries - 1: raise

def dialogue(turns):
    try:
        return post("/v1/text-to-dialogue?output_format=mp3_44100_128",
            {"model_id": "eleven_v3", "inputs": [{"text": t, "voice_id": V[s]} for s, t in turns],
             "settings": {"stability": float(os.environ.get("KRAP_STAB", "0.5"))}})
    except RuntimeError as e:
        print("dialogue API failed, per-line fallback:", e, file=sys.stderr)
        parts = []
        for s, t in turns:
            parts.append(post(f"/v1/text-to-speech/{V[s]}?output_format=mp3_44100_128",
                {"text": t, "model_id": "eleven_v3", "voice_settings": {"stability": 0.5}}))
        return concat(parts)

def run(*a): subprocess.run([FF, "-y", "-loglevel", "error", *a], check=True)

def concat(parts, gap=0.25):
    with tempfile.TemporaryDirectory() as d:
        lst = []
        run("-f", "lavfi", "-i", f"anullsrc=r=44100:cl=mono", "-t", str(gap), "-c:a", "libmp3lame", f"{d}/gap.mp3")
        for i, p in enumerate(parts):
            open(f"{d}/p{i}.mp3", "wb").write(p)
            lst.append(f"file 'p{i}.mp3'"); lst.append("file 'gap.mp3'")
        open(f"{d}/l.txt", "w").write("\n".join(lst[:-1]))
        run("-f", "concat", "-safe", "0", "-i", f"{d}/l.txt", "-ar", "44100", "-ac", "1", "-c:a", "libmp3lame", "-b:a", "128k", f"{d}/o.mp3")
        return open(f"{d}/o.mp3", "rb").read()

TEXTURE = ("[0:a]afftdn=nr=10:nf=-45,highpass=f=85,lowpass=f=9000,"
           "equalizer=f=220:t=q:w=1:g=2,equalizer=f=4500:t=q:w=1:g=-2,"
           "acompressor=threshold=-20dB:ratio=3:attack=5:release=80:makeup=3,"
           "aecho=0.85:0.7:18:0.10[v];"
           "anoisesrc=c=pink:a=0.0045:r=44100,lowpass=f=6000[n];"
           "[v][n]amix=inputs=2:duration=first:normalize=0,loudnorm=I=-16:TP=-1.5:LRA=11")

def finish(data, name):
    os.makedirs(OUT + "/raw", exist_ok=True)
    raw = f"{OUT}/raw/{name}.mp3"
    open(raw, "wb").write(data)
    dst = f"{OUT}/{name}.mp3"
    run("-i", raw, "-filter_complex", TEXTURE, "-ar", "44100", "-ac", "2", "-c:a", "libmp3lame", "-b:a", "128k", dst)
    print("wrote", dst, os.path.getsize(dst))

def chunks(turns, limit=2400):
    cur, n = [], 0
    for t in turns:
        if cur and n + len(t[1]) > limit: yield cur; cur, n = [], 0
        cur.append(t); n += len(t[1])
    if cur: yield cur

if __name__ == "__main__":
    what = sys.argv[1]
    if what == "one": finish(dialogue(scripts.SPOTS[sys.argv[2]]), "KRAP_v5_" + sys.argv[2])
    elif what == "spots":
        for k, t in scripts.SPOTS.items(): finish(dialogue(t), "KRAP_v5_" + k)
    elif what == "fun":
        for k, t in scripts.SPOTS_FUN.items(): finish(dialogue(t), "KRAP_v7_" + k)
    elif what == "talk":
        finish(concat([dialogue(c) for c in chunks(scripts.TALK)], gap=0.5), "KRAP_v5_special_pirate_radio_talk")
