import assert from 'node:assert/strict';
import { execFileSync, spawnSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { after, before, describe, test } from 'node:test';
import { fileURLToPath } from 'node:url';

const ROOT = realpathSync(join(fileURLToPath(import.meta.url), '..', '..'));
const COS = join(ROOT, 'cos.mjs');
const GIT_ENV = {
  ...process.env,
  GIT_AUTHOR_NAME: 't',
  GIT_AUTHOR_EMAIL: 't@example.com',
  GIT_COMMITTER_NAME: 't',
  GIT_COMMITTER_EMAIL: 't@example.com',
  GIT_CONFIG_GLOBAL: '/dev/null',
  GIT_CONFIG_SYSTEM: '/dev/null',
};
const vcs = (cwd, ...args) => execFileSync('git', args, { cwd, env: GIT_ENV, stdio: 'pipe' }).toString();

let tmp;
let work;
let registry;

function commit(file) {
  writeFileSync(join(work, file), file);
  vcs(work, 'add', '-A');
  vcs(work, 'commit', '-m', file);
}

before(() => {
  tmp = realpathSync(mkdtempSync(join(tmpdir(), 'cos-ff-')));
  const bare = join(tmp, 'origin.git');
  mkdirSync(bare);
  vcs(bare, 'init', '--bare', '-b', 'main');
  work = join(tmp, 'work');
  vcs(tmp, 'clone', bare, work);
  commit('a.txt');
  vcs(work, 'push', 'origin', 'main');
  vcs(work, 'checkout', '-b', 'long-lived');
  commit('long.txt');
  vcs(work, 'push', 'origin', 'long-lived');
  vcs(work, 'checkout', '-b', 'sync', 'long-lived');
  commit('sync1.txt');
  commit('sync2.txt');
  vcs(work, 'push', 'origin', 'sync');
  for (const b of ['sync-moved', 'sync-ok']) {
    vcs(work, 'checkout', '-b', b, 'long-lived');
    commit(`${b}.txt`);
    vcs(work, 'push', 'origin', b);
  }
  for (const b of ['target-moved', 'target-ok']) vcs(work, 'push', 'origin', `long-lived:refs/heads/${b}`);
  vcs(work, 'checkout', '-b', 'stale', 'main');
  commit('stale.txt');
  vcs(work, 'push', 'origin', 'stale');
  registry = join(tmp, 'projects.json');
  const project = { id: 'demo', name: 'Demo', what: 'x', checkouts: [work], aliases: [], keywords: [], public: { branches: ['main'], remotes: [], notes: [] }, repos: [], site: null, secrets: [] };
  writeFileSync(registry, JSON.stringify({ projects: [project] }));
});
after(() => rmSync(tmp, { recursive: true, force: true }));

function checks(name, data) {
  const file = join(tmp, `${name}.json`);
  writeFileSync(file, JSON.stringify(data));
  return file;
}

function ff(sync, target, fake, ...extra) {
  const r = spawnSync('node', [COS, 'ff', work, sync, target, ...(fake ? ['--fake-checks', fake] : []), '--registry', registry, ...extra], { env: GIT_ENV, encoding: 'utf8' });
  return { code: r.status, out: r.stdout, err: r.stderr };
}

const GREEN = { check_runs: [{ name: 'ci', status: 'completed', conclusion: 'success' }, { name: 'lint', status: 'completed', conclusion: 'skipped' }], statuses: [{ context: 'vercel', state: 'success' }] };

describe('cos ff', () => {
  test('green checks print the owner command with branch names and the commit count', () => {
    const r = ff('sync', 'long-lived', checks('green', GREEN));
    assert.equal(r.code, 0, r.err);
    assert.match(r.out, /Moves 2 commits\./);
    assert.match(r.out, /git fetch origin && \{ \[ "\$\(git rev-parse refs\/remotes\/origin\/sync\)" = [0-9a-f]{40} \]/);
    assert.match(r.out, /git push origin refs\/remotes\/origin\/sync:refs\/heads\/long-lived$/m);
    assert.doesNotMatch(r.out, /go-live/);
  });

  test('--json carries ready, command, commits and checks', () => {
    const out = JSON.parse(ff('sync', 'long-lived', checks('green2', GREEN), '--json').out);
    assert.equal(out.ready, true);
    assert.equal(out.commits, 2);
    assert.match(out.command, /^cd .* && git fetch origin && \{ .* \} && git push origin refs\/remotes\/origin\/sync:refs\/heads\/long-lived$/);
    assert.equal(out.checksRan, true);
    assert.deepEqual(out.checks.map((c) => c.name), ['ci', 'lint', 'vercel']);
  });

  test('a public target is called a go-live step', () => {
    const r = ff('long-lived', 'main', checks('green3', GREEN));
    assert.equal(r.code, 0, r.err);
    assert.match(r.out, /main is public .*go-live/);
  });

  test('a target with commits the sync branch lacks is refused', () => {
    const r = ff('stale', 'long-lived', checks('green4', GREEN));
    assert.equal(r.code, 1);
    assert.match(r.out, /long-lived has commits stale lacks; rebuild the sync branch from origin\/long-lived/);
    assert.doesNotMatch(r.out, /git push/);
  });

  test('equal branches say already up to date and print no command', () => {
    const r = ff('long-lived', 'long-lived', checks('green5', GREEN));
    assert.equal(r.code, 0);
    assert.match(r.out, /already up to date/);
    assert.doesNotMatch(r.out, /git push/);
  });

  test('failing checks are named and block the command', () => {
    const bad = { check_runs: [{ name: 'e2e', status: 'completed', conclusion: 'failure' }, { name: 'ci', status: 'completed', conclusion: 'success' }], statuses: [] };
    const r = ff('sync', 'long-lived', checks('bad', bad));
    assert.equal(r.code, 1);
    assert.match(r.out, /Checks failing on sync: e2e\./);
    assert.doesNotMatch(r.out, /git push/);
  });

  test('pending checks say they are still running', () => {
    const wait = { check_runs: [{ name: 'ci', status: 'in_progress', conclusion: null }], statuses: [] };
    const r = ff('sync', 'long-lived', checks('wait', wait));
    assert.equal(r.code, 1);
    assert.match(r.out, /Checks still running on sync: ci\./);
  });

  test('no checks at all still prints the command, with a note', () => {
    const r = ff('sync', 'long-lived', checks('none', { check_runs: [], statuses: [] }));
    assert.equal(r.code, 0);
    assert.match(r.out, /No checks ran on sync\./);
    assert.match(r.out, /git push origin refs\/remotes\/origin\/sync:refs\/heads\/long-lived/);
  });

  test('no checks and a public target is refused, with checksRan false in the JSON', () => {
    const none = checks('none2', { check_runs: [], statuses: [] });
    const r = ff('long-lived', 'main', none, '--json');
    assert.equal(r.code, 1);
    const out = JSON.parse(r.out);
    assert.equal(out.ready, false);
    assert.equal(out.checksRan, false);
    assert.equal(out.command, null);
    assert.match(out.reason, /No checks ran on long-lived; push it where CI runs \(or open a draft PR\), then rerun cos ff\./);
  });

  test('only skipped or neutral checks count as no checks, so a public target is refused', () => {
    const skippedOnly = checks('skipped', { check_runs: [{ name: 'ci', status: 'completed', conclusion: 'skipped' }, { name: 'lint', status: 'completed', conclusion: 'neutral' }], statuses: [] });
    const out = JSON.parse(ff('long-lived', 'main', skippedOnly, '--json').out);
    assert.equal(out.ready, false);
    assert.equal(out.checksRan, false);
  });

  test('the printed command refuses to push when the sync branch moved after ff checked it', () => {
    const out = JSON.parse(ff('sync-moved', 'target-moved', checks('g-moved', GREEN), '--json').out);
    assert.equal(out.ready, true);
    const before = vcs(join(tmp, 'origin.git'), 'rev-parse', 'target-moved').trim();
    vcs(work, 'checkout', 'sync-moved');
    commit('later.txt');
    vcs(work, 'push', 'origin', 'sync-moved');
    const r = spawnSync('sh', ['-c', out.command], { env: GIT_ENV, encoding: 'utf8' });
    assert.notEqual(r.status, 0);
    assert.match(r.stdout, /sync-moved moved since cos ff checked it; rerun cos ff/);
    assert.equal(vcs(join(tmp, 'origin.git'), 'rev-parse', 'target-moved').trim(), before);
  });

  test('the printed command pushes when nothing moved, even with a local origin/<branch> tag in the way', () => {
    const out = JSON.parse(ff('sync-ok', 'target-ok', checks('g-ok', GREEN), '--json').out);
    vcs(work, 'tag', 'origin/sync-ok', 'main');
    const r = spawnSync('sh', ['-c', out.command], { env: GIT_ENV, encoding: 'utf8' });
    assert.equal(r.status, 0, r.stderr);
    const bare = join(tmp, 'origin.git');
    assert.equal(vcs(bare, 'rev-parse', 'target-ok').trim(), vcs(bare, 'rev-parse', 'sync-ok').trim());
  });

  test('a home-relative folder with a space keeps ~ unquoted and works in a shell', () => {
    const home = join(tmp, 'home');
    const spaced = join(home, 'my app');
    mkdirSync(home);
    vcs(tmp, 'clone', join(tmp, 'origin.git'), spaced);
    const env = { ...GIT_ENV, HOME: home };
    const r = spawnSync('node', [COS, 'ff', spaced, 'sync-spaced', 'target-spaced', '--fake-checks', checks('g-sp', GREEN), '--registry', registry, '--json'], { env, encoding: 'utf8' });
    assert.equal(r.status, 1, 'no such branches yet');
    vcs(work, 'push', 'origin', 'sync-ok:refs/heads/sync-spaced', 'long-lived:refs/heads/target-spaced');
    const out = JSON.parse(spawnSync('node', [COS, 'ff', spaced, 'sync-spaced', 'target-spaced', '--fake-checks', checks('g-sp', GREEN), '--registry', registry, '--json'], { env, encoding: 'utf8' }).stdout);
    assert.match(out.command, /^cd ~\/'my app' && git fetch origin/);
    const run = spawnSync('sh', ['-c', out.command], { env, encoding: 'utf8' });
    assert.equal(run.status, 0, run.stderr);
  });

  test('a missing folder is named before branch names are checked', () => {
    const r = spawnSync('node', [COS, 'ff', join(tmp, 'nowhere'), 'bad name', 'main', '--registry', registry], { env: GIT_ENV, encoding: 'utf8' });
    assert.equal(r.status, 1);
    assert.match(r.stdout, /nowhere does not exist/);
  });

  test('a bad branch name is refused before anything runs', () => {
    const r = ff('sync; rm -rf', 'long-lived', checks('green6', GREEN));
    assert.equal(r.code, 1);
    assert.match(r.out, /not a valid branch name/);
  });

  test('a missing remote branch is named', () => {
    const r = ff('nope', 'long-lived', checks('green7', GREEN));
    assert.equal(r.code, 1);
    assert.match(r.out, /origin\/nope does not exist/);
  });

  test('unreadable checks block the command', () => {
    const r = spawnSync('node', [COS, 'ff', work, 'sync', 'long-lived', '--registry', registry], { env: { ...GIT_ENV, GH_BIN: join(tmp, 'no-such-gh') }, encoding: 'utf8' });
    assert.equal(r.status, 1);
    assert.match(r.stdout, /Could not read the checks/);
  });
});
