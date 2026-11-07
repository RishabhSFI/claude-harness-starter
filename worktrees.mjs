// Worktree state for status and the stale-worktree cleanup. Git reads only, except `removeWorktree`.
import { spawnSync } from 'node:child_process';
import { realpathSync, statSync } from 'node:fs';
import { resolve } from 'node:path';

const DAY_MS = 86_400_000;

function git(cwd, ...args) {
  const r = spawnSync('git', args, { cwd, encoding: 'utf8', timeout: 10_000, stdio: ['ignore', 'pipe', 'pipe'], env: { ...process.env, GIT_OPTIONAL_LOCKS: '0' } });
  return { ok: r.status === 0, out: (r.stdout ?? '').trimEnd() };
}

const canon = (p) => { try { return realpathSync(p); } catch { return resolve(p); } };

/** The ref worktree branches are compared with: origin/<default> when present, else the local default. */
export function baseRefOf(repo) {
  const head = git(repo, 'symbolic-ref', '--short', 'refs/remotes/origin/HEAD');
  const name = head.ok ? head.out.replace(/^origin\//, '') : ['main', 'master'].find((n) => git(repo, 'show-ref', '--verify', '--quiet', `refs/heads/${n}`).ok);
  if (!name) return null;
  return git(repo, 'show-ref', '--verify', '--quiet', `refs/remotes/origin/${name}`).ok ? `origin/${name}` : name;
}

/** Every linked worktree of the repo at `repo` (the main checkout is left out). */
export function linkedWorktrees(repo) {
  const r = git(repo, 'worktree', 'list', '--porcelain');
  if (!r.ok) return [];
  return r.out.split(/\n\n+/).slice(1).flatMap((block) => {
    const path = block.match(/^worktree (.+)$/m)?.[1];
    if (!path) return [];
    return [{ path, branch: block.match(/^branch refs\/heads\/(.+)$/m)?.[1] ?? null, locked: /^locked/m.test(block), prunable: /^prunable/m.test(block) }];
  });
}

/** A squash-merged branch has commits the base lacks but merging it would change nothing. */
function addsNothing(cwd, baseRef) {
  const merged = git(cwd, 'merge-tree', '--write-tree', baseRef, 'HEAD');
  const base = git(cwd, 'rev-parse', `${baseRef}^{tree}`);
  return merged.ok && base.ok && merged.out.split('\n')[0] === base.out;
}

/** Does the branch's upstream no longer exist on the remote (as of the last fetch)? */
function upstreamGone(repo, branch) {
  const r = git(repo, 'for-each-ref', '--format=%(upstream:track)', `refs/heads/${branch}`);
  return r.ok && r.out.includes('gone');
}

/**
 * @returns {{path, branch, dirty: number, ahead: number|null, merged: boolean, gone: boolean, ageDays: number, locked: boolean, missing: boolean}}
 * `ahead` counts commits the worktree's HEAD has that the base ref lacks.
 */
export function inspectWorktree(repo, wt, baseRef, now = Date.now()) {
  let ageDays = Infinity;
  let missing = false;
  try { ageDays = (now - statSync(wt.path).birthtimeMs) / DAY_MS; } catch { missing = true; }
  const base = { path: wt.path, branch: wt.branch, locked: wt.locked, missing, ageDays, dirty: 0, ahead: null, merged: false, gone: false };
  if (missing) return base;
  const status = git(wt.path, 'status', '--porcelain');
  const dirty = status.ok && status.out ? status.out.split('\n').length : status.ok ? 0 : 1;
  const ahead = baseRef ? git(wt.path, 'rev-list', '--count', `${baseRef}..HEAD`) : { ok: false };
  const aheadN = ahead.ok ? Number(ahead.out) : null;
  return { ...base, dirty, ahead: aheadN, merged: aheadN === 0 || (aheadN > 0 && addsNothing(wt.path, baseRef)), gone: wt.branch ? upstreamGone(repo, wt.branch) : false };
}

/** Work that is not safe to forget: commits not in the base, or uncommitted files. */
export const hasOpenWork = (w) => w.dirty > 0 || (!w.merged && (w.ahead ?? 0) > 0);

/**
 * A worktree is stale when nothing in it would be lost: no uncommitted files, not locked, older than a day (a
 * fresh one may belong to a session just starting), and its work is in the base branch or its remote branch is gone.
 */
export function staleReason(w) {
  if (w.missing || w.locked || w.dirty > 0 || w.ageDays < 1) return null;
  if (w.merged) return w.branch ? `branch ${w.branch} is merged` : 'detached HEAD is merged';
  if (w.gone && w.ahead === 0) return `branch ${w.branch} is gone from the remote`;
  return null;
}

export function removeWorktree(repo, path) {
  return git(repo, 'worktree', 'remove', path);
}

export { canon };
