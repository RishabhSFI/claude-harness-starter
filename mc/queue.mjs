import { randomBytes } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, realpathSync, renameSync, writeFileSync } from 'node:fs';
import { dirname, resolve, sep } from 'node:path';

/**
 * @typedef {'queued'|'starting'|'working'|'blocked'|'in_review'|'ready_to_merge'|'merged'|'failed'|'stopped'|'cancelled'} TaskState
 * @typedef {{at: string, from: TaskState | null, to: TaskState | null, note: string}} HistoryEntry
 * @typedef {{id: string, project: string, title: string, prompt: string, priority: 1|2|3, risky: boolean, approved: boolean,
 *   state: TaskState, rank: number, branch: string, sessionId: string | null, sessionName: string, startedAt: string | null,
 *   pr: {url: string, number: number} | null, createdAt: string, updatedAt: string, history: HistoryEntry[]}} Task
 * @typedef {{sessionId: string, name?: string, cwd: string, kind?: string, status: string, startedAt?: number}} Session
 * @typedef {{cap: number | null, paused: boolean, pauseReason: string | null, pausedUntil?: string}} Settings `cap: null` is no limit; `pausedUntil` is when a limit pause lifts.
 */

/** Every legal move. Anything not listed is rejected. */
export const TRANSITIONS = {
  queued: ['starting', 'cancelled'],
  starting: ['working', 'queued', 'failed', 'stopped', 'cancelled'],
  working: ['blocked', 'in_review', 'failed', 'stopped'],
  blocked: ['working', 'in_review', 'failed', 'stopped'],
  in_review: ['ready_to_merge', 'merged', 'blocked', 'stopped'],
  ready_to_merge: ['in_review', 'merged', 'blocked', 'stopped'],
  merged: [],
  failed: [],
  stopped: [],
  cancelled: [],
};
export const STATES = Object.keys(TRANSITIONS);
export const TERMINAL = new Set(STATES.filter((s) => TRANSITIONS[s].length === 0));

/** States whose session may still be writing. */
const WRITING = new Set(['starting', 'working', 'blocked']);
/** States that count against the cap. */
const RUNNING = new Set(['starting', 'working']);

/** What a `claude agents` status means for a task's state. Unlisted statuses leave the task alone. */
const SESSION_STATUS = { busy: 'working', working: 'working', idle: 'blocked', blocked: 'blocked', waiting: 'blocked' };
/** How long a fresh session may be missing from `claude agents` before the task counts as stalled. */
const SESSION_GRACE_MS = 60_000;
/** How long a `starting` task may go without its session showing up before it counts as failed. */
export const START_GRACE_MS = 90_000;
/** `claude --bg` prints a short id: the first 8 hex characters of the session's UUID. */
const SHORT_ID = /^[0-9a-f]{8}$/i;

export class IllegalTransition extends Error {}

export const DEFAULT_SETTINGS = Object.freeze({ cap: null, paused: false, pauseReason: null });
/** Settings files from before v2 saved the old default cap of 3 whether or not the owner chose it. */
const SETTINGS_VERSION = 2;

export function newId() {
  return randomBytes(3).toString('hex');
}

/**
 * Parses an add-task request. Throws a plain Error with an owner-readable message on bad input.
 * @returns {Task}
 */
export function createTask(input, { projects, now = new Date(), id = newId() }) {
  const project = projects.find((p) => p.id === input?.project);
  if (!project) throw new Error('Pick a project from the list.');
  const title = String(input.title ?? '').replace(/\s+/g, ' ').trim().replace(/^-+/, '').slice(0, 120);
  const prompt = String(input.prompt ?? '').trim();
  if (!title) throw new Error('Give the task a title.');
  if (!prompt) throw new Error('Say what the task should do.');
  if (prompt.length > 20_000) throw new Error('The prompt is too long (20,000 characters at most).');
  const priority = Number(input.priority ?? 2);
  if (![1, 2, 3].includes(priority)) throw new Error('Priority is 1, 2 or 3.');
  const at = now.toISOString();
  return {
    id,
    project: project.id,
    title,
    prompt,
    priority,
    risky: input.risky === true,
    approved: false,
    state: 'queued',
    rank: now.getTime(),
    branch: `task/mc-${id}`,
    sessionId: null,
    sessionName: `${project.id}: ${title}`,
    startedAt: null,
    pr: null,
    createdAt: at,
    updatedAt: at,
    history: [{ at, from: null, to: 'queued', note: 'added' }],
  };
}

export function canTransition(from, to) {
  return TRANSITIONS[from]?.includes(to) ?? false;
}

/** @returns {Task} a new task in state `to`. Throws IllegalTransition. */
export function transition(task, to, { now = new Date(), note = '', patch = {} } = {}) {
  if (!canTransition(task.state, to)) throw new IllegalTransition(`can't move a ${task.state} task to ${to}`);
  const at = now.toISOString();
  return { ...task, ...patch, state: to, updatedAt: at, history: [...task.history, { at, from: task.state, to, note }] };
}

/** A change that isn't a state move (approval, reorder), kept in history. */
export function annotate(task, note, patch, { now = new Date() } = {}) {
  const at = now.toISOString();
  return { ...task, ...patch, updatedAt: at, history: [...task.history, { at, from: null, to: null, note }] };
}

const byQueueOrder = (a, b) => a.priority - b.priority || a.rank - b.rank;

export function queueOrder(tasks) {
  return tasks.filter((t) => t.state === 'queued').sort(byQueueOrder);
}

/** Moves a queued task one place up or down; it takes its neighbour's priority so the order holds. */
export function move(tasks, id, dir, { now = new Date() } = {}) {
  const order = queueOrder(tasks);
  const i = order.findIndex((t) => t.id === id);
  if (i < 0) throw new Error('Only waiting tasks can be moved.');
  const j = dir === 'up' ? i - 1 : i + 1;
  if (j < 0 || j >= order.length) return tasks;
  const [a, b] = [order[i], order[j]];
  const samePriority = a.priority === b.priority;
  const patch = samePriority ? { rank: b.rank } : { priority: b.priority, rank: dir === 'up' ? b.rank - 1 : b.rank + 1 };
  const moved = annotate(a, `moved ${dir}`, patch, { now });
  return tasks.map((t) => (t.id === a.id ? moved : samePriority && t.id === b.id ? { ...b, rank: a.rank } : t));
}

const canonical = (p) => {
  try {
    return realpathSync(p);
  } catch {
    return resolve(p);
  }
};

/** Roots that belong to a project: each checkout and its `<checkout>-tasks` worktree folder. */
export function projectRoots(projects) {
  return projects.flatMap((p) => p.checkouts.flatMap((c) => [canonical(c), `${canonical(c)}-tasks`]).map((root) => ({ id: p.id, root })));
}

/** @returns {string | null} the project whose checkout (or worktree folder) holds `cwd`, longest match first. */
export function projectOfPath(roots, cwd) {
  if (!cwd) return null;
  const here = canonical(cwd);
  let best = null;
  for (const { id, root } of roots) {
    if ((here === root || here.startsWith(root + sep)) && (!best || root.length > best.root.length)) best = { id, root };
  }
  return best?.id ?? null;
}

/** True when `id` (a full UUID or the short id `--bg` prints) names `sessionId`. */
export function sameSession(id, sessionId) {
  return Boolean(id && sessionId) && (id === sessionId || (SHORT_ID.test(id) && sessionId.startsWith(id)));
}

/** The task's live session: by id when it has one, else by the name the queue gave it. */
export function sessionFor(task, sessions) {
  return task.sessionId ? sessions.find((s) => sameSession(task.sessionId, s.sessionId)) : sessions.find((s) => s.name === task.sessionName);
}

/**
 * The scheduler. Plain rules, no model. Every task gets its own worktree, so tasks in one project run side by side.
 * @returns {{start: Task | null, waiting: Record<string, string>}} the task to start now (if any) and why each other queued task waits.
 */
export function pickNext(tasks, { settings }) {
  const waiting = {};
  const order = queueOrder(tasks);
  const running = tasks.filter((t) => RUNNING.has(t.state)).length;
  let start = null;
  for (const t of order) {
    if (settings.paused) waiting[t.id] = settings.pauseReason ? `paused: ${settings.pauseReason}` : 'paused';
    else if (t.risky && !t.approved) waiting[t.id] = 'needs your approval to start';
    else if (settings.cap && running >= settings.cap) waiting[t.id] = `at the limit you set (${settings.cap} working)`;
    else if (start) waiting[t.id] = 'starts as soon as the one before it has started';
    else start = t;
  }
  return { start, waiting };
}

const LIMIT = /rate.?limit|usage.?limit|limit (reached|exceeded)|too many requests|\b429\b|quota|out of (credits|usage)/i;

/** True when a failed start looks like a rate or usage limit, which pauses the scheduler. */
export function isLimitMessage(text) {
  return LIMIT.test(String(text ?? ''));
}

/** Settings with a limit pause lifted once its reset time has passed; the same object when nothing changes. */
export function liftExpiredPause(settings, now = new Date()) {
  if (!settings.paused || !settings.pausedUntil || now.getTime() < Date.parse(settings.pausedUntil)) return settings;
  const { pausedUntil: _lifted, ...rest } = settings;
  return { ...rest, paused: false, pauseReason: null };
}

/** PRs from cos status, flattened with their project. */
export function prsFromStatus(status) {
  return (status?.projects ?? []).flatMap((p) =>
    p.checkouts.flatMap((c) => (c.prs ?? []).map((pr) => ({ ...pr, project: p.id, projectName: p.name }))),
  );
}

const ageOf = (t, now) => now.getTime() - Date.parse(t.startedAt ?? t.updatedAt);
/** Time since the task last moved into its current state. A start can take minutes, so `startedAt` would count that too. */
const timeInState = (t, now) => {
  const entered = t.history?.findLast((h) => h.to === t.state)?.at;
  return entered ? now.getTime() - Date.parse(entered) : ageOf(t, now);
};

/**
 * Maps live session status and open PRs onto tasks. `sessions` is null when the session list is unknown
 * (not polled yet, or the poll failed), and then only PRs move tasks. `launching` is the id of the task whose
 * start is still running (worktree setup, then `claude --bg`); it isn't failed for a missing session until that returns.
 * @param {{sessions: Session[] | null, prs: object[], now?: Date, launching?: string | null}} live
 * @returns {{id: string, to: TaskState | null, note: string, patch?: object}[]} only legal moves.
 */
export function reconcile(tasks, { sessions, prs, now = new Date(), launching = null }) {
  const moves = [];
  for (const t of tasks) {
    if (TERMINAL.has(t.state) || t.state === 'queued') continue;
    if (t.state === 'starting') {
      if (!sessions) continue;
      const s = sessionFor(t, sessions);
      if (s) moves.push({ id: t.id, to: 'working', note: `session ${s.status}`, patch: { sessionId: s.sessionId } });
      else if (t.id !== launching && ageOf(t, now) > START_GRACE_MS) {
        moves.push({ id: t.id, to: 'failed', note: `no session named "${t.sessionName}" showed up within ${START_GRACE_MS / 1000} s of the start` });
      }
      continue;
    }
    const pr = prs.find((p) => p.project === t.project && p.branch === t.branch);
    if (pr) {
      const to = pr.classification === 'mergeable-by-cos' ? 'ready_to_merge' : 'in_review';
      const path = canTransition(t.state, to) ? [to] : canTransition(t.state, 'in_review') && canTransition('in_review', to) ? ['in_review', to] : [];
      if (to === t.state) continue;
      for (const step of path) moves.push({ id: t.id, to: step, note: `PR #${pr.number} ${pr.classification}`, patch: { pr: { url: pr.url, number: pr.number } } });
      continue;
    }
    if (!WRITING.has(t.state) || !sessions) continue;
    const s = sessionFor(t, sessions);
    if (!s) {
      if (t.state === 'working' && timeInState(t, now) > SESSION_GRACE_MS) moves.push({ id: t.id, to: 'blocked', note: 'session ended without a PR' });
      continue;
    }
    const to = SESSION_STATUS[s.status];
    const patch = s.sessionId === t.sessionId ? undefined : { sessionId: s.sessionId };
    if (to && to !== t.state && canTransition(t.state, to)) moves.push({ id: t.id, to, note: `session ${s.status}`, patch });
    else if (patch) moves.push({ id: t.id, to: null, note: 'matched session', patch });
  }
  return moves;
}

/** Applies reconcile moves in order; `to: null` patches without a state change. */
export function applyMoves(tasks, moves, { now = new Date() } = {}) {
  return tasks.map((t) =>
    moves
      .filter((m) => m.id === t.id)
      .reduce((cur, m) => (m.to ? transition(cur, m.to, { now, note: m.note, patch: m.patch }) : annotate(cur, m.note, m.patch, { now })), t),
  );
}

function readJson(file, fallback) {
  if (!existsSync(file)) return fallback;
  return JSON.parse(readFileSync(file, 'utf8'));
}

function writeJsonAtomic(file, value) {
  mkdirSync(dirname(file), { recursive: true });
  const tmp = `${file}.${process.pid}.tmp`;
  writeFileSync(tmp, `${JSON.stringify(value, null, 2)}\n`);
  renameSync(tmp, file);
}

export function loadQueue(file) {
  const raw = readJson(file, { tasks: [] });
  return Array.isArray(raw?.tasks) ? raw.tasks.filter((t) => t && STATES.includes(t.state)) : [];
}

export function saveQueue(file, tasks) {
  writeJsonAtomic(file, { tasks });
}

/** @returns {Settings} */
export const validCap = (cap) => cap === null || (Number.isSafeInteger(cap) && cap >= 1);

/** @returns {Settings} An unversioned file's cap was the old default, not a choice, so it loads as no limit. */
export function loadSettings(file) {
  const raw = readJson(file, {});
  const current = raw?.version === SETTINGS_VERSION;
  const cap = current && validCap(raw.cap) ? raw.cap : DEFAULT_SETTINGS.cap;
  const pausedUntil = typeof raw?.pausedUntil === 'string' && !Number.isNaN(Date.parse(raw.pausedUntil)) ? raw.pausedUntil : null;
  return { cap, paused: raw?.paused === true, pauseReason: typeof raw?.pauseReason === 'string' ? raw.pauseReason : null, ...(pausedUntil ? { pausedUntil } : {}) };
}

export function saveSettings(file, settings) {
  writeJsonAtomic(file, { ...settings, version: SETTINGS_VERSION });
}
