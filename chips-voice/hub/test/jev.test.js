const test = require('node:test');
const assert = require('node:assert');
const { createJevAsk, combine, buildQuestions, TRUTH_QUESTIONS } = require('../jev');
const { classifyWithSecondOpinion } = require('../freshness');

// Canned answers in the shape TypeSafe documents. `over` changes single questions.
const answers = (over = {}) => {
  const a = {};
  for (const k of Object.keys(TRUTH_QUESTIONS)) a[k] = { type: 'noul', noul: 0.02 };
  a.horizon = { type: 'choice', choice: 'years', confidence: 0.9, probabilities: { years: 0.9, months: 0.07, weeks: 0.02, days: 0.01, hours: 0 } };
  a.daypart = { type: 'choice', choice: 'any', confidence: 0.9, probabilities: { any: 0.95, morning: 0.02, afternoon: 0.01, evening: 0.01, night: 0.01 } };
  return { ...a, ...over };
};
const noul = (v) => ({ type: 'noul', noul: v });
const horizon = (probabilities, confidence = 0.9) => ({ type: 'choice', choice: 'x', confidence, probabilities });
const daypart = (probabilities, confidence = 0.9) => ({ type: 'choice', choice: 'x', confidence, probabilities });
const serve = (a) => async () => new Response(JSON.stringify({ model: 'jev-1.13.0', answers: a }), { status: 200 });

test('asks several atomic questions in one request', async () => {
  let seen;
  const ask = createJevAsk({ apiKey: 'k-test', fetchImpl: async (url, init) => { seen = { url, init, body: JSON.parse(init.body) }; return serve(answers())(); } });
  await ask('Tonight at seven, Wild Bill.');
  assert.strictEqual(seen.url, 'https://api.typesafe.ai/v1/systemone');
  assert.strictEqual(seen.init.headers.authorization, 'Bearer k-test');
  assert.strictEqual(seen.body.state, 'Tonight at seven, Wild Bill.');
  const q = seen.body.questions;
  assert.deepStrictEqual(Object.keys(q).sort(), [...Object.keys(TRUTH_QUESTIONS), 'horizon', 'daypart'].sort());
  for (const k of Object.keys(TRUTH_QUESTIONS)) assert.strictEqual(q[k].type, 'noul');
  assert.strictEqual(q.horizon.type, 'choice');
  assert.deepStrictEqual(Object.keys(q.horizon.criteria), ['years', 'months', 'weeks', 'days', 'hours']);
  assert.deepStrictEqual(Object.keys(buildQuestions()), Object.keys(q));
});

test('nothing fires: stays static', () => {
  const v = combine(answers());
  assert.strictEqual(v.tier, 'static');
  assert.deepStrictEqual(v.signals, []);
});

test('each kind of doubt argues for the right tier', () => {
  assert.strictEqual(combine(answers({ surrounding_content: noul(0.9) })).tier, 'live');
  assert.strictEqual(combine(answers({ assumes_now: noul(0.8) })).tier, 'live');
  assert.strictEqual(combine(answers({ horizon: horizon({ years: 0, months: 0.1, weeks: 0, days: 0.1, hours: 0.8 }) })).tier, 'live');
  assert.strictEqual(combine(answers({ changing_fact: noul(0.7) })).tier, 'refreshable');
  assert.strictEqual(combine(answers({ seasonal_or_dated: noul(0.65) })).tier, 'refreshable');
  assert.strictEqual(combine(answers({ promises_later: noul(0.9) })).tier, 'refreshable');
  assert.strictEqual(combine(answers({ horizon: horizon({ years: 0.1, months: 0.2, weeks: 0.4, days: 0.3, hours: 0 }) })).tier, 'refreshable');
  assert.strictEqual(combine(answers({ daypart: daypart({ any: 0.1, morning: 0.8, afternoon: 0.05, evening: 0.03, night: 0.02 }) })).tier, 'daypart');
});

test('the strongest argument wins, and weak signals below the threshold are ignored', () => {
  const v = combine(answers({ surrounding_content: noul(0.9), changing_fact: noul(0.7) }));
  assert.strictEqual(v.tier, 'live');
  assert.deepStrictEqual(v.signals.map((s) => s.question).sort(), ['changing_fact', 'surrounding_content']);
  assert.strictEqual(combine(answers({ changing_fact: noul(0.4), assumes_now: noul(0.5) })).tier, 'static');
});

test('missing or unreadable answers give no verdict', () => {
  assert.strictEqual(combine({}), null);
  assert.strictEqual(combine(answers({ horizon: undefined })), null);
  assert.strictEqual(combine(answers({ assumes_now: { type: 'noul' } })), null);
});

test('as the second opinion it only demotes, names the questions that fired, and flags review', async () => {
  const text = 'Green Light Radio. Turn it up.';
  const fine = await classifyWithSecondOpinion(text, createJevAsk({ apiKey: 'k', fetchImpl: serve(answers()) }));
  assert.strictEqual(fine.freshness, 'static');
  assert.ok(!fine.needsReview);
  const caught = await classifyWithSecondOpinion(text, createJevAsk({ apiKey: 'k', fetchImpl: serve(answers({ surrounding_content: noul(0.92) })) }));
  assert.strictEqual(caught.freshness, 'live');
  assert.strictEqual(caught.needsReview, true);
  assert.ok(caught.reasons.some((r) => r.includes('surrounding_content 0.92')));
  // rules already said live: Jev is not asked and cannot soften it
  let asked = false;
  const live = await classifyWithSecondOpinion('Right now it is raining.', async () => { asked = true; return { tier: 'static', timeDependent: 0 }; });
  assert.strictEqual(live.freshness, 'live');
  assert.strictEqual(asked, false);
});

test('errors and doubt are flagged for review, never trusted', async () => {
  const text = 'Green Light Radio. Turn it up.';
  const down = await classifyWithSecondOpinion(text, createJevAsk({ apiKey: 'k', fetchImpl: async () => new Response('no', { status: 503 }) }));
  assert.strictEqual(down.freshness, 'static');
  assert.strictEqual(down.needsReview, true);
  const odd = await classifyWithSecondOpinion(text, createJevAsk({ apiKey: 'k', fetchImpl: serve({}) }));
  assert.strictEqual(odd.needsReview, true);
  const unsure = await classifyWithSecondOpinion(text, createJevAsk({ apiKey: 'k', fetchImpl: serve(answers({ horizon: horizon({ years: 0.9, months: 0.1, weeks: 0, days: 0, hours: 0 }, 0.3) })) }));
  assert.strictEqual(unsure.freshness, 'static');
  assert.strictEqual(unsure.needsReview, true);
});

test('refuses to be built without a key', () => {
  assert.throws(() => createJevAsk({}), /API key/);
});
