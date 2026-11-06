// Pure view math ported from ParkScoop api/_besttime.js, api/_reliability.js, api/_crowd.js, and api/_forecast.js.
// Every sample is an encoded log value: number >= 0 operating posted wait, null = operating with no standby,
// -1 = DOWN, -2 = CLOSED / REFURBISHMENT / anything else. Nothing here invents a sample.
const { PARKS, SCORED, offHours, parkTz } = require('./parks');
const { toMin, addDays } = require('./time');

const BEST_DAYS = 21;
const MIN_DAY_HOURS = 3;
const MIN_CHECKS = 6;
const REL_DAYS = 7;
const GAP = 31;
const CROWD_DAYS = 21;
const CROWD_MIN = 3;

const BEST_SOURCE = 'ParkScoop wait log (ThemeParks.wiki posted standby waits, logged every 15 minutes during park hours; posted waits, not true walk time). Disneyland Resort hours are Pacific.';
const BEST_METHOD = `per clock-hour median of operating posted waits; hour shown when ≥${MIN_DAY_HOURS} distinct days or ≥${MIN_CHECKS} checks; bestHour = lowest qualifying median; usual = overall median; vsUsual = live − this hour's median`;
const BEST_TZ = 'Log timestamps are America/New_York; Disneyland Resort buckets use America/Los_Angeles (ET−3).';
const REL_SOURCE = 'ParkScoop wait log (ThemeParks.wiki live ride status, logged every 15 minutes, 7:30 AM-2:30 AM ET; actual check counts included)';
const CROWD_SOURCE = 'ParkScoop wait log (ThemeParks.wiki standby waits)';

function medianRound(xs) {
  if (!xs.length) return null;
  const s = [...xs].sort((a, b) => a - b);
  const h = s.length >> 1;
  return s.length % 2 ? s[h] : Math.round((s[h - 1] + s[h]) / 2);
}

// Unrounded middle-of-two, matching api/_forecast.js. Callers Math.round the result.
function medianRaw(a) {
  const s = a.slice().sort((x, y) => x - y);
  const m = s.length >> 1;
  return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2;
}

function encodeStatus(status, wait) {
  const s = status || 'UNKNOWN';
  if (s === 'OPERATING') return typeof wait === 'number' ? wait : null;
  if (s === 'DOWN') return -1;
  return -2;
}

// Map an Eastern log clock time onto the park-local date and hour.
// Pacific = ET − 3, so 00:00–02:59 ET belongs to the previous Pacific date (minutes 21:00–23:59).
function parkLocal(etDate, hhmm, off) {
  let m = toMin(hhmm) - off * 60;
  let date = etDate;
  if (m < 0) {
    m += 1440;
    date = addDays(etDate, -1);
  } else if (m >= 1440) {
    m -= 1440;
    date = addDays(etDate, 1);
  }
  return { date, hour: Math.floor(m / 60) };
}

function outages(t, arr) {
  const out = [];
  let i = 0;
  while (i < arr.length) {
    if (arr[i] !== -1) { i++; continue; }
    const a = i;
    let tight = true;
    while (i < arr.length && arr[i] === -1) {
      if (i > a && toMin(t[i]) - toMin(t[i - 1]) > GAP) tight = false;
      i++;
    }
    const open = i >= arr.length;
    if (!open && toMin(t[i]) - toMin(t[i - 1]) > GAP) tight = false;
    // Duration runs from the first DOWN check to the next check that is not DOWN.
    out.push({ a: t[a], m: !open && tight ? Math.max(1, toMin(t[i]) - toMin(t[a])) : null, open });
  }
  return out;
}

function scanRide(t, arr) {
  let u = 0;
  let d = 0;
  for (const v of arr) {
    if (typeof v !== 'number') continue;
    if (v >= 0) u++;
    else if (v === -1) d++;
  }
  // Never seen running: treat the day as closed. Downs do not count against the ride.
  const outs = u ? outages(t, arr) : [];
  return { up: u, dn: d, outs };
}

function emptyRel(id, n, p) {
  return { id, n, p, up: 0, dn: 0, ev: 0, mins: [], longest: null, days: 0, downDays: 0 };
}

function applyRelDay(r, rec, day, isToday, t, arr) {
  const os = rec.outs;
  if (rec.up) { r.days++; r.up += rec.up; r.dn += rec.dn; }
  if (os.length) r.downDays++;
  r.ev += os.length;
  for (const o of os) {
    if (o.open || o.m == null) continue;
    r.mins.push(o.m);
    if (!r.longest || o.m > r.longest.m) r.longest = { m: o.m, d: day, a: o.a };
  }
  if (isToday && arr) {
    r.tl = arr.map(v => v == null ? '.' : v >= 0 ? 'u' : v === -1 ? 'd' : 'c').join('');
    const lastV = arr.length ? arr[arr.length - 1] : null;
    if (lastV === -1) {
      let k = arr.length - 1;
      while (k > 0 && arr[k - 1] === -1) k--;
      r.since = t[k];
    }
    r.todayEv = os.length;
    r.todayDownMin = os.every(o => o.m != null) ? os.reduce((s, o) => s + o.m, 0) : null;
  }
}

function relRecord(id, meta, t, arr) {
  const rec = scanRide(t, arr);
  return { n: meta[0], p: meta[1], up: rec.up, dn: rec.dn, outs: rec.outs };
}

function finishRel(R, today, todayT, logged, first, last, updated) {
  const parks = {};
  for (const p of PARKS) parks[p.slug] = [];
  for (const id of Object.keys(R)) {
    const r = R[id];
    if (!parks[r.p]) continue;
    if (r.up + r.dn === 0 && !r.tl) continue;
    const row = {
      id: r.id, n: r.n, up: r.up, dn: r.dn, ev: r.ev, med: medianRound(r.mins), long: r.longest,
      days: r.days, downDays: r.downDays,
    };
    if (r.tl) {
      row.tl = r.tl;
      row.todayEv = r.todayEv;
      row.todayDownMin = r.todayDownMin;
    }
    if (r.since) row.since = r.since;
    parks[r.p].push(row);
  }
  for (const s of Object.keys(parks)) parks[s].sort((a, b) => a.n.localeCompare(b.n));
  return {
    updated,
    source: REL_SOURCE,
    tz: 'America/New_York',
    interval: 15,
    gap: GAP,
    checks: logged.reduce((n, x) => n + x.n, 0),
    days: logged,
    window: first ? { first, last } : null,
    todayDate: today,
    todayT: todayT || [],
    parks,
  };
}

function reliabilityFromFiles(filesByDay, today, updated) {
  const days = [];
  for (let n = REL_DAYS; n >= 0; n--) days.push(addDays(today, -n));
  const R = {};
  const logged = [];
  let first = null;
  let last = null;
  let todayT = [];
  days.forEach(day => {
    const f = filesByDay[day];
    if (!f || !Array.isArray(f.t) || !f.t.length) return;
    const isToday = day === today;
    logged.push({ d: day, n: f.t.length });
    if (!first || toMin(f.t[0]) < toMin(first)) first = f.t[0];
    if (!last || toMin(f.t[f.t.length - 1]) > toMin(last)) last = f.t[f.t.length - 1];
    if (isToday) todayT = f.t;
    for (const id of Object.keys(f.w)) {
      const meta = f.rides[id];
      if (!meta) continue;
      const arr = f.w[id];
      const rec = relRecord(id, meta, f.t, arr);
      const r = R[id] || (R[id] = emptyRel(id, meta[0], meta[1]));
      r.n = meta[0];
      applyRelDay(r, rec, day, isToday, f.t, arr);
    }
  });
  return finishRel(R, today, todayT, logged, first, last, updated);
}

function reliabilityFromSummaries(loadSummary, today, updated) {
  const days = [];
  for (let n = REL_DAYS; n >= 0; n--) days.push(addDays(today, -n));
  const R = {};
  const logged = [];
  let first = null;
  let last = null;
  let todayT = [];
  for (const day of days) {
    const isToday = day === today;
    const sum = loadSummary(day);
    if (!sum || !sum.n) continue;
    logged.push({ d: day, n: sum.n });
    if (sum.t0 && (!first || toMin(sum.t0) < toMin(first))) first = sum.t0;
    if (sum.t1 && (!last || toMin(sum.t1) > toMin(last))) last = sum.t1;
    const raw = isToday ? sum.raw : null;
    if (isToday && raw) todayT = raw.t;
    const rel = sum.rel || {};
    // Today prefers the raw series so the timeline matches a direct file read.
    if (isToday && raw) {
      for (const id of Object.keys(raw.w || {})) {
        const meta = raw.rides[id];
        if (!meta) continue;
        const rec = relRecord(id, meta, raw.t, raw.w[id]);
        const r = R[id] || (R[id] = emptyRel(id, meta[0], meta[1]));
        r.n = meta[0];
        applyRelDay(r, rec, day, true, raw.t, raw.w[id]);
      }
      continue;
    }
    for (const id of Object.keys(rel)) {
      const rec = rel[id];
      const r = R[id] || (R[id] = emptyRel(id, rec.n, rec.p));
      r.n = rec.n;
      applyRelDay(r, rec, day, false, null, null);
    }
    if (sum.nm) {
      for (const id of Object.keys(sum.nm)) if (R[id]) R[id].n = sum.nm[id];
    }
  }
  return finishRel(R, today, todayT, logged, first, last, updated);
}

function summarizeCrowd(f) {
  const out = {};
  for (const p of PARKS) {
    const ids = Object.keys(f.rides).filter(id => f.rides[id][1] === p.slug);
    let sum = 0;
    let k = 0;
    for (let i = 0; i < f.t.length; i++) {
      let s = 0;
      let c = 0;
      for (const id of ids) {
        const v = (f.w[id] || [])[i];
        if (typeof v === 'number' && v >= 0) { s += v; c++; }
      }
      if (c >= CROWD_MIN) { sum += s / c; k++; }
    }
    if (k) out[p.slug] = { avg: Math.round(sum / k), k };
  }
  return out;
}

function crowdFromFiles(filesByDay, today, updated) {
  const days = [];
  for (let i = CROWD_DAYS - 1; i >= 0; i--) {
    const d = addDays(today, -i);
    const f = filesByDay[d];
    if (f && Array.isArray(f.t) && f.t.length) days.push({ d, checks: f.t.length, parks: summarizeCrowd(f) });
  }
  return { updated, source: CROWD_SOURCE, days };
}

function crowdFromSummaries(loadSummary, today, updated) {
  const days = [];
  for (let i = CROWD_DAYS - 1; i >= 0; i--) {
    const d = addDays(today, -i);
    const s = loadSummary(d);
    if (s && s.n) days.push({ d, checks: s.n, parks: s.crowd || {} });
  }
  return { updated, source: CROWD_SOURCE, days };
}

function accumulateBest(R, p, localDate, id, name, hour, value) {
  const r = R[id] || (R[id] = { id, n: name, p: p.slug, all: [], hours: {} });
  r.n = name;
  r.all.push(value);
  const bucket = r.hours[hour] || (r.hours[hour] = { vals: [], days: new Set() });
  bucket.vals.push(value);
  bucket.days.add(localDate);
}

function bestBody(R, logged, checks, first, last) {
  const parks = {};
  for (const p of SCORED) {
    const rides = [];
    for (const id of Object.keys(R)) {
      const r = R[id];
      if (r.p !== p.slug) continue;
      const hours = [];
      let bestHour = null;
      let bestMed = null;
      for (let h = 0; h < 24; h++) {
        const b = r.hours[h];
        if (!b || !b.vals.length) continue;
        const dayN = b.days.size;
        const n = b.vals.length;
        const enough = dayN >= MIN_DAY_HOURS || n >= MIN_CHECKS;
        const med = medianRound(b.vals);
        hours.push({ h, m: enough ? med : null, n, d: dayN, ok: enough });
        if (!enough) continue;
        if (bestMed == null || med < bestMed || (med === bestMed && (bestHour == null || h < bestHour))) {
          bestMed = med;
          bestHour = h;
        }
      }
      if (!r.all.length && !hours.length) continue;
      rides.push({
        id: r.id, n: r.n, usual: medianRound(r.all), bestHour, bestMedian: bestMed, hours, samples: r.all.length,
      });
    }
    rides.sort((a, b) => a.n.localeCompare(b.n));
    parks[p.slug] = { name: p.name, dest: p.dest, hid: p.hid, tz: parkTz(p), rides };
  }
  return {
    checks,
    days: logged,
    window: first && last ? { first, last } : null,
    parks,
  };
}

function bestEnvelope(body, updated) {
  return {
    updated,
    source: BEST_SOURCE,
    method: BEST_METHOD,
    tzNote: BEST_TZ,
    minDayHours: MIN_DAY_HOURS,
    minChecks: MIN_CHECKS,
    checks: body.checks,
    days: body.days,
    window: body.window,
    parks: body.parks,
  };
}

function bestFromFiles(filesByDay, today, updated) {
  const days = [];
  for (let n = BEST_DAYS - 1; n >= 0; n--) days.push(addDays(today, -n));
  const logged = [];
  let checks = 0;
  let first = null;
  let last = null;
  for (const d of days) {
    const f = filesByDay[d];
    if (!f || !f.t || !f.t.length) continue;
    logged.push({ d, n: f.t.length });
    checks += f.t.length;
    if (!first) first = d;
    last = d;
  }
  const R = {};
  for (const p of SCORED) {
    const off = offHours(p);
    for (const d of days) {
      const files = off ? [filesByDay[d], filesByDay[addDays(d, 1)]] : [filesByDay[d]];
      files.forEach((f, fi) => {
        if (!f) return;
        for (const id of Object.keys(f.rides || {})) {
          if (f.rides[id][1] !== p.slug) continue;
          const arr = f.w[id] || [];
          const name = f.rides[id][0];
          // Touch the name even when this file contributes no in-range operating sample.
          if (!R[id]) R[id] = { id, n: name, p: p.slug, all: [], hours: {} };
          R[id].n = name;
          f.t.forEach((t, i) => {
            const m = toMin(t) - off * 60 + fi * 1440;
            if (m < 0 || m >= 1440) return;
            const v = arr[i];
            if (typeof v !== 'number' || v < 0) return;
            accumulateBest(R, p, d, id, name, Math.floor(m / 60), v);
          });
        }
      });
    }
  }
  return bestEnvelope(bestBody(R, logged, checks, first, last), updated);
}

// `loadSummary(etDate)` returns a day summary (sealed or freshly built). Summaries carry
// operating samples already bucketed by park-local date, so this never opens older day files.
function bestFromSummaries(loadSummary, today, updated) {
  const days = [];
  for (let n = BEST_DAYS - 1; n >= 0; n--) days.push(addDays(today, -n));
  const extra = addDays(today, 1);
  const logged = [];
  let checks = 0;
  let first = null;
  let last = null;
  const sums = new Map();
  const need = new Set(days);
  need.add(extra);
  for (const d of need) {
    const s = loadSummary(d);
    if (s) sums.set(d, s);
  }
  for (const d of days) {
    const s = sums.get(d);
    if (!s || !s.n) continue;
    logged.push({ d, n: s.n });
    checks += s.n;
    if (!first) first = d;
    last = d;
  }
  const R = {};
  // Oldest Eastern file first. The next ET date is included so Pacific 21:00–23:59 (00:00–02:59 ET) lands on the previous park-local date.
  const etOrder = [];
  for (let n = BEST_DAYS - 1; n >= -1; n--) etOrder.push(addDays(today, -n));
  const daySet = new Set(days);
  for (const et of etOrder) {
    const s = sums.get(et);
    if (!s || !s.ops) continue;
    for (const id of Object.keys(s.ops)) {
      const o = s.ops[id];
      if (!SCORED.some(p => p.slug === o.p) || !o.b) continue;
      for (const localDate of Object.keys(o.b)) {
        if (!daySet.has(localDate)) continue;
        const hours = o.b[localDate];
        for (const h of Object.keys(hours)) {
          for (const v of hours[h]) {
            const p = SCORED.find(x => x.slug === o.p);
            accumulateBest(R, p, localDate, id, o.n, +h, v);
          }
        }
      }
    }
  }
  for (const et of etOrder) {
    const s = sums.get(et);
    if (!s || !s.nm) continue;
    for (const id of Object.keys(s.nm)) if (R[id]) R[id].n = s.nm[id];
  }
  return bestEnvelope(bestBody(R, logged, checks, first, last), updated);
}

// Compact per-ET-day record. Crowd, reliability, and park-local hour samples are sealed from this alone.
function summarizeDay(f) {
  const rel = {};
  const ops = {};
  for (const id of Object.keys(f.rides || {})) {
    const meta = f.rides[id];
    const arr = f.w[id] || [];
    const rec = scanRide(f.t, arr);
    if (rec.up > 0) rel[id] = { n: meta[0], p: meta[1], up: rec.up, dn: rec.dn, outs: rec.outs };
    const off = offHours(meta[1]);
    const b = {};
    f.t.forEach((t, i) => {
      const v = arr[i];
      if (typeof v !== 'number' || v < 0) return;
      const loc = parkLocal(f.d, t, off);
      const row = b[loc.date] || (b[loc.date] = {});
      (row[loc.hour] || (row[loc.hour] = [])).push(v);
    });
    if (Object.keys(b).length) ops[id] = { n: meta[0], p: meta[1], b };
  }
  // Names for every ride seen that day, including ones that never posted a wait.
  // A later DOWN-only day can still rename a ride the views already track.
  const nm = {};
  for (const id of Object.keys(f.rides || {})) nm[id] = f.rides[id][0];
  return {
    d: f.d,
    n: f.t.length,
    t0: f.t[0] || null,
    t1: f.t[f.t.length - 1] || null,
    crowd: summarizeCrowd(f),
    rel,
    ops,
    nm,
  };
}

// Hourly actuals for one park on park-local date D: { names, hours:{id:{h: rounded mean}} }.
function actualsFromFiles(p, D, readFile) {
  const off = offHours(p);
  const files = off ? [readFile(D), readFile(addDays(D, 1))] : [readFile(D)];
  const acc = {};
  const names = {};
  files.forEach((f, fi) => {
    if (!f) return;
    const ids = Object.keys(f.rides).filter(id => f.rides[id][1] === p.slug);
    f.t.forEach((t, i) => {
      const m = toMin(t) - off * 60 + fi * 1440;
      if (m < 0 || m >= 1440) return;
      const h = Math.floor(m / 60);
      for (const id of ids) {
        const v = (f.w[id] || [])[i];
        if (typeof v !== 'number' || v < 0) continue;
        names[id] = f.rides[id][0];
        ((acc[id] = acc[id] || {})[h] = acc[id][h] || []).push(v);
      }
    });
  });
  const hours = {};
  for (const id of Object.keys(acc)) {
    for (const h of Object.keys(acc[id])) {
      const a = acc[id][h];
      (hours[id] = hours[id] || {})[h] = Math.round(a.reduce((s, x) => s + x, 0) / a.length);
    }
  }
  return { names, hours };
}

function actualsFromSummary(p, D, load) {
  const off = offHours(p);
  const etDates = off ? [D, addDays(D, 1)] : [D];
  const acc = {};
  const names = {};
  for (const et of etDates) {
    const sum = load(et);
    if (!sum || !sum.ops) continue;
    for (const id of Object.keys(sum.ops)) {
      const o = sum.ops[id];
      if (o.p !== p.slug || !o.b || !o.b[D]) continue;
      const hours = o.b[D];
      for (const h of Object.keys(hours)) {
        const vals = hours[h];
        if (!vals || !vals.length) continue;
        names[id] = o.n;
        (acc[id] = acc[id] || {})[h] = Math.round(vals.reduce((s, x) => s + x, 0) / vals.length);
      }
    }
  }
  return { names, hours: acc };
}

module.exports = {
  BEST_DAYS, MIN_DAY_HOURS, MIN_CHECKS, REL_DAYS, GAP, CROWD_DAYS,
  BEST_SOURCE, BEST_METHOD, BEST_TZ, REL_SOURCE, CROWD_SOURCE,
  medianRound, medianRaw, encodeStatus, parkLocal, outages, scanRide,
  summarizeDay, summarizeCrowd,
  reliabilityFromFiles, reliabilityFromSummaries,
  crowdFromFiles, crowdFromSummaries,
  bestFromFiles, bestFromSummaries,
  actualsFromFiles, actualsFromSummary,
};
