// A tiny JSON-file store for the clip catalogue and schedules.
// One process owns the file; writes are atomic (temp file + rename) and debounced.
const fs = require('fs');
const path = require('path');

function createStore(file, defaults = {}) {
  let data = JSON.parse(JSON.stringify(defaults));
  if (file && fs.existsSync(file)) {
    try {
      data = { ...data, ...JSON.parse(fs.readFileSync(file, 'utf8')) };
    } catch (err) {
      // Keep the unreadable file for inspection instead of overwriting it.
      fs.renameSync(file, `${file}.corrupt-${Date.now()}`);
    }
  }

  let timer = null;
  function flush() {
    if (timer) { clearTimeout(timer); timer = null; }
    if (!file) return;
    fs.mkdirSync(path.dirname(file), { recursive: true });
    const tmp = `${file}.tmp`;
    fs.writeFileSync(tmp, JSON.stringify(data, null, 2));
    fs.renameSync(tmp, file);
  }

  function save() {
    if (!file || timer) return;
    timer = setTimeout(flush, 200);
    if (timer.unref) timer.unref();
  }

  return { data, save, flush };
}

module.exports = { createStore };
