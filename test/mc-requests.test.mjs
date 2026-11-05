import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { after, describe, test } from 'node:test';
import { buildWorkMap, loadLinks, matchSessions, parseRequests, resolvePrRef, saveLinks, setLink } from '../mc/requests.mjs';

const MD = readFileSync(new URL('./fixtures/owner-requests.md', import.meta.url), 'utf8');
const REPOS = ['acme/shop-site', 'acme/haulco', 'acme/claude-harness'];
const NOW = new Date('2026-11-05T12:00:00Z');
const ago = (h) => new Date(NOW.getTime() - h * 3600e3).toISOString();
const NO_LINKS = { link: {}, unlink: {} };

const tmp = mkdtempSync(join(tmpdir(), 'mc-requests-'));
after(() => rmSync(tmp, { recursive: true, force: true }));

const requests = parseRequests(MD, { repos: REPOS });
const byText = (re) => requests.find((r) => re.test(r.text));

const session = (over = {}) => ({ sessionId: 's1', name: 'Some chat', project: null, projectName: 'claude-harness', busy: false, status: 'idle', since: ago(5), lastAt: ago(5), plan: null, doing: null, pr: null, taskId: null, ...over });
const rowFor = (re, work, extra = {}) => buildWorkMap({ requests, work, now: NOW, ...extra }).rows.find((r) => re.test(r.text));
const SYSTEM = /System page/;
const systemChat = (over = {}) => session({ name: 'Mission control System page', ...over });

describe('parseRequests', () => {
  test('reads every section and skips the empty placeholder', () => {
    assert.deepEqual(requests.map((r) => r.section), ['waiting', 'waiting', 'working', 'working', 'working', 'working', 'done', 'done', 'done']);
  });

  test('project comes from the wiki link or the cell text; done rows have none', () => {
    assert.equal(byText(/shop site/).project, 'shop');
    assert.equal(byText(/Mac wakes/).project, 'harness');
    assert.equal(byText(/Database storage/).project, null);
    assert.equal(byText(/Database storage/).stands, 'Live; 319 MB to 175 MB after vacuum.');
  });

  test('ids are stable when a row moves between sections', () => {
    const row = '| 11-05 | Mac wakes for the morning jobs | harness | Owner to run a `sudo pmset` command. |\n';
    const moved = MD.replace(row, '').replace('| 11-06 | Nightly report emails', `${row}| 11-06 | Nightly report emails`);
    const reparsed = parseRequests(moved, { repos: REPOS });
    const wakes = reparsed.find((r) => /Mac wakes/.test(r.text));
    assert.equal(wakes.section, 'working');
    assert.equal(wakes.id, byText(/Mac wakes/).id);
    assert.equal(new Set(requests.map((r) => r.id)).size, requests.length);
  });

  test('PR references resolve against known repos, harness included; unknown bare names are dropped', () => {
    assert.deepEqual(byText(/shop site/).prs, ['acme/shop-site#1']);
    assert.deepEqual(parseRequests(MD).find((r) => /shop site/.test(r.text)).prs, []);
    assert.deepEqual(byText(/Publish starter/).prs, ['acme/claude-harness#2']);
    assert.deepEqual(byText(/Mission control fixes/).prs, ['acme/claude-harness#3']);
    assert.equal(resolvePrRef('Shop-Site', 4, REPOS), 'acme/shop-site#4');
    assert.equal(resolvePrRef('other/thing', 4, REPOS), 'other/thing#4');
    assert.equal(resolvePrRef('PR', 4, REPOS), null);
  });

  test('links include bare github.com addresses', () => {
    assert.deepEqual(byText(/Starter kit/).links, ['https://github.com/example/starter-kit']);
  });
});

describe('matchSessions', () => {
  const find = (work, links = NO_LINKS) => matchSessions(requests, work, links).get(byText(SYSTEM).id);

  test('matches on shared words in the same project and records which words', () => {
    const [m] = find([systemChat()]);
    assert.equal(m.how, 'words');
    assert.deepEqual(m.words.sort(), ['control', 'mission', 'page', 'system']);
    assert.match(m.why, /control/);
  });

  test('one shared word is not enough, and a different project never matches on words', () => {
    assert.deepEqual(find([session({ name: 'Mission planner' })]), []);
    assert.deepEqual(find([systemChat({ projectName: 'Other', project: 'haulco' })]), []);
  });

  test('sibling sessions that share only the project topic lose to the closest match', () => {
    const close = systemChat({ sessionId: 'close' });
    const sibling = session({ sessionId: 'sibling', name: 'Mission control QA queue' });
    assert.deepEqual(find([close, sibling]).map((m) => m.session.sessionId), ['close']);
  });

  test('a session whose PR the request names matches by PR even with unrelated words', () => {
    const req = byText(/Publish starter/);
    const [m] = matchSessions(requests, [session({ name: 'zzz', pr: { repo: 'acme/claude-harness', number: 2, url: 'u' } })], NO_LINKS).get(req.id);
    assert.equal(m.how, 'pr');
  });

  test('a manual link adds a session the words would not match, even from another project', () => {
    const odd = session({ sessionId: 'odd', name: 'unrelated', project: 'haulco', projectName: 'HaulCo' });
    const links = setLink(NO_LINKS, byText(SYSTEM).id, 'odd', true);
    const [m] = find([odd], links);
    assert.equal(m.how, 'manual');
  });

  test('a manual unlink removes an automatic match', () => {
    const links = setLink(NO_LINKS, byText(SYSTEM).id, 's1', false);
    assert.deepEqual(find([systemChat()], links), []);
  });

  test('done requests match no sessions', () => {
    assert.deepEqual(matchSessions(requests, [session({ name: 'Database storage' })], NO_LINKS).get(byText(/Database storage/).id), []);
  });
});

describe('work map states', () => {
  test('done: the result text, with the PR link', () => {
    const r = rowFor(/Mission control fixes/, []);
    assert.equal(r.state, 'done');
    assert.match(r.reason, /merged/);
    assert.equal(r.prUrl, 'https://github.com/acme/claude-harness/pull/3');
  });

  test('working: a busy session, naming its in-progress step', () => {
    const plan = { items: [{ content: 'Wire the page', status: 'in_progress' }], current: 'Wire the page' };
    const r = rowFor(SYSTEM, [systemChat({ busy: true, status: 'busy', plan })]);
    assert.equal(r.state, 'working');
    assert.match(r.reason, /Wire the page/);
    assert.equal(r.sessions[0].how, 'words');
  });

  test('a busy session beats the waiting-on-owner section', () => {
    const r = rowFor(/Mac wakes/, [session({ name: 'Mac wakes morning jobs', busy: true, status: 'busy' })]);
    assert.equal(r.state, 'working');
  });

  test('paused: the session is stopped at a usage limit', () => {
    const pauses = [{ sessionId: 's1', resetsAt: ago(-2), handled: false, due: false }];
    const r = rowFor(SYSTEM, [systemChat()], { limitPauses: pauses });
    assert.equal(r.state, 'paused');
    assert.match(r.reason, /usage limit/);
    assert.equal(r.at, ago(-2));
  });

  test('paused beats waiting on the owner; a handled pause does not count', () => {
    const work = [session({ name: 'Mac wakes morning jobs' })];
    assert.equal(rowFor(/Mac wakes/, work, { limitPauses: [{ sessionId: 's1', resetsAt: ago(-1), handled: false }] }).state, 'paused');
    assert.equal(rowFor(/Mac wakes/, work, { limitPauses: [{ sessionId: 's1', resetsAt: ago(-1), handled: true }] }).state, 'waiting_you');
  });

  test('waiting_you: the waiting section, or a request PR that is a QA card', () => {
    assert.equal(rowFor(/Mac wakes/, []).state, 'waiting_you');
    const viaCard = rowFor(/Publish starter/, [], { qaCards: [{ key: 'acme/claude-harness#2', nextAction: 'Review, then merge into main.', waitingSince: ago(9) }] });
    assert.equal(viaCard.state, 'waiting_you');
    assert.equal(viaCard.qaKey, 'acme/claude-harness#2');
    assert.equal(viaCard.reason, 'Review, then merge into main.');
  });

  test('waiting_helper: idle with a step still in progress, however long', () => {
    const plan = { items: [{ content: 'Edit screens', status: 'in_progress' }], current: 'Edit screens' };
    const r = rowFor(SYSTEM, [systemChat({ lastAt: ago(5), plan })]);
    assert.equal(r.state, 'waiting_helper');
    assert.match(r.reason, /idle for 5h/);
    assert.match(r.reason, /Edit screens/);
  });

  test('waiting_helper: idle under two hours with nothing in progress', () => {
    const r = rowFor(SYSTEM, [systemChat({ lastAt: ago(1) })]);
    assert.equal(r.state, 'waiting_helper');
    assert.equal(r.canStart, false);
  });

  test('not_worked: idle for hours with nothing in progress', () => {
    const r = rowFor(SYSTEM, [systemChat({ lastAt: ago(3) })]);
    assert.equal(r.state, 'not_worked');
    assert.match(r.reason, /stopped 3h ago with nothing in progress/);
    assert.equal(r.canStart, true);
  });

  test('not_worked: a working-section request with no session says no session is open', () => {
    const r = rowFor(SYSTEM, []);
    assert.equal(r.state, 'not_worked');
    assert.match(r.reason, /no session is open/);
  });

  test('buildWorkMap counts every state and lists sessions that match no request', () => {
    const stray = session({ sessionId: 'stray', name: 'Taxes helper', projectName: 'Elsewhere', lastAt: ago(1), doing: { text: 'Reading', tool: 'Read', at: ago(1) } });
    const map = buildWorkMap({ requests, work: [systemChat({ busy: true, status: 'busy' }), stray], now: NOW });
    assert.deepEqual(Object.keys(map.counts), ['done', 'working', 'paused', 'waiting_you', 'waiting_helper', 'not_worked']);
    assert.equal(Object.values(map.counts).reduce((a, b) => a + b, 0), requests.length);
    assert.equal(map.counts.working, 1);
    assert.deepEqual(map.other.map((o) => o.sessionId), ['stray']);
    assert.equal(map.other[0].doing, 'Reading');
  });
});

describe('links file', () => {
  test('setLink, saveLinks and loadLinks round trip', () => {
    const file = join(tmp, 'state', 'request-links.json');
    assert.deepEqual(loadLinks(file), NO_LINKS);
    let links = setLink(NO_LINKS, 'r1', 'a', true);
    links = setLink(links, 'r1', 'b', false);
    links = setLink(links, 'r2', 'a', false);
    saveLinks(file, links);
    assert.deepEqual(loadLinks(file), { link: { r1: ['a'] }, unlink: { r1: ['b'], r2: ['a'] } });
    const back = setLink(loadLinks(file), 'r1', 'b', true);
    assert.deepEqual(back, { link: { r1: ['a', 'b'] }, unlink: { r2: ['a'] } });
  });

  test('a corrupt links file loads as empty', () => {
    const file = join(tmp, 'bad.json');
    saveLinks(file, { link: 'nope' });
    assert.deepEqual(loadLinks(file), NO_LINKS);
  });
});

describe('snake_case names in a request', () => {
  test('keep their underscores while emphasis marks still go', () => {
    const md = '## Waiting on the owner\n\n| Asked | Request | Project | Where it stands |\n| --- | --- | --- | --- |\n| 11-04 | Run the form_submissions migration | harness | Add `NEXT_PUBLIC_SITE_URL` and _soon_. |\n';
    const [r] = parseRequests(md);
    assert.equal(r.text, 'Run the form_submissions migration');
    assert.equal(r.stands, 'Add NEXT_PUBLIC_SITE_URL and soon.');
  });
});

test('a busy session with no plan step reads what it is doing as words', () => {
  const md = '## Working\n\n| Asked | Request | Project | Where it stands |\n| --- | --- | --- | --- |\n| 11-04 | Shop checkout rebuild | shop | building |\n';
  const reqs = parseRequests(md, { repos: [] });
  const busy = session({ name: 'Shop checkout rebuild', projectName: 'shop', busy: true, status: 'busy', doing: { text: 'Editing cart.js', tool: 'Edit', at: ago(1) } });
  const { rows } = buildWorkMap({ requests: reqs, work: [busy], limitPauses: [], qaCards: [], links: { link: {}, unlink: {} }, now: new Date() });
  assert.equal(rows[0].state, 'working');
  assert.match(rows[0].reason, /Editing cart\.js/);
  assert.doesNotMatch(rows[0].reason, /object/);
});
