// Decides from a script's TEXT ALONE, before any speech is paid for, how long a clip made from it stays good:
//   static       no live values: generate once, keep, reuse as often as the rotation wants
//   daypart      good for the same part of the day (morning / afternoon / evening / night)
//   refreshable  uses values that change rarely (a show's name or start time): regenerate only when those values change
//   live         uses values that change all the time: generate shortly before it airs, with a fallback
// Rules are plain regular expressions so a person can read and extend them. The tier can only go UP: any signal takes a script out of
// "static". A false "live" costs a little reuse; a false "static" would put a stale line on air all week, so tests aim at that case.
// Port of tools/ script_freshness.py from the Green Light Radio scripts (station-side prototype); keep the two in step.
const TIERS = ['static', 'daypart', 'refreshable', 'live'];
const CLASSIFIER_VERSION = 1;

// Placeholder classes. An unknown placeholder is assumed live.
const STATIC_PLACEHOLDERS = new Set(['station', 'tagline', 'callsign']);   // fixed for a station; a rename changes the text hash, so it regenerates by itself
const STABLE_PLACEHOLDERS = new Set(['showname', 'hostname', 'nextshow', 'nexthost']);
const VOLATILE_PLACEHOLDERS = new Set(['time', 'date', 'weather', 'temperature', 'nowplaying', 'nextsong', 'lastsong', 'event', 'listeners']);

const RULES = [
  ['live', 'now/latest wording', /\b(right now|currently|at the moment|just (now|happened|played|heard)|latest|breaking|moments ago)\b/i],
  ['live', 'song/track reference', /\b(next (one|song|track|tune|up)|that was|you just heard|this (one|song|track|tune)|up next|coming up|here comes|the (song|track|tune)\b)/i],
  ['live', 'weather/temperature', /\b(weather|forecast|rain|snow|sunny|cloudy|windy|degrees|hot out|cold out|storm)\b/i],
  ['refreshable', 'clock time', /\b(\d{1,2}(:\d{2})?\s?(am|pm|a\.m\.|p\.m\.)|\d{1,2} o'?clock|(one|two|three|four|five|six|seven|eight|nine|ten|eleven|twelve) o'?clock|at (one|two|three|four|five|six|seven|eight|nine|ten|eleven|twelve)\b|noon|midnight)/i],
  ['refreshable', 'day/date word', /\b(tonight|today|tomorrow|yesterday|this (week|weekend|morning|afternoon|evening)|monday|tuesday|wednesday|thursday|friday|saturday|sunday|january|february|march|april|may \d|june|july|august|september|october|november|december|20\d\d)\b/i],
  ['refreshable', 'schedule claim', /\b(starts? (at|in)|coming up (at|in)|in (about )?\w+ minutes|later (today|tonight))\b/i],
  ['refreshable', 'contact/price/number claim', /(\b\d{3}[- ]\d{3}[- ]\d{4}\b|\$\d+|\b\d+ percent\b|\b\d+% off|@\w+\.\w+| dot com)/i],
  ['daypart', 'daypart wording', /\b(good (morning|afternoon|evening|night)|morning|afternoon slump|late night|early bird)\b/i],
];

const higher = (a, b) => (TIERS.indexOf(b) > TIERS.indexOf(a) ? b : a);

/** classify(text) -> { freshness, reasons: string[], needs: string[], classifierVersion } */
function classify(text) {
  const src = String(text == null ? '' : text);
  let freshness = 'static';
  const reasons = [];
  const needs = [];
  for (const m of src.matchAll(/\{\{\s*(\w+)\s*(?:\|[^}]*)?\}\}/g)) {
    const name = m[1];
    const key = name.toLowerCase();
    const tier = STATIC_PLACEHOLDERS.has(key) ? 'static' : VOLATILE_PLACEHOLDERS.has(key) ? 'live' : STABLE_PLACEHOLDERS.has(key) ? 'refreshable' : 'live';
    reasons.push(`placeholder ${name} (${tier})`);
    if (tier !== 'static' && !needs.includes(name)) needs.push(name);
    freshness = higher(freshness, tier);
  }
  for (const [tier, why, rx] of RULES) {
    const m = rx.exec(src);
    if (m) { reasons.push(`${why}: '${m[0]}'`); freshness = higher(freshness, tier); }
  }
  return { freshness, reasons, needs, classifierVersion: CLASSIFIER_VERSION };
}

// Optional second opinion for scripts the rules call static. `ask(text)` is injected (a Jev "Choice" question, or any small classifier) and must
// resolve to { timeDependent: number 0..1, confidence?: number 0..1 }. It can only take a script OUT of static, never put one in: a
// time-dependent verdict (a `tier` named by the verdict, else a score at or above `threshold` meaning `refreshable`) moves it out of static (held until a person looks); a failed or low-confidence answer
// marks it `needsReview` and leaves the rules' tier alone. Rules always win in the other direction.
async function classifyWithSecondOpinion(text, ask, { threshold = 0.5, minConfidence = 0.5 } = {}) {
  const result = classify(text);
  if (result.freshness !== 'static' || typeof ask !== 'function') return result;
  let verdict;
  try { verdict = await ask(String(text == null ? '' : text)); } catch (err) { return { ...result, needsReview: true, reasons: [...result.reasons, `second opinion unavailable: ${err && err.message ? err.message : 'error'}`] }; }
  const p = verdict && Number(verdict.timeDependent);
  if (!Number.isFinite(p)) return { ...result, needsReview: true, reasons: [...result.reasons, 'second opinion unreadable'] };
  const conf = verdict.confidence === undefined ? 1 : Number(verdict.confidence);
  // A verdict may name the tier its answers argue for (the Jev adapter does, from several questions). Without one, a single score decides.
  const argued = TIERS.includes(verdict.tier) ? verdict.tier : p >= threshold ? 'refreshable' : 'static';
  const why = Array.isArray(verdict.signals) && verdict.signals.length ? verdict.signals.map((x) => `${x.question} ${Number(x.p).toFixed(2)}`).join(', ') : `p=${p.toFixed(2)}`;
  if (TIERS.indexOf(argued) > TIERS.indexOf('static')) return { ...result, freshness: argued, needsReview: true, reasons: [...result.reasons, `second opinion: ${argued} (${why})`] };
  if (Number.isFinite(conf) && conf < minConfidence) return { ...result, needsReview: true, reasons: [...result.reasons, `second opinion unsure (confidence ${conf.toFixed(2)})`] };
  return result;
}

module.exports = { classify, classifyWithSecondOpinion, TIERS, CLASSIFIER_VERSION, STATIC_PLACEHOLDERS, STABLE_PLACEHOLDERS, VOLATILE_PLACEHOLDERS };
