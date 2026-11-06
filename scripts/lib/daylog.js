const fs = require('fs');
const path = require('path');
const { PARKS } = require('./parks');
const { encodeStatus } = require('./compute');
const { toMin } = require('./time');
const { readJson, writeJson } = require('./io');

const MIN_GAP = 12;

function daysDir(root) { return path.join(root, 'waits', 'days'); }
function dayPath(root, d) { return path.join(daysDir(root), d + '.json'); }

function listDayDates(root) {
  const dir = daysDir(root);
  if (!fs.existsSync(dir)) return [];
  return fs.readdirSync(dir)
    .filter(n => /^\d{4}-\d{2}-\d{2}\.json$/.test(n))
    .map(n => n.slice(0, 10))
    .sort();
}

function readDay(root, d) {
  const f = readJson(dayPath(root, d));
  if (!f || !Array.isArray(f.t) || !f.t.length) return null;
  return f;
}

function blankDay(d) {
  return { d, tz: 'America/New_York', t: [], rides: {}, w: {} };
}

// One check across the parks that actually responded. Missing parks stay null for this index
// (unknown, not closed). Arrays stay aligned with t.
function appendSample(day, hhmm, parks) {
  const i = day.t.length;
  day.t.push(hhmm);
  const seen = new Set();
  for (const p of parks) {
    if (p.ok === false) continue;
    const rides = (p.rides || []).slice().sort((a, b) => String(a.n).localeCompare(String(b.n)));
    for (const r of rides) {
      if (!r.id || seen.has(r.id)) continue;
      seen.add(r.id);
      const name = String(r.n || r.id).replace(/\s+/g, ' ').trim();
      if (!day.rides[r.id]) day.rides[r.id] = [name, p.slug];
      else day.rides[r.id][0] = name;
      const v = Object.prototype.hasOwnProperty.call(r, 'v') ? r.v : encodeStatus(r.s, r.w);
      const arr = day.w[r.id] || (day.w[r.id] = []);
      while (arr.length < i) arr.push(null);
      arr.push(v);
    }
  }
  for (const id of Object.keys(day.w)) while (day.w[id].length < day.t.length) day.w[id].push(null);
  return day;
}

function shouldLog(day, hhmm, force) {
  if (!day || !day.t.length) return true;
  if (force) return true;
  const last = day.t[day.t.length - 1];
  return toMin(hhmm) - toMin(last) >= MIN_GAP;
}

function saveDay(root, day) {
  writeJson(dayPath(root, day.d), day);
}

// Convert a ThemeParks.wiki-shaped snapshot ({ parks:[{ slug, rides:[{id,n,s,w}] }] }) into one log row.
function dayFromSnapshot(snapshot, d, hhmm) {
  const bySlug = Object.fromEntries((snapshot.parks || []).map(p => [p.slug, p]));
  const parks = PARKS.map(p => {
    const src = bySlug[p.slug];
    if (!src) return { slug: p.slug, ok: false, rides: [] };
    return { slug: p.slug, ok: true, rides: src.rides || [] };
  });
  const day = blankDay(d);
  appendSample(day, hhmm, parks);
  return day;
}

module.exports = {
  MIN_GAP, daysDir, dayPath, listDayDates, readDay, blankDay, appendSample, shouldLog, saveDay, dayFromSnapshot,
};
