const ET = 'America/New_York';

function toMin(s) {
  const [h, m] = String(s).split(':').map(Number);
  return h * 60 + m;
}

function addDays(k, n) {
  const d = new Date(k + 'T12:00:00Z');
  d.setUTCDate(d.getUTCDate() + n);
  return d.toISOString().slice(0, 10);
}

function dow(k) {
  return new Date(k + 'T12:00:00Z').getUTCDay();
}

function etParts(date) {
  const fmt = new Intl.DateTimeFormat('en-CA', {
    timeZone: ET, year: 'numeric', month: '2-digit', day: '2-digit',
    hour: '2-digit', minute: '2-digit', hourCycle: 'h23',
  });
  const o = {};
  for (const p of fmt.formatToParts(date)) o[p.type] = p.value;
  let hour = o.hour;
  if (hour === '24') hour = '00';
  return { date: `${o.year}-${o.month}-${o.day}`, hhmm: `${hour}:${o.minute}` };
}

function etDate(date) { return etParts(date).date; }
function etHHMM(date) { return etParts(date).hhmm; }
function etDay(iso) { return etDate(new Date(iso)); }

// 7:30 AM through 2:30 AM ET (rope drop through a Disneyland midnight, which is 3:00 AM ET).
function inWindow(min) { return min >= 7 * 60 + 30 || min <= 2 * 60 + 30; }

// A park day is finished once the late Pacific close (as late as ~3:00 AM ET) has passed.
function lastFinished(now) {
  const parts = etParts(now);
  const lag = toMin(parts.hhmm) >= 3 * 60 + 30 ? -1 : -2;
  return addDays(parts.date, lag);
}

module.exports = { ET, toMin, addDays, dow, etParts, etDate, etHHMM, etDay, inWindow, lastFinished };
