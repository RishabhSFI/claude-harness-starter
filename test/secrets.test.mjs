import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { chmodSync, cpSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { after, before, describe, test } from 'node:test';
import { fileURLToPath } from 'node:url';

const ROOT = realpathSync(join(fileURLToPath(import.meta.url), '..', '..'));
const COS = join(ROOT, 'cos.mjs');
const WIKI = join(ROOT, 'wiki.mjs');
const PLANTED = 'PLANTED_SECRET_VALUE_9f3a';

let tmp;
let home;
let registry;
let env;
let vercelLog;
const dirs = {};

const script = (file, body) => {
  writeFileSync(file, `#!/bin/sh\n${body}\n`);
  chmodSync(file, 0o755);
};

function cos(args, extraEnv = {}, reg = registry) {
  const r = spawnSync(process.execPath, [COS, ...args, '--registry', reg], { env: { ...env, ...extraEnv }, encoding: 'utf8' });
  return { code: r.status, out: r.stdout, err: r.stderr, all: `${r.stdout}\n${r.stderr}` };
}

before(() => {
  tmp = realpathSync(mkdtempSync(join(tmpdir(), 'secrets-test-')));
  home = join(tmp, 'home');
  mkdirSync(home);
  dirs.alpha = join(tmp, 'alpha');
  dirs.beta = join(tmp, 'beta');
  mkdirSync(join(dirs.alpha, '.vercel'), { recursive: true });
  mkdirSync(dirs.beta);
  writeFileSync(join(dirs.alpha, '.vercel', 'project.json'), JSON.stringify({ projectName: 'alpha-site' }));
  writeFileSync(join(dirs.alpha, '.env'), `# comment\n\nLOCAL_HAVE=${PLANTED}\nexport LOCAL_EXPORTED=${PLANTED}\n`);

  vercelLog = join(tmp, 'vercel.log');
  script(join(tmp, 'gh'), `
[ "$4" = "acme/broken" ] && { echo "HTTP 403: nope" >&2; exit 1; }
case "$1" in
  secret) echo '[{"name":"GH_HAVE","value":"${PLANTED}"}]' ;;
  variable) echo '[{"name":"GH_VAR","value":"${PLANTED}"}]' ;;
esac`);
  script(join(tmp, 'vercel'), `
echo "$(pwd) $*" >> "${vercelLog}"
echo "Retrieving project ${PLANTED}" >&2
echo "> Environment Variables found"
echo "name        value       environments   created"
echo "VC_HAVE     Encrypted   Production     1d ago"
echo "VC_LEAK     ${PLANTED}  Production     1d ago"`);

  env = { HOME: home, PATH: '/usr/bin:/bin', GH_BIN: join(tmp, 'gh'), VERCEL_BIN: join(tmp, 'vercel') };

  registry = join(tmp, 'projects.json');
  writeFileSync(
    registry,
    JSON.stringify({
      projects: [
        {
          id: 'alpha',
          name: 'Alpha',
          what: 'First.',
          checkouts: [dirs.alpha],
          secrets: [
            { name: 'GH_MISSING', where: 'github:acme/app', purpose: 'the nightly sync', required: true },
            { name: 'GH_HAVE', where: 'github:acme/app', purpose: 'deploys', required: true },
            { name: 'GH_VAR', where: 'github:acme/app', purpose: 'a variable', required: true },
            { name: 'GH_OPTIONAL', where: 'github:acme/app', purpose: 'extra alerts', required: false },
            { name: 'VC_MISSING', where: 'vercel:alpha-site', purpose: 'contact form email', required: true },
            { name: 'VC_HAVE', where: 'vercel:alpha-site', purpose: 'database', required: true },
            { name: 'LOCAL_HAVE', where: 'local:.env', purpose: 'dev server', required: true },
            { name: 'LOCAL_EXPORTED', where: 'local:.env', purpose: 'dev server', required: true },
            { name: 'LOCAL_MISSING', where: 'local:.env', purpose: 'dev emails', required: true },
          ],
        },
        {
          id: 'beta',
          name: 'Beta',
          what: 'Second.',
          checkouts: [dirs.beta],
          secrets: [
            { name: 'BETA_KEY', where: 'github:acme/broken', purpose: 'billing', required: true },
            { name: 'BETA_UNLINKED', where: 'vercel:beta-site', purpose: 'forms', required: true },
          ],
        },
        { id: 'plain', name: 'Plain', what: 'No secrets.', checkouts: [dirs.beta] },
      ],
    }),
  );
});

after(() => rmSync(tmp, { recursive: true, force: true }));

describe('secrets', () => {
  let r;
  before(() => {
    r = cos(['secrets']);
  });

  test('exits 0 and reports a missing required secret with its feature and add command', () => {
    assert.equal(r.code, 0, r.err);
    const block = r.out.split('# Missing, optional')[0];
    assert.match(block, /\*\*Alpha\*\*: GH_MISSING \(github:acme\/app\)/);
    assert.match(block, /Breaks: the nightly sync/);
    assert.match(block, new RegExp(`Add it: ${join(tmp, 'gh').replace(/[.*+?^${}()|[\]\\]/g, '\\$&')} secret set GH_MISSING -R acme/app`));
    assert.match(block, /Add it: cd .*alpha && vercel env add VC_MISSING production/);
    assert.match(block, new RegExp(`Add it: add LOCAL_MISSING=\\.\\.\\. to ${join(dirs.alpha, '.env')}`));
  });

  test('present secrets (gh secret, gh variable, vercel, .env with export) are not reported missing', () => {
    for (const name of ['GH_HAVE', 'GH_VAR', 'VC_HAVE', 'LOCAL_HAVE', 'LOCAL_EXPORTED']) {
      assert.doesNotMatch(r.out, new RegExp(`: ${name} \\(`), name);
    }
    assert.match(r.out, /5 present of 11 declared\./);
  });

  test('optional missing secrets are in their own section', () => {
    const optional = r.out.split('# Missing, optional')[1].split("# Can't check")[0];
    assert.match(optional, /GH_OPTIONAL/);
    assert.doesNotMatch(r.out.split('# Missing, optional')[0], /GH_OPTIONAL/);
  });

  test("a failing gh and an unlinked vercel project are \"can't check\" with a reason", () => {
    const unknown = r.out.split("# Can't check")[1];
    assert.match(unknown, /BETA_KEY[\s\S]*Why: gh failed: HTTP 403/);
    assert.match(unknown, /BETA_UNLINKED[\s\S]*Why: no checkout is linked to Vercel project beta-site/);
  });

  test('vercel runs in the linked checkout with the default environment', () => {
    assert.match(readFileSync(vercelLog, 'utf8'), new RegExp(`^${dirs.alpha} env ls --environment production$`, 'm'));
  });

  test('a missing vercel CLI is "can\'t check"', () => {
    const none = cos(['secrets', '--json'], { VERCEL_BIN: join(tmp, 'no-such-vercel') });
    const alpha = JSON.parse(none.out).projects.find((p) => p.id === 'alpha');
    const vc = alpha.secrets.find((s) => s.name === 'VC_MISSING');
    assert.equal(vc.status, 'unknown');
    assert.match(vc.reason, /vercel CLI is not installed/);
  });

  test('--json has statuses, reasons and a summary', () => {
    const j = JSON.parse(cos(['secrets', '--json']).out);
    const alpha = j.projects.find((p) => p.id === 'alpha');
    assert.equal(alpha.secrets.find((s) => s.name === 'GH_HAVE').status, 'present');
    assert.equal(alpha.secrets.find((s) => s.name === 'GH_MISSING').status, 'missing');
    assert.deepEqual(j.summary, { present: 5, missing: 4, unknown: 2 });
  });

  test('no planted value reaches any output', () => {
    for (const args of [['secrets'], ['secrets', '--json'], ['status'], ['status', '--json'], ['status', '--no-gh'], ['status', '--json', '--no-gh']]) {
      const out = cos(args);
      assert.doesNotMatch(out.all, new RegExp(PLANTED), args.join(' '));
    }
  });
});

describe('status', () => {
  test('Needs you lists missing required secrets by name, not optional or unknown ones', () => {
    const r = cos(['status']);
    assert.equal(r.code, 0, r.err);
    const needs = r.out.split('# Needs you')[1].split('\n## ')[0];
    assert.match(needs, /\*\*Alpha\*\*.*missing secret GH_MISSING \(github:acme\/app\)/);
    assert.match(needs, /missing secret VC_MISSING \(vercel:alpha-site\)/);
    assert.match(needs, /missing secret LOCAL_MISSING \(local:\.env\)/);
    assert.doesNotMatch(needs, /GH_OPTIONAL|BETA_KEY|GH_HAVE/);
  });

  test('--no-gh checks only local files and never runs gh or vercel', () => {
    writeFileSync(vercelLog, '');
    const r = cos(['status', '--json', '--no-gh'], { GH_BIN: '/nonexistent/gh' });
    assert.equal(r.code, 0, r.err);
    assert.equal(readFileSync(vercelLog, 'utf8'), '');
    const alpha = JSON.parse(r.out).projects.find((p) => p.id === 'alpha');
    const messages = alpha.checkouts[0].attention.map((a) => a.message);
    assert.ok(messages.includes('missing secret LOCAL_MISSING (local:.env)'));
    assert.ok(!messages.some((m) => /GH_MISSING|VC_MISSING/.test(m)));
    assert.equal(alpha.secrets.find((s) => s.name === 'GH_MISSING').status, 'unknown');
  });

  test('projects without secrets keep their old shape', () => {
    const plain = JSON.parse(cos(['status', '--json', '--no-gh']).out).projects.find((p) => p.id === 'plain');
    assert.equal('secrets' in plain, false);
  });
});

describe('registry', () => {
  test('a bad where is a clear error', () => {
    const bad = join(tmp, 'bad.json');
    writeFileSync(bad, JSON.stringify({ projects: [{ id: 'x', name: 'X', checkouts: [], secrets: [{ name: 'K', where: 'ftp:somewhere' }] }] }));
    const r = cos(['status', '--no-gh'], {}, bad);
    assert.equal(r.code, 1);
    assert.match(r.err, /secrets\[0\] \(K\): bad secret location "ftp:somewhere"/);
  });
});

describe('--write-page', () => {
  test('writes an inventory page that lints clean and holds no values', () => {
    const harness = join(tmp, 'harness');
    mkdirSync(harness);
    cpSync(join(ROOT, 'starter-wiki'), join(harness, 'wiki'), { recursive: true });
    const real = { projects: [{ id: 'alpha', name: 'Alpha', what: 'A made-up project.', checkouts: [] }] };
    real.projects[0].secrets = [
      { name: 'SMTP_PASSWORD', where: 'github:acme/app', purpose: 'order emails | receipts', required: true },
      { name: 'LOCAL_HAVE', where: 'local:.env', purpose: 'dev', required: false },
    ];
    const reg = join(harness, 'projects.json');
    writeFileSync(reg, JSON.stringify(real));
    const made = spawnSync(process.execPath, [WIKI, 'new-page', 'alpha', '--wiki', join(harness, 'wiki'), '--registry', reg], { encoding: 'utf8' });
    assert.equal(made.status, 0, made.stderr);
    const w = cos(['secrets', '--write-page'], {}, reg);
    assert.equal(w.code, 0, w.err);
    const page = readFileSync(join(harness, 'wiki', 'topics', 'secrets.md'), 'utf8');
    assert.match(page, /^---\nupdated: \d{4}-\d{2}-\d{2}\nsources:\n {2}- "projects\.json"\ntags: \[topic, secrets\]\n---/);
    assert.match(page, new RegExp(`## \\[\\[projects/${real.projects[0].id}\\]\\]`));
    assert.match(page, /\| SMTP_PASSWORD \| github:acme\/app \| order emails \/ receipts \| yes \|/);
    assert.doesNotMatch(page, new RegExp(PLANTED));
    assert.match(cos(['secrets', '--write-page'], {}, reg).out, /^unchanged/);
    const lint = spawnSync(process.execPath, [WIKI, 'lint', '--wiki', join(harness, 'wiki'), '--registry', reg], { encoding: 'utf8' });
    assert.equal(lint.status, 0, lint.stdout);
    assert.doesNotMatch(lint.stdout, /secrets\.md.*(broken|frontmatter)/);
  });
});

test('a missing repo variable gets a gh variable set command', () => {
  const reg = join(tmp, 'vars.json');
  writeFileSync(
    reg,
    JSON.stringify({
      projects: [
        {
          id: 'gamma',
          name: 'Gamma',
          what: 'Vars.',
          checkouts: [dirs.beta],
          secrets: [
            { name: 'SOME_VAR', where: 'github:acme/app', purpose: 'a toggle', required: true, variable: true },
            { name: 'SOME_SECRET', where: 'github:acme/app', purpose: 'a key', required: true },
          ],
        },
      ],
    }),
  );
  const r = cos(['secrets'], {}, reg);
  assert.match(r.out, /gh variable set SOME_VAR -R acme\/app/);
  assert.match(r.out, /gh secret set SOME_SECRET -R acme\/app/);
});
