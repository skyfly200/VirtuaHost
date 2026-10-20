// Pre-mixes scripts into finished audio files: speech from the site's /api/generate, [sfx:name] effects mixed in with
// ffmpeg (the same parser and mixer the Chips Voice server uses, chips-voice/googleTextToSpeech1/lib/sfx.js), then
// loudness-normalised. Meant for scripts known ahead of time (station IDs, promos, scheduled shows); run by
// .github/workflows/premix.yml, or by hand.
//
//   node scripts/premix.mjs [--dry-run] [--publish] [--in premix] [--out premix-out] [file.txt ...]
//
//   SITE_URL, ACCESS_KEY   the deployed site and its machine key (not needed with --dry-run)
//
// --publish saves each finished file to the site's clip library (POST /api/clips). With the site in STATION_MODE=queue, a
// "# send: air" header also queues it to go on air, and "# send: library" queues it for the station to keep; without a
// send header it is only saved.
//
// A script is premix/<name>.txt. Leading "# key: value" lines set voice, tone, speechModel, loudness (LUFS, default
// -16, "off" to skip), send (air | library), and metadata for other systems: kind, title, tags (comma list) and expires (ISO 8601, nothing
// plays the clip after it); the rest is the text, with tags like [sfx:ding], [sfx:whoosh over], [sfx:crowd vol=0.5].
// Sound effects: the built-ins, plus any premix/sfx/<name>.mp3|wav|ogg (these override a built-in of the same name). With
// SITE_URL and ACCESS_KEY set, effects and music from the site's cloud library (OwnCloud / Google Drive, docs/LIBRARY.md) work
// too, and `[music:name vol=0.2]` puts a library music bed under the whole clip (fading in before the first word, out after the last).
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { createRequire } from "node:module";

const require = createRequire(import.meta.url);
const root = path.resolve(path.dirname(new URL(import.meta.url).pathname), "..");
const voiceDir = path.join(root, "chips-voice/googleTextToSpeech1/lib");
const audio = require(path.join(voiceDir, "audio.js"));
const { createSfx } = require(path.join(voiceDir, "sfx.js"));

const args = process.argv.slice(2);
const flag = (name) => args.includes(name);
const option = (name, fallback) => { const i = args.indexOf(name); return i >= 0 ? args[i + 1] : fallback; };
const dry = flag("--dry-run");
const publish = flag("--publish");
const inDir = path.resolve(option("--in", "premix"));
const outDir = path.resolve(option("--out", "premix-out"));
const named = args.filter((a, i) => !a.startsWith("--") && args[i - 1] !== "--in" && args[i - 1] !== "--out");

// "# key: value" header lines, then the text.
export function parseScript(source) {
  const meta = {};
  const lines = source.split(/\r?\n/);
  let i = 0;
  for (; i < lines.length; i++) {
    const m = /^#\s*([A-Za-z]+)\s*:\s*(.*)$/.exec(lines[i]);
    if (!m) break;
    meta[m[1]] = m[2].trim();
  }
  return { meta, text: lines.slice(i).join("\n").trim() };
}

// "[music:name vol=0.2]" out of the text: the bed to use, and the text without it. One bed per script.
export function extractMusic(text) {
  const tag = /\[\s*music\s*:\s*([a-z0-9_-]{1,40})((?:\s+vol=[0-9.]+)?)\s*\]/gi;
  const found = [...text.matchAll(tag)];
  if (found.length > 1) throw new Error("use only one [music:...] bed per script");
  const rest = text.replace(tag, " ").replace(/\s{2,}/g, " ").trim();
  if (/\[\s*music\s*:/i.test(rest)) throw new Error("a music tag is malformed (use [music:name] or [music:name vol=0.2])");
  if (!found.length) return { text, music: null };
  const vol = Number(/vol=([0-9.]+)/i.exec(found[0][2])?.[1] ?? 0.25);
  return { text: rest, music: { name: found[0][1].toLowerCase(), vol: Math.min(1, Math.max(0, Number.isFinite(vol) ? vol : 0.25)) } };
}

// ----- the site's cloud library (optional) -----
const siteReady = () => Boolean(process.env.SITE_URL && process.env.ACCESS_KEY);
const libraryCache = new Map();
async function libraryItem(kind, name) {
  if (!libraryCache.has(kind)) {
    const res = await fetch(`${process.env.SITE_URL.replace(/\/+$/, "")}/api/library?kind=${kind}`, { headers: { "x-api-key": process.env.ACCESS_KEY } });
    if (!res.ok) throw new Error(`could not read the library (${res.status})`);
    libraryCache.set(kind, (await res.json()).items ?? []);
  }
  return libraryCache.get(kind).find((i) => i.name === name);
}
async function libraryFile(kind, name) {
  const item = await libraryItem(kind, name);
  if (!item) return null;
  const res = await fetch(`${process.env.SITE_URL.replace(/\/+$/, "")}/api/library/${encodeURIComponent(item.source)}/${kind}/${encodeURIComponent(item.name)}`, { headers: { "x-api-key": process.env.ACCESS_KEY } });
  if (!res.ok) throw new Error(`could not download "${name}" from the library (${res.status})`);
  return Buffer.from(await res.arrayBuffer());
}

// Music under the finished speech: a short lead-in, a fade in, and a fade out after the last word.
const LEAD = 0.8;
const TAIL = 1.5;
function durationOf(file) {
  const r = spawnSync(process.env.FFPROBE_BIN || "ffprobe", ["-v", "error", "-show_entries", "format=duration", "-of", "csv=p=0", file], { encoding: "utf8" });
  const d = Number(r.stdout);
  if (!Number.isFinite(d) || d <= 0) throw new Error("could not measure the clip (is ffprobe installed?)");
  return d;
}
const withBed = (speech, bed, vol) => audio.withTempDir(async (tmp) => {
  const sp = path.join(tmp, "speech"); const bd = path.join(tmp, "bed");
  fs.writeFileSync(sp, speech); fs.writeFileSync(bd, bed);
  const total = durationOf(sp) + LEAD + TAIL;
  const graph = `[0:a]aresample=44100,adelay=${Math.round(LEAD * 1000)}|${Math.round(LEAD * 1000)},apad=pad_dur=${TAIL}[s];[1:a]aresample=44100,volume=${vol},afade=t=in:d=0.5,atrim=0:${total.toFixed(3)},afade=t=out:st=${(total - TAIL).toFixed(3)}:d=${TAIL}[b];[s][b]amix=inputs=2:duration=longest:normalize=0,atrim=0:${total.toFixed(3)}`;
  await audio.run(["-i", sp, "-stream_loop", "-1", "-i", bd, "-filter_complex", graph, "-ar", "44100", "-ac", "1", "-c:a", "libmp3lame", "-b:a", "128k", path.join(tmp, "out.mp3")]);
  return fs.readFileSync(path.join(tmp, "out.mp3"));
});

async function speak(text, meta) {
  const site = (process.env.SITE_URL || "").replace(/\/+$/, "");
  const key = process.env.ACCESS_KEY;
  if (!site || !key) throw new Error("SITE_URL and ACCESS_KEY are required (or use --dry-run)");
  const body = { mode: "say", text, handoff: false, ...(meta.voice ? { voice: meta.voice } : {}), ...(meta.tone ? { tone: meta.tone } : {}), ...(meta.speechModel ? { speechModel: meta.speechModel } : {}) };
  const res = await fetch(`${site}/api/generate`, { method: "POST", headers: { "content-type": "application/json", "x-api-key": key }, body: JSON.stringify(body) });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(`generate failed (${res.status}): ${data.error ?? "no detail"}`);
  const clip = await fetch(`${site}${data.audioUrl}`, { headers: { "x-api-key": key } });
  if (!clip.ok) throw new Error(`could not download the clip (${clip.status})`);
  return Buffer.from(await clip.arrayBuffer());
}

async function publishClip(buffer, name, meta, text, effects) {
  const site = (process.env.SITE_URL || "").replace(/\/+$/, "");
  const key = process.env.ACCESS_KEY;
  const send = meta.send === "air" || meta.send === "library" ? meta.send : null;
  const info = { source: "premix", ...(meta.kind ? { kind: meta.kind } : {}), ...(meta.title ? { title: meta.title } : {}), ...(meta.expires ? { expiresAt: meta.expires } : {}), ...(meta.tags ? { tags: meta.tags.split(",").map((t) => t.trim()) } : {}) };
  const details = { mode: "say", input: text, scriptText: text.slice(0, 2000), voice: meta.voice || "", tone: meta.tone, speechModel: meta.speechModel, effects, info, handoff: send !== null, ...(send ? { play: send === "air" } : {}) };
  const res = await fetch(`${site}/api/clips`, { method: "POST", headers: { "content-type": "audio/mpeg", "x-api-key": key, "x-clip-meta": encodeURIComponent(JSON.stringify(details)) }, body: buffer });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(`publish failed (${res.status}): ${data.error ?? "no detail"}`);
  return data;
}

const loudnorm = (buffer, lufs) => audio.withTempDir(async (tmp) => {
  fs.writeFileSync(path.join(tmp, "in"), buffer);
  await audio.run(["-i", path.join(tmp, "in"), "-af", `loudnorm=I=${lufs}:TP=-1.5:LRA=11`, "-ar", "44100", "-c:a", "libmp3lame", "-b:a", "128k", path.join(tmp, "out.mp3")]);
  return fs.readFileSync(path.join(tmp, "out.mp3"));
});

async function main() {
  const files = (named.length ? named : fs.readdirSync(inDir).filter((f) => f.endsWith(".txt"))).map((f) => path.resolve(inDir, path.basename(f)));
  if (!files.length) { console.log(`No scripts in ${inDir}`); return; }
  if (!audio.ffmpegAvailable()) throw new Error("ffmpeg is not installed");

  const work = fs.mkdtempSync(path.join(os.tmpdir(), "premix-"));
  const sfx = createSfx({ dir: path.join(work, "sfx"), builtinDir: path.join(work, "builtin") });
  const customDir = path.join(inDir, "sfx");
  if (fs.existsSync(customDir)) {
    for (const f of fs.readdirSync(customDir).filter((n) => /\.(mp3|wav|ogg)$/i.test(n))) {
      await sfx.put(f.replace(/\.[^.]+$/, ""), fs.readFileSync(path.join(customDir, f)));
    }
  }

  fs.mkdirSync(outDir, { recursive: true });
  let failed = 0;
  for (const file of files) {
    const name = path.basename(file, ".txt");
    try {
      const parsed = parseScript(fs.readFileSync(file, "utf8"));
      const { meta } = parsed;
      if (!parsed.text) throw new Error("the script is empty");
      const { text, music } = extractMusic(parsed.text);
      if (!text) throw new Error("the script has music but no words");

      // Effects that are not built in or in premix/sfx come from the site's library, when the site is configured.
      if (siteReady()) {
        for (const m of text.matchAll(/\[\s*sfx\s*:\s*([a-z0-9_-]{1,40})/gi)) {
          const sound = m[1].toLowerCase();
          if (sfx.has(sound)) continue;
          const file = await libraryFile("sfx", sound);
          if (file) await sfx.put(sound, file);
        }
      }
      const plan = sfx.plan({ text }); // throws on an unknown or malformed [sfx:...] tag
      let bed = null;
      if (music) {
        if (!siteReady()) { if (!dry) throw new Error(`[music:${music.name}] needs SITE_URL and ACCESS_KEY to read the library`); }
        else {
          bed = await libraryFile("music", music.name);
          if (!bed) throw new Error(`unknown music "${music.name}" (not in the library)`);
        }
      }
      if (dry) { console.log(`ok   ${name}${plan ? ` (${plan.filter((i) => i.kind === "sfx").length} effects)` : ""}${music ? `, music ${music.name}${bed ? "" : " (not checked: no SITE_URL)"}` : ""}`); continue; }

      let mixed;
      if (!plan) {
        mixed = await speak(text, meta);
      } else {
        const items = [];
        for (const item of plan) {
          items.push(item.kind === "speech" ? { kind: "speech", buffer: await speak(item.text, meta) } : { ...item, path: await sfx.file(item.name) });
        }
        mixed = await sfx.assemble(items);
      }
      if (bed) mixed = await withBed(mixed, bed, music.vol);
      const lufs = meta.loudness === "off" ? null : Number(meta.loudness) || -16;
      const final = lufs === null ? mixed : await loudnorm(mixed, lufs);
      fs.writeFileSync(path.join(outDir, `${name}.mp3`), final);
      let note = "";
      if (publish) {
        const saved = await publishClip(final, name, meta, parsed.text, [...(plan ? plan.filter((i) => i.kind === "sfx").map((i) => i.name) : []), ...(music ? [music.name] : [])]);
        note = ` -> saved as ${saved.id}${saved.handoff ? (saved.handoff.sent ? ", sent to the station" : `, station hand-off failed: ${saved.handoff.error}`) : ""}`;
      }
      console.log(`done ${name} (${Math.round(final.length / 1024)} KB)${note}`);
    } catch (err) {
      failed += 1;
      console.error(`FAIL ${name}: ${err.message}`);
    }
  }
  fs.rmSync(work, { recursive: true, force: true });
  if (failed) process.exit(1);
}

if (import.meta.url === `file://${process.argv[1]}`) main().catch((err) => { console.error(err.message); process.exit(1); });
