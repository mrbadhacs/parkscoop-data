# ParkScoop wait times

Open log of posted standby waits for ten US theme parks. [ParkScoop](https://parkscoop.com) reads the JSON in this repository from `raw.githubusercontent.com`. No API key, no Vercel Blob, no paid scheduler.

This is an independent fan project. It is not affiliated with, endorsed by, or sponsored by The Walt Disney Company, Universal Destinations & Experiences, or Royal Caribbean Group. Ride names are the parks' own names, stored because that is what the wait feed reports. There are no park logos here.

Samples come from the free [ThemeParks.wiki](https://themeparks.wiki) API (`User-Agent: ParkScoop/1.0 (+https://parkscoop.com)`). Nothing in this repo is estimated, backfilled, or hand-edited. A missing day is a day the logger did not run.

## What gets published

| File | What it is |
| --- | --- |
| `waits/days/YYYY-MM-DD.json` | Raw Eastern-time checks for one calendar day |
| `waits/rollup.json` | Sealed per-day summaries plus lifetime totals |
| `waits/best.json` | Best Time to Ride, rolling 21 days |
| `waits/rel.json` | Ride reliability, last 7 days plus today |
| `waits/crowd.json` | Daily crowd gauge, rolling 21 days |
| `hours/YYYY-MM-DD.json` | Official OPERATING windows, written once |
| `forecasts/YYYY-MM-DD.json` | Hourly forecast locked the evening before, written once |
| `scores/index.json` | One score record per finished day |
| `scores/summary.json` | Scorecard payload for parkscoop.com/api/forecast |

ParkScoop overlays the live wait (`hourNow`, `live`, `liveStatus`, `hourUsual`, `vsUsual`) at request time. Those fields are not stored here.

## Parks

Magic Kingdom, EPCOT, Hollywood Studios, Animal Kingdom, Universal Studios Florida, Islands of Adventure, Epic Universe, Volcano Bay, Disneyland Park, and Disney California Adventure.

Volcano Bay is logged and included in reliability and crowd history. Best Time to Ride and the forecast scorecard skip it.

## Logger

GitHub Actions runs `.github/workflows/log-waits.yml` on this public repository. Each job samples, commits, and sleeps until the next 15-minute mark, then repeats for about 5 hours 45 minutes so it stays under the 6-hour job limit. A cron at minute 7 of every third hour (`7 */3 * * *`) starts another job only if the previous one has stopped. The `log-waits` concurrency group, with `cancel-in-progress: false`, keeps a single job in progress and lets the next one wait.

- Window: 7:30 AM through 2:30 AM America/New_York (`minute >= 450 || minute <= 150`). That covers East Coast rope drop through a Disneyland midnight, which is 3:00 AM Eastern.
- A sample is skipped when the previous check in today's file is less than 12 minutes old.
- `workflow_dispatch` inputs `force` and `rebuild` bypass that gate on the first pass of the run and rebuild the rollup. Later passes in that job use the normal window and gap.
- Each value is the posted standby wait while `OPERATING` (or `null` if none was posted), `-1` when the ride is `DOWN`, and `-2` for `CLOSED`, `REFURBISHMENT`, and every other status.

Days are sealed into `waits/rollup.json` only once `D < today - 1`. That extra day lets a Pacific late night (midnight to 2:59 AM Eastern on `D+1`, which is 9:00 PM to 11:59 PM Pacific on `D`) land in the file before day `D` is frozen. After that, a routine run reads the rollup plus the last two or three raw day files. It does not reread the archive.

Best Time to Ride buckets Disneyland Resort samples on Pacific clock hours (Eastern minus 3 hours). Reliability and crowd history stay on the Eastern log date. The forecast uses the same park-local hours, and it only grades clock hours that sit entirely inside the official OPERATING window. Early Entry and other ticketed events are not graded.

The forecast for a date is written only while that date is still in the future, and only at or after 8:00 PM Eastern, and only when at least one ride-hour has enough history (same weekday across 28 days with 2 or more days, otherwise the last 7 days with 3 or more). Hours files and forecasts are never overwritten. A day is scored only when its forecast was saved before that Eastern date began.

## Git history

The workflow keeps one commit per Eastern date. The message is `data: YYYY-MM-DD (HH:MM ET)`. If the tip of `main` is already that date's data commit and it has a parent, the run amends it and pushes with `--force-with-lease`. Before each commit it fetches `main`. When the remote only moved forward it fast-forwards with `git pull --rebase` (the sample is autostashed). When the tip was rewritten by an amend, it checks out that fetched tip and keeps the uncommitted sample, so the lease is the current remote SHA. The next date starts a new commit. History stays near 365 commits a year.

## Run it

Node 20 or newer. No install step.

```bash
node scripts/run.js
node scripts/run.js --force
node scripts/run.js --rebuild
node --test
```

`--force` logs outside the window and inside the 12-minute gap. `--rebuild` reseals `waits/rollup.json` from `waits/days/*.json` and rewrites the views. Both paths produce the same views.
