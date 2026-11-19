import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { after, before, describe, test } from 'node:test';
import { fileURLToPath } from 'node:url';
import { cachedSecrets, parseSecrets, resolveSecrets } from '../secrets.mjs';

const COS = join(realpathSync(join(fileURLToPath(import.meta.url), '..', '..')), 'cos.mjs');

let tmp;
let gh;
let ghLog;
let registry;
let cacheFile;
let project;

const calls = () => (existsSync(ghLog) ? readFileSync(ghLog, 'utf8').split('\n').filter(Boolean).length : 0);

before(() => {
  tmp = realpathSync(mkdtempSync(join(tmpdir(), 'secrets-cache-test-')));
  gh = join(tmp, 'gh');
  ghLog = join(tmp, 'gh.log');
  writeFileSync(gh, `#!/bin/sh\necho "$@" >> "${ghLog}"\n[ "$4" = "acme/broken" ] && { echo "HTTP 403: nope" >&2; exit 1; }\necho '[]'\n`);
  chmodSync(gh, 0o755);
  mkdirSync(join(tmp, 'app'));
  registry = join(tmp, 'projects.json');
  cacheFile = join(tmp, '.claude', 'secrets-cache.json');
  const secrets = [
    { name: 'BROKEN_KEY', where: 'github:acme/broken', required: true },
    { name: 'MISSING_KEY', where: 'github:acme/app', required: true },
  ];
  writeFileSync(registry, JSON.stringify({ projects: [{ id: 'app', name: 'App', what: 'x', checkouts: [join(tmp, 'app')], secrets }] }));
  project = { id: 'app', name: 'App', checkouts: [join(tmp, 'app')], secrets: parseSecrets(secrets, 'test') };
});
after(() => rmSync(tmp, { recursive: true, force: true }));

describe('the secrets cache', () => {
  test('unknown answers are cached with their reason, so a second run makes no CLI calls', () => {
    const now = Date.now();
    const first = resolveSecrets([project], { gh, cacheFile, now });
    const callsAfterFirst = calls();
    assert.ok(callsAfterFirst > 0);
    assert.equal(first[0].secrets[0].status, 'unknown');
    const second = resolveSecrets([project], { gh, cacheFile, now: now + 60_000 });
    assert.equal(calls(), callsAfterFirst, 'served from the cache');
    assert.equal(second[0].secrets[0].status, 'unknown');
    assert.match(second[0].secrets[0].reason, /gh failed: HTTP 403/);
    assert.equal(second[0].secrets[1].status, 'missing');
  });

  test('refresh and an expired cache both check again', () => {
    const before = calls();
    resolveSecrets([project], { gh, cacheFile, refresh: true });
    const afterRefresh = calls();
    assert.ok(afterRefresh > before);
    resolveSecrets([project], { gh, cacheFile, now: Date.now() + 31 * 60_000 });
    assert.ok(calls() > afterRefresh);
  });

  test('status --cached-secrets makes no CLI calls and still lists the missing secret', () => {
    resolveSecrets([project], { gh, cacheFile, refresh: true });
    const before = calls();
    const r = spawnSync(process.execPath, [COS, 'status', '--json', '--no-gh', '--cached-secrets', '--registry', registry], { env: { ...process.env, GH_BIN: gh }, encoding: 'utf8' });
    assert.equal(r.status, 0, r.stderr);
    assert.equal(calls(), before);
    const app = JSON.parse(r.stdout).projects.find((p) => p.id === 'app');
    assert.deepEqual(app.secrets.map((s) => s.status), ['unknown', 'missing']);
    assert.match(app.secrets[0].reason, /HTTP 403/);
    assert.ok(app.checkouts[0].attention.some((a) => a.message === 'missing secret MISSING_KEY (github:acme/app)'));
  });

  test('cachedSecrets with no cache file is all unknown and runs nothing', () => {
    const before = calls();
    const r = cachedSecrets([project], { cacheFile: join(tmp, 'none.json'), gh });
    assert.deepEqual(r[0].secrets.map((s) => s.status), ['unknown', 'unknown']);
    assert.equal(calls(), before);
  });
});
