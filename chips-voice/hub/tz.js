// Time zone helpers. Two zones are NEVER the same thing here:
//   broadcastTz  the station's wall clock (America/Denver for Green Light Radio): {{time}}, schedules, "tonight at 7", weather wording.
//   machineTz    the clock of the PC that runs RadioDJ (may be Central while broadcasting Denver): used ONLY to read timestamps that
//                come from that PC (RadioDJ history / now playing), which are written as local time with no zone.
// Zero dependencies (Intl only). hub/tz.js is an identical copy (a test keeps them in sync); lib/timezones.ts is the site's typed twin.

const fmtCache = new Map();
function formatter(tz) {
  let f = fmtCache.get(tz);
  if (!f) {
    f = new Intl.DateTimeFormat('en-US', { timeZone: tz, hourCycle: 'h23', year: 'numeric', month: 'numeric', day: 'numeric', hour: 'numeric', minute: 'numeric', second: 'numeric' });
    fmtCache.set(tz, f);
  }
  return f;
}

function validTimeZone(tz) {
  if (typeof tz !== 'string' || !tz.trim()) return false;
  try { formatter(tz); return true; } catch (err) { return false; }
}

// The wall-clock parts of an instant (ms since epoch) in a zone.
function parts(ms, tz) {
  const got = {};
  for (const p of formatter(tz).formatToParts(new Date(ms))) if (p.type !== 'literal') got[p.type] = Number(p.value);
  return { year: got.year, month: got.month, day: got.day, hour: got.hour % 24, minute: got.minute, second: got.second };
}

// The zone's offset from UTC at an instant, in minutes (Denver in July: -360).
function offsetMinutes(ms, tz) {
  const p = parts(ms, tz);
  return Math.round((Date.UTC(p.year, p.month - 1, p.day, p.hour, p.minute, p.second) - Math.floor(ms / 1000) * 1000) / 60000);
}

// All instants at which the clock in `tz` reads the given local time: none (a spring-forward gap), one, or two (a fall-back repeat).
function localInstants(c, tz) {
  const naive = Date.UTC(c.year, c.month - 1, c.day, c.hour || 0, c.minute || 0, c.second || 0);
  const found = new Set();
  // The real offset is one of the offsets in effect around that day; try each and keep the ones that round-trip.
  for (const probe of [naive - 36 * 3600e3, naive, naive + 36 * 3600e3]) {
    const off = offsetMinutes(probe, tz);
    const ms = naive - off * 60000;
    if (offsetMinutes(ms, tz) === off) found.add(ms);
  }
  return [...found].sort((a, b) => a - b);
}

// A local time in `tz` as an instant. In the repeated hour of a fall-back change it takes the candidate nearest `near` (default: the first);
// in a spring-forward gap, where that time never happened, it moves forward by the gap, the way a clock would.
function localToInstant(c, tz, { near } = {}) {
  const list = localInstants(c, tz);
  if (list.length === 1) return list[0];
  if (list.length === 2) return near === undefined ? list[0] : (Math.abs(list[0] - near) <= Math.abs(list[1] - near) ? list[0] : list[1]);
  const naive = Date.UTC(c.year, c.month - 1, c.day, c.hour || 0, c.minute || 0, c.second || 0);
  return naive - offsetMinutes(naive - 3 * 3600e3, tz) * 60000;           // in the gap: use the offset from before the change
}

// A timestamp written by the PC ("2026-10-22 17:05:30", ISO without a zone, or a Date's local fields) read in machineTz.
// Returns the real instant. Without a zone in the text it is interpreted in machineTz; with Z or an offset it is taken as written.
function parseMachineTimestamp(text, machineTz, { near } = {}) {
  const m = String(text).trim().match(/^(\d{4})-(\d{2})-(\d{2})[T ](\d{2}):(\d{2})(?::(\d{2}))?(?:\.\d+)?\s*(Z|[+-]\d{2}:?\d{2})?$/i);
  if (!m) return null;
  if (m[7]) return Date.parse(`${m[1]}-${m[2]}-${m[3]}T${m[4]}:${m[5]}:${m[6] || '00'}${m[7].toUpperCase() === 'Z' ? 'Z' : m[7].replace(/^([+-]\d{2})(\d{2})$/, '$1:$2')}`);
  if (!validTimeZone(machineTz)) return null;
  return localToInstant({ year: +m[1], month: +m[2], day: +m[3], hour: +m[4], minute: +m[5], second: +(m[6] || 0) }, machineTz, { near });
}

const pad = (n) => String(n).padStart(2, '0');
// "2026-10-22 17:05:30" as the clock in `tz` shows it at an instant.
function formatLocal(ms, tz) {
  const p = parts(ms, tz);
  return `${p.year}-${pad(p.month)}-${pad(p.day)} ${pad(p.hour)}:${pad(p.minute)}:${pad(p.second)}`;
}
// The same, with the zone's offset: "2026-10-22T17:05:30-06:00".
function formatIso(ms, tz) {
  const off = offsetMinutes(ms, tz);
  const a = Math.abs(off);
  return `${formatLocal(ms, tz).replace(' ', 'T')}${off < 0 ? '-' : '+'}${pad(Math.floor(a / 60))}:${pad(a % 60)}`;
}

// The first and last instants of a calendar day ("2026-03-08") in a zone. Days are 23 or 25 hours long across a DST change.
function dayBounds(date, tz) {
  const m = String(date).match(/^(\d{4})-(\d{2})-(\d{2})$/);
  if (!m) return null;
  const start = localToInstant({ year: +m[1], month: +m[2], day: +m[3], hour: 0 }, tz);
  const next = new Date(Date.UTC(+m[1], +m[2] - 1, +m[3] + 1));
  const end = localToInstant({ year: next.getUTCFullYear(), month: next.getUTCMonth() + 1, day: next.getUTCDate(), hour: 0 }, tz);
  return { start, end, hours: (end - start) / 3600e3 };
}
// The calendar day ("YYYY-MM-DD") it is in a zone at an instant.
const dateIn = (ms, tz) => formatLocal(ms, tz).slice(0, 10);

// What to tell a person about the two clocks. `pcOffsetMinutes` is what the PC itself reports (-new Date().getTimezoneOffset(), in the
// UTC-offset sense: Central daylight = -300); when it differs from the offset of the declared machineTz, the declared zone is wrong or the PC
// clock is set to another zone. Returns a list of { code, level, message }; empty = nothing to say.
function zoneWarnings({ machineTz, broadcastTz, pcOffsetMinutes, now = Date.now() } = {}) {
  const out = [];
  if (!machineTz) out.push({ code: 'machine-tz-missing', level: 'warn', message: 'machineTz is not set. Set the time zone of the RadioDJ PC so its timestamps are read correctly.' });
  else if (!validTimeZone(machineTz)) out.push({ code: 'machine-tz-invalid', level: 'error', message: `machineTz "${machineTz}" is not a time zone name (use something like America/Chicago).` });
  if (!broadcastTz) out.push({ code: 'broadcast-tz-missing', level: 'warn', message: 'broadcastTz is not set. Set the station\'s own time zone (for example America/Denver).' });
  else if (!validTimeZone(broadcastTz)) out.push({ code: 'broadcast-tz-invalid', level: 'error', message: `broadcastTz "${broadcastTz}" is not a time zone name (use something like America/Denver).` });
  if (validTimeZone(machineTz) && validTimeZone(broadcastTz)) {
    const a = offsetMinutes(now, machineTz); const b = offsetMinutes(now, broadcastTz);
    if (a !== b) {
      const diff = (b - a) / 60;
      out.push({ code: 'zones-differ', level: 'warn', message: `The PC clock (${machineTz}) and the broadcast clock (${broadcastTz}) differ by ${Math.abs(diff)} hour${Math.abs(diff) === 1 ? '' : 's'} right now. Times from the PC are converted; on-air wording uses ${broadcastTz}.` });
    }
  }
  if (validTimeZone(machineTz) && Number.isFinite(pcOffsetMinutes)) {
    const declared = offsetMinutes(now, machineTz);
    if (declared !== pcOffsetMinutes) {
      out.push({ code: 'pc-offset-mismatch', level: 'error', message: `The PC reports a UTC offset of ${fmtOffset(pcOffsetMinutes)} but machineTz ${machineTz} is ${fmtOffset(declared)} right now. Fix machineTz or the PC's time zone setting.` });
    }
  }
  return out;
}
function fmtOffset(min) { const a = Math.abs(min); return `UTC${min < 0 ? '-' : '+'}${pad(Math.floor(a / 60))}:${pad(a % 60)}`; }

// The PC's own offset right now (the sense used above); in Node on the PC this is the machine's real clock setting.
const localOffsetMinutes = (d = new Date()) => -d.getTimezoneOffset();

module.exports = { validTimeZone, parts, offsetMinutes, localInstants, localToInstant, parseMachineTimestamp, formatLocal, formatIso, dayBounds, dateIn, zoneWarnings, localOffsetMinutes };
