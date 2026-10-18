// The music library on disk, for syncing playlists between stations.
//
//   listTracks(musicDir)               -> [{ path, size }]   relative paths (forward slashes), audio files only
//   writePlaylist(dir, musicDir, name, items) -> { file, written, missing }
//                                       an .m3u of absolute paths for the items this machine has; the others are
//                                       reported as missing (the files themselves are never copied between stations)
//   playlistFile(dir, name)            -> absolute path of a saved playlist, or null
//   listPlaylists(dir)                 -> names of saved playlists
//
// Names and paths from outside are validated: nothing can point outside the music directory or the playlist directory.
const fs = require('fs');
const path = require('path');

const AUDIO = /\.(mp3|ogg|oga|opus|flac|wav|m4a|aac|wma)$/i;
const NAME = /^[A-Za-z0-9][A-Za-z0-9 _.-]{0,59}$/;
const MAX_TRACKS = 50000;
const MAX_ITEMS = 5000;

class LibraryError extends Error {}

function listTracks(musicDir, limit = MAX_TRACKS) {
  const out = [];
  const walk = (dir, rel) => {
    let entries;
    try { entries = fs.readdirSync(dir, { withFileTypes: true }); } catch (err) { return; }
    for (const e of entries) {
      if (out.length >= limit) return;
      if (e.name.startsWith('.')) continue;
      const full = path.join(dir, e.name);
      const r = rel ? `${rel}/${e.name}` : e.name;
      if (e.isDirectory()) walk(full, r);
      else if (e.isFile() && AUDIO.test(e.name)) out.push({ path: r, size: fs.statSync(full).size });
    }
  };
  walk(musicDir, '');
  return out.sort((a, b) => a.path.localeCompare(b.path));
}

function validName(name) {
  if (!NAME.test(String(name || ''))) throw new LibraryError('playlist names are letters, numbers, spaces, dots, dashes and underscores (up to 60)');
  return String(name);
}

// A relative track path that stays inside the music directory.
function safeTrack(musicDir, rel) {
  const text = String(rel || '');
  if (!text || text.length > 400 || text.includes('\0') || path.isAbsolute(text)) return null;
  const full = path.resolve(musicDir, text);
  if (!full.startsWith(path.resolve(musicDir) + path.sep)) return null;
  return AUDIO.test(full) ? full : null;
}

function writePlaylist(dir, musicDir, name, items) {
  validName(name);
  if (!Array.isArray(items) || !items.length) throw new LibraryError('items must be a non-empty list of track paths');
  if (items.length > MAX_ITEMS) throw new LibraryError(`at most ${MAX_ITEMS} tracks per playlist`);
  const have = [];
  const missing = [];
  for (const rel of items) {
    const full = safeTrack(musicDir, rel);
    if (full && fs.existsSync(full)) have.push(full); else missing.push(String(rel).slice(0, 400));
  }
  if (!have.length) throw new LibraryError(`none of the ${items.length} tracks are on this station`);
  fs.mkdirSync(dir, { recursive: true });
  const file = path.join(dir, `${name}.m3u`);
  fs.writeFileSync(`${file}.tmp`, `#EXTM3U\n${have.join('\n')}\n`);
  fs.renameSync(`${file}.tmp`, file);
  return { file, written: have.length, missing };
}

function playlistFile(dir, name) {
  if (!NAME.test(String(name || ''))) return null;
  const file = path.join(dir, `${name}.m3u`);
  return fs.existsSync(file) ? file : null;
}

function listPlaylists(dir) {
  try { return fs.readdirSync(dir).filter((f) => f.endsWith('.m3u')).map((f) => f.slice(0, -4)).sort(); } catch (err) { return []; }
}

module.exports = { listTracks, writePlaylist, playlistFile, listPlaylists, LibraryError, AUDIO };
