#!/usr/bin/env node
import { spawnSync } from 'node:child_process';
import { accessSync, constants as fsConstants, cpSync, existsSync, mkdirSync, readdirSync, readFileSync, realpathSync, renameSync, statSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { basename, dirname, isAbsolute, join, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import { DEFAULT_DESKTOP_DIR, DEFAULT_PROJECTS_DIR, findPaused, markResumed } from './limits.mjs';
import { USER_FILES } from './starter-update.mjs';
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
const VALUE_FLAGS = new Set(['registry', 'harness', 'what', 'root', 'owner', 'fake-prs', 'id', 'name', 'keywords', 'to', 'message', 'from', 'mark', 'paused-at', 'projects-dir', 'desktop-dir', 'marks-file', 'now']);
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

/** @returns {Project[]} */
export function loadRegistry(file) {
  const raw = readRegistryRaw(file);
  if (!Array.isArray(raw?.projects)) throw new Error(`${file}: expected {"projects": [...]}`);
  return raw.projects.map((p, i) => {
    if (typeof p?.id !== 'string' || typeof p?.name !== 'string' || !Array.isArray(p?.checkouts)) {
      throw new Error(`${file}: projects[${i}] needs string id, string name, and a checkouts array`);
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
      secrets: parseSecrets(p.secrets, `${file}: projects[${i}]`),
    };
  });
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
  const fields = 'number,title,headRefName,baseRefName,isDraft,url,statusCheckRollup,mergeable,reviewDecision';
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
      failingChecks: (pr.statusCheckRollup ?? [])
        .filter((c) => FAILING_CHECK.has(c.conclusion) || FAILING_CHECK.has(c.state))
        .map((c) => c.name ?? c.context ?? 'check'),
    }));
    return { prs, note: null };
  } catch {
    return { prs: [], note: 'gh pr list returned unparseable output' };
  }
}

/** First matching rule wins; no match means mergeable-by-cos. Every unknown fails closed. */
const PR_RULES = [
  { to: 'review', when: (pr) => !pr.base },
  { to: 'review', when: (pr, publicBranches) => publicBranches.includes(pr.base) },
  { to: 'blocked', when: (pr) => pr.isDraft },
  { to: 'blocked', when: (pr) => !pr.checks?.length },
  { to: 'blocked', when: (pr) => !pr.checks.every((c) => SUCCESS_CHECK.has(c)) },
  { to: 'blocked', when: (pr) => pr.mergeable === 'CONFLICTING' },
  { to: 'blocked', when: (pr) => pr.reviewDecision === 'CHANGES_REQUESTED' },
];

/**
 * review: lands in a public branch (or has no base), so the owner looks first.
 * blocked: draft, no checks, any check not green, conflicts, or changes requested.
 * @param {{base: string | null, isDraft: boolean, checks: string[], mergeable?: string | null, reviewDecision?: string | null}} pr
 * @param {PublicSurface | null} surface
 * @returns {'review' | 'blocked' | 'mergeable-by-cos'}
 */
export function classifyPr(pr, surface, defaultBranch) {
  const publicBranches = surface ? surface.branches : [defaultBranch ?? 'main'];
  return PR_RULES.find((rule) => rule.when(pr, publicBranches))?.to ?? 'mergeable-by-cos';
}

function canonical(p) {
  try {
    return realpathSync(p);
  } catch {
    return resolve(p);
  }
}

function collectCheckout(path, { useGh, fakePrs }) {
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
    s.dirty = { count: lines.length, files: lines.slice(0, 5).map((l) => l.slice(3)) };
  } else s.notes.push(`git status failed: ${status.err}`);

  const counts = git(path, 'rev-list', '--left-right', '--count', 'HEAD...@{u}');
  if (counts.ok) [s.ahead, s.behind] = counts.out.split(/\s+/).map(Number);

  const last = git(path, 'log', '-1', '--format=%cr%x1f%s');
  if (last.ok && last.out) {
    const [age, subject] = last.out.split('\x1f');
    s.lastCommit = { age, subject };
  }

  s.worktrees = listWorktrees(path);
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

function describeCheckout(c) {
  if (!c.exists) return 'missing';
  if (!c.isGit) return 'not a git repo';
  const parts = [`branch ${c.branch ?? '(detached)'}${c.defaultBranch ? ` (default ${c.defaultBranch})` : ''}`];
  parts.push(c.dirty.count ? `${c.dirty.count} dirty (${c.dirty.files.join(', ')})` : 'clean');
  parts.push(c.ahead === null ? 'no upstream' : `ahead ${c.ahead} / behind ${c.behind}`);
  if (c.lastCommit) parts.push(`last commit ${c.lastCommit.age}: ${c.lastCommit.subject}`);
  parts.push(c.hasGate ? `gate yes (${c.activeGates} active)` : 'gate no');
  if (c.worktrees.length) parts.push(`worktrees: ${c.worktrees.map((w) => `${tilde(w.path)} [${w.branch ?? 'detached'}]`).join(', ')}`);
  if (c.prs.length) {
    parts.push(`PRs: ${c.prs.map((pr) => `#${pr.number} ${pr.title}${pr.failingChecks.length ? ' (failing)' : ''}${pr.isDraft ? ' (draft)' : ''}`).join('; ')}`);
  }
  return parts.join('; ');
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

export function renderStatus(report) {
  const needs = report.flatMap((p) =>
    p.checkouts.flatMap((c) =>
      c.attention.map((a) => `- **${p.name}**${p.checkouts.length > 1 ? ` (${basename(c.path)})` : ''}: ${a.message}`),
    ),
  );
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
      lines.push(`- \`${tilde(c.path)}\`: ${describeCheckout(c)}`);
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

function cmdStatus(projects, flags, _positional, registryFile) {
  if (!projects.length && !flags.json) {
    console.log(NO_PROJECTS);
    return;
  }
  const report = gatherStatus(projects, { useGh: !flags['no-gh'], fakePrs: flags['fake-prs'] });
  attachSecretsToStatus(report, projects, { online: !flags['no-gh'], gh: GH, cacheFile: secretsCacheFor(registryFile) });
  console.log(flags.json ? JSON.stringify({ projects: report }, null, 2) : renderStatus(report));
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

const idTaken = (raw, slug) => raw.projects.some((p) => String(p.id).toLowerCase() === slug);

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

function cmdRoute(projects, flags, positional) {
  const scores = scoreProjects(projects, positional.join(' '));
  const best = bestProject(scores);
  if (flags.json) {
    const out = { match: best?.id ?? null, path: best?.checkouts[0] ?? null };
    out.scores = Object.fromEntries(scores.map((s) => [s.project.id, s.score]));
    console.log(JSON.stringify(out, null, 2));
  } else console.log(best ? `${best.id}\t${best.checkouts[0]}` : 'none');
}

function cmdHook(projects, flags) {
  const { prompt, cwd } = JSON.parse(readFileSync(0, 'utf8'));
  if (typeof prompt !== 'string' || typeof cwd !== 'string') return;
  const harness = canonical(flags.harness || SELF_DIR);
  const here = canonical(cwd);
  for (const hub of [harness, `${harness}-tasks`]) {
    if (here === hub || here.startsWith(hub + sep)) return;
  }
  const own = owningProject(projects, cwd);
  const scores = scoreProjects(projects, prompt, { strongOnly: true });
  const routed = bestProject(scores);
  if (!routed || routed.id === own?.id) return;
  if (own && scores.find((s) => s.project.id === own.id).score > 0) return;
  console.log(
    `This message looks like ${routed.name} work (${routed.checkouts[0]}), but this session is in ${own?.name ?? basename(here)}. ` +
      'Before doing anything, tell the owner and offer to switch folders (change_directory) or start a session there.',
  );
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

  if (command === 'publish-starter' || command === 'update') {
    const file = command === 'update' ? 'starter-update.mjs' : 'make-starter.mjs';
    runStarterCommand(file, command, { flags, positional, harness: SELF_DIR }).catch((e) => refuse(e.message, 1));
    return;
  }

  if (!flags.registry && command !== 'hook') ensureUserFiles(SELF_DIR);

  const writers = { new: cmdNew, add: cmdAdd };
  if (writers[command]) {
    try {
      writers[command](flags, positional, registryFile);
    } catch (e) {
      refuse(e.message, 1);
    }
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

  const commands = { status: cmdStatus, route: cmdRoute, secrets: cmdSecrets, paused: cmdPaused };
  if (!commands[command]) {
    console.error('usage: cos.mjs status [--json] [--no-gh] | new <slug> --what "..." | add <folder> | secrets [--json | --write-page] | route "<text>" [--json] | paused [--json] [--due] [--mark <sessionId> [--paused-at <iso>]] | hook | mc [--port 4747] | init | update [--check] [--adopt] [--from <url>] | publish-starter [--to <url>] [--dry-run]   (--registry <path>)');
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
