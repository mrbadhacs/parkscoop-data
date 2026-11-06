const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { execFileSync } = require('node:child_process');
const { addDays } = require('../scripts/lib/time');
const { saveDay } = require('../scripts/lib/daylog');
const { incrementalSeal, rebuildRollup, buildViews, readRollup } = require('../scripts/lib/rollup');
const { outages, bestFromFiles, reliabilityFromFiles, crowdFromFiles, summarizeCrowd, actualsFromFiles, actualsFromSummary, summarizeDay } = require('../scripts/lib/compute');
const { buildForecast, scoreDay, ensureForecast, inHours } = require('../scripts/lib/forecast');
const { readJson, writeJson, stableOmit } = require('../scripts/lib/io');

const ROOT = path.join(__dirname, '..');
const UPDATED = '2026-10-29T18:00:00.000Z';

function makeDay(d, t, rides) {
  const day = { d, tz: 'America/New_York', t: t.slice(), rides: {}, w: {} };
  for (const r of rides) {
    if (r.w.length !== t.length) throw new Error('length ' + r.id);
    day.rides[r.id] = [r.n, r.p];
    day.w[r.id] = r.w.slice();
  }
  return day;
}

function fixture() {
  const D = '2026-10-26';
  const D1 = '2026-10-27';
  const D3 = '2026-10-29';
  const t0 = ['09:00', '09:10', '09:20', '09:30', '09:40', '09:50', '22:30', '23:00'];
  const t1 = ['01:00', '01:30', '10:00', '10:20', '11:00'];
  const t3 = ['12:00', '12:15', '12:30'];
  const files = {
    [D]: makeDay(D, t0, [
      { id: 'mk-out', n: 'Outage Coaster', p: 'magic-kingdom', w: [30, -1, -1, 20, 25, 15, null, null] },
      { id: 'mk-hour', n: 'Hourly', p: 'magic-kingdom', w: [10, 20, 30, 40, 50, 60, null, null] },
      { id: 'mk-fill', n: 'Filler', p: 'magic-kingdom', w: [5, 5, 5, 5, 5, 5, null, null] },
      { id: 'dl-ride', n: 'Matterhorn', p: 'disneyland', w: [null, null, null, null, null, null, 40, 50] },
    ]),
    [D1]: makeDay(D1, t1, [
      { id: 'mk-out', n: 'Outage Coaster', p: 'magic-kingdom', w: [null, null, 10, -1, 12] },
      { id: 'mk-hour', n: 'Hourly Mid', p: 'magic-kingdom', w: [null, null, null, null, null] },
      { id: 'mk-fill', n: 'Filler', p: 'magic-kingdom', w: [null, null, null, null, null] },
      { id: 'dl-ride', n: 'Matterhorn', p: 'disneyland', w: [10, 20, null, null, null] },
    ]),
    [D3]: makeDay(D3, t3, [
      { id: 'mk-out', n: 'Outage Coaster', p: 'magic-kingdom', w: [30, -1, -1] },
      { id: 'mk-fill', n: 'Filler', p: 'magic-kingdom', w: [null, null, null] },
      { id: 'dl-ride', n: 'Matterhorn', p: 'disneyland', w: [null, null, null] },
    ]),
  };
  return { D, D1, D3, files, today: D3 };
}

function writeFixture(dir, files) {
  for (const d of Object.keys(files)) saveDay(dir, files[d]);
}

function omitUpdated(v) {
  return JSON.parse(stableOmit(v, ['updated']));
}

test('outage duration uses the recovery check and drops wide gaps', () => {
  const tight = outages(['10:00', '10:15', '10:30', '10:45'], [20, -1, -1, 15]);
  assert.equal(tight.length, 1);
  assert.equal(tight[0].open, false);
  assert.equal(tight[0].a, '10:15');
  assert.equal(tight[0].m, 30);

  const loose = outages(['10:00', '10:15', '11:00'], [20, -1, 10]);
  assert.equal(loose[0].m, null);
  assert.equal(loose[0].open, false);

  const open = outages(['10:00', '10:15'], [20, -1]);
  assert.equal(open[0].open, true);
  assert.equal(open[0].m, null);

  const single = outages(['10:00', '10:15', '10:30'], [5, -1, 5]);
  assert.equal(single[0].m, 15);
});

test('pacific carryover, outages, and rollup rebuild match raw views', () => {
  const { D, D1, D3, files, today } = fixture();
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ps-'));
  writeFixture(dir, files);

  incrementalSeal(dir, D1, UPDATED);
  assert.equal(readRollup(dir).days[D], undefined);

  incrementalSeal(dir, addDays(D1, 1), UPDATED);
  assert.ok(readRollup(dir).days[D]);
  assert.equal(readRollup(dir).days[D1], undefined);

  const inc = incrementalSeal(dir, today, UPDATED);
  assert.ok(inc.days[D] && inc.days[D1]);
  assert.equal(inc.days[D3], undefined);
  assert.equal(inc.allTime.days, 3);
  assert.equal(inc.allTime.checks, 8 + 5 + 3);
  assert.equal(inc.allTime.first, D);

  const viewsInc = buildViews(dir, today, UPDATED, inc);
  rebuildRollup(dir, today, UPDATED);
  const rebuilt = readRollup(dir);
  const viewsRe = buildViews(dir, today, UPDATED, rebuilt);
  assert.deepEqual(omitUpdated(rebuilt), omitUpdated(inc));
  assert.deepEqual(omitUpdated(viewsRe.best), omitUpdated(viewsInc.best));
  assert.deepEqual(omitUpdated(viewsRe.rel), omitUpdated(viewsInc.rel));
  assert.deepEqual(omitUpdated(viewsRe.crowd), omitUpdated(viewsInc.crowd));

  const rawBest = bestFromFiles(files, today, UPDATED);
  const rawRel = reliabilityFromFiles(files, today, UPDATED);
  const rawCrowd = crowdFromFiles(files, today, UPDATED);
  assert.deepEqual(omitUpdated(viewsRe.best), omitUpdated(rawBest));
  assert.deepEqual(omitUpdated(viewsRe.rel), omitUpdated(rawRel));
  assert.deepEqual(omitUpdated(viewsRe.crowd), omitUpdated(rawCrowd));

  const dl = viewsRe.best.parks.disneyland.rides.find(r => r.id === 'dl-ride');
  assert.equal(dl.samples, 4);
  assert.equal(dl.usual, 30);
  assert.equal(dl.bestHour, null);
  const h19 = dl.hours.find(h => h.h === 19);
  const h20 = dl.hours.find(h => h.h === 20);
  const h22 = dl.hours.find(h => h.h === 22);
  assert.deepEqual({ n: h19.n, d: h19.d, ok: h19.ok, m: h19.m }, { n: 1, d: 1, ok: false, m: null });
  assert.equal(h20.n, 1);
  assert.deepEqual({ n: h22.n, d: h22.d, ok: h22.ok }, { n: 2, d: 1, ok: false });

  const hourly = viewsRe.best.parks['magic-kingdom'].rides.find(r => r.id === 'mk-hour');
  assert.equal(hourly.n, 'Hourly Mid');
  assert.equal(hourly.bestHour, 9);
  assert.equal(hourly.bestMedian, 35);
  assert.equal(hourly.usual, 35);
  assert.equal(hourly.hours[0].ok, true);
  assert.equal(hourly.samples, 6);
  assert.equal(viewsRe.best.parks['volcano-bay'], undefined);
  assert.equal(viewsRe.best.checks, 16);
  assert.deepEqual(viewsRe.best.days.map(d => d.d), [D, D1, D3]);
  assert.equal(viewsRe.best.window.first, D);
  assert.equal(viewsRe.best.window.last, D3);

  const out = viewsRe.rel.parks['magic-kingdom'].find(r => r.id === 'mk-out');
  assert.equal(out.up, 7);
  assert.equal(out.dn, 5);
  assert.equal(out.ev, 3);
  assert.equal(out.days, 3);
  assert.equal(out.downDays, 3);
  assert.equal(out.med, 20);
  assert.deepEqual(out.long, { m: 20, d: D, a: '09:10' });
  assert.equal(out.tl, 'udd');
  assert.equal(out.since, '12:15');
  assert.equal(out.todayEv, 1);
  assert.equal(out.todayDownMin, null);
  assert.equal(viewsRe.rel.todayDate, D3);
  assert.deepEqual(viewsRe.rel.todayT, ['12:00', '12:15', '12:30']);
  assert.equal(viewsRe.rel.gap, 31);
  assert.equal(viewsRe.rel.interval, 15);

  const crowdD = viewsRe.crowd.days.find(d => d.d === D);
  assert.deepEqual(crowdD.parks['magic-kingdom'], { avg: 23, k: 4 });
  assert.equal(crowdD.parks.disneyland, undefined);
  assert.equal(viewsRe.crowd.days.some(d => d.d === '2026-10-28'), false);
  assert.deepEqual(summarizeCrowd(files[D])['magic-kingdom'], { avg: 23, k: 4 });

  const load = (d) => files[d] ? summarizeDay(files[d]) : null;
  const park = { slug: 'disneyland', dest: 'disneyland' };
  assert.deepEqual(actualsFromSummary(park, D, load), actualsFromFiles(park, D, d => files[d] || null));
  assert.equal(actualsFromFiles(park, D, d => files[d] || null).hours['dl-ride']['22'], 15);
  assert.equal(actualsFromFiles(park, D, d => files[d] || null).hours['dl-ride']['19'], 40);
});

test('forecast locks same-weekday history and scores only inside official hours', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ps-fc-'));
  const mk = (d, t, w) => saveDay(dir, makeDay(d, t, [{ id: 'mk-fc', n: 'Forecast Test', p: 'magic-kingdom', w }]));
  mk('2026-10-28', ['09:10', '09:40'], [40, 60]);
  mk('2026-11-04', ['09:15', '09:45'], [20, 40]);
  mk('2026-11-08', ['10:10'], [10]);
  mk('2026-11-09', ['10:10', '10:40'], [20, 30]);
  mk('2026-11-10', ['10:05'], [40]);
  mk('2026-11-11', ['09:10', '09:40', '10:15'], [30, 40, 10]);

  const now = new Date('2026-11-10T22:00:00.000Z');
  const fc = buildForecast('2026-11-11', (p, d) => actualsFromSummary(p, d, (day) => {
    const f = readJson(path.join(dir, 'waits', 'days', day + '.json'));
    return f ? summarizeDay(f) : null;
  }), now);
  const ride = fc.parks['magic-kingdom'].rides['mk-fc'];
  assert.equal(ride.f[9], 40);
  assert.equal(ride.m[9], 'w');
  assert.equal(ride.f[10], 25);
  assert.equal(ride.m[10], 'r');
  assert.equal(ride.n, 'Forecast Test');

  writeJson(path.join(dir, 'forecasts', '2026-11-11.json'), fc);
  writeJson(path.join(dir, 'hours', '2026-11-11.json'), {
    d: '2026-11-11', fetched: now.toISOString(), source: 'ThemeParks.wiki schedule (type OPERATING only)',
    parks: { 'magic-kingdom': [[8 * 60, 22 * 60]] },
  });
  assert.equal(inHours([[8 * 60, 22 * 60]], 9), true);
  assert.equal(inHours([[8 * 60, 22 * 60]], 22), false);

  const scored = scoreDay(dir, '2026-11-11', now);
  assert.equal(scored.overall.n, 2);
  assert.equal(scored.overall.w10, 1);
  assert.equal(scored.overall.pct, 50);
  assert.equal(scored.overall.mae, 10);
  assert.equal(scored.overall.bias, 10);
  assert.equal(scored.methods.w, 1);
  assert.equal(scored.methods.r, 1);
  assert.equal(scored.miss, null);

  const sameDay = JSON.parse(JSON.stringify(fc));
  sameDay.made = '2026-11-11T15:00:00.000Z';
  writeJson(path.join(dir, 'forecasts', '2026-11-11.json'), sameDay);
  assert.equal(scoreDay(dir, '2026-11-11', now), null);

  const early = ensureForecast(dir, '2026-11-11', '2026-11-11', now);
  assert.equal(early.ok, false);
});

test('view envelopes match the ParkScoop contract', () => {
  const { files, today } = fixture();
  const best = bestFromFiles(files, today, UPDATED);
  const rel = reliabilityFromFiles(files, today, UPDATED);
  const crowd = crowdFromFiles(files, today, UPDATED);
  for (const key of ['updated', 'source', 'method', 'tzNote', 'minDayHours', 'minChecks', 'checks', 'days', 'window', 'parks']) {
    assert.ok(Object.prototype.hasOwnProperty.call(best, key), key);
  }
  assert.equal(best.minDayHours, 3);
  assert.equal(best.minChecks, 6);
  const ride = best.parks['magic-kingdom'].rides[0];
  for (const key of ['id', 'n', 'usual', 'bestHour', 'bestMedian', 'hours', 'samples']) assert.ok(key in ride);
  assert.equal('live' in ride, false);
  assert.equal('hourNow' in ride, false);
  assert.equal('hourNow' in best.parks['magic-kingdom'], false);
  assert.deepEqual(Object.keys(ride.hours[0]).sort(), ['d', 'h', 'm', 'n', 'ok']);
  for (const key of ['updated', 'source', 'tz', 'interval', 'gap', 'checks', 'days', 'window', 'todayDate', 'todayT', 'parks']) {
    assert.ok(key in rel, key);
  }
  assert.equal(Object.keys(rel.parks).length, 10);
  assert.ok(Array.isArray(crowd.days));
  assert.ok(crowd.days[0].d && typeof crowd.days[0].checks === 'number' && crowd.days[0].parks);
});

test('CLI rebuild writes a rollup without fetching', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ps-cli-'));
  saveDay(dir, makeDay('2026-10-26', ['13:53'], [
    { id: 'mk-1', n: 'Space Mountain', p: 'magic-kingdom', w: [20] },
  ]));
  execFileSync(process.execPath, [path.join(ROOT, 'scripts', 'run.js'), '--no-fetch', '--rebuild', '--root', dir, '--now', '2026-11-06T18:00:00.000Z'], { encoding: 'utf8' });
  const rollup = readJson(path.join(dir, 'waits', 'rollup.json'));
  assert.equal(rollup.days['2026-10-26'].n, 1);
  assert.equal(rollup.days['2026-11-06'], undefined);
  assert.equal(rollup.allTime.first, '2026-10-26');
  const summary = readJson(path.join(dir, 'scores', 'summary.json'));
  assert.equal(summary.today, '2026-11-06');
  assert.equal(summary.lastFinished, '2026-11-05');
  assert.equal(summary.method.includes('same weekday'), true);
  assert.deepEqual(Object.keys(summary.scoringStarts).sort(), ['forecastDay', 'forecastLocked', 'scoreAppears']);
  assert.equal(summary.locked.today, false);
  assert.equal(summary.locked.tomorrow, false);
  assert.ok(readJson(path.join(dir, 'waits', 'best.json')));
  assert.ok(readJson(path.join(dir, 'waits', 'rel.json')));
  assert.ok(readJson(path.join(dir, 'waits', 'crowd.json')));
  assert.ok(readJson(path.join(dir, 'scores', 'index.json')));
});
