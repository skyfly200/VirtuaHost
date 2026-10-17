// ffmpeg helpers: joining speech parts and shrinking uploaded audio. ffmpeg is optional; callers that
// need it get a clear error when it is missing.
const { spawn, spawnSync } = require('child_process');
const fs = require('fs');
const os = require('os');
const path = require('path');

const bin = () => process.env.FFMPEG_BIN || 'ffmpeg';

function ffmpegAvailable() {
  const r = spawnSync(bin(), ['-version'], { stdio: 'ignore' });
  return !r.error && r.status === 0;
}

function run(args) {
  return new Promise((resolve, reject) => {
    const child = spawn(bin(), ['-y', '-loglevel', 'error', ...args], { stdio: ['ignore', 'ignore', 'pipe'] });
    let stderr = '';
    child.stderr.on('data', (d) => { stderr += d; });
    child.on('error', (err) => reject(err.code === 'ENOENT' ? new Error('ffmpeg is not installed (set FFMPEG_BIN)') : err));
    child.on('close', (code) => (code === 0 ? resolve() : reject(new Error(`ffmpeg failed: ${stderr.slice(0, 300)}`))));
  });
}

async function withTempDir(fn) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'cv-audio-'));
  try { return await fn(dir); } finally { fs.rmSync(dir, { recursive: true, force: true }); }
}

// Joins MP3 buffers with a short silence between them (used when a long script is split into parts).
function concatMp3(parts, gap = 0.25) {
  if (parts.length === 1) return Promise.resolve(parts[0]);
  return withTempDir(async (dir) => {
    await run(['-f', 'lavfi', '-i', 'anullsrc=r=44100:cl=mono', '-t', String(gap), '-c:a', 'libmp3lame', path.join(dir, 'gap.mp3')]);
    const lines = [];
    parts.forEach((p, i) => { fs.writeFileSync(path.join(dir, `p${i}.mp3`), p); lines.push(`file 'p${i}.mp3'`, "file 'gap.mp3'"); });
    fs.writeFileSync(path.join(dir, 'list.txt'), lines.slice(0, -1).join('\n'));
    await run(['-f', 'concat', '-safe', '0', '-i', path.join(dir, 'list.txt'), '-ar', '44100', '-ac', '1', '-c:a', 'libmp3lame', '-b:a', '128k', path.join(dir, 'out.mp3')]);
    return fs.readFileSync(path.join(dir, 'out.mp3'));
  });
}

// Any audio file (wav, ogg, ...) to MP3 at the stream bitrate. Keeps uploaded clips small on a small disk.
function toMp3(buffer, { bitrate = '128k' } = {}) {
  return withTempDir(async (dir) => {
    fs.writeFileSync(path.join(dir, 'in'), buffer);
    await run(['-i', path.join(dir, 'in'), '-vn', '-ar', '44100', '-ac', '1', '-c:a', 'libmp3lame', '-b:a', bitrate, path.join(dir, 'out.mp3')]);
    return fs.readFileSync(path.join(dir, 'out.mp3'));
  });
}

module.exports = { ffmpegAvailable, concatMp3, toMp3 };
