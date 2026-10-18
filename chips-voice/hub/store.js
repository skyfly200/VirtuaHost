// JSON-file store: stations, playlists and timed broadcasts. Atomic, debounced writes (same approach as the voice server).
const fs = require('fs');
const path = require('path');

function createStore(file, defaults = { stations: [], playlists: {}, jobs: [] }) {
  let data = JSON.parse(JSON.stringify(defaults));
  if (file && fs.existsSync(file)) {
    try { data = { ...data, ...JSON.parse(fs.readFileSync(file, 'utf8')) }; } catch (err) { fs.renameSync(file, `${file}.corrupt-${Date.now()}`); }
  }
  let timer = null;
  function flush() {
    if (timer) { clearTimeout(timer); timer = null; }
    if (!file) return;
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(`${file}.tmp`, JSON.stringify(data, null, 2), { mode: 0o600 });       // it holds station keys
    fs.renameSync(`${file}.tmp`, file);
  }
  function save() { if (!file || timer) return; timer = setTimeout(flush, 200); if (timer.unref) timer.unref(); }
  return { data, save, flush };
}

module.exports = { createStore };
