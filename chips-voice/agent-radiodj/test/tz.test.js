const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const path = require('path');
const tz = require('../tz');

const CHI = 'America/Chicago';
const DEN = 'America/Denver';

test('hub/tz.js is an identical copy', () => {
  assert.strictEqual(fs.readFileSync(path.join(__dirname, '../tz.js'), 'utf8'), fs.readFileSync(path.join(__dirname, '../../hub/tz.js'), 'utf8'));
});

test('a Central PC timestamp is read as Central and shown as Denver (one hour earlier on the wall)', () => {
  const ms = tz.parseMachineTimestamp('2026-10-22 18:30:00', CHI);
  assert.strictEqual(new Date(ms).toISOString(), '2026-10-22T23:30:00.000Z');       // CDT = UTC-5
  assert.strictEqual(tz.formatLocal(ms, DEN), '2026-10-22 17:30:00');
  assert.strictEqual(tz.formatIso(ms, DEN), '2026-10-22T17:30:00-06:00');
});

test('timestamps that carry their own offset or Z are not reinterpreted', () => {
  assert.strictEqual(tz.parseMachineTimestamp('2026-10-22T23:30:00Z', CHI), Date.parse('2026-10-22T23:30:00Z'));
  assert.strictEqual(tz.parseMachineTimestamp('2026-10-22T18:30:00-0500', CHI), Date.parse('2026-10-22T23:30:00Z'));
  assert.strictEqual(tz.parseMachineTimestamp('nonsense', CHI), null);
  assert.strictEqual(tz.parseMachineTimestamp('2026-10-22 18:30:00', 'Not/AZone'), null);
});

test('midnight rollover: a PC time just after midnight Central is still the previous day in Denver', () => {
  const ms = tz.parseMachineTimestamp('2026-10-23 00:30:00', CHI);
  assert.strictEqual(tz.formatLocal(ms, DEN), '2026-10-22 23:30:00');
  assert.strictEqual(tz.dateIn(ms, DEN), '2026-10-22');
  assert.strictEqual(tz.dateIn(ms, CHI), '2026-10-23');
  // and the other way: 23:30 Denver is 00:30 the next day on the PC
  const denver = tz.localToInstant({ year: 2026, month: 10, day: 22, hour: 23, minute: 30 }, DEN);
  assert.strictEqual(tz.formatLocal(denver, CHI), '2026-10-23 00:30:00');
});

test('the broadcast day for the nightly playlist runs midnight to midnight in Denver, not on the PC clock', () => {
  const day = tz.dayBounds('2026-10-22', DEN);
  assert.strictEqual(tz.formatIso(day.start, DEN), '2026-10-22T00:00:00-06:00');
  assert.strictEqual(tz.formatLocal(day.start, CHI), '2026-10-22 01:00:00');
  assert.strictEqual(day.hours, 24);
});

test('DST: spring forward makes a 23-hour day, fall back a 25-hour day, and the offsets change', () => {
  assert.strictEqual(tz.dayBounds('2026-03-08', DEN).hours, 23);
  assert.strictEqual(tz.dayBounds('2026-11-01', DEN).hours, 25);
  assert.strictEqual(tz.dayBounds('2026-03-09', DEN).hours, 24);
  assert.strictEqual(tz.offsetMinutes(Date.parse('2026-03-08T08:59:00Z'), DEN), -420);   // MST until 02:00 local = 09:00Z
  assert.strictEqual(tz.offsetMinutes(Date.parse('2026-03-08T09:00:00Z'), DEN), -360);
});

test('DST: a time that never happened moves forward; a repeated time resolves by the nearest reference', () => {
  const gap = tz.localToInstant({ year: 2026, month: 3, day: 8, hour: 2, minute: 30 }, DEN);   // 02:30 does not exist in Denver on 2026-03-08
  assert.strictEqual(tz.formatLocal(gap, DEN), '2026-03-08 03:30:00');
  const both = tz.localInstants({ year: 2026, month: 11, day: 1, hour: 1, minute: 30 }, DEN);  // 01:30 happens twice
  assert.strictEqual(both.length, 2);
  assert.strictEqual(new Date(both[0]).toISOString(), '2026-11-01T07:30:00.000Z');          // MDT
  assert.strictEqual(new Date(both[1]).toISOString(), '2026-11-01T08:30:00.000Z');          // MST
  const c = { year: 2026, month: 11, day: 1, hour: 1, minute: 30 };
  assert.strictEqual(tz.localToInstant(c, DEN), both[0]);
  assert.strictEqual(tz.localToInstant(c, DEN, { near: both[1] + 60000 }), both[1]);
  assert.strictEqual(tz.localToInstant(c, DEN, { near: both[0] - 60000 }), both[0]);
});

test('DST: both zones change at their own local 2:00, so for one hour the Chicago/Denver gap is 2 hours', () => {
  const between = Date.parse('2026-03-08T08:30:00Z');       // Chicago has sprung forward (08:00Z); Denver has not yet (09:00Z)
  assert.strictEqual(tz.offsetMinutes(between, CHI), -300);
  assert.strictEqual(tz.offsetMinutes(between, DEN), -420);
  const warn = tz.zoneWarnings({ machineTz: CHI, broadcastTz: DEN, now: between });
  assert.ok(warn.some((w) => w.code === 'zones-differ' && /2 hours/.test(w.message)));
});

test('warnings: Central machine with Denver broadcast, matching zones, wrong PC offset, missing and invalid zones', () => {
  const now = Date.parse('2026-10-22T20:00:00Z');
  const differ = tz.zoneWarnings({ machineTz: CHI, broadcastTz: DEN, pcOffsetMinutes: -300, now });
  assert.deepStrictEqual(differ.map((w) => w.code), ['zones-differ']);
  assert.match(differ[0].message, /1 hour/);
  assert.deepStrictEqual(tz.zoneWarnings({ machineTz: DEN, broadcastTz: DEN, pcOffsetMinutes: -360, now }), []);
  const wrong = tz.zoneWarnings({ machineTz: DEN, broadcastTz: DEN, pcOffsetMinutes: -300, now });
  assert.deepStrictEqual(wrong.map((w) => [w.code, w.level]), [['pc-offset-mismatch', 'error']]);
  assert.match(wrong[0].message, /UTC-05:00.*UTC-06:00/);
  assert.deepStrictEqual(tz.zoneWarnings({ broadcastTz: DEN, now }).map((w) => w.code), ['machine-tz-missing']);
  assert.deepStrictEqual(tz.zoneWarnings({ machineTz: 'Nope', broadcastTz: 'Also/Nope', now }).map((w) => w.code), ['machine-tz-invalid', 'broadcast-tz-invalid']);
});

test('validTimeZone', () => {
  assert.ok(tz.validTimeZone(DEN));
  assert.ok(!tz.validTimeZone('Mars/Base'));
  assert.ok(!tz.validTimeZone(''));
  assert.ok(!tz.validTimeZone(undefined));
});
