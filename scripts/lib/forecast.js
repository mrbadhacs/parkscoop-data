// Forecast lock + scorecard, ported from ParkScoop api/_forecast.js.
// Forecasts and official hours are written once and never overwritten. No hour is filled in without logged history.
const fs = require('fs');
const path = require('path');
const { SCORED, RESORTS } = require('./parks');
const { addDays, dow, etDay, etDate, lastFinished } = require('./time');
const { readJson, writeJson, writeJsonIfChanged } = require('./io');
const { medianRaw, actualsFromSummary } = require('./compute');
const { readRollup, makeLoader } = require('./rollup');

const METHOD = 'v1: median hourly posted wait, same weekday (28 days, 2+ days) else last 7 days (3+ days); actual = mean of the operating checks logged in that hour';
const HOURS_SOURCE = 'ThemeParks.wiki schedule (type OPERATING only)';
const FORECAST_SOURCE = 'ParkScoop wait log (ThemeParks.wiki posted standby waits)';

const r1 = x => Math.round(x * 10) / 10;

function hoursPath(root, d) { return path.join(root, 'hours', d + '.json'); }
function forecastPath(root, d) { return path.join(root, 'forecasts', d + '.json'); }
function indexPath(root) { return path.join(root, 'scores', 'index.json'); }
function summaryPath(root) { return path.join(root, 'scores', 'summary.json'); }

function localMin(iso, D) {
  const m = /^(\d{4}-\d{2}-\d{2})T(\d{2}):(\d{2})/.exec(iso || '');
  if (!m) return null;
  const v = +m[2] * 60 + +m[3];
  return m[1] > D ? v + 1440 : m[1] < D ? v - 1440 : v;
}

function inHours(wins, h) {
  return (wins || []).some(([a, b]) => h * 60 >= a && (h + 1) * 60 <= b);
}

function windowsFor(scheduleJson, D) {
  if (!scheduleJson) return [];
  return (scheduleJson.schedule || [])
    .filter(x => x.date === D && x.type === 'OPERATING')
    .map(x => [localMin(x.openingTime, D), localMin(x.closingTime, D)])
    .filter(x => x[0] != null && x[1] != null && x[1] > x[0]);
}

function hoursFromSchedules(D, schedules, fetched) {
  const parks = {};
  for (const p of SCORED) {
    const w = windowsFor(schedules[p.slug], D);
    if (w.length) parks[p.slug] = w;
  }
  if (!Object.keys(parks).length) return null;
  return { d: D, fetched, source: HOURS_SOURCE, parks };
}

function ensureHours(root, D, schedules, fetched) {
  const file = hoursPath(root, D);
  if (fs.existsSync(file)) return { ok: true, existed: true };
  const h = hoursFromSchedules(D, schedules, fetched);
  if (!h) return { ok: false, reason: 'no schedule' };
  writeJson(file, h);
  return { ok: true, parks: Object.keys(h.parks).length };
}

function agg(items) {
  if (!items.length) return { n: 0 };
  const e = items.map(x => x.f - x.a);
  const w10 = e.filter(x => Math.abs(x) <= 10).length;
  return {
    n: items.length,
    w10,
    pct: r1(100 * w10 / items.length),
    mae: r1(e.reduce((s, x) => s + Math.abs(x), 0) / e.length),
    bias: r1(e.reduce((s, x) => s + x, 0) / e.length),
  };
}

function cellCount(fc) {
  return Object.values(fc.parks).reduce((n, p) => n + Object.values(p.rides).reduce((k, r) => k + Object.keys(r.f).length, 0), 0);
}

// actuals(park, date) -> { names, hours } for park-local date. History is strictly before D.
function buildForecast(D, actuals, now) {
  const out = { d: D, made: now.toISOString(), method: METHOD, source: FORECAST_SOURCE, parks: {} };
  const hist = [];
  for (let i = 1; i <= 28; i++) hist.push(addDays(D, -i));
  for (const p of SCORED) {
    const days = hist.map(d => ({ d, a: actuals(p, d) }));
    const rides = {};
    const allIds = new Set();
    days.forEach(x => Object.keys(x.a.hours).forEach(id => allIds.add(id)));
    for (const id of allIds) {
      const f = {};
      const m = {};
      for (let h = 0; h < 24; h++) {
        const wk = days.filter(x => dow(x.d) === dow(D)).map(x => (x.a.hours[id] || {})[h]).filter(v => typeof v === 'number');
        const rc = days.slice(0, 7).map(x => (x.a.hours[id] || {})[h]).filter(v => typeof v === 'number');
        if (wk.length >= 2) { f[h] = Math.round(medianRaw(wk)); m[h] = 'w'; }
        else if (rc.length >= 3) { f[h] = Math.round(medianRaw(rc)); m[h] = 'r'; }
      }
      if (Object.keys(f).length) {
        const name = (days.find(x => x.a.names[id]) || { a: { names: {} } }).a.names[id] || id;
        rides[id] = { n: name, f, m };
      }
    }
    const off = p.dest === 'disneyland' ? 3 : 0;
    out.parks[p.slug] = { name: p.name, dest: p.dest, clock: off ? 'America/Los_Angeles' : 'America/New_York', rides };
  }
  return out;
}

function loaderActuals(root) {
  const load = makeLoader(root, readRollup(root));
  return (p, d) => actualsFromSummary(p, d, load);
}

function buildForecastFromRoot(root, D, now) {
  return buildForecast(D, loaderActuals(root), now);
}

// Only while D is still in the future (ET), and only when at least one ride-hour has history.
function ensureForecast(root, D, today, now) {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(D) || D <= today) return { ok: false, reason: 'only future dates can be forecast' };
  const file = forecastPath(root, D);
  if (fs.existsSync(file)) return { ok: true, d: D, existed: true };
  const f = buildForecastFromRoot(root, D, now);
  const cells = cellCount(f);
  if (!cells) return { ok: false, reason: 'not enough logged history yet' };
  writeJson(file, f);
  return { ok: true, d: D, made: f.made, cells };
}

function scoreDay(root, D, now) {
  const fc = readJson(forecastPath(root, D));
  if (!fc || !fc.parks || !fc.made || etDay(fc.made) >= D) return null;
  const hrs = readJson(hoursPath(root, D));
  if (!hrs) return null;
  const actuals = loaderActuals(root);
  const items = [];
  const parks = {};
  for (const p of SCORED) {
    const fp = fc.parks[p.slug];
    if (!fp) continue;
    const wins = hrs.parks[p.slug];
    if (!wins) continue;
    const a = actuals(p, D);
    let cells = 0;
    const mine = [];
    for (const id of Object.keys(fp.rides || {})) {
      const ride = fp.rides[id];
      for (const h of Object.keys(ride.f || {})) {
        if (!inHours(wins, +h)) continue;
        cells++;
        const act = (a.hours[id] || {})[h];
        if (typeof act === 'number') mine.push({ park: p.slug, id, n: ride.n, h: +h, f: ride.f[h], a: act, m: (ride.m || {})[h] });
      }
    }
    items.push(...mine);
    parks[p.slug] = { name: p.name, dest: p.dest, ...agg(mine), cells };
  }
  if (!items.length) return null;
  const resorts = {};
  for (const [k, name] of RESORTS) {
    const s = agg(items.filter(x => (parks[x.park] || {}).dest === k));
    if (s.n) resorts[k] = { name, ...s };
  }
  const byRide = {};
  for (const x of items) (byRide[x.park + '|' + x.id] = byRide[x.park + '|' + x.id] || []).push(x);
  const rides = Object.values(byRide).map(group => {
    const s = agg(group);
    const worst = group.reduce((w, x) => (Math.abs(x.f - x.a) > Math.abs(w.f - w.a) ? x : w), group[0]);
    return {
      park: group[0].park, n: group[0].n, hours: s.n, mae: s.mae, bias: s.bias, pct: s.pct,
      avgA: r1(group.reduce((t, x) => t + x.a, 0) / group.length),
      worst: { h: worst.h, f: worst.f, a: worst.a },
    };
  });
  const miss = rides.filter(r => r.hours >= 3).sort((x, y) => y.mae - x.mae || Math.abs(y.worst.f - y.worst.a) - Math.abs(x.worst.f - x.worst.a))[0] || null;
  const best = (rides.filter(r => r.hours >= 6 && r.avgA >= 20).sort((x, y) => x.mae - y.mae || y.hours - x.hours)[0])
    || (rides.filter(r => r.hours >= 4 && r.avgA >= 15).sort((x, y) => x.mae - y.mae || y.hours - x.hours)[0]) || null;
  let weak = null;
  const cand = Object.entries(parks).filter(([, s]) => s.n >= 20).sort((x, y) => x[1].pct - y[1].pct);
  if (cand.length >= 2) {
    const [slug, s] = cand[0];
    const mine = items.filter(x => x.park === slug);
    const byH = {};
    mine.forEach(x => { (byH[x.h] = byH[x.h] || []).push(x); });
    const hrsRank = Object.entries(byH).filter(([, a]) => a.length >= 4).map(([h, a]) => ({ h: +h, ...agg(a) })).sort((x, y) => x.pct - y.pct);
    const missesBy = {};
    mine.filter(x => Math.abs(x.f - x.a) > 10).forEach(x => { missesBy[x.n] = (missesBy[x.n] || 0) + 1; });
    const topRide = Object.entries(missesBy).sort((x, y) => y[1] - x[1])[0];
    weak = {
      park: slug, name: s.name, pct: s.pct, n: s.n, bias: s.bias, mae: s.mae, misses: s.n - s.w10,
      worstHour: hrsRank[0] ? { h: hrsRank[0].h, pct: hrsRank[0].pct, n: hrsRank[0].n, bias: hrsRank[0].bias } : null,
      topRide: topRide ? { n: topRide[0], misses: topRide[1] } : null,
    };
  }
  const methods = { w: items.filter(x => x.m === 'w').length, r: items.filter(x => x.m === 'r').length };
  return {
    d: D, made: fc.made, scoredAt: now.toISOString(), overall: agg(items), resorts, parks, miss, best, weak, methods,
    cells: Object.values(parks).reduce((n, p) => n + (p.cells || 0), 0),
  };
}

function readIndex(root) {
  return readJson(indexPath(root)) || { days: [] };
}

function finalize(root, now) {
  const D = lastFinished(now);
  const idx = readIndex(root);
  const added = [];
  for (const d of [addDays(D, -2), addDays(D, -1), D]) {
    if (idx.days.some(x => x.d === d) || !fs.existsSync(forecastPath(root, d))) continue;
    const s = scoreDay(root, d, now);
    if (s) added.push(s);
  }
  if (!added.length) {
    if (!fs.existsSync(indexPath(root))) {
      idx.updated = now.toISOString();
      idx.method = METHOD;
      writeJson(indexPath(root), idx);
    }
    return { ok: idx.days.some(x => x.d === D), d: D, existed: idx.days.some(x => x.d === D), reason: 'nothing new to score', idx };
  }
  idx.days = idx.days.filter(x => !added.some(a => a.d === x.d)).concat(added).sort((a, b) => (a.d < b.d ? -1 : 1)).slice(-180);
  idx.updated = now.toISOString();
  idx.method = METHOD;
  writeJson(indexPath(root), idx);
  return { ok: true, d: D, scored: added.map(x => x.d), idx };
}

function summary(root, now) {
  const idx = readIndex(root);
  const today = etDate(now);
  const tomorrow = addDays(today, 1);
  const want = lastFinished(now);
  const latest = idx.days.length ? idx.days[idx.days.length - 1] : null;
  const locked = {
    today: fs.existsSync(forecastPath(root, today)),
    tomorrow: fs.existsSync(forecastPath(root, tomorrow)),
  };
  const firstScored = idx.days.length ? idx.days[0].d : locked.today ? today : tomorrow;
  return {
    updated: now.toISOString(),
    method: METHOD,
    today,
    lastFinished: want,
    scoringStarts: {
      forecastDay: firstScored,
      scoreAppears: addDays(firstScored, 1),
      forecastLocked: idx.days.length > 0 || locked.today || locked.tomorrow,
    },
    locked,
    latest,
    history: idx.days.map(x => ({
      d: x.d,
      n: x.overall.n,
      pct: x.overall.pct,
      mae: x.overall.mae,
      resorts: Object.fromEntries(Object.entries(x.resorts || {}).map(([k, v]) => [k, v.pct])),
    })),
  };
}

function writeSummary(root, now) {
  const sum = summary(root, now);
  writeJsonIfChanged(summaryPath(root), sum, ['updated']);
  return sum;
}

module.exports = {
  METHOD, HOURS_SOURCE, FORECAST_SOURCE,
  hoursPath, forecastPath, indexPath, summaryPath,
  localMin, inHours, windowsFor, hoursFromSchedules, ensureHours,
  agg, buildForecast, buildForecastFromRoot, ensureForecast, scoreDay, readIndex, finalize, summary, writeSummary,
};
