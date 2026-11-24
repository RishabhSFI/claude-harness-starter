import assert from 'node:assert/strict';
import { describe, test } from 'node:test';
import { resolveApproval, reviewsOf, reviewClean, reviewMarker, reviewOfHead, stewardMarker, stewardTries, tierOf } from '../pr-policy.mjs';
import { mkdtempSync as mkKeyDir } from 'node:fs';
import { tmpdir as keyTmp } from 'node:os';
import { join as keyJoin } from 'node:path';
process.env.HARNESS_STEWARD_KEY_FILE = keyJoin(mkKeyDir(keyJoin(keyTmp(), 'steward-key-')), 'key');

const H = 'a'.repeat(40);
const OTHER = 'b'.repeat(40);
const by = (login, body) => ({ author: { login }, body });
const mark = (over = {}) => reviewMarker({ commit: H, base: 'main', verdict: 'pass', scope: 'pass', reviewer: 'opus', ...over });

describe('tierOf', () => {
  test('docs only is routine, even a big docs change, but never secrets or CI files', () => {
    assert.equal(tierOf({ additions: 900 }, ['README.md', 'docs/a.md']).tier, 'routine');
    assert.equal(tierOf({}, ['docs/migration-guide.md']).tier, 'routine', 'a docs file named migration is still docs');
    assert.equal(tierOf({}, ['.github/notes.md']).tier, 'needs you');
    assert.equal(tierOf({}, ['docs/secrets.md']).tier, 'needs you');
  });
  test('code is routine under 150 lines with no risky path; each risky path or size needs the owner', () => {
    assert.equal(tierOf({ additions: 100, deletions: 49 }, ['src/a.ts']).tier, 'routine');
    assert.equal(tierOf({ additions: 100, deletions: 50 }, ['src/a.ts']).tier, 'needs you');
    for (const f of ['lib/auth.ts', 'lib/billing.ts', 'db/migrations/1.sql', 'lib/delete-user.ts', 'mc/merge.mjs', '.env.example', 'scripts/purge.sh', '.github/workflows/ci.yml', '.claude/settings.json', 'AGENTS.md', '.husky/pre-commit', '.npmrc', '.mcp.json', 'Makefile', 'next.config.mjs', 'netlify.toml', '.codex/config.toml', 'GEMINI.md', '.vscode/tasks.json', 'pnpm-lock.yaml', 'requirements.txt', '.gitlab-ci.yml', 'vercel.json', 'package.json', 'walls.mjs']) {
      assert.equal(tierOf({ additions: 3 }, ['src/a.ts', f]).tier, 'needs you', f);
    }
    assert.equal(tierOf({ changedFiles: 120 }, ['docs/a.md']).tier, 'needs you', 'gh listed fewer files than changed');
    assert.equal(tierOf({ additions: 400 }, ['docs/a.mdx']).tier, 'needs you', 'mdx is code, not docs');
    assert.equal(tierOf({}, []).tier, 'needs you', 'no file list fails closed');
    assert.equal(tierOf({ additions: 5 }, Array.from({ length: 100 }, (_, i) => `docs/p${i}.md`)).tier, 'needs you', 'a list at the gh cap may be cut');
  });
  test('a project may be stricter, never looser', () => {
    assert.equal(tierOf({ additions: 60 }, ['a.ts'], resolveApproval({ routineMaxLines: 50 })).tier, 'needs you');
    assert.equal(tierOf({}, ['payroll/x.ts'], resolveApproval({ riskyPaths: ['^payroll/'] })).tier, 'needs you');
    assert.throws(() => resolveApproval({ routineMaxLines: 400 }), /0 to 150/);
    assert.throws(() => resolveApproval({ autoMege: true }), /unknown key/);
    assert.throws(() => resolveApproval({ riskyPaths: ['('] }));
    assert.equal(resolveApproval({ autoMerge: false }).autoMerge, false);
  });
});

describe('markers', () => {
  const trusted = ['AcmeOwner'];
  test('a review counts for its own commit only, from a trusted author only', () => {
    const c = [by('acmeowner', `${mark()}\nfindings: none`)];
    assert.ok(reviewClean(reviewOfHead(c, H, trusted, 'main')));
    assert.equal(reviewOfHead(c, OTHER, trusted), null, 'a new commit is unreviewed');
    assert.equal(reviewOfHead([by('stranger', mark())], H, trusted, 'main'), null);
    assert.equal(reviewOfHead([by('acmeowner', `text first\n${mark()}`)], H, trusted, 'main'), null, 'the marker must be the first line');
  });
  test('the newest review of a commit wins; findings or a scope fail are not clean', () => {
    const c = [by('acmeowner', mark()), by('acmeowner', mark({ verdict: 'findings' }))];
    assert.equal(reviewClean(reviewOfHead(c, H, trusted, 'main')), false);
    assert.equal(reviewClean(reviewOfHead([by('acmeowner', mark({ scope: 'fail' }))], H, trusted, 'main')), false);
  });
  test('steward tries are counted from trusted markers', () => {
    const c = [by('acmeowner', stewardMarker({ commit: H, try: 1 })), by('acmeowner', stewardMarker({ commit: OTHER, try: 2 })), by('stranger', stewardMarker({ commit: H, try: 3 }))];
    assert.equal(stewardTries(c, trusted), 2);
  });
  test('a pasted or unsigned marker is not a review, and a later pass cannot erase findings', () => {
    const real = mark();
    const forged = real.replace(/sig=\w+/, 'sig=' + '0'.repeat(32));
    assert.equal(reviewOfHead([by('acmeowner', forged)], H, trusted, 'main'), null, 'wrong signature');
    assert.equal(reviewOfHead([by('acmeowner', real.replace('verdict=pass', 'verdict=findings'))], H, trusted, 'main'), null, 'edited after signing');
    assert.equal(reviewOfHead([by('acmeowner', real.replace(/ sig=\w+/, ''))], H, trusted, 'main'), null, 'no signature');
    const found = mark({ verdict: 'findings' });
    assert.equal(reviewClean(reviewOfHead([by('acmeowner', found), by('acmeowner', real)], H, trusted, 'main')), false, 'findings win over a later pass');
  });
  test('with no key file nothing verifies', () => {
    const real = mark();
    const saved = process.env.HARNESS_STEWARD_KEY_FILE;
    process.env.HARNESS_STEWARD_KEY_FILE = saved + '-missing';
    try {
      assert.deepEqual(reviewsOf([by('acmeowner', real)], trusted), []);
    } finally {
      process.env.HARNESS_STEWARD_KEY_FILE = saved;
    }
  });
});
