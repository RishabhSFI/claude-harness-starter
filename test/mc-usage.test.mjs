import assert from 'node:assert/strict';
import { appendFileSync, mkdirSync, mkdtempSync, realpathSync, rmSync, utimesSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { after, describe, test } from 'node:test';

const { createUsageTracker, weigh } = await import('../mc/usage.mjs');

const tmp = realpathSync(mkdtempSync(join(tmpdir(), 'mc-usage-test-')));
after(() => rmSync(tmp, { recursive: true, force: true }));

const NOW = Date.now();
const iso = (msAgo) => new Date(NOW - msAgo).toISOString();
const msg = (id, msAgo, usage, extra = {}) =>
  `${JSON.stringify({ type: 'assistant', timestamp: iso(msAgo), cwd: '/work/alpha', message: { id, role: 'assistant', usage, content: [{ type: 'text', text: 'hi' }] }, ...extra })}\n`;
const U = { input_tokens: 10, cache_creation_input_tokens: 100, cache_read_input_tokens: 1000, output_tokens: 20 };
const W = 10 + 125 + 100 + 100;

describe('usage', () => {
  test('weighs input 1, cache write 1.25, cache read 0.1, output 5', () => {
    assert.equal(weigh(U), W);
    assert.equal(weigh({}), 0);
  });

  const dir = join(tmp, 'projects');
  const folder = join(dir, '-Users-me-Projects-alpha');
  const main = join(folder, 'aaaaaaaa-0000-4000-8000-000000000000.jsonl');
  const helperDir = join(folder, 'aaaaaaaa-0000-4000-8000-000000000000', 'subagents');

  test('counts each message once, gives helpers to their parent, and reads only new bytes', async () => {
    mkdirSync(helperDir, { recursive: true });
    writeFileSync(main, msg('m1', 60_000, U) + msg('m1', 59_000, U) + msg('m2', 30 * 3_600_000, U) + 'not json\n');
    writeFileSync(join(helperDir, 'agent-x.jsonl'), msg('h1', 120_000, U, { isSidechain: true }));
    writeFileSync(join(folder, 'bbbbbbbb-0000-4000-8000-000000000000.jsonl'), `${JSON.stringify({ type: 'custom-title', customTitle: 'Other chat', sessionId: 'bbbbbbbb-0000-4000-8000-000000000000' })}\n${msg('b1', 60_000, U)}`);
    const t = createUsageTracker({ projectsDir: dir });
    await t.refresh(NOW);
    let s = t.summary({ now: NOW });
    const a = s.top.find((x) => x.sessionId.startsWith('aaaaaaaa'));
    assert.equal(a.weighted, 2 * W, 'm1 once (split lines share an id), h1 from its helper, m2 is older than 24 h');
    assert.equal(s.top.find((x) => x.sessionId.startsWith('bbbbbbbb')).name, 'Other chat');
    assert.equal(a.projectName, 'alpha', 'with no live session, the folder name stands in');
    assert.equal(s.hours.length, 24);
    assert.equal(s.hours.reduce((n, h) => n + h.weighted, 0), 3 * W);

    const half = msg('m3', 1_000, U);
    appendFileSync(main, half.slice(0, 40));
    await t.refresh(NOW);
    assert.equal(t.summary({ now: NOW }).top.find((x) => x.sessionId === a.sessionId).weighted, 2 * W, 'a half-written line waits');
    appendFileSync(main, half.slice(40) + msg('m1', 500, U));
    await t.refresh(NOW);
    s = t.summary({ now: NOW, sessions: [{ sessionId: a.sessionId, name: 'Live name', cwd: '/work/alpha' }], roots: [{ id: 'alpha', root: '/work/alpha' }], projects: [{ id: 'alpha', name: 'Alpha' }] });
    const live = s.top.find((x) => x.sessionId === a.sessionId);
    assert.equal(live.weighted, 3 * W, 'the rest of the line is read; a repeat of m1 still counts once');
    assert.deepEqual([live.name, live.project, live.projectName], ['Live name', 'alpha', 'Alpha']);
  });

  test('a message streamed over several lines counts at its largest usage', async () => {
    const d = join(tmp, 'stream');
    mkdirSync(join(d, 'f'), { recursive: true });
    const small = { ...U, output_tokens: 1 };
    writeFileSync(join(d, 'f', 'cccccccc-0000-4000-8000-000000000000.jsonl'), msg('s1', 3_000, small) + msg('s1', 2_000, U) + msg('s1', 1_000, small));
    const t = createUsageTracker({ projectsDir: d });
    await t.refresh(NOW);
    assert.equal(t.summary({ now: NOW }).top[0].weighted, W);
  });

  test('forgets transcripts untouched for 24 hours', async () => {
    const d = join(tmp, 'prune');
    mkdirSync(join(d, 'f'), { recursive: true });
    const old = join(d, 'f', 'dddddddd-0000-4000-8000-000000000000.jsonl');
    writeFileSync(old, msg('o1', 1_000, U));
    writeFileSync(join(d, 'f', 'eeeeeeee-0000-4000-8000-000000000000.jsonl'), msg('e1', 1_000, U));
    const t = createUsageTracker({ projectsDir: d });
    await t.refresh(NOW);
    assert.deepEqual(t.held, { files: 2, sessions: 2 });
    const stale = (NOW - 25 * 3_600_000) / 1000;
    utimesSync(old, stale, stale);
    await t.refresh(NOW);
    assert.deepEqual(t.held, { files: 1, sessions: 1 });
  });

  test('today counts only since local midnight', async () => {
    const d = join(tmp, 'today');
    mkdirSync(join(d, 'f'), { recursive: true });
    const midnight = new Date(NOW);
    midnight.setHours(0, 0, 0, 0);
    const sinceMidnight = NOW - midnight.getTime();
    writeFileSync(join(d, 'f', 'cccccccc-0000-4000-8000-000000000000.jsonl'), msg('t1', Math.max(0, sinceMidnight - 1000), U) + msg('t2', sinceMidnight + 60_000, U));
    const t = createUsageTracker({ projectsDir: d });
    await t.refresh(NOW);
    assert.equal(t.summary({ now: NOW }).today, W);
  });
});
