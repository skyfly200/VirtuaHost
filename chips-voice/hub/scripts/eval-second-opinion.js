#!/usr/bin/env node
// Measures the Jev second opinion against hand-labelled "sneaky" lines (ones the regular expressions are expected to call static).
//   TYPESAFE_API_KEY=... node scripts/eval-second-opinion.js [fixtures.json]
// Prints, per line: what the rules said, what Jev argued, and which questions fired. Spends a few cents of Jev calls; nothing else.
const fs = require('fs');
const path = require('path');
const { classify, classifyWithSecondOpinion } = require('../freshness');
const { createJevAsk } = require('../jev');

(async () => {
  const key = process.env.TYPESAFE_API_KEY;
  if (!key) { console.error('Set TYPESAFE_API_KEY first.'); process.exit(2); }
  const file = process.argv[2] || path.join(__dirname, '../test/fixtures/sneaky-lines.json');
  const lines = JSON.parse(fs.readFileSync(file, 'utf8'));
  const ask = createJevAsk({ apiKey: key });
  let caught = 0, missed = 0, falseAlarm = 0, fine = 0, rulesAlready = 0;
  for (const { text, expect } of lines) {
    if (classify(text).freshness !== 'static') { rulesAlready += 1; console.log(`rules already flag  | ${text}`); continue; }
    const r = await classifyWithSecondOpinion(text, ask);
    const flagged = r.freshness !== 'static';
    if (expect === 'none') { flagged ? falseAlarm++ : fine++; } else { flagged ? caught++ : missed++; }
    console.log(`${(flagged ? r.freshness : 'static').padEnd(11)} expect ${expect.padEnd(19)}| ${text}${r.needsReview ? '  [review: ' + r.reasons.slice(-1)[0] + ']' : ''}`);
  }
  console.log(`\ncaught ${caught}, missed ${missed}, false alarms ${falseAlarm}, correctly left alone ${fine}, rules already flagged ${rulesAlready}`);
})();
