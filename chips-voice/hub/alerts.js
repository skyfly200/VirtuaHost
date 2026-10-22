// US weather and emergency alerts for the hub, from the National Weather Service (api.weather.gov: free, no key, but it asks for a
// User-Agent that says who you are: set ALERTS_CONTACT). The hub polls each "watch" (a point, a state or a zone), decides which alerts
// matter, and either just records them (action "notify", the default) or has the voice server say them and broadcasts the clip to the
// chosen stations (action "broadcast"). Nothing airs unless a watch is set to "broadcast".
//
// This relays what the NWS publishes. It reads the NWS web service, not the EAS chain: it does not decode EAS/SAME or play the attention tones.
// See docs/ALERTS.md.
// Alerts are never "Test" or "Exercise" ones, and each alert id airs at most once.
//
// NOT VERIFIED against the live service (it could not be reached while this was written): the request and response shapes follow the
// api.weather.gov GeoJSON documentation (features[].properties: id, event, severity, headline, instruction, areaDesc, expires, status,
// messageType).
const crypto = require('crypto');

const SEVERITY = ['Unknown', 'Minor', 'Moderate', 'Severe', 'Extreme'];
const rank = (s) => Math.max(0, SEVERITY.indexOf(s));
const API = 'https://api.weather.gov';

class AlertError extends Error { constructor(message, status = 400) { super(message); this.status = status; } }

const clean = (v, max) => String(v === undefined || v === null ? '' : v).replace(/[\u0000-\u001f\u007f]/g, ' ').replace(/\s+/g, ' ').trim().slice(0, max);

// ---------- NWS ----------
function normalize(feature) {
  const p = (feature && feature.properties) || {};
  const expires = Date.parse(p.ends || p.expires || '');
  return {
    id: clean(p.id || feature.id, 200),
    event: clean(p.event, 80),
    severity: SEVERITY.includes(p.severity) ? p.severity : 'Unknown',
    urgency: clean(p.urgency, 30),
    certainty: clean(p.certainty, 30),
    status: clean(p.status, 30),
    messageType: clean(p.messageType, 30),
    headline: clean(p.headline, 300),
    description: clean(p.description, 2000),
    instruction: clean(p.instruction, 1000),
    area: clean(p.areaDesc, 300),
    sender: clean(p.senderName, 100),
    sent: Date.parse(p.sent || '') || null,
    expires: Number.isFinite(expires) ? expires : null,
  };
}

// A point watch with a radius also listens around the edge of that circle (eight points), so an alert for the edge of where the station
// is heard counts, not only one over the antenna. (The radius is the station's "good" coverage reach from the site: docs/COVERAGE.md.)
function ringPoints(point, km) {
  const R = 6371; const rad = (d) => (d * Math.PI) / 180; const deg = (r) => (r * 180) / Math.PI;
  const out = [point];
  for (let b = 0; b < 360; b += 45) {
    const d = km / R; const t = rad(b); const p1 = rad(point.lat); const l1 = rad(point.lon);
    const p2 = Math.asin(Math.sin(p1) * Math.cos(d) + Math.cos(p1) * Math.sin(d) * Math.cos(t));
    const l2 = l1 + Math.atan2(Math.sin(t) * Math.sin(d) * Math.cos(p1), Math.cos(d) - Math.sin(p1) * Math.sin(p2));
    out.push({ lat: Math.round(deg(p2) * 1e4) / 1e4, lon: Math.round((((deg(l2) + 540) % 360) - 180) * 1e4) / 1e4 });
  }
  return out;
}

async function fetchActive(watch, opts = {}) {
  if (watch.point && watch.radiusKm > 0.5) {
    const lists = await Promise.all(ringPoints(watch.point, watch.radiusKm).map((p) => fetchOne({ point: p }, opts)));
    const seen = new Map();
    for (const a of lists.flat()) if (!seen.has(a.id)) seen.set(a.id, a);
    return [...seen.values()];
  }
  return fetchOne(watch, opts);
}

async function fetchOne(watch, { fetchImpl = globalThis.fetch, contact = '', timeoutMs = 10000 } = {}) {
  const q = watch.point ? `point=${encodeURIComponent(`${watch.point.lat},${watch.point.lon}`)}` : watch.zone ? `zone=${encodeURIComponent(watch.zone)}` : `area=${encodeURIComponent(watch.area)}`;
  let res;
  try {
    res = await fetchImpl(`${API}/alerts/active?${q}`, {
      headers: { accept: 'application/geo+json', 'user-agent': `(VirtuaHost hub, ${contact || 'set ALERTS_CONTACT'})` },
      signal: AbortSignal.timeout(timeoutMs),
    });
  } catch (err) { throw new AlertError(`the National Weather Service is not reachable: ${err.message}`, 502); }
  if (!res.ok) throw new AlertError(`the National Weather Service answered ${res.status}`, 502);
  const body = await res.json().catch(() => null);
  if (!body || !Array.isArray(body.features)) throw new AlertError('the National Weather Service sent something unexpected', 502);
  return body.features.map(normalize).filter((a) => a.id);
}

// Which alerts count: real (not test), not cancellations, still in force, at least the minimum severity, and on the event list if there is one.
function matters(alert, watch, now) {
  if (alert.status && alert.status !== 'Actual') return false;
  if (alert.messageType === 'Cancel') return false;
  if (alert.expires !== null && alert.expires <= now) return false;
  if (rank(alert.severity) < rank(watch.minSeverity)) return false;
  if (watch.events.length && !watch.events.some((e) => e.toLowerCase() === alert.event.toLowerCase())) return false;
  return true;
}

// What gets said: deterministic, short, and clearly an automated relay. Nothing is added that the NWS did not say.
function speakable(alert, watch) {
  const first = (s) => { const m = /^(.+?[.!?])(\s|$)/.exec(s); return m ? m[1] : s; };
  const parts = [];
  if (watch.prefix) parts.push(watch.prefix);
  parts.push(`${alert.headline || `${alert.event} for ${alert.area}`}.`);
  if (alert.instruction) parts.push(first(alert.instruction).slice(0, 220));
  if (watch.suffix) parts.push(watch.suffix);
  return parts.join(' ').replace(/\s+/g, ' ').trim().slice(0, 700);
}

// ---------- watches ----------
const STATE = /^[A-Za-z]{2}$/;
const ZONE = /^[A-Za-z]{2}[CZ][0-9]{3}$/;
function sanitizeWatch(raw, existing) {
  const r = raw || {};
  const w = existing ? { ...existing } : { id: crypto.randomBytes(4).toString('hex'), enabled: true, minSeverity: 'Severe', events: [], action: 'notify', stations: 'all', preempt: false, prefix: '', suffix: '', createdAt: Date.now() };
  if (r.name !== undefined) w.name = clean(r.name, 60);
  if (!w.name) w.name = 'Alerts';
  if (r.lat !== undefined || r.lon !== undefined || r.zone !== undefined || r.area !== undefined) {
    delete w.point; delete w.zone; delete w.area;
    if (r.lat !== undefined || r.lon !== undefined) {
      const lat = Number(r.lat); const lon = Number(r.lon);
      if (!(lat >= -90 && lat <= 90 && lon >= -180 && lon <= 180)) throw new AlertError('give a latitude (-90 to 90) and longitude (-180 to 180)');
      w.point = { lat: Math.round(lat * 1e4) / 1e4, lon: Math.round(lon * 1e4) / 1e4 };
    } else if (r.zone !== undefined) {
      if (!ZONE.test(String(r.zone))) throw new AlertError('a zone looks like TXZ213 or TXC201');
      w.zone = String(r.zone).toUpperCase();
    } else {
      if (!STATE.test(String(r.area))) throw new AlertError('an area is a two-letter state or territory code, for example TX');
      w.area = String(r.area).toUpperCase();
    }
  }
  if (!w.point && !w.zone && !w.area) throw new AlertError('say where to watch: lat and lon, a zone, or a state');
  if (r.radiusKm !== undefined) { const km = Number(r.radiusKm); if (!(km >= 0 && km <= 300)) throw new AlertError('radiusKm is 0 to 300 (how far around the point to listen)'); w.radiusKm = km; }
  if (r.minSeverity !== undefined) { if (!SEVERITY.includes(r.minSeverity)) throw new AlertError(`minSeverity is one of ${SEVERITY.join(', ')}`); w.minSeverity = r.minSeverity; }
  if (r.events !== undefined) w.events = (Array.isArray(r.events) ? r.events : String(r.events).split(',')).map((e) => clean(e, 80)).filter(Boolean).slice(0, 40);
  if (r.action !== undefined) { if (r.action !== 'notify' && r.action !== 'broadcast') throw new AlertError('action is "notify" or "broadcast"'); w.action = r.action; }
  if (r.stations !== undefined) w.stations = r.stations === 'all' ? 'all' : (Array.isArray(r.stations) ? r.stations.map((s) => clean(s, 60)).filter(Boolean).slice(0, 50) : 'all');
  if (r.preempt !== undefined) w.preempt = r.preempt === true;
  if (r.enabled !== undefined) w.enabled = r.enabled !== false;
  if (r.prefix !== undefined) w.prefix = clean(r.prefix, 200);
  if (r.suffix !== undefined) w.suffix = clean(r.suffix, 200);
  return w;
}

// deps: { store, fetchImpl, now, contact, broadcast(body), speak(text) -> clipId | null, log }
function createAlerts({ store, fetchImpl = globalThis.fetch, now = Date.now, contact = '', broadcast = null, speak = null, maxLog = 100 }) {
  const state = () => { store.data.alerts ||= { watches: [], seen: {}, log: [] }; return store.data.alerts; };
  const record = (entry) => { const s = state(); s.log.unshift({ at: now(), ...entry }); s.log.length = Math.min(s.log.length, maxLog); };

  async function checkWatch(watch, { dry = false } = {}) {
    const found = await fetchActive(watch, { fetchImpl, contact });
    const t = now();
    const relevant = found.filter((a) => matters(a, watch, t));
    const s = state();
    const results = [];
    for (const alert of relevant) {
      const key = `${watch.id}:${alert.id}`;
      if (s.seen[key]) continue;                                   // each alert is handled once per watch
      const text = speakable(alert, watch);
      const entry = { watch: watch.id, alert: alert.id, event: alert.event, severity: alert.severity, area: alert.area, headline: alert.headline, text, action: watch.action };
      if (dry) { results.push({ ...entry, status: 'would-handle' }); continue; }
      s.seen[key] = { at: t, expires: alert.expires };
      if (watch.action === 'broadcast') {
        try {
          if (!speak || !broadcast) throw new AlertError('broadcasting needs VOICE_URL and VOICE_KEY on the hub', 503);
          const clipId = await speak(text);
          if (!clipId) throw new AlertError('the voice server did not make a clip', 502);
          const out = await broadcast({ clipId, stations: watch.stations, title: `Alert: ${alert.event}`.slice(0, 100), preempt: watch.preempt });
          results.push({ ...entry, status: 'broadcast', played: out && out.played !== false });
          record({ ...entry, status: 'broadcast' });
        } catch (err) {
          delete s.seen[key];                                      // try again on the next poll
          results.push({ ...entry, status: 'failed', error: err.message });
          record({ ...entry, status: 'failed', error: err.message });
        }
      } else {
        results.push({ ...entry, status: 'noted' });
        record({ ...entry, status: 'noted' });
      }
    }
    // Forget alerts that have long since ended.
    for (const [k, v] of Object.entries(s.seen)) if (v.expires && v.expires < t - 24 * 3600e3) delete s.seen[k];
    store.save();
    return { watch: watch.id, found: found.length, relevant: relevant.length, results };
  }

  async function checkAll(opts) {
    const out = [];
    for (const w of state().watches.filter((x) => x.enabled)) {
      try { out.push(await checkWatch(w, opts)); } catch (err) { out.push({ watch: w.id, error: err.message }); record({ watch: w.id, status: 'error', error: err.message }); store.save(); }
    }
    return out;
  }

  return {
    list: () => ({ watches: state().watches, log: state().log.slice(0, 50) }),
    add(raw) { const w = sanitizeWatch(raw); state().watches.push(w); store.save(); return w; },
    update(id, raw) {
      const s = state(); const i = s.watches.findIndex((w) => w.id === id);
      if (i < 0) throw new AlertError('no such watch', 404);
      s.watches[i] = sanitizeWatch(raw, s.watches[i]); store.save(); return s.watches[i];
    },
    remove(id) { const s = state(); const n = s.watches.length; s.watches = s.watches.filter((w) => w.id !== id); if (s.watches.length === n) throw new AlertError('no such watch', 404); store.save(); },
    get: (id) => { const w = state().watches.find((x) => x.id === id); if (!w) throw new AlertError('no such watch', 404); return w; },
    checkWatch, checkAll,
    /** A look at what is active right now, with no state kept and nothing sent anywhere. */
    peek: async (raw) => (await fetchActive(sanitizeWatch({ name: 'peek', ...raw }), { fetchImpl, contact })),
  };
}

module.exports = { createAlerts, AlertError, normalize, matters, speakable, sanitizeWatch, fetchActive, ringPoints, SEVERITY };
