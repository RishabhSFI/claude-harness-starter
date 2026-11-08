#!/usr/bin/env node
import { spawnSync } from 'node:child_process';
import { accessSync, constants as fsConstants, cpSync, existsSync, mkdirSync, readdirSync, readFileSync, realpathSync, renameSync, statSync, writeFileSync } from 'node:fs';
import { homedir, uptime as osUptime } from 'node:os';
import { basename, dirname, isAbsolute, join, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import { DEFAULT_DESKTOP_DIR, DEFAULT_PROJECTS_DIR, findPaused, markResumed } from './limits.mjs';
import { USER_FILES } from './starter-update.mjs';
import { uptimeWarningOn } from './uptime.mjs';
import { sizeWarning } from './size-guard.mjs';
import { baseRefOf, hasOpenWork, inspectWorktree, linkedWorktrees, removeWorktree, staleReason } from './worktrees.mjs';
import { attachSecretsToStatus, parseSecrets, resolveSecrets, renderSecrets, secretsJson, writeSecretsPage } from './secrets.mjs';

const SELF_DIR = dirname(fileURLToPath(import.meta.url));
const GIT_TIMEOUT_MS = 10_000;
const GH_TIMEOUT_MS = 8_000;
const FAILING_CHECK = new Set(['FAILURE', 'TIMED_OUT', 'STARTUP_FAILURE', 'ERROR']);
const SUCCESS_CHECK = new Set(['SUCCESS', 'NEUTRAL', 'SKIPPED']);
const IGNORE_LINES = ['.claude/loop/', '.env', '.env.*', '!.env.example', 'node_modules/'];

/**
 * The owner's own files. The starter never ships them, `update` never touches them, and the
 * starter's .gitignore lists them. A trailing slash means the whole folder.
 */
export { USER_FILES };

const DEFAULT_ROOT = '~/Projects';
const VALUE_FLAGS = new Set(['registry', 'harness', 'what', 'root', 'owner', 'fake-prs', 'fake-merged', 'id', 'name', 'keywords', 'to', 'message', 'from', 'mark', 'paused-at', 'projects-dir', 'desktop-dir', 'marks-file', 'now', 'fake-checks']);
const SLUG = /^[a-z0-9]+(-[a-z0-9]+)*$/;

const CLAUDE_MD = (name, what) => `# ${name}

${what}

## How work happens here
- Build with pstack end to end: load the \`pstack:poteto-mode\` skill, follow its playbook (design first, delegated build, independent review before a PR).
- Use \`/until-ready\` for anything that changes code. The first task in a new project adds \`.claude/gate.json\` with this project's checks (tests, lint, build) once there is code to check.
- Work on a task branch and open a PR. Never push to \`main\` directly.

## What's public
Nothing is live yet. When this project gets a deploy, list here what makes it public (branches, deploy commands, anything that emails or messages people). The owner reviews those before they happen. Everything else (merging into other branches, preview deploys) can go ahead.
`;

/**
 * @typedef {{branches: string[], remotes: string[], notes: string[]}} PublicSurface
 * @typedef {{id: string, name: string, what: string, checkouts: string[], aliases: string[], keywords: string[], public: PublicSurface | null, repos: string[], site: string | null, secrets: import('./secrets.mjs').SecretSpec[]}} Project
 */

function expandHome(p) {
  if (p === '~') return homedir();
  return p.startsWith('~/') ? join(homedir(), p.slice(2)) : p;
}

/** @returns {PublicSurface | null} null means undeclared: the default branch counts as public. */
function parsePublic(raw) {
  if (!raw || typeof raw !== 'object') return null;
  const list = (v) => (Array.isArray(v) ? v.map(String) : []);
  return { branches: list(raw.branches), remotes: list(raw.remotes), notes: list(raw.notes) };
}

/** A missing file is an empty registry, so a fresh install works before the first `add`. */
function readRegistryRaw(file) {
  return existsSync(file) ? JSON.parse(readFileSync(file, 'utf8')) : { projects: [] };
}

function parseProject(p, where) {
  if (typeof p?.id !== 'string' || typeof p?.name !== 'string' || !Array.isArray(p?.checkouts)) {
    throw new Error(`${where} needs string id, string name, and a checkouts array`);
  }
  return {
    id: p.id,
    name: p.name,
    what: typeof p.what === 'string' ? p.what : '',
    checkouts: p.checkouts.map((c) => resolve(expandHome(String(c)))),
    aliases: Array.isArray(p.aliases) ? p.aliases.map(String) : [],
    keywords: Array.isArray(p.keywords) ? p.keywords.map(String) : [],
    public: parsePublic(p.public),
    repos: Array.isArray(p.repos) ? p.repos.map(String) : [],
    site: typeof p.site === 'string' ? p.site : null,
    secrets: parseSecrets(p.secrets, where),
  };
}

/** Active projects only: every reader that goes through here skips the retired ones. */
export function loadRegistry(file) {
  const raw = readRegistryRaw(file);
  if (!Array.isArray(raw?.projects)) throw new Error(`${file}: expected {"projects": [...]}`);
  const projects = raw.projects.map((p, i) => parseProject(p, `${file}: projects[${i}]`));
  loadRetired(file);
  return projects;
}

/** Retired projects, for the places that still care: the starter's leak scan and `retire`. @returns {(Project & {retiredOn: string | null})[]} */
export function loadRetired(file) {
  const raw = readRegistryRaw(file);
  if (raw.retired !== undefined && !Array.isArray(raw.retired)) throw new Error(`${file}: "retired" must be an array`);
  const retired = (raw.retired ?? []).map((p, i) => ({ ...parseProject(p, `${file}: retired[${i}]`), retiredOn: typeof p.retiredOn === 'string' ? p.retiredOn : null }));
  const seen = new Set((raw.projects ?? []).map((p) => String(p?.id).toLowerCase()));
  for (const p of retired) {
    if (seen.has(p.id.toLowerCase())) throw new Error(`${file}: project id "${p.id}" is in both projects and retired`);
    seen.add(p.id.toLowerCase());
  }
  return retired;
}

class UsageError extends Error {}

function parseArgs(argv) {
  const flags = {};
  const positional = [];
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a.startsWith('--') && VALUE_FLAGS.has(a.slice(2))) {
      const value = argv[i + 1];
      if (value === undefined || value.startsWith('--')) throw new UsageError(`${a} needs a value`);
      flags[a.slice(2)] = value;
      i++;
    }
    else if (a.startsWith('--')) flags[a.slice(2)] = true;
    else positional.push(a);
  }
  return { flags, positional };
}

/**
 * The GitHub CLI's path. Shells started by apps (the desktop app's terminal tabs, launchd)
 * often lack ~/.local/bin or Homebrew on PATH, so check the usual install spots too.
 */
export function findGh(env = process.env) {
  if (env.GH_BIN) return env.GH_BIN;
  const home = env.HOME || homedir();
  const dirs = [...String(env.PATH || '').split(':'), join(home, '.local/bin'), '/opt/homebrew/bin', '/usr/local/bin'];
  for (const dir of dirs.filter((d) => d && isAbsolute(d))) {
    const p = join(dir, 'gh');
    try {
      if (statSync(p).isFile()) {
        accessSync(p, fsConstants.X_OK);
        return p;
      }
    } catch {}
  }
  return 'gh';
}
const GH = findGh();

function run(cmd, args, cwd, timeout) {
  const r = spawnSync(cmd, args, {
    cwd,
    timeout,
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'pipe'],
    env: { ...process.env, GIT_OPTIONAL_LOCKS: '0' },
  });
  if (r.error) return { ok: false, out: '', err: r.error.code === 'ETIMEDOUT' ? 'timed out' : r.error.message };
  return { ok: r.status === 0, out: r.stdout.trimEnd(), err: r.stderr.trim() };
}

const git = (cwd, ...args) => run('git', args, cwd, GIT_TIMEOUT_MS);

function defaultBranchOf(cwd) {
  const head = git(cwd, 'symbolic-ref', '--short', 'refs/remotes/origin/HEAD');
  if (head.ok) return head.out.replace(/^origin\//, '');
  for (const name of ['main', 'master']) {
    if (git(cwd, 'show-ref', '--verify', '--quiet', `refs/heads/${name}`).ok) return name;
  }
  return null;
}

function listWorktrees(cwd) {
  const r = git(cwd, 'worktree', 'list', '--porcelain');
  if (!r.ok) return [];
  const self = canonical(cwd);
  return r.out
    .split(/\n\n+/)
    .map((block) => {
      const path = block.match(/^worktree (.+)$/m)?.[1];
      const branch = block.match(/^branch refs\/heads\/(.+)$/m)?.[1] ?? null;
      return path ? { path, branch } : null;
    })
    .filter((w) => w && canonical(w.path) !== self);
}

/** @returns {string | null} owner/repo for https, ssh and ssh:// GitHub URLs. */
export function githubRepoOf(url) {
  const m = url.trim().match(/^(?:https?:\/\/(?:[^@/]+@)?|ssh:\/\/(?:[^@/]+@)?|[^@/\s]+@)github\.com[:/]([^/\s]+)\/([^/\s]+?)(?:\.git)?\/?$/i);
  return m ? `${m[1]}/${m[2]}` : null;
}

function listPullRequests(cwd, repo, fakePrsFile) {
  const fields = 'number,title,headRefName,baseRefName,isDraft,url,statusCheckRollup,mergeable,reviewDecision,updatedAt,labels';
  const r = fakePrsFile
    ? { ok: true, out: readFileSync(fakePrsFile, 'utf8') }
    : run(GH, ['pr', 'list', '-R', repo, '--json', fields, '--limit', '20'], cwd, GH_TIMEOUT_MS);
  if (!r.ok) return { prs: [], note: `gh pr list failed: ${r.err.split('\n')[0] || 'unknown error'}` };
  try {
    const prs = JSON.parse(r.out).map((pr) => ({
      number: pr.number,
      title: pr.title,
      branch: pr.headRefName,
      base: pr.baseRefName ?? null,
      isDraft: pr.isDraft,
      url: pr.url,
      checks: (pr.statusCheckRollup ?? []).map((c) => String(c.conclusion || c.state || '').toUpperCase()),
      mergeable: pr.mergeable ?? null,
      reviewDecision: pr.reviewDecision ?? null,
      updatedAt: pr.updatedAt ?? null,
      labels: (pr.labels ?? []).map((l) => ({ name: String(l?.name ?? '') })),
      failingChecks: (pr.statusCheckRollup ?? [])
        .filter((c) => FAILING_CHECK.has(c.conclusion) || FAILING_CHECK.has(c.state))
        .map((c) => c.name ?? c.context ?? 'check'),
    }));
    return { prs, note: null };
  } catch {
    return { prs: [], note: 'gh pr list returned unparseable output' };
  }
}

const localDate = (d) => `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;

/** PRs merged since the start of local yesterday, so a caller can pick out local today in any time zone. Kept apart from open PRs. */
function listMergedPullRequests(cwd, repo, { fakePrs, fakeMerged }) {
  const since = new Date();
  since.setDate(since.getDate() - 1);
  const fields = 'number,title,url,mergedAt,headRefName,baseRefName';
  const r = fakeMerged
    ? { ok: true, out: readFileSync(fakeMerged, 'utf8') }
    : fakePrs
      ? { ok: true, out: '[]' }
      : run(GH, ['pr', 'list', '-R', repo, '--state', 'merged', '--search', `merged:>=${localDate(since)}`, '--json', fields, '--limit', '100'], cwd, GH_TIMEOUT_MS);
  if (!r.ok) return { merged: [], note: `gh pr list --state merged failed: ${r.err.split('\n')[0] || 'unknown error'}` };
  try {
    const merged = JSON.parse(r.out).map((pr) => ({
      number: pr.number,
      title: pr.title,
      branch: pr.headRefName,
      base: pr.baseRefName ?? null,
      url: pr.url,
      mergedAt: pr.mergedAt,
    }));
    return { merged, note: null };
  } catch {
    return { merged: [], note: 'gh pr list --state merged returned unparseable output' };
  }
}

/**
 * First matching rule wins; no match means mergeable-by-cos. Every unknown fails closed. Draft, conflicts and requested
 * changes sit above the public-branch rule so a live PR with any of them is blocked, not merely "review": the owner
 * can confirm past failing checks on a live PR, never past these. `why` is the plain-words reason shown to the owner.
 */
const PR_RULES = [
  { to: 'review', why: "It doesn't say which branch it merges into.", when: (pr) => !pr.base },
  { to: 'blocked', why: "It's still a draft.", when: (pr) => pr.isDraft },
  { to: 'blocked', why: 'It has merge conflicts with its base branch.', when: (pr) => pr.mergeable === 'CONFLICTING' },
  { to: 'blocked', why: 'A reviewer asked for changes.', when: (pr) => pr.reviewDecision === 'CHANGES_REQUESTED' },
  { to: 'review', why: 'It lands in a public branch, so you look first.', when: (pr, publicBranches) => publicBranches.includes(pr.base) },
  { to: 'blocked', why: 'It has no checks, so nothing shows it works.', when: (pr) => !pr.checks?.length },
  { to: 'blocked', why: "Its checks aren't all green.", when: (pr) => !pr.checks.every((c) => SUCCESS_CHECK.has(c)) },
];

const matchRule = (pr, surface, defaultBranch) => {
  const publicBranches = surface ? surface.branches : [defaultBranch ?? 'main'];
  return PR_RULES.find((rule) => rule.when(pr, publicBranches));
};

/**
 * review: lands in a public branch (or has no base), so the owner looks first.
 * blocked: draft, conflicts or requested changes (even on a public branch), else no checks or any check not green.
 * @param {{base: string | null, isDraft: boolean, checks: string[], mergeable?: string | null, reviewDecision?: string | null}} pr
 * @param {PublicSurface | null} surface
 * @returns {'review' | 'blocked' | 'mergeable-by-cos'}
 */
export function classifyPr(pr, surface, defaultBranch) {
  return matchRule(pr, surface, defaultBranch)?.to ?? 'mergeable-by-cos';
}

/**
 * Why a PR can't be merged yet, in plain words, or null when it is not 'blocked'. The merge refusal and the QA
 * card's blockedBy both use this text.
 * @returns {string | null}
 */
export function prBlockReason(pr, surface, defaultBranch) {
  const rule = matchRule(pr, surface, defaultBranch);
  return rule?.to === 'blocked' ? rule.why : null;
}

function canonical(p) {
  try {
    return realpathSync(p);
  } catch {
    return resolve(p);
  }
}

function collectCheckout(path, { useGh, fakePrs, fakeMerged }) {
  /** @type {Record<string, any>} */
  const s = {
    path,
    exists: existsSync(path),
    isGit: false,
    branch: null,
    defaultBranch: null,
    dirty: { count: 0, files: [] },
    ahead: null,
    behind: null,
    lastCommit: null,
    worktrees: [],
    hasGate: false,
    activeGates: 0,
    githubRemote: false,
    prs: [],
    merged: [],
    notes: [],
  };
  if (!s.exists) return s;
  s.isGit = existsSync(join(path, '.git'));
  if (!s.isGit) return s;

  const branch = git(path, 'symbolic-ref', '--short', 'HEAD');
  s.branch = branch.ok ? branch.out : null;
  s.defaultBranch = defaultBranchOf(path);

  const status = git(path, 'status', '--porcelain');
  if (status.ok) {
    const lines = status.out ? status.out.split('\n') : [];
    s.dirty = { count: lines.length, files: lines.slice(0, 3).map((l) => l.slice(3)) };
  } else s.notes.push(`git status failed: ${status.err}`);

  const counts = git(path, 'rev-list', '--left-right', '--count', 'HEAD...@{u}');
  if (counts.ok) [s.ahead, s.behind] = counts.out.split(/\s+/).map(Number);

  const last = git(path, 'log', '-1', '--format=%cr%x1f%s');
  if (last.ok && last.out) {
    const [age, subject] = last.out.split('\x1f');
    s.lastCommit = { age, subject };
  }

  s.worktrees = listWorktrees(path);
  const baseRef = baseRefOf(path);
  for (const w of s.worktrees) Object.assign(w, inspectWorktree(path, w, baseRef));
  s.hasGate = existsSync(join(path, '.claude', 'gate.json'));
  try {
    s.activeGates = readdirSync(join(path, '.claude', 'loop')).filter((f) => f.endsWith('.json')).length;
  } catch {
    s.activeGates = 0;
  }

  const origin = git(path, 'remote', 'get-url', 'origin');
  s.githubRemote = origin.ok && /github\.com[:/]/.test(origin.out);
  const repo = origin.ok ? githubRepoOf(origin.out) : null;
  if (useGh && (repo || fakePrs)) {
    const { prs, note } = listPullRequests(path, repo, fakePrs);
    s.prs = prs;
    if (note) s.notes.push(note);
    const done = listMergedPullRequests(path, repo, { fakePrs, fakeMerged });
    s.merged = done.merged;
    if (done.note) s.notes.push(done.note);
  } else if (useGh && origin.ok) {
    s.notes.push(`origin (${origin.out}) is not a parseable GitHub URL; skipped PRs`);
  }
  return s;
}

/** Each rule returns a message when the checkout needs the owner, else null. */
const ATTENTION_RULES = [
  { id: 'missing', test: (s) => (s.exists ? null : 'checkout is missing') },
  { id: 'not-git', test: (s) => (s.exists && !s.isGit ? 'not a git repo' : null) },
  {
    id: 'dirty',
    test: (s) => (s.isGit && s.dirty.count > 0 ? `${s.dirty.count} uncommitted file(s)` : null),
  },
  {
    id: 'unpushed',
    test: (s) => (s.isGit && s.ahead > 0 ? `${s.ahead} commit(s) not pushed on ${s.branch}` : null),
  },
  {
    id: 'no-upstream',
    test: (s) =>
      s.isGit && s.branch && s.ahead === null && s.branch !== s.defaultBranch
        ? `branch ${s.branch} has no upstream`
        : null,
  },
  {
    id: 'failing-pr',
    test: (s) => {
      const failing = s.prs.filter((pr) => pr.failingChecks.length > 0);
      return failing.length ? `failing checks on ${failing.map((pr) => `#${pr.number}`).join(', ')}` : null;
    },
  },
];

function attentionFor(state) {
  return ATTENTION_RULES.flatMap((rule) => {
    const message = rule.test(state);
    return message ? [{ rule: rule.id, message }] : [];
  });
}

function gatherStatus(projects, opts) {
  return projects.map((p) => ({
    id: p.id,
    name: p.name,
    what: p.what,
    public: p.public,
    checkouts: p.checkouts.map((path) => {
      try {
        const state = collectCheckout(path, opts);
        for (const pr of state.prs) pr.classification = classifyPr(pr, p.public, state.defaultBranch);
        return { ...state, attention: attentionFor(state) };
      } catch (e) {
        return { path, exists: existsSync(path), notes: [`collection failed: ${e.message}`], attention: [] };
      }
    }),
  }));
}

const tilde = (p) => (p.startsWith(homedir()) ? `~${p.slice(homedir().length)}` : p);

function describeCheckout(c, { full = false } = {}) {
  if (!c.exists) return 'missing';
  if (!c.isGit) return 'not a git repo';
  const parts = [`branch ${c.branch ?? '(detached)'}${c.defaultBranch ? ` (default ${c.defaultBranch})` : ''}`];
  parts.push(c.dirty.count ? `${c.dirty.count} dirty (${c.dirty.files.join(', ')})` : 'clean');
  parts.push(c.ahead === null ? 'no upstream' : `ahead ${c.ahead} / behind ${c.behind}`);
  if (c.lastCommit) parts.push(`last commit ${c.lastCommit.age}: ${c.lastCommit.subject}`);
  parts.push(c.hasGate ? `gate yes (${c.activeGates} active)` : 'gate no');
  if (c.worktrees.length) {
    if (full) parts.push(`worktrees: ${c.worktrees.map((w) => `${tilde(w.path)} [${w.branch ?? 'detached'}]`).join(', ')}`);
    else {
      const open = c.worktrees.filter((w) => hasOpenWork(w) || prBranches(c).has(w.branch));
      parts.push(`worktrees: ${c.worktrees.length}${open.length ? `, ${open.length} with open work (${open.slice(0, 4).map(describeWorktree).join(', ')}${open.length > 4 ? ', ...' : ''})` : ', none with open work'}`);
    }
  }
  if (c.prs.length) {
    parts.push(`PRs: ${c.prs.map((pr) => `#${pr.number} ${pr.title}${pr.failingChecks.length ? ' (failing)' : ''}${pr.isDraft ? ' (draft)' : ''}`).join('; ')}`);
  }
  return parts.join('; ');
}

const prBranches = (c) => new Set(c.prs.map((pr) => pr.branch));

function describeWorktree(w) {
  const bits = [!w.merged && w.ahead > 0 ? `${w.ahead} unmerged` : null, w.dirty > 0 ? `${w.dirty} uncommitted` : null].filter(Boolean);
  return `${w.branch ?? basename(w.path)}${bits.length ? ` ${bits.join(', ')}` : ' open PR'}`;
}

export function describePublic(surface, defaultBranch = 'main') {
  if (!surface) return `Public: ${defaultBranch} on origin (nothing declared, default branch assumed)`;
  const parts = [];
  if (surface.branches.length) parts.push(`${surface.branches.join(', ')} on origin`);
  if (surface.remotes.length) parts.push(`pushes to ${surface.remotes.join(', ')}`);
  parts.push(...surface.notes.map((n) => n.replaceAll('`', '')));
  return `Public: ${parts.length ? parts.join('; ') : 'nothing'}`;
}

function prSection(report, classification, heading) {
  const seen = new Set();
  const items = report.flatMap((p) =>
    p.checkouts.flatMap((c) =>
      (c.prs ?? [])
        .filter((pr) => pr.classification === classification && !seen.has(pr.url) && seen.add(pr.url))
        .map((pr) => `- **${p.name}** #${pr.number} ${pr.title} (${pr.url})`),
    ),
  );
  return items.length ? [heading, '', ...items, ''] : [];
}

export function renderStatus(report, notices = [], { full = false } = {}) {
  const needs = [
    ...notices.map((n) => `- ${n}`),
    ...report.flatMap((p) =>
      p.checkouts.flatMap((c) =>
        c.attention.map((a) => `- **${p.name}**${p.checkouts.length > 1 ? ` (${basename(c.path)})` : ''}: ${a.message}`),
      ),
    ),
  ];
  const lines = [
    '# Needs you',
    '',
    ...(needs.length ? needs : ['- Nothing.']),
    '',
    ...prSection(report, 'review', '# Ready for your review'),
    ...prSection(report, 'mergeable-by-cos', '# Chief of Staff can merge'),
  ];
  for (const p of report) {
    lines.push(`## ${p.name}`, '', p.what, '', describePublic(p.public, p.checkouts[0]?.defaultBranch ?? undefined), '');
    for (const c of p.checkouts) {
      lines.push(`- \`${tilde(c.path)}\`: ${describeCheckout(c, { full })}`);
      for (const note of c.notes ?? []) lines.push(`  - note: ${note}`);
    }
    lines.push('');
  }
  return lines.join('\n');
}

function normalize(text) {
  return text.toLowerCase().replace(/[\s_-]+/g, ' ');
}

function scoreProjects(projects, text, { strongOnly = false } = {}) {
  const haystack = ` ${normalize(text)} `;
  return projects.map((project) => {
    const terms = new Set([project.id, project.name, ...project.aliases, ...(strongOnly ? [] : project.keywords)].map(normalize));
    let score = 0;
    for (const term of terms) {
      const escaped = term.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
      if (new RegExp(`(?<![a-z0-9])${escaped}(?![a-z0-9])`).test(haystack)) score++;
    }
    return { project, score };
  });
}

function bestProject(scores) {
  const ranked = [...scores].sort((a, b) => b.score - a.score);
  if (!ranked.length || ranked[0].score === 0 || ranked[1]?.score === ranked[0].score) return null;
  return ranked[0].project;
}

function owningProject(projects, cwd) {
  const here = canonical(cwd);
  let best = null;
  for (const project of projects) {
    for (const checkout of project.checkouts) {
      const root = canonical(checkout);
      for (const base of [root, `${root}-tasks`]) {
        if ((here === base || here.startsWith(base + sep)) && (!best || base.length > best.len)) {
          best = { project, len: base.length };
        }
      }
    }
  }
  return best?.project ?? null;
}

/** Online secret checks are cached beside the registry, in the harness's ignored `.claude/` state. */
const secretsCacheFor = (registryFile) => join(dirname(resolve(registryFile)), '.claude', 'secrets-cache.json');

const NO_PROJECTS = 'No projects yet. Register a folder with `node cos.mjs add <folder>`, or start one with `node cos.mjs new <slug> --what "..."`.';

/** Installed scheduled task -> its prompt in this repo's scheduled/ folder. */
const SCHEDULED_PROMPTS = { 'resume-paused-sessions': 'resume-paused.md', 'cos-morning-brief': 'morning-brief.md', 'daily-harness-review': 'daily-review.md' };

const normalizePrompt = (text) => text.replaceAll(homedir(), '~').trim();

/** The prompt of a scheduled/ file: everything below the first line that is only `---`. */
const repoPrompt = (text) => text.slice(text.indexOf('\n---\n') + 5);

/** Installed tasks whose prompt differs from the repo copy. A task that isn't installed is not drift. */
export function scheduledDrift(scheduledDir, repoDir = join(SELF_DIR, 'scheduled')) {
  return Object.entries(SCHEDULED_PROMPTS).flatMap(([name, file]) => {
    const installed = join(scheduledDir, name, 'SKILL.md');
    const source = join(repoDir, file);
    if (!existsSync(installed) || !existsSync(source)) return [];
    const body = readFileSync(installed, 'utf8').replace(/^---\n[\s\S]*?\n---\n/, '');
    if (normalizePrompt(body) === normalizePrompt(repoPrompt(readFileSync(source, 'utf8')))) return [];
    return [{ task: name, file: `scheduled/${file}`, message: `Scheduled task ${name} differs from scheduled/${file}; paste the new prompt in its settings (or have the hub update it).` }];
  });
}

function cmdStatus(projects, flags, _positional, registryFile) {
  if (!projects.length && !flags.json) {
    console.log(NO_PROJECTS);
    return;
  }
  const report = gatherStatus(projects, { useGh: !flags['no-gh'], fakePrs: flags['fake-prs'], fakeMerged: flags['fake-merged'] });
  attachSecretsToStatus(report, projects, { online: !flags['no-gh'], cached: flags['cached-secrets'] === true, gh: GH, cacheFile: secretsCacheFor(registryFile) });
  const fakeUptime = process.env.COS_UPTIME_SEC;
  const uptimeSec = Number(fakeUptime ?? osUptime());
  const machine = { uptimeDays: Math.floor(uptimeSec / 86_400), warning: uptimeWarningOn(fakeUptime === undefined ? process.platform : 'darwin', uptimeSec) };
  const drift = scheduledDrift(process.env.COS_SCHEDULED_DIR ?? join(homedir(), '.claude', 'scheduled-tasks'));
  if (flags.json) console.log(JSON.stringify(projects.length ? { machine, scheduledDrift: drift, projects: report } : { projects: report }, null, 2));
  else console.log(renderStatus(report, [machine.warning, ...drift.map((d) => d.message)].filter(Boolean), { full: flags.full === true }));
}

/** Linked worktrees whose work is already in the default branch (or whose remote branch is gone) and that hold nothing uncommitted. */
export function findStaleWorktrees(projects, { now = Date.now(), skip = [] } = {}) {
  const registered = new Set(projects.flatMap((p) => p.checkouts.map(canonical)));
  const seen = new Set(skip.map(canonical));
  const stale = [];
  let total = 0;
  for (const p of projects) {
    for (const checkout of p.checkouts.filter((c) => existsSync(join(c, '.git')))) {
      const baseRef = baseRefOf(checkout);
      for (const wt of linkedWorktrees(checkout)) {
        const key = canonical(wt.path);
        if (registered.has(key) || seen.has(key)) continue;
        seen.add(key);
        total++;
        const info = inspectWorktree(checkout, wt, baseRef, now);
        const reason = staleReason(info);
        if (reason) stale.push({ project: p.id, repo: checkout, path: wt.path, branch: wt.branch, reason });
      }
    }
  }
  return { stale, total };
}

function cmdWorktrees(projects, flags) {
  const { stale, total } = findStaleWorktrees(projects, { skip: [process.cwd()] });
  if (flags.json && !flags.remove) {
    console.log(JSON.stringify({ total, stale }, null, 2));
    return;
  }
  console.log(`${stale.length} of ${total} linked worktrees are stale (merged or gone from the remote, nothing uncommitted, older than a day).`);
  for (const w of stale) console.log(`- ${w.project}: ${tilde(w.path)} (${w.reason})`);
  if (!stale.length) return;
  if (!flags.remove) {
    console.log('Nothing removed. Rerun with --remove to remove them (git refuses any that gained changes).');
    return;
  }
  let removed = 0;
  for (const w of stale) {
    const r = removeWorktree(w.repo, w.path);
    if (r.ok) removed++;
    else console.log(`- not removed: ${tilde(w.path)}`);
  }
  console.log(`Removed ${removed} of ${stale.length}.`);
}

function cmdSecrets(projects, flags, _positional, registryFile) {
  if (flags['write-page']) {
    const dir = wikiDirFor({ registryFile });
    if (!existsSync(dir)) throw new Error(`no wiki folder at ${dir}`);
    const { file, changed } = writeSecretsPage(projects, dir);
    console.log(`${changed ? 'wrote' : 'unchanged'} ${tilde(file)}`);
    return;
  }
  const results = resolveSecrets(projects, { gh: GH, refresh: true, cacheFile: secretsCacheFor(registryFile) });
  console.log(flags.json ? JSON.stringify(secretsJson(results), null, 2) : renderSecrets(results));
}

const fmtTime = (iso) =>
  new Date(iso).toLocaleString('en-CA', { month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit', timeZoneName: 'short' });

/**
 * Sessions stopped at a usage limit. Read-only unless `--mark <sessionId>`, which records that this pause was resumed.
 * `--due` lists only pauses whose reset has passed, in chats that aren't archived, that nobody has resumed yet.
 */
function cmdPaused(projects, flags) {
  const opts = {
    projectsDir: flags['projects-dir'] ? resolve(expandHome(flags['projects-dir'])) : DEFAULT_PROJECTS_DIR,
    desktopDir: flags['desktop-dir'] ? resolve(expandHome(flags['desktop-dir'])) : DEFAULT_DESKTOP_DIR,
    marksFile: flags['marks-file'] ? resolve(expandHome(flags['marks-file'])) : join(SELF_DIR, 'mc', 'state', 'resumed.json'),
    now: flags.now ? new Date(flags.now) : new Date(),
  };
  if (Number.isNaN(opts.now.getTime())) throw new UsageError('--now needs an ISO date');
  if (flags['paused-at'] && Number.isNaN(Date.parse(flags['paused-at']))) throw new UsageError('--paused-at needs an ISO date');
  if (flags.mark) {
    const result = markResumed(flags.mark, { ...opts, pausedAt: flags['paused-at'] ?? null });
    const said = {
      marked: 'marked as resumed',
      already: 'already marked',
      'not-paused': 'not paused any more; nothing to mark',
      'not-due': 'paused again and its new reset has not passed; left unmarked so it is woken after that reset',
      'new-pause': 'paused again since that listing; left unmarked so it is woken after the new reset',
    };
    console.log(`${flags.mark}: ${said[result]}`);
    return;
  }
  const pauses = findPaused(opts)
    .filter((p) => !flags.due || (p.due && !p.handled && !p.archived))
    .map(({ file: _file, ...p }) => ({ ...p, project: p.cwd ? owningProject(projects, p.cwd)?.id ?? null : null }));
  if (flags.json) {
    console.log(JSON.stringify({ paused: pauses }, null, 2));
    return;
  }
  if (!pauses.length) {
    console.log(flags.due ? 'No paused sessions are due to resume.' : 'No sessions are paused at a usage limit.');
    return;
  }
  console.log(`${flags.due ? 'Due to resume' : 'Paused at a usage limit'} (${pauses.length}):`);
  for (const p of pauses) {
    const when = p.due ? `reset ${fmtTime(p.resetsAt)}, due now` : `resets ${fmtTime(p.resetsAt)}`;
    const notes = [p.resetGuessed ? 'reset time guessed' : null, p.handled ? 'resume already sent' : null, p.archived ? 'archived' : null].filter(Boolean);
    console.log(`- ${p.title ?? '(untitled)'}${p.project ? ` [${p.project}]` : ''}: paused ${fmtTime(p.pausedAt)}, ${when}${notes.length ? ` (${notes.join(', ')})` : ''}`);
    console.log(`  ${p.localId ?? p.sessionId}  ${p.cwd ? tilde(p.cwd) : 'cwd unknown'}`);
  }
}

const titleCase = (slug) => slug.split('-').map((w) => w[0].toUpperCase() + w.slice(1)).join(' ');

/** The wiki sits beside projects.json in the harness folder. */
const wikiDirFor = (s) => join(dirname(resolve(s.registryFile)), 'wiki');

/** Ordered so a rerun skips what already holds: each `done` inspects the world, not a record of past runs. */
const NEW_STEPS = [
  {
    name: 'folder',
    done: (s) => existsSync(s.dir),
    run: (s) => mkdirSync(s.dir, { recursive: true }),
  },
  {
    name: 'git repo',
    done: (s) => existsSync(join(s.dir, '.git')),
    run: (s) => {
      const r = git(s.dir, 'init', '-b', 'main');
      if (!r.ok) throw new Error(`git init failed: ${r.err}`);
    },
  },
  {
    name: 'CLAUDE.md',
    done: (s) => existsSync(join(s.dir, 'CLAUDE.md')),
    run: (s) => writeFileSync(join(s.dir, 'CLAUDE.md'), CLAUDE_MD(s.name, s.what)),
  },
  {
    name: '.gitignore',
    done: (s) => missingIgnoreLines(join(s.dir, '.gitignore')).length === 0,
    run: (s) => {
      const file = join(s.dir, '.gitignore');
      const prior = existsSync(file) ? readFileSync(file, 'utf8') : '';
      const add = missingIgnoreLines(file).map((l) => `${l}\n`).join('');
      writeFileSync(file, `${prior}${prior && !prior.endsWith('\n') ? '\n' : ''}${add}`);
    },
  },
  {
    name: 'first commit',
    done: (s) => git(s.dir, 'rev-parse', '--verify', 'HEAD').ok,
    run: (s) => {
      git(s.dir, 'add', '-A');
      const r = git(s.dir, 'commit', '-m', `Start ${s.name}`);
      if (!r.ok) throw new Error(`git commit failed: ${r.err}`);
    },
  },
  {
    name: 'registry entry',
    done: (s) => readRegistryRaw(s.registryFile).projects.some((p) => p.id === s.slug),
    run: (s) => appendProject(s.registryFile, { ...s, keywords: [], branch: 'main' }),
  },
  {
    name: 'wiki page',
    enabled: (s) => existsSync(wikiDirFor(s)),
    done: (s) => existsSync(join(wikiDirFor(s), 'projects', `${s.slug}.md`)),
    run: (s) => {
      const r = run(process.execPath, [join(SELF_DIR, 'wiki.mjs'), 'new-page', s.slug, '--wiki', wikiDirFor(s), '--registry', s.registryFile], SELF_DIR, 10_000);
      if (!r.ok) throw new Error(`wiki new-page failed: ${r.err || 'unknown error'}`);
    },
  },
  {
    name: 'github repo',
    enabled: (s) => s.github,
    done: (s) => git(s.dir, 'remote', 'get-url', 'origin').ok && git(s.dir, 'ls-remote', '--exit-code', 'origin', 'HEAD').ok,
    run: (s) => {
      if (git(s.dir, 'remote', 'get-url', 'origin').ok) {
        const push = git(s.dir, 'push', '-u', 'origin', 'main');
        if (!push.ok) throw new Error(`git push failed: ${push.err || 'unknown error'}`);
        return;
      }
      const owner = s.owner ?? signedInOwner();
      const r = run(GH, ['repo', 'create', `${owner}/${s.slug}`, '--private', '--source', s.dir, '--push'], s.dir, 60_000);
      if (!r.ok) throw new Error(`gh repo create failed: ${r.err || 'unknown error'}`);
    },
  },
];

/** Whoever `gh` is signed in as; asked only when --owner is absent. */
function signedInOwner() {
  const r = run(GH, ['api', 'user', '--jq', '.login'], undefined, GH_TIMEOUT_MS);
  if (r.ok && r.out.trim()) return r.out.trim();
  throw new Error(`can't tell your GitHub name (gh api user: ${r.err.split('\n')[0] || 'no login returned'}). Pass --owner <name> or run gh auth login.`);
}

function missingIgnoreLines(file) {
  const have = new Set(existsSync(file) ? readFileSync(file, 'utf8').split('\n').map((l) => l.trim()) : []);
  return IGNORE_LINES.filter((l) => !have.has(l));
}

/** @returns {string | null} why `new` must refuse, else null. Sets s.dir to the folder's real on-disk casing. */
function refuseReason(s, adopt) {
  if (idTaken(readRegistryRaw(s.registryFile), s.slug)) return `project id "${s.slug}" is already registered`;
  const parent = dirname(s.dir);
  const existing = existsSync(parent) ? readdirSync(parent).find((n) => n.toLowerCase() === basename(s.dir).toLowerCase()) : undefined;
  if (existing === undefined) return null;
  s.dir = join(parent, existing);
  if (!statSync(s.dir).isDirectory()) return `${s.dir} exists and is not a folder`;
  if (adopt) return null;
  if (existsSync(join(s.dir, '.git'))) return `${s.dir} is already a git repo (use --adopt to take it over)`;
  if (readdirSync(s.dir).length) return `${s.dir} exists and is not empty (use --adopt to take it over)`;
  return null;
}

const idTaken = (raw, slug) => [...raw.projects, ...(raw.retired ?? [])].some((p) => String(p.id).toLowerCase() === slug);

function writeRegistry(file, raw) {
  const tmp = `${file}.tmp`;
  writeFileSync(tmp, `${JSON.stringify(raw, null, 2)}\n`);
  renameSync(tmp, file);
}

/** The one shape `new` and `add` both write. The public branch is the default branch until the owner says otherwise. */
function appendProject(file, { slug, name, what, dir, keywords, branch }) {
  const raw = readRegistryRaw(file);
  raw.projects.push({
    id: slug,
    name,
    what,
    checkouts: [tilde(dir)],
    aliases: [slug.replaceAll('-', ' ')],
    keywords,
    public: { branches: [branch], remotes: [], notes: [] },
  });
  writeRegistry(file, raw);
}

/** Creates whichever of the owner's files are missing; never overwrites one. */
export function ensureUserFiles(dir) {
  const made = [];
  const make = (name, create) => {
    const path = join(dir, name);
    if (existsSync(path)) return;
    mkdirSync(dirname(path), { recursive: true });
    create(path);
    made.push(name);
  };
  make('projects.json', (f) => writeFileSync(f, '{ "projects": [] }\n'));
  make('ledger.md', (f) => writeFileSync(f, '# Harness ledger\n\nOne row per lesson. The daily review updates it.\n'));
  make('wiki', (f) => (existsSync(join(dir, 'starter-wiki')) ? cpSync(join(dir, 'starter-wiki'), f, { recursive: true }) : mkdirSync(f)));
  make('reports', (f) => mkdirSync(f));
  make('mc/state', (f) => mkdirSync(f));
  return made;
}

function cmdInit(flags) {
  const made = ensureUserFiles(typeof flags.harness === 'string' ? resolve(flags.harness) : SELF_DIR);
  console.log(made.length ? `created ${made.join(', ')}` : 'your files are all in place');
}

/** The starter-side commands live in files that only some checkouts have. */
async function runStarterCommand(file, name, ctx) {
  let mod;
  try {
    mod = await import(`./${file}`);
  } catch (e) {
    if (e.code !== 'ERR_MODULE_NOT_FOUND') throw e;
    return refuse(`${name} isn't available in this checkout (${file} is missing)`, 2);
  }
  process.exitCode = await mod.runCommand(ctx);
}

function refuse(message, code = 2) {
  console.error(`cos: ${message}`);
  process.exitCode = code;
}

function cmdNew(flags, positional, registryFile) {
  const slug = positional[0];
  if (!slug || !SLUG.test(slug) || typeof flags.what !== 'string' || !flags.what.trim()) {
    console.error('usage: cos.mjs new <slug> --what "<one line>" [--github] [--adopt] [--root <dir>] [--owner <gh owner>]   (slug: lowercase letters, digits, hyphens)');
    process.exitCode = 2;
    return;
  }
  const state = {
    slug,
    name: titleCase(slug),
    what: flags.what.trim(),
    dir: resolve(expandHome(typeof flags.root === 'string' ? flags.root : DEFAULT_ROOT), slug),
    registryFile,
    github: flags.github === true,
    owner: typeof flags.owner === 'string' ? flags.owner : undefined,
  };
  const reason = refuseReason(state, flags.adopt === true);
  if (reason) return refuse(reason);
  let failed = false;
  for (const step of NEW_STEPS) {
    if (step.enabled && !step.enabled(state)) continue;
    if (step.done(state)) {
      console.log(`already ${step.name}`);
      continue;
    }
    try {
      step.run(state);
      console.log(`created ${step.name}`);
    } catch (e) {
      console.error(`cos: ${e.message}`);
      failed = true;
      if (step.name !== 'github repo' && step.name !== 'wiki page') break;
    }
  }
  console.log(state.dir);
  if (failed) process.exitCode = 1;
}

const slugify = (name) => name.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '');

function cmdAdd(flags, positional, registryFile) {
  const folder = positional[0];
  const slug = typeof flags.id === 'string' ? flags.id : folder && slugify(basename(resolve(expandHome(folder))));
  if (!folder || !slug || !SLUG.test(slug)) {
    console.error('usage: cos.mjs add <folder> [--id <slug>] [--name "..."] [--what "..."] [--keywords a,b]   (id: lowercase letters, digits, hyphens)');
    process.exitCode = 2;
    return;
  }
  const dir = canonical(resolve(expandHome(folder)));
  if (!existsSync(dir) || !statSync(dir).isDirectory()) return refuse(`${dir} is not a folder`);
  const raw = readRegistryRaw(registryFile);
  if (idTaken(raw, slug)) return refuse(`project id "${slug}" is already registered`);
  const holder = raw.projects.find((p) => (p.checkouts ?? []).some((c) => canonical(resolve(expandHome(String(c)))) === dir));
  if (holder) return refuse(`${tilde(dir)} is already registered as "${holder.id}"`);

  const branch = defaultBranchOf(dir);
  const origin = git(dir, 'remote', 'get-url', 'origin');
  const repo = origin.ok ? githubRepoOf(origin.out) : null;
  const keywords = typeof flags.keywords === 'string' ? flags.keywords.split(',').map((k) => k.trim()).filter(Boolean) : [];
  const name = typeof flags.name === 'string' ? flags.name : titleCase(slug);
  const what = typeof flags.what === 'string' ? flags.what.trim() : '';
  appendProject(registryFile, { slug, name, what, dir, keywords, branch: branch ?? 'main' });
  console.log(`added ${slug} (${name}): ${tilde(dir)}`);
  console.log(`origin: ${repo ?? 'no GitHub origin found'}; default branch: ${branch ?? 'none found, assumed main'}`);
  console.log(`Next: fill in "public" for ${slug} in ${tilde(registryFile)}: the branches, remotes and notes (deploy commands, emails) that make it public. The Chief of Staff merges and deploys anything not listed there on its own.`);
}

function cmdRoute(projects, flags, positional, registryFile) {
  const text = positional.join(' ');
  const scores = scoreProjects(projects, text);
  const best = bestProject(scores);
  const retired = scores.every((s) => s.score === 0) ? bestProject(scoreProjects(loadRetired(registryFile), text)) : null;
  if (flags.json) {
    const out = { match: best?.id ?? null, path: best?.checkouts[0] ?? null };
    if (retired) out.retired = retired.id;
    out.scores = Object.fromEntries(scores.map((s) => [s.project.id, s.score]));
    console.log(JSON.stringify(out, null, 2));
  } else if (retired) console.log(`${retired.name} is retired (projects.json \`retired\`)`);
  else console.log(best ? `${best.id}\t${best.checkouts[0]}` : 'none');
}

/** Moves a project to `retired`. There is no restore command: move it back by hand. */
function cmdRetire(flags, positional, registryFile) {
  const key = normalize(positional[0] ?? '');
  if (!key) throw new UsageError('usage: cos.mjs retire <id or alias>');
  const raw = readRegistryRaw(registryFile);
  const all = [...raw.projects, ...(raw.retired ?? [])];
  const byId = all.filter((p) => normalize(String(p.id)) === key);
  const byAlias = all.filter((p) => (p.aliases ?? []).some((t) => normalize(String(t)) === key));
  const found = byId.length ? byId : byAlias;
  if (found.length > 1) {
    console.error(`cos: "${positional[0]}" matches more than one project (${found.map((p) => p.id).join(', ')}). Use the id.`);
    process.exitCode = 1;
    return;
  }
  const [hit] = found;
  if (hit && (raw.retired ?? []).includes(hit)) return console.log(`${hit.name} is already retired.`);
  const at = hit ? raw.projects.indexOf(hit) : -1;
  if (at < 0) {
    console.error(`cos: no project "${positional[0]}". Known ids: ${raw.projects.map((p) => p.id).join(', ') || '(none)'}`);
    process.exitCode = 1;
    return;
  }
  const [project] = raw.projects.splice(at, 1);
  raw.retired = [...(raw.retired ?? []), { ...project, retiredOn: localDate(new Date()) }];
  writeRegistry(registryFile, raw);
  console.log(`retired ${project.name} (${project.id}). To bring it back, move its entry from "retired" to "projects" in ${tilde(registryFile)} by hand.`);
}

const LEARNED_HEADING = /^## What the last hub learned.*$/m;

/** The "What the last hub learned" section of the newest handoff, else the newest other cos report that has one. */
function cmdLearned(flags) {
  const dir = join(flags.harness ? resolve(String(flags.harness)) : SELF_DIR, 'reports');
  const names = existsSync(dir) ? readdirSync(dir).filter((n) => /^cos-(handoff-)?\d{4}-\d{2}-\d{2}\.md$/.test(n)) : [];
  const newestFirst = (list) => list.sort().reverse();
  const handoffs = newestFirst(names.filter((n) => /^cos-handoff-\d{4}-\d{2}-\d{2}\.md$/.test(n)));
  for (const name of [...handoffs, ...newestFirst(names.filter((n) => !handoffs.includes(n)))]) {
    const text = readFileSync(join(dir, name), 'utf8');
    const start = text.search(LEARNED_HEADING);
    if (start < 0) continue;
    const rest = text.slice(start);
    const end = rest.slice(1).search(/^## /m);
    console.log((end < 0 ? rest : rest.slice(0, end + 1)).trim());
    return;
  }
}

const shellQuote = (s) => (/^[\w./@%+=:,~-]+$/.test(s) ? s : `'${s.replaceAll("'", "'\\''")}'`);

/** `~` only expands unquoted, so a home-relative path keeps `~/` bare and quotes the rest. */
const shellPath = (p) => {
  const home = homedir();
  if (p === home) return '~';
  return p.startsWith(home + sep) ? `~/${shellQuote(p.slice(home.length + 1))}` : shellQuote(p);
};

/**
 * Check runs and commit statuses for a commit, in one shape: [{name, state}] with state ok, failing or pending.
 * `--fake-checks <file>` stands in for gh: {"check_runs": [{name, status, conclusion}], "statuses": [{context, state}]}.
 * @returns {{ok: true, checks: {name: string, state: 'ok' | 'failing' | 'pending', ran: boolean}[]} | {ok: false, why: string}}
 */
function readChecks(folder, sha, fakeFile) {
  let runs;
  let statuses;
  if (fakeFile) {
    ({ check_runs: runs = [], statuses = [] } = JSON.parse(readFileSync(fakeFile, 'utf8')));
  } else {
    const origin = git(folder, 'remote', 'get-url', 'origin');
    const repo = origin.ok ? githubRepoOf(origin.out) : null;
    if (!repo) return { ok: false, why: 'origin is not a GitHub repo' };
    const api = (path, jq) => run(GH, ['api', `repos/${repo}/commits/${sha}/${path}`, '--paginate', '--jq', jq], folder, GH_TIMEOUT_MS);
    const a = api('check-runs', '.check_runs[] | {name, status, conclusion}');
    const b = api('status', '.statuses[] | {context, state}');
    if (!a.ok || !b.ok) return { ok: false, why: (a.err || b.err).split('\n')[0] || 'gh failed' };
    const lines = (r) => r.out.split('\n').filter(Boolean).map((l) => JSON.parse(l));
    runs = lines(a);
    statuses = lines(b);
  }
  const runState = (r) => (r.status !== 'completed' ? 'pending' : SUCCESS_CHECK.has(String(r.conclusion).toUpperCase()) ? 'ok' : 'failing');
  const statusState = (st) => (st.state === 'success' ? 'ok' : st.state === 'pending' ? 'pending' : 'failing');
  const skipped = (r) => r.status === 'completed' && ['NEUTRAL', 'SKIPPED'].includes(String(r.conclusion).toUpperCase());
  return {
    ok: true,
    checks: [
      ...runs.map((r) => ({ name: r.name, state: runState(r), ran: !skipped(r) })),
      ...statuses.map((st) => ({ name: st.context, state: statusState(st), ran: true })),
    ],
  };
}

/**
 * Hands the owner one command that fast-forwards <target> to <sync>. The repos are squash-only, so a long-lived
 * branch catches up with main through a sync branch a worker built, never through a merge here.
 */
function cmdFf(projects, flags, positional) {
  const [folderArg, sync, target] = positional;
  if (!folderArg || !sync || !target) throw new UsageError('usage: cos.mjs ff <repo-folder> <sync-branch> <target-branch> [--json]');
  const result = { ready: false, reason: '', command: null, commits: 0, checksRan: false, checks: [] };
  const finish = (reason, code = 1) => {
    result.reason = reason;
    if (flags.json) console.log(JSON.stringify(result, null, 2));
    else console.log(result.ready ? `${reason}\n${result.command}` : reason);
    process.exitCode = code;
  };
  const folder = resolve(expandHome(folderArg));
  if (!existsSync(folder)) return finish(`${tilde(folder)} does not exist.`);
  if (!existsSync(join(folder, '.git'))) return finish(`${tilde(folder)} is not a git repo.`);
  for (const b of [sync, target]) {
    if (!git(folder, 'check-ref-format', '--branch', b).ok) return finish(`"${b}" is not a valid branch name.`);
  }
  const fetched = run('git', ['-C', folder, 'fetch', 'origin', '--quiet'], undefined, 60_000);
  if (!fetched.ok) return finish(`Could not fetch origin: ${fetched.err.split('\n')[0] || 'unknown error'}`);
  // Full refs: a local branch or tag named origin/<b> must not shadow the remote one.
  const ref = (b) => `refs/remotes/origin/${b}`;
  const sha = (b) => git(folder, 'rev-parse', '--verify', '--quiet', `${ref(b)}^{commit}`);
  const [syncSha, targetSha] = [sha(sync), sha(target)];
  for (const [b, r] of [[sync, syncSha], [target, targetSha]]) if (!r.ok) return finish(`origin/${b} does not exist.`);
  if (syncSha.out === targetSha.out) return finish(`${target} is already up to date with ${sync}.`, 0);
  if (!git(folder, 'merge-base', '--is-ancestor', ref(target), ref(sync)).ok) {
    return finish(`${target} has commits ${sync} lacks; rebuild the sync branch from origin/${target}.`);
  }
  result.commits = Number(git(folder, 'rev-list', '--count', `${ref(target)}..${ref(sync)}`).out);
  const read = readChecks(folder, syncSha.out, flags['fake-checks']);
  if (!read.ok) return finish(`Could not read the checks on ${sync} (${read.why}), so not handing over a command.`);
  result.checks = read.checks;
  result.checksRan = read.checks.some((c) => c.ran);
  const named = (state) => read.checks.filter((c) => c.state === state).map((c) => c.name);
  if (named('failing').length) return finish(`Checks failing on ${sync}: ${named('failing').join(', ')}.`);
  if (named('pending').length) return finish(`Checks still running on ${sync}: ${named('pending').join(', ')}.`);
  const project = projects.find((p) => p.checkouts.some((c) => canonical(c) === canonical(folder)));
  const publicBranches = project?.public ? project.public.branches : [defaultBranchOf(folder) ?? 'main'];
  const isPublic = publicBranches.includes(target);
  if (!result.checksRan && isPublic) return finish(`No checks ran on ${sync}; push it where CI runs (or open a draft PR), then rerun cos ff.`);
  const lines = [];
  if (!result.checksRan) lines.push(`No checks ran on ${sync}.`);
  lines.push(`Moves ${result.commits} commit${result.commits === 1 ? '' : 's'}.`);
  if (isPublic) lines.push(`${target} is public${project ? ` (${describePublic(project.public)})` : ''}, so this is a go-live step.`);
  result.ready = true;
  const moved = shellQuote(`${sync} moved since cos ff checked it; rerun cos ff`);
  result.command =
    `cd ${shellPath(folder)} && git fetch origin && { [ "$(git rev-parse ${shellQuote(ref(sync))})" = ${syncSha.out} ] || { echo ${moved}; false; }; }` +
    ` && git push origin ${shellQuote(ref(sync))}:${shellQuote(`refs/heads/${target}`)}`;
  finish(lines.join(' '), 0);
}

function routeNote(projects, flags, prompt, cwd) {
  const harness = canonical(flags.harness || SELF_DIR);
  const here = canonical(cwd);
  for (const hub of [harness, `${harness}-tasks`]) {
    if (here === hub || here.startsWith(hub + sep)) return null;
  }
  const own = owningProject(projects, cwd);
  const scores = scoreProjects(projects, prompt, { strongOnly: true });
  const routed = bestProject(scores);
  if (!routed || routed.id === own?.id) return null;
  if (own && scores.find((s) => s.project.id === own.id).score > 0) return null;
  return (
    `This message looks like ${routed.name} work (${routed.checkouts[0]}), but this session is in ${own?.name ?? basename(here)}. ` +
    'Before doing anything, tell the owner and offer to switch folders (change_directory) or start a session there.'
  );
}

// The hub is the session started in the harness folder itself, not a worktree under it.
const isHubCwd = (cwd) => {
  try { return typeof cwd === 'string' && realpathSync(cwd) === realpathSync(SELF_DIR); } catch { return false; }
};

function cmdHook(projects, flags) {
  const input = JSON.parse(readFileSync(0, 'utf8'));
  const { prompt, cwd } = input;
  const notes = [];
  try {
    notes.push(sizeWarning({ transcriptPath: input.transcript_path, sessionId: input.session_id, hub: isHubCwd(cwd) }));
  } catch {}
  if (typeof prompt === 'string' && typeof cwd === 'string') notes.push(routeNote(projects, flags, prompt, cwd));
  const out = notes.filter(Boolean).join('\n\n');
  if (out) console.log(out);
}

function main() {
  const [command, ...rest] = process.argv.slice(2);
  let parsed;
  try {
    parsed = parseArgs(rest);
  } catch (e) {
    if (!(e instanceof UsageError)) throw e;
    console.error(`cos: ${e.message}`);
    process.exitCode = 2;
    return;
  }
  const { flags, positional } = parsed;
  const registryFile = flags.registry || join(SELF_DIR, 'projects.json');

  if (command === 'init') {
    cmdInit(flags);
    return;
  }

  if (command === 'learned') {
    cmdLearned(flags);
    return;
  }

  if (command === 'publish-starter' || command === 'update') {
    const file = command === 'update' ? 'starter-update.mjs' : 'make-starter.mjs';
    runStarterCommand(file, command, { flags, positional, harness: SELF_DIR }).catch((e) => refuse(e.message, 1));
    return;
  }

  if (!flags.registry && command !== 'hook') ensureUserFiles(SELF_DIR);

  const writers = { new: cmdNew, add: cmdAdd, retire: cmdRetire };
  if (writers[command]) {
    try {
      writers[command](flags, positional, registryFile);
    } catch (e) {
      refuse(e.message, 1);
    }
    return;
  }

  if (command === 'usage') {
    import('./usage-report.mjs').then((u) => u.main(rest));
    return;
  }

  if (command === 'mc') {
    import('./mc/server.mjs').then((mc) => mc.main(rest));
    return;
  }

  if (command === 'hook') {
    try {
      cmdHook(loadRegistry(registryFile), flags);
    } catch {
      /* a hook must never block the prompt */
    }
    return;
  }

  const commands = { status: cmdStatus, worktrees: cmdWorktrees, route: cmdRoute, secrets: cmdSecrets, paused: cmdPaused, ff: cmdFf };
  if (!commands[command]) {
    console.error('usage: cos.mjs status [--json] [--no-gh] [--cached-secrets] [--full] | worktrees [--json] [--remove] | usage [--hours 48] [--growth 80000 | --cap <tokens>] [--projects-dir <dir>] | new <slug> --what "..." | add <folder> | secrets [--json | --write-page] | retire <id> | route "<text>" [--json] | ff <folder> <sync-branch> <target-branch> [--json] | learned | paused [--json] [--due] [--mark <sessionId> [--paused-at <iso>]] | hook | mc [--port 4747] | init | update [--check] [--adopt] [--from <url>] | publish-starter [--to <url>] [--dry-run]   (--registry <path>)');
    process.exitCode = 2;
    return;
  }
  try {
    commands[command](loadRegistry(registryFile), flags, positional, registryFile);
  } catch (e) {
    refuse(e.message, 1);
  }
}

if (process.argv[1] && canonical(process.argv[1]) === canonical(fileURLToPath(import.meta.url))) main();
