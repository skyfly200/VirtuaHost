// Twilio request signatures (X-Twilio-Signature): base64 HMAC-SHA1 of the full URL followed by each POST
// parameter name and value, sorted by name, using the account auth token.
const crypto = require('crypto');

function signature(url, params, authToken) {
  const data = Object.keys(params || {}).sort().reduce((acc, k) => acc + k + params[k], url);
  return crypto.createHmac('sha1', authToken).update(Buffer.from(data, 'utf8')).digest('base64');
}

function valid(url, params, authToken, given) {
  if (!authToken || !given) return false;
  const a = Buffer.from(signature(url, params, authToken));
  const b = Buffer.from(String(given));
  return a.length === b.length && crypto.timingSafeEqual(a, b);
}

const escapeXml = (s) => String(s).replace(/[<>&'"]/g, (c) => ({ '<': '&lt;', '>': '&gt;', '&': '&amp;', "'": '&apos;', '"': '&quot;' }[c]));
const twiml = (message) => `<?xml version="1.0" encoding="UTF-8"?><Response>${message ? `<Message>${escapeXml(message)}</Message>` : ''}</Response>`;

module.exports = { signature, valid, twiml, escapeXml };
