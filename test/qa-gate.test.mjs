import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { after, before, describe, test } from 'node:test';
import { fileURLToPath } from 'node:url';

const ROOT = realpathSync(join(fileURLToPath(import.meta.url), '..', '..'));
const GATE = join(ROOT, 'gate', 'qa-gate.mjs');

let repo;
let n = 0;
before(() => {
  repo = realpathSync(mkdtempSync(join(tmpdir(), 'qagate-')));
  spawnSync('git', ['init', '-q'], { cwd: repo });
  mkdirSync(join(repo, '.claude', 'loop'), { recursive: true });
});
after(() => rmSync(repo, { recursive: true, force: true }));

// A gate whose one step prints whatever is in out.txt and fails.
const session = (tries = 5) => {
  const sid = `s${++n}`;
  writeFileSync(join(repo, '.claude', 'gate.json'), JSON.stringify({ steps: [{ name: 'tests', run: 'cat out.txt; exit 1' }], tries }));
  writeFileSync(join(repo, '.claude', 'loop', `${sid}.json`), JSON.stringify({ goal: 'g', dir: repo, attempts: 0 }));
  return sid;
};
const output = (text) => writeFileSync(join(repo, 'out.txt'), text);
const stop = (sid) => {
  const r = spawnSync('node', [GATE], { input: JSON.stringify({ session_id: sid, cwd: repo }), encoding: 'utf8' });
  return JSON.parse(r.stdout).reason;
};
const GIVE_UP = /Stop and report/;

describe('gate loop convergence', () => {
  test('the same failure twice in a row ends the loop early', () => {
    const sid = session();
    output('not ok 1 - login works\n');
    assert.doesNotMatch(stop(sid), GIVE_UP);
    const second = stop(sid);
    assert.match(second, GIVE_UP);
    assert.match(second, /same way twice/);
    assert.match(second, /draft PR/);
  });

  test('different failures keep going', () => {
    const sid = session();
    output('not ok 1 - login works\n');
    assert.doesNotMatch(stop(sid), GIVE_UP);
    output('not ok 2 - logout works\n');
    assert.doesNotMatch(stop(sid), GIVE_UP);
    output('not ok 1 - login works\n');
    assert.doesNotMatch(stop(sid), GIVE_UP);
  });

  test('runs differing only in timestamps, durations, ports and paths count as the same', () => {
    const sid = session();
    output('Error: connect ECONNREFUSED localhost:3131 at /tmp/a1b2/app.js:4 (12ms) 2026-11-18T10:00:01Z\n');
    assert.doesNotMatch(stop(sid), GIVE_UP);
    output('Error: connect ECONNREFUSED localhost:3199 at /private/var/folders/ab/cdef12/T/x9/app.js:4 (340ms) 2026-11-19T22:41:09Z\n');
    assert.match(stop(sid), GIVE_UP);
  });

  test('passing lines that mention errors are not taken as the failure', () => {
    const sid = session();
    output('ok 1 - returns error on bad input\n# fail 0\nnot ok 2 - login works\n');
    assert.doesNotMatch(stop(sid), GIVE_UP);
    output('ok 1 - returns error on bad input\n# fail 0\nnot ok 3 - logout works\n');
    assert.doesNotMatch(stop(sid), GIVE_UP);
  });

  test('different files or routes are different failures', () => {
    const sid = session();
    output('FAIL /repo/a.test.ts\n');
    stop(sid);
    output('FAIL /repo/b.test.ts\n');
    assert.doesNotMatch(stop(sid), GIVE_UP);
    output('GET /api/users 500\nError: bad\n');
    stop(sid);
    output('GET /api/orders 500\nError: bad\n');
    assert.doesNotMatch(stop(sid), GIVE_UP);
  });

  test('fixing some failures, or noise lines, is not a repeat', () => {
    const sid = session();
    output('not ok 1 - a\nnot ok 2 - b\nnot ok 3 - c\n');
    stop(sid);
    output('not ok 1 - a\n');
    assert.doesNotMatch(stop(sid), GIVE_UP);
    output('npm WARN deprecated x\nconsole.error boom\nnot ok 1 - a\n');
    assert.match(stop(sid), GIVE_UP);
  });

  test('cargo-style passing summaries are not the failure', () => {
    const sid = session();
    output('test result: ok. 5 passed; 0 failed\nerror[E0308]: mismatched types\n');
    stop(sid);
    output('test result: ok. 6 passed; 0 failed\nerror[E0599]: no method\n');
    assert.doesNotMatch(stop(sid), GIVE_UP);
  });

  test('hex ids are normalized but plain numbers and words are not', () => {
    const sid = session();
    output('Error: job deadbeef1 failed on 1234567 defaced\n');
    stop(sid);
    output('Error: job cafe0123a failed on 1234567 defaced\n');
    assert.match(stop(sid), GIVE_UP);
    output('Error: job 1 failed on 1234567\n');
    const s2 = session();
    stop(s2);
    output('Error: job 1 failed on 7654321\n');
    assert.doesNotMatch(stop(s2), GIVE_UP);
  });

  test('turning the gate on or off clears stale dead ends', () => {
    const sid = 'sid-x';
    const dead = join(repo, '.claude', 'loop', `${sid}.deadends.md`);
    writeFileSync(join(repo, '.claude', 'gate.json'), JSON.stringify({ steps: [] }));
    for (const cmd of [['on', 'g'], ['off']]) {
      writeFileSync(dead, '- old\n');
      const r = spawnSync('node', [join(ROOT, 'gate', 'until-ready.mjs'), ...cmd], { cwd: repo, encoding: 'utf8', env: { ...process.env, CLAUDE_CODE_SESSION_ID: sid } });
      assert.equal(r.status, 0, r.stderr);
      assert.ok(!existsSync(dead), cmd[0]);
    }
  });

  test('a huge dead-ends file is capped to its tail', () => {
    const sid = session();
    writeFileSync(join(repo, '.claude', 'loop', `${sid}.deadends.md`), '- first-entry\n' + '- filler\n'.repeat(2000) + '- last-entry\n');
    output('not ok 1 - a\n');
    const r = stop(sid);
    assert.match(r, /last-entry/);
    assert.doesNotMatch(r, /first-entry/);
  });

  test('the signature is kept in .claude/loop', () => {
    const sid = session();
    output('not ok 1 - login works\n');
    stop(sid);
    const state = JSON.parse(readFileSync(join(repo, '.claude', 'loop', `${sid}.json`), 'utf8'));
    assert.equal(state.lastSignature, 'tests: 1 failing | not ok 1 - login works');
  });

  test('tries stays the hard cap', () => {
    const sid = session(2);
    output('not ok 1 - a\n');
    stop(sid);
    output('not ok 2 - b\n');
    assert.match(stop(sid), /still fails after 2 tries/);
  });

  test('dead ends are carried into the retry message and cleaned up at the end', () => {
    const sid = session();
    const dead = join(repo, '.claude', 'loop', `${sid}.deadends.md`);
    output('not ok 1 - a\n');
    assert.match(stop(sid), new RegExp(`append one line to ${dead.replace(/[.]/g, '\\.')}`));
    writeFileSync(dead, '- bumped the timeout: no change\n');
    output('not ok 2 - b\n');
    const retry = stop(sid);
    assert.match(retry, /Dead ends so far/);
    assert.match(retry, /bumped the timeout: no change/);
    output('not ok 3 - c\n');
    stop(sid);
    output('not ok 3 - c\n');
    assert.match(stop(sid), /bumped the timeout: no change/);
    assert.ok(!existsSync(dead));
  });
});
