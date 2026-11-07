import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { after, before, describe, test } from 'node:test';
import { fileURLToPath } from 'node:url';

const ROOT = realpathSync(join(fileURLToPath(import.meta.url), '..', '..'));
const { latestHistory, firstHistory, sizeWarning } = await import(join(ROOT, 'size-guard.mjs'));

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

  test('firstHistory is the first main-chat reply, ignoring sidechains and a missing file', () => {
    const p = transcript('f.jsonl', [reply(900_000, { isSidechain: true }), reply(90_000), reply(150_000)]);
    assert.equal(firstHistory(p), 2 + 500 + 90_000);
    assert.equal(firstHistory(join(tmp, 'missing.jsonl')), null);
    assert.equal(firstHistory(transcript('nouse.jsonl', [JSON.stringify({ type: 'user', message: { content: 'hi' } })])), null);
  });

  test('a fresh chat that starts big stays quiet until it grows', () => {
    const args = (...reads) => ({ transcriptPath: transcript('fresh.jsonl', reads.map((r) => reply(r))), sessionId: 's-fresh', stateDir: state });
    assert.equal(sizeWarning(args(123_000)), null);
    assert.equal(sizeWarning(args(123_000, 150_000)), null);
    assert.equal(sizeWarning(args(123_000, 150_000, 123_000 + 79_000)), null);
    assert.equal(readFileSync(join(state, 'base', 's-fresh'), 'utf8'), String(2 + 500 + 123_000));
  });

  test('warns once at 80k of growth, states the growth, and again only 60k later', () => {
    const args = (read) => ({ transcriptPath: transcript('grow.jsonl', [reply(90_000), reply(read)]), sessionId: 's-grow', stateDir: state });
    const first = sizeWarning(args(175_000));
    assert.match(first, /about 176k tokens, up 85k from 91k when it started/);
    assert.match(first, /fresh session/);
    assert.equal(sizeWarning(args(200_000)), null);
    assert.equal(sizeWarning(args(234_000)), null);
    assert.match(sizeWarning(args(236_000)), /about 237k tokens, up 146k from 91k/);
    assert.equal(sizeWarning(args(240_000)), null);
  });

  test('the baseline is kept from the first call even when the transcript head changes', () => {
    const id = 's-keep';
    sizeWarning({ transcriptPath: transcript('k1.jsonl', [reply(50_000)]), sessionId: id, stateDir: state });
    const late = transcript('k2.jsonl', [reply(100_000), reply(140_000)]);
    assert.match(sizeWarning({ transcriptPath: late, sessionId: id, stateDir: state }), /up 90k from 51k/);
  });

  test('growth is measured exactly at the boundary and zero-usage replies are not a baseline', () => {
    const at = (read) => ({ transcriptPath: transcript('edge.jsonl', [reply(100_000), reply(read)]), sessionId: 's-edge', stateDir: state });
    assert.equal(sizeWarning(at(100_000 + 79_999)), null);
    assert.ok(sizeWarning(at(100_000 + 80_000)));
    const zero = JSON.stringify({ type: 'assistant', message: { usage: { input_tokens: 0, output_tokens: 0 } } });
    const p = transcript('zero.jsonl', [zero, reply(100_000), reply(130_000)]);
    assert.equal(firstHistory(p), 2 + 500 + 100_000);
    assert.equal(sizeWarning({ transcriptPath: p, sessionId: 's-zero', stateDir: state }), null);
  });

  test('a compacted chat is re-based so it can warn again', () => {
    const run = (...reads) => sizeWarning({ transcriptPath: transcript('cmp.jsonl', reads.map((r) => reply(r))), sessionId: 's-cmp', stateDir: state });
    assert.ok(run(100_000, 190_000));
    assert.equal(run(100_000, 190_000, 30_000), null);
    assert.match(run(100_000, 190_000, 30_000, 120_000), /up 90k from 31k/);
  });

  test('a corrupt baseline file is ignored and rewritten', () => {
    mkdirSync(join(state, 'base'), { recursive: true });
    writeFileSync(join(state, 'base', 's-bad'), 'not a number');
    const p = transcript('bad.jsonl', [reply(100_000), reply(190_000)]);
    assert.match(sizeWarning({ transcriptPath: p, sessionId: 's-bad', stateDir: state }), /up 90k from 101k/);
    assert.equal(readFileSync(join(state, 'base', 's-bad'), 'utf8'), String(2 + 500 + 100_000));
  });

  test('without a baseline the backstop applies', () => {
    const tailOnly = transcript('nobase2.jsonl', ['{"type":"user"}', reply(400_000, { isSidechain: true })]);
    assert.equal(sizeWarning({ transcriptPath: tailOnly, sessionId: 's-nb1', stateDir: state }), null);
    const big = transcript('nobase3.jsonl', [JSON.stringify({ type: 'user', message: { content: 'x'.repeat(2_000_000) } }), reply(260_000)]);
    const msg = sizeWarning({ transcriptPath: big, sessionId: 's-nb2', stateDir: state });
    assert.match(msg, /about 261k tokens\b/);
    assert.ok(!/from/.test(msg));
    const under = transcript('nobase4.jsonl', [JSON.stringify({ type: 'user', message: { content: 'x'.repeat(2_000_000) } }), reply(200_000)]);
    assert.equal(sizeWarning({ transcriptPath: under, sessionId: 's-nb3', stateDir: state }), null);
  });

  test('a missing transcript gives no warning and sidechain replies never count', () => {
    assert.equal(sizeWarning({ transcriptPath: join(tmp, 'gone.jsonl'), sessionId: 's-gone', stateDir: state }), null);
    const p = transcript('side.jsonl', [reply(90_000), reply(500_000, { isSidechain: true })]);
    assert.equal(sizeWarning({ transcriptPath: p, sessionId: 's-side', stateDir: state }), null);
  });

  test('sessions keep separate markers and an unsafe session id is ignored', () => {
    const p = transcript('b.jsonl', [reply(10_000), reply(200_000)]);
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
    const long = run(transcript('long.jsonl', [reply(60_000), reply(300_000)]), 'h-long');
    assert.equal(long.status, 0, long.stderr);
    assert.match(long.stdout, /history is about 301k tokens, up 240k from 61k/);
    assert.equal(run(transcript('long.jsonl', [reply(60_000), reply(310_000)]), 'h-long').stdout, '');
    assert.equal(run(transcript('short.jsonl', [reply(5_000), reply(9_000)]), 'h-short').stdout, '');
  });
});
