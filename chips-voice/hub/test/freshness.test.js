const test = require('node:test');
const assert = require('node:assert');
const { classify, classifyWithSecondOpinion, TIERS } = require('../freshness');
const fixtures = require('./fixtures/glr-scripts.json');

test('every Green Light script gets the same tier as the station-side Python classifier', () => {
  assert.ok(fixtures.length >= 100);
  const wrong = fixtures.filter((f) => classify(f.text).freshness !== f.freshness).map((f) => `${f.group}: ${f.text.slice(0, 60)}`);
  assert.deepStrictEqual(wrong, []);
});

test('a station name, tagline and call sign are fully static placeholders', () => {
  for (const t of ['{{station}}: no ads, no sponsors.', "You're listening to {{station}}, {{callsign}}. {{tagline}}", '{{ Station }} forever']) {
    const r = classify(t);
    assert.strictEqual(r.freshness, 'static', t);
    assert.deepStrictEqual(r.needs, []);
  }
});

test('placeholder classes: stable values are refreshable, volatile and unknown ones are live', () => {
  assert.strictEqual(classify('{{nextShow}} is on soon').freshness, 'refreshable');
  assert.strictEqual(classify('It is {{time}}').freshness, 'live');
  assert.strictEqual(classify('{{weather|a lovely day}} out there').freshness, 'live');
  assert.strictEqual(classify('{{somethingNew}}').freshness, 'live');
  assert.deepStrictEqual(classify('{{station}} at {{time}}').needs, ['time']);
});

test('the tier only goes up: one signal is enough to leave static', () => {
  const base = classify('Green Light Radio. Turn it up.');
  assert.strictEqual(base.freshness, 'static');
  const worse = classify('Green Light Radio. Turn it up, the next song is a good one.');
  assert.ok(TIERS.indexOf(worse.freshness) > TIERS.indexOf(base.freshness));
});

// The dangerous mistake is a time-bound script called static, so these must NEVER come out static.
test('time-bound wording is never static', () => {
  const mustNotBeStatic = [
    "Wild Bill's Rock Show starts at 7.",
    'Tonight on Green Light Radio, two hours of rock.',
    'Coming up in about twenty minutes, Datura.',
    'It is 3:45 PM and the sun is out.',
    "Thanks for hanging out this Friday.",
    'That was a great one, wasn\'t it.',
    'Rain is coming, grab a jacket.',
    "Call 720-432-5457 and tell us what you want to hear.",
    'Email us at kglrfm at gmail dot com.',
    'Happy new year 2027.',
    'This week only, a new show.',
    'Right now, someone is listening.',
  ];
  const bad = mustNotBeStatic.filter((t) => classify(t).freshness === 'static');
  assert.deepStrictEqual(bad, []);
});

test('plain evergreen lines stay static, and the result explains itself', () => {
  const r = classify("You're listening to Green Light Radio. No ads. No sponsors. No tracking.");
  assert.strictEqual(r.freshness, 'static');
  assert.deepStrictEqual(r.reasons, []);
  const live = classify('Right now it is raining.');
  assert.strictEqual(live.freshness, 'live');
  assert.ok(live.reasons.some((x) => x.startsWith('now/latest wording')));
  assert.strictEqual(typeof live.classifierVersion, 'number');
});

test('empty and odd input does not throw', () => {
  for (const v of ['', null, undefined, 42]) assert.strictEqual(classify(v).freshness, 'static');
});

test('second opinion can only take a script out of static, never the other way', async () => {
  const text = 'Green Light Radio. Turn it up.';
  const stays = await classifyWithSecondOpinion(text, async () => ({ timeDependent: 0.05, confidence: 0.9 }));
  assert.strictEqual(stays.freshness, 'static');
  assert.ok(!stays.needsReview);
  const moved = await classifyWithSecondOpinion(text, async () => ({ timeDependent: 0.8, confidence: 0.9 }));
  assert.strictEqual(moved.freshness, 'refreshable');
  assert.strictEqual(moved.needsReview, true);
  // the rules already said live: the model is not even asked, and cannot demote it
  let asked = false;
  const live = await classifyWithSecondOpinion('Right now it is raining.', async () => { asked = true; return { timeDependent: 0 }; });
  assert.strictEqual(live.freshness, 'live');
  assert.strictEqual(asked, false);
});

test('second opinion failures and low confidence are flagged for review, not trusted', async () => {
  const text = 'Green Light Radio. Turn it up.';
  const down = await classifyWithSecondOpinion(text, async () => { throw new Error('503'); });
  assert.strictEqual(down.freshness, 'static');
  assert.strictEqual(down.needsReview, true);
  const junk = await classifyWithSecondOpinion(text, async () => ({ nope: 1 }));
  assert.strictEqual(junk.needsReview, true);
  const unsure = await classifyWithSecondOpinion(text, async () => ({ timeDependent: 0.2, confidence: 0.3 }));
  assert.strictEqual(unsure.freshness, 'static');
  assert.strictEqual(unsure.needsReview, true);
  assert.strictEqual((await classifyWithSecondOpinion(text, null)).freshness, 'static');
});
