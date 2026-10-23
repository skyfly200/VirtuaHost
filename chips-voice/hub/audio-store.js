// Finished clips by content hash (sha256 of the audio bytes). On disk when a folder is given, otherwise in memory (tests, or no HUB_DATA).
const fs = require('fs');
const path = require('path');

function createAudioStore(dir = '') {
  const mem = new Map();
  const ok = (hash) => /^[0-9a-f]{64}$/.test(hash);
  const file = (hash, mime) => path.join(dir, `${hash}.${/wav/.test(mime) ? 'wav' : /ogg/.test(mime) ? 'ogg' : 'mp3'}`);
  const find = (hash) => {
    if (!dir) return null;
    for (const ext of ['mp3', 'wav', 'ogg']) { const f = path.join(dir, `${hash}.${ext}`); if (fs.existsSync(f)) return f; }
    return null;
  };
  return {
    put(hash, buffer, mime = 'audio/mpeg') {
      if (!ok(hash)) throw new Error('bad audio hash');
      if (!dir) { mem.set(hash, { buffer, mime }); return; }
      fs.mkdirSync(dir, { recursive: true });
      const f = file(hash, mime);
      if (!fs.existsSync(f)) { fs.writeFileSync(`${f}.tmp`, buffer, { mode: 0o600 }); fs.renameSync(`${f}.tmp`, f); }
    },
    get(hash) {
      if (!ok(hash)) return null;
      if (!dir) return mem.get(hash) || null;
      const f = find(hash);
      return f ? { buffer: fs.readFileSync(f), mime: f.endsWith('.wav') ? 'audio/wav' : f.endsWith('.ogg') ? 'audio/ogg' : 'audio/mpeg' } : null;
    },
    has(hash) { return ok(hash) && (dir ? !!find(hash) : mem.has(hash)); },
    remove(hash) { if (!ok(hash)) return; if (!dir) { mem.delete(hash); return; } const f = find(hash); if (f) fs.unlinkSync(f); },
    list() { return dir ? (fs.existsSync(dir) ? fs.readdirSync(dir).filter((n) => /^[0-9a-f]{64}\./.test(n)).map((n) => n.slice(0, 64)) : []) : [...mem.keys()]; },
  };
}

module.exports = { createAudioStore };
