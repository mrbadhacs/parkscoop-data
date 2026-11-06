// ThemeParks.wiki fetches. Attractions only. A failed park is omitted from the sample, never filled in.
const { PARKS, SCORED } = require('./parks');

const HEADERS = { 'User-Agent': 'ParkScoop/1.0 (+https://parkscoop.com)', Accept: 'application/json' };

async function fetchJson(url) {
  let last;
  for (let i = 0; i < 3; i++) {
    try {
      const r = await fetch(url, { headers: HEADERS, signal: AbortSignal.timeout(20000) });
      if (!r.ok) throw new Error('HTTP ' + r.status);
      return await r.json();
    } catch (e) {
      last = e;
      await new Promise(res => setTimeout(res, 400 * (i + 1)));
    }
  }
  throw last;
}

async function parkLive(p) {
  try {
    const j = await fetchJson(`https://api.themeparks.wiki/v1/entity/${p.tp}/live`);
    const rides = (j.liveData || []).filter(x => x.entityType === 'ATTRACTION').map(x => {
      const q = x.queue || {};
      const w = q.STANDBY && typeof q.STANDBY.waitTime === 'number' ? q.STANDBY.waitTime : null;
      return { id: x.id, n: String(x.name || x.id).replace(/\s+/g, ' ').trim(), s: x.status || 'UNKNOWN', w };
    });
    return { slug: p.slug, name: p.name, dest: p.dest, ok: true, rides };
  } catch (e) {
    console.error('live', p.slug, e && e.message);
    return { slug: p.slug, name: p.name, dest: p.dest, ok: false, rides: [] };
  }
}

function allLive(list = PARKS) {
  return Promise.all(list.map(parkLive));
}

async function allSchedules(list = SCORED) {
  const pairs = await Promise.all(list.map(async p => {
    try {
      return [p.slug, await fetchJson(`https://api.themeparks.wiki/v1/entity/${p.tp}/schedule`)];
    } catch (e) {
      console.error('hours', p.slug, e && e.message);
      return [p.slug, null];
    }
  }));
  return Object.fromEntries(pairs);
}

module.exports = { fetchJson, parkLive, allLive, allSchedules };
