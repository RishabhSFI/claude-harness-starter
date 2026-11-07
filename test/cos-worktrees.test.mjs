import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { existsSync, mkdtempSync, realpathSync, rmSync, utimesSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { after, before, describe, test } from 'node:test';
import { fileURLToPath } from 'node:url';

const ROOT = realpathSync(join(fileURLToPath(import.meta.url), '..', '..'));
const COS = join(ROOT, 'cos.mjs');

const git = (cwd, ...a) => {
  const r = spawnSync('git', ['-c', 'user.name=t', '-c', 'user.email=t@example.com', '-c', 'commit.gpgsign=false', ...a], { cwd, encoding: 'utf8' });
  assert.equal(r.status, 0, r.stderr);
  return r.stdout.trim();
};
const cos = (args, registry) => spawnSync('node', [COS, ...args, '--registry', registry], { encoding: 'utf8', env: { ...process.env, COS_UPTIME_SEC: '0' } });

let tmp, repo, registry;
before(() => {
  tmp = realpathSync(mkdtempSync(join(tmpdir(), 'wt-')));
  repo = join(tmp, 'repo');
  git(tmp, 'init', '-b', 'main', repo);
  writeFileSync(join(repo, 'a.txt'), 'a');
  git(repo, 'add', '-A');
  git(repo, 'commit', '-m', 'init');
  const add = (name, commit) => {
    git(repo, 'worktree', 'add', '-b', name, join(tmp, name));
    if (commit) {
      writeFileSync(join(tmp, name, `${name}.txt`), name);
      git(join(tmp, name), 'add', '-A');
      git(join(tmp, name), 'commit', '-m', name);
    }
  };
  add('merged-clean', false);
  add('merged-dirty', false);
  writeFileSync(join(tmp, 'merged-dirty', 'scratch.txt'), 'x');
  add('has-work', true);
  add('fresh', false);
  add('squashed', true);
  git(repo, 'merge', '--squash', 'squashed');
  git(repo, 'commit', '-m', 'squash squashed');
  const old = new Date(Date.now() - 3 * 86_400_000);
  for (const n of ['merged-clean', 'merged-dirty', 'has-work', 'squashed']) utimesSync(join(tmp, n), old, old);
  registry = join(tmp, 'projects.json');
  writeFileSync(registry, JSON.stringify({ projects: [{ id: 'p', name: 'P', what: 'x', checkouts: [repo] }] }));
});
after(() => {
  spawnSync('git', ['worktree', 'prune'], { cwd: repo });
  rmSync(tmp, { recursive: true, force: true });
});

describe('worktrees', () => {
  test('lists only merged, clean worktrees and removes nothing without --remove', () => {
    const r = cos(['worktrees', '--json'], registry);
    assert.equal(r.status, 0, r.stderr);
    const out = JSON.parse(r.stdout);
    assert.equal(out.total, 5);
    assert.deepEqual(out.stale.map((w) => w.branch).sort(), ['merged-clean', 'squashed']);
    assert.ok(existsSync(join(tmp, 'merged-clean')));
  });
});

describe('worktrees --remove and compact status', () => {
  test('status counts worktrees and names only those with open work; --full lists all', () => {
    const compact = cos(['status', '--no-gh'], registry).stdout;
    assert.match(compact, /worktrees: 5, 2 with open work \(has-work 1 unmerged, merged-dirty 1 uncommitted\)/);
    assert.ok(!compact.includes('merged-clean'));
    const full = cos(['status', '--no-gh', '--full'], registry).stdout;
    assert.ok(full.includes('merged-clean') && full.includes('fresh'));
  });

  test('--remove deletes the stale ones and leaves the rest', () => {
    const r = cos(['worktrees', '--remove'], registry);
    assert.match(r.stdout, /Removed 2 of 2/);
    assert.ok(!existsSync(join(tmp, 'merged-clean')));
    assert.ok(!existsSync(join(tmp, 'squashed')));
    for (const keep of ['merged-dirty', 'has-work', 'fresh']) assert.ok(existsSync(join(tmp, keep)), keep);
  });
});
