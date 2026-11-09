import assert from 'node:assert/strict';
import { execFileSync, spawnSync } from 'node:child_process';
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { request } from 'node:http';
import { createServer as netServer } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { after, before, describe, test } from 'node:test';

const q = await import('../mc/queue.mjs');
const { createMissionControl } = await import('../mc/server.mjs');

const GIT_ENV = { ...process.env, GIT_AUTHOR_NAME: 't', GIT_AUTHOR_EMAIL: 't@example.com', GIT_COMMITTER_NAME: 't', GIT_COMMITTER_EMAIL: 't@example.com', GIT_CONFIG_GLOBAL: '/dev/null', GIT_CONFIG_SYSTEM: '/dev/null' };
const git = (cwd, ...args) => execFileSync('git', args, { cwd, env: GIT_ENV, stdio: 'pipe' }).toString();

const tmp = realpathSync(mkdtempSync(join(tmpdir(), 'mc-server-test-')));
after(() => rmSync(tmp, { recursive: true, force: true }));

const ALPHA = join(tmp, 'alpha');
const BETA = join(tmp, 'beta');
const PROJECTS = [
  { id: 'alpha', name: 'Alpha', checkouts: [ALPHA], public: { branches: ['main'], remotes: [], notes: [] }, repos: ['acme/alpha'] },
  { id: 'beta', name: 'Beta', checkouts: [BETA], public: { branches: ['main'], remotes: ['site'], notes: [] }, repos: ['acme/beta'] },
];


const BIN = join(tmp, 'bin');
const FAKE = {
  claudeLog: join(tmp, 'claude.log'), ghLog: join(tmp, 'gh.log'), agents: join(tmp, 'agents.json'), prs: join(tmp, 'prs.json'), view: join(tmp, 'view.json'),
  limit: join(tmp, 'limit'), limitText: join(tmp, 'limit-text'), short: join(tmp, 'short'), silent: join(tmp, 'silent'), stopGone: join(tmp, 'stop-gone'), slow: join(tmp, 'slow'),
};
const SESSION_UUID = '11111111-2222-4333-8444-555555555555';
const SHORT_UUID = '1a2b3c4d-9999-4999-8999-999999999999';

function writeFakes() {
  mkdirSync(BIN, { recursive: true });
  writeFileSync(join(BIN, 'claude'), `#!/usr/bin/env node
const fs = require('fs');
const args = process.argv.slice(2);
fs.appendFileSync(${JSON.stringify(FAKE.claudeLog)}, JSON.stringify({ args, cwd: process.cwd() }) + '\\n');
const has = (k) => fs.existsSync(F[k]);
const F = ${JSON.stringify(FAKE)};
if (args[0] === 'agents') {
  if (has('slow')) Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 300);
  process.stdout.write(has('agents') ? fs.readFileSync(F.agents, 'utf8') : '[]');
  process.exit(0);
}
if (args.includes('--bg')) {
  if (has('limit')) { process.stderr.write('Claude usage limit reached. Resets at 5pm.'); process.exit(1); }
  if (has('limitText')) { process.stdout.write('Started in the background: ${SESSION_UUID}\\nYou are close to your usage limit.\\n'); process.exit(0); }
  if (has('short')) {
    const agents = has('agents') ? JSON.parse(fs.readFileSync(F.agents, 'utf8')) : [];
    agents.push({ sessionId: '${SHORT_UUID}', name: args[2] + ' (2)', cwd: process.cwd(), kind: 'background', status: 'busy' });
    fs.writeFileSync(F.agents, JSON.stringify(agents));
    process.stdout.write('Started in the background: 1a2b3c4d\\n'); process.exit(0);
  }
  if (has('silent')) process.exit(0);
  process.stdout.write('Started in the background: ${SESSION_UUID}\\n'); process.exit(0);
}
if (args[0] === 'stop') {
  if (has('stopGone')) { process.stderr.write('No background session found for ' + args[1]); process.exit(1); }
  process.exit(0);
}
process.exit(3);
`);
  writeFileSync(join(BIN, 'gh'), `#!/usr/bin/env node
const fs = require('fs');
const args = process.argv.slice(2);
fs.appendFileSync(${JSON.stringify(FAKE.ghLog)}, JSON.stringify(args) + '\\n');
if (args[0] === 'pr' && args[1] === 'list') {
  const all = fs.existsSync(${JSON.stringify(FAKE.prs)}) ? JSON.parse(fs.readFileSync(${JSON.stringify(FAKE.prs)}, 'utf8')) : {};
  process.stdout.write(JSON.stringify(all[args[args.indexOf('-R') + 1]] || []));
  process.exit(0);
}
if (args[0] === 'pr' && args[1] === 'view') {
  const all = fs.existsSync(${JSON.stringify(FAKE.view)}) ? JSON.parse(fs.readFileSync(${JSON.stringify(FAKE.view)}, 'utf8')) : {};
  const pr = all[args[args.indexOf('-R') + 1] + '#' + args[2]];
  if (!pr) { process.stderr.write('no pull requests found'); process.exit(1); }
  process.stdout.write(JSON.stringify(pr));
  process.exit(0);
}
if (args[0] === 'pr' && args[1] === 'merge') process.exit(0);
process.exit(3);
`);
  chmodSync(join(BIN, 'claude'), 0o755);
  chmodSync(join(BIN, 'gh'), 0o755);
}

const readLog = (file) => (existsSync(file) ? readFileSync(file, 'utf8').trim().split('\n').filter(Boolean).map((l) => JSON.parse(l)) : []);
const reset = () => {
  for (const f of Object.values(FAKE)) rmSync(f, { force: true });
};

function freePort() {
  return new Promise((done) => {
    const s = netServer().listen(0, '127.0.0.1', () => {
      const { port } = s.address();
      s.close(() => done(port));
    });
  });
}

const REGISTRY = join(tmp, 'projects.json');
const GREEN = { state: 'OPEN', headRefOid: 'abc123', baseRefName: 'develop', isDraft: false, statusCheckRollup: [{ name: 'ci', conclusion: 'SUCCESS' }], mergeable: 'MERGEABLE', reviewDecision: null };
const listed = (number, over = {}) => ({ number, title: `PR ${number}`, headRefName: `feature-${number}`, baseRefName: 'develop', isDraft: false, url: `https://github.com/acme/alpha/pull/${number}`, statusCheckRollup: [{ name: 'ci', conclusion: 'SUCCESS' }], mergeable: 'MERGEABLE', reviewDecision: null, ...over });

async function waitFor(fn, what, ms = 8000) {
  const end = Date.now() + ms;
  for (;;) {
    const v = await fn();
    if (v) return v;
    if (Date.now() > end) throw new Error(`timed out waiting for ${what}`);
    await new Promise((r) => setTimeout(r, 50));
  }
}

function raw(port, { method = 'GET', path = '/api/state', headers = {}, body } = {}) {
  return new Promise((done, fail) => {
    const req = request({ host: '127.0.0.1', port, method, path, headers: { Host: `127.0.0.1:${port}`, ...headers } }, (res) => {
      let data = '';
      res.on('data', (c) => (data += c));
      res.on('end', () => done({ status: res.statusCode, headers: res.headers, body: data, json: (() => { try { return JSON.parse(data); } catch { return null; } })() }));
    });
    req.on('error', fail);
    if (body !== undefined) req.write(typeof body === 'string' ? body : JSON.stringify(body));
    req.end();
  });
}

describe('server', () => {
  let mc;
  let port;
  let token;
  let stateDir;
  const auth = () => ({ Authorization: `Bearer ${token}` });
  const post = (path, body = {}, headers = {}) =>
    raw(port, { method: 'POST', path, body, headers: { ...auth(), Origin: `http://127.0.0.1:${port}`, 'Content-Type': 'application/json', ...headers } });
  const tasks = () => mc.state.tasks;
  const claudeCalls = (pred) => readLog(FAKE.claudeLog).filter((c) => pred(c.args));

  before(async () => {
    writeFakes();
    for (const [dir, repo] of [[ALPHA, 'acme/alpha'], [BETA, 'acme/beta']]) {
      mkdirSync(dir, { recursive: true });
      git(dir, 'init', '-b', 'main');
      writeFileSync(join(dir, 'a.txt'), 'a');
      git(dir, 'add', '-A');
      git(dir, 'commit', '-m', 'init');
      git(dir, 'remote', 'add', 'origin', `https://github.com/${repo}.git`);
    }
    const registry = REGISTRY;
    writeFileSync(registry, JSON.stringify({ projects: PROJECTS.map((p) => ({ ...p, aliases: [], keywords: [] })) }));
    process.env.PATH = `${BIN}:${process.env.PATH}`;
    port = await freePort();
    stateDir = join(tmp, 'state');
    mc = createMissionControl({
      port,
      registryFile: registry,
      stateDir,
      tokenFile: join(tmp, 'home', '.claude', 'mission-control.token'),
      claudeBin: join(BIN, 'claude'),
      intervals: { sessionsMs: 3_600_000, statusMs: 3_600_000, sweepMs: 3_600_000 },
    });
    token = mc.token;
    await mc.listen();
    await waitFor(() => mc.state.at.sessions && mc.state.at.status, 'first refresh');
  });
  after(() => mc?.close());

  test('the token file is private and the URL carries it', () => {
    const file = join(tmp, 'home', '.claude', 'mission-control.token');
    assert.equal(statSync(file).mode & 0o777, 0o600);
    assert.equal(readFileSync(file, 'utf8').trim(), token);
    assert.equal(mc.url, `http://127.0.0.1:${port}/?token=${token}`);
  });

  test('API calls need the token, by header or query', async () => {
    assert.equal((await raw(port)).status, 401);
    assert.equal((await raw(port, { headers: { Authorization: 'Bearer nope' } })).status, 401);
    assert.equal((await raw(port, { path: `/api/state?token=${token}x` })).status, 401);
    assert.equal((await raw(port, { headers: auth() })).status, 200);
    assert.equal((await raw(port, { path: `/api/state?token=${token}` })).status, 200);
  });

  test('the page is served with a strict CSP and no token needed', async () => {
    const r = await raw(port, { path: '/' });
    assert.equal(r.status, 200);
    assert.match(r.body, /<title>Mission control<\/title>/);
    assert.match(r.headers['content-security-policy'], /script-src 'self'/);
    assert.equal(r.headers['referrer-policy'], 'no-referrer');
  });

  test('requests for another Host are refused (DNS rebinding)', async () => {
    for (const host of [`evil.example:${port}`, '127.0.0.1', `127.0.0.1:${port + 1}`]) {
      assert.equal((await raw(port, { headers: { ...auth(), Host: host } })).status, 403, host);
    }
    assert.equal((await raw(port, { headers: { ...auth(), Host: `localhost:${port}` } })).status, 200);
  });

  test('mutations must be POST with JSON and a matching Origin', async () => {
    assert.equal((await raw(port, { path: '/api/settings', headers: auth() })).status, 405);
    assert.equal((await post('/api/settings', { cap: 3 }, { Origin: '' })).status, 403);
    assert.equal((await post('/api/settings', { cap: 3 }, { Origin: 'http://evil.example' })).status, 403);
    assert.equal((await post('/api/settings', { cap: 3 }, { 'Content-Type': 'text/plain' })).status, 415);
    assert.equal((await post('/api/settings', 'not json')).status, 400);
    assert.equal((await post('/api/settings', { cap: 3 })).status, 200);
  });

  test('SSE sends the snapshot, then a new one on change', async () => {
    const events = [];
    const req = request({ host: '127.0.0.1', port, path: `/api/events?token=${token}`, headers: { Host: `127.0.0.1:${port}` } });
    let buffer = '';
    req.on('response', (res) => {
      res.setEncoding('utf8');
      res.on('data', (chunk) => {
        buffer += chunk;
        let i;
        while ((i = buffer.indexOf('\n\n')) >= 0) {
          const block = buffer.slice(0, i);
          buffer = buffer.slice(i + 2);
          const event = block.match(/^event: (.+)$/m)?.[1];
          const data = block.match(/^data: (.+)$/m)?.[1];
          events.push({ event, data: JSON.parse(data) });
        }
      });
    });
    req.end();
    await waitFor(() => events.some((e) => e.event === 'state'), 'first state event');
    assert.ok(events[0].data.projects.some((p) => p.id === 'alpha'));
    await post('/api/settings', { cap: 2 });
    await waitFor(() => events.some((e) => e.event === 'state' && e.data.meta.cap === 2), 'state after a change');
    await post('/api/settings', { cap: 3 });
    req.destroy();
  });

  test('start: the brief goes to claude --bg as one argument, in the first checkout', async () => {
    reset();
    writeFileSync(FAKE.agents, '[]');
    await mc.refreshSessions();
    const evil = 'Fix it"; touch /tmp/pwned; echo $(whoami) `id`\n--dangerously-skip-permissions';
    const r = await post('/api/tasks', { project: 'alpha', title: 'Make it work', prompt: evil, priority: 1 });
    assert.equal(r.status, 200, r.body);
    const id = r.json.task.id;
    await waitFor(() => tasks().find((t) => t.id === id)?.state === 'working', 'task working');
    const [call] = claudeCalls((a) => a.includes('--bg'));
    assert.equal(call.cwd, join(`${ALPHA}-tasks`, `mc-${id}`), 'each task runs in its own worktree');
    assert.equal(git(call.cwd, 'branch', '--show-current').trim(), `task/mc-${id}`);
    assert.deepEqual(call.args.slice(0, 7), ['--bg', '-n', 'alpha: Make it work', '--model', 'sonnet', '--permission-mode', 'auto']);
    assert.equal(call.args.length, 8);
    assert.ok(call.args[7].startsWith('/until-ready Make it work\n'));
    assert.ok(call.args[7].includes('> Fix it"; touch /tmp/pwned; echo $(whoami) `id`\n> --dangerously-skip-permissions'));
    assert.match(call.args[7], /-R acme\/alpha/);
    assert.equal(tasks().find((t) => t.id === id).sessionId, SESSION_UUID);
    const log = readFileSync(join(stateDir, 'actions.log'), 'utf8');
    assert.ok(!log.includes('pwned') && !log.includes(token), 'the action log has no prompt text or token');
  });

  test('a busy session does not hold the project; the next alpha task starts in its own worktree', async () => {
    writeFileSync(FAKE.agents, JSON.stringify([{ sessionId: SESSION_UUID, name: 'alpha: Make it work', cwd: join(ALPHA, '.claude', 'worktrees', 'w'), kind: 'background', status: 'busy', startedAt: Date.now() }]));
    await mc.refreshSessions();
    const r = await post('/api/tasks', { project: 'alpha', title: 'Second', prompt: 'p' });
    const second = r.json.task.id;
    await waitFor(() => claudeCalls((a) => a.includes('--bg')).length === 2, 'second start');
    const calls = claudeCalls((a) => a.includes('--bg'));
    assert.notEqual(calls[0].cwd, calls[1].cwd, 'two tasks in one project never share a folder');
    await waitFor(() => tasks().find((t) => t.id === second).state !== 'starting', 'second settled');
    await post(`/api/tasks/${second}/stop`);
    assert.equal(tasks().find((t) => t.id === second).state, 'stopped');
  });

  test('idle maps to blocked, then a PR on the branch to ready to merge, then merge', async () => {
    const t = tasks().find((x) => x.sessionId === SESSION_UUID);
    writeFileSync(FAKE.agents, JSON.stringify([{ sessionId: SESSION_UUID, name: t.sessionName, cwd: ALPHA, kind: 'background', status: 'idle' }]));
    await mc.refreshSessions();
    assert.equal(tasks().find((x) => x.id === t.id).state, 'blocked');
    writeFileSync(FAKE.prs, JSON.stringify({
      'acme/alpha': [{ number: 7, title: 'Make it work', headRefName: t.branch, baseRefName: 'develop', isDraft: false, url: 'https://github.com/acme/alpha/pull/7', statusCheckRollup: [{ name: 'ci', conclusion: 'SUCCESS' }], mergeable: 'MERGEABLE', reviewDecision: null }],
    }));
    await mc.refreshStatus();
    assert.equal(tasks().find((x) => x.id === t.id).state, 'ready_to_merge');
    writeFileSync(FAKE.view, JSON.stringify({ 'acme/alpha#7': GREEN }));
    const r = await post('/api/merge', { repo: 'acme/alpha', number: 7 });
    assert.equal(r.status, 200, r.body);
    assert.deepEqual(readLog(FAKE.ghLog).find((a) => a[1] === 'merge'), ['pr', 'merge', '7', '-R', 'acme/alpha', '--squash', '--delete-branch', '--match-head-commit', 'abc123']);
    assert.equal(tasks().find((x) => x.id === t.id).state, 'merged');
  });

  test('a public merge is refused without the typed confirm, and goes through with it', async () => {
    reset();
    writeFileSync(FAKE.prs, JSON.stringify({
      'acme/beta': [{ number: 9, title: 'Ship', headRefName: 'feature', baseRefName: 'main', isDraft: false, url: 'https://github.com/acme/beta/pull/9', statusCheckRollup: [{ name: 'ci', conclusion: 'SUCCESS' }], mergeable: 'MERGEABLE' }],
    }));
    await mc.refreshStatus();
    writeFileSync(FAKE.view, JSON.stringify({ 'acme/beta#9': { ...GREEN, baseRefName: 'main' } }));
    const refused = await post('/api/merge', { repo: 'acme/beta', number: 9 });
    assert.equal(refused.status, 409);
    assert.match(refused.json.error, /public branch/);
    assert.equal((await post('/api/merge', { repo: 'acme/beta', number: 9, confirm: 'acme/beta#8' })).status, 409);
    assert.equal(readLog(FAKE.ghLog).filter((a) => a[1] === 'merge').length, 0, 'gh pr merge never ran');
    assert.equal((await post('/api/merge', { repo: 'acme/beta', number: 9, confirm: 'acme/beta#9' })).status, 200);
    assert.equal(readLog(FAKE.ghLog).filter((a) => a[1] === 'merge').length, 1);
  });

  test('a live merge with failing checks says so and needs the typed override; a typed confirm is offered when nothing is declared public', async () => {
    reset();
    const red = { ...GREEN, baseRefName: 'main', statusCheckRollup: [{ name: 'ci', conclusion: 'FAILURE' }, { name: 'lint', conclusion: 'SUCCESS' }] };
    writeFileSync(FAKE.prs, JSON.stringify({ 'acme/beta': [{ number: 10, title: 'Ship red', headRefName: 'red', baseRefName: 'main', isDraft: false, url: 'https://github.com/acme/beta/pull/10', statusCheckRollup: red.statusCheckRollup, mergeable: 'MERGEABLE' }] }));
    await mc.refreshStatus();
    writeFileSync(FAKE.view, JSON.stringify({ 'acme/beta#10': red }));
    const plain = await post('/api/merge', { repo: 'acme/beta', number: 10, confirm: 'acme/beta#10' });
    assert.equal(plain.status, 409);
    assert.match(plain.json.error, /checks aren't green \(1 passing, 1 failing\)/);
    assert.deepEqual([plain.json.needs.phrase, plain.json.needs.typed, plain.json.needs.override], ['acme/beta#10', true, true]);
    assert.equal((await post('/api/merge', { repo: 'acme/beta', number: 10, confirm: 'acme/beta#10', override: 'acme/beta#9' })).status, 409);
    assert.equal(readLog(FAKE.ghLog).filter((a) => a[1] === 'merge').length, 0, 'gh pr merge never ran');
    assert.equal((await post('/api/merge', { repo: 'acme/beta', number: 10, confirm: 'acme/beta#10', override: 'acme/beta#10' })).status, 200);
    assert.equal(readLog(FAKE.ghLog).filter((a) => a[1] === 'merge').length, 1);
  });

  test('stop: queue sessions stop on request, others only after a confirm', async () => {
    reset();
    writeFileSync(FAKE.agents, JSON.stringify([{ sessionId: 'aaaaaaaa-0000-4000-8000-000000000000', name: 'desktop chat', cwd: BETA, kind: 'interactive', status: 'idle' }]));
    await mc.refreshSessions();
    const refused = await post('/api/sessions/aaaaaaaa-0000-4000-8000-000000000000/stop');
    assert.equal(refused.status, 409);
    assert.equal(claudeCalls((a) => a[0] === 'stop').length, 0);
    assert.equal((await post('/api/sessions/aaaaaaaa-0000-4000-8000-000000000000/stop', { confirm: true })).status, 200);
    assert.deepEqual(claudeCalls((a) => a[0] === 'stop')[0].args, ['stop', 'aaaaaaaa-0000-4000-8000-000000000000']);
    assert.equal((await post('/api/sessions/--help/stop', { confirm: true })).status, 400);

    writeFileSync(FAKE.agents, '[]');
    await mc.refreshSessions();
    const r = await post('/api/tasks', { project: 'beta', title: 'Stop me', prompt: 'p' });
    await waitFor(() => tasks().find((t) => t.id === r.json.task.id)?.state === 'working', 'beta task working');
    writeFileSync(FAKE.agents, JSON.stringify([{ sessionId: SESSION_UUID, name: 'beta: Stop me', cwd: BETA, kind: 'background', status: 'busy' }]));
    await mc.refreshSessions();
    assert.equal((await post(`/api/tasks/${r.json.task.id}/stop`)).status, 200);
    assert.equal(tasks().find((t) => t.id === r.json.task.id).state, 'stopped');
    assert.deepEqual(claudeCalls((a) => a[0] === 'stop').at(-1).args, ['stop', SESSION_UUID]);
  });

  test('risky tasks wait for approve start', async () => {
    reset();
    writeFileSync(FAKE.agents, '[]');
    await mc.refreshSessions();
    const r = await post('/api/tasks', { project: 'beta', title: 'Risky one', prompt: 'p', risky: true });
    const id = r.json.task.id;
    mc.tick();
    assert.equal(tasks().find((t) => t.id === id).state, 'queued');
    assert.ok(mc.state.waiting[id].includes('approval'));
    const snap = (await raw(port, { headers: auth() })).json;
    assert.ok(snap.needsYou.some((n) => n.kind === 'approve' && n.taskId === id));
    await post(`/api/tasks/${id}/approve`);
    await waitFor(() => tasks().find((t) => t.id === id)?.state === 'working', 'approved task working');
    await post(`/api/tasks/${id}/stop`);
  });

  test('a usage limit on start pauses the queue once and never retries', async () => {
    reset();
    writeFileSync(FAKE.agents, '[]');
    writeFileSync(FAKE.limit, '');
    await mc.refreshSessions();
    const r = await post('/api/tasks', { project: 'beta', title: 'Hits the limit', prompt: 'p' });
    const id = r.json.task.id;
    await waitFor(() => mc.state.settings.paused, 'scheduler paused');
    assert.match(mc.state.settings.pauseReason, /usage limit/);
    assert.equal(tasks().find((t) => t.id === id).state, 'queued');
    for (let i = 0; i < 3; i++) await mc.refreshSessions();
    assert.equal(claudeCalls((a) => a.includes('--bg')).length, 1, 'one attempt only');
    const snap = (await raw(port, { headers: auth() })).json;
    assert.equal(snap.needsYou[0].kind, 'paused');
    assert.ok(JSON.parse(readFileSync(join(stateDir, 'settings.json'), 'utf8')).paused, 'the pause is saved');
    rmSync(FAKE.limit);
    await post('/api/settings', { paused: false });
    await waitFor(() => tasks().find((t) => t.id === id)?.state === 'working', 'started after resume');
  });

  const stopActive = async () => {
    for (const t of tasks().filter((x) => ['starting', 'working', 'blocked'].includes(x.state))) await post(`/api/tasks/${t.id}/stop`);
  };
  const startOne = async (project, title) => {
    const r = await post('/api/tasks', { project, title, prompt: 'p' });
    assert.equal(r.status, 200, r.body);
    return waitFor(() => (tasks().find((t) => t.id === r.json.task.id)?.state === 'working' ? tasks().find((t) => t.id === r.json.task.id) : null), `${title} working`);
  };
  const merges = () => readLog(FAKE.ghLog).filter((a) => a[1] === 'merge');

  test('merge re-reads the PR: a base that turned public after the poll needs the typed confirm', async () => {
    reset();
    writeFileSync(FAKE.prs, JSON.stringify({ 'acme/alpha': [listed(12)] }));
    await mc.refreshStatus();
    writeFileSync(FAKE.view, JSON.stringify({ 'acme/alpha#12': { ...GREEN, baseRefName: 'main', headRefOid: 'feed12' } }));
    const refused = await post('/api/merge', { repo: 'acme/alpha', number: 12 });
    assert.equal(refused.status, 409);
    assert.match(refused.json.error, /public branch \(main\)/);
    assert.equal(merges().length, 0);
    assert.deepEqual(readLog(FAKE.ghLog).find((a) => a[1] === 'view').slice(0, 6), ['pr', 'view', '12', '-R', 'acme/alpha', '--json']);
    assert.equal((await post('/api/merge', { repo: 'acme/alpha', number: 12, confirm: 'acme/alpha#12' })).status, 200);
    assert.deepEqual(merges()[0].slice(-2), ['--match-head-commit', 'feed12']);
  });

  test('merge re-reads the PR: checks that failed after the poll refuse it', async () => {
    reset();
    writeFileSync(FAKE.prs, JSON.stringify({ 'acme/alpha': [listed(13)] }));
    await mc.refreshStatus();
    writeFileSync(FAKE.view, JSON.stringify({ 'acme/alpha#13': { ...GREEN, statusCheckRollup: [{ name: 'ci', conclusion: 'FAILURE' }] } }));
    for (const confirm of [undefined, 'acme/alpha#13']) {
      const r = await post('/api/merge', { repo: 'acme/alpha', number: 13, confirm });
      assert.equal(r.status, 409);
      assert.match(r.json.error, /Not mergeable yet/);
    }
    assert.equal(merges().length, 0);
  });

  test('merge is refused while the status poll is failing or more than 2 minutes old', async () => {
    reset();
    writeFileSync(FAKE.prs, JSON.stringify({ 'acme/alpha': [listed(14)] }));
    await mc.refreshStatus();
    writeFileSync(FAKE.view, JSON.stringify({ 'acme/alpha#14': GREEN }));
    const goodAt = mc.state.at.status;
    mc.state.at.status = new Date(Date.now() - 3 * 60_000).toISOString();
    const old = await post('/api/merge', { repo: 'acme/alpha', number: 14 });
    assert.equal(old.status, 409);
    assert.match(old.json.error, /more than 2 minutes old/);
    mc.state.at.status = goodAt;
    mc.state.errors.status = 'gh pr list failed';
    const failing = await post('/api/merge', { repo: 'acme/alpha', number: 14 });
    assert.equal(failing.status, 409);
    assert.match(failing.json.error, /status check failed/);
    mc.state.errors.status = null;
    assert.equal(merges().length, 0);
    assert.equal((await post('/api/merge', { repo: 'acme/alpha', number: 14 })).status, 200);
  });

  test('limit text on a successful start is not a limit', async () => {
    reset();
    await stopActive();
    writeFileSync(FAKE.agents, '[]');
    writeFileSync(FAKE.limitText, '');
    await mc.refreshSessions();
    const t = await startOne('alpha', 'Close to the limit');
    assert.equal(mc.state.settings.paused, false);
    assert.equal(t.sessionId, SESSION_UUID);
  });

  test('stop: a task whose session already ended moves to stopped without calling claude stop', async () => {
    reset();
    writeFileSync(FAKE.agents, '[]');
    await mc.refreshSessions();
    const t = tasks().find((x) => x.title === 'Close to the limit');
    const r = await post(`/api/tasks/${t.id}/stop`);
    assert.equal(r.status, 200, r.body);
    assert.match(r.json.message, /already ended/);
    assert.equal(tasks().find((x) => x.id === t.id).state, 'stopped');
    assert.equal(claudeCalls((a) => a[0] === 'stop').length, 0);
  });

  test('stop: claude stop saying the session is not found counts as stopped', async () => {
    reset();
    const id = 'bbbbbbbb-0000-4000-8000-000000000000';
    writeFileSync(FAKE.agents, JSON.stringify([{ sessionId: id, name: 'gone chat', cwd: BETA, kind: 'background', status: 'idle' }]));
    writeFileSync(FAKE.stopGone, '');
    await mc.refreshSessions();
    const r = await post(`/api/sessions/${id}/stop`, { confirm: true });
    assert.equal(r.status, 200, r.body);
    assert.deepEqual(claudeCalls((a) => a[0] === 'stop')[0].args, ['stop', id]);
  });

  test('start: the short id --bg prints resolves to the full session UUID, which stop then uses', async () => {
    reset();
    writeFileSync(FAKE.agents, '[]');
    writeFileSync(FAKE.short, '');
    await mc.refreshSessions();
    const t = await startOne('alpha', 'Short id');
    assert.equal(t.sessionId, SHORT_UUID);
    await mc.refreshSessions();
    assert.equal((await post(`/api/tasks/${t.id}/stop`)).status, 200);
    assert.deepEqual(claudeCalls((a) => a[0] === 'stop').at(-1).args, ['stop', SHORT_UUID]);
  });

  test('stop: a task with no session id stops the session found by name, or says none was running', async () => {
    reset();
    writeFileSync(FAKE.agents, '[]');
    writeFileSync(FAKE.silent, '');
    await mc.refreshSessions();
    const named = await startOne('alpha', 'No id one');
    assert.equal(named.sessionId, null);
    const id = 'cccccccc-0000-4000-8000-000000000000';
    writeFileSync(FAKE.agents, JSON.stringify([{ sessionId: id, name: named.sessionName, cwd: ALPHA, kind: 'background', status: 'busy' }]));
    await mc.refreshSessions();
    assert.equal((await post(`/api/tasks/${named.id}/stop`)).status, 200);
    assert.deepEqual(claudeCalls((a) => a[0] === 'stop').at(-1).args, ['stop', id]);

    writeFileSync(FAKE.agents, '[]');
    await mc.refreshSessions();
    const lost = await startOne('alpha', 'No id two');
    const before = claudeCalls((a) => a[0] === 'stop').length;
    const r = await post(`/api/tasks/${lost.id}/stop`);
    assert.equal(r.status, 200, r.body);
    assert.match(r.json.message, /No session named "alpha: No id two" is running/);
    assert.equal(claudeCalls((a) => a[0] === 'stop').length, before);
    assert.match(tasks().find((x) => x.id === lost.id).history.at(-1).note, /nothing needed stopping/);
  });

  test('session reads never overlap: calls made during a read share one follow-up read', async () => {
    reset();
    writeFileSync(FAKE.agents, '[]');
    writeFileSync(FAKE.slow, '');
    await Promise.all([1, 2, 3, 4, 5].map(() => mc.refreshSessions()));
    assert.equal(claudeCalls((a) => a[0] === 'agents').length, 2);
  });

  test('a malformed % escape in the path is a 400', async () => {
    const r = await post('/api/sessions/%E0%A4%A/stop', { confirm: true });
    assert.equal(r.status, 400);
  });

  test('a task whose PR left the open list is looked up once: merged moves on, closed goes back to blocked', async () => {
    reset();
    writeFileSync(FAKE.agents, '[]');
    await mc.refreshSessions();
    const inReview = (title, number) => {
      let t = q.createTask({ project: 'alpha', title, prompt: 'p' }, { projects: PROJECTS });
      for (const to of ['starting', 'working', 'in_review']) t = q.transition(t, to, { patch: to === 'in_review' ? { pr: { url: `https://github.com/acme/alpha/pull/${number}`, number } } : {} });
      return t;
    };
    const merged = inReview('Merged elsewhere', 21);
    const closed = inReview('Closed elsewhere', 22);
    mc.state.tasks.push(merged, closed);
    writeFileSync(FAKE.prs, JSON.stringify({ 'acme/alpha': [] }));
    writeFileSync(FAKE.view, JSON.stringify({ 'acme/alpha#21': { state: 'MERGED' }, 'acme/alpha#22': { state: 'CLOSED' } }));
    await mc.refreshStatus();
    assert.equal(tasks().find((t) => t.id === merged.id).state, 'merged');
    const back = tasks().find((t) => t.id === closed.id);
    assert.equal(back.state, 'blocked');
    assert.match(back.history.at(-1).note, /PR #22 was closed without merging/);
    await mc.refreshStatus();
    assert.equal(readLog(FAKE.ghLog).filter((a) => a[1] === 'view').length, 2, 'one lookup per task');
    await post(`/api/tasks/${closed.id}/stop`);
  });

  test('a second server on the same state is refused; a stale lock is taken over and removed on close', async () => {
    const opts = { registryFile: REGISTRY, tokenFile: join(tmp, 'home', '.claude', 'mission-control.token'), claudeBin: join(BIN, 'claude'), intervals: { sessionsMs: 3_600_000, statusMs: 3_600_000, sweepMs: 3_600_000 } };
    const second = createMissionControl({ ...opts, port: await freePort(), stateDir });
    await assert.rejects(second.listen(), /already running on this state \(pid \d+, port \d+\)/);
    const staleDir = join(tmp, 'state-stale');
    mkdirSync(staleDir, { recursive: true });
    const deadPid = spawnSync(process.execPath, ['-e', '']).pid;
    writeFileSync(join(staleDir, 'server.lock'), JSON.stringify({ pid: deadPid, port: 1 }));
    const third = createMissionControl({ ...opts, port: await freePort(), stateDir: staleDir });
    await third.listen();
    assert.equal(JSON.parse(readFileSync(join(staleDir, 'server.lock'), 'utf8')).pid, process.pid);
    await third.close();
    assert.equal(existsSync(join(staleDir, 'server.lock')), false);
  });

  test('the queue survives a restart', () => {
    const saved = q.loadQueue(join(stateDir, 'queue.json'));
    assert.deepEqual(saved.map((t) => [t.id, t.state]), tasks().map((t) => [t.id, t.state]));
  });
});

describe('recovery on load', () => {
  let mc;
  const stateDir = join(tmp, 'state-recovery');
  const FOUND = 'dddddddd-0000-4000-8000-000000000000';
  const tenMinutesAgo = () => new Date(Date.now() - 10 * 60_000).toISOString();
  const byTitle = (title) => mc.state.tasks.find((t) => t.title === title);

  before(async () => {
    reset();
    process.env.PATH = `${BIN}:${process.env.PATH}`;
    const make = (project, title, state) => {
      const t = q.createTask({ project: 'alpha', title, prompt: 'p' }, { projects: PROJECTS });
      return { ...t, project, sessionName: `${project}: ${title}`, state, startedAt: state === 'starting' ? tenMinutesAgo() : null };
    };
    const tasks = [make('gone', 'Project removed', 'queued'), make('alpha', 'Found me', 'starting'), make('beta', 'Never showed', 'starting'), make('beta', 'Log breaks', 'queued')];
    mkdirSync(join(stateDir, 'actions.log'), { recursive: true });
    q.saveQueue(join(stateDir, 'queue.json'), tasks);
    writeFileSync(FAKE.agents, JSON.stringify([{ sessionId: FOUND, name: 'alpha: Found me', cwd: ALPHA, kind: 'background', status: 'busy' }]));
    mc = createMissionControl({
      port: await freePort(),
      registryFile: REGISTRY,
      stateDir,
      tokenFile: join(tmp, 'home', '.claude', 'mission-control.token'),
      claudeBin: join(BIN, 'claude'),
      intervals: { sessionsMs: 3_600_000, statusMs: 3_600_000, sweepMs: 3_600_000 },
    });
    await mc.listen();
    await waitFor(() => byTitle('Log breaks').state === 'failed', 'the last queued task to settle');
  });
  after(() => mc?.close());

  test('a starting task whose session is running moves to working with its id', () => {
    assert.equal(byTitle('Found me').state, 'working');
    assert.equal(byTitle('Found me').sessionId, FOUND);
  });

  test('a starting task with no session after the grace period fails with a reason', () => {
    assert.equal(byTitle('Never showed').state, 'failed');
    assert.match(byTitle('Never showed').history.at(-1).note, /no session named "beta: Never showed"/);
  });

  test('a task whose project left projects.json fails with a clear reason', () => {
    assert.equal(byTitle('Project removed').state, 'failed');
    assert.equal(byTitle('Project removed').history.at(-1).note, "gone isn't in projects.json any more.");
  });

  test('a start that throws moves the task to failed instead of leaving it starting', () => {
    assert.equal(byTitle('Log breaks').state, 'failed');
    assert.match(byTitle('Log breaks').history.at(-1).note, /^start failed: .*EISDIR/);
  });
});
