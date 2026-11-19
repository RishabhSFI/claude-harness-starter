import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, test } from 'node:test';
import { fileURLToPath } from 'node:url';
import { capStatus, checkState, DECISIONS, evaluatePr, loadConfig, parsePrRef, rateWindow, renderPrCheck, repoFromRemote, resolveConfig, runPrCheck, runTool, stopRule, workerModel } from '../cos-tools.mjs';

const COS = fileURLToPath(new URL('../cos.mjs', import.meta.url));
const run = (...args) => spawnSync(process.execPath, [COS, ...args], { encoding: 'utf8' });

const BODY = `Outcome: done.

## Asked vs delivered

Asked:
> "Fix the login page."

Delivered:
- Login fix (answers: "Fix the login page")

Not asked, suggested:
- none

Open questions for the owner:
- none

Scope review: pass (scope reviewer subagent, opus)

Code review: independent reviewer, Opus subagent, found nothing.
Security audit: no findings.
Phone screenshots at 375 and 390 are attached.
`;
const OK_CHECKS = [{ name: 'ci', status: 'COMPLETED', conclusion: 'SUCCESS' }, { context: 'vercel', state: 'SUCCESS' }];
const good = (over = {}) => ({ body: BODY, files: [{ path: 'app/page.tsx' }], statusCheckRollup: OK_CHECKS, ...over });
const failing = (r, name) => r.lines.find((l) => l.name === name && l.status === 'FAIL');

describe('pr-check', () => {
  test('a clean PR passes every line', () => {
    const r = evaluatePr(good());
    assert.equal(r.ok, true, JSON.stringify(r.lines));
  });

  test('missing, queued and in-progress checks never pass (the old .conclusion // PENDING bug)', () => {
    assert.equal(checkState({ status: 'IN_PROGRESS', conclusion: null }), 'pending');
    assert.equal(checkState({ status: 'QUEUED' }), 'pending');
    assert.equal(checkState({ status: 'COMPLETED' }), 'fail', 'completed with no conclusion is not success');
    assert.equal(checkState({ status: 'COMPLETED', conclusion: 'FAILURE' }), 'fail');
    assert.equal(checkState({ state: 'PENDING' }), 'pending');
    assert.equal(checkState({}), 'fail');
    assert.ok(failing(evaluatePr(good({ statusCheckRollup: [...OK_CHECKS, { name: 'e2e', status: 'IN_PROGRESS', conclusion: '' }] })), 'checks'));
    assert.ok(failing(evaluatePr(good({ statusCheckRollup: [] })), 'checks'), 'no checks at all is not a pass');
    assert.ok(failing(evaluatePr(good({ statusCheckRollup: undefined })), 'checks'));
    assert.equal(evaluatePr(good({ statusCheckRollup: [] }), { allowNoChecks: true }).ok, true);
    assert.match(evaluatePr(good({ statusCheckRollup: [] })).lines.find((l) => l.name === 'checks').note, /--allow-no-checks/, 'a repo with no CI is told how to pass, not dropped silently');
    for (const deny of ['Review: none, Opus not used', 'Reviewer: skipped (Sonnet unavailable)']) {
      const body = good().body.split('\n').filter((l) => !/review/i.test(l) || /scope review/i.test(l)).concat(deny).join('\n');
      assert.ok(failing(evaluatePr(good({ body })), 'reviewer') || !evaluatePr(good({ body })).ok, `"${deny}" is not a review`);
    }
  });

  test('fails without an Asked vs delivered section or a passing scope review', () => {
    const noSection = evaluatePr(good({ body: 'Reviewer: Opus subagent.\nSecurity audit: no findings.' }));
    assert.ok(failing(noSection, 'asked-vs-delivered'));
    assert.ok(failing(noSection, 'scope-check'));
    const badVerdict = evaluatePr(good({ body: BODY.replace('Scope review: pass', 'Scope review: fail') }));
    assert.ok(failing(badVerdict, 'scope-check'));
    assert.equal(badVerdict.lines.find((l) => l.name === 'asked-vs-delivered').status, 'pass');
  });

  test('fails when no reviewer or no Security audit line', () => {
    assert.ok(failing(evaluatePr(good({ body: BODY.replace(/^Code review:.*$/m, '') })), 'reviewer'));
    assert.ok(failing(evaluatePr(good({ body: BODY.replace(/^Security audit:.*$/m, '') })), 'security-audit'));
  });

  test('flags, but does not fail, UI changes without 375 and 390 screenshots', () => {
    const r = evaluatePr(good({ body: BODY.replace(/^Phone screenshots.*$/m, '') }));
    assert.equal(r.ok, true);
    assert.equal(r.lines.find((l) => l.name === 'phone-shots').status, 'FLAG');
    assert.equal(evaluatePr(good({ body: BODY.replace(/^Phone screenshots.*$/m, ''), files: [{ path: 'src/api.ts' }] })).lines.find((l) => l.name === 'phone-shots').status, 'n/a');
  });

  test('all-skipped or all-neutral checks do not pass; neutral beside a success does', () => {
    const skipped = [{ name: 'a', status: 'COMPLETED', conclusion: 'SKIPPED' }, { name: 'b', status: 'COMPLETED', conclusion: 'NEUTRAL' }];
    assert.ok(failing(evaluatePr(good({ statusCheckRollup: skipped })), 'checks'));
    assert.equal(evaluatePr(good({ statusCheckRollup: skipped }), { allowNoChecks: true }).ok, true);
    assert.equal(evaluatePr(good({ statusCheckRollup: [...OK_CHECKS, ...skipped] })).ok, true);
  });

  test('a closed or merged PR never passes', () => {
    assert.equal(evaluatePr(good({ state: 'OPEN' })).ok, true);
    for (const state of ['CLOSED', 'MERGED']) {
      const r = evaluatePr(good({ state }));
      assert.equal(r.ok, false);
      assert.match(r.lines.find((l) => l.name === 'state').note, /PR is not open/);
    }
  });

  test('negated reviewer lines do not count', () => {
    for (const line of ['Code review: none ran, Opus reviewer pending.', 'Reviewed by Opus: not reviewed yet.', 'No review by a subagent.', 'Independent review (Opus) pending', 'Review: waiting on a different model']) {
      assert.ok(failing(evaluatePr(good({ body: BODY.replace(/^Code review:.*$/m, line) })), 'reviewer'), line);
    }
    assert.equal(evaluatePr(good({ body: BODY.replace(/^Code review:.*$/m, 'Code review: Opus subagent, no findings.') })).ok, true);
  });

  test('a line that only names the scope review is not the independent code review', () => {
    for (const line of ['Reviewers: scope review by Opus', 'Scope review by Opus subagent', 'Reviewers: scope reviewer (sonnet)']) {
      const body = BODY.replace(/^Code review:.*$/m, line).replace(/^Scope review:.*$/m, '');
      assert.ok(failing(evaluatePr(good({ body })), 'reviewer'), line);
    }
    const both = BODY.replace(/^Code review:.*$/m, 'Reviewers: code review by Opus subagent; scope review by Sonnet');
    assert.equal(evaluatePr(good({ body: both })).lines.find((l) => l.name === 'reviewer').status, 'pass');
  });

  test('prints the Asked-vs-delivered section, capped, so the hub can read it from the output', () => {
    const lines = [];
    runPrCheck(['me/app#7'], { fetchPr: () => good({ body: `${BODY.replace('Scope review:', '## Checks\\n\\nScope review:')}` }), out: (l) => lines.push(l) });
    assert.match(lines[0], /Asked vs delivered/);
    assert.match(lines[0], /> "Fix the login page\."/);
    const fenced = lines[0].split('--- BEGIN worker-written PR text')[1];
    assert.doesNotMatch(fenced, /Security audit|Phone screenshots/, 'stops at the end of the section');
    assert.match(fenced, /--- END worker-written PR text ---\s*$/);
    const inner = fenced.split('\n').slice(1, -1);
    assert.ok(inner.length > 0 && inner.every((l) => l.startsWith('| ') || l.startsWith('(... cut')), 'every quoted line is prefixed, so it cannot pass for a check line');
    const long = { body: `## Asked vs delivered\n\n${Array.from({ length: 100 }, (_, i) => `- item ${i}`).join('\n')}\n` };
    const text = renderPrCheck('x#1', evaluatePr(long), long.body);
    assert.match(text, /cut at 60 lines/);
    assert.ok(text.split('\n').length < 80);
    assert.doesNotMatch(text, /item 99/);
  });

  test('--registry is parsed with its value, not left as the PR number', () => {
    const lines = [];
    assert.equal(runPrCheck(['--registry', '/tmp/p.json', 'me/app#7'], { fetchPr: (ref) => (lines.push(ref), good()), out: () => {} }), 0);
    assert.deepEqual(lines, [{ repo: 'me/app', number: 7 }]);
    assert.equal(runTool('cap', ['--registry', '/tmp/p.json', '--working', '1'], { out: () => {} }), 0);
  });

  test('parses PR refs and remotes', () => {
    assert.deepEqual(parsePrRef('me/app#12'), { repo: 'me/app', number: 12 });
    assert.deepEqual(parsePrRef('12', 'me/app'), { repo: 'me/app', number: 12 });
    assert.throws(() => parsePrRef('nope'));
    assert.equal(repoFromRemote('https://github.com/me/app.git'), 'me/app');
    assert.equal(repoFromRemote(['git', 'github.com:me/app.git'].join('@')), 'me/app');
  });

  test('runPrCheck uses the injected fetcher, passes the repo, and exits non-zero on fail', () => {
    const seen = [];
    const lines = [];
    const code = runPrCheck(['me/app#7'], { fetchPr: (ref) => (seen.push(ref), good()), out: (l) => lines.push(l) });
    assert.equal(code, 0);
    assert.deepEqual(seen, [{ repo: 'me/app', number: 7 }]);
    assert.match(lines[0], /^pr-check me\/app#7: PASS/);
    assert.match(lines[0], /merging stays the hub's act/);
    const bad = [];
    assert.equal(runPrCheck(['7', '-R', 'me/app'], { fetchPr: () => good({ statusCheckRollup: [{ name: 'ci', status: 'IN_PROGRESS' }] }), out: (l) => bad.push(l) }), 1);
    assert.match(bad.join('\n'), /FAIL/);
    assert.match(bad.join('\n'), /not completed: ci/);
    assert.equal(runPrCheck(['7'], { fetchPr: () => good(), originOf: () => null, err: () => {} }), 2, 'no repo to ask about');
    assert.equal(runPrCheck(['7', '-R', 'me/app'], { fetchPr: () => { throw new Error('gh down'); }, err: () => {} }), 2);
  });

  test('the command works from a fixture file, with exit codes', () => {
    const dir = mkdtempSync(join(tmpdir(), 'prcheck-'));
    const okFile = join(dir, 'ok.json');
    const badFile = join(dir, 'bad.json');
    writeFileSync(okFile, JSON.stringify(good()));
    writeFileSync(badFile, JSON.stringify(good({ statusCheckRollup: [{ name: 'ci', status: 'COMPLETED', conclusion: 'FAILURE' }] })));
    const a = run('pr-check', '5', '--fixture', okFile);
    assert.equal(a.status, 0, a.stderr);
    assert.match(a.stdout, /PASS/);
    const b = run('pr-check', '5', '--fixture', badFile);
    assert.equal(b.status, 1);
    assert.match(b.stdout, /checks: FAIL - failing: ci/);
  });
});

describe('stop-rule', () => {
  const cfg = resolveConfig(null);
  test('under the limits is ok', () => assert.equal(stopRule({ all: 40, fable: 50 }, cfg).decision, DECISIONS.ok));
  test('all-models 85 or Fable 90 drops to 2 workers', () => {
    assert.equal(stopRule({ all: 85, fable: 0 }, cfg).decision, 'drop-to-2-workers-finish-open');
    assert.equal(stopRule({ all: 84, fable: 90 }, cfg).decision, 'drop-to-2-workers-finish-open');
    assert.equal(stopRule({ all: 84, fable: 89 }, cfg).decision, 'ok');
  });
  test('95 on either window means finish reviews only', () => {
    assert.equal(stopRule({ all: 95, fable: 0 }, cfg).decision, 'no-new-turns-finish-reviews');
    assert.equal(stopRule({ all: 10, fable: 96 }, cfg).decision, 'no-new-turns-finish-reviews');
    assert.equal(stopRule({ all: 10, fable: 10, fiveHour: 95 }, cfg).decision, 'no-new-turns-finish-reviews');
  });
  test('the 5-hour window uses the same soft threshold', () => {
    assert.equal(stopRule({ all: 10, fable: 10, fiveHour: 85 }, cfg).decision, 'drop-to-2-workers-finish-open');
    assert.equal(stopRule({ all: 10, fable: 10, fiveHour: 80 }, cfg).decision, 'ok');
  });
  test('the soft stop only lasts until softStopBefore; the hard stop never lapses', () => {
    const c = resolveConfig({ softStopBefore: '2026-11-11T06:00:00-05:00' });
    assert.equal(stopRule({ all: 90, fable: 0, now: '2026-11-10T20:00:00-05:00' }, c).decision, 'drop-to-2-workers-finish-open');
    assert.equal(stopRule({ all: 90, fable: 0, now: '2026-11-11T07:00:00-05:00' }, c).decision, 'ok');
    assert.equal(stopRule({ all: 96, fable: 0, now: '2026-11-11T07:00:00-05:00' }, c).decision, 'no-new-turns-finish-reviews');
    assert.equal(stopRule({ all: 90, fable: 0, now: '2026-11-11T07:00:00-05:00' }, cfg).decision, 'drop-to-2-workers-finish-open', 'no deadline configured: always applies');
  });
  test('a time of day two days early is not mistaken for before the deadline; a bare hour is refused', () => {
    const c = resolveConfig({ softStopBefore: '2026-11-12T06:00:00-05:00' });
    assert.equal(stopRule({ all: 90, fable: 0, now: '2026-11-14T07:00:00-05:00' }, c).decision, 'ok', 'two days past the deadline');
    assert.equal(stopRule({ all: 90, fable: 0, now: '2026-11-10T07:00:00-05:00' }, c).decision, 'drop-to-2-workers-finish-open', 'two days before');
    assert.equal(stopRule({ all: 90, fable: 0 }, resolveConfig({ softStopBefore: '2020-01-01T00:00:00Z' })).decision, 'ok', 'now defaults to the real time: past deadline');
    assert.equal(stopRule({ all: 90, fable: 0 }, resolveConfig({ softStopBefore: '2999-01-01T00:00:00Z' })).decision, 'drop-to-2-workers-finish-open', 'now defaults to the real time: before deadline');
    const err = [];
    assert.equal(runTool('stop-rule', ['--all', '90', '--now', '7'], { err: (l) => err.push(l) }), 2);
    assert.match(err[0], /--now must be an ISO time/);
    assert.equal(runTool('stop-rule', ['--all', '90', '--hour', '7'], { out: () => {}, err: () => {} }), 0, 'the old flag is just ignored');
  });
  test('thresholds come from the config; flags that are not numbers are refused', () => {
    const c = resolveConfig({ stopAllModels: 70, stopFable: 75, hardStop: 80 });
    assert.equal(stopRule({ all: 70, fable: 0 }, c).decision, 'drop-to-2-workers-finish-open');
    assert.equal(stopRule({ all: 80, fable: 0 }, c).decision, 'no-new-turns-finish-reviews');
    const out = [];
    assert.equal(runTool('stop-rule', ['--all', 'lots'], { out: (l) => out.push(l), err: () => {} }), 2);
    assert.equal(runTool('stop-rule', [], { err: () => {} }), 2);
    assert.equal(runTool('stop-rule', ['--all', '90', '--fable', '10'], { out: (l) => out.push(l) }), 0);
    assert.match(out[0], /^drop-to-2-workers-finish-open: /);
  });
  test('reads cos.config.json from a file', () => {
    const f = join(mkdtempSync(join(tmpdir(), 'cosconf-')), 'c.json');
    writeFileSync(f, JSON.stringify({ stopAllModels: 50 }));
    const out = [];
    runTool('stop-rule', ['--all', '55', '--fable', '0'], { out: (l) => out.push(l), configFile: f });
    assert.match(out[0], /^drop-to-2/);
  });
});

describe('rate', () => {
  test('percent per worker-hour and worker-hours left', () => {
    const r = rateWindow(10, 16, 6, { targetLow: 90, targetHigh: 97 });
    assert.equal(r.perHour, 1);
    assert.equal(r.toLow, 74);
    assert.equal(r.toHigh, 81);
    assert.equal(rateWindow(10, 95, 5).toLow, 0, 'already past the target');
    assert.equal(rateWindow(10, 10, 5).toLow, null, 'no movement: cannot estimate');
  });
  test('prints both windows', () => {
    const out = [];
    assert.equal(runTool('rate', ['--start-all', '33', '--start-fable', '0', '--now-all', '39', '--now-fable', '6', '--worker-hours', '6'], { out: (l) => out.push(l) }), 0);
    assert.match(out[0], /^all-models: 1\.0% per worker-hour; worker-hours left to 90%: 51\.0, to 97%: 58\.0$/);
    assert.match(out[1], /^fable: 1\.0% per worker-hour; worker-hours left to 90%: 84\.0, to 97%: 91\.0$/);
    assert.equal(runTool('rate', ['--start-all', '1'], { err: () => {} }), 2);
    assert.equal(runTool('rate', ['--start-all', '1', '--start-fable', '1', '--now-all', '2', '--now-fable', '2', '--worker-hours', '0'], { err: () => {} }), 2);
  });
});

describe('cap and worker-model', () => {
  test('defaults keep today\'s behaviour: cap 3, no model switching', () => {
    const cfg = resolveConfig(null);
    assert.equal(cfg.maxWorkers, 3);
    assert.equal(workerModel('builder', cfg), null);
    assert.deepEqual(capStatus({ working: 2 }, cfg), { cap: 3, working: 2, canStart: 1, usageFirst: false });
  });
  test('at or past the cap means a usage check first, not a refusal', () => {
    assert.deepEqual(capStatus({ working: 3 }), { cap: 3, working: 3, canStart: 0, usageFirst: true });
    assert.equal(capStatus({ working: 5 }).canStart, 0);
    assert.equal(capStatus({ working: 1, want: 3 }).usageFirst, true);
    assert.equal(capStatus({ working: 1, want: 2 }).usageFirst, false);
    assert.equal(capStatus({ working: 2 }, resolveConfig({ maxWorkers: 5 })).canStart, 3);
  });
  test('roleModels win, an explicit null opts a role out, workerModelAfterStart is the fallback', () => {
    const cfg = resolveConfig({ roleModels: { builder: 'model-x', reviewer: null }, workerModelAfterStart: 'model-y' });
    assert.equal(workerModel('builder', cfg), 'model-x');
    assert.equal(workerModel('reviewer', cfg), null);
    assert.equal(workerModel('other', cfg), 'model-y');
  });
  test('the commands print the answer', () => {
    const f = join(mkdtempSync(join(tmpdir(), 'cosconf-')), 'c.json');
    writeFileSync(f, JSON.stringify({ maxWorkers: 4, roleModels: { builder: 'model-x' } }));
    const out = [];
    runTool('cap', ['--working', '4', '--json'], { out: (l) => out.push(l), configFile: f });
    assert.deepEqual(JSON.parse(out[0]), { cap: 4, working: 4, canStart: 0, usageFirst: true });
    runTool('worker-model', ['builder'], { out: (l) => out.push(l), configFile: f });
    runTool('worker-model', ['qa'], { out: (l) => out.push(l), configFile: f });
    assert.deepEqual(out.slice(1), ['model-x', 'none']);
    assert.equal(run('worker-model', 'builder').stdout.trim(), 'none', 'no cos.config.json in the repo: never switch');
  });
  test('bad config is refused with a clear message', () => {
    assert.throws(() => resolveConfig({ maxWorkers: -1 }), /maxWorkers/);
    assert.throws(() => resolveConfig({ roleModels: { a: 3 } }), /roleModels\.a/);
    assert.throws(() => resolveConfig({ typo: 1 }), /unknown key/);
    assert.throws(() => resolveConfig({ hardStop: 101 }), /hardStop/);
    assert.equal(loadConfig('/nonexistent/cos.config.json').maxWorkers, 3);
  });
});

describe('always-loaded text stays short, each rule in one place', async () => {
  const { readFileSync: read } = await import('node:fs');
  const root = new URL('..', import.meta.url);
  const text = (p) => read(new URL(p, root), 'utf8');
  const { NEVER_SHIP } = await import('../make-starter.mjs');
  const covered = (f) => NEVER_SHIP.some((n) => (n.path.endsWith('/') ? f.startsWith(n.path) : n.path === f));

  test('size budgets', () => {
    assert.ok(Buffer.byteLength(text('global/CLAUDE.md')) <= 6600, 'global/CLAUDE.md grew past its budget');
    assert.ok(Buffer.byteLength(text('skills/cos/SKILL.md')) <= 16 * 1024, 'the cos skill grew past 16 KB; move detail to reference.md');
  });

  test('duplicated rules live in one place', () => {
    const skill = text('skills/cos/SKILL.md');
    assert.doesNotMatch(skill, /150 lines/, 'reviewer sizing is in global/CLAUDE.md only');
    assert.doesNotMatch(skill, /never end a turn with a status-only message/i, 'turn-end rule is in global/CLAUDE.md only');
    assert.match(text('global/CLAUDE.md'), /COMPLETED and successful/);
    assert.match(text('global/CLAUDE.md'), /git remote get-url origin/);
    assert.match(skill, /relayed between sessions doesn't count/);
    assert.match(skill, /Never switch any session\s+out of auto mode/);
    assert.match(skill, /reference\.md/);
  });

  test('the new files ship in the starter, and the real config does not', () => {
    for (const f of ['cos-tools.mjs', 'cos.config.example.json', 'skills/cos/reference.md', 'test/cos-tools.test.mjs']) assert.equal(covered(f), false, f);
    assert.match(text('.gitignore'), /^cos\.config\.json$/m);
  });
});
