#!/usr/bin/env node
// One pass: optional live sample, seal finished days into the rollup, write precomputed views,
// snapshot official hours, lock tomorrow's forecast after 8:00 PM ET, score finished days.
const fs = require('fs');
const path = require('path');
const { etParts, etDate, toMin, inWindow, addDays } = require('./lib/time');
const { readDay, blankDay, appendSample, shouldLog, saveDay } = require('./lib/daylog');
const { incrementalSeal, rebuildRollup, buildViews, writeViews } = require('./lib/rollup');
const { hoursPath, ensureHours, ensureForecast, finalize, writeSummary } = require('./lib/forecast');
const { allLive, allSchedules } = require('./lib/live');

function parseArgs(argv) {
  const o = { force: false, rebuild: false, noFetch: false, now: null, root: null };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--force') o.force = true;
    else if (a === '--rebuild') o.rebuild = true;
    else if (a === '--no-fetch') o.noFetch = true;
    else if (a === '--now') o.now = argv[++i];
    else if (a === '--root') o.root = argv[++i];
    else throw new Error('Unknown argument ' + a);
  }
  return o;
}

async function run(opts = {}) {
  const root = path.resolve(opts.root || path.join(__dirname, '..'));
  const now = opts.now ? new Date(opts.now) : new Date();
  if (Number.isNaN(now.getTime())) throw new Error('Invalid --now');
  const updated = now.toISOString();
  const parts = etParts(now);
  const today = parts.date;
  const hhmm = parts.hhmm;
  const nowMin = toMin(hhmm);
  for (const dir of ['waits/days', 'waits', 'hours', 'forecasts', 'scores']) {
    fs.mkdirSync(path.join(root, dir), { recursive: true });
  }

  let logged = null;
  let fetchFailed = false;
  if (!opts.noFetch && (opts.force || inWindow(nowMin))) {
    const existing = readDay(root, today);
    const day = existing || blankDay(today);
    if (shouldLog(existing, hhmm, opts.force)) {
      const parks = await allLive();
      const ok = parks.filter(p => p.ok && p.rides && p.rides.length);
      if (!ok.length) {
        fetchFailed = true;
        console.error('live fetch returned no parks');
      } else {
        appendSample(day, hhmm, parks);
        saveDay(root, day);
        logged = { t: hhmm, rides: ok.reduce((n, p) => n + p.rides.length, 0), parks: ok.length };
        const failed = parks.filter(p => !p.ok).map(p => p.slug);
        if (failed.length) console.error('live fetch missed:', failed.join(', '));
      }
    } else {
      logged = { skipped: 'recent', t: hhmm };
    }
  } else if (!opts.noFetch) {
    logged = { skipped: 'overnight', t: hhmm };
  }

  const rollup = opts.rebuild ? rebuildRollup(root, today, updated) : incrementalSeal(root, today, updated);
  const views = buildViews(root, today, updated, rollup);
  writeViews(root, views);

  let hours = null;
  if (!opts.noFetch) {
    const tomorrow = addDays(today, 1);
    if (!fs.existsSync(hoursPath(root, today)) || !fs.existsSync(hoursPath(root, tomorrow))) {
      const schedules = await allSchedules();
      hours = {
        today: ensureHours(root, today, schedules, updated),
        tomorrow: ensureHours(root, tomorrow, schedules, updated),
      };
    }
    if (nowMin >= 20 * 60) {
      const locked = ensureForecast(root, addDays(today, 1), today, now);
      if (!locked.ok && locked.reason && locked.reason !== 'only future dates can be forecast') {
        console.error('forecast', locked.reason);
      }
    }
  }

  const fin = finalize(root, now);
  const sum = writeSummary(root, now);
  const report = {
    today,
    t: hhmm,
    logged,
    sealed: Object.keys(rollup.days).length,
    allTime: rollup.allTime,
    hours,
    lastFinished: sum.lastFinished,
    locked: sum.locked,
    scored: fin.scored || [],
  };
  console.log(JSON.stringify(report));
  return fetchFailed ? 1 : 0;
}

module.exports = { run, parseArgs };

if (require.main === module) {
  run(parseArgs(process.argv.slice(2))).then(code => {
    if (code) process.exitCode = code;
  }).catch(e => {
    console.error(e && e.stack || e);
    process.exit(1);
  });
}
