const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { execFileSync } = require('node:child_process');

const REPO = path.join(__dirname, '..');
const LOOP = path.join(REPO, 'scripts', 'log-loop.sh');

function git(cwd, args) {
  return execFileSync('git', args, {
    cwd,
    encoding: 'utf8',
  }).trim();
}

function initBare(dir) {
  fs.mkdirSync(dir, { recursive: true });
  execFileSync('git', ['init', '--bare', '-b', 'main', path.join(dir, 'origin.git')], { stdio: 'ignore' });
}

function seedClone(dir) {
  const origin = path.join(dir, 'origin.git');
  const work = path.join(dir, 'work');
  initBare(dir);
  execFileSync('git', ['init', '-b', 'main', work], { stdio: 'ignore' });
  git(work, ['config', 'user.email', 't@example.com']);
  git(work, ['config', 'user.name', 't']);
  fs.writeFileSync(path.join(work, 'README'), 'parent\n');
  git(work, ['add', 'README']);
  git(work, ['commit', '-m', 'parent']);
  fs.mkdirSync(path.join(work, 'waits'));
  fs.writeFileSync(path.join(work, 'waits', 'seed.txt'), 'seed\n');
  git(work, ['add', 'waits']);
  const today = execFileSync('node', ['--input-type=module', '-e', `
    const f = new Intl.DateTimeFormat('en-CA', { timeZone: 'America/New_York', year: 'numeric', month: '2-digit', day: '2-digit' });
    const o = {};
    for (const p of f.formatToParts(new Date())) o[p.type] = p.value;
    process.stdout.write(o.year + '-' + o.month + '-' + o.day);
  `], { encoding: 'utf8' });
  git(work, ['commit', '-m', `data: ${today} (00:00 ET)`]);
  git(work, ['remote', 'add', 'origin', origin]);
  git(work, ['push', '-u', 'origin', 'HEAD:main']);
  const shallow = path.join(dir, 'shallow');
  execFileSync('git', ['clone', '--depth', '2', `file://${origin}`, shallow], { stdio: 'ignore' });
  git(shallow, ['config', 'protocol.file.allow', 'always']);
  git(shallow, ['config', 'user.email', 't@example.com']);
  git(shallow, ['config', 'user.name', 't']);
  return { origin, work, shallow, today };
}

test('seconds_until_next_mark waits until the following boundary', () => {
  const out = execFileSync('bash', ['-c', `
    source "$1"
    seconds_until_next_mark 0 900
    seconds_until_next_mark 1000 900
    seconds_until_next_mark 1799 900
    seconds_until_next_mark 1800 900
    seconds_until_next_mark 5 3
  `, 'bash', LOOP], { encoding: 'utf8' }).trim().split('\n');
  assert.deepEqual(out, ['900', '800', '1', '900', '1']);
});

test('short interval amends one ET-day commit and stops at the budget', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'parkscoop-loop-'));
  const { shallow } = seedClone(dir);
  const started = Date.now();
  const output = execFileSync('bash', [LOOP], {
    cwd: shallow,
    encoding: 'utf8',
    timeout: 25000,
    env: {
      ...process.env,
      LOG_INTERVAL_SECONDS: '3',
      LOG_BUDGET_SECONDS: '11',
      LOG_SAMPLE_CMD: 'mkdir -p waits && date +%s >> waits/ticks.txt',
    },
  });
  const elapsed = Date.now() - started;
  const iterations = [...output.matchAll(/^Iteration (\d+)/gm)].map(m => Number(m[1]));
  assert.ok(iterations.length >= 2, output);
  assert.equal(iterations[iterations.length - 1], iterations.length, output);
  assert.ok(elapsed < 20000, `ran ${elapsed}ms\n${output}`);
  assert.match(output, /Loop finished: \d+\/\d+ iterations ok/);
  assert.doesNotMatch(output, /Iteration \d+ failed/);

  for (const line of output.split('\n')) {
    const m = line.match(/^Sleeping (\d+)s from (\d+) until the next 3s mark$/);
    if (!m) continue;
    const sleep = Number(m[1]);
    const now = Number(m[2]);
    const rem = now % 3;
    const expect = rem === 0 ? 3 : 3 - rem;
    assert.equal(sleep, expect, line);
  }

  const log = git(shallow, ['log', '--oneline', 'origin/main']);
  assert.equal(log.split('\n').length, 2, log);
  assert.match(git(shallow, ['log', '-1', '--format=%s', 'origin/main']), /^data: \d{4}-\d{2}-\d{2} \(\d{2}:\d{2} ET\)$/);
  assert.ok(git(shallow, ['rev-parse', '--verify', 'origin/main~1']));
  const ticks = git(shallow, ['show', 'origin/main:waits/ticks.txt']).trim().split('\n');
  assert.equal(ticks.length, iterations.length, ticks.join(','));
  assert.ok(ticks.every(t => /^\d+$/.test(t)));
});

test('rewritten tip is re-fetched so the amend lease matches origin', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'parkscoop-lease-'));
  const { work, shallow } = seedClone(dir);
  fs.writeFileSync(path.join(work, 'waits', 'remote.txt'), 'remote-version\n');
  git(work, ['add', 'waits/remote.txt']);
  git(work, ['commit', '--amend', '--no-edit']);
  git(work, ['push', '--force', 'origin', 'HEAD:main']);

  const output = execFileSync('bash', [LOOP], {
    cwd: shallow,
    encoding: 'utf8',
    timeout: 20000,
    env: {
      ...process.env,
      LOG_INTERVAL_SECONDS: '3600',
      LOG_BUDGET_SECONDS: '30',
      LOG_SAMPLE_CMD: 'mkdir -p waits && echo from-sample > waits/local.txt',
    },
  });
  assert.match(output, /Loop finished: 1\/1 iterations ok/);
  assert.doesNotMatch(output, /failed/);
  assert.equal(git(shallow, ['show', 'origin/main:waits/remote.txt']), 'remote-version');
  assert.equal(git(shallow, ['show', 'origin/main:waits/local.txt']), 'from-sample');
  assert.equal(git(shallow, ['rev-list', '--count', 'origin/main']), '2');
  const parent = git(shallow, ['rev-parse', 'origin/main~1']);
  assert.equal(parent, git(work, ['rev-parse', 'HEAD~1']));
});

test('fast-forward pull keeps the sample and a new commit on top', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'parkscoop-ff-'));
  const { work, shallow } = seedClone(dir);
  fs.writeFileSync(path.join(work, 'waits', 'extra.txt'), 'extra\n');
  git(work, ['add', 'waits/extra.txt']);
  git(work, ['commit', '-m', 'marker']);
  git(work, ['push', 'origin', 'HEAD:main']);

  const output = execFileSync('bash', [LOOP], {
    cwd: shallow,
    encoding: 'utf8',
    timeout: 20000,
    env: {
      ...process.env,
      LOG_INTERVAL_SECONDS: '3600',
      LOG_BUDGET_SECONDS: '30',
      LOG_SAMPLE_CMD: 'mkdir -p waits && echo from-sample > waits/local.txt',
    },
  });
  assert.match(output, /New day commit/);
  assert.match(output, /Loop finished: 1\/1 iterations ok/);
  assert.equal(git(shallow, ['rev-list', '--count', 'origin/main']), '4');
  assert.equal(git(shallow, ['show', 'origin/main:waits/extra.txt']), 'extra');
  assert.equal(git(shallow, ['show', 'origin/main:waits/local.txt']), 'from-sample');
  assert.equal(git(shallow, ['log', '-1', '--skip=1', '--format=%s', 'origin/main']), 'marker');
});

test('overlapping sample on a rewritten tip resets and is taken again', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'parkscoop-conflict-'));
  const { work, shallow } = seedClone(dir);
  fs.writeFileSync(path.join(work, 'waits', 'seed.txt'), 'remote-version\n');
  git(work, ['add', 'waits/seed.txt']);
  git(work, ['commit', '--amend', '--no-edit']);
  git(work, ['push', '--force', 'origin', 'HEAD:main']);
  fs.writeFileSync(path.join(shallow, 'waits', 'seed.txt'), 'local-version\n');

  const output = execFileSync('bash', ['-c', `
    source "$1"
    set +e
    sync_before_commit
    echo EXIT:$?
    echo "STASH:$(git stash list)"
  `, 'bash', LOOP], { cwd: shallow, encoding: 'utf8' });
  assert.match(output, /EXIT:2/);
  assert.match(output, /STASH:\s*$/);
  assert.equal(fs.readFileSync(path.join(shallow, 'waits', 'seed.txt'), 'utf8'), 'remote-version\n');
  assert.equal(git(shallow, ['status', '--porcelain']), '');
  assert.equal(git(shallow, ['rev-parse', 'HEAD']), git(work, ['rev-parse', 'HEAD']));
});
