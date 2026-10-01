const { test } = require('node:test');
const assert = require('node:assert/strict');
const { isRealDay, shiftDay, mondayOf, clientDay, utcDay } = require('../server/day');

test('isRealDay accepts only dates that exist', () => {
  assert.equal(isRealDay('2026-10-01'), true);
  assert.equal(isRealDay('2024-02-29'), true);
  assert.equal(isRealDay('2026-02-29'), false);
  assert.equal(isRealDay('2026-13-01'), false);
  assert.equal(isRealDay('2026-1-1'), false);
  assert.equal(isRealDay("2026-10-01');alert(1)//"), false);
  assert.equal(isRealDay(undefined), false);
});

test('shiftDay crosses month and year boundaries', () => {
  assert.equal(shiftDay('2026-10-01', -1), '2026-09-30');
  assert.equal(shiftDay('2026-12-31', 1), '2027-01-01');
  assert.equal(shiftDay('2024-03-01', -1), '2024-02-29');
});

test('mondayOf returns the Monday of that week', () => {
  assert.equal(mondayOf('2026-10-01'), '2026-09-28'); // a Thursday
  assert.equal(mondayOf('2026-09-28'), '2026-09-28'); // already Monday
  assert.equal(mondayOf('2026-10-04'), '2026-09-28'); // Sunday belongs to the week that started Monday
});

test('clientDay trusts the header only within a day of the server clock', () => {
  const req = (value) => ({ get: () => value });
  const today = utcDay();
  assert.equal(clientDay(req(shiftDay(today, 1))), shiftDay(today, 1));
  assert.equal(clientDay(req(shiftDay(today, -1))), shiftDay(today, -1));
  assert.equal(clientDay(req(shiftDay(today, 2))), today);
  assert.equal(clientDay(req('garbage')), today);
  assert.equal(clientDay(req(undefined)), today);
});
