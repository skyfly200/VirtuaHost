// Schedules announcements: once at a time, or repeating every N seconds (optionally limited to N runs).
// State lives in the store, so schedules survive restarts.
const crypto = require('crypto');

class ScheduleError extends Error {}

function createScheduler({ store, clips, play, now = Date.now, tickMs = 5000, graceMs = 5 * 60 * 1000, limits = {} }) {
  if (!store.data.schedules) store.data.schedules = {};
  const schedules = store.data.schedules;
  let timer = null;
  let ticking = false;

  function validate(input) {
    const startAt = typeof input.startAt === 'number' ? input.startAt : Date.parse(input.startAt);
    if (!Number.isFinite(startAt)) throw new ScheduleError('startAt must be a date and time');
    const intervalSec = Number(input.intervalSec || 0);
    if (!Number.isFinite(intervalSec) || intervalSec < 0 || (intervalSec > 0 && intervalSec < 30)) {
      throw new ScheduleError('intervalSec must be 0 (once) or at least 30');
    }
    const count = Math.floor(Number(input.count || 0));
    if (!Number.isFinite(count) || count < 0 || count > 10000) throw new ScheduleError('count must be 0 (no limit) to 10000');
    return { startAt, intervalSec, count };
  }

  return {
    ScheduleError,

    add(input) {
      const { startAt, intervalSec, count } = validate(input);
      let clipId = null;
      let spec = null;
      if (input.clipId) {
        if (!clips.get(input.clipId)) throw new ScheduleError('clip not found');
        clipId = input.clipId;
      } else {
        spec = clips.normalizeSpec(input.spec || {}, limits);    // throws on a bad spec
      }
      const id = crypto.randomBytes(6).toString('hex');
      const label = clipId ? clips.get(clipId).title : (spec.text || spec.ssml).slice(0, 60);
      schedules[id] = {
        id, name: String(input.name || label).slice(0, 80), clipId, spec,
        startAt, intervalSec, count, preempt: input.preempt === true,
        enabled: true, nextAt: startAt, runs: 0, lastRunAt: 0, lastResult: '', createdAt: now(),
      };
      store.save();
      return schedules[id];
    },

    list: () => Object.values(schedules).sort((a, b) => (a.nextAt || Infinity) - (b.nextAt || Infinity)),
    get: (id) => schedules[id] || null,

    update(id, patch = {}) {
      const s = schedules[id];
      if (!s) return null;
      if (typeof patch.name === 'string') s.name = patch.name.slice(0, 80) || s.name;
      if (typeof patch.preempt === 'boolean') s.preempt = patch.preempt;
      if (typeof patch.enabled === 'boolean') {
        s.enabled = patch.enabled;
        // Re-enabling a finished or overdue schedule restarts it from the next slot, not the past.
        if (s.enabled && s.nextAt < now() - graceMs) s.nextAt = s.intervalSec ? now() + s.intervalSec * 1000 : now() + 60000;
      }
      store.save();
      return s;
    },

    remove(id) {
      const had = !!schedules[id];
      delete schedules[id];
      if (had) store.save();
      return had;
    },

    // Runs every schedule that is due. Exposed so tests (and a "run now" button) can call it.
    async tick() {
      if (ticking) return;
      ticking = true;
      try {
        for (const s of Object.values(schedules)) {
          if (!s.enabled || s.nextAt > now()) continue;
          const late = now() - s.nextAt;
          if (late > graceMs) {
            s.lastResult = 'missed (server was off or busy)';
          } else {
            await this.run(s);
          }
          // Work out the next slot, skipping any that have already passed.
          if (s.intervalSec > 0 && (s.count === 0 || s.runs < s.count)) {
            const step = s.intervalSec * 1000;
            s.nextAt += step * Math.max(1, Math.ceil((now() - s.nextAt + 1) / step));
          } else {
            s.enabled = false;
          }
          store.save();
        }
      } finally {
        ticking = false;
      }
    },

    async run(s) {
      s.lastRunAt = now();
      s.runs += 1;
      try {
        const spec = s.clipId ? (clips.get(s.clipId) || {}).spec : s.spec;
        if (!spec) throw new Error('clip was deleted');
        const { clip } = await clips.getOrCreate(spec, limits);
        const result = await play(clip, { preempt: s.preempt });
        s.lastResult = result && result.played === false ? `skipped: ${result.reason}` : 'played';
      } catch (err) {
        s.lastResult = `error: ${err.message}`.slice(0, 200);
      }
    },

    start() {
      if (timer) return;
      timer = setInterval(() => this.tick().catch((e) => console.error('scheduler:', e)), tickMs);
      if (timer.unref) timer.unref();
    },

    stop() { if (timer) { clearInterval(timer); timer = null; } },
  };
}

module.exports = { createScheduler, ScheduleError };
