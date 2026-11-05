import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, realpathSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { after, describe, test } from 'node:test';

const q = await import('../mc/queue.mjs');
const { sessionActivity, PLAN_TOOL } = await import('../mc/activity.mjs');
const { buildSnapshot } = await import('../mc/snapshot.mjs');

const tmp = realpathSync(mkdtempSync(join(tmpdir(), 'mc-work-test-')));
after(() => rmSync(tmp, { recursive: true, force: true }));
const ALPHA = join(tmp, 'alpha');
mkdirSync(ALPHA, { recursive: true });
const PROJECTS = [{ id: 'alpha', name: 'Alpha', checkouts: [ALPHA], public: { branches: ['main'], remotes: [], notes: [] }, repos: ['acme/alpha'] }];
const ROOTS = q.projectRoots(PROJECTS);
const SECRET = 'sk_live_abcdefghijklmnopqrstuv';

const pr = (number, branch, over = {}) => ({ number, title: `PR ${number}`, url: `https://github.com/acme/alpha/pull/${number}`, branch, base: 'main', checks: ['SUCCESS'], classification: 'review', ...over });
const status = { projects: [{ id: 'alpha', name: 'Alpha', checkouts: [{ path: ALPHA, prs: [pr(7, 'feature-x', { mergeable: 'CONFLICTING' }), pr(8, 'task/mc-aaaaaa')] }] }] };
const tool = (at, name, input) => ({ type: 'assistant', timestamp: at, message: { content: [{ type: 'tool_use', name, input }] } });

function snap() {
  const task = { ...q.createTask({ project: 'alpha', title: 'Queued work', prompt: 'p' }, { projects: PROJECTS, id: 'aaaaaa' }), state: 'working', sessionId: 'sess-task' };
  const busyAct = sessionActivity([
    { type: 'user', timestamp: '2026-11-04T10:00:00Z', message: { content: 'go' } },
    tool('2026-11-04T10:00:01Z', PLAN_TOOL, { items: [{ content: 'Plan it', status: 'completed' }, { content: `Rotate ${SECRET}`, status: 'in_progress' }] }),
    { type: 'assistant', timestamp: '2026-11-04T10:00:02Z', message: { content: [{ type: 'text', text: `The key is ${SECRET}` }] } },
    tool('2026-11-04T10:00:03Z', 'Edit', { file_path: join(ALPHA, 'a.js') }),
  ], { cwd: ALPHA });
  const idleAct = sessionActivity([tool('2026-11-04T09:00:00Z', 'Read', { file_path: join(ALPHA, 'b.js') })], { cwd: ALPHA });
  const sessions = [
    { sessionId: 'sess-idle', name: 'Idle chat', cwd: ALPHA, status: 'idle', startedAt: Date.parse('2026-11-04T08:00:00Z') },
    { sessionId: 'sess-busy', name: `Busy ${SECRET}`, cwd: ALPHA, status: 'busy', startedAt: Date.parse('2026-11-04T08:00:00Z') },
    { sessionId: 'sess-task', name: task.sessionName, cwd: `${ALPHA}-tasks/mc-aaaaaa`, status: 'busy' },
  ];
  const activity = new Map([
    ['sess-busy', { activity: busyAct, branch: 'feature-x' }],
    ['sess-idle', { activity: idleAct, branch: 'main' }],
    ['sess-task', { activity: null, branch: 'something-else' }],
  ]);
  const hours = Array.from({ length: 24 }, (_, i) => ({ start: new Date(i * 3_600_000).toISOString(), weighted: i, sessions: i % 3 }));
  return buildSnapshot({
    projects: PROJECTS, roots: ROOTS, status, sessions, tasks: [task], waiting: {}, settings: q.DEFAULT_SETTINGS, sweep: null, meta: {},
    activity, usage: { hours, today: 1234, top: [] },
  });
}

describe('work, feed and kpis', () => {
  test('a row per session, busy first, with plan step, last tool, last line and since', () => {
    const { work } = snap();
    assert.deepEqual(work.map((w) => w.sessionId), ['sess-busy', 'sess-task', 'sess-idle']);
    const busy = work[0];
    assert.equal(busy.projectName, 'Alpha');
    assert.deepEqual([busy.plan.step, busy.plan.total], [2, 2]);
    assert.equal(busy.doing.text, 'Editing a.js');
    assert.equal(busy.since, '2026-11-04T10:00:00Z', 'busy since the turn started');
    assert.equal(work[2].since, '2026-11-04T09:00:00Z', 'idle since its last activity');
  });

  test('a session finds its PR by its queue task first, else by the branch its folder has out', () => {
    const { work } = snap();
    const by = Object.fromEntries(work.map((w) => [w.sessionId, w.pr?.number ?? null]));
    assert.deepEqual(by, { 'sess-busy': 7, 'sess-task': 8, 'sess-idle': null });
    assert.equal(work[0].pr.conflict, true, 'a conflicting PR says so');
  });

  test('redacted secrets never appear in work or feed', () => {
    const s = snap();
    const out = JSON.stringify({ work: s.work, feed: s.feed });
    assert.ok(!out.includes(SECRET), out);
    assert.ok(s.feed.length >= 3);
    assert.deepEqual(s.feed.map((e) => e.at), [...s.feed.map((e) => e.at)].sort().reverse(), 'newest first');
  });

  test('kpis carry values and 12-point series where they are cheap', () => {
    const { kpis, lanes } = snap();
    assert.equal(kpis.working.value, 2);
    assert.equal(kpis.usageToday.value, 1234);
    assert.equal(kpis.usageToday.series.length, 12);
    assert.equal(kpis.usageToday.series[0], 0 + 1);
    assert.equal(kpis.working.series.length, 12);
    assert.equal(kpis.queueLength.series, null);
    assert.equal(kpis.prsWaiting.value, lanes.filter((l) => ['needs_you', 'ready_to_merge'].includes(l.id)).flatMap((l) => l.cards).filter((c) => c.pr).length);
    assert.ok(lanes.flatMap((l) => l.cards).some((c) => c.pr?.conflict), 'PR cards carry merge conflicts');
  });
});
