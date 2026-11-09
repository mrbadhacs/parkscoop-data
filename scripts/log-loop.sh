#!/usr/bin/env bash
# Sample, commit one Eastern-time day, then sleep until the next interval
# boundary. One Actions job repeats this until LOG_BUDGET_SECONDS (default
# 5h45m) so logging does not depend on GitHub firing a cron every 15 minutes.
#
# LOG_INTERVAL_SECONDS  boundary length; 900 aligns to :00/:15/:30/:45
# LOG_BUDGET_SECONDS    stop before this much wall time (default 20700 = 5h45m)
# LOG_FORCE / LOG_REBUILD   "1" applies --force / --rebuild on the first pass
# LOG_SAMPLE_CMD        override the sampler (tests only)
# LOG_REMOTE / LOG_BRANCH   defaults: origin / main
set -euo pipefail

LOG_REMOTE="${LOG_REMOTE:-origin}"
LOG_BRANCH="${LOG_BRANCH:-main}"

seconds_until_next_mark() {
  local now="$1" step="$2" rem
  rem=$(( now % step ))
  if (( rem == 0 )); then
    printf '%s\n' "$step"
  else
    printf '%s\n' $(( step - rem ))
  fi
}

ensure_on_branch() {
  local current
  current="$(git symbolic-ref --short -q HEAD || true)"
  if [[ "$current" != "$LOG_BRANCH" ]]; then
    git checkout -B "$LOG_BRANCH"
  fi
}

drop_sample_stash() {
  local top
  top="$(git stash list -1 || true)"
  if [[ "$top" == *parkscoop-sample* || "$top" == *autostash* ]]; then
    git stash drop || true
  fi
}

# An amended tip is not a fast-forward. pull --rebase autostashes the sample
# onto that rewritten commit and can leave conflict markers while exiting 0.
# Check out the fetched tip instead, and keep the sample only if it applies.
# Returns 2 when the sample must be taken again.
restore_sample_onto() {
  local tip="$1" before after p
  local -a paths=()
  before="$(git rev-parse -q --verify refs/stash || true)"
  for p in waits hours forecasts scores; do
    if [[ -e "$p" ]]; then paths+=("$p"); fi
  done
  if ((${#paths[@]} > 0)); then
    git stash push -u -m "parkscoop-sample" -- "${paths[@]}"
  fi
  after="$(git rev-parse -q --verify refs/stash || true)"
  git reset --hard "$tip"
  if [[ "$before" != "$after" ]]; then
    if ! git stash pop; then
      git reset --hard "$tip"
      git stash drop || true
      echo "Uncommitted sample did not apply onto the rewritten tip" >&2
      return 2
    fi
  fi
}

# Fetch main and make HEAD that tip before we read the amend lease.
# Fast-forward uses pull --rebase. A rewritten tip is reset to the fetch.
sync_before_commit() {
  local tip="${LOG_REMOTE}/${LOG_BRANCH}" head remote_sha

  git fetch --no-tags "$LOG_REMOTE" \
    "+refs/heads/${LOG_BRANCH}:refs/remotes/${LOG_REMOTE}/${LOG_BRANCH}"
  if ! git rev-parse --verify --quiet "${tip}~1" >/dev/null; then
    echo "Deepening clone so the amend keeps its parent"
    git fetch --no-tags --deepen=8 "$LOG_REMOTE" "$LOG_BRANCH" || true
  fi
  if ! git rev-parse --verify --quiet "${tip}~1" >/dev/null; then
    echo "Refusing to commit: ${tip} has no parent in this clone" >&2
    return 1
  fi

  head="$(git rev-parse HEAD)"
  remote_sha="$(git rev-parse "$tip")"
  if [[ "$head" != "$remote_sha" ]] && ! git merge-base --is-ancestor "$head" "$remote_sha"; then
    # `|| return` so a discarded sample (status 2) is not treated as a clean sync.
    restore_sample_onto "$tip" || return
  else
    if ! git pull --rebase --autostash "$LOG_REMOTE" "$LOG_BRANCH"; then
      git rebase --abort || true
      return 1
    fi
  fi

  if [[ -n "$(git ls-files -u)" ]]; then
    echo "Sync left conflicts; resetting to ${tip}" >&2
    git reset --hard "$tip"
    drop_sample_stash
    return 2
  fi

  if [[ "$(git rev-parse HEAD)" != "$(git rev-parse "$tip")" ]]; then
    git fetch --no-tags "$LOG_REMOTE" \
      "+refs/heads/${LOG_BRANCH}:refs/remotes/${LOG_REMOTE}/${LOG_BRANCH}" || true
  fi
  if [[ "$(git rev-parse HEAD)" != "$(git rev-parse "$tip")" ]]; then
    echo "HEAD $(git rev-parse --short HEAD) is not ${tip} $(git rev-parse --short "$tip") after sync" >&2
    return 1
  fi
}

sample_once() {
  local use_flags="${1:-0}"
  local -a args=()
  if [[ -n "${LOG_SAMPLE_CMD:-}" ]]; then
    bash -c "$LOG_SAMPLE_CMD"
    return
  fi
  if [[ "$use_flags" == 1 ]]; then
    if [[ "${LOG_FORCE:-0}" == 1 ]]; then args+=(--force); fi
    if [[ "${LOG_REBUILD:-0}" == 1 ]]; then args+=(--rebuild); fi
  fi
  node scripts/run.js "${args[@]}"
}

commit_day() {
  local today hm msg last expected
  git config user.name "github-actions[bot]"
  git config user.email "41898282+github-actions[bot]@users.noreply.github.com"
  # A global commit.gpgsign must not block the bot or sign with a local key.
  git config commit.gpgsign false
  local p
  for p in waits hours forecasts scores; do
    if [[ -e "$p" ]]; then git add -A -- "$p"; fi
  done
  if git diff --cached --quiet; then
    echo "No changes"
    return 0
  fi
  # `read` returns 1 on EOF when the line has no trailing newline, and
  # `set -e` would abort before the commit. console.log adds the newline.
  read -r today hm < <(node --input-type=module -e "const f=new Intl.DateTimeFormat('en-CA',{timeZone:'America/New_York',year:'numeric',month:'2-digit',day:'2-digit',hour:'2-digit',minute:'2-digit',hourCycle:'h23'}); const o={}; for (const p of f.formatToParts(new Date())) o[p.type]=p.value; let h=o.hour==='24'?'00':o.hour; console.log(o.year+'-'+o.month+'-'+o.day+' '+h+':'+o.minute);") || true
  if [[ ! "${today:-} ${hm:-}" =~ ^[0-9]{4}-[0-9]{2}-[0-9]{2}\ [0-9]{2}:[0-9]{2}$ ]]; then
    echo "Could not determine ET timestamp (got: '${today:-}' '${hm:-}')" >&2
    return 1
  fi
  msg="data: ${today} (${hm} ET)"
  expected="$(git rev-parse HEAD)"
  if [[ "$expected" != "$(git rev-parse "${LOG_REMOTE}/${LOG_BRANCH}")" ]]; then
    echo "Lease base is not ${LOG_REMOTE}/${LOG_BRANCH}; refusing to commit" >&2
    return 1
  fi
  last="$(git log -1 --pretty=%s || true)"
  if [[ "$last" == "data: ${today}"* ]] && git rev-parse --verify --quiet HEAD~1 >/dev/null; then
    git commit --amend -m "$msg"
    if ! git rev-parse --verify --quiet HEAD~1 >/dev/null; then
      echo "Amend dropped the parent commit; refusing to push" >&2
      git reset --hard "$expected"
      return 1
    fi
    echo "Amending ${LOG_BRANCH}, lease ${expected}"
    if ! git push --force-with-lease="refs/heads/${LOG_BRANCH}:${expected}" \
        "$LOG_REMOTE" "HEAD:${LOG_BRANCH}"; then
      git reset --hard "$expected"
      return 1
    fi
  else
    git commit -m "$msg"
    echo "New day commit on ${LOG_BRANCH}"
    if ! git push "$LOG_REMOTE" "HEAD:${LOG_BRANCH}"; then
      git reset --hard HEAD~1
      return 1
    fi
  fi
}

# Sample and commit. One retry when the fetched tip rejected the sample.
attempt_commit() {
  local use_flags="$1" rc=0
  sync_before_commit || rc=$?
  if (( rc == 2 )); then
    echo "Re-sampling on the fetched tip"
    sample_once "$use_flags" || return 1
    rc=0
    sync_before_commit || rc=$?
  fi
  if (( rc != 0 )); then
    return 1
  fi
  commit_day
}

run_loop() {
  local interval="${LOG_INTERVAL_SECONDS:-900}"
  local budget="${LOG_BUDGET_SECONDS:-20700}"
  local start now deadline n=0 successes=0 attempts=0 sleep_for use_flags

  if [[ ! "$interval" =~ ^[0-9]+$ ]] || (( interval < 1 )); then
    echo "LOG_INTERVAL_SECONDS must be a positive integer" >&2
    return 1
  fi
  if [[ ! "$budget" =~ ^[0-9]+$ ]] || (( budget < 1 )); then
    echo "LOG_BUDGET_SECONDS must be a positive integer" >&2
    return 1
  fi

  ensure_on_branch
  start="$(date +%s)"
  deadline=$(( start + budget ))
  echo "Logging every ${interval}s until ${budget}s elapse (deadline epoch ${deadline})"

  while true; do
    now="$(date +%s)"
    if (( now >= deadline )); then
      echo "Loop budget reached"
      break
    fi
    n=$(( n + 1 ))
    attempts=$n
    use_flags=0
    if (( n == 1 )); then use_flags=1; fi
    echo "Iteration ${n} at $(date -u +%Y-%m-%dT%H:%M:%SZ)"
    if sample_once "$use_flags" && attempt_commit "$use_flags"; then
      successes=$(( successes + 1 ))
    else
      echo "Iteration ${n} failed" >&2
    fi

    now="$(date +%s)"
    if (( now >= deadline )); then
      echo "Loop budget reached"
      break
    fi
    sleep_for="$(seconds_until_next_mark "$now" "$interval")"
    if (( now + sleep_for >= deadline )); then
      echo "Next mark in ${sleep_for}s is outside the budget; stopping"
      break
    fi
    echo "Sleeping ${sleep_for}s from ${now} until the next ${interval}s mark"
    sleep "$sleep_for"
  done

  echo "Loop finished: ${successes}/${attempts} iterations ok"
  if (( attempts == 0 || successes == 0 )); then
    return 1
  fi
}

if [[ "${BASH_SOURCE[0]}" == "$0" ]]; then
  run_loop
fi
