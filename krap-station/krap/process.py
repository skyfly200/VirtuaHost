#!/usr/bin/env python3 -I
"""Re-process raw KRAP dialogue mp3s (no API credits): speed up, trim pauses, add texture. Usage: process.py <tempo> <outdir>"""
import os, sys, glob, subprocess
sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
FF = os.path.expanduser("~/.local/bin/ffmpeg")
RAW = os.path.expanduser("~/.openclaw/workspace/media/outbound/krap-drops/v5/raw")
tempo, out = sys.argv[1], sys.argv[2]
os.makedirs(out, exist_ok=True)
PRE = (f"silenceremove=stop_periods=-1:stop_duration=0.18:stop_threshold=-45dB:stop_silence=0.10,"
       f"atempo={tempo}")
TEX = ("afftdn=nr=10:nf=-45,highpass=f=85,lowpass=f=9000,"
       "equalizer=f=220:t=q:w=1:g=2,equalizer=f=4500:t=q:w=1:g=-2,"
       "acompressor=threshold=-20dB:ratio=3:attack=5:release=80:makeup=3,"
       "aecho=0.85:0.7:18:0.10")
for f in sorted(glob.glob(RAW + "/*.mp3")):
    dst = out + "/" + os.path.basename(f).replace("KRAP_v5_", "KRAP_v6_")
    fc = (f"[0:a]{PRE},{TEX}[v];anoisesrc=c=pink:a=0.0045:r=44100,lowpass=f=6000[n];"
          "[v][n]amix=inputs=2:duration=first:normalize=0,loudnorm=I=-16:TP=-1.5:LRA=11")
    subprocess.run([FF, "-y", "-loglevel", "error", "-i", f, "-filter_complex", fc, "-ar", "44100", "-ac", "2",
                    "-c:a", "libmp3lame", "-b:a", "128k", dst], check=True)
    d = subprocess.run([FF, "-i", dst], capture_output=True, text=True).stderr
    print(os.path.basename(dst), [l.strip()[:21] for l in d.splitlines() if "Duration" in l])
