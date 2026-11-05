import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { after, describe, test } from 'node:test';

process.env.TZ = 'America/New_York';
const { buildLanes, buildSnapshot } = await import('../mc/snapshot.mjs');

const COS = join(import.meta.dirname, '..', 'cos.mjs');
const tmp = realpathSync(mkdtempSync(join(tmpdir(), 'mc-merged-')));
after(() => rmSync(tmp, { recursive: true, force: true }));

const NOW = new Date('2026-11-05T01:45:00Z');
const url = (n) => `https://github.com/acme/alpha/pull/${n}`;
const merged = (n, mergedAt) => ({ number: n, title: `PR ${n}`, branch: `b${n}`, base: 'main', url: url(n), mergedAt });
const statusWith = (list) => ({ projects: [{ id: 'alpha', name: 'Alpha', checkouts: [{ path: '/a', prs: [], merged: list }, { path: '/a2', prs: [], merged: list }] }] });
const mergedToday = (lanes) => lanes.find((l) => l.id === 'merged_today').cards.map((c) => c.pr?.number);

function snapshot(status, tasks = []) {
  return buildSnapshot({
    projects: [{ id: 'alpha', name: 'Alpha', checkouts: ['/a'] }], roots: [], status, sessions: [], tasks,
    settings: { cap: 3, paused: false, pauseReason: null }, waiting: {}, sweep: null, meta: {}, now: NOW,
  });
}

describe('Merged today counts PRs merged on GitHub', () => {
  test('a PR merged outside the dashboard on the local day counts, once across two checkouts', () => {
    const snap = snapshot(statusWith([merged(8, '2026-11-05T01:43:00Z')]));
    assert.deepEqual(mergedToday(snap.lanes), [8]);
    assert.equal(snap.kpis.mergedToday.value, 1);
  });

  test('a PR merged just before local midnight yesterday does not count, though it is the same UTC day as one that does', () => {
    const lanes = buildLanes([], [], NOW, [merged(7, '2026-11-04T04:59:00Z'), merged(8, '2026-11-04T05:01:00Z')]);
    assert.deepEqual(mergedToday(lanes), [8]);
  });

  test('a merged queue task with the same PR URL shows one card', () => {
    const task = { id: 't1', project: 'alpha', title: 'Queued work', state: 'merged', branch: 'b8', updatedAt: '2026-11-05T01:44:00Z', pr: { url: url(8), number: 8 } };
    const snap = snapshot(statusWith([merged(8, '2026-11-05T01:43:00Z')]), [task]);
    const cards = snap.lanes.find((l) => l.id === 'merged_today').cards;
    assert.deepEqual(cards.map((c) => c.title), ['Queued work']);
    assert.equal(snap.kpis.mergedToday.value, 1);
  });

  test('a merged queue task that never saw its PR open shows one card, matched by project and branch', () => {
    const task = { id: 't2', project: 'alpha', title: 'Fast merge', state: 'merged', branch: 'b9', updatedAt: '2026-11-05T01:44:00Z', pr: null };
    const other = { ...merged(10, '2026-11-05T01:40:00Z'), project: 'beta', branch: 'b9' };
    const lanes = buildLanes([task], [], NOW, [{ ...merged(9, '2026-11-05T01:43:00Z'), project: 'alpha' }, other]);
    const cards = lanes.find((l) => l.id === 'merged_today').cards;
    assert.deepEqual(cards.map((c) => c.title), ['Fast merge', 'PR 10'], 'the same branch name in another project still counts');
  });
});

describe('cos status lists merged PRs apart from open ones', () => {
  test('--fake-merged fills checkout.merged and leaves prs and the text report alone', () => {
    const repo = join(tmp, 'repo');
    execFileSync('git', ['init', '-q', '-b', 'main', repo]);
    const prs = join(tmp, 'prs.json');
    const done = join(tmp, 'merged.json');
    writeFileSync(prs, '[]');
    writeFileSync(done, JSON.stringify([{ number: 5, title: 'Shipped', url: 'https://x/5', mergedAt: '2026-11-05T01:43:00Z', headRefName: 'f', baseRefName: 'main' }]));
    const reg = join(tmp, 'projects.json');
    writeFileSync(reg, JSON.stringify({ projects: [{ id: 'r', name: 'R', checkouts: [repo] }] }));
    const run = (...extra) => execFileSync(process.execPath, [COS, 'status', '--registry', reg, '--fake-prs', prs, ...extra], { encoding: 'utf8' });
    const c = JSON.parse(run('--json', '--fake-merged', done)).projects[0].checkouts[0];
    assert.deepEqual(c.prs, []);
    assert.deepEqual(c.merged, [{ number: 5, title: 'Shipped', branch: 'f', base: 'main', url: 'https://x/5', mergedAt: '2026-11-05T01:43:00Z' }]);
    assert.equal(JSON.parse(run('--json')).projects[0].checkouts[0].merged.length, 0);
    assert.equal(run('--fake-merged', done), run());
  });
});
