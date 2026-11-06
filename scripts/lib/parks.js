// Tracked parks. Slugs, short ids, and ThemeParks.wiki UUIDs are the ParkScoop contract.
const PARKS = [
  { slug: 'magic-kingdom', hid: 'mk', name: 'Magic Kingdom', dest: 'disney-world', tp: '75ea578a-adc8-4116-a54d-dccb60765ef9' },
  { slug: 'epcot', hid: 'epcot', name: 'EPCOT', dest: 'disney-world', tp: '47f90d2c-e191-4239-a466-5892ef59a88b' },
  { slug: 'hollywood-studios', hid: 'hs', name: 'Hollywood Studios', dest: 'disney-world', tp: '288747d1-8b4f-4a64-867e-ea7c9b27bad8' },
  { slug: 'animal-kingdom', hid: 'ak', name: 'Animal Kingdom', dest: 'disney-world', tp: '1c84a229-8862-4648-9c71-378ddd2c7693' },
  { slug: 'universal-studios-florida', hid: 'usf', name: 'Universal Studios Florida', dest: 'universal', tp: 'eb3f4560-2383-4a36-9152-6b3e5ed6bc57' },
  { slug: 'islands-of-adventure', hid: 'ioa', name: 'Islands of Adventure', dest: 'universal', tp: '267615cc-8943-4c2a-ae2c-5da728ca591f' },
  { slug: 'epic-universe', hid: 'epic', name: 'Epic Universe', dest: 'universal', tp: '12dbb85b-265f-44e6-bccf-f1faa17211fc' },
  { slug: 'volcano-bay', hid: 'vb', name: 'Volcano Bay', dest: 'universal', tp: 'fe78a026-b91b-470c-b906-9d2266b692da' },
  { slug: 'disneyland', hid: 'dl', name: 'Disneyland Park', dest: 'disneyland', tp: '7340550b-c14d-4def-80bb-acdb51d49a66' },
  { slug: 'california-adventure', hid: 'dca', name: 'Disney California Adventure', dest: 'disneyland', tp: '832fcd51-ea19-4e77-85c7-75d5843b127c' },
];

const BY_SLUG = Object.fromEntries(PARKS.map(p => [p.slug, p]));
// Best Time, forecast, and the scorecard skip Volcano Bay (water-park waits). Reliability and crowd still include it.
const SCORED = PARKS.filter(p => p.slug !== 'volcano-bay');
const RESORTS = [['disney-world', 'Walt Disney World'], ['universal', 'Universal Orlando'], ['disneyland', 'Disneyland Resort']];

function parkBySlug(slug) { return BY_SLUG[slug] || null; }
// Disneyland Resort clock hours are Pacific, three hours behind the Eastern log.
function offHours(slugOrPark) {
  const p = typeof slugOrPark === 'string' ? BY_SLUG[slugOrPark] : slugOrPark;
  return p && p.dest === 'disneyland' ? 3 : 0;
}
function parkTz(slugOrPark) {
  const p = typeof slugOrPark === 'string' ? BY_SLUG[slugOrPark] : slugOrPark;
  return p && p.dest === 'disneyland' ? 'America/Los_Angeles' : 'America/New_York';
}

module.exports = { PARKS, BY_SLUG, SCORED, RESORTS, parkBySlug, offHours, parkTz };
