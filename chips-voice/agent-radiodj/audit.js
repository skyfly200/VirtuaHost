// Append-only audit log and rate limits for the agent.
//   { at, hub, action, detail, result, status, reason }   one JSON object per line; the file is only ever appended to.
// Secrets never reach it: anything named like a key, token, password or secret is replaced, and URLs lose their query strings.
const fs = require('fs');
const path = require('path');

const SECRET_KEY = /key|token|secret|pass|auth|authorization/i;

function redact(value, depth = 0) {
  if (value === null || value === undefined) return value;
  if (typeof value === 'string') return value.replace(/(https?:\/\/[^\s?"']+)\?[^\s"']*/g, '$1?…').slice(0, 300);
  if (typeof value !== 'object' || depth > 4) return typeof value === 'object' ? '[nested]' : value;
  if (Array.isArray(value)) return value.slice(0, 20).map((v) => redact(v, depth + 1));
  const out = {};
  for (const [k, v] of Object.entries(value)) out[k] = SECRET_KEY.test(k) ? '[redacted]' : redact(v, depth + 1);
  return out;
}

function createAudit({ file = '', now = Date.now, keep = 500 } = {}) {
  const recent = [];                                                       // the tail is kept in memory so reading it is cheap
  if (file) {
    fs.mkdirSync(path.dirname(file), { recursive: true });
    try {
      const lines = fs.readFileSync(file, 'utf8').split('\n').filter(Boolean).slice(-keep);
      for (const l of lines) { try { recent.push(JSON.parse(l)); } catch (err) { /* a torn last line: skip it */ } }
    } catch (err) { /* no file yet */ }
  }
  function record(entry) {
    const row = { at: new Date(now()).toISOString(), ...redact(entry) };
    recent.push(row); if (recent.length > keep) recent.shift();
    if (file) { try { fs.appendFileSync(file, `${JSON.stringify(row)}\n`, { mode: 0o600 }); } catch (err) { /* a full disk must not stop playout */ } }
    return row;
  }
  const tail = (limit = 100) => recent.slice(-Math.min(Math.max(1, limit), keep)).reverse();
  return { record, tail };
}

// A sliding window per id: allow(id) is false once `max` calls happened in `windowMs`.
function createRateLimit({ max, windowMs = 60000, now = Date.now }) {
  const hits = new Map();
  return {
    allow(id) {
      const t = now();
      const h = (hits.get(id) || []).filter((x) => t - x < windowMs);
      if (h.length >= max) { hits.set(id, h); return { ok: false, retryAfterSeconds: Math.max(1, Math.ceil((windowMs - (t - h[0])) / 1000)) }; }
      h.push(t); hits.set(id, h);
      return { ok: true };
    },
  };
}

module.exports = { createAudit, createRateLimit, redact };
