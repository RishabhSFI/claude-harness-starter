import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { after, describe, test } from 'node:test';

const { ensureWorktree, leftoverWorktrees } = await import('../mc/actions.mjs');

Object.assign(process.env, { GIT_AUTHOR_NAME: 't', GIT_AUTHOR_EMAIL: 't@example.com', GIT_COMMITTER_NAME: 't', GIT_COMMITTER_EMAIL: 't@example.com', GIT_CONFIG_GLOBAL: '/dev/null', GIT_CONFIG_SYSTEM: '/dev/null' });
const git = (cwd, ...args) => execFileSync('git', args, { cwd, stdio: 'pipe' }).toString().trim();

const tmp = realpathSync(mkdtempSync(join(tmpdir(), 'mc-worktree-test-')));
after(() => rmSync(tmp, { recursive: true, force: true }));

function repo(name) {
  const dir = join(tmp, name);
  mkdirSync(dir, { recursive: true });
  git(dir, 'init', '-q', '-b', 'main');
  writeFileSync(join(dir, 'a.txt'), 'one\n');
  git(dir, 'add', '.');
  git(dir, 'commit', '-qm', 'one');
  return dir;
}

const commit = (dir, msg) => {
  writeFileSync(join(dir, `${msg}.txt`), msg);
  git(dir, 'add', '.');
  git(dir, 'commit', '-qm', msg);
  return git(dir, 'rev-parse', 'HEAD');
};

describe('task worktrees', () => {
  test('start from origin default branch after a fetch, not what the checkout has checked out', async () => {
    const bare = join(tmp, 'origin.git');
    git(tmp, 'clone', '-q', '--bare', repo('origin-src'), bare);
    const checkout = join(tmp, 'checkout');
    git(tmp, 'clone', '-q', bare, checkout);
    git(checkout, 'checkout', '-qb', 'side');
    const sideTip = commit(checkout, 'side');
    const other = join(tmp, 'other');
    git(tmp, 'clone', '-q', bare, other);
    const newTip = commit(other, 'pushed-later');
    git(other, 'push', '-q', 'origin', 'main');

    const r = await ensureWorktree(checkout, { id: 'aaa111', branch: 'task/mc-aaa111' });
    assert.ok(r.ok, r.message);
    const head = git(r.dir, 'rev-parse', 'HEAD');
    assert.equal(head, newTip, 'based on origin/main as fetched just now');
    assert.notEqual(head, sideTip);
    assert.equal(git(r.dir, 'branch', '--show-current'), 'task/mc-aaa111');
    assert.equal(git(r.dir, 'config', '--default', '', 'branch.task/mc-aaa111.merge'), '', 'no upstream, so a bare push never lands on main');
  });

  test('with no remote, start from the local main', async () => {
    const checkout = repo('local-only');
    const mainTip = git(checkout, 'rev-parse', 'HEAD');
    git(checkout, 'checkout', '-qb', 'wip');
    commit(checkout, 'wip');
    const r = await ensureWorktree(checkout, { id: 'bbb222', branch: 'task/mc-bbb222' });
    assert.ok(r.ok, r.message);
    assert.equal(git(r.dir, 'rev-parse', 'HEAD'), mainTip);
  });

  test('a folder deleted by hand is pruned, and the existing branch is reused', async () => {
    const checkout = repo('prune');
    const task = { id: 'ccc333', branch: 'task/mc-ccc333' };
    const first = await ensureWorktree(checkout, task);
    const tip = commit(first.dir, 'work');
    rmSync(first.dir, { recursive: true, force: true });
    const again = await ensureWorktree(checkout, task);
    assert.ok(again.ok, again.message);
    assert.equal(git(again.dir, 'rev-parse', 'HEAD'), tip);
  });

  test('copies the gate local files through worktree.sh setup', async () => {
    const checkout = repo('local-files');
    mkdirSync(join(checkout, '.claude'), { recursive: true });
    writeFileSync(join(checkout, '.claude', 'gate.json'), JSON.stringify({ steps: [], local: ['.env.local'] }));
    git(checkout, 'add', '.');
    git(checkout, 'commit', '-qm', 'gate');
    writeFileSync(join(checkout, '.env.local'), 'X=1\n');
    const r = await ensureWorktree(checkout, { id: 'ddd444', branch: 'task/mc-ddd444' }, { harnessDir: join(import.meta.dirname, '..') });
    assert.ok(r.ok, r.message);
    assert.ok(existsSync(join(r.dir, '.env.local')));
  });

  test('leftover task folders are counted, not removed', () => {
    const dirs = leftoverWorktrees([{ checkouts: [join(tmp, 'prune'), join(tmp, 'nowhere')] }]);
    assert.deepEqual(dirs, [join(tmp, 'prune-tasks', 'mc-ccc333')]);
  });
});
