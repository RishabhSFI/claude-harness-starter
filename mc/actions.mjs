import { execFile } from 'node:child_process';
import { appendFileSync, existsSync, mkdirSync, readdirSync } from 'node:fs';
import { homedir } from 'node:os';
import { delimiter, dirname, join } from 'node:path';
import { classifyPr, describePublic, githubRepoOf, prBlockReason } from '../cos.mjs';
import { clean } from './activity.mjs';
import { isLimitMessage, sameSession } from './queue.mjs';

const CLAUDE_TIMEOUT_MS = 60_000;
const GH_TIMEOUT_MS = 120_000;
const UUID = /\b[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\b/i;
const SHORT_ID = /\b[0-9a-f]{8}\b/i;
/** How old the last good PR status poll may be before merges are refused. */
export const STATUS_MAX_AGE_MS = 120_000;
export const MERGE_FIELDS = ['baseRefName', 'headRefOid', 'isDraft', 'statusCheckRollup', 'mergeable', 'reviewDecision', 'state'];

/** CLAUDE_BIN, then `claude` on PATH, then the newest copy the desktop app ships. */
export function findClaude(env = process.env, home = homedir()) {
  if (env.CLAUDE_BIN) return existsSync(env.CLAUDE_BIN) ? env.CLAUDE_BIN : null;
  for (const dir of String(env.PATH ?? '').split(delimiter).filter(Boolean)) {
    if (existsSync(join(dir, 'claude'))) return join(dir, 'claude');
  }
  const root = join(home, 'Library/Application Support/Claude/claude-code');
  const dirs = (d) => (existsSync(d) ? readdirSync(d, { withFileTypes: true }).filter((e) => e.isDirectory()).map((e) => e.name) : []);
  const found = dirs(root).flatMap((version) =>
    dirs(join(root, version))
      .map((build) => ({ version, p: join(root, version, build, 'claude.app/Contents/MacOS/claude') }))
      .filter((x) => existsSync(x.p)),
  );
  return found.sort((a, b) => a.version.localeCompare(b.version, undefined, { numeric: true })).at(-1)?.p ?? null;
}

/** execFile with an args array: no shell, so task text can't become a command. Never rejects. */
export function exec(bin, args, { cwd, timeout, env } = {}) {
  return new Promise((done) => {
    execFile(bin, args, { cwd, timeout, env, maxBuffer: 16 * 1024 * 1024, encoding: 'utf8' }, (err, stdout, stderr) => {
      done({ ok: !err, code: err?.code ?? 0, out: String(stdout ?? '').trim(), err: String(stderr ?? '').trim() || (err && !stderr ? err.message : '') });
    });
  });
}

export async function listSessions(claudeBin) {
  const r = await exec(claudeBin, ['agents', '--json'], { timeout: 15_000 });
  if (!r.ok) throw new Error(`claude agents failed: ${(r.err || 'unknown error').split('\n')[0]}`);
  const raw = JSON.parse(r.out || '[]');
  if (!Array.isArray(raw)) throw new Error('claude agents --json did not return a list');
  return raw.filter((s) => s && typeof s.sessionId === 'string');
}

async function originRepo(project) {
  const checkout = project.checkouts[0];
  const r = await exec('git', ['remote', 'get-url', 'origin'], { cwd: checkout, timeout: 10_000 });
  return (r.ok && githubRepoOf(r.out)) || project.repos[0] || null;
}

/** The cos worker brief (skills/cos/SKILL.md), filled in for one queue task. */
export function buildBrief({ task, project, harnessDir, repo }) {
  const quoted = task.prompt.split('\n').map((l) => `> ${l}`).join('\n');
  return `/until-ready ${task.title}

Read ${join(harnessDir, 'wiki', 'projects', `${project.id}.md`)} first: what earlier sessions decided and
learned about this project. Put anything new you learn in your report.

Work on pstack end to end: load the pstack:poteto-mode skill and follow its
playbook (design first, delegated build, independent review before the PR).
Don't stop to ask about routine choices; decide and list your decisions in
the report. If the project has no .claude/gate.json, draft one from its
real checks and commit it with the work.

Keep this chat small: delegate building and long reads, don't end a turn
just to say you're waiting, and stop once the PR is open. Size the review:
Sonnet for small, low-risk diffs; Opus for large or risky ones.

Use the task slug mc-${task.id}, so your branch is ${task.branch}. You start
in your own worktree, already on that branch; other queue tasks may be
working in this project at the same time in their own worktrees, so stay
in yours. Mission control finds your PR by that branch name.

GitHub: push only to origin and pass \`-R ${repo ?? '<origin owner/repo>'}\` to every gh
command (some folders have a public \`upstream\` remote; never use it).

Release rules for this project: ${describePublic(project.public).replace(/^Public: /, '')}. Those
need the owner's review: open a PR and stop there, with a preview deploy
link if the project has one. Anything else (task branches, private
branches, preview deploys) you may do.

Report back in this shape: outcome first, PR link, preview link, what the
checks and the review found, decisions you made, anything left.

The owner's words (from the mission control queue):

${quoted}

Done looks like: a PR from ${task.branch} that passes the gate, and the report above.
`;
}

/** The session id `claude --bg` printed: a full UUID, or the 8-character short id. */
export function printedSessionId(text) {
  return String(text ?? '').match(UUID)?.[0] ?? String(text ?? '').match(SHORT_ID)?.[0] ?? null;
}

const GIT_QUIET = { ...process.env, GIT_TERMINAL_PROMPT: '0' };
/** A fetch that can't reach origin gives up fast; the task then starts from the last fetched default branch. */
const FETCH_TIMEOUT_MS = 15_000;
const FETCH_SSH = 'ssh -o ConnectTimeout=5 -o BatchMode=yes';
const hasRef = async (cwd, ref) => (await exec('git', ['rev-parse', '--verify', '--quiet', ref], { cwd, timeout: 10_000 })).ok;

/**
 * Where a new task branch starts: origin's default branch after a fetch, as gate/worktree.sh picks it, else the local
 * main or master. Never whatever the main checkout happens to have checked out.
 * @returns {Promise<string | null>}
 */
export async function defaultBase(checkout) {
  if ((await exec('git', ['remote', 'get-url', 'origin'], { cwd: checkout, timeout: 10_000 })).ok) {
    await exec('git', ['-c', `core.sshCommand=${FETCH_SSH}`, 'fetch', '--quiet', 'origin'], { cwd: checkout, timeout: FETCH_TIMEOUT_MS, env: GIT_QUIET });
    const head = await exec('git', ['symbolic-ref', '--short', 'refs/remotes/origin/HEAD'], { cwd: checkout, timeout: 10_000 });
    for (const ref of [head.ok ? head.out : null, 'origin/main', 'origin/master'].filter(Boolean)) {
      if (await hasRef(checkout, `refs/remotes/${ref}`)) return ref;
    }
  }
  for (const name of ['main', 'master']) if (await hasRef(checkout, `refs/heads/${name}`)) return name;
  return null;
}

/**
 * The task's own worktree, `<checkout>-tasks/mc-<id>` on the task's branch, so tasks in one project never share a folder.
 * A new branch starts from the default branch; a retried start reuses the worktree or branch it already made.
 * The worktree gets gate/worktree.sh setup (node_modules and the gate's local files); if that fails the task still starts.
 * @returns {Promise<{ok: true, dir: string} | {ok: false, message: string}>}
 */
export async function ensureWorktree(checkout, task, { harnessDir } = {}) {
  const dir = join(`${checkout}-tasks`, `mc-${task.id}`);
  if (existsSync(dir)) return { ok: true, dir };
  mkdirSync(dirname(dir), { recursive: true });
  await exec('git', ['worktree', 'prune'], { cwd: checkout, timeout: 10_000 });
  let args;
  if (await hasRef(checkout, `refs/heads/${task.branch}`)) args = ['worktree', 'add', dir, task.branch];
  else {
    const base = await defaultBase(checkout);
    args = ['worktree', 'add', '--no-track', '-b', task.branch, dir, ...(base ? [base] : [])];
  }
  const r = await exec('git', args, { cwd: checkout, timeout: 60_000 });
  if (!r.ok) return { ok: false, message: `couldn't make a worktree: ${(r.err || r.out).split('\n')[0]}` };
  if (harnessDir) await exec('sh', [join(harnessDir, 'gate', 'worktree.sh'), 'setup'], { cwd: dir, timeout: 60_000 });
  return { ok: true, dir };
}

/** @returns {Promise<string[]>} the task worktrees mission control made (`<checkout>-tasks/mc-*`) that are still on disk. */
export function leftoverWorktrees(projects) {
  return projects.flatMap((p) =>
    p.checkouts.flatMap((c) => {
      const root = `${c}-tasks`;
      return existsSync(root) ? readdirSync(root).filter((n) => n.startsWith('mc-')).map((n) => join(root, n)) : [];
    }),
  );
}

/** @returns {Promise<{ok: true, sessionId: string | null, brief: string} | {ok: false, limit: boolean, message: string}>} */
export async function startTask(ctx, task, project) {
  if (!project) return { ok: false, limit: false, message: `${task.project} isn't in projects.json any more.` };
  if (!ctx.claudeBin) return { ok: false, limit: false, message: "Can't find the claude CLI. Set CLAUDE_BIN." };
  const checkout = project.checkouts[0];
  if (!existsSync(checkout)) return { ok: false, limit: false, message: `${checkout} doesn't exist` };
  const tree = await ensureWorktree(checkout, task, { harnessDir: ctx.harnessDir });
  if (!tree.ok) return { ok: false, limit: false, message: tree.message };
  const cwd = tree.dir;
  const brief = buildBrief({ task, project, harnessDir: ctx.harnessDir, repo: await originRepo(project) });
  const r = await exec(ctx.claudeBin, ['--bg', '-n', task.sessionName, '--permission-mode', 'auto', brief], { cwd, timeout: CLAUDE_TIMEOUT_MS });
  if (!r.ok) {
    const limit = isLimitMessage(`${r.out}\n${r.err}`);
    logAction(ctx, 'start', { taskId: task.id, project: project.id, ok: false, limit });
    return { ok: false, limit, message: (r.err || r.out || 'claude --bg failed').split('\n').slice(0, 3).join(' ') };
  }
  const printed = printedSessionId(r.out) ?? printedSessionId(r.err);
  let sessionId = printed && UUID.test(printed) ? printed : null;
  if (!sessionId) {
    const sessions = await listSessions(ctx.claudeBin).catch(() => []);
    const match = sessions.find((s) => sameSession(printed, s.sessionId)) ?? sessions.find((s) => s.name === task.sessionName);
    sessionId = match?.sessionId ?? printed;
  }
  logAction(ctx, 'start', { taskId: task.id, project: project.id, sessionId, ok: true });
  return { ok: true, sessionId, brief };
}

const ALREADY_GONE = /not found|no such|no (background )?session|not running|unknown (session|id)/i;

/** Stops a background session. One that already ended counts as stopped. */
export async function stopSession(ctx, sessionId, meta = {}) {
  const r = await exec(ctx.claudeBin, ['stop', sessionId], { timeout: CLAUDE_TIMEOUT_MS });
  const gone = !r.ok && ALREADY_GONE.test(`${r.err}\n${r.out}`);
  logAction(ctx, 'stop', { sessionId, ...meta, ok: r.ok || gone, gone });
  return r.ok || gone ? { ok: true } : { ok: false, message: (r.err || r.out || 'claude stop failed').split('\n')[0] };
}

/**
 * Who may stop a session: ones the queue started, or any other after the owner confirms in the page.
 * @returns {{allow: boolean, reason?: string}}
 */
export function stopDecision({ sessionId, tasks, confirm }) {
  if (tasks.some((t) => sameSession(t.sessionId, sessionId))) return { allow: true };
  if (confirm === true) return { allow: true };
  return { allow: false, reason: "That session wasn't started by the queue. Confirm to stop it." };
}

/** `gh pr view` for one PR. Never rejects. */
export async function viewPr(ctx, repo, number, fields) {
  const r = await exec(ctx.ghBin ?? 'gh', ['pr', 'view', String(number), '-R', repo, '--json', fields.join(',')], { timeout: GH_TIMEOUT_MS });
  if (!r.ok) return { ok: false, message: (r.err || r.out || 'gh pr view failed').split('\n')[0] };
  try {
    return { ok: true, pr: JSON.parse(r.out) };
  } catch {
    return { ok: false, message: 'gh pr view returned unparseable output' };
  }
}

/** Raw `gh pr view` JSON in the shape cos's classifyPr reads. Missing fields fail closed. */
export function parseFreshPr(raw) {
  return {
    state: raw?.state ?? null,
    head: typeof raw?.headRefOid === 'string' && raw.headRefOid ? raw.headRefOid : null,
    base: raw?.baseRefName ?? null,
    isDraft: raw?.isDraft !== false,
    checks: (raw?.statusCheckRollup ?? []).map((c) => String(c.conclusion || c.state || '').toUpperCase()),
    mergeable: raw?.mergeable ?? null,
    reviewDecision: raw?.reviewDecision ?? null,
  };
}

/** @returns {string | null} why the last PR status poll can't back a merge, or null when it can. */
export function staleStatus({ at, error }, now = Date.now()) {
  if (error) return `The last PR status check failed (${error}). Refresh and try again.`;
  if (!at || now - Date.parse(at) > STATUS_MAX_AGE_MS) return 'PR status is more than 2 minutes old. Refresh and try again.';
  return null;
}

const PASS_CHECK = new Set(['SUCCESS', 'NEUTRAL', 'SKIPPED']);
const FAIL_CHECK = new Set(['FAILURE', 'TIMED_OUT', 'STARTUP_FAILURE', 'ERROR', 'CANCELLED', 'ACTION_REQUIRED']);

/** "2 passing, 1 failing" style summary of a fresh PR's checks, with `green` true only when there are checks and all passed. */
export function checkState(checks = []) {
  const pass = checks.filter((c) => PASS_CHECK.has(c)).length;
  const fail = checks.filter((c) => FAIL_CHECK.has(c)).length;
  const pending = checks.length - pass - fail;
  const parts = [[pass, 'passing'], [fail, 'failing'], [pending, 'pending']].filter(([n]) => n).map(([n, w]) => `${n} ${w}`);
  return { pass, fail, pending, green: checks.length > 0 && pass === checks.length, text: parts.length ? parts.join(', ') : 'no checks' };
}

/**
 * The merge policy, run on the PR as GitHub has it right now. One click only for mergeable-by-cos with a declared
 * `public` list. Otherwise the owner confirms `<repo>#<n>`: by the dialog's second click for a green live merge,
 * typed when nothing is declared public, and typed again as `override` for a live merge whose checks aren't green.
 * A blocked PR (draft, conflicts, requested changes) is refused whatever confirm and override say.
 * A refusal the owner can confirm past carries `needs`, so the page asks for exactly what the server will accept.
 * @param {{pr: ReturnType<typeof parseFreshPr> | null, project: object | undefined, defaultBranch: string | null, repo: string, number: number, confirm?: string, override?: string}} input
 * @returns {{allow: boolean, reason?: string, needs?: {phrase: string, typed: boolean, override: boolean, live: boolean, base: string | null, checks: string}}}
 */
export function mergeDecision({ pr, project, defaultBranch, repo, number, confirm, override }) {
  if (!project) return { allow: false, reason: `${repo} isn't listed in any project's repos in projects.json.` };
  if (!pr) return { allow: false, reason: `Couldn't read ${repo}#${number} from GitHub. Try again.` };
  if (pr.state !== 'OPEN') return { allow: false, reason: `${repo}#${number} is ${String(pr.state ?? 'not open').toLowerCase()}, not open.` };
  if (!pr.head) return { allow: false, reason: `GitHub didn't say which commit ${repo}#${number} is at. Try again.` };
  if (!pr.base) return { allow: false, reason: `GitHub didn't say which branch ${repo}#${number} lands in. Try again.` };
  const kind = classifyPr(pr, project.public, defaultBranch);
  const phrase = `${repo}#${number}`;
  const checks = checkState(pr.checks);
  const needs = (o) => ({ phrase, typed: false, override: false, live: false, base: pr.base, checks: checks.text, ...o });
  // With no declared `public` list the default branch is only a local guess, so never merge on one click.
  const sure = Array.isArray(project.public?.branches);
  if (kind === 'mergeable-by-cos' && sure) return { allow: true };
  if (kind === 'mergeable-by-cos' && confirm === phrase) return { allow: true };
  if (kind === 'mergeable-by-cos') return { allow: false, reason: `${project.id} doesn't declare what's public in projects.json, so every merge needs a typed ${phrase}.`, needs: needs({ typed: true }) };
  if (kind === 'review') {
    if (!checks.green) {
      if (confirm === phrase && override === phrase) return { allow: true };
      return { allow: false, reason: `This lands in a public branch (${pr.base ?? 'unknown base'}) and its checks aren't green (${checks.text}). Type ${phrase} to merge it anyway.`, needs: needs({ typed: true, override: true, live: true }) };
    }
    if (confirm === phrase) return { allow: true };
    return { allow: false, reason: `This lands in a public branch (${pr.base ?? 'unknown base'}). Confirm the live merge in the dialog.`, needs: needs({ live: true }) };
  }
  return { allow: false, reason: `Not mergeable yet. ${prBlockReason(pr, project.public, defaultBranch)}` };
}

/**
 * Checks the status poll, fetches the PR fresh, decides, and merges only the commit that was checked.
 * @returns {Promise<{ok: true} | {ok: false, status: number, message: string}>}
 */
export async function mergePr(ctx, { projects, status, poll, repo, number, confirm, override, now = Date.now() }) {
  const stale = staleStatus(poll, now);
  if (stale) return refuse(ctx, repo, number, stale);
  const project = projects.find((p) => p.repos.some((r) => r.toLowerCase() === repo.toLowerCase()));
  const view = project ? await viewPr(ctx, repo, number, MERGE_FIELDS) : null;
  const pr = view?.ok ? parseFreshPr(view.pr) : null;
  const defaultBranch = status?.projects?.find((p) => p.id === project?.id)?.checkouts?.[0]?.defaultBranch ?? null;
  const d = mergeDecision({ pr, project, defaultBranch, repo, number, confirm, override });
  if (!d.allow) return { ...refuse(ctx, repo, number, d.reason), ...(d.needs ? { needs: d.needs } : {}) };
  const r = await exec(ctx.ghBin ?? 'gh', ['pr', 'merge', String(number), '-R', repo, '--squash', '--delete-branch', '--match-head-commit', pr.head], { timeout: GH_TIMEOUT_MS });
  logAction(ctx, 'merge', { repo, number, head: pr.head, ok: r.ok, ...(override ? { override: true, checks: checkState(pr.checks).text } : {}) });
  if (r.ok) void recordMerge(ctx, project, repo, number).catch(() => {});
  return r.ok ? { ok: true } : { ok: false, status: 502, message: (r.err || r.out || 'gh pr merge failed').split('\n')[0] };
}

/** Adds a merged PR to its project's wiki page. Best effort and not awaited, so the merge reply never waits on it. The outcome only goes to the log. */
async function recordMerge(ctx, project, repo, number) {
  if (!ctx.harnessDir) return;
  const env = ctx.ghBin ? { ...process.env, GH_BIN: ctx.ghBin } : process.env;
  const r = await exec(process.execPath, [join(ctx.harnessDir, 'wiki.mjs'), 'record', project.id, '--pr', `${repo}#${number}`, ...(ctx.registryFile ? ['--registry', ctx.registryFile] : [])], { timeout: GH_TIMEOUT_MS, env });
  try {
    logAction(ctx, 'wiki-record', { repo, number, ok: r.ok });
  } catch {}
}

function refuse(ctx, repo, number, message) {
  logAction(ctx, 'merge-refused', { repo, number });
  return { ok: false, status: 409, message };
}

/**
 * No documented deep link opens one desktop session, so this gives what the owner can act on:
 * the name to search for in the app's sidebar and, for background sessions, the attach command.
 */
export function openInApp(session) {
  if (!session) return { ok: false, message: 'That session is no longer running.' };
  return {
    ok: true,
    link: null,
    search: clean(session.name || session.sessionId),
    attach: session.kind === 'interactive' ? null : `claude attach ${session.sessionId}`,
  };
}

/** One JSON line per action. Callers pass ids and outcomes only, never prompt text or tokens. */
export function logAction(ctx, action, fields) {
  if (!ctx.logFile) return;
  mkdirSync(dirname(ctx.logFile), { recursive: true });
  appendFileSync(ctx.logFile, `${JSON.stringify({ at: new Date().toISOString(), action, ...fields })}\n`);
}
