'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const S = require('../public/slots.js');

const timesMc = (responses = []) => ({
  mode: 'times', dates: ['2026-10-03', '2026-10-04'], startTime: '09:00', endTime: '12:00', slotMinutes: 60, responses,
});

test('builds slot ids for dates and times', () => {
  assert.deepEqual(S.slotIds({ mode: 'dates', dates: ['2026-10-03'] }), ['2026-10-03']);
  assert.deepEqual(S.timeRows(timesMc()), ['09:00', '10:00', '11:00']);
  assert.equal(S.slotIds(timesMc()).length, 6);
  assert.equal(S.slotIds(timesMc())[0], '2026-10-03T09:00');
});

test('validates dates and times', () => {
  assert.ok(S.isValidDate('2028-02-29'));
  assert.ok(!S.isValidDate('2026-02-30'));
  assert.ok(!S.isValidDate('nope'));
  assert.equal(S.timeToMin('24:00'), 1440);
  assert.ok(isNaN(S.timeToMin('24:30')));
});

test('merges consecutive slots with the same crowd into ranked windows', () => {
  const mc = timesMc([
    { name: 'Ana', yes: ['2026-10-03T09:00', '2026-10-03T10:00', '2026-10-04T11:00'], maybe: [] },
    { name: 'Bo', yes: ['2026-10-03T09:00', '2026-10-03T10:00'], maybe: ['2026-10-04T11:00'] },
  ]);
  const [best, second] = S.computeWindows(mc);
  assert.deepEqual(best.slots, ['2026-10-03T09:00', '2026-10-03T10:00']);
  assert.equal(best.start, '09:00');
  assert.equal(best.end, '11:00');
  assert.deepEqual(best.yes, ['Ana', 'Bo']);
  assert.equal(second.score, 1.5);
  assert.deepEqual(second.maybe, ['Bo']);
});

test('converts wall time in a zone to UTC, across DST', () => {
  assert.equal(S.zonedToUtc('2026-07-01', '09:00', 'America/New_York').toISOString(), '2026-07-01T13:00:00.000Z');
  assert.equal(S.zonedToUtc('2026-12-01', '09:00', 'America/New_York').toISOString(), '2026-12-01T14:00:00.000Z');
  assert.equal(S.zonedToUtc('2026-10-01', '24:00', 'UTC').toISOString(), '2026-10-02T00:00:00.000Z');
});
