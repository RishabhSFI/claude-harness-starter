#!/usr/bin/env node
import { randomBytes, timingSafeEqual } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { chmodSync, existsSync, mkdirSync, readFileSync, realpathSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { createServer } from 'node:http';
import { homedir } from 'node:os';
import { basename, dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { findGh, githubRepoOf, loadRegistry } from '../cos.mjs';
import { findPaused, parseResetText } from '../limits.mjs';
import * as actions from './actions.mjs';
import { createActivityReader, DEFAULT_PROJECTS_DIR } from './activity.mjs';
import { buildQa, createQaFetcher, isQaPr, loadReviewed, saveReviewed } from './qa.mjs';
import * as q from './queue.mjs';
import { loadLinks, parseRequests, saveLinks, setLink } from './requests.mjs';
import { cachedSecrets } from '../secrets.mjs';
import { buildSnapshot, prRef, readSweep } from './snapshot.mjs';
import { canStop, createSystemSampler, folderTargets, REFUSALS } from './system.mjs';
import { createUsageTracker } from './usage.mjs';

const MC_DIR = dirname(fileURLToPath(import.meta.url));
const HARNESS_DIR = dirname(MC_DIR);
const PUBLIC_DIR = join(MC_DIR, 'public');
const MAX_BODY = 64 * 1024;
const STATIC = {
  '/': ['index.html', 'text/html; charset=utf-8'],
  '/app.js': ['app.js', 'text/javascript; charset=utf-8'],
  '/app.css': ['app.css', 'text/css; charset=utf-8'],
};
const SECURITY_HEADERS = {
  'Cache-Control': 'no-store',
  'Content-Security-Policy': "default-src 'none'; script-src 'self'; style-src 'self'; connect-src 'self'; img-src 'self' data:; base-uri 'none'; form-action 'none'; frame-ancestors 'none'",
  'Referrer-Policy': 'no-referrer',
  'X-Content-Type-Options': 'nosniff',
};
export const DEFAULT_INTERVALS = { sessionsMs: 3_000, statusMs: 60_000, sweepMs: 600_000, usageMs: 60_000, pausedMs: 60_000 };

class HttpError extends Error {
  constructor(status, message, extra = {}) {
    super(message);
    this.status = status;
    this.extra = extra;
  }
}

/** Reads the token, making a fresh one (mode 0600) on first run. */
export function ensureToken(file) {
  mkdirSync(dirname(file), { recursive: true });
  if (existsSync(file)) {
    const token = readFileSync(file, 'utf8').trim();
    if (token.length >= 32) {
      chmodSync(file, 0o600);
      return token;
    }
  }
  const token = randomBytes(32).toString('hex');
  writeFileSync(file, `${token}\n`, { mode: 0o600 });
  chmodSync(file, 0o600);
  return token;
}

function pidAlive(pid) {
  try {
    process.kill(pid, 0);
    return true;
  } catch (e) {
    return e.code === 'EPERM';
  }
}

/** Claims `file` for this process. Refuses while another live server holds it; takes over a stale one. */
export function takeLock(file, port) {
  mkdirSync(dirname(file), { recursive: true });
  for (let tries = 0; tries < 2; tries++) {
    try {
      writeFileSync(file, `${JSON.stringify({ pid: process.pid, port })}\n`, { flag: 'wx' });
      return;
    } catch (e) {
      if (e.code !== 'EEXIST') throw e;
    }
    let held = null;
    try {
      held = JSON.parse(readFileSync(file, 'utf8'));
    } catch {}
    if (Number.isInteger(held?.pid) && pidAlive(held.pid)) {
      throw new Error(`Mission control is already running on this state (pid ${held.pid}, port ${held.port}). Stop it first.`);
    }
    rmSync(file, { force: true });
  }
  throw new Error(`Couldn't take the lock ${file}.`);
}

function dropLock(file) {
  try {
    if (JSON.parse(readFileSync(file, 'utf8')).pid === process.pid) rmSync(file, { force: true });
  } catch {}
}

function sameSecret(a, b) {
  const x = Buffer.from(String(a ?? ''));
  const y = Buffer.from(String(b));
  return x.length === y.length && timingSafeEqual(x, y);
}

function readBody(req) {
  return new Promise((done, fail) => {
    let size = 0;
    const chunks = [];
    req.on('data', (c) => {
      size += c.length;
      if (size > MAX_BODY) {
        fail(new HttpError(413, 'Request too large.'));
        req.destroy();
      } else chunks.push(c);
    });
    req.on('end', () => {
      try {
        const value = JSON.parse(Buffer.concat(chunks).toString('utf8') || '{}');
        if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error();
        done(value);
      } catch {
        fail(new HttpError(400, 'Send a JSON object.'));
      }
    });
    req.on('error', fail);
  });
}

function sendJson(res, status, value) {
  res.writeHead(status, { ...SECURITY_HEADERS, 'Content-Type': 'application/json; charset=utf-8' });
  res.end(JSON.stringify(value));
}

/** The harness itself as a project, so its requests can start a worker, its PRs get QA cards and its main branch needs the live confirm. */
function harnessProject(registryProjects, override) {
  if (registryProjects.some((p) => p.id === 'harness')) return [];
  const dir = override?.dir ?? HARNESS_DIR;
  let repo = override?.repo;
  if (repo === undefined) {
    try {
      repo = githubRepoOf(execFileSync('git', ['remote', 'get-url', 'origin'], { cwd: dir, encoding: 'utf8', timeout: 5000, stdio: ['ignore', 'pipe', 'ignore'] }));
    } catch {
      repo = null;
    }
  }
  return [{ id: 'harness', name: 'Harness', what: 'The tooling that runs these projects.', checkouts: [dir], aliases: [], keywords: [], public: { branches: ['main'], remotes: [], notes: [] }, repos: repo ? [repo] : [], site: null, secrets: [] }];
}

/** A short task title from a request: its first sentence, at most 80 characters. */
export function shortTitle(text) {
  const one = String(text).replace(/\s+/g, ' ').trim();
  const sentence = one.split(/(?<=[.!?:])\s/)[0];
  if (sentence.length <= 80) return sentence.replace(/[.:]$/, '');
  const cut = sentence.slice(0, 79);
  return `${cut.slice(0, cut.lastIndexOf(' ') > 40 ? cut.lastIndexOf(' ') : 79).trimEnd()}…`;
}

const SESSION_ID = /^[0-9a-f][0-9a-f-]{5,63}$/i;
const TASK_ID = /^[0-9a-f]{6}$/;

/**
 * @param {{port: number, registryFile?: string, requestsFile?: string, harness?: {dir?: string, repo?: string | null}, stateDir?: string, tokenFile?: string, projectsDir?: string, claudeBin?: string | null, ghBin?: string, intervals?: Partial<typeof DEFAULT_INTERVALS>, system?: ReturnType<typeof createSystemSampler> | null, kill?: (pid: number, signal: string) => void, log?: (line: string) => void}} opts
 */
export function createMissionControl(opts) {
  const port = opts.port;
  const registryFile = opts.registryFile ?? join(HARNESS_DIR, 'projects.json');
  const stateDir = opts.stateDir ?? join(MC_DIR, 'state');
  const files = { queue: join(stateDir, 'queue.json'), settings: join(stateDir, 'settings.json'), lock: join(stateDir, 'server.lock'), resumed: join(stateDir, 'resumed.json'), reviewed: join(stateDir, 'qa-reviewed.json'), links: join(stateDir, 'request-links.json'), requests: opts.requestsFile ?? join(dirname(resolve(registryFile)), 'wiki', 'topics', 'owner-requests.md'), secretsCache: join(dirname(resolve(registryFile)), '.claude', 'secrets-cache.json') };
  const intervals = { ...DEFAULT_INTERVALS, ...opts.intervals };
  const tokenFile = opts.tokenFile ?? join(homedir(), '.claude', 'mission-control.token');
  const token = ensureToken(tokenFile);
  const log = opts.log ?? (() => {});
  const ctx = { claudeBin: opts.claudeBin ?? null, ghBin: opts.ghBin ?? 'gh', harnessDir: HARNESS_DIR, registryFile, logFile: join(stateDir, 'actions.log') };
  const allowedHosts = new Set([`127.0.0.1:${port}`, `localhost:${port}`]);
  const allowedOrigins = new Set([...allowedHosts].map((h) => `http://${h}`));

  const registryProjects = loadRegistry(registryFile);
  const projects = [...registryProjects, ...harnessProject(registryProjects, opts.harness)];
  const roots = q.projectRoots(projects);
  const projectsDir = opts.projectsDir ?? DEFAULT_PROJECTS_DIR;
  const reader = createActivityReader({ projectsDir });
  const usage = createUsageTracker({ projectsDir });
  const system = opts.system ?? null;
  const kill = opts.kill ?? process.kill;
  const s = {
    tasks: q.loadQueue(files.queue),
    settings: q.loadSettings(files.settings),
    sessions: [],
    status: null,
    sweep: null,
    limitPauses: [],
    waiting: {},
    activity: new Map(),
    usage: undefined,
    errors: { sessions: null, status: null, qa: null },
    at: { sessions: null, status: null, sweep: null },
    launching: null,
    launchingId: null,
    closed: false,
    statusRun: null,
    sessionsRun: null,
    sessionsAgain: false,
    prLookups: new Set(),
    requests: { mtime: -2, list: [] },
    links: loadLinks(files.links),
    reviewed: loadReviewed(files.reviewed),
    qaDetails: new Map(),
    missingKeys: {},
    qaRun: null,
    qaVersion: 0,
    qaCache: null,
  };
  const allRepos = projects.flatMap((p) => p.repos);
  const qaFetcher = createQaFetcher({ exec: actions.exec, ghBin: ctx.ghBin });
  const qaProjects = () =>
    Object.fromEntries(projects.flatMap((p) => p.repos.map((repo) => [repo.toLowerCase(), { project: p.id, projectName: p.name, publicBranches: p.public ? p.public.branches : ['main'] }])));
  const tilde = (p) => (p.startsWith(homedir()) ? `~${p.slice(homedir().length)}` : p);
  const paths = { token: tilde(tokenFile), state: tilde(stateDir), log: tilde(ctx.logFile), transcripts: tilde(projectsDir) };
  const clients = new Set();
  const systemRoots = [...roots, ...[realpathSync(HARNESS_DIR), `${realpathSync(HARNESS_DIR)}-tasks`].map((root) => ({ id: 'harness', root }))];
  const systemEnv = {
    sessions: () => knownSessions(),
    active: () => clients.size > 0,
    roots: systemRoots,
    diskTargets: [
      { label: 'harness', path: HARNESS_DIR },
      { label: 'projects', path: dirname(projects[0]?.checkouts[0] ?? HARNESS_DIR) },
      { label: '~/.claude', path: join(homedir(), '.claude') },
    ],
    folderTargets: folderTargets({ projects, transcriptsDir: projectsDir, harnessDir: HARNESS_DIR, exists: existsSync }),
    onUpdate: () => !s.closed && publish(),
  };
  let lastBody = '';
  const timers = [];

  const saveTasks = () => q.saveQueue(files.queue, s.tasks);
  const saveSettings = () => q.saveSettings(files.settings, s.settings);
  const findTask = (id) => s.tasks.find((t) => t.id === id) ?? null;
  const replaceTask = (task) => {
    s.tasks = s.tasks.map((t) => (t.id === task.id ? task : t));
    saveTasks();
  };

  /** Checks one process against a fresh probe, signals it if the guard allows, and logs the attempt either way. */
  function stopOne(fresh, pid, startedAt) {
    const proc = fresh.procs.find((p) => p.pid === pid);
    const verdict = canStop(proc, { ...fresh.ctx, startedAt });
    const project = proc ? q.projectOfPath(systemRoots, proc.cwd) ?? proc.cmdProject ?? null : null;
    const fields = { pid, name: proc?.name ?? null, kind: proc?.kind ?? null, project };
    const name = proc ? `${proc.name} (${pid})` : `Process ${pid}`;
    if (!verdict.ok) {
      actions.logAction(ctx, 'system-stop', { ...fields, ok: false, reason: verdict.reason });
      return { ok: false, name, status: 409, message: REFUSALS[verdict.reason] };
    }
    let reason = null;
    try {
      kill(pid, 'SIGTERM');
    } catch (e) {
      reason = e.code === 'ESRCH' ? 'gone' : 'kill-failed';
    }
    actions.logAction(ctx, 'system-stop', { ...fields, ok: !reason, reason });
    if (reason) return { ok: false, name, status: reason === 'gone' ? 409 : 502, message: reason === 'gone' ? REFUSALS.gone : "Couldn't stop that process." };
    return { ok: true, name: proc.name };
  }

  /** Task worktrees still on disk whose task has finished (or left the queue). Removing them is the owner's call. */
  function leftover() {
    const live = new Set(s.tasks.filter((t) => !q.TERMINAL.has(t.state)).map((t) => `mc-${t.id}`));
    return actions.leftoverWorktrees(projects).filter((dir) => !live.has(basename(dir))).length;
  }

  /** The owner's request list, re-read only when the file changes. */
  function currentRequests() {
    let mtime = -1;
    try {
      mtime = statSync(files.requests).mtimeMs;
    } catch {}
    if (s.requests.mtime !== mtime) {
      let list = [];
      try {
        if (mtime >= 0) list = parseRequests(readFileSync(files.requests, 'utf8'), { repos: allRepos });
      } catch (e) {
        log(`request list read failed: ${e.message}`);
      }
      s.requests = { mtime, list };
      s.qaVersion += 1;
    }
    return s.requests.list;
  }

  function qaCards() {
    const requests = currentRequests();
    if (s.qaCache?.version !== s.qaVersion) {
      s.qaCache = { version: s.qaVersion, cards: buildQa({ details: [...s.qaDetails.values()], requests, reviewed: s.reviewed, ctx: { projects: qaProjects(), missingKeys: s.missingKeys } }) };
    }
    return s.qaCache.cards;
  }

  /** Which PRs deserve a closer look, then their details from GitHub. A failed fetch keeps the last good copy. */
  async function refreshQa() {
    if (s.qaRun) return s.qaRun;
    s.qaRun = (async () => {
      try {
        const requests = currentRequests();
        const byRepo = qaProjects();
        const waitingRefs = new Set(requests.filter((r) => r.section === 'waiting').flatMap((r) => r.prs.map((p) => p.toLowerCase())));
        const wanted = new Map();
        const want = (repo, number, updatedAt) => {
          const key = `${repo}#${number}`;
          if (byRepo[repo.toLowerCase()] && !wanted.has(key)) wanted.set(key, { key, repo, number, updatedAt });
        };
        for (const pr of q.prsFromStatus(s.status)) {
          const ref = prRef(pr.url);
          const per = { repo: ref?.repo ?? '', publicBranches: byRepo[ref?.repo.toLowerCase()]?.publicBranches, waitingRefs };
          if (ref && (pr.classification === 'review' || isQaPr({ baseRefName: pr.base, labels: pr.labels, number: pr.number }, per))) want(ref.repo, pr.number, pr.updatedAt);
        }
        const bucket = String(Math.floor(Date.now() / 300_000));
        for (const r of requests.filter((x) => x.section !== 'done')) {
          for (const ref of r.prs) {
            const m = ref.match(/^(.+)#(\d+)$/);
            if (m) want(m[1], Number(m[2]), bucket);
          }
        }
        let failed = null;
        const list = [...wanted.values()];
        for (let i = 0; i < list.length && !s.closed; i += 3) {
          await Promise.all(list.slice(i, i + 3).map(async (w) => {
            const r = await qaFetcher.get(w);
            if (r.ok) s.qaDetails.set(w.key, { repo: w.repo, detail: r.detail, deployments: r.deployments });
            else failed = `${w.key}: ${r.message}`;
          }));
        }
        for (const key of [...s.qaDetails.keys()]) if (!wanted.has(key)) s.qaDetails.delete(key);
        try {
          const missing = {};
          for (const r of cachedSecrets(projects, { cacheFile: files.secretsCache })) {
            const names = r.secrets.filter((x) => x.required && x.status === 'missing').map((x) => x.name);
            if (names.length) missing[r.id] = names;
          }
          s.missingKeys = missing;
        } catch (e) {
          log(`secrets cache read failed: ${e.message}`);
        }
        s.errors.qa = failed ? `Couldn't read ${failed}` : null;
        s.qaVersion += 1;
      } catch (e) {
        s.errors.qa = e.message;
        log(`qa refresh failed: ${e.stack}`);
      }
      s.qaRun = null;
      publish();
    })();
    return s.qaRun;
  }

  function snapshot() {
    const cards = qaCards();
    const queuedFor = new Set(s.tasks.filter((t) => t.requestId && !q.TERMINAL.has(t.state)).map((t) => t.requestId));
    const snap = buildSnapshot({
      projects,
      roots,
      status: s.status,
      sessions: s.sessions,
      tasks: s.tasks,
      settings: s.settings,
      waiting: s.waiting,
      sweep: s.sweep,
      limitPauses: s.limitPauses,
      activity: s.activity,
      usage: s.usage,
      qaCards: cards,
      requests: s.requests.list,
      links: s.links,
      system: system?.snapshot() ?? null,
      meta: { errors: s.errors, statusAt: s.at.status, sweepAt: s.at.sweep, claudeFound: Boolean(ctx.claudeBin), paths, leftover: leftover() },
    });
    snap.workMap.rows = snap.workMap.rows.map((r) => ({ ...r, queued: queuedFor.has(r.id) }));
    return snap;
  }

  function writeEvent(res, event, data) {
    res.write(`event: ${event}\ndata: ${data}\n\n`);
  }

  function publish() {
    const body = JSON.stringify(snapshot());
    if (body === lastBody) return;
    lastBody = body;
    for (const res of clients) writeEvent(res, 'state', body);
  }

  function ping() {
    const data = JSON.stringify({ sessionsAt: s.at.sessions, statusAt: s.at.status });
    for (const res of clients) writeEvent(res, 'ping', data);
  }

  /** The session list when it's current, or null when it was never read or the last read failed. */
  const knownSessions = () => (s.at.sessions && !s.errors.sessions ? s.sessions : null);

  async function launch(task) {
    try {
      const project = projects.find((p) => p.id === task.project);
      replaceTask(q.transition(task, 'starting', { note: 'scheduler', patch: { startedAt: new Date().toISOString() } }));
      publish();
      const r = await actions.startTask(ctx, findTask(task.id), project);
      const current = findTask(task.id);
      if (current.state !== 'starting') {
        if (r.ok && r.sessionId && q.TERMINAL.has(current.state)) await actions.stopSession(ctx, r.sessionId, { taskId: task.id, reason: `task ${current.state} while starting` });
        else if (r.ok && r.sessionId && !current.sessionId) replaceTask(q.annotate(current, 'matched session', { sessionId: r.sessionId }));
      } else if (r.ok) replaceTask(q.transition(current, 'working', { note: r.sessionId ? `session ${r.sessionId}` : 'started; session id not seen yet', patch: { sessionId: r.sessionId } }));
      else if (r.limit) {
        replaceTask(q.transition(current, 'queued', { note: `start hit a limit: ${r.message}` }));
        const now = new Date();
        const named = parseResetText(r.message, now);
        const reset = (named && named > now ? named.toISOString() : null) ?? s.limitPauses.filter((p) => !p.resetGuessed).map((p) => p.resetsAt).filter((t) => Date.parse(t) > now.getTime()).sort()[0] ?? null;
        s.settings = { ...s.settings, paused: true, pauseReason: `a start hit a usage or rate limit (${r.message.slice(0, 160)})`, ...(reset ? { pausedUntil: reset } : {}) };
        saveSettings();
      } else replaceTask(q.transition(current, 'failed', { note: r.message.slice(0, 300) }));
    } catch (e) {
      log(`launch failed: ${e.stack}`);
      const current = findTask(task.id);
      if (current && q.canTransition(current.state, 'failed')) replaceTask(q.transition(current, 'failed', { note: `start failed: ${e.message}`.slice(0, 300) }));
    }
  }

  function tick() {
    if (s.closed) return;
    const lifted = q.liftExpiredPause(s.settings);
    if (lifted !== s.settings) {
      s.settings = lifted;
      saveSettings();
      actions.logAction(ctx, 'settings', { paused: false, reason: 'usage limit reset' });
    }
    const prs = q.prsFromStatus(s.status);
    const moves = q.reconcile(s.tasks, { sessions: knownSessions(), prs, launching: s.launchingId });
    if (moves.length) {
      s.tasks = q.applyMoves(s.tasks, moves);
      saveTasks();
    }
    const { start, waiting } = q.pickNext(s.tasks, { settings: s.settings });
    s.waiting = waiting;
    if (start && !s.launching && !s.closed && s.at.sessions && !s.errors.sessions) {
      if (!ctx.claudeBin) s.waiting[start.id] = "can't find the claude CLI";
      else {
        s.launchingId = start.id;
        s.launching = launch(start).finally(() => {
          s.launching = null;
          s.launchingId = null;
          tick();
        });
      }
    }
    publish();
  }

  /** One `claude agents` read at a time. A call made during a read gets one more read after it, so results land in order. */
  function refreshSessions() {
    if (s.sessionsRun) {
      s.sessionsAgain = true;
      return s.sessionsRun;
    }
    s.sessionsRun = (async () => {
      do {
        s.sessionsAgain = false;
        await readSessions();
      } while (s.sessionsAgain);
      s.sessionsRun = null;
    })();
    return s.sessionsRun;
  }

  async function readSessions() {
    if (!ctx.claudeBin) {
      s.errors.sessions = "Can't find the claude CLI. Set CLAUDE_BIN.";
      publish();
      return;
    }
    try {
      s.sessions = await actions.listSessions(ctx.claudeBin);
      s.errors.sessions = null;
      s.at.sessions = new Date().toISOString();
      s.activity = await reader.readAll(s.sessions);
      if (s.usage) s.usage = usage.summary({ sessions: s.sessions, roots, projects });
    } catch (e) {
      s.errors.sessions = e.message;
    }
    tick();
    ping();
  }

  async function refreshUsage() {
    try {
      await usage.refresh();
      s.usage = usage.summary({ sessions: s.sessions, roots, projects });
    } catch (e) {
      log(`usage read failed: ${e.message}`);
    }
    publish();
  }

  /** A task whose PR left the open list: ask GitHub once whether it merged or closed. */
  async function settleClosedPrs() {
    const open = new Set(q.prsFromStatus(s.status).map((p) => p.url));
    for (const t of s.tasks) {
      if (!['in_review', 'ready_to_merge'].includes(t.state) || !t.pr) continue;
      const key = `${t.id}#${t.pr.number}`;
      if (open.has(t.pr.url)) {
        s.prLookups.delete(key);
        continue;
      }
      const ref = prRef(t.pr.url);
      if (!ref || s.prLookups.has(key)) continue;
      s.prLookups.add(key);
      const r = await actions.viewPr(ctx, ref.repo, ref.number, ['state']);
      const current = findTask(t.id);
      if (!r.ok || !current) continue;
      if (r.pr.state === 'MERGED' && q.canTransition(current.state, 'merged')) {
        replaceTask(q.transition(current, 'merged', { note: `PR #${ref.number} merged` }));
      } else if (r.pr.state === 'CLOSED' && q.canTransition(current.state, 'blocked')) {
        replaceTask(q.transition(current, 'blocked', { note: `PR #${ref.number} was closed without merging` }));
      }
    }
  }

  function refreshStatus() {
    if (s.statusRun) return s.statusRun;
    s.statusRun = (async () => {
      const r = await actions.exec(process.execPath, [join(HARNESS_DIR, 'cos.mjs'), 'status', '--json', '--registry', registryFile], { timeout: 180_000 });
      try {
        if (!r.ok) throw new Error((r.err || 'cos status failed').split('\n')[0]);
        s.status = JSON.parse(r.out);
        s.errors.status = null;
        s.at.status = new Date().toISOString();
        await settleClosedPrs();
      } catch (e) {
        s.errors.status = e.message;
      }
      s.statusRun = null;
      tick();
      void refreshQa();
    })();
    return s.statusRun;
  }

  function refreshLimitPauses() {
    try {
      s.limitPauses = findPaused({ projectsDir, desktopDir: null, marksFile: files.resumed });
    } catch (e) {
      log(`paused-session scan failed: ${e.message}`);
    }
    tick();
  }

  function refreshSweep() {
    try {
      s.sweep = readSweep(join(HARNESS_DIR, 'reports'));
      s.at.sweep = new Date().toISOString();
    } catch (e) {
      log(`sweep read failed: ${e.message}`);
    }
    publish();
  }

  /**
   * Stops a task's session and moves the task to `to`. A session that already ended needs no CLI call;
   * the returned message says so for the page.
   */
  async function endTask(task, to, verb) {
    const sessions = knownSessions();
    const session = sessions ? q.sessionFor(task, sessions) : null;
    let message = null;
    if (session || (!sessions && task.sessionId)) {
      const r = await actions.stopSession(ctx, session?.sessionId ?? task.sessionId, { taskId: task.id });
      if (!r.ok) throw new HttpError(502, r.message);
    } else if (!sessions) {
      throw new HttpError(503, "Can't read the session list right now, so there's no telling what to stop. Try again in a moment.");
    } else {
      message = task.sessionId ? 'Its session had already ended, so nothing needed stopping.' : `No session named "${task.sessionName}" is running, so nothing needed stopping.`;
    }
    replaceTask(q.transition(findTask(task.id), to, { note: `${verb} by the owner${message ? `. ${message}` : ''}` }));
    tick();
    return { ok: true, message };
  }

  function requireTask(id, states) {
    const task = TASK_ID.test(id) ? findTask(id) : null;
    if (!task) throw new HttpError(404, 'No such task.');
    if (states && !states.includes(task.state)) throw new HttpError(409, `That task is ${task.state.replace('_', ' ')}.`);
    return task;
  }

  function requireRequest(id) {
    const req = s.requests.list.find((r) => r.id === id) ?? (currentRequests(), s.requests.list.find((r) => r.id === id));
    if (!req) throw new HttpError(404, 'No such request.');
    return req;
  }

  /** Each handler gets the parsed body and route params, and returns a JSON-able result. */
  const ROUTES = [
    {
      path: /^\/api\/tasks$/,
      run: (body) => {
        let task;
        try {
          task = q.createTask(body, { projects });
        } catch (e) {
          throw new HttpError(400, e.message);
        }
        s.tasks = [...s.tasks, task];
        saveTasks();
        actions.logAction(ctx, 'add', { taskId: task.id, project: task.project, priority: task.priority, risky: task.risky });
        tick();
        return { ok: true, task: { id: task.id } };
      },
    },
    {
      path: /^\/api\/tasks\/([^/]+)\/approve$/,
      run: (_, [id]) => {
        const task = requireTask(id, ['queued']);
        replaceTask(q.annotate(task, 'start approved by the owner', { approved: true }));
        actions.logAction(ctx, 'approve', { taskId: id });
        tick();
        return { ok: true };
      },
    },
    {
      path: /^\/api\/tasks\/([^/]+)\/cancel$/,
      run: async (_, [id]) => {
        const task = requireTask(id, ['queued', 'starting']);
        actions.logAction(ctx, 'cancel', { taskId: id });
        if (task.state === 'starting') return endTask(task, 'cancelled', 'cancelled');
        replaceTask(q.transition(task, 'cancelled', { note: 'cancelled by the owner' }));
        tick();
        return { ok: true };
      },
    },
    {
      path: /^\/api\/tasks\/([^/]+)\/(up|down)$/,
      run: (_, [id, dir]) => {
        requireTask(id, ['queued']);
        s.tasks = q.move(s.tasks, id, dir);
        saveTasks();
        tick();
        return { ok: true };
      },
    },
    {
      path: /^\/api\/tasks\/([^/]+)\/stop$/,
      run: (_, [id]) => endTask(requireTask(id, ['starting', 'working', 'blocked', 'in_review', 'ready_to_merge']), 'stopped', 'stopped'),
    },
    {
      path: /^\/api\/sessions\/([^/]+)\/stop$/,
      run: async (body, [sessionId]) => {
        if (!SESSION_ID.test(sessionId)) throw new HttpError(400, 'Bad session id.');
        const d = actions.stopDecision({ sessionId, tasks: s.tasks, confirm: body.confirm });
        if (!d.allow) throw new HttpError(409, d.reason);
        const r = await actions.stopSession(ctx, sessionId);
        if (!r.ok) throw new HttpError(502, r.message);
        refreshSessions();
        return { ok: true };
      },
    },
    {
      path: /^\/api\/sessions\/([^/]+)\/open$/,
      run: (_, [sessionId]) => actions.openInApp(s.sessions.find((x) => x.sessionId === sessionId)),
    },
    {
      path: /^\/api\/merge$/,
      run: async (body) => {
        const repo = String(body.repo ?? '');
        const number = Number(body.number);
        if (!/^[\w.-]+\/[\w.-]+$/.test(repo) || !Number.isInteger(number) || number < 1) throw new HttpError(400, 'Need repo (owner/name) and PR number.');
        const poll = { at: s.at.status, error: s.errors.status };
        const r = await actions.mergePr(ctx, { projects, status: s.status, poll, repo, number, confirm: body.confirm, override: body.override });
        if (!r.ok) throw new HttpError(r.status, r.message, r.needs ? { needs: r.needs } : {});
        const sameRef = (url) => {
          const ref = prRef(url);
          return ref?.number === number && ref.repo.toLowerCase() === repo.toLowerCase();
        };
        const task = s.tasks.find((t) => sameRef(t.pr?.url) && q.canTransition(t.state, 'merged'));
        if (task) replaceTask(q.transition(task, 'merged', { note: `merged ${repo}#${number}` }));
        refreshStatus();
        return { ok: true };
      },
    },
    {
      path: /^\/api\/qa\/reviewed$/,
      run: (body) => {
        const key = String(body.key ?? '');
        if (!/^([\w.-]+\/[\w.-]+#\d+|req:[\w-]+)$/.test(key) || typeof body.on !== 'boolean') throw new HttpError(400, 'Need the card key and on: true or false.');
        const next = { ...s.reviewed };
        if (body.on) next[key] = new Date().toISOString();
        else delete next[key];
        s.reviewed = next;
        saveReviewed(files.reviewed, next);
        s.qaVersion += 1;
        publish();
        return { ok: true };
      },
    },
    {
      path: /^\/api\/requests\/([^/]+)\/link$/,
      run: (body, [id]) => {
        requireRequest(id);
        if (!SESSION_ID.test(String(body.sessionId ?? '')) || typeof body.on !== 'boolean') throw new HttpError(400, 'Need a session id and on: true or false.');
        s.links = setLink(s.links, id, body.sessionId, body.on);
        saveLinks(files.links, s.links);
        publish();
        return { ok: true };
      },
    },
    {
      path: /^\/api\/requests\/([^/]+)\/start$/,
      run: (_, [id]) => {
        const req = requireRequest(id);
        const project = projects.find((p) => p.id === req.project);
        if (req.section === 'done') throw new HttpError(400, 'That request is already done.');
        if (!project || !existsSync(project.checkouts[0] ?? '')) throw new HttpError(400, `${req.project ? `"${req.project}"` : 'This request'} isn't a project mission control can start a worker in.`);
        if (s.tasks.some((t) => t.requestId === id && !q.TERMINAL.has(t.state))) throw new HttpError(409, 'A worker is already queued for this request.');
        const prompt = [req.text, req.stands && `Where it stands: ${req.stands}`, req.prs.length && `Related pull requests: ${req.prs.join(', ')}`, `From the owner's request list${req.asked ? ` (asked ${req.asked})` : ''}.`].filter(Boolean).join('\n\n');
        const task = { ...q.createTask({ project: project.id, title: shortTitle(req.text), prompt }, { projects }), requestId: id };
        s.tasks = [...s.tasks, task];
        saveTasks();
        actions.logAction(ctx, 'add', { taskId: task.id, project: task.project, requestId: id });
        tick();
        return { ok: true, task: { id: task.id } };
      },
    },
    {
      path: /^\/api\/settings$/,
      run: (body) => {
        const next = { ...s.settings };
        if (body.cap !== undefined) {
          const cap = body.cap === 0 ? null : body.cap;
          if (!q.validCap(cap)) throw new HttpError(400, 'The limit is a whole number of 1 or more, or off.');
          next.cap = cap;
        }
        if (body.paused !== undefined) {
          next.paused = body.paused === true;
          next.pauseReason = null;
          delete next.pausedUntil;
        }
        s.settings = next;
        saveSettings();
        actions.logAction(ctx, 'settings', { cap: next.cap, paused: next.paused });
        tick();
        return { ok: true };
      },
    },
    {
      path: /^\/api\/system\/stop$/,
      /** Body: `{pid, startedAt}`, or `{processes: [{pid, startedAt}, ...]}` to stop several on one fresh probe. */
      run: async (body) => {
        if (!system) throw new HttpError(404, "The System page isn't available.");
        const asked = Array.isArray(body.processes) ? body.processes : [body];
        if (!asked.length || !asked.every((a) => Number.isInteger(a?.pid) && Number.isFinite(a?.startedAt))) throw new HttpError(400, 'Need a process id and its start time.');
        const fresh = await system.probeNow();
        if (!fresh) throw new HttpError(503, "Can't read the process list right now. Try again in a moment.");
        const results = asked.map(({ pid, startedAt }) => stopOne(fresh, pid, startedAt));
        const stopped = results.filter((r) => r.ok);
        if (stopped.length) system.wake();
        const failed = results.filter((r) => !r.ok);
        if (!stopped.length) throw new HttpError(failed[0].status, failed.length === 1 ? failed[0].message : failed.map((f) => `${f.name}: ${f.message}`).join(' '));
        return { ok: true, message: [`Asked ${stopped.map((r) => r.name).join(', ')} to stop.`, ...failed.map((f) => `${f.name}: ${f.message}`)].join(' ') };
      },
    },
    {
      path: /^\/api\/refresh$/,
      run: () => {
        refreshStatus();
        refreshSweep();
        refreshSessions();
        return { ok: true };
      },
    },
  ];

  function authorized(req, url) {
    const header = req.headers.authorization ?? '';
    const bearer = header.startsWith('Bearer ') ? header.slice(7) : null;
    return sameSecret(bearer ?? url.searchParams.get('token'), token);
  }

  async function handle(req, res) {
    if (!allowedHosts.has(String(req.headers.host ?? '').toLowerCase())) return sendJson(res, 403, { error: 'Wrong host.' });
    const url = new URL(req.url, `http://127.0.0.1:${port}`);
    const file = STATIC[url.pathname];
    if (file && req.method === 'GET') {
      res.writeHead(200, { ...SECURITY_HEADERS, 'Content-Type': file[1] });
      return res.end(readFileSync(join(PUBLIC_DIR, file[0])));
    }
    if (!url.pathname.startsWith('/api/')) return sendJson(res, 404, { error: 'Not found.' });
    if (!authorized(req, url)) return sendJson(res, 401, { error: 'Missing or wrong token.' });

    if (req.method === 'GET' && url.pathname === '/api/state') return sendJson(res, 200, snapshot());
    if (req.method === 'GET' && url.pathname === '/api/events') {
      res.writeHead(200, { ...SECURITY_HEADERS, 'Content-Type': 'text/event-stream', Connection: 'keep-alive' });
      writeEvent(res, 'state', JSON.stringify(snapshot()));
      writeEvent(res, 'ping', JSON.stringify({ sessionsAt: s.at.sessions, statusAt: s.at.status }));
      clients.add(res);
      req.on('close', () => clients.delete(res));
      system?.wake();
      return;
    }

    const route = ROUTES.find((r) => r.path.test(url.pathname));
    if (!route) return sendJson(res, 404, { error: 'Not found.' });
    if (req.method !== 'POST') return sendJson(res, 405, { error: 'Use POST.' });
    if (!allowedOrigins.has(String(req.headers.origin ?? ''))) return sendJson(res, 403, { error: 'Wrong origin.' });
    if (!String(req.headers['content-type'] ?? '').startsWith('application/json')) return sendJson(res, 415, { error: 'Send JSON.' });
    try {
      const body = await readBody(req);
      const params = url.pathname.match(route.path).slice(1).map((p) => {
        try {
          return decodeURIComponent(p);
        } catch {
          throw new HttpError(400, 'Bad characters in the address.');
        }
      });
      sendJson(res, 200, await route.run(body, params));
    } catch (e) {
      if (e instanceof q.IllegalTransition) return sendJson(res, 409, { error: e.message });
      if (e instanceof HttpError) return sendJson(res, e.status, { ...e.extra, error: e.message });
      log(`error on ${url.pathname}: ${e.stack}`);
      sendJson(res, 500, { error: 'Something went wrong. See the server output.' });
    }
  }

  const server = createServer((req, res) => {
    handle(req, res).catch((e) => {
      log(`unhandled: ${e.stack}`);
      if (!res.headersSent) sendJson(res, 500, { error: 'Something went wrong.' });
    });
  });

  return {
    token,
    url: `http://127.0.0.1:${port}/?token=${token}`,
    state: s,
    lockFile: files.lock,
    tick,
    refreshStatus,
    refreshSessions,
    refreshLimitPauses,
    async listen() {
      takeLock(files.lock, port);
      return new Promise((done, fail) => {
        server.once('error', (e) => {
          dropLock(files.lock);
          fail(e);
        });
        server.listen(port, '127.0.0.1', () => {
          refreshSweep();
          refreshLimitPauses();
          refreshSessions();
          refreshStatus();
          refreshUsage();
          system?.start(systemEnv);
          timers.push(setInterval(refreshSessions, intervals.sessionsMs));
          timers.push(setInterval(refreshUsage, intervals.usageMs));
          timers.push(setInterval(refreshStatus, intervals.statusMs));
          timers.push(setInterval(refreshSweep, intervals.sweepMs));
          timers.push(setInterval(refreshLimitPauses, intervals.pausedMs));
          done();
        });
      });
    },
    /** Stops polling and waits for reads and starts already running, so no child process outlives the server. */
    async close() {
      s.closed = true;
      for (const t of timers) clearInterval(t);
      await Promise.all([s.launching, s.statusRun, s.sessionsRun, usage.stop(), system?.stop()]);
      for (const res of clients) res.end();
      clients.clear();
      await new Promise((done) => server.close(() => done()));
      await Promise.allSettled([s.sessionsRun, s.statusRun, s.qaRun]);
      dropLock(files.lock);
    },
  };
}

function parseArgs(argv) {
  const out = { port: 4747 };
  for (let i = 0; i < argv.length; i++) {
    const [flag, value] = [argv[i], argv[i + 1]];
    if (flag === '--port' && /^\d+$/.test(value ?? '')) out.port = Number(argv[++i]);
    else if (flag === '--registry' && value) out.registryFile = resolve(argv[++i]);
    else if (flag === '--state-dir' && value) out.stateDir = resolve(argv[++i]);
    else if (flag === '--projects-dir' && value) out.projectsDir = resolve(argv[++i]);
    else throw new Error(`unknown or incomplete option ${flag}`);
  }
  return out;
}

export async function main(argv = process.argv.slice(2)) {
  let args;
  try {
    args = parseArgs(argv);
  } catch (e) {
    console.error(`mission control: ${e.message}\nusage: node mc/server.mjs [--port 4747] [--registry projects.json] [--state-dir mc/state] [--projects-dir ~/.claude/projects]`);
    process.exitCode = 2;
    return;
  }
  const mc = createMissionControl({
    ...args,
    tokenFile: process.env.MC_TOKEN_FILE || undefined,
    claudeBin: actions.findClaude(),
    ghBin: findGh(),
    system: createSystemSampler({ exec: actions.exec }),
    log: (line) => console.error(line),
  });
  try {
    await mc.listen();
  } catch (e) {
    console.error(`mission control: ${e.message}`);
    process.exitCode = 1;
    return;
  }
  process.on('exit', () => dropLock(mc.lockFile));
  console.log(`Mission control: ${mc.url}`);
  if (!actions.findClaude()) console.log("Can't find the claude CLI; sessions won't show. Set CLAUDE_BIN.");
  const stop = () => mc.close().then(() => process.exit(0));
  process.on('SIGINT', stop);
  process.on('SIGTERM', stop);
}

if (process.argv[1] && realpathSync(process.argv[1]) === realpathSync(fileURLToPath(import.meta.url))) main();
