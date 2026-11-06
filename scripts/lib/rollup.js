const path = require('path');
const { addDays } = require('./time');
const { readJson, writeJsonIfChanged } = require('./io');
const { listDayDates, readDay } = require('./daylog');
const { summarizeDay, bestFromSummaries, reliabilityFromSummaries, crowdFromSummaries } = require('./compute');

function rollupPath(root) { return path.join(root, 'waits', 'rollup.json'); }

function emptyRollup(updated) {
  return { version: 1, updated, allTime: { checks: 0, first: null, days: 0 }, days: {} };
}

function readRollup(root) {
  const r = readJson(rollupPath(root));
  if (!r || !r.days) return null;
  return r;
}

// Days strictly before yesterday stay sealed. Yesterday stays raw so a Pacific late night
// (00:00–02:59 ET on D+1, which is 21:00–23:59 PT on D) is in the file before D is sealed.
function sealBefore(today) { return addDays(today, -1); }

function recomputeAllTime(root, rollup) {
  const dates = listDayDates(root);
  let checks = 0;
  let first = null;
  for (const d of dates) {
    if (!first || d < first) first = d;
    if (rollup.days[d]) checks += rollup.days[d].n;
    else {
      const f = readDay(root, d);
      checks += f ? f.t.length : 0;
    }
  }
  rollup.allTime = { checks, first, days: dates.length };
}

function sorted(rollup) {
  const days = {};
  for (const d of Object.keys(rollup.days).sort()) days[d] = rollup.days[d];
  rollup.days = days;
  return rollup;
}

function writeRollup(root, rollup) {
  writeJsonIfChanged(rollupPath(root), sorted(rollup), ['updated']);
  return rollup;
}

// Seal any ET day that is now old enough and not yet in the rollup. Existing sealed days are never rewritten.
function incrementalSeal(root, today, updated) {
  const rollup = readRollup(root) || emptyRollup(updated);
  rollup.updated = updated;
  const before = sealBefore(today);
  for (const d of listDayDates(root)) {
    if (d < before && !rollup.days[d]) {
      const f = readDay(root, d);
      if (f) rollup.days[d] = summarizeDay(f);
    }
  }
  recomputeAllTime(root, rollup);
  return writeRollup(root, rollup);
}

function rebuildRollup(root, today, updated) {
  const rollup = emptyRollup(updated);
  const before = sealBefore(today);
  for (const d of listDayDates(root)) {
    if (d < before) {
      const f = readDay(root, d);
      if (f) rollup.days[d] = summarizeDay(f);
    }
  }
  recomputeAllTime(root, rollup);
  return writeRollup(root, rollup);
}

// Summaries for sealed days come from the rollup. Newer days are summarized in memory from the two or three raw files.
function makeLoader(root, rollup) {
  const cache = new Map();
  return function loadSummary(d) {
    if (cache.has(d)) return cache.get(d);
    let s = null;
    if (rollup && rollup.days && rollup.days[d]) {
      // Sealed days are complete. Do not reopen the raw file.
      s = rollup.days[d];
    } else {
      const f = readDay(root, d);
      if (f) {
        s = summarizeDay(f);
        s.raw = f;
      }
    }
    cache.set(d, s);
    return s;
  };
}

function buildViews(root, today, updated, rollup) {
  const r = rollup || readRollup(root) || emptyRollup(updated);
  const load = makeLoader(root, r);
  return {
    best: bestFromSummaries(load, today, updated),
    rel: reliabilityFromSummaries(load, today, updated),
    crowd: crowdFromSummaries(load, today, updated),
  };
}

function writeViews(root, views) {
  const wrote = {};
  wrote.best = writeJsonIfChanged(path.join(root, 'waits', 'best.json'), views.best, ['updated']);
  wrote.rel = writeJsonIfChanged(path.join(root, 'waits', 'rel.json'), views.rel, ['updated']);
  wrote.crowd = writeJsonIfChanged(path.join(root, 'waits', 'crowd.json'), views.crowd, ['updated']);
  return wrote;
}

module.exports = {
  rollupPath, emptyRollup, readRollup, sealBefore, incrementalSeal, rebuildRollup, makeLoader, buildViews, writeViews,
};
