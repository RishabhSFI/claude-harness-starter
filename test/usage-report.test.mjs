import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { after, before, describe, test } from 'node:test';
import { fileURLToPath } from 'node:url';

const ROOT = realpathSync(join(fileURLToPath(import.meta.url), '..', '..'));
const { collect, capped, summarize, weigh, labelFolder } = await import(join(ROOT, 'usage-report.mjs'));

const NOW = Date.parse('2026-11-07T12:00:00Z');
const line = (id, at, usage, extra = {}) =>
  JSON.stringify({ type: 'assistant', timestamp: at, requestId: `req_${id}`, message: { id, model: 'claude-opus-5-5', usage, content: [{ type: 'text', text: 'SECRET-TRANSCRIPT-TEXT' }] }, ...extra });
const u = (input, write, read, output) => ({ input_tokens: input, cache_creation_input_tokens: write, cache_read_input_tokens: read, output_tokens: output });

let dir;
before(() => {
  dir = realpathSync(mkdtempSync(join(tmpdir(), 'usage-')));
  const folder = join(dir, '-Users-someone-Projects-alpha');
  mkdirSync(join(folder, 'abcdef123456', 'subagents'), { recursive: true });
  writeFileSync(
    join(folder, 'abcdef123456.jsonl'),
    [
      line('m1', '2026-11-07T10:00:00Z', u(10, 1000, 199_000, 100)),
      line('m1', '2026-11-07T10:00:01Z', u(10, 1000, 199_000, 400)),
      line('m2', '2026-11-07T10:05:00Z', u(10, 500, 49_000, 50)),
      line('old', '2026-11-01T10:00:00Z', u(10, 500, 49_000, 50)),
      'not json "usage" "assistant"',
    ].join('\n'),
  );
  writeFileSync(join(folder, 'abcdef123456', 'subagents', 'agent-x.jsonl'), line('s1', '2026-11-07T11:00:00Z', u(5, 100, 9_000, 10), { isSidechain: true }));
});
after(() => rmSync(dir, { recursive: true, force: true }));

describe('usage report', () => {
  test('dedupes a streamed message at its largest usage and honours the window', () => {
    const rs = collect(dir, { hours: 48, now: NOW });
    assert.equal(rs.length, 3);
    assert.equal(rs.find((r) => r.read === 199_000).output, 400);
    assert.equal(rs.filter((r) => r.sub).length, 1);
  });

  test('weights follow the price ratios', () => {
    assert.equal(weigh({ input: 100, write: 100, read: 1000, output: 10 }), 100 + 125 + 100 + 50);
  });

  test('the cap trims only the cache read of replies above it', () => {
    const rs = collect(dir, { hours: 48, now: NOW });
    const c = capped(rs, 100_000);
    assert.equal(c.over, 1);
    assert.ok(c.newW < c.total);
    const big = rs.find((r) => r.read === 199_000);
    assert.equal(c.total - c.newW, weigh(big) - weigh({ ...big, read: 100_000 - big.input - big.write }));
  });

  test('summary labels chats by folder and short id, and prints no transcript text', () => {
    const out = summarize(collect(dir, { hours: 48, now: NOW }), { cap: 100_000 });
    assert.match(out, /alpha abcdef12/);
    assert.match(out, /Subagents \d+%/);
    assert.ok(!out.includes('SECRET-TRANSCRIPT-TEXT'));
    assert.ok(!out.includes('someone'));
  });

  test('labelFolder drops the home part and marks worktrees', () => {
    assert.equal(labelFolder('-Users-me-Projects-claude-harness--claude-worktrees-x-123'), 'claude-harness (worktree)');
  });

  test('the cos usage command runs on a fixture dir', () => {
    const r = spawnSync('node', [join(ROOT, 'cos.mjs'), 'usage', '--projects-dir', dir, '--hours', '100000'], { encoding: 'utf8' });
    assert.equal(r.status, 0, r.stderr);
    assert.match(r.stdout, /Usage, last 100000h/);
  });
});
