import assert from 'node:assert/strict';
import { appendFileSync, mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { after, describe, test } from 'node:test';

const a = await import('../mc/activity.mjs');

const tmp = realpathSync(mkdtempSync(join(tmpdir(), 'mc-activity-test-')));
after(() => rmSync(tmp, { recursive: true, force: true }));

const items = (...statuses) => statuses.map((status, i) => ({ content: `Step ${i + 1}`, status }));
const statuses = (plan) => plan.items.map((x) => x.status);

describe('reducePlan', () => {
  const base = a.reducePlan(null, { items: items('in_progress', 'pending', 'pending', 'pending') });
  const cases = [
    { name: 'items replaces the list', plan: base, input: { items: items('completed', 'in_progress') }, want: ['completed', 'in_progress'], step: 2, total: 2 },
    { name: 'advance completes the current step and starts the next pending one', plan: base, input: { advance: true }, want: ['completed', 'in_progress', 'pending', 'pending'], step: 2 },
    { name: 'advance on the last step finishes the plan', plan: a.reducePlan(null, { items: items('completed', 'in_progress') }), input: { advance: true }, want: ['completed', 'completed'], step: 2, current: null },
    { name: 'done and start are 1-based, out of order', plan: base, input: { done: [1, 2], start: 4 }, want: ['completed', 'completed', 'pending', 'in_progress'], step: 4 },
    { name: 'start alone moves the in-progress mark', plan: base, input: { start: 3 }, want: ['pending', 'pending', 'in_progress', 'pending'], step: 3 },
    { name: 'out-of-range numbers are ignored', plan: base, input: { done: [9], start: 0 }, want: ['in_progress', 'pending', 'pending', 'pending'], step: 1 },
    { name: 'wrap_up completes everything', plan: base, input: { completeAll: true }, want: ['completed', 'completed', 'completed', 'completed'], step: 4, current: null },
    { name: 'an unknown input changes nothing', plan: base, input: { what: 1 }, want: ['in_progress', 'pending', 'pending', 'pending'], step: 1 },
  ];
  for (const c of cases) {
    test(c.name, () => {
      const plan = a.reducePlan(c.plan, c.input);
      assert.deepEqual(statuses(plan), c.want);
      assert.equal(plan.step, c.step);
      assert.equal(plan.total, c.total ?? c.want.length);
      assert.equal(plan.done, c.want.filter((s) => s === 'completed').length);
      if ('current' in c) assert.equal(plan.current, c.current);
      else assert.equal(plan.current, plan.items[plan.step - 1].content);
    });
  }

  test('an update with no list to update keeps null', () => {
    assert.equal(a.reducePlan(null, { advance: true }), null);
    assert.equal(a.reducePlan(null, { done: [1] }), null);
  });
});

describe('tool words', () => {
  const cwd = '/work/repo';
  const cases = [
    ['Bash', { command: 'node --test test/*.test.mjs' }, 'Running tests'],
    ['Bash', { command: 'cd x && npm test', description: 'Run them' }, 'Running tests'],
    ['Bash', { command: 'python3 -m pytest -q' }, 'Running tests'],
    ['Bash', { command: 'git -c user.name=x commit -m "y"' }, 'Committing'],
    ['Bash', { command: 'git push -u origin HEAD' }, 'Pushing'],
    ['Bash', { command: 'gh pr create -R a/b' }, 'Working on the PR'],
    ['Bash', { command: 'ls', description: 'List files' }, 'List files'],
    ['Bash', { command: 'ls' }, 'Running a command'],
    ['Edit', { file_path: '/work/repo/mc/server.mjs' }, 'Editing mc/server.mjs'],
    ['Write', { file_path: '/elsewhere/x.md' }, 'Editing /elsewhere/x.md'],
    ['Read', { file_path: '/work/repo/README.md' }, 'Reading README.md'],
    ['Grep', { pattern: 'x' }, 'Searching the code'],
    ['Glob', { pattern: '*' }, 'Searching the code'],
    ['Agent', { description: 'Review the diff' }, 'Waiting on a helper: Review the diff'],
    ['Skill', { skill: 'wiki' }, 'Loading the wiki skill'],
    ['WebFetch', { url: 'https://x' }, 'Reading the web'],
    ['mcp__Claude_Browser__navigate', {}, 'Checking the page in the browser'],
    ['mcp__ccd_turn__update_plan', {}, 'Updating the plan'],
    ['mcp__ccd_turn__wrap_up', {}, 'Wrapping up'],
    ['mcp__ccd_session__start_session', {}, 'Starting a session'],
    ['SendMessage', {}, 'Messaging a session'],
    ['Monitor', {}, 'Waiting'],
    ['mcp__some_server__list_things', {}, 'Using list things'],
    ['Frobnicate', {}, 'Using Frobnicate'],
  ];
  for (const [name, input, want] of cases) {
    test(`${name} ${JSON.stringify(input)}`, () => assert.equal(a.toolWords(name, input, cwd), want));
  }

  test('a Bash description carrying a secret is redacted and cut to one line', () => {
    const words = a.toolWords('Bash', { command: 'x', description: `Set token=sk_live_abcdefghijklmnop\nand more ${'y'.repeat(300)}` }, cwd);
    assert.ok(!words.includes('sk_live_abcdefghijklmnop'));
    assert.ok(!words.includes('\n'));
    assert.ok(words.length <= 160);
  });
});

const line = (o) => `${JSON.stringify(o)}\n`;
const assistant = (at, content, extra = {}) => ({ type: 'assistant', timestamp: at, message: { id: `m-${at}`, content }, ...extra });
const tool = (name, input) => ({ type: 'tool_use', name, input });

describe('transcript cache', () => {
  const user = (at, extra = {}) => ({ type: 'user', timestamp: at, message: { content: [{ type: 'tool_result', content: 'ok' }] }, ...extra });
  const bulk = (at, kb) => user(at, { pad: 'x'.repeat(kb * 1024) });

  test('reads appended lines only, including a line split across two writes', async () => {
    const file = join(tmp, 'append.jsonl');
    writeFileSync(file, line(assistant('t1', [{ type: 'text', text: 'First' }])));
    const cache = a.createTranscriptCache();
    assert.equal((await cache.read(file)).said.text, 'First');
    const unchanged = await cache.read(file);
    assert.equal(await cache.read(file), unchanged, 'an unchanged file gives the same view');
    const next = line(assistant('t2', [{ type: 'text', text: 'Second' }, tool('Read', { file_path: '/x' })]));
    appendFileSync(file, next.slice(0, 20));
    assert.equal((await cache.read(file)).said.text, 'First', 'half a line is held back');
    appendFileSync(file, next.slice(20));
    const act = await cache.read(file);
    assert.equal(act.said.text, 'Second', 'text counts even when the message also calls a tool');
    assert.equal(act.doing.text, 'Reading /x');
  });

  test('a file that shrank is read fresh', async () => {
    const file = join(tmp, 'truncate.jsonl');
    writeFileSync(file, line(assistant('t1', [{ type: 'text', text: 'Old and long message' }])) + line(assistant('t2', [{ type: 'text', text: 'Old again' }])));
    const cache = a.createTranscriptCache();
    assert.equal((await cache.read(file)).said.text, 'Old again');
    writeFileSync(file, line(assistant('t9', [{ type: 'text', text: 'New' }])));
    const act = await cache.read(file);
    assert.equal(act.said.text, 'New');
    assert.equal(act.lastAt, 't9');
  });

  test('looks back past the tail for the plan list, the turn start and the last message', async () => {
    const file = join(tmp, 'long.jsonl');
    const body = [
      { type: 'user', timestamp: '2026-11-04T09:00:00Z', message: { content: 'Do the long thing' } },
      assistant('2026-11-04T09:00:01Z', [{ type: 'text', text: 'Starting now' }, tool(a.PLAN_TOOL, { items: items('in_progress', 'pending', 'pending') })]),
      ...Array.from({ length: 4 }, (_, i) => bulk(`2026-11-04T09:01:0${i}Z`, 120)),
      bulk('2026-11-04T09:01:30Z', 600),
      assistant('2026-11-04T09:02:00Z', [tool(a.PLAN_TOOL, { advance: true })]),
      ...Array.from({ length: 4 }, (_, i) => bulk(`2026-11-04T09:03:0${i}Z`, 120)),
    ];
    writeFileSync(file, body.map(line).join(''));
    const act = await a.createTranscriptCache().read(file);
    assert.deepEqual({ step: act.plan?.step, total: act.plan?.total, current: act.plan?.current }, { step: 2, total: 3, current: 'Step 2' });
    assert.equal(act.turnAt, '2026-11-04T09:00:00Z');
    assert.equal(act.said?.text, 'Starting now');
    assert.equal(act.doing?.text, 'Updating the plan');
    assert.equal(act.lastAt, '2026-11-04T09:03:03Z');
  });

  test('a long file with no plan at all reads to its start and has none', async () => {
    const file = join(tmp, 'noplan.jsonl');
    writeFileSync(file, Array.from({ length: 6 }, (_, i) => line(bulk(`t${i}`, 100))).join(''));
    const act = await a.createTranscriptCache().read(file);
    assert.equal(act.plan, null);
    assert.equal(act.said, null);
    assert.equal(act.lastAt, 't5');
  });

  const said = (at, text) => assistant(at, [{ type: 'text', text }]);
  const ts = (i) => new Date(Date.UTC(2026, 10, 4, 9, 0, i)).toISOString();

  test('an unchanged file past the tail reads the same view twice', async () => {
    const file = join(tmp, 'reread.jsonl');
    const body = [bulk(ts(0), 300), ...Array.from({ length: 5 }, (_, i) => said(ts(i + 1), `Note ${i}`))];
    writeFileSync(file, body.map(line).join(''));
    const cache = a.createTranscriptCache();
    const first = await cache.read(file);
    assert.deepEqual(await cache.read(file), first);
  });

  test('an advance near the end of a file whose tail starts mid-line is applied once', async () => {
    const file = join(tmp, 'advance-once.jsonl');
    const body = [
      assistant(ts(0), [tool(a.PLAN_TOOL, { items: items('in_progress', 'pending', 'pending', 'pending') })]),
      bulk(ts(1), 300),
      assistant(ts(2), [tool(a.PLAN_TOOL, { advance: true })]),
      said(ts(3), 'Moving on'),
    ];
    writeFileSync(file, body.map(line).join(''));
    const cache = a.createTranscriptCache();
    const first = await cache.read(file);
    assert.equal(first.plan?.step, 2);
    const again = await cache.read(file);
    assert.equal(again.plan?.step, 2, 'the advance is not applied a second time');
    assert.deepEqual(again, first);
  });

  test('a long file ending mid-line gives one event for that line once it completes', async () => {
    const file = join(tmp, 'midline.jsonl');
    const body = [bulk(ts(0), 300), ...Array.from({ length: 5 }, (_, i) => said(ts(i + 1), `Note ${i}`))];
    const last = line(said(ts(200), 'Finally done'));
    writeFileSync(file, body.map(line).join('') + last.slice(0, 30));
    const cache = a.createTranscriptCache();
    assert.equal((await cache.read(file)).said.text, 'Note 4');
    appendFileSync(file, last.slice(30));
    const act = await cache.read(file);
    assert.equal(act.said.text, 'Finally done');
    assert.equal(act.events.filter((e) => e.text === 'Finally done').length, 1);
    assert.equal(act.events.filter((e) => e.text === 'Note 4').length, 1);
  });

  test('looking back stops after LOOK_BACK_BYTES; what lies further back stays unknown', async () => {
    const file = join(tmp, 'far.jsonl');
    const filler = (mb) => Array.from({ length: mb * 10 }, (_, i) => line(bulk(ts(i + 1), 100))).join('');
    writeFileSync(file, line(said(ts(0), 'Far back')) + filler(17));
    const act = await a.createTranscriptCache().read(file);
    assert.equal(act.said, null);
    assert.equal(act.lastAt, ts(170));
    writeFileSync(file, line(said(ts(0), 'Near enough')) + filler(15));
    assert.equal((await a.createTranscriptCache().read(file)).said?.text, 'Near enough');
  });

  test('a single line longer than the tail is found by looking back', async () => {
    const file = join(tmp, 'longline.jsonl');
    writeFileSync(file, line(said(ts(0), `Huge ${'y'.repeat(1024 * 1024)}`)) + line(bulk(ts(1), 10)));
    const act = await a.createTranscriptCache().read(file);
    assert.match(act.said?.text ?? '', /^Huge y/);
  });

  test('the reader keeps state only for the sessions it was last asked about', async () => {
    const dir = join(tmp, 'evict');
    const ids = ['aaaaaaaa-0000-4000-8000-000000000001', 'aaaaaaaa-0000-4000-8000-000000000002'];
    mkdirSync(join(dir, '-w'), { recursive: true });
    for (const id of ids) writeFileSync(join(dir, '-w', `${id}.jsonl`), line(assistant('t1', [{ type: 'text', text: id }])));
    const reader = a.createActivityReader({ projectsDir: dir });
    const both = await reader.readAll(ids.map((sessionId) => ({ sessionId, cwd: '/w' })));
    assert.equal(both.get(ids[1]).activity.said.text, ids[1]);
    assert.equal(reader.cached, 2);
    await reader.readAll([{ sessionId: ids[0], cwd: '/w' }]);
    assert.equal(reader.cached, 1);
  });
});

describe('sessionActivity', () => {
  const cwd = '/work/repo';
  const entries = [
    { type: 'user', timestamp: '2026-11-04T10:00:00Z', message: { content: 'Build the page' } },
    assistant('2026-11-04T10:00:05Z', [tool(a.PLAN_TOOL, { items: items('in_progress', 'pending', 'pending') })]),
    assistant('2026-11-04T10:00:10Z', [tool('Read', { file_path: '/work/repo/a.js' })]),
    { type: 'user', timestamp: '2026-11-04T10:00:11Z', message: { content: [{ type: 'tool_result', content: 'ok' }] } },
    assistant('2026-11-04T10:00:20Z', [tool(a.PLAN_TOOL, { advance: true })]),
    assistant('2026-11-04T10:00:30Z', [{ type: 'text', text: '\n## **Done** with [the read](https://x)\nmore' }]),
    assistant('2026-11-04T10:00:40Z', [tool('Edit', { file_path: '/work/repo/mc/server.mjs' })]),
    assistant('2026-11-04T10:00:50Z', [tool('Bash', { command: 'rm -rf /' })], { isSidechain: true }),
  ];

  test('plan, last tool in words, first line of the last message, turn start', () => {
    const act = a.sessionActivity(entries, { cwd });
    assert.deepEqual({ step: act.plan.step, total: act.plan.total, current: act.plan.current }, { step: 2, total: 3, current: 'Step 2' });
    assert.deepEqual(act.doing, { text: 'Editing mc/server.mjs', tool: 'Edit', at: '2026-11-04T10:00:40Z' });
    assert.deepEqual(act.said, { text: 'Done with the read', at: '2026-11-04T10:00:30Z' });
    assert.equal(act.turnAt, '2026-11-04T10:00:00Z', 'tool results are not a new turn');
    assert.equal(act.lastAt, '2026-11-04T10:00:40Z', 'helper entries are skipped');
    assert.deepEqual(act.events.map((e) => e.kind), ['plan', 'tool', 'plan', 'said', 'tool']);
    assert.equal(act.events[2].text, 'Step 2 of 3: Step 2');
  });

  test('wrap_up finishes the plan and its recap is what it said', () => {
    const act = a.sessionActivity([...entries, assistant('2026-11-04T10:01:00Z', [tool(a.WRAP_TOOL, { recap: 'The page is rebuilt.\nNot merged.' })])], { cwd });
    assert.equal(act.plan.done, 3);
    assert.equal(act.plan.current, null);
    assert.equal(act.said.text, 'The page is rebuilt.');
  });

  test('secrets in messages, plans and tool inputs never come out', () => {
    const secret = ['ghp', 'abcdefghijklmnopqrstuvwxyz0123'].join('_'); // split so the starter's leak scan doesn't flag the fixture
    const act = a.sessionActivity([
      assistant('t1', [tool(a.PLAN_TOOL, { items: [{ content: `Rotate ${secret}`, status: 'in_progress' }] })]),
      assistant('t2', [{ type: 'text', text: `Here is the key ${secret} and mail me at someone@example.com` }]),
      assistant('t3', [tool('Bash', { command: 'x', description: `export API_KEY=${secret}` })]),
    ]);
    const out = JSON.stringify(act);
    assert.ok(!out.includes(secret), out);
    assert.ok(!out.includes('someone@example.com'), out);
  });
});

describe('finding transcripts and branches', () => {
  test('finds a transcript by the cwd folder, then by scanning, and by short id', async () => {
    const dir = join(tmp, 'projects');
    const id = 'abcdef12-0000-4000-8000-000000000000';
    mkdirSync(join(dir, '-work-repo'), { recursive: true });
    mkdirSync(join(dir, 'other'), { recursive: true });
    writeFileSync(join(dir, '-work-repo', `${id}.jsonl`), '');
    writeFileSync(join(dir, 'other', 'ffffffff-0000-4000-8000-000000000000.jsonl'), '');
    assert.equal(await a.findTranscript(dir, id, '/work/repo'), join(dir, '-work-repo', `${id}.jsonl`));
    assert.equal(await a.findTranscript(dir, 'ffffffff-0000-4000-8000-000000000000', '/nowhere'), join(dir, 'other', 'ffffffff-0000-4000-8000-000000000000.jsonl'));
    assert.equal(await a.findTranscript(dir, 'ffffffff', null), join(dir, 'other', 'ffffffff-0000-4000-8000-000000000000.jsonl'));
    assert.equal(await a.findTranscript(dir, '99999999-0000-4000-8000-000000000000', null), null);
  });

  test('a miss is not searched for again for 30 seconds, but the cwd folder is still checked', async () => {
    const dir = join(tmp, 'misses');
    const id = 'bbbbbbbb-0000-4000-8000-000000000000';
    const now = 1_000_000;
    mkdirSync(join(dir, 'elsewhere'), { recursive: true });
    assert.equal(await a.findTranscript(dir, id, '/w', now), null);
    writeFileSync(join(dir, 'elsewhere', `${id}.jsonl`), '');
    assert.equal(await a.findTranscript(dir, id, '/w', now + 1000), null, 'no rescan inside the window');
    assert.equal(await a.findTranscript(dir, id, '/w', now + a.MISS_TTL_MS + 1), join(dir, 'elsewhere', `${id}.jsonl`));
    const other = 'cccccccc-0000-4000-8000-000000000000';
    assert.equal(await a.findTranscript(dir, other, '/v', now), null);
    mkdirSync(join(dir, '-v'), { recursive: true });
    writeFileSync(join(dir, '-v', `${other}.jsonl`), '');
    assert.equal(await a.findTranscript(dir, other, '/v', now + 1000), join(dir, '-v', `${other}.jsonl`), 'the cwd guess skips the miss window');
  });

  test('reads the branch from .git, a worktree .git file, or a parent folder', async () => {
    const repo = join(tmp, 'repo');
    mkdirSync(join(repo, '.git'), { recursive: true });
    mkdirSync(join(repo, 'src', 'deep'), { recursive: true });
    writeFileSync(join(repo, '.git', 'HEAD'), 'ref: refs/heads/main\n');
    assert.equal(await a.readBranch(join(repo, 'src', 'deep')), 'main');
    const wt = join(tmp, 'wt');
    mkdirSync(join(repo, '.git', 'worktrees', 'wt'), { recursive: true });
    mkdirSync(wt, { recursive: true });
    writeFileSync(join(repo, '.git', 'worktrees', 'wt', 'HEAD'), 'ref: refs/heads/task/mc-abc123\n');
    writeFileSync(join(wt, '.git'), `gitdir: ${join(repo, '.git', 'worktrees', 'wt')}\n`);
    assert.equal(await a.readBranch(wt), 'task/mc-abc123');
    writeFileSync(join(repo, '.git', 'HEAD'), '0123456789abcdef\n');
    assert.equal(await a.readBranch(repo), null, 'detached HEAD has no branch');
  });
});
