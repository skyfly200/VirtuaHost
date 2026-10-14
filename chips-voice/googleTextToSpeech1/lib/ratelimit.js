// Fixed-window rate limiter per client address, for endpoints that cost money (TTS, LLM).
function createLimiter({ windowMs = 60000, max = 30, now = Date.now } = {}) {
  const hits = new Map();
  return function limit(req, res, next) {
    const key = req.ip;
    const t = now();
    let entry = hits.get(key);
    if (!entry || t - entry.start >= windowMs) {
      entry = { start: t, count: 0 };
      hits.set(key, entry);
    }
    entry.count += 1;
    if (hits.size > 5000) {
      for (const [k, v] of hits) if (t - v.start >= windowMs) hits.delete(k);
    }
    if (entry.count > max) {
      res.set('Retry-After', String(Math.ceil((windowMs - (t - entry.start)) / 1000)));
      return res.status(429).json({ error: 'too many requests; slow down' });
    }
    next();
  };
}

module.exports = { createLimiter };
