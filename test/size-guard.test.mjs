import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { existsSync, mkdtempSync, readdirSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { after, before, describe, test } from 'node:test';
import { fileURLToPath } from 'node:url';

const ROOT = realpathSync(join(fileURLToPath(import.meta.url), '..', '..'));
const { latestHistory, sizeWarning } = await import(join(ROOT, 'size-guard.mjs'));

const reply = (read, extra = {}) =>
  JSON.stringify({ type: 'assistant', message: { id: 'm', usage: { input_tokens: 2, cache_creation_input_tokens: 500, cache_read_input_tokens: read, output_tokens: 9 } }, ...extra });

let tmp;
let state;
before(() => {
  tmp = realpathSync(mkdtempSync(join(tmpdir(), 'size-')));
  state = join(tmp, 'state');
});
after(() => rmSync(tmp, { recursive: true, force: true }));

const transcript = (name, lines) => {
  const p = join(tmp, name);
  writeFileSync(p, lines.join('\n') + '\n');
  return p;
};

describe('size guard', () => {
  test('latest history is input + cache write + cache read of the last main-chat reply', () => {
    const p = transcript('a.jsonl', [reply(10_000), reply(50_000), reply(900_000, { isSidechain: true }), JSON.stringify({ type: 'user', message: { content: 'hi' } })]);
    assert.equal(latestHistory(p), 2 + 500 + 50_000);
    assert.equal(latestHistory(join(tmp, 'missing.jsonl')), null);
  });

  test('reads only the tail of a big transcript', () => {
    const filler = JSON.stringify({ type: 'user', message: { content: 'x'.repeat(2_000_000) } });
    const p = transcript('big.jsonl', [reply(10), filler, reply(130_000)]);
    assert.equal(latestHistory(p), 2 + 500 + 130_000);
  });

  test('stays quiet under the threshold', () => {
    const p = transcript('small.jsonl', [reply(100_000)]);
    assert.equal(sizeWarning({ transcriptPath: p, sessionId: 's-small', stateDir: state }), null);
  });

  test('warns once at the threshold, again only 60k later', () => {
    const args = (read) => ({ transcriptPath: transcript('grow.jsonl', [reply(read)]), sessionId: 's-grow', stateDir: state });
    const first = sizeWarning(args(125_000));
    assert.match(first, /about 126k tokens/);
    assert.match(first, /fresh session/);
    assert.equal(sizeWarning(args(150_000)), null);
    assert.equal(sizeWarning(args(184_000)), null);
    assert.match(sizeWarning(args(190_000)), /about 191k tokens/);
    assert.equal(sizeWarning(args(191_000)), null);
  });

  test('sessions keep separate markers and an unsafe session id is ignored', () => {
    const p = transcript('b.jsonl', [reply(200_000)]);
    assert.ok(sizeWarning({ transcriptPath: p, sessionId: 's-one', stateDir: state }));
    assert.ok(sizeWarning({ transcriptPath: p, sessionId: 's-two', stateDir: state }));
    assert.equal(sizeWarning({ transcriptPath: p, sessionId: '../escape', stateDir: state }), null);
    assert.ok(!existsSync(join(tmp, 'escape')));
    assert.ok(readdirSync(state).includes('s-one'));
  });

  test('the hook prints the warning for a long chat and nothing for a short one', () => {
    const registry = join(tmp, 'projects.json');
    writeFileSync(registry, JSON.stringify({ projects: [{ id: 'a', name: 'Alpha', what: 'x', checkouts: [tmp] }] }));
    const run = (p, id) =>
      spawnSync('node', [join(ROOT, 'cos.mjs'), 'hook', '--registry', registry], {
        input: JSON.stringify({ prompt: 'hello', cwd: tmp, transcript_path: p, session_id: id }),
        env: { ...process.env, COS_SIZE_STATE_DIR: join(tmp, 'hook-state') },
        encoding: 'utf8',
      });
    const long = run(transcript('long.jsonl', [reply(300_000)]), 'h-long');
    assert.equal(long.status, 0, long.stderr);
    assert.match(long.stdout, /history is about 301k tokens/);
    assert.equal(run(transcript('long.jsonl', [reply(310_000)]), 'h-long').stdout, '');
    assert.equal(run(transcript('short.jsonl', [reply(5_000)]), 'h-short').stdout, '');
  });
});
