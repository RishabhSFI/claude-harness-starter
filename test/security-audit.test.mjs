import assert from 'node:assert/strict';
import { execFileSync, spawnSync } from 'node:child_process';
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { after, before, describe, test } from 'node:test';
import { fileURLToPath } from 'node:url';
import { diffFiles } from '../gate/security-audit.mjs';

const ROOT = realpathSync(join(fileURLToPath(import.meta.url), '..', '..'));
const SCRIPT = join(ROOT, 'gate', 'security-audit.mjs');
const GIT_ENV = {
  ...process.env,
  GIT_AUTHOR_NAME: 't',
  GIT_AUTHOR_EMAIL: 't@example.com',
  GIT_COMMITTER_NAME: 't',
  GIT_COMMITTER_EMAIL: 't@example.com',
  GIT_CONFIG_GLOBAL: '/dev/null',
  GIT_CONFIG_SYSTEM: '/dev/null',
};
const git = (cwd, ...args) => execFileSync('git', args, { cwd, env: GIT_ENV, stdio: 'pipe' }).toString();

const finding = (verdict, severity) => ({ verdict, severity, title: 'Unchecked redirect', file: 'a.js', line: 3, why: 'w', fix: 'check the host' });

let dir;
let fake;
let calls;

before(() => {
  dir = realpathSync(mkdtempSync(join(tmpdir(), 'sec-audit-')));
  git(dir, 'init', '-b', 'main');
  writeFileSync(join(dir, 'a.js'), 'export const a = 1;\n');
  git(dir, 'add', '-A');
  git(dir, 'commit', '-m', 'init');
  fake = join(dir, '..', `fake-claude-${process.pid}.mjs`);
  calls = join(dir, '..', `fake-calls-${process.pid}.log`);
  writeFileSync(
    fake,
    `#!/usr/bin/env node
import { appendFileSync, readFileSync } from 'node:fs';
appendFileSync(${JSON.stringify(calls)}, 'call\\n');
if (process.env.FAKE_RAW !== undefined) { process.stdout.write(process.env.FAKE_RAW); process.exit(0); }
process.stdout.write(JSON.stringify({ is_error: false, structured_output: JSON.parse(process.env.FAKE_RESULT) }));
`,
  );
  chmodSync(fake, 0o755);
});

after(() => {
  rmSync(dir, { recursive: true, force: true });
  rmSync(fake, { force: true });
  rmSync(calls, { force: true });
});

const callCount = () => (existsSync(calls) ? readFileSync(calls, 'utf8').split('\n').filter(Boolean).length : 0);

function change(content) {
  writeFileSync(join(dir, 'a.js'), content);
}

function audit(result, args = [], extra = {}) {
  return spawnSync('node', [SCRIPT, ...args], {
    cwd: dir,
    encoding: 'utf8',
    env: { ...process.env, CLAUDE_BIN: fake, FAKE_RESULT: JSON.stringify(result), ...extra },
  });
}

describe('security-audit gate', () => {
  test('empty diff exits 0 without calling the binary', () => {
    rmSync(calls, { force: true });
    const r = audit({ summary: '', findings: [] });
    assert.equal(r.status, 0);
    assert.match(r.stdout, /no changes to audit/);
    assert.equal(callCount(), 0);
  });

  test('passes when there are no findings', () => {
    change('export const a = 2;\n');
    const r = audit({ summary: 'nothing', findings: [] });
    assert.equal(r.status, 0, r.stderr);
    assert.match(r.stdout, /PASS/);
  });

  test('fails on a confirmed high finding and lists it', () => {
    change('export const a = 3;\n');
    const r = audit({ summary: 's', findings: [finding('confirmed', 'high')] });
    assert.equal(r.status, 1);
    assert.match(r.stdout, /high confirmed a\.js:3 Unchecked redirect/);
    assert.match(r.stdout, /FAIL: 1 confirmed high\+ finding/);
  });

  test('needs_validation never counts, whatever its severity', () => {
    change('export const a = 4;\n');
    const r = audit({ summary: 's', findings: [finding('needs_validation', 'high'), finding('rejected', 'critical')] });
    assert.equal(r.status, 0);
    assert.match(r.stdout, /PASS/);
  });

  test('--fail-on critical lets a high finding through', () => {
    change('export const a = 5;\n');
    const result = { summary: 's', findings: [finding('confirmed', 'high')] };
    assert.equal(audit(result, ['--fail-on', 'critical']).status, 0);
    change('export const a = 55;\n');
    assert.equal(audit({ ...result, findings: [finding('confirmed', 'critical')] }, ['--fail-on', 'critical']).status, 1);
    change('export const a = 56;\n');
    assert.equal(audit({ ...result, findings: [finding('confirmed', 'critical')] }, ['--fail-on', 'none']).status, 0);
  });

  test('a second run on the same diff reuses the cached result', () => {
    change('export const a = 6;\n');
    rmSync(calls, { force: true });
    const result = { summary: 's', findings: [finding('confirmed', 'high')] };
    assert.equal(audit(result).status, 1);
    assert.equal(audit({ summary: '', findings: [] }).status, 1);
    assert.equal(callCount(), 1);
  });

  test('untracked files are part of the diff', () => {
    git(dir, 'checkout', '--', 'a.js');
    writeFileSync(join(dir, 'new.js'), 'export const b = 1;\n');
    rmSync(calls, { force: true });
    const r = audit({ summary: '', findings: [] });
    assert.equal(r.status, 0, r.stderr);
    assert.equal(callCount(), 1);
    rmSync(join(dir, 'new.js'));
  });

  test('unusable output exits 2', () => {
    change('export const a = 7;\n');
    const r = audit({}, [], { FAKE_RAW: 'not json' });
    assert.equal(r.status, 2);
    assert.match(r.stderr, /no usable result/);
  });

  test('no binary exits 2', () => {
    change('export const a = 8;\n');
    const r = spawnSync(process.execPath, [SCRIPT], {
      cwd: dir,
      encoding: 'utf8',
      env: { ...process.env, CLAUDE_BIN: join(dir, 'missing'), CLAUDE_CODE_EXECPATH: '', PATH: '/usr/bin:/bin', HOME: dir },
    });
    assert.equal(r.status, 2);
    assert.match(r.stderr, /no claude binary/);
  });
});

describe('security-audit --pr', () => {
  // The sweep ran this in a project checkout on an older commit (9 PRs over 5 days), so the
  // auditor read files that weren't the PR's. PR mode must read the PR head, never the folder it runs in.
  const HEAD = 'a'.repeat(40);
  let tmp;
  let ghFake;
  let claudeFake;
  let seen;
  before(() => {
    tmp = realpathSync(mkdtempSync(join(tmpdir(), 'sec-audit-pr-')));
    writeFileSync(join(tmp, 'a.js'), 'export const stale = "checkout";\n');
    mkdirSync(join(tmp, 'bin'));
    ghFake = join(tmp, 'bin', 'gh');
    writeFileSync(
      ghFake,
      `#!/bin/sh
case "$1 $2" in
  "pr diff") printf 'diff --git a/a.js b/a.js\\n--- a/a.js\\n+++ b/a.js\\n@@ -1 +1 @@\\n-old\\n+export const head = "pr";\\ndiff --git a/gone.js b/gone.js\\ndeleted file mode 100644\\ndiff --git a/CLAUDE.md b/CLAUDE.md\\n+++ b/CLAUDE.md\\n+x\\n'"$FAKE_EXTRA" ;;
  "pr view") echo ${HEAD} ;;
  "api -H") case "$4" in *"contents/a.js?ref=${HEAD}") printf 'export const head = "pr";\\n' ;; *) exit 1 ;; esac ;;
  *) exit 3 ;;
esac
`,
    );
    chmodSync(ghFake, 0o755);
    seen = join(tmp, 'seen.json');
    claudeFake = join(tmp, 'claude.mjs');
    writeFileSync(
      claudeFake,
      `#!/usr/bin/env node
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
const prompt = process.argv[process.argv.indexOf('-p') + 1];
writeFileSync(${JSON.stringify(seen)}, JSON.stringify({ cwd: process.cwd(), a: readFileSync('a.js', 'utf8'), gone: existsSync('gone.js'), prompt }));
process.stdout.write(JSON.stringify({ is_error: false, structured_output: { summary: '', findings: [] } }));
`,
    );
    chmodSync(claudeFake, 0o755);
  });
  after(() => rmSync(tmp, { recursive: true, force: true }));

  test('audits the files at the PR head commit, not the stale checkout it runs in', () => {
    const r = spawnSync('node', [SCRIPT, '--pr', `me/proj#${process.pid}`], { cwd: tmp, encoding: 'utf8', env: { ...process.env, GH_BIN: ghFake, PATH: `${join(tmp, 'bin')}:${process.env.PATH}`, CLAUDE_BIN: claudeFake, HOME: tmp } });
    assert.equal(r.status, 0, r.stderr);
    const s = JSON.parse(readFileSync(seen, 'utf8'));
    assert.notEqual(s.cwd, tmp, 'runs outside the project checkout');
    assert.equal(s.a, 'export const head = "pr";\n', 'reads the head version of a changed file');
    assert.equal(s.gone, false, 'a file deleted by the PR is not in the snapshot');
    assert.match(s.prompt, new RegExp(`head commit ${HEAD}`));
    assert.equal(existsSync(s.cwd), false, 'the snapshot is removed afterwards');
  });

  test('steering files and failed fetches are named in the prompt, and the result is not cached', () => {
    const env = { ...process.env, GH_BIN: ghFake, CLAUDE_BIN: claudeFake, HOME: tmp, FAKE_EXTRA: 'diff --git a/flaky.js b/flaky.js\\n+++ b/flaky.js\\n+y\\n' };
    const run = () => spawnSync('node', [SCRIPT, '--pr', 'me/proj#77'], { cwd: tmp, encoding: 'utf8', env });
    assert.equal(run().status, 0);
    const s = JSON.parse(readFileSync(seen, 'utf8'));
    assert.match(s.prompt, /judge from the diff only:\nCLAUDE\.md\nflaky\.js/);
    rmSync(seen);
    const again = run();
    assert.doesNotMatch(again.stdout, /cached result/);
    assert.ok(existsSync(seen), 'ran the audit again');
  });
});

describe('diffFiles', () => {
  test('reads paths from the +++ line, marks deletions, and sets quoted headers aside', () => {
    const diff = [
      'diff --git a/x b/y.js b/x b/y.js', '--- a/x b/y.js', '+++ b/x b/y.js', '@@ -1 +1 @@', '+a',
      'diff --git a/gone.js b/gone.js', 'deleted file mode 100644', '--- a/gone.js', '+++ /dev/null',
      'diff --git a/old.js b/new.js', 'similarity index 100%', 'rename from old.js', 'rename to new.js',
      'diff --git "a/caf\\303\\251.js" "b/caf\\303\\251.js"', '+++ "b/caf\\303\\251.js"',
    ].join('\n');
    const { files, deleted, quoted } = diffFiles(diff);
    assert.deepEqual(files, ['x b/y.js', 'gone.js', 'new.js']);
    assert.deepEqual([...deleted], ['gone.js']);
    assert.equal(quoted.length, 1);
  });
});
