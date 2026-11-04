#!/usr/bin/env node
import { spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, readdirSync, readFileSync, realpathSync, renameSync, statSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { basename, dirname, join, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';

const SELF_DIR = dirname(fileURLToPath(import.meta.url));
const GIT_TIMEOUT_MS = 10_000;
const GH_TIMEOUT_MS = 8_000;
const FAILING_CHECK = new Set(['FAILURE', 'TIMED_OUT', 'STARTUP_FAILURE', 'ERROR']);
const SUCCESS_CHECK = new Set(['SUCCESS', 'NEUTRAL', 'SKIPPED']);
const IGNORE_LINES = ['.claude/loop/', '.env', '.env.*', '!.env.example', 'node_modules/'];

const DEFAULT_ROOT = '~/Projects';
const VALUE_FLAGS = new Set(['registry', 'harness', 'what', 'root', 'owner', 'fake-prs']);
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
 * @typedef {{id: string, name: string, what: string, checkouts: string[], aliases: string[], keywords: string[], public: PublicSurface | null}} Project
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

/** @returns {Project[]} */
function loadRegistry(file) {
  const raw = JSON.parse(readFileSync(file, 'utf8'));
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
    : run('gh', ['pr', 'list', '-R', repo, '--json', fields, '--limit', '20'], cwd, GH_TIMEOUT_MS);
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

function describePublic(surface, defaultBranch = 'main') {
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

function cmdStatus(projects, flags) {
  const report = gatherStatus(projects, { useGh: !flags['no-gh'], fakePrs: flags['fake-prs'] });
  console.log(flags.json ? JSON.stringify({ projects: report }, null, 2) : renderStatus(report));
}

function readRegistryRaw(file) {
  return JSON.parse(readFileSync(file, 'utf8'));
}

const titleCase = (slug) => slug.split('-').map((w) => w[0].toUpperCase() + w.slice(1)).join(' ');

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
    run: (s) => {
      const raw = readRegistryRaw(s.registryFile);
      raw.projects.push({
        id: s.slug,
        name: s.name,
        what: s.what,
        checkouts: [tilde(s.dir)],
        aliases: [s.slug.replaceAll('-', ' ')],
        keywords: [],
        public: { branches: ['main'], remotes: [], notes: [] },
      });
      writeRegistry(s.registryFile, raw);
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
      let owner = s.owner;
      if (!owner) {
        const me = run('gh', ['api', 'user', '--jq', '.login'], s.dir, 15_000);
        if (!me.ok || !me.out.trim()) throw new Error(`couldn't read your GitHub name (run gh auth login, or pass --owner): ${me.err || 'no name returned'}`);
        owner = me.out.trim();
      }
      const r = run('gh', ['repo', 'create', `${owner}/${s.slug}`, '--private', '--source', s.dir, '--push'], s.dir, 60_000);
      if (!r.ok) throw new Error(`gh repo create failed: ${r.err || 'unknown error'}`);
    },
  },
];

function missingIgnoreLines(file) {
  const have = new Set(existsSync(file) ? readFileSync(file, 'utf8').split('\n').map((l) => l.trim()) : []);
  return IGNORE_LINES.filter((l) => !have.has(l));
}

/** @returns {string | null} why `new` must refuse, else null. Sets s.dir to the folder's real on-disk casing. */
function refuseReason(s, adopt) {
  const registered = readRegistryRaw(s.registryFile).projects.some((p) => String(p.id).toLowerCase() === s.slug);
  if (registered) return `project id "${s.slug}" is already registered`;
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

function writeRegistry(file, raw) {
  const tmp = `${file}.tmp`;
  writeFileSync(tmp, `${JSON.stringify(raw, null, 2)}\n`);
  renameSync(tmp, file);
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
    owner: typeof flags.owner === 'string' ? flags.owner : null,
  };
  try {
    const reason = refuseReason(state, flags.adopt === true);
    if (reason) {
      console.error(`cos: ${reason}`);
      process.exitCode = 2;
      return;
    }
  } catch (e) {
    console.error(`cos: ${e.message}`);
    process.exitCode = 1;
    return;
  }
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
      if (step.name !== 'github repo') break;
    }
  }
  console.log(state.dir);
  if (failed) process.exitCode = 1;
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

  if (command === 'new') {
    cmdNew(flags, positional, registryFile);
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

  const commands = { status: cmdStatus, route: cmdRoute };
  if (!commands[command]) {
    console.error('usage: cos.mjs status [--json] [--no-gh] | new <slug> --what "..." | route "<text>" [--json] | hook   (--registry <path>)');
    process.exitCode = 2;
    return;
  }
  try {
    commands[command](loadRegistry(registryFile), flags, positional);
  } catch (e) {
    console.error(`cos: ${e.message}`);
    process.exitCode = 1;
  }
}

if (process.argv[1] && canonical(process.argv[1]) === canonical(fileURLToPath(import.meta.url))) main();
