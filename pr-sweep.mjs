// The PR steward's planner: looks at every open PR across the projects in projects.json and says what the steward
// should do with each. It plans and prints; it never merges, pushes or comments. The scheduled task (scheduled/pr-steward.md)
// runs the reviewers and fixers, then merges only PRs whose pr-check shows "auto-merge: pass - ELIGIBLE", through walls.mjs.
//
//   cos.mjs pr-sweep [--json] [--project <id>] [--registry projects.json] [--fixture <file>]
//   cos.mjs pr-marker review --commit <sha> --base <branch> --verdict pass|findings --scope pass|fail --reviewer <model>
//   cos.mjs pr-marker steward --commit <sha> --try <n>
//
// Actions: review (latest commit has no review), fix (failing checks, conflicts or review findings; max 3 tries),
// merge (auto-merge eligible), owner (listed for the hub's next merge question), flag (out of tries: tell the hub),
// wait (checks still running), skip (draft or closed).
import { spawnSync } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { evaluatePr, ghFetchPr, policyFor, repoFromRemote, checkState, publicBaseOf } from './cos-tools.mjs';
import { MAX_TRIES, reviewClean, reviewMarker, reviewOfHead, riskOf, stewardMarker, stewardTries } from './pr-policy.mjs';

const SELF_DIR = dirname(fileURLToPath(import.meta.url));
const expandHome = (p) => (p === '~' ? homedir() : p.startsWith('~/') ? join(homedir(), p.slice(2)) : p);

/** Every GitHub repo a project owns (its `repos` plus each checkout's origin), with the checkout folder that has it, or null. */
export function reposOfProject(p, originOf = defaultOrigin) {
  const set = new Map();
  for (const r of p.repos ?? []) set.set(String(r).toLowerCase(), { repo: String(r), checkout: null });
  for (const c of p.checkouts ?? []) {
    const dir = expandHome(String(c));
    const r = originOf(dir);
    if (r) set.set(r.toLowerCase(), { repo: set.get(r.toLowerCase())?.repo ?? r, checkout: dir });
  }
  return [...set.values()];
}

function defaultOrigin(dir) {
  if (!existsSync(dir)) return null;
  const r = spawnSync('git', ['-C', dir, 'remote', 'get-url', 'origin'], { encoding: 'utf8', timeout: 5000 });
  return r.status === 0 ? repoFromRemote(r.stdout) : null;
}

/**
 * What the steward does with one PR.
 * @returns {{action: 'review' | 'fix' | 'merge' | 'owner' | 'flag' | 'wait' | 'skip', why: string, model?: string}}
 */
export function planPr(pr, opts) {
  if (String(pr?.state ?? 'OPEN').toUpperCase() !== 'OPEN') return { action: 'skip', why: 'not open' };
  if (pr?.isDraft) return { action: 'skip', why: 'draft' };
  if (!(opts.trusted ?? []).some((t) => String(t).toLowerCase() === String(pr?.author?.login ?? '').toLowerCase())) return { action: 'owner', why: 'PR author is not the owner' };
  const ev = evaluatePr(pr, opts);
  const files = (pr.files ?? []).map((f) => (typeof f === 'string' ? f : f?.path ?? '')).filter(Boolean);
  const tries = stewardTries(pr.comments, opts.trusted ?? []);
  const rollup = Array.isArray(pr.statusCheckRollup) ? pr.statusCheckRollup : [];
  const failing = rollup.filter((c) => checkState(c) === 'fail').map((c) => c.name || c.context || 'check');
  const pending = rollup.some((c) => checkState(c) === 'pending');
  const review = reviewOfHead(pr.comments, pr.headRefOid, opts.trusted ?? [], pr.baseRefName ?? '');

  let fix = null;
  if (pr.mergeable === 'CONFLICTING') fix = 'merge conflicts with the base branch';
  else if (failing.length) fix = `failing checks: ${failing.join(', ')}`;
  else if (review && !reviewClean(review)) fix = review.scope === 'fail' ? 'scope review failed' : 'unaddressed review findings';
  if (fix) {
    if (tries >= MAX_TRIES) return { action: 'flag', why: `${fix}; ${tries} steward tries used (max ${MAX_TRIES}), tell the hub` };
    return { action: 'fix', why: `${fix} (try ${tries + 1} of ${MAX_TRIES})` };
  }
  if (pending) return { action: 'wait', why: 'checks still running' };
  if (!review) {
    const risk = riskOf(pr, files);
    return { action: 'review', why: risk ? `no review of the latest commit; Opus (${risk})` : 'no review of the latest commit; Sonnet is enough', model: risk ? 'opus' : 'sonnet' };
  }
  if (ev.eligible) return { action: 'merge', why: `routine into private ${pr.baseRefName}, clean review of ${pr.headRefOid.slice(0, 7)}` };
  const fails = ev.lines.filter((l) => l.status === 'FAIL').map((l) => `${l.name}: ${l.note}`);
  const auto = ev.lines.find((l) => l.name === 'auto-merge')?.note ?? '';
  return { action: 'owner', why: fails.length ? `pr-check fails: ${fails.join('; ')}` : auto.replace(/^needs the owner: /, '') };
}

/**
 * Plans every open PR. `fetch` gives {repo, pr} pairs; the default asks gh for each project's open PRs.
 * @returns {{repo: string, number: number, title: string, url: string, base: string, action: string, why: string, model?: string}[]}
 */
export function sweep({ registryFile, project = null, fetch = ghFetchAll, originOf = defaultOrigin } = {}) {
  const projects = JSON.parse(readFileSync(registryFile, 'utf8')).projects ?? [];
  const rows = [];
  const seen = new Set();
  for (const p of projects) {
    if (project && p.id !== project) continue;
    for (const { repo, checkout } of reposOfProject(p, originOf)) {
      if (seen.has(repo.toLowerCase())) continue;
      seen.add(repo.toLowerCase());
      let prs;
      try {
        prs = fetch(repo);
      } catch (e) {
        rows.push({ repo, number: 0, title: '', url: '', base: '', action: 'flag', why: `could not list PRs: ${e.message}` });
        continue;
      }
      for (const pr of prs) {
        let plan;
        try {
          plan = planPr(pr, { publicBase: publicBaseOf(repo, pr.baseRefName, registryFile), ...policyFor(repo, registryFile) });
        } catch (e) {
          plan = { action: 'owner', why: `could not plan (${e.message}); the owner decides` };
        }
        // The steward runs gh from a checkout of the repo (walls checks -R against that folder's origin).
        if (!checkout && ['review', 'fix'].includes(plan.action)) plan = { action: 'owner', why: `no local checkout of ${repo} (steward can't run gh there); was: ${plan.action}` };
        rows.push({ repo, number: pr.number, title: pr.title ?? '', url: pr.url ?? '', base: pr.baseRefName ?? '', checkout, ...plan });
      }
    }
  }
  return rows;
}

/** Open PRs of `repo` with everything planPr reads. */
function ghFetchAll(repo) {
  const r = spawnSync(process.env.GH_BIN || 'gh', ['pr', 'list', '-R', repo, '--state', 'open', '--json', 'number', '--limit', '50'], { encoding: 'utf8', timeout: 30_000 });
  if (r.status !== 0) throw new Error((r.stderr || r.error?.message || 'gh pr list failed').split('\n')[0]);
  return JSON.parse(r.stdout).map(({ number }) => ghFetchPr({ repo, number }));
}

const ORDER = ['merge', 'review', 'fix', 'flag', 'owner', 'wait', 'skip'];

/**
 * `cos.mjs pr-automerge <owner/repo#N>`: the steward's only merge. Re-runs pr-check logic and merges (squash, delete branch,
 * pinned to the reviewed head) only when the PR is eligible; otherwise merges nothing and exits 1.
 * @returns {number} exit code
 */
export function runAutoMerge(args, { fetchPr = ghFetchPr, gh = (a) => spawnSync(process.env.GH_BIN || 'gh', a, { encoding: 'utf8', timeout: 60_000 }), registryFile = join(SELF_DIR, 'projects.json'), out = console.log, err = console.error } = {}) {
  try {
    const m = String(args[0] ?? '').match(/^([^/\s#]+\/[^#\s]+)#(\d+)$/);
    if (!m) throw new Error('usage: pr-automerge <owner/repo#N> [--dry-run]');
    const [, repo, n] = m;
    const pr = fetchPr({ repo, number: Number(n) });
    const ev = evaluatePr(pr, { publicBase: publicBaseOf(repo, pr?.baseRefName, registryFile), ...policyFor(repo, registryFile) });
    if (!ev.eligible) {
      out(`pr-automerge ${repo}#${n}: NOT merged. ${ev.lines.find((l) => l.name === 'auto-merge')?.note ?? ''}`.replace(/[\u0000-\u001f]+/g, ' '));
      return 1;
    }
    if (args.includes('--dry-run')) {
      out(`pr-automerge ${repo}#${n}: would merge (squash, delete branch, head ${ev.head}).`);
      return 0;
    }
    const r = gh(['pr', 'merge', n, '-R', repo, '--squash', '--delete-branch', '--match-head-commit', ev.head]);
    if (r.status !== 0) throw new Error(`gh pr merge failed: ${(r.stderr || '').split('\n')[0]}`);
    out(`pr-automerge ${repo}#${n}: merged (squash, head ${ev.head}).`);
    return 0;
  } catch (e) {
    err(`pr-automerge: ${e.message}`);
    return 2;
  }
}

export function renderSweep(rows) {
  if (!rows.length) return 'pr-sweep: no open PRs.';
  const sorted = [...rows].sort((a, b) => ORDER.indexOf(a.action) - ORDER.indexOf(b.action));
  const counts = ORDER.map((a) => [a, rows.filter((r) => r.action === a).length]).filter(([, n]) => n);
  const line = (r) => `${r.action.padEnd(6)} ${r.repo}#${r.number} -> ${r.base || '?'}  ${r.title.slice(0, 60)}\n         ${r.why}`;
  return [`pr-sweep: ${counts.map(([a, n]) => `${n} ${a}`).join(', ')} (plan only: nothing was reviewed, fixed, pushed or merged)`, ...sorted.map(line)].join('\n');
}

/** @returns {number} exit code */
export function runSweep(args, { out = console.log, err = console.error } = {}) {
  try {
    const flags = {};
    for (let i = 0; i < args.length; i++) {
      const a = args[i];
      if (!a.startsWith('--')) throw new Error(`unexpected argument "${a}"`);
      const k = a.slice(2);
      if (['registry', 'project', 'fixture'].includes(k)) {
        if (args[i + 1] === undefined) throw new Error(`${a} needs a value`);
        flags[k] = args[++i];
      } else flags[k] = true;
    }
    const registryFile = flags.registry ?? join(SELF_DIR, 'projects.json');
    const fixture = flags.fixture ? JSON.parse(readFileSync(flags.fixture, 'utf8')) : null;
    const rows = sweep({ registryFile, project: flags.project ?? null, ...(fixture ? { fetch: (repo) => fixture[repo] ?? [], originOf: () => null } : {}) });
    out(flags.json ? JSON.stringify(rows, null, 2) : renderSweep(rows));
    return 0;
  } catch (e) {
    err(`pr-sweep: ${e.message}`);
    return 2;
  }
}

/** `cos.mjs pr-marker review|steward ...` prints the comment's first line. */
export function runMarker(args, { out = console.log, err = console.error } = {}) {
  try {
    const [kind, ...rest] = args;
    const f = {};
    for (let i = 0; i < rest.length; i += 2) f[String(rest[i]).replace(/^--/, '')] = rest[i + 1];
    if (!/^[0-9a-f]{40}$/i.test(f.commit ?? '')) throw new Error('--commit must be the full 40-character sha');
    if (kind === 'review') {
      if (!f.base || !['pass', 'findings'].includes(f.verdict) || !['pass', 'fail'].includes(f.scope) || !f.reviewer) throw new Error('review needs --base <branch> --verdict pass|findings --scope pass|fail --reviewer <model>');
      out(reviewMarker(f));
    } else if (kind === 'steward') {
      if (!/^\d+$/.test(f.try ?? '')) throw new Error('steward needs --try <n>');
      out(stewardMarker(f));
    } else throw new Error('usage: pr-marker review|steward ...');
    return 0;
  } catch (e) {
    err(`pr-marker: ${e.message}`);
    return 2;
  }
}
