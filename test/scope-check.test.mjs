import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, test } from 'node:test';
import { fileURLToPath } from 'node:url';
import { classifyPr } from '../cos.mjs';
import { checkLedger, scopeStatus } from '../scope-check.mjs';

const SCRIPT = fileURLToPath(new URL('../scope-check.mjs', import.meta.url));

const GOOD = `Outcome: the application questions are drafted.

## Asked vs delivered

Asked:
> "For Acme I need a plan for hiring. Draft what we should ask on the application."

Delivered:
- Hiring plan (answers: "a plan for hiring")
- Application questions (answers: "what we should ask on the application")

Not asked, suggested:
- A scoring sheet, left out of the doc

Open questions for the owner:
- Who do the new hires report to?

Scope review: pass (scope reviewer subagent, opus)

## Security audit

No findings.
`;

describe('checkLedger', () => {
  test('passes a complete section and returns its open questions', () => {
    assert.deepEqual(checkLedger(GOOD), { ok: true, problems: [], openQuestions: ['Who do the new hires report to?'] });
  });

  test('accepts inline labels, bold labels and "none"', () => {
    const text = `### Asked vs delivered\n> "Fix the login button"\n**Delivered:**\n- The button submits again\n**Not asked, suggested:** none\nOpen questions for the owner: none\n**Scope review: pass** (sonnet)\n`;
    assert.deepEqual(checkLedger(text), { ok: true, problems: [], openQuestions: [] });
  });

  test('fails a report with no section', () => {
    const r = checkLedger('Outcome: done. PR #4.');
    assert.equal(r.ok, false);
    assert.match(r.problems[0], /No "## Asked vs delivered" section/);
  });

  test('fails each missing piece by name', () => {
    const r = checkLedger('## Asked vs delivered\n\nDelivered:\n- none\n');
    assert.equal(r.ok, false);
    assert.equal(r.problems.length, 5);
    assert.match(r.problems.join('\n'), /quote the owner's request/);
    assert.match(r.problems.join('\n'), /lists nothing/);
    assert.match(r.problems.join('\n'), /Not asked, suggested/);
    assert.match(r.problems.join('\n'), /Open questions/);
    assert.match(r.problems.join('\n'), /Scope review: pass/);
  });

  test('fails a scope review that did not pass', () => {
    const r = checkLedger(GOOD.replace('Scope review: pass', 'Scope review: fail'));
    assert.equal(r.ok, false);
    assert.match(r.problems[0], /not pass/);
  });

  test('ignores labels that sit under a later heading', () => {
    const text = '## Asked vs delivered\n> "x"\n\n## Notes\nDelivered:\n- y\nNot asked: none\nOpen questions: none\nScope review: pass\n';
    assert.equal(checkLedger(text).ok, false);
  });
});

describe('scope-check.mjs', () => {
  const run = (args, input) => spawnSync(process.execPath, [SCRIPT, ...args], { input, encoding: 'utf8' });

  test('reads a file, passes it and prints the questions to ask', () => {
    const file = join(mkdtempSync(join(tmpdir(), 'scope-')), 'report.md');
    writeFileSync(file, GOOD);
    const r = run(['--file', file]);
    assert.equal(r.status, 0);
    assert.match(r.stdout, /pass[\s\S]*Who do the new hires report to\?/);
  });

  test('fails stdin with no section, naming the problem', () => {
    const r = run([], 'All done!');
    assert.equal(r.status, 1);
    assert.match(r.stdout, /FAIL[\s\S]*Asked vs delivered/);
  });

  test('exits 2 on a malformed --pr', () => {
    assert.equal(run(['--pr', 'nope']).status, 2);
  });
});

describe('cos status', () => {
  const pr = { base: 'dev', isDraft: false, checks: ['SUCCESS'], mergeable: 'MERGEABLE', reviewDecision: null };

  test('blocks a green PR whose body fails the scope check', () => {
    assert.equal(classifyPr({ ...pr, scopeProblems: checkLedger('no section').problems }, null, 'main'), 'blocked');
  });

  test('lets a green PR with a passing section be merged by cos', () => {
    assert.equal(classifyPr({ ...pr, scopeProblems: checkLedger(GOOD).problems }, null, 'main'), 'mergeable-by-cos');
  });
});

describe('checkLedger against copied templates and rewrites', () => {
  const TEMPLATE = readFileSync(fileURLToPath(new URL('../skills/scope-review/SKILL.md', import.meta.url)), 'utf8');
  const shape = TEMPLATE.match(/```markdown\n([\s\S]*?)\n```/)[1];

  test('fails the template from the skill, copied as it is', () => {
    const r = checkLedger(shape);
    assert.equal(r.ok, false);
    assert.match(r.problems.join('\n'), /lists nothing/);
    assert.match(r.problems.join('\n'), /doesn't name the reviewer/);
  });

  test('never reads a section shown inside a code fence', () => {
    const r = checkLedger(`## What changed\n\n\`\`\`markdown\n${GOOD}\n\`\`\`\n`);
    assert.equal(r.ok, false);
    assert.match(r.problems[0], /No "## Asked vs delivered" section/);
  });

  test('takes the last verdict, and a quoted one', () => {
    assert.equal(checkLedger(GOOD.replace('Scope review: pass', 'Scope review: fail (round 1)\n\nScope review: pass')).ok, true);
    assert.equal(checkLedger(GOOD.replace('Scope review: pass', '> Scope review: pass')).ok, true);
    assert.equal(checkLedger(GOOD.replace('Scope review: pass', 'Scope review: pass (r1)\n\nScope review: fail')).ok, false);
  });

  test('fails a bare pass with no reviewer named', () => {
    const r = checkLedger(GOOD.replace('Scope review: pass (scope reviewer subagent, opus)', 'Scope review: pass'));
    assert.match(r.problems.join('\n'), /doesn't name the reviewer/);
  });

  test('accepts a heading with trailing text', () => {
    assert.equal(checkLedger(GOOD.replace('## Asked vs delivered', '## Asked vs delivered (hiring plan)')).ok, true);
  });
});

describe('checkLedger placeholders and tags', () => {
  test('fails a quote left as the template placeholder', () => {
    const r = checkLedger(GOOD.replace(/^> .*$/m, `> "<the owner's exact words, copied, not paraphrased>"`));
    assert.match(r.problems.join('\n'), /quote the owner's request/);
  });

  test('fails a placeholder left beside a real delivered item', () => {
    const r = checkLedger(GOOD.replace('- Application questions', '- <each thing delivered>\n- Application questions'));
    assert.match(r.problems.join('\n'), /template placeholders/);
  });

  test('reads HTML tags as text, not placeholders', () => {
    const text = GOOD.replace('- Hiring plan', '- <button> focus ring fixed, and the Hiring plan').replace('(scope reviewer subagent, opus)', '(opus; checked the <Button> copy)');
    assert.equal(checkLedger(text).ok, true);
  });

  test('a fence line with an info string does not close a fence', () => {
    const r = checkLedger(`\`\`\`markdown\n\`\`\`js\n${GOOD}\n\`\`\`\n`);
    assert.equal(r.ok, false);
  });
});

describe('scopeStatus', () => {
  const SIGNED = '\n\n🤖 Generated with [Claude Code](https://claude.com/claude-code)\n';
  const after = '2026-11-11T00:00:00Z';
  const before = '2026-11-01T00:00:00Z';

  test('blocks a new worker PR with no section', () => {
    const s = scopeStatus({ body: `Done.${SIGNED}`, author: { login: 'me' }, createdAt: after });
    assert.ok(s.scopeProblems.length > 0);
    assert.equal(s.scopeNeeded, false);
  });

  test('only notes a worker PR opened before the rule', () => {
    assert.deepEqual(scopeStatus({ body: `Done.${SIGNED}`, author: { login: 'me' }, createdAt: before }), { scopeProblems: null, scopeNeeded: true });
  });

  test("exempts the owner's own unsigned PRs and bot PRs", () => {
    const none = { scopeProblems: null, scopeNeeded: false };
    assert.deepEqual(scopeStatus({ body: 'Bump deps', author: { login: 'me' }, createdAt: after }), none);
    assert.deepEqual(scopeStatus({ body: `x${SIGNED}`, author: { login: 'dependabot[bot]', is_bot: true }, createdAt: after }), none);
    assert.deepEqual(scopeStatus({ body: `x${SIGNED}`, author: { login: 'renovate' }, createdAt: after }), none);
  });

  test('passes a new worker PR with a passing section', () => {
    assert.deepEqual(scopeStatus({ body: GOOD + SIGNED, author: { login: 'me' }, createdAt: after }), { scopeProblems: null, scopeNeeded: false });
  });

  test('the placeholder pattern stays fast on a long crafted line', () => {
    const t = Date.now();
    checkLedger(`## Asked vs delivered\nDelivered:\n- <${'a '.repeat(50_000)}`);
    assert.ok(Date.now() - t < 1000);
  });
});
