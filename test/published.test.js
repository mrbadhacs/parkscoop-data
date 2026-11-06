const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');

const root = path.join(__dirname, '..');
const read = (rel) => JSON.parse(fs.readFileSync(path.join(root, rel), 'utf8'));

test('published day logs are real encoded samples', () => {
  const seed = read('waits/days/2026-10-26.json');
  assert.equal(seed.d, '2026-10-26');
  assert.equal(seed.tz, 'America/New_York');
  assert.deepEqual(seed.t, ['13:53']);
  assert.equal(seed.w['b2260923-9315-40fd-9c6b-44dd811dbe64'][0], 20);
  assert.deepEqual(seed.rides['b2260923-9315-40fd-9c6b-44dd811dbe64'], ['Space Mountain', 'magic-kingdom']);
  assert.equal(seed.w['4f391f0e-52be-4f9d-99d6-b3ae0373b43c'][0], -1);
  assert.equal(seed.w['e40ac396-cbac-43f4-8752-764ed60ccceb'][0], -2);
  assert.equal(seed.w['de737ffc-306b-4f32-8bbb-34e5d370ec8f'][0], null);

  const today = read('waits/days/2026-11-06.json');
  assert.equal(today.d, '2026-11-06');
  assert.ok(today.t.length >= 1);
  for (const file of [seed, today]) {
    for (const id of Object.keys(file.w)) {
      assert.equal(file.w[id].length, file.t.length);
      for (const v of file.w[id]) {
        assert.ok(v === null || (Number.isInteger(v) && v >= -2));
      }
    }
  }
});

test('rollup, views, hours, and scorecard match the published contract', () => {
  const roll = read('waits/rollup.json');
  assert.deepEqual(Object.keys(roll.days), ['2026-10-26']);
  assert.equal(roll.allTime.first, '2026-10-26');
  assert.equal(roll.allTime.days, 2);
  assert.ok(roll.allTime.checks >= 2);

  const best = read('waits/best.json');
  assert.equal(best.minDayHours, 3);
  assert.equal(best.minChecks, 6);
  assert.deepEqual(best.days.map(d => d.d), ['2026-10-26', '2026-11-06']);
  assert.equal(best.parks['volcano-bay'], undefined);
  assert.equal('hourNow' in best.parks['magic-kingdom'], false);
  const dlSpace = best.parks.disneyland.rides.find(r => r.id === '9167db1d-e5e7-46da-a07f-ae30a87bc4c4');
  assert.ok(dlSpace.hours.some(h => h.h === 10));
  assert.equal('live' in dlSpace, false);
  assert.equal(best.source.includes('every 15 minutes'), true);

  const rel = read('waits/rel.json');
  assert.equal(rel.todayDate, '2026-11-06');
  assert.equal(rel.interval, 15);
  assert.equal(rel.gap, 31);
  assert.equal(rel.tz, 'America/New_York');
  assert.equal(Object.keys(rel.parks).length, 10);
  assert.deepEqual(rel.days.map(d => d.d), ['2026-11-06']);

  const crowd = read('waits/crowd.json');
  assert.equal(crowd.source, 'ParkScoop wait log (ThemeParks.wiki standby waits)');
  assert.deepEqual(crowd.days.map(d => d.d), ['2026-10-26', '2026-11-06']);
  for (const day of crowd.days) {
    assert.equal(day.checks, 1);
    assert.ok(day.parks['magic-kingdom'].k >= 1);
  }

  for (const day of ['2026-11-06', '2026-11-07']) {
    const hours = read(`hours/${day}.json`);
    assert.equal(hours.d, day);
    assert.equal(hours.parks['volcano-bay'], undefined);
    for (const wins of Object.values(hours.parks)) {
      assert.ok(wins.length >= 1);
      for (const [open, close] of wins) assert.ok(close > open);
    }
  }
  assert.equal(fs.existsSync(path.join(root, 'forecasts', '2026-11-06.json')), false);
  assert.equal(fs.existsSync(path.join(root, 'forecasts', '2026-11-07.json')), false);

  const summary = read('scores/summary.json');
  assert.equal(summary.today, '2026-11-06');
  assert.equal(summary.lastFinished, '2026-11-05');
  assert.equal(summary.method.startsWith('v1:'), true);
  assert.deepEqual(summary.locked, { today: false, tomorrow: false });
  assert.equal(summary.scoringStarts.forecastDay, '2026-11-07');
  assert.equal(summary.scoringStarts.scoreAppears, '2026-11-08');
  assert.equal(summary.scoringStarts.forecastLocked, false);
  assert.equal(summary.latest, null);
  assert.deepEqual(summary.history, []);
  assert.deepEqual(read('scores/index.json').days, []);
});
