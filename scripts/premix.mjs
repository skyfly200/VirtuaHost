// Pre-mixes scripts into finished audio files: speech from the site's /api/generate, [sfx:name] effects mixed in with
// ffmpeg (the same parser and mixer the Chips Voice server uses, chips-voice/googleTextToSpeech1/lib/sfx.js), then
// loudness-normalised. Meant for scripts known ahead of time (station IDs, promos, scheduled shows); run by
// .github/workflows/premix.yml, or by hand.
//
//   node scripts/premix.mjs [--dry-run] [--in premix] [--out premix-out] [file.txt ...]
//
//   SITE_URL, ACCESS_KEY   the deployed site and its machine key (not needed with --dry-run)
//
// A script is premix/<name>.txt. Leading "# key: value" lines set voice, tone, speechModel and loudness (LUFS, default
// -16, "off" to skip); the rest is the text, with tags like [sfx:ding], [sfx:whoosh over], [sfx:crowd vol=0.5].
// Sound effects: the built-ins, plus any premix/sfx/<name>.mp3|wav|ogg (these override a built-in of the same name).
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
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
      const { meta, text } = parseScript(fs.readFileSync(file, "utf8"));
      if (!text) throw new Error("the script is empty");
      const plan = sfx.plan({ text }); // throws on an unknown or malformed [sfx:...] tag
      if (dry) { console.log(`ok   ${name}${plan ? ` (${plan.filter((i) => i.kind === "sfx").length} effects)` : ""}`); continue; }

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
      const lufs = meta.loudness === "off" ? null : Number(meta.loudness) || -16;
      const final = lufs === null ? mixed : await loudnorm(mixed, lufs);
      fs.writeFileSync(path.join(outDir, `${name}.mp3`), final);
      console.log(`done ${name} (${Math.round(final.length / 1024)} KB)`);
    } catch (err) {
      failed += 1;
      console.error(`FAIL ${name}: ${err.message}`);
    }
  }
  fs.rmSync(work, { recursive: true, force: true });
  if (failed) process.exit(1);
}

if (import.meta.url === `file://${process.argv[1]}`) main().catch((err) => { console.error(err.message); process.exit(1); });
