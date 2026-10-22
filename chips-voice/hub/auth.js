// Keys and short-lived tokens, so a browser UI never has to keep a key itself.
//   Authorization: Bearer <key or token>   or   x-api-key: <key or token>
//   POST /auth/login { "key": "..." } -> { token, expiresAt, scope }
//
// Three kinds of caller:
//   control   HUB_KEY: everything.
//   read      HUB_READ_KEY (optional): GET routes only. It can see stations, slots, items and the audit log; it can change nothing.
//   station   a per-station key (created with POST /stations/:id/pullkey): only that station's heartbeat, queue, ack and slot-sync routes.
//             Station keys are checked by the hub (hub.js), not here.
const crypto = require('crypto');

function createAuth({ key, readKey = '', ttlMs = 12 * 3600e3, now = Date.now }) {
  if (!key || key.length < 12) throw new Error('HUB_KEY is required and must be at least 12 characters (openssl rand -hex 24)');
  if (readKey && readKey.length < 12) throw new Error('HUB_READ_KEY must be at least 12 characters (openssl rand -hex 24)');
  if (readKey && readKey === key) throw new Error('HUB_READ_KEY must be different from HUB_KEY');
  const secret = crypto.createHash('sha256').update(`hub-token:${key}`).digest();
  const b64 = (b) => Buffer.from(b).toString('base64url');
  const sign = (data) => crypto.createHmac('sha256', secret).update(data).digest();
  const eq = (a, b) => { const x = Buffer.from(String(a)); const y = Buffer.from(String(b)); return x.length === y.length && crypto.timingSafeEqual(x, y); };

  // h2 tokens carry their scope; h1 tokens (issued before scopes existed) were only ever issued for the control key.
  function issue(scope = 'control') {
    const exp = now() + ttlMs;
    const payload = b64(JSON.stringify({ exp, scope }));
    return { token: `h2.${payload}.${b64(sign(`h2.${payload}`))}`, expiresAt: exp, scope };
  }
  function tokenScope(token) {
    const parts = String(token || '').split('.');
    if (parts.length !== 3 || (parts[0] !== 'h1' && parts[0] !== 'h2')) return null;
    if (!eq(b64(sign(`${parts[0]}.${parts[1]}`)), parts[2])) return null;
    try {
      const body = JSON.parse(Buffer.from(parts[1], 'base64url').toString());
      if (!(body.exp > now())) return null;
      return parts[0] === 'h1' ? 'control' : body.scope === 'read' ? 'read' : body.scope === 'control' ? 'control' : null;
    } catch (err) { return null; }
  }
  const given = (req) => req.headers['x-api-key'] || String(req.headers.authorization || '').replace(/^Bearer\s+/i, '');
  // The scope a key or token gives: 'control', 'read' or null.
  function scopeOf(value) {
    if (!value) return null;
    if (eq(value, key)) return 'control';
    if (readKey && eq(value, readKey)) return 'read';
    return tokenScope(value);
  }
  return {
    issue,
    scopeOf,
    given,
    // The scope of a login key (never a token): used by POST /auth/login.
    checkKey: (value) => (eq(value, key) ? 'control' : readKey && eq(value, readKey) ? 'read' : null),
    identify: (req) => scopeOf(given(req)),
    allowed(req) { return !!scopeOf(given(req)); },
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
