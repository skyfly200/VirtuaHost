// One admin key, exchanged for short-lived tokens so a browser UI never has to keep the key itself.
//   Authorization: Bearer <key or token>   or   x-api-key: <key or token>
//   POST /auth/login { "key": "..." } -> { token, expiresAt }
const crypto = require('crypto');

function createAuth({ key, ttlMs = 12 * 3600e3, now = Date.now }) {
  if (!key || key.length < 12) throw new Error('HUB_KEY is required and must be at least 12 characters (openssl rand -hex 24)');
  const secret = crypto.createHash('sha256').update(`hub-token:${key}`).digest();
  const b64 = (b) => Buffer.from(b).toString('base64url');
  const sign = (data) => crypto.createHmac('sha256', secret).update(data).digest();
  const eq = (a, b) => { const x = Buffer.from(String(a)); const y = Buffer.from(String(b)); return x.length === y.length && crypto.timingSafeEqual(x, y); };

  function issue() {
    const exp = now() + ttlMs;
    const payload = b64(JSON.stringify({ exp }));
    return { token: `h1.${payload}.${b64(sign(`h1.${payload}`))}`, expiresAt: exp };
  }
  function verifyToken(token) {
    const parts = String(token || '').split('.');
    if (parts.length !== 3 || parts[0] !== 'h1') return false;
    if (!eq(b64(sign(`h1.${parts[1]}`)), parts[2])) return false;
    try { return JSON.parse(Buffer.from(parts[1], 'base64url').toString()).exp > now(); } catch (err) { return false; }
  }
  return {
    issue,
    checkKey: (given) => eq(given, key),
    allowed(req) {
      const given = req.headers['x-api-key'] || String(req.headers.authorization || '').replace(/^Bearer\s+/i, '');
      return !!given && (eq(given, key) || verifyToken(given));
    },
  };
}

// Counts failures per client so the key cannot be guessed quickly.
function createLimiter({ max = 10, windowMs = 60000, now = Date.now } = {}) {
  const hits = new Map();
  return {
    blocked(id) { const h = (hits.get(id) || []).filter((t) => now() - t < windowMs); hits.set(id, h); return h.length >= max; },
    fail(id) { const h = hits.get(id) || []; h.push(now()); hits.set(id, h); },
  };
}

module.exports = { createAuth, createLimiter };
