// Adapter that lets freshness.js ask TypeSafe's Jev about a script. Jev answers small, specific questions best, so instead of one big
// "is this time-sensitive?" this asks several atomic ones in a single request and combines the answers here in code (TypeSafe's own
// advice: decompose, then compose with logic you control). It is a SECOND layer for scripts the regular expressions called static, aimed at
// the cases a pattern cannot see: a line that quietly assumes "right now", leans on what plays around it, or states a fact that can go stale.
//
// Request shape follows TypeSafe's documented native API (POST https://api.typesafe.ai/v1/systemone, docs.typesafe.ai/introduction/quickstart):
//   { state, model, questions: { <name>: { type: "choice"|"noul", instructions, criteria? } } }  ->  answers.<name>
//   choice -> { choice, confidence, probabilities: { <option>: p } }      noul -> { noul: 0..1 }
// NOT RUN against the live service (no key when this was written). Calling Jev through OpenRouter (`typesafe/jev-router`) is NOT covered:
// OpenRouter documents only a chat shape for it, so check what that route accepts before pointing `baseUrl` at it.

// "noul" questions: is this statement true of the script? Each asks one thing.
const TRUTH_QUESTIONS = {
  assumes_now: 'The line assumes something about the present moment: the time of day, what the listener is doing right now, or what is happening in the world today.',
  surrounding_content: 'The line only makes sense next to specific content around it: the song just played or about to play, the previous or next segment, or something said earlier or later.',
  changing_fact: 'The line states a fact that could become false or out of date: a price, a count, a name or role, something described as new, latest, recent or upcoming.',
  seasonal_or_dated: 'The line is tied to a season, holiday, weather, a year, or a specific date or event.',
  promises_later: 'The line promises or announces something that will happen later, or refers to a schedule.',
};

// "choice" questions: pick one option.
const CHOICE_QUESTIONS = {
  horizon: {
    instructions: 'For how long would this radio line stay accurate and natural to play?',
    criteria: {
      years: 'Years: it would still be fine to play it years from now',
      months: 'Months: fine for months, but eventually it dates',
      weeks: 'Weeks: it goes stale within a few weeks',
      days: 'Days: it goes stale within a day or two',
      hours: 'Hours: it is only right at a particular moment or time of day',
    },
  },
  daypart: {
    instructions: 'Which part of the day does this line fit?',
    criteria: {
      any: 'Any time of day',
      morning: 'Morning',
      afternoon: 'Afternoon',
      evening: 'Evening',
      night: 'Late night or overnight',
    },
  },
};

const buildQuestions = () => ({
  ...Object.fromEntries(Object.entries(TRUTH_QUESTIONS).map(([k, instructions]) => [k, { type: 'noul', instructions }])),
  ...Object.fromEntries(Object.entries(CHOICE_QUESTIONS).map(([k, q]) => [k, { type: 'choice', instructions: q.instructions, criteria: q.criteria }])),
});

const p = (v) => (Number.isFinite(Number(v)) ? Number(v) : NaN);

/**
 * Combine the answers into one verdict. Returns { tier, timeDependent, confidence, signals } or null when an answer is missing or unreadable.
 *   tier   'live' | 'refreshable' | 'daypart' | 'static'   (the tier Jev's answers argue for; 'static' means it found nothing)
 */
function combine(answers, { threshold = 0.6 } = {}) {
  const a = answers || {};
  const noul = {};
  for (const k of Object.keys(TRUTH_QUESTIONS)) {
    const v = p(a[k] && a[k].noul);
    if (!Number.isFinite(v)) return null;
    noul[k] = v;
  }
  const probs = (name) => {
    const x = a[name] && a[name].probabilities;
    return x && typeof x === 'object' ? x : null;
  };
  const horizon = probs('horizon');
  const daypart = probs('daypart');
  if (!horizon || !daypart) return null;
  const hp = (k) => p(horizon[k]) || 0;
  const dp = (k) => p(daypart[k]) || 0;

  const signals = [];
  for (const [k, v] of Object.entries(noul)) if (v >= threshold) signals.push({ question: k, p: v });
  const hours = hp('hours');
  const shortLived = hp('days') + hp('weeks');
  if (hours >= 0.5) signals.push({ question: 'horizon:hours', p: hours });
  else if (shortLived >= 0.5) signals.push({ question: 'horizon:days-or-weeks', p: shortLived });
  const notAny = 1 - dp('any');
  if (notAny >= threshold) signals.push({ question: 'daypart', p: notAny });

  let tier = 'static';
  if (noul.surrounding_content >= threshold || hours >= 0.5 || noul.assumes_now >= threshold) tier = 'live';
  else if (noul.changing_fact >= threshold || noul.seasonal_or_dated >= threshold || noul.promises_later >= threshold || shortLived >= 0.5) tier = 'refreshable';
  else if (notAny >= threshold) tier = 'daypart';

  const confidences = ['horizon', 'daypart'].map((k) => p(a[k].confidence)).filter(Number.isFinite);
  return {
    tier,
    timeDependent: signals.length ? Math.max(...signals.map((s) => s.p)) : Math.max(...Object.values(noul)),
    confidence: confidences.length ? Math.min(...confidences) : undefined,
    signals,
  };
}

function createJevAsk({ apiKey, fetchImpl = globalThis.fetch, baseUrl = 'https://api.typesafe.ai', model = 'jev-latest', timeoutMs = 8000, threshold = 0.6 } = {}) {
  if (!apiKey) throw new Error('A TypeSafe API key is needed to ask Jev');
  return async function ask(text) {
    const res = await fetchImpl(`${baseUrl.replace(/\/+$/, '')}/v1/systemone`, {
      method: 'POST',
      headers: { authorization: `Bearer ${apiKey}`, 'content-type': 'application/json' },
      body: JSON.stringify({ state: String(text), model, questions: buildQuestions() }),
      signal: AbortSignal.timeout(timeoutMs),
    });
    if (!res.ok) throw new Error(`Jev returned ${res.status}`);
    const body = await res.json();
    const verdict = combine(body && body.answers, { threshold });
    if (!verdict) throw new Error('Jev answer not understood');
    return verdict;
  };
}

module.exports = { createJevAsk, combine, buildQuestions, TRUTH_QUESTIONS, CHOICE_QUESTIONS };
