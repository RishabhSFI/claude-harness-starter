import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { request } from 'node:http';
import { createServer as netServer } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { after, before, describe, test } from 'node:test';

const { createMissionControl } = await import('../mc/server.mjs');

const tmp = realpathSync(mkdtempSync(join(tmpdir(), 'mc-secrets-server-test-')));
after(() => rmSync(tmp, { recursive: true, force: true }));

const GIT_ENV = { ...process.env, GIT_AUTHOR_NAME: 't', GIT_AUTHOR_EMAIL: 't@example.com', GIT_COMMITTER_NAME: 't', GIT_COMMITTER_EMAIL: 't@example.com', GIT_CONFIG_GLOBAL: '/dev/null', GIT_CONFIG_SYSTEM: '/dev/null' };
const ALPHA = join(tmp, 'alpha');
const GH = join(tmp, 'gh');
const GH_LOG = join(tmp, 'gh.log');
const REGISTRY = join(tmp, 'projects.json');
const CACHE = join(tmp, '.claude', 'secrets-cache.json');

const listCalls = () => (existsSync(GH_LOG) ? readFileSync(GH_LOG, 'utf8').split('\n').filter((l) => /^\["(secret|variable)"/.test(l)).length : 0);
const freePort = () => new Promise((done) => {
  const s = netServer().listen(0, '127.0.0.1', () => {
    const { port } = s.address();
    s.close(() => done(port));
  });
});
const waitFor = async (fn, what, ms = 15000) => {
  const end = Date.now() + ms;
  for (;;) {
    const v = await fn();
    if (v) return v;
    if (Date.now() > end) throw new Error(`timed out waiting for ${what}`);
    await new Promise((r) => setTimeout(r, 25));
  }
};

describe('background key checks', () => {
  let mc;
  let port;
  const call = (path, { method = 'GET', body, headers = {} } = {}) => new Promise((done, fail) => {
    const req = request({ host: '127.0.0.1', port, method, path, headers: { Host: `127.0.0.1:${port}`, Authorization: `Bearer ${mc.token}`, ...headers } }, (res) => {
      let data = '';
      res.on('data', (c) => (data += c));
      res.on('end', () => done({ status: res.statusCode, json: JSON.parse(data || 'null') }));
    });
    req.on('error', fail);
    if (body !== undefined) req.write(JSON.stringify(body));
    req.end();
  });
  const state = async () => (await call('/api/state')).json;

  before(async () => {
    mkdirSync(ALPHA, { recursive: true });
    execFileSync('git', ['init', '-b', 'main'], { cwd: ALPHA, env: GIT_ENV, stdio: 'pipe' });
    writeFileSync(GH, `#!/bin/sh\necho "[\\"$1\\",\\"$2\\"]" >> "${GH_LOG}"\ncase "$1" in secret|variable) sleep 0.4; echo '[]' ;; *) echo '[]' ;; esac\n`);
    chmodSync(GH, 0o755);
    writeFileSync(REGISTRY, JSON.stringify({ projects: [{ id: 'alpha', name: 'Alpha', what: 'x', checkouts: [ALPHA], repos: ['acme/alpha'], secrets: [{ name: 'API_KEY', where: 'github:acme/alpha', purpose: 'the api', required: true }] }] }));
    process.env.GH_BIN = GH;
    port = await freePort();
    mc = createMissionControl({
      port, registryFile: REGISTRY, stateDir: join(tmp, 'state'), tokenFile: join(tmp, 'home', 'token'), projectsDir: join(tmp, 'projects'), claudeBin: null, ghBin: GH,
      intervals: { sessionsMs: 3_600_000, statusMs: 3_600_000, sweepMs: 3_600_000, usageMs: 3_600_000, pausedMs: 3_600_000 },
    });
    await mc.listen();
  });
  after(() => mc?.close());

  test('the first check starts with the server, is single-flight, and its answers reach the page without a status run', async () => {
    await waitFor(() => Boolean(mc.state.secretsRun), 'the first check to start');
    assert.equal((await state()).meta.secretsRunning, true);
    assert.equal(mc.refreshSecrets({ force: true }), mc.state.secretsRun, 'a request while one runs gets the running one');
    await waitFor(() => !mc.state.secretsRun && mc.state.at.status, 'the check and first status to finish');
    assert.equal(listCalls(), 2, 'one secret list and one variable list, from one run');
    const statusAt = mc.state.at.status;
    const snap = await state();
    assert.equal(snap.meta.secretsRunning, false);
    assert.ok(snap.moves.some((m) => m.id === 'key:alpha:github:acme/alpha'), 'the missing key is a move');
    assert.ok(snap.moves.find((m) => m.kind === 'key').checkedAt, 'with the time it was checked');
    assert.equal(mc.state.at.status, statusAt);
  });

  test('a fresh cache means a status tick starts no check', async () => {
    const before = listCalls();
    assert.equal(mc.refreshSecrets(), null);
    await mc.refreshStatus();
    assert.equal(mc.state.secretsRun, null);
    assert.equal(listCalls(), before);
  });

  test('an old cache starts one on the next status tick', async () => {
    const cache = JSON.parse(readFileSync(CACHE, 'utf8'));
    writeFileSync(CACHE, JSON.stringify({ ...cache, at: Date.now() - 31 * 60_000 }));
    const before = listCalls();
    const status = mc.refreshStatus();
    assert.ok(mc.state.secretsRun, 'started by the tick itself');
    await Promise.all([mc.state.secretsRun, status]);
    assert.equal(listCalls(), before + 2);
  });

  test('a check that leaves no fresh answers does not run again on the next tick', async () => {
    rmSync(CACHE);
    mkdirSync(CACHE);
    try {
      await mc.refreshSecrets({ force: true });
      const before = listCalls();
      await mc.refreshStatus();
      assert.equal(mc.state.secretsRun, null);
      assert.equal(listCalls(), before, 'an unwritable cache must not mean a check every poll');
    } finally {
      rmSync(CACHE, { recursive: true });
    }
  });

  test('POST /api/secrets/refresh forces a run even when the cache is fresh, and is guarded like the other POSTs', async () => {
    const headers = { Origin: `http://127.0.0.1:${port}`, 'Content-Type': 'application/json' };
    assert.equal((await call('/api/secrets/refresh', { method: 'POST', body: {}, headers: { ...headers, Origin: 'http://evil.example' } })).status, 403);
    assert.equal((await call('/api/secrets/refresh', { method: 'GET' })).status, 405);
    const before = listCalls();
    const r = await call('/api/secrets/refresh', { method: 'POST', body: {}, headers });
    assert.equal(r.status, 200);
    assert.equal(r.json.running, true);
    assert.equal((await state()).meta.secretsRunning, true);
    await waitFor(() => !mc.state.secretsRun, 'the forced check to finish');
    assert.equal(listCalls(), before + 2);
  });
});
