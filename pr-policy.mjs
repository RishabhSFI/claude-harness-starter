// What counts as a routine PR, and the review/steward markers the PR steward leaves in PR comments.
// Leaf module: cos-tools.mjs (pr-check), pr-sweep.mjs and walls.mjs all read it.
//
// Markers are the first line of a PR comment written by the owner's own gh login (comments by anyone else are ignored):
//   <!-- harness-review commit=<sha> base=<branch> verdict=pass|findings scope=pass|fail reviewer=<model> sig=<hmac> -->
//   <!-- harness-steward commit=<sha> try=<n> -->
// A review counts only for the commit and base branch it names, so a new push is reviewed again and an unchanged commit never is.
// The sig is an HMAC with a per-install key (~/.claude/harness-steward.key, made by `cos.mjs pr-marker`), so text a PR
// author or an injected comment pastes in is not a review. Without the key file no review verifies: nothing auto-merges.
// Residual limit: every session on this Mac runs as the owner's gh login and could call pr-marker itself.
import { createHmac, randomBytes } from 'node:crypto';
import { chmodSync, existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, join } from 'node:path';

export const keyFile = () => process.env.HARNESS_STEWARD_KEY_FILE || join(homedir(), '.claude', 'harness-steward.key');

/** The install's signing key. `create` makes it (mode 0600) when missing; otherwise a missing key is null. */
export function stewardKey({ create = false } = {}) {
  const f = keyFile();
  if (existsSync(f)) return readFileSync(f, 'utf8').trim() || null;
  if (!create) return null;
  mkdirSync(dirname(f), { recursive: true });
  writeFileSync(f, `${randomBytes(32).toString('hex')}\n`, { mode: 0o600 });
  chmodSync(f, 0o600);
  return readFileSync(f, 'utf8').trim();
}

const signed = (a, key) => createHmac('sha256', key).update(`review|${a.commit}|${a.base}|${a.verdict}|${a.scope}|${a.reviewer}`).digest('hex').slice(0, 32);

// global/CLAUDE.md "Size reviews": Opus for large or risky diffs (about 150 lines, or auth, money, data deletion or merge logic).
export const RISKY_LINES = 150;
export const RISKY_PATH = /auth|login|passw|secret|session|jwt|cookie|middleware|crypto|\.env|\brls\b|polic|permission|payment|billing|stripe|invoice|payout|refund|accounting|money|wallet|delete|purge|migration|\.sql$|merge/i;
// Paths that are not "risky" for the Opus rule but still need the owner's eye: CI, deploy and harness guard files.
const SENSITIVE_PATH = /(^|\/)\.(github|claude|husky)\/|(^|\/)AGENTS\.md|(^|\/)\.npmrc|(^|\/)\.mcp\.json|(^|\/)\.(codex|agents|cursor|vscode)\/|GEMINI\.md|CLAUDE\.local\.md|\.pnpmfile|\.pre-commit-config|\.gitlab-ci|(yarn|pnpm)-lock|requirements[^/]*\.txt|(^|\/)(Cargo\.(toml|lock)|go\.(mod|sum)|pyproject\.toml|poetry\.lock|uv\.lock|Pipfile(\.lock)?|Gemfile(\.lock)?|bun\.lockb?|\.cursorrules)$|(^|\/)Makefile|netlify\.toml|next\.config\.|(^|\/)supabase\/functions\/|vercel\.json|(^|\/)walls\.mjs|(^|\/)cos\.mjs|projects\.json|(^|\/)CLAUDE\.md|(^|\/)gate\.json|package(-lock)?\.json|Dockerfile/i;
const DOC_FILE = /\.(md|rst)$/i;
export const MAX_TRIES = 3;
const GH_FILE_CAP = 100;

/** Why a PR needs an Opus review, or null when a Sonnet review is enough. */
export function riskOf(pr, files) {
  const size = (Number(pr?.additions) || 0) + (Number(pr?.deletions) || 0);
  const paths = files.filter((f) => RISKY_PATH.test(f));
  const why = [];
  if (size >= RISKY_LINES) why.push(`${size} changed lines`);
  if (paths.length) why.push(`risky paths: ${paths.slice(0, 3).join(', ')}${paths.length > 3 ? ` (+${paths.length - 3})` : ''}`);
  return why.length ? why.join('; ') : null;
}

export const DEFAULT_APPROVAL = Object.freeze({ autoMerge: true, routineMaxLines: RISKY_LINES, riskyPaths: [] });

/** The project's approval policy from projects.json (`approval`), defaults filled in. Throws on a malformed entry. */
export function resolveApproval(raw) {
  if (raw == null) return { ...DEFAULT_APPROVAL, riskyPaths: [] };
  if (typeof raw !== 'object' || Array.isArray(raw)) throw new Error('approval must be an object');
  const bad = Object.keys(raw).filter((k) => !(k in DEFAULT_APPROVAL));
  if (bad.length) throw new Error(`approval has unknown key(s): ${bad.join(', ')}`);
  const a = { ...DEFAULT_APPROVAL, riskyPaths: [] };
  if ('autoMerge' in raw) {
    if (typeof raw.autoMerge !== 'boolean') throw new Error('approval.autoMerge must be true or false');
    a.autoMerge = raw.autoMerge;
  }
  if ('routineMaxLines' in raw) {
    // A project may only be stricter than the global 150-line rule.
    if (!Number.isInteger(raw.routineMaxLines) || raw.routineMaxLines < 0 || raw.routineMaxLines > RISKY_LINES) throw new Error(`approval.routineMaxLines must be a whole number from 0 to ${RISKY_LINES}`);
    a.routineMaxLines = raw.routineMaxLines;
  }
  if ('riskyPaths' in raw) {
    if (!Array.isArray(raw.riskyPaths) || raw.riskyPaths.some((s) => typeof s !== 'string' || !s)) throw new Error('approval.riskyPaths must be a list of regex strings');
    raw.riskyPaths.forEach((s) => new RegExp(s, 'i'));
    a.riskyPaths = [...raw.riskyPaths];
  }
  return a;
}

/**
 * "routine" or "needs you". Routine is docs only (no secrets or CI/deploy files), or under the line cap with no risky path.
 * @returns {{tier: 'routine' | 'needs you', why: string}}
 */
export function tierOf(pr, files, approval = DEFAULT_APPROVAL) {
  if (!files.length) return { tier: 'needs you', why: 'no changed files listed' };
  if (Number(pr?.changedFiles) > files.length) return { tier: 'needs you', why: `gh listed ${files.length} of ${pr.changedFiles} changed files, so the rest can't be checked` };
  if (files.length >= GH_FILE_CAP) return { tier: 'needs you', why: `${files.length} files listed; gh may cut the list at ${GH_FILE_CAP}, so it can't be checked` };
  const extra = approval.riskyPaths.map((s) => new RegExp(s, 'i'));
  const hits = (f, ...res) => res.some((re) => re.test(f));
  const sensitive = files.filter((f) => hits(f, SENSITIVE_PATH, ...extra));
  if (sensitive.length) return { tier: 'needs you', why: `sensitive path: ${sensitive.slice(0, 3).join(', ')}` };
  if (files.every((f) => DOC_FILE.test(f) && !/secret|\.env/i.test(f))) return { tier: 'routine', why: 'docs only' };
  const risky = files.filter((f) => RISKY_PATH.test(f));
  if (risky.length) return { tier: 'needs you', why: `risky path: ${risky.slice(0, 3).join(', ')}` };
  const size = (Number(pr?.additions) || 0) + (Number(pr?.deletions) || 0);
  if (size >= approval.routineMaxLines) return { tier: 'needs you', why: `${size} changed lines (routine is under ${approval.routineMaxLines})` };
  return { tier: 'routine', why: `${size} changed lines, no risky paths` };
}

// ---- markers ----

const REVIEW_MARK = /^<!--\s*harness-review\s+([^>]*?)\s*-->/;
const STEWARD_MARK = /^<!--\s*harness-steward\s+([^>]*?)\s*-->/;
const attrs = (s) => Object.fromEntries([...s.matchAll(/(\w+)=(\S+)/g)].map((m) => [m[1], m[2]]));

/** A comment counts only when its author is one of `trusted` (logins, case-insensitive). */
const trustedComments = (comments, trusted) => {
  const ok = new Set(trusted.map((t) => t.toLowerCase()));
  return (Array.isArray(comments) ? comments : []).filter((c) => ok.has(String(c?.author?.login ?? '').toLowerCase()) && typeof c.body === 'string');
};

/** Reviews of the PR, oldest first: {commit, verdict, scope, reviewer}. */
export function reviewsOf(comments, trusted) {
  const key = stewardKey();
  if (!key) return [];
  return trustedComments(comments, trusted)
    .map((c) => REVIEW_MARK.exec(c.body.trimStart()))
    .filter(Boolean)
    .map((m) => attrs(m[1]))
    .filter((a) => /^[0-9a-f]{7,40}$/i.test(a.commit ?? '') && a.sig === signed(a, key));
}

/** The review of exactly `head`, or null. Any findings or scope failure on that commit beats a pass, so a later pass can't erase them. */
export function reviewOfHead(comments, head, trusted, base = '') {
  const h = String(head ?? '').toLowerCase();
  if (!h) return null;
  const mine = reviewsOf(comments, trusted).filter((r) => r.commit.toLowerCase() === h && r.base === String(base));
  return mine.find((r) => !reviewClean(r)) ?? mine.at(-1) ?? null;
}

/** True when the newest review of `head` found nothing, on both the code and the scope review. */
export const reviewClean = (r) => !!r && r.verdict === 'pass' && r.scope === 'pass';

/** How many fix tries the steward has already spent on this PR. */
export function stewardTries(comments, trusted) {
  return trustedComments(comments, trusted).filter((c) => STEWARD_MARK.test(c.body.trimStart())).length;
}

export function reviewMarker({ commit, base, verdict, scope, reviewer }, key = stewardKey({ create: true })) {
  const a = { commit, base: String(base).replace(/\s+/g, ''), verdict, scope, reviewer: String(reviewer).replace(/\s+/g, '-') };
  return `<!-- harness-review commit=${a.commit} base=${a.base} verdict=${a.verdict} scope=${a.scope} reviewer=${a.reviewer} sig=${signed(a, key)} -->`;
}
export const stewardMarker = ({ commit, try: n }) => `<!-- harness-steward commit=${commit} try=${n} -->`;
