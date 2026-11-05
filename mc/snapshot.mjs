import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { basename, join } from 'node:path';
import { clean } from './activity.mjs';
import { buildWorkMap } from './requests.mjs';
import { mergedFromStatus, prsFromStatus, projectOfPath, queueOrder, sameSession } from './queue.mjs';

export const LANES = [
  { id: 'working', label: 'Working' },
  { id: 'needs_you', label: 'Needs you' },
  { id: 'in_review', label: 'In review' },
  { id: 'ready_to_merge', label: 'Ready to merge' },
  { id: 'merged_today', label: 'Merged today' },
];

/** Queue task state to lane. States not listed don't show in the lanes. */
const TASK_LANE = {
  starting: 'working',
  working: 'working',
  blocked: 'needs_you',
  in_review: 'in_review',
  ready_to_merge: 'ready_to_merge',
  merged: 'merged_today',
};

/** PRs with no queue task. First match wins. */
const PR_LANE = [
  { lane: 'needs_you', when: (pr) => pr.classification === 'review' },
  { lane: 'needs_you', when: (pr) => pr.failingChecks?.length > 0 },
  { lane: 'ready_to_merge', when: (pr) => pr.classification === 'mergeable-by-cos' },
  { lane: 'in_review', when: () => true },
];

const PASS = new Set(['SUCCESS', 'NEUTRAL', 'SKIPPED']);
const FAIL = new Set(['FAILURE', 'TIMED_OUT', 'STARTUP_FAILURE', 'ERROR', 'CANCELLED', 'ACTION_REQUIRED']);

export function checkSummary(checks = []) {
  const pass = checks.filter((c) => PASS.has(c)).length;
  const fail = checks.filter((c) => FAIL.has(c)).length;
  return { pass, fail, pending: checks.length - pass - fail, total: checks.length };
}

/** @returns {{repo: string, number: number} | null} */
export function prRef(url) {
  const m = String(url ?? '').match(/github\.com\/([^/\s]+\/[^/\s]+)\/pull\/(\d+)/i);
  return m ? { repo: m[1], number: Number(m[2]) } : null;
}

const sameDay = (iso, now) => new Date(iso).toDateString() === now.toDateString();

function prCard(pr, lane, task) {
  const ref = prRef(pr.url);
  return {
    key: `pr:${pr.url}`,
    lane,
    project: pr.project,
    title: task?.title ?? pr.title,
    taskId: task?.id ?? null,
    pr: { url: pr.url, number: pr.number, repo: ref?.repo ?? null, base: pr.base, draft: pr.isDraft, classification: pr.classification, conflict: pr.mergeable === 'CONFLICTING' },
    checks: checkSummary(pr.checks),
  };
}

/**
 * `merged` is PRs merged on GitHub; those merged on the local day of `now` join Merged today unless a task already shows them,
 * by URL or, for a task that never saw its PR open, by project and branch.
 */
export function buildLanes(tasks, prs, now = new Date(), merged = []) {
  const cards = [];
  const claimed = new Set();
  const branchKey = (x) => `${x.project}\0${x.branch}`;
  const taskBranches = new Set();
  for (const t of tasks) {
    const lane = TASK_LANE[t.state];
    if (!lane || (lane === 'merged_today' && !sameDay(t.updatedAt, now))) continue;
    const pr = prs.find((p) => p.project === t.project && p.branch === t.branch);
    if (pr) {
      claimed.add(pr.url);
      cards.push(prCard(pr, lane, t));
    } else {
      cards.push({ key: `task:${t.id}`, lane, project: t.project, title: t.title, taskId: t.id, pr: t.pr ? { ...t.pr, repo: prRef(t.pr.url)?.repo ?? null } : null, checks: null });
      taskBranches.add(branchKey(t));
    }
  }
  for (const pr of prs) {
    if (claimed.has(pr.url)) continue;
    claimed.add(pr.url);
    cards.push(prCard(pr, PR_LANE.find((r) => r.when(pr)).lane, null));
  }
  for (const t of tasks) if (t.pr?.url) claimed.add(t.pr.url);
  for (const pr of merged) {
    if (claimed.has(pr.url) || taskBranches.has(branchKey(pr)) || !sameDay(pr.mergedAt, now)) continue;
    claimed.add(pr.url);
    cards.push({ ...prCard(pr, 'merged_today', null), checks: null });
  }
  return LANES.map((l) => ({ ...l, cards: cards.filter((c) => c.lane === l.id) }));
}

export function groupSessions(sessions, projects, roots, tasks) {
  const groups = new Map(projects.map((p) => [p.id, { project: p.id, name: p.name, sessions: [] }]));
  const other = { project: null, name: 'Other', sessions: [] };
  for (const s of sessions) {
    const id = projectOfPath(roots, s.cwd);
    const task = tasks.find((t) => sameSession(t.sessionId, s.sessionId));
    const row = {
      sessionId: s.sessionId,
      name: s.name || '(unnamed)',
      cwd: s.cwd,
      kind: s.kind ?? null,
      status: s.status,
      startedAt: s.startedAt ?? null,
      taskId: task?.id ?? null,
    };
    (groups.get(id) ?? other).sessions.push(row);
  }
  return [...groups.values(), other].filter((g) => g.sessions.length);
}

/**
 * Needs-you rows, most urgent kinds first: pause notices, approvals, blocked queue tasks, PRs for the owner, status warnings, computer alerts.
 * Sessions the queue didn't start show only in the Sessions panel, and the daily review's proposals in their own section.
 */
export function buildNeedsYou({ status, prs, tasks, settings, waiting, limitPauses = [], systemAlerts = [], now = new Date() }) {
  const items = [];
  if (settings.paused && settings.pauseReason) {
    const until = settings.pausedUntil ? ` Resumes by itself at ${clock(settings.pausedUntil)}.` : '';
    items.push({ kind: 'paused', text: `The queue is paused: ${settings.pauseReason}.${until}` });
  }
  const dueSince = now.getTime() - LIMIT_ROW_MS;
  for (const p of limitPauses.filter((x) => x.due && !x.handled && Date.parse(x.resetsAt) >= dueSince)) {
    items.push({ kind: 'limit', sessionId: p.sessionId, path: p.cwd, text: `${p.title ?? p.sessionId} is still stopped at a usage limit that reset at ${clock(p.resetsAt)}` });
  }
  const upcoming = limitPauses.filter((x) => !x.due).map((x) => x.resetsAt).sort();
  if (upcoming.length) {
    const n = upcoming.length;
    items.push({ kind: 'limit', text: `${n} chat${n === 1 ? ' is' : 's are'} stopped at a usage limit; the next reset is ${clock(upcoming[0])}` });
  }
  for (const t of tasks.filter((x) => x.state === 'queued' && x.risky && !x.approved)) {
    items.push({ kind: 'approve', project: t.project, taskId: t.id, text: `Approve start: ${t.title}` });
  }
  for (const t of tasks.filter((x) => x.state === 'blocked')) {
    const last = t.history.at(-1)?.note ?? '';
    items.push({ kind: 'blocked', project: t.project, taskId: t.id, sessionId: t.sessionId, text: `${t.title} is waiting on you (${last})` });
  }
  for (const pr of prs.filter((p) => p.classification === 'review')) {
    items.push({ kind: 'review', project: pr.project, link: pr.url, base: pr.base, checks: checkSummary(pr.checks), text: `Review PR #${pr.number}: ${pr.title}` });
  }
  for (const p of status?.projects ?? []) {
    for (const c of p.checkouts) {
      for (const a of c.attention ?? []) items.push({ kind: 'status', project: p.id, text: `${p.name}: ${a.message}`, path: c.path });
    }
  }
  for (const a of systemAlerts) items.push({ kind: 'system', text: a.text });
  return items.map((x) => ({ ...x, waiting: x.taskId ? waiting[x.taskId] ?? null : null }));
}

/** A due pause older than this is an abandoned chat, not news. */
const LIMIT_ROW_MS = 24 * 3600_000;
const clock = (iso) => new Date(iso).toLocaleString('en-CA', { month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' });

/** The latest daily harness review's proposed changes. */
export function readSweep(reportsDir) {
  if (!existsSync(reportsDir)) return null;
  const latest = readdirSync(reportsDir).filter((f) => /^\d{4}-\d{2}-\d{2}\.md$/.test(f)).sort().at(-1);
  if (!latest) return null;
  const file = join(reportsDir, latest);
  const lines = readFileSync(file, 'utf8').split('\n');
  const items = [];
  let inProposals = false;
  for (const line of lines) {
    if (/^## /.test(line)) inProposals = /^## Proposed changes/i.test(line);
    else if (inProposals && /^### /.test(line)) items.push(line.replace(/^###\s+/, '').trim());
  }
  return { file, date: latest.slice(0, 10), items };
}

function prChip(pr) {
  const ref = prRef(pr.url);
  return { url: pr.url, number: pr.number, repo: ref?.repo ?? null, title: clean(pr.title), checks: checkSummary(pr.checks), conflict: pr.mergeable === 'CONFLICTING', classification: pr.classification };
}

/** The session's PR: its queue task's, else an open PR on the branch its folder has checked out. */
function sessionPr({ task, project, branch, prs }) {
  const byTask = task && prs.find((p) => p.project === task.project && p.branch === task.branch);
  if (byTask) return prChip(byTask);
  if (task?.pr) return { url: task.pr.url, number: task.pr.number, repo: prRef(task.pr.url)?.repo ?? null, title: clean(task.title), checks: null, conflict: false, classification: null };
  const byBranch = branch && project && prs.find((p) => p.project === project && p.branch === branch);
  return byBranch ? prChip(byBranch) : null;
}

/** A session outside projects.json is named after its repo folder, not the worktree it runs in. */
const folderName = (cwd) => clean(basename(String(cwd ?? '').replace(/\/\.claude\/worktrees\/.*$/, '').replace(/-tasks\/[^/]+$/, ''))) || 'Other';

const toIso = (ms) => (Number.isFinite(ms) ? new Date(ms).toISOString() : null);

/**
 * One row per live session with what it's doing now. Busy rows first, then the most recently active.
 * `since` is when it entered its state: the turn's start for a busy session, its last activity for an idle one.
 */
export function buildWork({ sessions, projects, roots, tasks, prs, activity }) {
  return sessions
    .map((s) => {
      const { activity: act = null, branch = null } = activity.get(s.sessionId) ?? {};
      const project = projectOfPath(roots, s.cwd);
      const task = tasks.find((t) => sameSession(t.sessionId, s.sessionId)) ?? null;
      const busy = s.status === 'busy';
      return {
        sessionId: s.sessionId,
        name: clean(s.name || '(unnamed)'),
        project,
        projectName: projects.find((p) => p.id === project)?.name ?? folderName(s.cwd),
        busy,
        status: s.status,
        kind: s.kind ?? null,
        since: (busy ? act?.turnAt : act?.lastAt) ?? toIso(s.startedAt),
        lastAt: act?.lastAt ?? null,
        taskId: task?.id ?? null,
        plan: act?.plan ?? null,
        doing: act?.doing ?? null,
        said: act?.said ?? null,
        pr: sessionPr({ task, project, branch, prs }),
      };
    })
    .sort((a, b) => Number(b.busy) - Number(a.busy) || String(b.lastAt ?? b.since ?? '').localeCompare(String(a.lastAt ?? a.since ?? '')));
}

/** The latest events across sessions, newest first. */
export function buildFeed(work, activity, limit = 40) {
  return work
    .flatMap((w) => (activity.get(w.sessionId)?.activity?.events ?? []).map((e) => ({ at: e.at, kind: e.kind, sessionId: w.sessionId, name: w.name, project: w.project, projectName: w.projectName, text: e.text })))
    .sort((a, b) => b.at.localeCompare(a.at))
    .slice(0, limit);
}

const EMPTY_USAGE = { hours: [], today: 0, top: [] };

/** Twelve points from the 24 hourly buckets: pairs summed for usage, the busier hour for session counts. */
function pairs(hours, pick, join) {
  if (hours.length !== 24) return null;
  return Array.from({ length: 12 }, (_, i) => join(pick(hours[2 * i]), pick(hours[2 * i + 1])));
}

export function buildKpis({ work, lanes, queueLength, usage }) {
  const cards = (ids) => lanes.filter((l) => ids.includes(l.id)).flatMap((l) => l.cards);
  return {
    working: { value: work.filter((w) => w.busy).length, series: pairs(usage.hours, (h) => h.sessions, Math.max) },
    prsWaiting: { value: cards(['needs_you', 'ready_to_merge']).filter((c) => c.pr).length, series: null },
    queueLength: { value: queueLength, series: null },
    mergedToday: { value: cards(['merged_today']).length, series: null },
    usageToday: { value: usage.today, series: pairs(usage.hours, (h) => h.weighted, (a, b) => a + b) },
  };
}

export function buildSnapshot({ projects, roots, status, sessions, tasks, settings, waiting, sweep, limitPauses = [], meta, activity = new Map(), usage = EMPTY_USAGE, system = null, qaCards = [], requests = [], links, now = new Date() }) {
  const prs = prsFromStatus(status);
  const working = tasks.filter((t) => t.state === 'starting' || t.state === 'working').length;
  const lanes = buildLanes(tasks, prs, now, mergedFromStatus(status));
  const queued = queueOrder(tasks);
  const work = buildWork({ sessions, projects, roots, tasks, prs, activity });
  return {
    meta: { ...meta, cap: settings.cap, paused: settings.paused, pauseReason: settings.pauseReason, pausedUntil: settings.pausedUntil ?? null, working },
    projects: projects.map((p) => ({ id: p.id, name: p.name })),
    needsYou: buildNeedsYou({ status, prs, tasks, settings, waiting, limitPauses, systemAlerts: system?.alerts ?? [], now }),
    limitPauses: limitPauses.map(({ sessionId, cwd, title, pausedAt, resetsAt, due, handled }) => ({ sessionId, cwd, title, pausedAt, resetsAt, due, handled })),
    sessions: groupSessions(sessions, projects, roots, tasks),
    lanes,
    queue: {
      waiting: queued.map((t) => ({ ...t, waitingFor: waiting[t.id] ?? null })),
      active: tasks.filter((t) => !['queued', 'cancelled'].includes(t.state)).sort((a, b) => b.updatedAt.localeCompare(a.updatedAt)).slice(0, 30),
    },
    fromReview: sweep ? { file: sweep.file, date: sweep.date, items: sweep.items } : null,
    work,
    qa: { cards: qaCards },
    workMap: buildWorkMap({ requests, work, limitPauses, qaCards, links, now }),
    feed: buildFeed(work, activity),
    kpis: buildKpis({ work, lanes, queueLength: queued.length, usage }),
    usage,
    system,
  };
}
