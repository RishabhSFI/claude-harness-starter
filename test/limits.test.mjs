import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { appendFileSync, existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, utimesSync, writeFileSync } from 'node:fs';
import { request } from 'node:http';
import { createServer as netServer } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { after, describe, test } from 'node:test';
import { fileURLToPath } from 'node:url';

const ROOT = realpathSync(join(fileURLToPath(import.meta.url), '..', '..'));
const COS = join(ROOT, 'cos.mjs');
const { parseResetText, resetOf } = await import('../limits.mjs');
const q = await import('../mc/queue.mjs');
const { createMissionControl } = await import('../mc/server.mjs');

const tmp = realpathSync(mkdtempSync(join(tmpdir(), 'limits-test-')));
after(() => rmSync(tmp, { recursive: true, force: true }));

const PAUSED_AT = new Date('2026-11-04T23:01:12.776Z');
const iso = (s) => parseResetText(s, PAUSED_AT)?.toISOString() ?? null;

describe('reading the reset time', () => {
  test('a time and zone with no date is the next time it comes round', () => {
    assert.equal(iso("You've hit your session limit · resets 6:20pm (America/Toronto)"), '2026-11-04T23:20:00.000Z');
    assert.equal(iso('resets 1:50am (America/Toronto)'), '2026-11-05T06:50:00.000Z', 'after midnight local is the next day');
    assert.equal(parseResetText('resets 6:20pm (America/Toronto)', new Date('2026-11-04T23:30:00Z')).toISOString(), '2026-11-05T23:20:00.000Z', 'a time already passed means tomorrow');
    assert.equal(iso('resets 7am (Asia/Tokyo)'), '2026-11-05T22:00:00.000Z', 'it is already the 5th in Tokyo when the pause happens');
  });

  test('a date is read with or without a year boundary', () => {
    assert.equal(iso("You've hit your weekly limit · resets Nov 7, 6pm (America/Toronto)"), '2026-11-07T23:00:00.000Z');
    assert.equal(iso('resets on Nov 7 at 18:30 (Europe/London)'), '2026-11-07T18:30:00.000Z');
    assert.equal(parseResetText('resets Jan 2, 9am (Asia/Tokyo)', new Date('2026-12-30T12:00:00Z')).toISOString(), '2027-01-02T00:00:00.000Z');
  });

  test('daylight saving is applied for the reset day, not the pause day', () => {
    assert.equal(parseResetText('resets Mar 8, 3am (America/Toronto)', new Date('2026-03-07T12:00:00Z')).toISOString(), '2026-03-08T07:00:00.000Z');
    assert.equal(parseResetText('resets 3am (America/Toronto)', new Date('2026-03-07T12:00:00Z')).toISOString(), '2026-03-08T07:00:00.000Z');
  });

  test('a time skipped by spring-forward resolves after the change, never before', () => {
    assert.equal(parseResetText('resets 2:30am (America/Toronto)', new Date('2026-03-08T01:00:00Z')).toISOString(), '2026-03-08T07:30:00.000Z');
    assert.equal(parseResetText('resets 1:30am (Europe/London)', new Date('2026-03-28T22:00:00Z')).toISOString(), '2026-03-29T01:30:00.000Z');
    assert.equal(parseResetText('resets 2:30am (Australia/Sydney)', new Date('2026-10-03T12:00:00Z')).toISOString(), '2026-10-03T16:30:00.000Z');
  });

  test('a time repeated by fall-back takes the later instant in every zone', () => {
    assert.equal(parseResetText('resets 1:30am (America/Toronto)', new Date('2026-11-01T03:00:00Z')).toISOString(), '2026-11-01T06:30:00.000Z');
    assert.equal(parseResetText('resets 1:30am (Europe/London)', new Date('2026-10-24T22:00:00Z')).toISOString(), '2026-10-25T01:30:00.000Z');
  });

  test('no zone uses the given default; the old epoch form works; nonsense gives null', () => {
    assert.equal(parseResetText('Claude usage limit reached. Resets at 5pm.', PAUSED_AT, 'UTC').toISOString(), '2026-11-05T17:00:00.000Z');
    assert.equal(iso('Claude AI usage limit reached|1793834400'), '2026-11-04T23:20:00.000Z');
    assert.equal(iso('resets 3pm (Mars/Olympus)'), null);
    assert.equal(iso('resets in 3 hours'), null);
    assert.equal(iso('API Error: Your computer went to sleep mid-response.'), null);
    assert.equal(iso('resets 13pm'), null);
  });

  test('the structured resetsAt on the record wins over the text', () => {
    const record = { quotaLimits: { resetsAt: 1793838000 }, message: { content: [{ type: 'text', text: 'resets 6:20pm (America/Toronto)' }] } };
    assert.equal(resetOf(record, PAUSED_AT).toISOString(), '2026-11-05T00:20:00.000Z');
  });
});

const PROJECTS_DIR = join(tmp, 'projects');
const MARKS = join(tmp, 'state', 'resumed.json');
const DESKTOP = join(tmp, 'desktop');
mkdirSync(join(DESKTOP, 'acct', 'org'), { recursive: true });
writeFileSync(join(DESKTOP, 'acct', 'org', 'local_aaa.json'), JSON.stringify({ sessionId: 'local_aaa', cliSessionId: 'paused', isArchived: false, title: 'Alpha: build it' }));
writeFileSync(join(DESKTOP, 'acct', 'org', 'local_ccc.json'), JSON.stringify({ sessionId: 'local_ccc', cliSessionId: 'other', lastAssistantCliSessionId: 'poked-early', isArchived: false }));
writeFileSync(join(DESKTOP, 'acct', 'org', 'local_bbb.json'), JSON.stringify({ sessionId: 'local_bbb', cliSessionId: 'sidechain', isArchived: true }));
writeFileSync(join(DESKTOP, 'acct', 'org', 'local_bad.json'), '{ not json');
const REGISTRY = join(tmp, 'projects.json');
writeFileSync(REGISTRY, JSON.stringify({ projects: [{ id: 'alpha', name: 'Alpha', checkouts: [join(tmp, 'alpha')], aliases: [], keywords: [], public: {} }] }));

const SESSION_LIMIT = "You've hit your session limit · resets 6:20pm (America/Toronto)";

/** The record Claude Code writes on a usage-limit stop, trimmed from a real transcript. */
const limitRecord = (sessionId, at, { text = SESSION_LIMIT, resetsAt = 1793834400, cwd = join(tmp, 'alpha', 'sub') } = {}) => ({
  type: 'assistant',
  isSidechain: false,
  timestamp: at,
  sessionId,
  cwd,
  message: { model: '<synthetic>', role: 'assistant', content: [{ type: 'text', text }] },
  apiError: 'usage_limit_reached',
  ...(resetsAt ? { quotaLimits: { status: 'rejected', resetsAt, rateLimitType: 'five_hour' } } : {}),
  error: 'rate_limit',
  isApiErrorMessage: true,
  apiErrorStatus: 429,
});
const userRecord = (sessionId, at, text, extra = {}) => ({ type: 'user', isSidechain: false, timestamp: at, sessionId, cwd: join(tmp, 'alpha'), message: { role: 'user', content: text }, ...extra });
const replyRecord = (sessionId, at, extra = {}) => ({ type: 'assistant', isSidechain: false, timestamp: at, sessionId, cwd: join(tmp, 'alpha'), message: { model: 'claude-opus-5-5', role: 'assistant', content: [{ type: 'text', text: 'ok' }] }, ...extra });
const titleRecord = (sessionId, title) => ({ type: 'custom-title', customTitle: title, sessionId });

function transcript(id, records, { folder = '-tmp-alpha', ageDays = 0 } = {}) {
  const dir = join(PROJECTS_DIR, folder);
  mkdirSync(dir, { recursive: true });
  const file = join(dir, `${id}.jsonl`);
  writeFileSync(file, records.map((r) => JSON.stringify(r)).join('\n') + '\n');
  if (ageDays) {
    const t = (Date.now() - ageDays * 24 * 3600_000) / 1000;
    utimesSync(file, t, t);
  }
  return file;
}

function cos(...args) {
  const r = spawnSync(process.execPath, [COS, 'paused', '--registry', REGISTRY, '--projects-dir', PROJECTS_DIR, '--desktop-dir', DESKTOP, '--marks-file', MARKS, ...args], { encoding: 'utf8' });
  assert.equal(r.status, 0, r.stderr);
  return r.stdout;
}
const pausedJson = (...args) => JSON.parse(cos('--json', ...args)).paused;
const ids = (list) => list.map((p) => p.sessionId).sort();

const AFTER_RESET = '2026-11-04T23:30:00Z';
const BEFORE_RESET = '2026-11-04T23:10:00Z';

describe('cos paused', () => {
  transcript('paused', [userRecord('paused', '2026-11-04T22:50:00Z', 'build it'), replyRecord('paused', '2026-11-04T22:55:00Z'), titleRecord('paused', 'Alpha: build it'), limitRecord('paused', '2026-11-04T23:01:12.776Z'), { type: 'cost-state', totalCostUSD: 1 }]);
  transcript('resumed', [limitRecord('resumed', '2026-11-04T23:01:00Z'), userRecord('resumed', '2026-11-04T23:25:00Z', 'continue'), replyRecord('resumed', '2026-11-04T23:25:05Z')]);
  transcript('resuming', [limitRecord('resuming', '2026-11-04T23:01:00Z'), userRecord('resuming', '2026-11-04T23:25:00Z', 'continue')]);
  transcript('active', [userRecord('active', '2026-11-04T23:00:00Z', 'go'), replyRecord('active', '2026-11-04T23:00:05Z')]);
  transcript('poked-early', [limitRecord('poked-early', '2026-11-04T23:01:00Z'), userRecord('poked-early', '2026-11-04T23:05:00Z', 'are you there?')]);
  transcript('notified', [
    limitRecord('notified', '2026-11-04T23:01:00Z'),
    userRecord('notified', '2026-11-04T23:40:00Z', '<task-notification>\n<task-id>x</task-id></task-notification>', { queueTranscriptOnly: true }),
  ]);
  transcript('sidechain', [limitRecord('sidechain', '2026-11-04T23:01:00Z'), replyRecord('sidechain', '2026-11-04T23:02:00Z', { isSidechain: true })]);
  transcript('slept', [{ ...replyRecord('slept', '2026-11-04T23:01:00Z'), isApiErrorMessage: true, error: 'server_error', message: { model: '<synthetic>', content: [{ type: 'text', text: 'API Error: Your computer went to sleep mid-response.' }] } }]);
  transcript('old', [limitRecord('old', '2026-10-01T10:00:00Z')], { ageDays: 20 });
  transcript('weekly', [limitRecord('weekly', '2026-11-04T23:05:00Z', { text: "You've hit your weekly limit · resets Nov 7, 6pm (America/Toronto)", resetsAt: null })], { folder: '-tmp-beta' });
  transcript('bare', [limitRecord('bare', '2026-11-04T23:05:00Z', { text: 'Usage limit reached.', resetsAt: null }), { type: 'relocated', relocatedCwd: '/somewhere/else' }], { folder: '-tmp-beta' });

  test('lists sessions whose last word is a limit stop, and only those', () => {
    const list = pausedJson('--now', AFTER_RESET);
    assert.deepEqual(ids(list), ['bare', 'notified', 'paused', 'poked-early', 'sidechain', 'weekly']);
    const p = list.find((x) => x.sessionId === 'paused');
    assert.equal(p.title, 'Alpha: build it');
    assert.equal(p.project, 'alpha', 'cwd maps to its project');
    assert.equal(p.pausedAt, '2026-11-04T23:01:12.776Z');
    assert.equal(p.resetsAt, '2026-11-04T23:20:00.000Z');
    assert.equal(p.due, true);
    assert.equal(list.find((x) => x.sessionId === 'weekly').resetsAt, '2026-11-07T23:00:00.000Z', 'text reset when the record has no structured one');
    const bare = list.find((x) => x.sessionId === 'bare');
    assert.equal(bare.resetGuessed, true);
    assert.equal(bare.resetsAt, '2026-11-05T04:05:00.000Z', 'five hours when no reset is named');
    assert.equal(bare.cwd, '/somewhere/else');
  });

  test('--due keeps only pauses whose reset has passed', () => {
    assert.deepEqual(ids(pausedJson('--due', '--now', BEFORE_RESET)), []);
    assert.deepEqual(ids(pausedJson('--due', '--now', AFTER_RESET)), ['notified', 'paused', 'poked-early'], 'archived chats are never due');
    assert.match(cos('--due', '--now', BEFORE_RESET), /No paused sessions are due/);
    assert.match(cos('--now', BEFORE_RESET), /Alpha: build it \[alpha\]: paused .*resets/);
  });

  test('each pause carries its desktop chat id when the app knows the transcript', () => {
    const byId = Object.fromEntries(pausedJson('--now', AFTER_RESET).map((p) => [p.sessionId, p]));
    assert.equal(byId.paused.localId, 'local_aaa');
    assert.equal(byId['poked-early'].localId, 'local_ccc', 'matched by the last transcript the chat ran');
    assert.equal(byId.sidechain.archived, true);
    assert.equal(byId.weekly.localId, null, 'unknown to the app: fall back to list_sessions');
    assert.match(cos('--now', AFTER_RESET), /local_aaa/);
  });

  test('a prompt after the reset counts as resumed even before the reply lands', () => {
    const list = ids(pausedJson('--now', AFTER_RESET));
    assert.ok(!list.includes('resuming'));
    assert.ok(!list.includes('resumed'));
  });

  test('listing never writes the marks file', () => {
    pausedJson('--due', '--now', AFTER_RESET);
    assert.equal(existsSync(MARKS), false);
  });

  test('--mark hides a pause from --due once, and a later pause of the same session shows again', () => {
    assert.match(cos('--mark', 'paused', '--now', AFTER_RESET), /paused: marked as resumed/);
    assert.match(cos('--mark', 'local_aaa', '--now', AFTER_RESET), /already marked/, 'the desktop id names the same pause');
    assert.ok(!ids(pausedJson('--due', '--now', AFTER_RESET)).includes('paused'));
    assert.equal(pausedJson('--now', AFTER_RESET).find((p) => p.sessionId === 'paused').handled, true, 'still listed without --due, flagged handled');
    const marks = JSON.parse(readFileSync(MARKS, 'utf8'));
    assert.deepEqual(Object.keys(marks), ['paused']);

    const file = join(PROJECTS_DIR, '-tmp-alpha', 'paused.jsonl');
    for (const r of [userRecord('paused', '2026-11-05T00:00:00Z', 'continue'), replyRecord('paused', '2026-11-05T00:00:05Z'), limitRecord('paused', '2026-11-05T01:00:00Z', { resetsAt: 1793862000 })]) {
      appendFileSync(file, JSON.stringify(r) + '\n');
    }
    assert.ok(ids(pausedJson('--due', '--now', '2026-11-05T08:00:00Z')).includes('paused'), 'a new pause is due again');
  });

  test('--mark leaves a pause alone when it is not due or not the pause that was listed', () => {
    transcript('rebound', [limitRecord('rebound', '2026-11-04T23:01:00Z'), userRecord('rebound', '2026-11-04T23:25:00Z', 'continue'), limitRecord('rebound', '2026-11-04T23:25:03Z', { resetsAt: 1793862000 })]);
    assert.match(cos('--mark', 'rebound', '--now', AFTER_RESET), /new reset has not passed/);
    assert.match(cos('--mark', 'rebound', '--paused-at', '2026-11-04T23:01:00Z', '--now', '2026-11-05T08:00:00Z'), /paused again since that listing/);
    assert.ok(!('rebound' in JSON.parse(readFileSync(MARKS, 'utf8'))));
    assert.ok(ids(pausedJson('--due', '--now', '2026-11-05T08:00:00Z')).includes('rebound'), 'woken after the new reset');
    assert.match(cos('--mark', 'rebound', '--paused-at', '2026-11-04T23:25:03Z', '--now', '2026-11-05T08:00:00Z'), /marked as resumed/);
  });

  test('the resume task never lists its own runs', () => {
    const prompt = [
      { type: 'text', text: '<system-reminder>\nLinked sessions now: none\n</system-reminder>' },
      { type: 'text', text: 'This is the resume-paused-sessions task.\n\nWake desktop chats...' },
    ];
    transcript('resume-run', [userRecord('resume-run', '2026-11-04T23:00:00Z', prompt), limitRecord('resume-run', '2026-11-04T23:01:00Z')]);
    assert.ok(!ids(pausedJson('--now', AFTER_RESET)).includes('resume-run'));
  });

  test('--mark on a session that is not paused changes nothing', () => {
    const before = readFileSync(MARKS, 'utf8');
    assert.match(cos('--mark', 'active', '--now', AFTER_RESET), /not paused any more/);
    assert.equal(readFileSync(MARKS, 'utf8'), before);
  });
});

describe('mission control and limit pauses', () => {
  test('Needs you shows recent due pauses one by one and later resets as one line', async () => {
    const { buildNeedsYou } = await import('../mc/snapshot.mjs');
    const now = new Date('2026-11-05T12:00:00Z');
    const pause = (sessionId, resetsAt, extra = {}) => ({ sessionId, title: sessionId, cwd: '/x', resetsAt, due: Date.parse(resetsAt) <= now.getTime(), handled: false, ...extra });
    const rows = buildNeedsYou({
      status: null,
      prs: [],
      tasks: [],
      waiting: {},
      settings: { paused: false },
      now,
      limitPauses: [pause('fresh', '2026-11-05T11:00:00Z'), pause('woken', '2026-11-05T11:00:00Z', { handled: true }), pause('abandoned', '2026-11-03T11:00:00Z'), pause('later', '2026-11-05T15:00:00Z'), pause('later2', '2026-11-05T18:00:00Z')],
    }).filter((r) => r.kind === 'limit');
    assert.equal(rows.length, 2);
    assert.match(rows[0].text, /^fresh is still stopped/);
    assert.match(rows[1].text, /^2 chats are stopped at a usage limit; the next reset is/);
  });

  test('liftExpiredPause lifts only a pause whose reset has passed', () => {
    const paused = { cap: 3, paused: true, pauseReason: 'limit', pausedUntil: '2026-11-04T23:20:00.000Z' };
    assert.equal(q.liftExpiredPause(paused, new Date('2026-11-04T23:19:59Z')), paused);
    assert.deepEqual(q.liftExpiredPause(paused, new Date('2026-11-04T23:20:00Z')), { cap: 3, paused: false, pauseReason: null });
    const manual = { ...paused, pausedUntil: null };
    assert.equal(q.liftExpiredPause(manual, new Date('2030-01-01T00:00:00Z')), manual, 'a pause with no reset time waits for the owner');
  });

  test('loadSettings keeps a valid pausedUntil and drops a bad one', () => {
    const file = join(tmp, 'settings-check.json');
    writeFileSync(file, JSON.stringify({ paused: true, pauseReason: 'x', pausedUntil: '2026-11-04T23:20:00.000Z' }));
    assert.equal(q.loadSettings(file).pausedUntil, '2026-11-04T23:20:00.000Z');
    writeFileSync(file, JSON.stringify({ paused: true, pausedUntil: 'soon' }));
    assert.equal('pausedUntil' in q.loadSettings(file), false);
  });

  test('the server unpauses the queue once the reset passes and lists paused sessions', async () => {
    const stateDir = join(tmp, 'mc-state');
    mkdirSync(stateDir, { recursive: true });
    writeFileSync(join(stateDir, 'settings.json'), JSON.stringify({ cap: 3, paused: true, pauseReason: 'a start hit a usage limit', pausedUntil: new Date(Date.now() - 1000).toISOString() }));
    const projectsDir = join(tmp, 'mc-projects');
    const now = new Date();
    const later = new Date(now.getTime() + 3600_000);
    mkdirSync(join(projectsDir, '-x'), { recursive: true });
    writeFileSync(join(projectsDir, '-x', 'waiting.jsonl'), JSON.stringify({ ...limitRecord('waiting', now.toISOString(), { resetsAt: Math.floor(later.getTime() / 1000) }), cwd: tmp }) + '\n');
    const port = await new Promise((done) => {
      const srv = netServer().listen(0, '127.0.0.1', () => {
        const p = srv.address().port;
        srv.close(() => done(p));
      });
    });
    const mc = createMissionControl({
      port,
      registryFile: REGISTRY,
      stateDir,
      tokenFile: join(tmp, 'mc-home', 'mission-control.token'),
      claudeBin: null,
      projectsDir,
      intervals: { sessionsMs: 3_600_000, statusMs: 3_600_000, sweepMs: 3_600_000, pausedMs: 3_600_000, usageMs: 3_600_000 },
    });
    try {
      await mc.listen();
      assert.equal(mc.state.settings.paused, false, 'lifted on the first tick');
      assert.equal(JSON.parse(readFileSync(join(stateDir, 'settings.json'), 'utf8')).paused, false, 'and saved');
      const snap = await new Promise((done, fail) => {
        request({ host: '127.0.0.1', port, path: '/api/state', headers: { Authorization: `Bearer ${mc.token}`, Host: `127.0.0.1:${port}` } }, (res) => {
          let body = '';
          res.on('data', (c) => (body += c));
          res.on('end', () => done(JSON.parse(body)));
        })
          .on('error', fail)
          .end();
      });
      assert.deepEqual(snap.limitPauses.map((p) => [p.sessionId, p.resetsAt, p.due]), [['waiting', new Date(Math.floor(later.getTime() / 1000) * 1000).toISOString(), false]]);
      const row = snap.needsYou.find((n) => n.kind === 'limit');
      assert.match(row.text, /1 chat is stopped at a usage limit; the next reset is/);
      assert.ok(!snap.needsYou.some((n) => n.kind === 'paused'), 'no pause notice once lifted');
    } finally {
      await mc.close();
    }
  });
});
