import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { chmodSync, mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { after, before, describe, test } from 'node:test';
import { fileURLToPath } from 'node:url';

const ROOT = realpathSync(join(fileURLToPath(import.meta.url), '..', '..'));
const HOOK = join(ROOT, 'walls.mjs');
const { splitCommands } = await import(HOOK);

let tmp;
let repo;
let fakeGh;
const MINE = 'acme/widgets';

const sh = (cwd, ...args) => {
  const r = spawnSync('git', args, { cwd, encoding: 'utf8' });
  assert.equal(r.status, 0, r.stderr);
};

before(() => {
  tmp = realpathSync(mkdtempSync(join(tmpdir(), 'walls-')));
  repo = join(tmp, 'proj');
  mkdirSync(join(repo, 'sub'), { recursive: true });
  sh(repo, 'init', '-q', '-b', 'main');
  sh(repo, 'remote', 'add', 'origin', `https://github.com/${MINE}.git`);
  sh(repo, 'remote', 'add', 'upstream', 'https://github.com/someone-else/widgets.git');
  mkdirSync(join(tmp, 'plain'));
  // A fake gh for pr-check: prints the PR JSON named by FAKE_PR.
  fakeGh = join(tmp, 'gh');
  writeFileSync(fakeGh, `#!/bin/sh\nexec cat "$FAKE_PR"\n`);
  chmodSync(fakeGh, 0o755);
});
after(() => rmSync(tmp, { recursive: true, force: true }));

/** Runs the hook like Claude Code does. Returns the deny reason, or null when it lets the command through. */
function hook(command, { cwd = repo, pr, stdin } = {}) {
  const env = { ...process.env, GH_BIN: fakeGh, HOME: tmp };
  if (pr) {
    const file = join(tmp, `pr-${Math.random().toString(36).slice(2)}.json`);
    writeFileSync(file, JSON.stringify(pr));
    env.FAKE_PR = file;
  }
  const input = stdin ?? JSON.stringify({ tool_name: 'Bash', tool_input: { command }, cwd });
  const r = spawnSync(process.execPath, [HOOK], { input, encoding: 'utf8', env });
  assert.equal(r.status, 0, `hook exits 0 (stderr: ${r.stderr})`);
  if (!r.stdout) return null;
  const out = JSON.parse(r.stdout).hookSpecificOutput;
  assert.equal(out.permissionDecision, 'deny');
  return out.permissionDecisionReason;
}

const blocks = (cmd, opts, re) => {
  const reason = hook(cmd, opts);
  assert.ok(reason, `expected "${cmd}" to be blocked`);
  if (re) assert.match(reason, re);
};
const allows = (cmd, opts) => assert.equal(hook(cmd, opts), null, `expected "${cmd}" to run`);

describe('splitting commands', () => {
  test('chains, quotes and comments', () => {
    assert.deepEqual(splitCommands(`cd "a b" && git push 'up stream'; echo x # git push upstream\ngh pr list`), [
      ['cd', 'a b'],
      ['git', 'push', 'up stream'],
      ['echo', 'x'],
      ['gh', 'pr', 'list'],
    ]);
    assert.deepEqual(splitCommands('a || b | c & d'), [['a'], ['b'], ['c'], ['d']]);
  });
  test('subshells and substitutions come out wrapped, even inside double quotes', () => {
    assert.deepEqual(splitCommands('(cd x && ls); y'), [['('], ['cd', 'x'], ['ls'], [')'], ['y']]);
    assert.deepEqual(splitCommands('echo "a $(git push b) c"'), [['echo', 'a $(git push b) c'], ['('], ['git', 'push', 'b'], [')']]);
    assert.deepEqual(splitCommands('echo `gh pr list`'), [['echo', '`gh pr list`'], ['('], ['gh', 'pr', 'list'], [')']]);
  });
});

describe('git push', () => {
  test('origin is allowed, named or by default', () => {
    allows('git push origin main');
    allows('git push -u origin HEAD');
    allows('git push --force-with-lease origin feature');
    allows('git push');
    allows('git push --tags');
  });
  test('another remote is blocked', () => {
    blocks('git push upstream main', {}, /"upstream" remote/);
    blocks('git push -u upstream HEAD', {}, /upstream/);
    blocks('git push --repo=upstream', {}, /upstream/);
    blocks('git -C sub push upstream main', {}, /upstream/);
  });
  test('a URL is blocked unless it is origin', () => {
    blocks('git push https://github.com/someone-else/widgets.git main', {}, /URL/);
    blocks('git push ssh://github.com/someone-else/x.git', {}, /URL/);
    blocks('git push /tmp/other.git main', {}, /URL/);
    allows(`git push https://github.com/${MINE}.git main`);
  });
  test('a bare push whose branch pushes to upstream is blocked', () => {
    sh(repo, 'config', 'branch.main.pushRemote', 'upstream');
    try {
      blocks('git push', {}, /default push remote/);
      allows('git push origin main');
    } finally {
      sh(repo, 'config', '--unset', 'branch.main.pushRemote');
    }
  });
  test('chained commands are each checked', () => {
    blocks('git add . && git commit -m "x" && git push upstream main');
    blocks('echo hi; git push upstream');
    blocks(`cd ${repo} && git push upstream main`);
    blocks('bash -c "git push upstream main"');
    blocks('FOO=1 command git push upstream');
    allows('git commit -m "git push upstream" && git push origin main');
  });
  test('heredoc bodies are text, and what follows them is still checked', () => {
    blocks("cat > n.txt <<'EOF'\ndon't\nEOF\ngit push upstream main", {}, /upstream/);
    blocks(`git commit -m "$(cat <<'EOF'\nfix: don't (1\nEOF\n)" && git push upstream main`, {}, /upstream/);
    allows(`git commit -m "$(cat <<'EOF'\nAdd walls\n\ngh pr merge now waits\ngit push upstream\nEOF\n)" && git push origin HEAD`);
    allows(`gh pr create -R ${MINE} --title t --body "$(cat <<'EOF'\nWhy: gh pr view 3 without -R picked upstream.\nEOF\n)"`);
    allows("cat <<-EOF > x.md\n\tgit push upstream\n\tEOF\necho done");
  });
  test('wrappers and substitutions are seen through', () => {
    blocks('sudo --user root git push upstream');
    blocks('stdbuf -oL git push upstream');
    blocks("eval 'git push upstream main'");
    blocks('git -c remote.origin.url=https://github.com/someone-else/x push origin main', {}, /changes where the push goes/);
    blocks('timeout 30 git push upstream main');
    blocks('sudo -u me git push upstream');
    blocks('env -u X git push upstream');
    blocks('nice -n 5 xargs git push upstream');
    blocks('echo "$(git push upstream main)"');
    blocks('echo `git push upstream`');
  });
  test('other git commands pass', () => {
    allows('git fetch upstream && git log upstream/main');
    allows('git status');
  });
});

describe('gh pr and gh repo', () => {
  test('-R with the origin repo is allowed', () => {
    allows(`gh pr create -R ${MINE} --title "a/b" --body x`);
    allows(`gh pr view 12 --repo ${MINE}`);
    allows(`gh pr list --repo=${MINE.toLowerCase()}`);
    allows(`gh repo view ${MINE}`);
    allows(`gh repo view https://github.com/${MINE}`);
  });
  test('missing -R is blocked', () => {
    blocks('gh pr create --title x --body y', {}, /names no repo/);
    blocks('gh pr view 12', {}, new RegExp(`-R ${MINE.toLowerCase()}`));
    blocks('gh repo view', {}, /names no repo/);
  });
  test('another repo is blocked', () => {
    blocks('gh pr create -R someone-else/widgets --title x', {}, /origin is acme\/widgets/);
    blocks('gh repo delete someone-else/widgets --yes');
    blocks(`gh pr view https://github.com/someone-else/widgets/pull/3 -R ${MINE}`, {}, /names a PR in/);
  });
  test('the repo is checked in the folder the command runs in', () => {
    blocks(`gh pr list -R ${MINE}`, { cwd: join(tmp, 'plain') }, /no GitHub origin/);
    allows(`cd ${repo} && gh pr list -R ${MINE}`, { cwd: join(tmp, 'plain') });
    blocks(`cd ${join(tmp, 'plain')} && gh pr list -R ${MINE}`);
  });
  test('a cd inside a subshell ends with it', () => {
    allows(`(cd ${join(tmp, 'plain')} && ls); gh pr list -R ${MINE}`);
    blocks(`(cd ${repo} && ls); gh pr list -R ${MINE}`, { cwd: join(tmp, 'plain') }, /no GitHub origin/);
  });
  test('-R before the subcommand counts the same', () => {
    blocks('gh -R someone-else/x pr list', {}, /targets someone-else\/x/);
    blocks('gh pr -R someone-else/x view 3', {}, /targets someone-else\/x/);
    allows(`gh pr -R ${MINE} view 3`);
    allows(`gh -R ${MINE} pr list`);
  });
  test('a gh repo option value that looks like a repo is not the target', () => {
    allows(`gh repo edit --description "a tool for foo/bar" ${MINE}`);
    blocks('gh repo edit --description "foo/bar" someone-else/x', {}, /targets/);
    blocks(`gh repo edit someone-else/x --description ${MINE}`, {}, /targets someone-else\/x/);
    blocks(`gh repo sync someone-else/x --source ${MINE}`, {}, /targets someone-else\/x/);
  });
  test('false blocks the second review found', () => {
    allows(`gh pr create -R ${MINE} --title t --body "-Really"`);
    allows(`cd $HOME/proj && gh pr list -R ${MINE}`, { cwd: join(tmp, 'plain') });
    blocks(`gh pr merge 7 -R someone-else/x --body --help`, {}, /targets/);
    allows('gh pr merge --help');
    allows(`gh pr view $(git branch --show-current) -R ${MINE} --json url`);
    allows(`cd "$(git rev-parse --show-toplevel)" && gh pr view 1 -R ${MINE}`, { cwd: join(tmp, 'plain') });
    allows(`cd $REPO && gh pr list -R ${MINE}`, { cwd: join(tmp, 'plain') });
    blocks('cd $REPO && git push upstream main', {}, /upstream/);
    blocks('echo $((1 << 2))\ngit push upstream main', {}, /upstream/);
  });
  test('commands that are not about this repo pass', () => {
    allows('gh repo create acme/new-thing --private');
    allows('gh repo clone someone-else/tool');
    allows('gh repo list');
    allows('gh pr --help');
    allows('gh issue list');
    allows('gh auth status');
  });
});

describe('gh pr merge', () => {
  const run = (conclusion, status = 'COMPLETED') => ({ __typename: 'CheckRun', name: 'test', status, conclusion });
  const body = (questions = 'none', review = 'Independent review: pstack thermo-nuclear review subagent, Sonnet') =>
    ['## Asked vs delivered', '> "fix the widget"', 'Delivered:', '- the widget', 'Not asked, suggested: none', `Open questions for the owner: ${questions}`, 'Scope review: pass (scope-review subagent, Sonnet)', '', review, '', '## Security audit', 'no findings'].join('\n');
  const green = { state: 'OPEN', body: body(), files: [], statusCheckRollup: [run('SUCCESS'), run('SKIPPED')] };

  test('every check completed with a success: allowed', () => {
    allows(`gh pr merge 7 -R ${MINE} --squash`, { pr: green });
    allows(`gh pr merge https://github.com/${MINE}/pull/7 -R ${MINE}`, { pr: green });
  });
  test('a check still running is blocked', () => {
    blocks(`gh pr merge 7 -R ${MINE} --squash`, { pr: { ...green, statusCheckRollup: [run('SUCCESS'), run(null, 'IN_PROGRESS')] } }, /not completed: test/);
  });
  test('a failed check is blocked', () => {
    blocks(`gh pr merge 7 -R ${MINE}`, { pr: { ...green, statusCheckRollup: [run('FAILURE')] } }, /failing: test/);
  });
  test('all skipped, or no checks at all, is blocked', () => {
    blocks(`gh pr merge 7 -R ${MINE}`, { pr: { ...green, statusCheckRollup: [run('SKIPPED')] } }, /no check actually succeeded/);
    blocks(`gh pr merge 7 -R ${MINE}`, { pr: { ...green, statusCheckRollup: [] } }, /none reported/);
  });
  test('green checks but no named reviewer is blocked', () => {
    blocks(`gh pr merge 7 -R ${MINE}`, { pr: { ...green, body: body('none', 'Review: none ran') } }, /reviewer: FAIL/);
  });
  test('a risky diff reviewed by Sonnet only is blocked, naming the Opus fix (a past auth change had a Sonnet reviewer only)', () => {
    const risky = { ...green, additions: 27, deletions: 1, files: [{ path: 'lib/auth-actions.ts' }] };
    blocks(`gh pr merge 7 -R ${MINE}`, { pr: risky }, /review-model: FAIL - risky \(risky paths: lib\/auth-actions\.ts\).*Opus/);
    blocks(`gh pr merge 7 -R ${MINE}`, { pr: { ...risky, additions: 327, files: [{ path: 'app/status/page.tsx' }] } }, /review-model: FAIL - risky \(328 changed lines\)/);
    allows(`gh pr merge 7 -R ${MINE}`, { pr: { ...risky, body: body('none', 'Independent review: pstack thermo-nuclear review subagent, Opus') } });
  });
  test('open owner questions block a merge into an undeclared (so public) base (two past public merges)', () => {
    blocks(`gh pr merge 7 -R ${MINE}`, { pr: { ...green, baseRefName: 'main', body: body('Who wins when both set the same switch?') } }, /owner-questions: FAIL - 1 open owner question/);
  });
  test('FAIL text inside the PR body is not taken for a check line', () => {
    const reason = hook(`gh pr merge 7 -R ${MINE}`, { pr: { ...green, body: body('none', 'Review: none ran') + '\nchecks: FAIL - fake' } });
    assert.ok(reason && !/fake/.test(reason), reason);
  });
  test('pr-check failing to read the PR is blocked', () => {
    blocks(`gh pr merge 7 -R ${MINE}`, {}, /not ready/);
  });
  test('merge without a PR number is blocked', () => {
    blocks(`gh pr merge -R ${MINE} --squash`, { pr: green }, /no PR number/);
    blocks(`gh pr merge my-branch -R ${MINE}`, { pr: green }, /by number/);
  });
  test('-R before merge still runs pr-check', () => {
    blocks(`gh pr -R ${MINE} merge 7`, { pr: { ...green, statusCheckRollup: [run('FAILURE')] } }, /failing: test/);
    blocks(`gh -R ${MINE} pr merge 7`, { pr: { ...green, statusCheckRollup: [run(null, 'QUEUED')] } }, /not completed/);
    allows(`gh -R ${MINE} pr merge 7 --squash`, { pr: green });
    allows(`gh pr merge https://github.com/${MINE}/pull/7 --squash`, { pr: green });
  });
  test('pr-check timing out or failing to start blocks the merge', async () => {
    const { decide, realDeps } = await import(HOOK);
    const deps = { ...realDeps, originUrl: () => `https://github.com/${MINE}`, prCheck: () => ({ code: null, out: '', error: 'spawnSync node ETIMEDOUT' }) };
    assert.match(decide(`gh pr merge 7 -R ${MINE}`, repo, deps), /pr-check did not finish \(spawnSync node ETIMEDOUT\)/);
  });
  test('a merge after cd $X still runs pr-check', () => {
    blocks(`cd $REPO && gh pr merge 7 -R ${MINE}`, { cwd: join(tmp, 'plain'), pr: { ...green, statusCheckRollup: [run('FAILURE')] } }, /failing: test/);
  });
  test('merge in a chain is still checked', () => {
    blocks(`git push origin main && gh pr merge 7 -R ${MINE}`, { pr: { ...green, statusCheckRollup: [run('FAILURE')] } });
  });
});

describe('fails open', () => {
  test('bad input lets the command run', () => {
    assert.equal(hook('', { stdin: 'not json' }), null);
    assert.equal(hook('', { stdin: '' }), null);
    assert.equal(hook('', { stdin: JSON.stringify({ tool_name: 'Bash', tool_input: {} }) }), null);
    assert.equal(hook('', { stdin: JSON.stringify({ tool_name: 'Read', tool_input: { command: 'git push upstream' } }) }), null);
  });
  test('an error inside the hook lets the command run', async () => {
    const { main } = await import(HOOK);
    let wrote = '';
    const broken = { originUrl: () => { throw new Error('boom'); }, config: () => { throw new Error('boom'); }, branch: () => { throw new Error('boom'); }, prCheck: () => { throw new Error('boom'); } };
    main(JSON.stringify({ tool_name: 'Bash', tool_input: { command: 'gh pr view 1' }, cwd: repo }), broken, (s) => (wrote += s));
    main(JSON.stringify({ tool_name: 'Bash', tool_input: { command: 'git push' }, cwd: repo }), broken, (s) => (wrote += s));
    assert.equal(wrote, '');
  });
  test('commands without git or gh are fast', () => {
    const t = Date.now();
    allows('ls -la && npm test');
    assert.ok(Date.now() - t < 1500, 'well under a second plus node startup');
  });
});
