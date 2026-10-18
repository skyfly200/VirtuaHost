const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const lib = require('../lib/library');

function fixture() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'lib-'));
  const music = path.join(root, 'music');
  fs.mkdirSync(path.join(music, 'Artist'), { recursive: true });
  fs.mkdirSync(path.join(music, '.hidden'));
  fs.writeFileSync(path.join(music, 'Artist', 'One.mp3'), 'x'.repeat(10));
  fs.writeFileSync(path.join(music, 'Two.flac'), 'yy');
  fs.writeFileSync(path.join(music, 'notes.txt'), 'no');
  fs.writeFileSync(path.join(music, '.hidden', 'Secret.mp3'), 'z');
  fs.writeFileSync(path.join(root, 'outside.mp3'), 'o');
  return { root, music, lists: path.join(root, 'lists') };
}

test('the library lists audio files only, with relative paths and sizes, and skips hidden folders', () => {
  const f = fixture();
  assert.deepStrictEqual(lib.listTracks(f.music), [{ path: 'Artist/One.mp3', size: 10 }, { path: 'Two.flac', size: 2 }]);
  assert.deepStrictEqual(lib.listTracks(path.join(f.root, 'nope')), []);
});

test('a playlist keeps the tracks this station has and reports the rest as missing', () => {
  const f = fixture();
  const out = lib.writePlaylist(f.lists, f.music, 'Late Night', ['Artist/One.mp3', 'Gone/Missing.mp3', 'Two.flac']);
  assert.strictEqual(out.written, 2);
  assert.deepStrictEqual(out.missing, ['Gone/Missing.mp3']);
  const text = fs.readFileSync(out.file, 'utf8');
  assert.match(text, /^#EXTM3U\n/);
  assert.ok(text.includes(path.join(f.music, 'Artist', 'One.mp3')));
  assert.deepStrictEqual(lib.listPlaylists(f.lists), ['Late Night']);
  assert.strictEqual(lib.playlistFile(f.lists, 'Late Night'), out.file);
  assert.strictEqual(lib.playlistFile(f.lists, 'nope'), null);
});

test('track paths cannot leave the music folder, and names cannot leave the playlist folder', () => {
  const f = fixture();
  const out = lib.writePlaylist(f.lists, f.music, 'x', ['../outside.mp3', '/etc/passwd', 'Artist/../../outside.mp3', 'notes.txt', 'Two.flac']);
  assert.strictEqual(out.written, 1);
  assert.strictEqual(out.missing.length, 4);
  for (const bad of ['../evil', 'a/b', '', '.hidden', 'x'.repeat(61)]) assert.throws(() => lib.writePlaylist(f.lists, f.music, bad, ['Two.flac']), lib.LibraryError);
  assert.strictEqual(lib.playlistFile(f.lists, '../x'), null);
});

test('empty lists and lists with nothing usable are refused', () => {
  const f = fixture();
  assert.throws(() => lib.writePlaylist(f.lists, f.music, 'a', []), /non-empty/);
  assert.throws(() => lib.writePlaylist(f.lists, f.music, 'a', 'nope'), /non-empty/);
  assert.throws(() => lib.writePlaylist(f.lists, f.music, 'a', ['Gone.mp3']), /none of the 1 tracks/);
});
