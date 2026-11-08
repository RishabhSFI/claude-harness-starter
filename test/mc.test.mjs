import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { after, describe, test } from 'node:test';

const q = await import('../mc/queue.mjs');
const { buildBrief, mergeDecision, parseFreshPr, printedSessionId, staleStatus, stopDecision } = await import('../mc/actions.mjs');
const { buildLanes, buildSnapshot, readSweep } = await import('../mc/snapshot.mjs');

const tmp = realpathSync(mkdtempSync(join(tmpdir(), 'mc-test-')));
after(() => rmSync(tmp, { recursive: true, force: true }));

const ALPHA = join(tmp, 'alpha');
const BETA = join(tmp, 'beta');
const PROJECTS = [
  { id: 'alpha', name: 'Alpha', checkouts: [ALPHA], public: { branches: ['main'], remotes: [], notes: ['`vercel deploy --prod`'] }, repos: ['acme/alpha'] },
  { id: 'beta', name: 'Beta', checkouts: [BETA], public: { branches: ['main'], remotes: ['site'], notes: ['emails signups'] }, repos: ['acme/beta'] },
];
const ROOTS = q.projectRoots(PROJECTS);
const SETTINGS = { cap: 3, paused: false, pauseReason: null };

let clock = Date.parse('2026-11-04T12:00:00Z');
const tick = () => new Date((clock += 1000));
const task = (over = {}) => {
  const t = q.createTask({ project: 'alpha', title: 'Do a thing', prompt: 'Please do it.', priority: 2, ...over }, { projects: PROJECTS, now: tick() });
  return over.state ? { ...t, state: over.state, sessionId: over.sessionId ?? null } : t;
};

describe('queue transitions', () => {
  const LEGAL = [
    'queued>starting', 'queued>cancelled',
    'starting>working', 'starting>queued', 'starting>failed', 'starting>stopped', 'starting>cancelled',
    'working>blocked', 'working>in_review', 'working>failed', 'working>stopped',
    'blocked>working', 'blocked>in_review', 'blocked>failed', 'blocked>stopped',
    'in_review>ready_to_merge', 'in_review>merged', 'in_review>blocked', 'in_review>stopped',
    'ready_to_merge>in_review', 'ready_to_merge>merged', 'ready_to_merge>blocked', 'ready_to_merge>stopped',
  ];
  const STATES = ['queued', 'starting', 'working', 'blocked', 'in_review', 'ready_to_merge', 'merged', 'failed', 'stopped', 'cancelled'];

  test('the states are exactly the ten in the design', () => {
    assert.deepEqual([...q.STATES].sort(), [...STATES].sort());
    assert.deepEqual([...q.TERMINAL].sort(), ['cancelled', 'failed', 'merged', 'stopped']);
  });

  for (const from of STATES) {
    for (const to of STATES) {
      const legal = LEGAL.includes(`${from}>${to}`);
      test(`${from} -> ${to} is ${legal ? 'legal' : 'rejected'}`, () => {
        const t = { ...task(), state: from };
        if (legal) {
          const next = q.transition(t, to, { note: 'x', now: tick() });
          assert.equal(next.state, to);
          assert.deepEqual(next.history.at(-1), { at: next.updatedAt, from, to, note: 'x' });
          assert.equal(t.state, from, 'the original task is not mutated');
        } else {
          assert.throws(() => q.transition(t, to), q.IllegalTransition);
        }
      });
    }
  }

  test('createTask rejects unknown projects and empty text, and strips leading dashes from the title', () => {
    assert.throws(() => q.createTask({ project: 'nope', title: 't', prompt: 'p' }, { projects: PROJECTS }), /Pick a project/);
    assert.throws(() => q.createTask({ project: 'alpha', title: ' ', prompt: 'p' }, { projects: PROJECTS }), /title/);
    assert.throws(() => q.createTask({ project: 'alpha', title: 't', prompt: '' }, { projects: PROJECTS }), /what the task should do/);
    assert.throws(() => q.createTask({ project: 'alpha', title: 't', prompt: 'p', priority: 4 }, { projects: PROJECTS }), /Priority/);
    const t = q.createTask({ project: 'alpha', title: '--help me', prompt: 'p' }, { projects: PROJECTS });
    assert.equal(t.title, 'help me');
    assert.equal(t.branch, `task/mc-${t.id}`);
    assert.equal(t.sessionName, 'alpha: help me');
  });

  test('move up and down reorders waiting tasks, crossing priorities', () => {
    const a = task({ title: 'a' });
    const b = task({ title: 'b' });
    const c = task({ title: 'c', priority: 3 });
    let tasks = q.move([a, b, c], b.id, 'up');
    assert.deepEqual(q.queueOrder(tasks).map((t) => t.title), ['b', 'a', 'c']);
    tasks = q.move(tasks, c.id, 'up');
    assert.deepEqual(q.queueOrder(tasks).map((t) => t.title), ['b', 'c', 'a']);
    assert.equal(tasks.find((t) => t.id === c.id).priority, 2);
    assert.equal(q.move(tasks, b.id, 'up'), tasks, 'the top task stays put');
  });
});

describe('scheduler', () => {
  const pick = (tasks, { sessions = [], settings = SETTINGS } = {}) => q.pickNext(tasks, { sessions, roots: ROOTS, settings });

  test('starts the highest priority, then the oldest', () => {
    const old = task({ title: 'old p2' });
    const urgent = task({ title: 'new p1', priority: 1 });
    assert.equal(pick([old, urgent]).start.id, urgent.id);
    const older = task({ project: 'beta', title: 'older' });
    const newer = task({ project: 'beta', title: 'newer' });
    assert.equal(pick([newer, older]).start.id, older.id);
  });

  test('no limit by default: every queued task gets started, one per tick', () => {
    const working = [task({ state: 'working' }), task({ state: 'starting' }), task({ state: 'working' }), task({ state: 'working' })];
    const [a, b] = [task({ title: 'a' }), task({ title: 'b' })];
    const r = q.pickNext([...working, a, b], { settings: q.DEFAULT_SETTINGS });
    assert.equal(q.DEFAULT_SETTINGS.cap, null);
    assert.equal(r.start.id, a.id);
    assert.match(r.waiting[b.id], /as soon as the one before it/);
  });

  test('respects a limit the owner set', () => {
    const working = [task({ state: 'working', project: 'beta' }), task({ state: 'starting', project: 'beta' })];
    const waiting = task();
    assert.equal(pick([...working, waiting], { settings: { ...SETTINGS, cap: 2 } }).start, null);
    assert.match(pick([...working, waiting], { settings: { ...SETTINGS, cap: 2 } }).waiting[waiting.id], /at the limit you set \(2/);
    assert.equal(pick([...working, waiting], { settings: { ...SETTINGS, cap: 3 } }).start.id, waiting.id);
  });

  test('no one-writer rule: a queue task or a busy session in the project does not hold it', () => {
    const t = task();
    assert.equal(pick([task({ state: 'blocked' }), task({ state: 'working' }), t], { settings: { ...SETTINGS, cap: null } }).start.id, t.id);
    for (const cwd of [ALPHA, join(ALPHA, 'src'), `${ALPHA}-tasks/fix`, join(ALPHA, '.claude', 'worktrees', 'x')]) {
      assert.equal(pick([t], { sessions: [{ sessionId: 's1', name: 'desk', cwd, status: 'busy' }] }).start.id, t.id, cwd);
    }
  });

  test('settings: an old file with the old default cap loads as no limit; a saved limit sticks', () => {
    const file = join(tmp, 'settings-migrate.json');
    writeFileSync(file, JSON.stringify({ cap: 3, paused: true, pauseReason: 'usage limit' }));
    assert.deepEqual(q.loadSettings(file), { cap: null, paused: true, pauseReason: 'usage limit' });
    q.saveSettings(file, { cap: 5, paused: false, pauseReason: null });
    assert.equal(q.loadSettings(file).cap, 5);
    q.saveSettings(file, { cap: null, paused: false, pauseReason: null });
    assert.equal(q.loadSettings(file).cap, null);
  });

  test('pause stops every start', () => {
    const t = task();
    const r = pick([t], { settings: { ...SETTINGS, paused: true, pauseReason: 'usage limit' } });
    assert.equal(r.start, null);
    assert.equal(r.waiting[t.id], 'paused: usage limit');
  });

  test('a risky task waits for approval; the next one goes first', () => {
    const risky = task({ priority: 1, risky: true });
    const safe = task({ project: 'beta' });
    const r = pick([risky, safe]);
    assert.equal(r.start.id, safe.id);
    assert.equal(r.waiting[risky.id], 'needs your approval to start');
    assert.equal(pick([{ ...risky, approved: true }, safe]).start.id, risky.id);
  });

  test('limit messages are recognised, ordinary failures are not', () => {
    for (const m of ['Claude usage limit reached', 'Error: rate limit exceeded', 'HTTP 429 Too Many Requests', 'You are out of usage']) assert.ok(q.isLimitMessage(m), m);
    for (const m of ['not a git repository', 'ENOENT', 'invalid permission mode']) assert.ok(!q.isLimitMessage(m), m);
  });
});

describe('reconcile', () => {
  const now = new Date('2026-11-04T13:00:00Z');
  const started = (over) => ({ ...task(), state: 'working', sessionId: 'sess-1', startedAt: '2026-11-04T12:59:30Z', ...over });

  test('session status maps onto the task: busy is working, idle is blocked', () => {
    const t = started({});
    assert.deepEqual(q.reconcile([t], { sessions: [{ sessionId: 'sess-1', status: 'idle', cwd: ALPHA }], prs: [], now }).map((m) => m.to), ['blocked']);
    const b = started({ state: 'blocked' });
    assert.deepEqual(q.reconcile([b], { sessions: [{ sessionId: 'sess-1', status: 'busy', cwd: ALPHA }], prs: [], now }).map((m) => m.to), ['working']);
  });

  test('a session found by name fills in the missing id', () => {
    const t = started({ sessionId: null });
    const [m] = q.reconcile([t], { sessions: [{ sessionId: 'found', name: t.sessionName, status: 'busy', cwd: ALPHA }], prs: [], now });
    assert.equal(m.patch.sessionId, 'found');
    assert.equal(q.applyMoves([t], [m])[0].sessionId, 'found');
  });

  test("a PR on the task's branch moves it to review, or ready to merge when cos may merge it", () => {
    const t = started({});
    const pr = { project: 'alpha', branch: t.branch, number: 4, url: 'https://github.com/acme/alpha/pull/4' };
    const after = (task, classification, project = 'alpha') => q.applyMoves([task], q.reconcile([task], { sessions: [], prs: [{ ...pr, project, classification }], now }))[0];
    assert.equal(after(t, 'blocked').state, 'in_review');
    assert.equal(after(t, 'review').state, 'in_review');
    const ready = after(t, 'mergeable-by-cos');
    assert.equal(ready.state, 'ready_to_merge');
    assert.deepEqual(ready.history.slice(-2).map((h) => h.to), ['in_review', 'ready_to_merge']);
    assert.deepEqual(ready.pr, { url: pr.url, number: 4 });
    assert.equal(after({ ...t, state: 'blocked' }, 'mergeable-by-cos').state, 'ready_to_merge');
    assert.equal(after(ready, 'blocked').state, 'in_review');
    assert.equal(after(ready, 'mergeable-by-cos'), ready, 'no change when nothing moved');
    assert.equal(after(t, 'blocked', 'beta'), t, "another project's PR on the same branch name doesn't count");
  });

  test('a session that vanished without a PR blocks the task after the grace period', () => {
    assert.deepEqual(q.reconcile([started({})], { sessions: [], prs: [], now }), [], 'inside the grace period');
    const old = started({ startedAt: '2026-11-04T12:50:00Z' });
    assert.equal(q.reconcile([old], { sessions: [], prs: [], now })[0].to, 'blocked');
  });

  test('the working grace counts from entering working, not from the start, so a slow launch is not blocked', () => {
    const slow = started({ startedAt: '2026-11-04T12:55:00Z', history: [{ at: '2026-11-04T12:55:00Z', from: 'queued', to: 'starting', note: '' }, { at: '2026-11-04T12:59:50Z', from: 'starting', to: 'working', note: '' }] });
    assert.deepEqual(q.reconcile([slow], { sessions: [], prs: [], now }), [], 'launch took 5 min, working for 10 s');
    const later = new Date('2026-11-04T13:01:00Z');
    assert.equal(q.reconcile([slow], { sessions: [], prs: [], now: later })[0].to, 'blocked', 'still no session 70 s into working');
  });

  test('an unknown session list moves nothing: no blocking or failing on a failed poll', () => {
    const old = started({ startedAt: '2026-11-04T12:50:00Z' });
    const starting = started({ state: 'starting', sessionId: null, startedAt: '2026-11-04T12:50:00Z' });
    assert.deepEqual(q.reconcile([old, starting], { sessions: null, prs: [], now }), []);
  });

  test('a starting task finds its session by name and moves to working', () => {
    const t = started({ state: 'starting', sessionId: null });
    const [m] = q.reconcile([t], { sessions: [{ sessionId: 'found-1', name: t.sessionName, status: 'busy', cwd: ALPHA }], prs: [], now });
    assert.equal(m.to, 'working');
    const after = q.applyMoves([t], [m])[0];
    assert.equal(after.state, 'working');
    assert.equal(after.sessionId, 'found-1');
  });

  test('a starting task with no session after 90 s fails with a reason; inside 90 s it waits', () => {
    const fresh = started({ state: 'starting', sessionId: null, startedAt: '2026-11-04T12:58:40Z' });
    assert.deepEqual(q.reconcile([fresh], { sessions: [], prs: [], now }), []);
    const stuck = started({ state: 'starting', sessionId: null, startedAt: '2026-11-04T12:58:00Z' });
    const [m] = q.reconcile([stuck], { sessions: [], prs: [], now });
    assert.equal(m.to, 'failed');
    assert.match(m.note, /no session named "alpha: Do a thing" showed up within 90 s/);
  });

  test('a slow start is not failed while its launch is still running, and is once it returns', () => {
    const slow = started({ state: 'starting', sessionId: null, startedAt: '2026-11-04T12:55:00Z' });
    assert.deepEqual(q.reconcile([slow], { sessions: [], prs: [], now, launching: slow.id }), [], 'worktree setup still running');
    const found = q.reconcile([slow], { sessions: [{ sessionId: 'found-2', name: slow.sessionName, status: 'busy', cwd: ALPHA }], prs: [], now, launching: slow.id });
    assert.deepEqual(found.map((m) => m.to), ['working'], 'a session that shows up mid-launch still counts');
    assert.equal(q.reconcile([slow], { sessions: [], prs: [], now, launching: 'other-task' })[0].to, 'failed');
    assert.equal(q.reconcile([slow], { sessions: [], prs: [], now, launching: null })[0].to, 'failed');
  });

  test('the short id --bg prints matches the session UUID, and the task takes the full id', () => {
    const uuid = '1a2b3c4d-0000-4000-8000-000000000000';
    assert.ok(q.sameSession('1a2b3c4d', uuid));
    assert.ok(q.sameSession(uuid, uuid));
    assert.ok(!q.sameSession('1a2b3c4e', uuid));
    assert.ok(!q.sameSession('1a2b', uuid), 'only the 8-character short id is a prefix match');
    assert.ok(!q.sameSession(null, uuid));
    const t = started({ sessionId: '1a2b3c4d' });
    const [m] = q.reconcile([t], { sessions: [{ sessionId: uuid, status: 'busy', cwd: ALPHA }], prs: [], now });
    assert.equal(q.applyMoves([t], [m])[0].sessionId, uuid);
  });

  test('printedSessionId reads a UUID or a short id from --bg output', () => {
    assert.equal(printedSessionId('Started in the background: 11111111-2222-4333-8444-555555555555'), '11111111-2222-4333-8444-555555555555');
    assert.equal(printedSessionId('Started in the background: 1a2b3c4d\nclaude attach 1a2b3c4d'), '1a2b3c4d');
    assert.equal(printedSessionId('Started.'), null);
  });
});

describe('lanes and sweep', () => {
  test('tasks and untracked PRs land in lanes by the lane table', () => {
    const now = new Date('2026-11-04T15:00:00Z');
    const working = { ...task(), state: 'working' };
    const merged = { ...task(), state: 'merged', updatedAt: '2026-11-04T14:00:00Z' };
    const oldMerged = { ...task(), state: 'merged', updatedAt: '2026-10-01T14:00:00Z' };
    const prs = [
      { project: 'alpha', branch: 'x', number: 1, url: 'https://github.com/acme/alpha/pull/1', classification: 'review', checks: ['SUCCESS'] },
      { project: 'alpha', branch: 'y', number: 2, url: 'https://github.com/acme/alpha/pull/2', classification: 'mergeable-by-cos', checks: ['SUCCESS'] },
      { project: 'beta', branch: 'z', number: 3, url: 'https://github.com/acme/beta/pull/3', classification: 'blocked', checks: [], failingChecks: [] },
    ];
    const lanes = Object.fromEntries(buildLanes([working, merged, oldMerged], prs, now).map((l) => [l.id, l.cards.map((c) => c.title ?? c.pr.number)]));
    assert.deepEqual(lanes.working, [working.title]);
    assert.equal(lanes.merged_today.length, 1);
    assert.equal(lanes.needs_you.length, 1);
    assert.equal(lanes.ready_to_merge.length, 1);
    assert.equal(lanes.in_review.length, 1);
  });

  test('Needs you: blocked queue tasks, PRs, approvals and warnings; no outside sessions, no review proposals', () => {
    const blocked = { ...task({ title: 'Stuck' }), state: 'blocked', sessionId: 'q1' };
    const risky = task({ title: 'Careful', risky: true });
    const status = {
      projects: [{ id: 'alpha', name: 'Alpha', checkouts: [{ path: ALPHA, defaultBranch: 'main', attention: [{ message: '3 uncommitted files' }],
        prs: [{ number: 4, title: 'Public one', url: 'https://github.com/acme/alpha/pull/4', branch: 'x', classification: 'review', checks: [] }] }] }],
    };
    const sessions = [
      { sessionId: 'q1', name: blocked.sessionName, cwd: ALPHA, status: 'idle' },
      { sessionId: 'd1', name: 'desktop chat', cwd: ALPHA, status: 'idle' },
      { sessionId: 'd2', name: 'other chat', cwd: tmp, status: 'idle' },
    ];
    const snap = buildSnapshot({
      projects: PROJECTS, roots: ROOTS, status, sessions, tasks: [blocked, risky], waiting: {},
      settings: { cap: 3, paused: true, pauseReason: 'usage limit' },
      sweep: { file: '/r/2026-11-03.md', date: '2026-11-03', items: ['1. First', '2. Second'] }, meta: {},
    });
    assert.deepEqual(snap.needsYou.map((n) => n.kind), ['paused', 'approve', 'blocked', 'review', 'status']);
    assert.ok(!snap.needsYou.some((n) => n.sessionId === 'd1' || n.sessionId === 'd2'), 'outside sessions stay in the Sessions panel');
    assert.deepEqual(snap.fromReview, { file: '/r/2026-11-03.md', date: '2026-11-03', items: ['1. First', '2. Second'] });
    assert.equal(snap.sessions.flatMap((g) => g.sessions).length, 3);
  });

  test('the sweep is the latest daily review\'s proposed changes', () => {
    const dir = join(tmp, 'reports');
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, '2026-11-01.md'), '## Proposed changes\n### old\n');
    writeFileSync(join(dir, '2026-11-03.md'), '# Review\n## Proposed changes\n### 1. First\ntext\n### 2. Second\n## Notes added\n### not this\n');
    writeFileSync(join(dir, 'cos-2026-11-09.md'), '## Needs you\n### nope\n');
    const sweep = readSweep(dir);
    assert.equal(sweep.date, '2026-11-03');
    assert.deepEqual(sweep.items, ['1. First', '2. Second']);
  });
});

describe('worker brief', () => {
  const t = { ...task({ prompt: 'Fix "it"; rm -rf ~ $(whoami)\n--dangerously-skip-permissions' }) };
  const brief = buildBrief({ task: t, project: PROJECTS[1], harnessDir: '/H', repo: 'acme/beta' });

  test('starts with /until-ready and carries the cos brief lines', () => {
    assert.ok(brief.startsWith(`/until-ready ${t.title}\n`));
    assert.match(brief, /Read \/H\/wiki\/projects\/beta\.md first/);
    assert.match(brief, /load the pstack:poteto-mode skill/);
    assert.match(brief, /pass `-R acme\/beta` to every gh/);
    assert.match(brief, /Report back in this shape: outcome first, PR link/);
    assert.match(brief, new RegExp(`your branch is ${t.branch}`));
  });

  test('tells the worker to wait in the foreground, not end turns on status', () => {
    assert.match(brief, /Monitor\s+until-loops/);
    assert.match(brief, /only when the PR is open, you're\s+blocked, or you have a question/);
  });

  test("includes the project's public rules", () => {
    assert.match(brief, /Release rules for this project: main on origin; pushes to site; emails signups\./);
  });

  test("quotes the owner's words as written", () => {
    assert.ok(brief.includes('> Fix "it"; rm -rf ~ $(whoami)\n> --dangerously-skip-permissions'));
  });
});

describe('merge and stop policy', () => {
  const fresh = (over) => parseFreshPr({ state: 'OPEN', headRefOid: 'abc123', baseRefName: 'develop', isDraft: false, statusCheckRollup: [{ conclusion: 'SUCCESS' }], mergeable: 'MERGEABLE', reviewDecision: null, ...over });
  const decide = (pr, extra = {}) => mergeDecision({ pr, project: PROJECTS[0], defaultBranch: 'main', repo: 'acme/alpha', number: 5, ...extra });
  test('a project with no public list needs the typed confirm even for a green private-looking PR', () => {
    const undeclared = { ...PROJECTS[0], public: undefined };
    const green = parseFreshPr({ baseRefName: 'master', headRefOid: 'abc', isDraft: false, state: 'OPEN', mergeable: 'MERGEABLE', reviewDecision: '', statusCheckRollup: [{ conclusion: 'SUCCESS' }] });
    const d = mergeDecision({ pr: green, project: undeclared, defaultBranch: 'main', repo: 'acme/alpha', number: 5 });
    assert.equal(d.allow, false);
    assert.equal(mergeDecision({ pr: green, project: undeclared, defaultBranch: 'main', repo: 'acme/alpha', number: 5, confirm: 'acme/alpha#5' }).allow, true);
  });

  test('one click for a green PR into a private branch', () => {
    assert.deepEqual(decide(fresh()), { allow: true });
  });

  test('a public base needs the explicit confirmation', () => {
    assert.match(decide(fresh({ baseRefName: 'main' })).reason, /public branch \(main\)\. Confirm the live merge/);
    assert.equal(decide(fresh({ baseRefName: 'main' }), { confirm: 'acme/alpha#4' }).allow, false);
    assert.equal(decide(fresh({ baseRefName: 'main' }), { confirm: 'acme/alpha#5' }).allow, true);
  });

  test('failing, draft, closed, headless and unreadable PRs, and repos outside projects.json, are refused', () => {
    assert.equal(decide(fresh({ statusCheckRollup: [{ conclusion: 'FAILURE' }] }), { confirm: 'acme/alpha#5' }).allow, false);
    assert.equal(decide(fresh({ isDraft: undefined })).allow, false, 'a missing draft flag fails closed');
    assert.match(decide(fresh({ state: 'MERGED' })).reason, /is merged, not open/);
    assert.equal(decide(fresh({ headRefOid: '' })).allow, false);
    assert.match(decide(null).reason, /Couldn't read/);
    assert.match(decide(fresh(), { project: undefined }).reason, /isn't listed/);
  });

  test('a live merge whose checks are not green needs the typed override as well as the confirm', () => {
    for (const rollup of [[{ conclusion: 'FAILURE' }], [{ state: 'PENDING' }], []]) {
      const pr = fresh({ baseRefName: 'main', statusCheckRollup: rollup });
      const d = decide(pr, { confirm: 'acme/alpha#5' });
      assert.equal(d.allow, false);
      assert.match(d.reason, /checks aren't green/);
      assert.deepEqual([d.needs.typed, d.needs.override, d.needs.live], [true, true, true]);
      assert.equal(decide(pr, { override: 'acme/alpha#5' }).allow, false, 'override alone is not the live confirm');
      assert.equal(decide(pr, { confirm: 'acme/alpha#5', override: true }).allow, false);
      assert.equal(decide(pr, { confirm: 'acme/alpha#5', override: 'acme/alpha#5' }).allow, true);
    }
    assert.match(decide(fresh({ baseRefName: 'main', statusCheckRollup: [{ conclusion: 'FAILURE' }, { conclusion: 'SUCCESS' }, { state: 'PENDING' }] })).reason, /\(1 passing, 1 failing, 1 pending\)/);
  });

  test('a refusal the owner can confirm past says what to type; one they cannot does not', () => {
    const undeclared = { ...PROJECTS[0], public: undefined };
    const d = decide(fresh({ baseRefName: 'master' }), { project: undeclared });
    assert.deepEqual([d.needs.phrase, d.needs.typed, d.needs.override], ['acme/alpha#5', true, false]);
    assert.deepEqual([decide(fresh({ baseRefName: 'main' })).needs.typed, decide(fresh({ baseRefName: 'main' })).needs.live], [false, true]);
    assert.equal(decide(fresh({ statusCheckRollup: [{ conclusion: 'FAILURE' }] })).needs, undefined, 'a red private PR has nothing to confirm');
  });

  test('a failed or old status poll refuses merges', () => {
    const now = Date.parse('2026-11-04T12:00:00Z');
    assert.equal(staleStatus({ at: '2026-11-04T11:59:00Z', error: null }, now), null);
    assert.match(staleStatus({ at: '2026-11-04T11:57:59Z', error: null }, now), /more than 2 minutes old/);
    assert.match(staleStatus({ at: null, error: null }, now), /more than 2 minutes old/);
    assert.match(staleStatus({ at: '2026-11-04T11:59:59Z', error: 'gh failed' }, now), /failed \(gh failed\)/);
  });

  test('stopping a session the queue did not start needs a confirm', () => {
    const tasks = [{ ...task(), sessionId: 'mine' }, { ...task(), sessionId: '1a2b3c4d' }];
    assert.equal(stopDecision({ sessionId: 'mine', tasks }).allow, true);
    assert.equal(stopDecision({ sessionId: '1a2b3c4d-0000-4000-8000-000000000000', tasks }).allow, true, 'a short id on the task matches');
    assert.equal(stopDecision({ sessionId: 'theirs', tasks }).allow, false);
    assert.equal(stopDecision({ sessionId: 'theirs', tasks, confirm: true }).allow, true);
  });
});
