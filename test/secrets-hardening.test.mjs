import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, utimesSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { after, before, describe, test } from 'node:test';
import { fileURLToPath } from 'node:url';

const ROOT = realpathSync(join(fileURLToPath(import.meta.url), '..', '..'));
const COS = join(ROOT, 'cos.mjs');
const PLANTED = 'PLANTED_SECRET_VALUE_77c1';

let tmp;
let env;
const script = (file, body) => {
  writeFileSync(file, `#!/bin/sh\n${body}\n`);
  chmodSync(file, 0o755);
};

function cos(args, reg, extraEnv = {}) {
  const r = spawnSync(process.execPath, [COS, ...args, '--registry', reg], { env: { ...env, ...extraEnv }, encoding: 'utf8' });
  return { code: r.status, out: r.stdout, err: r.stderr, all: `${r.stdout}\n${r.stderr}` };
}

/** A registry in its own folder, so its cache file is its own. */
function registry(name, projects) {
  const dir = join(tmp, name);
  mkdirSync(dir, { recursive: true });
  const file = join(dir, 'projects.json');
  writeFileSync(file, JSON.stringify({ projects }));
  return file;
}

const project = (id, checkout, secrets) => ({ id, name: id, what: 'x', checkouts: [checkout], secrets });
const find = (r, id, name) => JSON.parse(r.out).projects.find((p) => p.id === id).secrets.find((s) => s.name === name);

before(() => {
  tmp = realpathSync(mkdtempSync(join(tmpdir(), 'secrets-hard-')));
  mkdirSync(join(tmp, 'home'));
  env = { HOME: join(tmp, 'home'), PATH: '/usr/bin:/bin', GH_BIN: join(tmp, 'gh'), VERCEL_BIN: join(tmp, 'vercel') };
  script(join(tmp, 'gh'), `echo x >> "${join(tmp, 'gh.count')}"\ncase "$1" in secret) echo '[{"name":"GH_HAVE"}]' ;; *) echo '[]' ;; esac`);
  script(join(tmp, 'vercel'), `echo "$*" >> "${join(tmp, 'vercel.args')}"\necho "NAME  VALUE\nVC_HAVE  ${PLANTED}"`);
});
after(() => rmSync(tmp, { recursive: true, force: true }));

describe('local files', () => {
  test('a directory where the file should be is unknown, not a crash', () => {
    const co = join(tmp, 'dirco');
    mkdirSync(join(co, '.env'), { recursive: true });
    const reg = registry('dirreg', [project('d', co, [{ name: 'K', where: 'local:.env' }])]);
    for (const args of [['status', '--json', '--no-gh'], ['secrets', '--json']]) {
      const r = cos(args, reg);
      assert.equal(r.code, 0, r.err);
      const s = args[0] === 'secrets' ? find(r, 'd', 'K') : JSON.parse(r.out).projects.find((p) => p.id === 'd').secrets[0];
      assert.equal(s.status, 'unknown');
      assert.match(s.reason, /could not read .*\.env: EISDIR/);
    }
  });

  test('a checkout that is not on this machine is unknown, not missing', () => {
    const reg = registry('gonereg', [project('g', join(tmp, 'no-such-checkout'), [{ name: 'K', where: 'local:.env' }])]);
    const s = find(cos(['secrets', '--json'], reg), 'g', 'K');
    assert.equal(s.status, 'unknown');
    assert.match(s.reason, /checkout .*no-such-checkout is not on this machine/);
  });

  test('~ and .. paths are rejected with the where grammar', () => {
    for (const where of ['local:~/.env', 'local:../other/.env', 'local:a/../../b']) {
      const reg = registry('badlocal', [project('b', tmp, [{ name: 'K', where }])]);
      const r = cos(['status', '--no-gh'], reg);
      assert.equal(r.code, 1, where);
      assert.match(r.err, /bad secret location .*use github:/, where);
    }
  });
});

describe('vercel', () => {
  const linked = (name, projectName = 'site') => {
    const co = join(tmp, name);
    mkdirSync(join(co, '.vercel'), { recursive: true });
    writeFileSync(join(co, '.vercel', 'project.json'), JSON.stringify(projectName ? { projectName } : { projectId: 'prj_1' }));
    return co;
  };

  test('uses --environment and the declared environment', () => {
    rmSync(join(tmp, 'vercel.args'), { force: true });
    const reg = registry('envreg', [project('e', linked('envco'), [{ name: 'VC_HAVE', where: 'vercel:site:preview' }])]);
    assert.equal(find(cos(['secrets', '--json'], reg), 'e', 'VC_HAVE').status, 'present');
    assert.equal(readFileSync(join(tmp, 'vercel.args'), 'utf8').trim(), 'env ls --environment preview');
  });

  test('an empty project (message on stderr) makes required names missing', () => {
    const bin = join(tmp, 'vercel-empty');
    script(bin, `echo "Vercel CLI 65.0.0" >&2\necho "No Environment Variables found for site" >&2`);
    const reg = registry('emptyreg', [project('m', linked('emptyco'), [{ name: 'K', where: 'vercel:site' }])]);
    const s = find(cos(['secrets', '--json'], reg, { VERCEL_BIN: bin }), 'm', 'K');
    assert.equal(s.status, 'missing');
  });

  test('a failure reason is the Error line, not the banner, and never stdout', () => {
    const bin = join(tmp, 'vercel-fail');
    script(bin, `echo "stdout ${PLANTED}"\necho "Vercel CLI 65.0.0" >&2\necho "Error: Not authorized" >&2\necho "trailing hint" >&2\nexit 1`);
    const reg = registry('failreg', [project('f', linked('failco'), [{ name: 'K', where: 'vercel:site' }])]);
    const r = cos(['secrets', '--json'], reg, { VERCEL_BIN: bin });
    const s = find(r, 'f', 'K');
    assert.equal(s.status, 'unknown');
    assert.match(s.reason, /vercel-fail failed: Error: Not authorized$/);
    assert.doesNotMatch(r.all, new RegExp(PLANTED));
  });

  test('the last stderr line is the reason when there is no Error line', () => {
    const bin = join(tmp, 'vercel-fail2');
    script(bin, `echo "Vercel CLI 65.0.0" >&2\necho "the token expired" >&2\nexit 1`);
    const reg = registry('fail2reg', [project('f2', linked('fail2co'), [{ name: 'K', where: 'vercel:site' }])]);
    assert.match(find(cos(['secrets', '--json'], reg, { VERCEL_BIN: bin }), 'f2', 'K').reason, /failed: the token expired$/);
  });

  test('a link without projectName is not a match and the reason says to re-run vercel link', () => {
    const reg = registry('unnamedreg', [project('u', linked('unnamedco', null), [{ name: 'K', where: 'vercel:site' }])]);
    const s = find(cos(['secrets', '--json'], reg), 'u', 'K');
    assert.equal(s.status, 'unknown');
    assert.match(s.reason, /does not name its project; re-run `vercel link`/);
  });

  test('of several cached npx installs the newest vercel binary wins', () => {
    const home = join(tmp, 'npxhome');
    for (const [dir, secondsOld] of [['aaa', 0], ['zzz', 5000]]) {
      const bin = join(home, '.npm/_npx', dir, 'node_modules/.bin/vercel');
      mkdirSync(join(bin, '..'), { recursive: true });
      script(bin, `echo "NAME VALUE"\necho "${dir === 'zzz' ? 'OLD_ONE' : 'NEW_ONE'} x"`);
      const t = new Date(Date.now() - secondsOld * 1000);
      utimesSync(bin, t, t);
    }
    const reg = registry('npxreg', [project('n', linked('npxco'), [{ name: 'NEW_ONE', where: 'vercel:site' }])]);
    const r = cos(['secrets', '--json'], reg, { HOME: home, VERCEL_BIN: '' });
    assert.equal(find(r, 'n', 'NEW_ONE').status, 'present');
  });
});

describe('status cache', () => {
  const ghCount = () => (existsSync(join(tmp, 'gh.count')) ? readFileSync(join(tmp, 'gh.count'), 'utf8').trim().split('\n').length : 0);

  test('status reuses fresh online results, secrets always refreshes', () => {
    const reg = registry('cachereg', [project('c', tmp, [{ name: 'GH_HAVE', where: 'github:acme/app' }, { name: 'GH_GONE', where: 'github:acme/app' }, { name: 'L', where: 'local:.nothing' }])]);
    rmSync(join(tmp, 'gh.count'), { force: true });
    const first = cos(['status', '--json'], reg);
    const afterFirst = ghCount();
    assert.ok(afterFirst > 0);
    const second = cos(['status', '--json'], reg);
    assert.equal(ghCount(), afterFirst, 'second status made no gh calls');
    assert.deepEqual(JSON.parse(second.out).projects.find((p) => p.id === 'c').secrets, JSON.parse(first.out).projects.find((p) => p.id === 'c').secrets);
    const messages = JSON.parse(second.out).projects.find((p) => p.id === 'c').checkouts[0].attention.map((a) => a.message);
    assert.ok(messages.includes('missing secret GH_GONE (github:acme/app)'));

    cos(['secrets'], reg);
    assert.equal(ghCount(), afterFirst * 2, 'cos secrets checked fresh');
    cos(['status', '--json'], reg);
    assert.equal(ghCount(), afterFirst * 2, 'and refreshed the cache');
  });

  test('the cache holds names and statuses only, and --no-gh ignores it', () => {
    const reg = registry('cachereg2', [project('c2', tmp, [{ name: 'GH_GONE', where: 'github:acme/app' }])]);
    cos(['status', '--no-gh'], reg);
    assert.equal(existsSync(join(tmp, 'cachereg2', '.claude', 'secrets-cache.json')), false, 'offline writes nothing');
    cos(['status'], reg);
    const cache = readFileSync(join(tmp, 'cachereg2', '.claude', 'secrets-cache.json'), 'utf8');
    assert.doesNotMatch(cache, new RegExp(PLANTED));
    assert.match(cache, /GH_GONE/);
    const offline = JSON.parse(cos(['status', '--json', '--no-gh'], reg).out).projects.find((p) => p.id === 'c2');
    assert.equal(offline.secrets[0].status, 'unknown');
  });

  test('a changed inventory is checked again', () => {
    const co = tmp;
    const reg = registry('cachereg3', [project('c3', co, [{ name: 'GH_HAVE', where: 'github:acme/app' }])]);
    cos(['status'], reg);
    const n = ghCount();
    writeFileSync(reg, JSON.stringify({ projects: [project('c3', co, [{ name: 'GH_HAVE', where: 'github:acme/app' }, { name: 'NEW_ONE', where: 'github:acme/app' }])] }));
    cos(['status'], reg);
    assert.ok(ghCount() > n);
  });
});
