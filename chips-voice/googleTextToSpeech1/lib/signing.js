// Signed, expiring links for audio files: /a/<id>/<name>?exp=<unix seconds>&sig=<hmac>
const crypto = require('crypto');

function sign(secret, id, exp) {
  return crypto.createHmac('sha256', secret).update(`${id}.${exp}`).digest('base64url');
}

function verify(secret, id, exp, sig, nowMs = Date.now()) {
  const expiry = Number(exp);
  if (!secret || !Number.isFinite(expiry) || expiry * 1000 < nowMs || !sig) return false;
  const given = Buffer.from(String(sig));
  const wanted = Buffer.from(sign(secret, id, expiry));
  return given.length === wanted.length && crypto.timingSafeEqual(given, wanted);
}

function slug(name) {
  return String(name || 'clip').toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 60) || 'clip';
}

function signedUrl({ base, secret, id, ext, title, ttlSeconds, nowMs = Date.now() }) {
  const exp = Math.floor(nowMs / 1000) + ttlSeconds;
  const name = `${slug(title)}.${ext}`;
  return {
    url: `${base.replace(/\/+$/, '')}/a/${id}/${name}?exp=${exp}&sig=${sign(secret, id, exp)}`,
    expires: new Date(exp * 1000).toISOString(),
  };
}

module.exports = { sign, verify, signedUrl, slug };
