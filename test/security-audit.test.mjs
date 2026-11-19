import assert from 'node:assert/strict';
import { execFileSync, spawnSync } from 'node:child_process';
import { chmodSync, existsSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { after, before, describe, test } from 'node:test';
import { fileURLToPath } from 'node:url';

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
