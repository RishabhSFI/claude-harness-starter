import assert from 'node:assert/strict';
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { after, test } from 'node:test';

const { mergePr } = await import('../mc/actions.mjs');

const tmp = realpathSync(mkdtempSync(join(tmpdir(), 'mc-merge-')));
after(() => rmSync(tmp, { recursive: true, force: true }));

const GREEN = { state: 'OPEN', headRefOid: 'abc123', baseRefName: 'develop', isDraft: false, statusCheckRollup: [{ name: 'ci', conclusion: 'SUCCESS' }], mergeable: 'MERGEABLE', reviewDecision: null };

function setup(wikiBody) {
  const gh = join(tmp, 'gh');
  writeFileSync(gh, `#!/bin/sh\n[ "$2" = "view" ] && echo '${JSON.stringify(GREEN)}'\nexit 0\n`);
  chmodSync(gh, 0o755);
  const harnessDir = join(tmp, 'harness');
  mkdirSync(harnessDir, { recursive: true });
  writeFileSync(join(harnessDir, 'wiki.mjs'), wikiBody);
  const logFile = join(tmp, 'actions.log');
  rmSync(logFile, { force: true });
  return { ghBin: gh, harnessDir, logFile };
}

const args = () => ({
  projects: [{ id: 'alpha', name: 'Alpha', checkouts: [join(tmp, 'alpha')], public: { branches: ['main'], remotes: [], notes: [] }, repos: ['acme/alpha'] }],
  status: { projects: [{ id: 'alpha', checkouts: [{ defaultBranch: 'main' }] }] },
  poll: { at: new Date().toISOString(), error: null },
  repo: 'acme/alpha',
  number: 5,
});

test('the merge reply does not wait on a slow wiki record', async () => {
  const marker = join(tmp, 'record-finished');
  const ctx = setup(`setTimeout(async () => { (await import('node:fs')).writeFileSync(${JSON.stringify(marker)}, 'x'); process.exit(0); }, 1500);`);
  const started = Date.now();
  assert.deepEqual(await mergePr(ctx, args()), { ok: true });
  assert.ok(Date.now() - started < 1200, 'returned before the record finished');
  assert.equal(existsSync(marker), false);
});

test('a failing wiki record still returns ok and logs the outcome', async () => {
  const ctx = setup('process.exit(1);');
  assert.deepEqual(await mergePr(ctx, args()), { ok: true });
  for (let i = 0; i < 50 && !/wiki-record/.test(existsSync(ctx.logFile) ? readFileSync(ctx.logFile, 'utf8') : ''); i++) await new Promise((r) => setTimeout(r, 100));
  const log = readFileSync(ctx.logFile, 'utf8');
  assert.match(log, /"action":"merge"/);
  assert.match(log, /"action":"wiki-record".*"ok":false/);
});

test('the wiki record gets the same --registry the server reads', async () => {
  const argv = join(tmp, 'record-argv.json');
  const ctx = { ...setup(`(await import('node:fs')).writeFileSync(${JSON.stringify(argv)}, JSON.stringify(process.argv.slice(2)));`), registryFile: join(tmp, 'other-projects.json') };
  assert.deepEqual(await mergePr(ctx, args()), { ok: true });
  for (let i = 0; i < 50 && !existsSync(argv); i++) await new Promise((r) => setTimeout(r, 100));
  assert.deepEqual(JSON.parse(readFileSync(argv, 'utf8')), ['record', 'alpha', '--pr', 'acme/alpha#5', '--registry', join(tmp, 'other-projects.json')]);
});
