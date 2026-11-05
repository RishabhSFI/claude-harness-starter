import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { request } from 'node:http';
import { createServer as netServer } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { after, before, describe, test } from 'node:test';

const { createMissionControl, shortTitle } = await import('../mc/server.mjs');

const GIT_ENV = { ...process.env, GIT_AUTHOR_NAME: 't', GIT_AUTHOR_EMAIL: 't@example.com', GIT_COMMITTER_NAME: 't', GIT_COMMITTER_EMAIL: 't@example.com', GIT_CONFIG_GLOBAL: '/dev/null', GIT_CONFIG_SYSTEM: '/dev/null' };
const git = (cwd, ...args) => execFileSync('git', args, { cwd, env: GIT_ENV, stdio: 'pipe' }).toString();

const tmp = realpathSync(mkdtempSync(join(tmpdir(), 'mc-qa-server-test-')));
after(() => rmSync(tmp, { recursive: true, force: true }));

const ALPHA = join(tmp, 'alpha');
const HARNESS = join(tmp, 'harness');
const BIN = join(tmp, 'bin');
const FAKE = { claudeLog: join(tmp, 'claude.log'), ghLog: join(tmp, 'gh.log'), agents: join(tmp, 'agents.json'), prs: join(tmp, 'prs.json'), view: join(tmp, 'view.json') };
const SESSION_UUID = '11111111-2222-4333-8444-555555555555';
const OTHER_SESSION = '99999999-2222-4333-8444-555555555555';
const REGISTRY = join(tmp, 'projects.json');
const REQUESTS = join(tmp, 'wiki', 'topics', 'owner-requests.md');

const detail = (number, repo, over = {}) => ({
  number, title: `feat: Landing page ${number}`, body: 'Adds the landing page.\n\n## Left for you\n- Check the copy', url: `https://github.com/${repo}/pull/${number}`,
  createdAt: '2026-11-01T10:00:00Z', updatedAt: '2026-11-02T10:00:00Z', baseRefName: 'main', headRefName: `feature-${number}`, headRefOid: 'abc123', isDraft: false,
  labels: [], comments: [], reviews: [], statusCheckRollup: [{ name: 'ci', conclusion: 'SUCCESS' }], mergeable: 'MERGEABLE', reviewDecision: null, state: 'OPEN', ...over,
});

function writeFakes() {
  mkdirSync(BIN, { recursive: true });
  writeFileSync(join(BIN, 'claude'), `#!/usr/bin/env node
const fs = require('fs');
const args = process.argv.slice(2);
fs.appendFileSync(${JSON.stringify(FAKE.claudeLog)}, JSON.stringify({ args, cwd: process.cwd() }) + '\\n');
if (args[0] === 'agents') { process.stdout.write(fs.existsSync(${JSON.stringify(FAKE.agents)}) ? fs.readFileSync(${JSON.stringify(FAKE.agents)}, 'utf8') : '[]'); process.exit(0); }
if (args.includes('--bg')) { process.stdout.write('Started in the background: ${SESSION_UUID}\\n'); process.exit(0); }
process.exit(0);
`);
  writeFileSync(join(BIN, 'gh'), `#!/usr/bin/env node
const fs = require('fs');
const args = process.argv.slice(2);
fs.appendFileSync(${JSON.stringify(FAKE.ghLog)}, JSON.stringify(args) + '\\n');
const read = (f) => (fs.existsSync(f) ? JSON.parse(fs.readFileSync(f, 'utf8')) : {});
const repo = args[args.indexOf('-R') + 1];
if (args[0] === 'pr' && args[1] === 'list') { process.stdout.write(JSON.stringify(read(${JSON.stringify(FAKE.prs)})[repo] || [])); process.exit(0); }
if (args[0] === 'pr' && args[1] === 'view') {
  const pr = read(${JSON.stringify(FAKE.view)})[repo + '#' + args[2]];
  if (!pr) { process.stderr.write('no pull requests found'); process.exit(1); }
  process.stdout.write(JSON.stringify(pr)); process.exit(0);
}
if (args[0] === 'api') { process.stdout.write('[]'); process.exit(0); }
if (args[0] === 'pr' && args[1] === 'merge') process.exit(0);
process.exit(3);
`);
  chmodSync(join(BIN, 'claude'), 0o755);
  chmodSync(join(BIN, 'gh'), 0o755);
}

const REQUEST_FILE = `# Requests

## Open (nobody on it yet)

| Asked | Request | Project | Next step |
| --- | --- | --- | --- |
| 11-06 | Fix the nightly report. It lists last week twice. | harness | Not started. |
| 11-06 | Something for a project nobody registered | [[projects/nowhere]] | Not started. |

## Waiting on the owner

| Asked | Request | Project | Where it stands |
| --- | --- | --- | --- |
| 11-01 | Landing page for the Alpha shop | [[projects/alpha]] | alpha#7 waits on review. |
| 11-02 | Pick a domain name for Alpha | [[projects/alpha]] | Owner to choose between two names. |
| 11-03 | Harness release notes | harness | harness#3 waits on review. |

## Working

| Asked | Request | Project | Where it stands |
| --- | --- | --- | --- |
| 11-04 | Search box for the Alpha catalogue | [[projects/alpha]] | Building. |

## Done (verified)

| Asked | Request | Result |
| --- | --- | --- |
| 11-01 | Old cleanup | Done and live. |
`;

function freePort() {
  return new Promise((done) => {
    const s = netServer().listen(0, '127.0.0.1', () => {
      const { port } = s.address();
      s.close(() => done(port));
    });
  });
}

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
      res.on('end', () => done({ status: res.statusCode, body: data, json: (() => { try { return JSON.parse(data); } catch { return null; } })() }));
    });
    req.on('error', fail);
    if (body !== undefined) req.write(JSON.stringify(body));
    req.end();
  });
}

describe('QA cards and the work map on the server', () => {
  let mc;
  let port;
  let token;
  let stateDir;
  const auth = () => ({ Authorization: `Bearer ${token}` });
  const get = async () => (await raw(port, { headers: auth() })).json;
  const post = (path, body = {}) => raw(port, { method: 'POST', path, body, headers: { ...auth(), Origin: `http://127.0.0.1:${port}`, 'Content-Type': 'application/json' } });
  const row = async (text) => (await get()).workMap.rows.find((r) => r.text.startsWith(text));
  const ghCalls = () => (existsSync(FAKE.ghLog) ? readFileSync(FAKE.ghLog, 'utf8').trim().split('\n').map((l) => JSON.parse(l)) : []);

  before(async () => {
    writeFakes();
    for (const [dir, repo] of [[ALPHA, 'acme/alpha'], [HARNESS, 'acme/harness']]) {
      mkdirSync(dir, { recursive: true });
      git(dir, 'init', '-b', 'main');
      writeFileSync(join(dir, 'a.txt'), 'a');
      git(dir, 'add', '-A');
      git(dir, 'commit', '-m', 'init');
      git(dir, 'remote', 'add', 'origin', `https://github.com/${repo}.git`);
    }
    mkdirSync(join(tmp, 'wiki', 'topics'), { recursive: true });
    writeFileSync(REQUESTS, REQUEST_FILE);
    writeFileSync(REGISTRY, JSON.stringify({ projects: [{ id: 'alpha', name: 'Alpha', checkouts: [ALPHA], public: { branches: ['main'], remotes: [], notes: [] }, repos: ['acme/alpha'], aliases: [], keywords: [] }] }));
    writeFileSync(FAKE.prs, JSON.stringify({ 'acme/alpha': [{ number: 7, title: 'feat: Landing page 7', headRefName: 'feature-7', baseRefName: 'main', isDraft: false, url: 'https://github.com/acme/alpha/pull/7', statusCheckRollup: [{ name: 'ci', conclusion: 'SUCCESS' }], mergeable: 'MERGEABLE', reviewDecision: null, updatedAt: '2026-11-02T10:00:00Z', labels: [] }] }));
    writeFileSync(FAKE.view, JSON.stringify({ 'acme/alpha#7': detail(7, 'acme/alpha'), 'acme/harness#3': detail(3, 'acme/harness', { title: 'Release notes' }) }));
    writeFileSync(FAKE.agents, JSON.stringify([{ sessionId: OTHER_SESSION, name: 'zzz unrelated chat', cwd: join(ALPHA, '.claude', 'worktrees', 'w'), kind: 'background', status: 'busy', startedAt: Date.now() }]));
    process.env.PATH = `${BIN}:${process.env.PATH}`;
    port = await freePort();
    stateDir = join(tmp, 'state');
    mc = createMissionControl({
      port,
      registryFile: REGISTRY,
      stateDir,
      tokenFile: join(tmp, 'home', '.claude', 'mission-control.token'),
      claudeBin: join(BIN, 'claude'),
      harness: { dir: HARNESS, repo: 'acme/harness' },
      intervals: { sessionsMs: 3_600_000, statusMs: 3_600_000, sweepMs: 3_600_000 },
    });
    token = mc.token;
    await mc.listen();
    await waitFor(async () => (await get()).qa.cards.length >= 3, 'QA cards');
  });
  after(() => mc?.close());

  test('the harness is a project of its own', async () => {
    const snap = await get();
    assert.ok(snap.projects.some((p) => p.id === 'harness' && p.name === 'Harness'));
  });

  test('PRs the owner must look at become cards, oldest first, including a harness PR that is not in the status poll', async () => {
    const { cards } = (await get()).qa;
    const pr = cards.find((c) => c.key === 'acme/alpha#7');
    assert.equal(pr.title, 'Landing page 7');
    assert.equal(pr.projectName, 'Alpha');
    assert.equal(pr.live, true);
    assert.deepEqual(pr.checklist, ['Check the copy']);
    const harnessPr = cards.find((c) => c.key === 'acme/harness#3');
    assert.equal(harnessPr.project, 'harness');
    assert.ok(cards.some((c) => c.kind === 'request' && c.title.startsWith('Pick a domain')), 'a waiting request with no PR is a card too');
    const times = cards.map((c) => Date.parse(c.waitingSince));
    assert.deepEqual(times, [...times].sort((a, b) => a - b));
  });

  test('the work map has one row per request, in a state, with counts', async () => {
    const { workMap } = await get();
    assert.equal(workMap.rows.length, 7);
    assert.equal((await row('Landing page')).state, 'waiting_you');
    assert.equal((await row('Landing page')).qaKey, 'acme/alpha#7');
    assert.equal((await row('Fix the nightly')).state, 'not_worked');
    assert.equal((await row('Old cleanup')).state, 'done');
    assert.equal(Object.values(workMap.counts).reduce((a, b) => a + b, 0), 7);
    assert.ok(workMap.other.some((o) => o.sessionId === OTHER_SESSION), 'a session on no request is listed as other');
  });

  test('requests are re-read when the file changes', async () => {
    writeFileSync(REQUESTS, `${REQUEST_FILE}\n`.replace('Old cleanup', 'Old cleanup again'));
    await waitFor(async () => (await row('Old cleanup again')), 'changed request');
    writeFileSync(REQUESTS, REQUEST_FILE);
    await waitFor(async () => (await row('Old cleanup')) && !(await row('Old cleanup again')), 'request back');
  });

  test('reviewed: marks a card, survives in the state file, and clears again', async () => {
    assert.equal((await post('/api/qa/reviewed', { key: 'not a key', on: true })).status, 400);
    assert.equal((await post('/api/qa/reviewed', { key: 'acme/alpha#7' })).status, 400);
    assert.equal((await post('/api/qa/reviewed', { key: 'acme/alpha#7', on: true })).status, 200);
    const card = (await get()).qa.cards.find((c) => c.key === 'acme/alpha#7');
    assert.match(card.reviewedAt, /^\d{4}-\d\d-\d\dT/);
    const saved = JSON.parse(readFileSync(join(stateDir, 'qa-reviewed.json'), 'utf8'));
    assert.match(saved['acme/alpha#7'].at, /^\d{4}-/);
    assert.equal((await post('/api/qa/reviewed', { key: 'acme/alpha#7', on: false })).status, 200);
    assert.equal((await get()).qa.cards.find((c) => c.key === 'acme/alpha#7').reviewedAt, null);
    assert.deepEqual(JSON.parse(readFileSync(join(stateDir, 'qa-reviewed.json'), 'utf8')), {});
  });

  test('link: pins a session to a request, persists, and unlinking keeps it off', async () => {
    const id = (await row('Search box')).id;
    assert.equal((await post('/api/requests/nope/link', { sessionId: OTHER_SESSION, on: true })).status, 404);
    assert.equal((await post(`/api/requests/${id}/link`, { sessionId: 'x', on: true })).status, 400);
    assert.equal((await post(`/api/requests/${id}/link`, { sessionId: OTHER_SESSION })).status, 400);
    assert.equal((await post(`/api/requests/${id}/link`, { sessionId: OTHER_SESSION, on: true })).status, 200);
    const linked = await row('Search box');
    assert.deepEqual(linked.sessions.map((x) => [x.sessionId, x.how]), [[OTHER_SESSION, 'manual']]);
    assert.equal(linked.state, 'working');
    assert.ok(!(await get()).workMap.other.some((o) => o.sessionId === OTHER_SESSION));
    assert.deepEqual(JSON.parse(readFileSync(join(stateDir, 'request-links.json'), 'utf8')).link[id], [OTHER_SESSION]);
    assert.equal((await post(`/api/requests/${id}/link`, { sessionId: OTHER_SESSION, on: false })).status, 200);
    assert.equal((await row('Search box')).sessions.length, 0);
    assert.deepEqual(JSON.parse(readFileSync(join(stateDir, 'request-links.json'), 'utf8')).unlink[id], [OTHER_SESSION]);
  });

  test('start: queues a worker in the request\'s project, once', async () => {
    const r = await row('Fix the nightly');
    const res = await post(`/api/requests/${r.id}/start`);
    assert.equal(res.status, 200, res.body);
    const task = mc.state.tasks.find((t) => t.id === res.json.task.id);
    assert.equal(task.project, 'harness');
    assert.equal(task.title, 'Fix the nightly report');
    assert.match(task.prompt, /It lists last week twice\./);
    assert.match(task.prompt, /Where it stands: Not started\./);
    assert.match(task.prompt, /From the owner's request list/);
    await waitFor(() => mc.state.tasks.find((t) => t.id === task.id)?.state === 'working', 'worker started');
    const call = readFileSync(FAKE.claudeLog, 'utf8').trim().split('\n').map((l) => JSON.parse(l)).find((c) => c.args.includes('--bg'));
    assert.equal(call.cwd, join(`${HARNESS}-tasks`, `mc-${task.id}`));
    assert.equal((await post(`/api/requests/${r.id}/start`)).status, 409);
    assert.equal((await row('Fix the nightly')).queued, true);
  });

  test('start: plain 400 when the project cannot start a worker, or the request is done', async () => {
    const stray = await post(`/api/requests/${(await row('Something for a project')).id}/start`);
    assert.equal(stray.status, 400);
    assert.match(stray.json.error, /isn't a project mission control can start a worker in/);
    assert.equal((await post(`/api/requests/${(await row('Old cleanup')).id}/start`)).status, 400);
    assert.equal((await post('/api/requests/nope/start')).status, 404);
  });

  test('a merge into the harness main branch needs the live confirm', async () => {
    const refused = await post('/api/merge', { repo: 'acme/harness', number: 3 });
    assert.equal(refused.status, 409);
    assert.equal(refused.json.needs.live, true);
    assert.equal(ghCalls().filter((c) => c[0] === 'pr' && c[1] === 'merge').length, 0);
    const ok = await post('/api/merge', { repo: 'acme/harness', number: 3, confirm: 'acme/harness#3' });
    assert.equal(ok.status, 200, ok.body);
    assert.equal(ghCalls().filter((c) => c[0] === 'pr' && c[1] === 'merge').length, 1);
  });

  test('the new routes keep the usual guards', async () => {
    assert.equal((await raw(port, { method: 'POST', path: '/api/qa/reviewed', body: { key: 'a/b#1', on: true } })).status, 401);
    const wrongOrigin = await raw(port, { method: 'POST', path: '/api/qa/reviewed', body: { key: 'a/b#1', on: true }, headers: { ...auth(), Origin: 'http://evil.example', 'Content-Type': 'application/json' } });
    assert.equal(wrongOrigin.status, 403);
  });

  test('short titles are the first sentence, trimmed to a sensible length', () => {
    assert.equal(shortTitle('Fix the nightly report. It lists last week twice.'), 'Fix the nightly report');
    assert.ok(shortTitle(`${'word '.repeat(40)}end`).length <= 81);
    assert.match(shortTitle(`${'word '.repeat(40)}end`), /…$/);
  });
});
