import assert from 'node:assert/strict';
import { execFileSync, spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { after, before, describe, test } from 'node:test';
import { fileURLToPath } from 'node:url';

const ROOT = realpathSync(join(fileURLToPath(import.meta.url), '..', '..'));
const COS = join(ROOT, 'cos.mjs');
const GIT_ENV = {
  ...process.env,
  GIT_AUTHOR_NAME: 't',
  GIT_AUTHOR_EMAIL: 't@example.com',
  GIT_COMMITTER_NAME: 't',
  GIT_COMMITTER_EMAIL: 't@example.com',
  GIT_CONFIG_GLOBAL: '/dev/null',
  GIT_CONFIG_SYSTEM: '/dev/null',
};

let tmp;
before(() => {
  tmp = realpathSync(mkdtempSync(join(tmpdir(), 'cos-retire-')));
});
after(() => rmSync(tmp, { recursive: true, force: true }));

const project = (id, name, aliases = []) => ({ id, name, what: 'x', checkouts: [join(tmp, id)], aliases, keywords: [], public: { branches: ['main'], remotes: [], notes: [] }, repos: [], site: null, secrets: [] });

function registryWith(name, data) {
  const file = join(tmp, `${name}.json`);
  writeFileSync(file, `${JSON.stringify(data, null, 2)}\n`);
  return file;
}

function cos(args, registry, env = {}) {
  const r = spawnSync('node', [COS, ...args, '--registry', registry], { env: { ...GIT_ENV, ...env }, encoding: 'utf8' });
  return { code: r.status, out: r.stdout, err: r.stderr };
}

const read = (file) => JSON.parse(readFileSync(file, 'utf8'));
const TODAY = /^\d{4}-\d{2}-\d{2}$/;

describe('cos retire', () => {
  test('moves the entry to retired, stamps the date, and keeps the file format', () => {
    const reg = registryWith('move', { projects: [project('zeta', 'Zeta Quiz', ['zeta game']), project('keep', 'Keeper')] });
    const r = cos(['retire', 'zeta'], reg);
    assert.equal(r.code, 0, r.err);
    const data = read(reg);
    assert.deepEqual(data.projects.map((p) => p.id), ['keep']);
    assert.equal(data.retired[0].id, 'zeta');
    assert.match(data.retired[0].retiredOn, TODAY);
    assert.equal(readFileSync(reg, 'utf8'), `${JSON.stringify(data, null, 2)}\n`);
  });

  test('accepts an alias, and a rerun is a no-op that says so', () => {
    const reg = registryWith('alias', { projects: [project('zeta', 'Zeta Quiz', ['zeta game'])] });
    assert.equal(cos(['retire', 'Zeta Game'], reg).code, 0);
    const once = readFileSync(reg, 'utf8');
    const again = cos(['retire', 'zeta'], reg);
    assert.equal(again.code, 0);
    assert.match(again.out, /Zeta Quiz is already retired\./);
    assert.equal(readFileSync(reg, 'utf8'), once);
  });

  test('an unknown id refuses and names the known ids', () => {
    const reg = registryWith('unknown', { projects: [project('one', 'One'), project('two', 'Two')] });
    const before = readFileSync(reg, 'utf8');
    const r = cos(['retire', 'nope'], reg);
    assert.equal(r.code, 1);
    assert.match(r.err, /Known ids: one, two/);
    assert.equal(readFileSync(reg, 'utf8'), before);
  });

  test('an exact id wins over another project\'s alias', () => {
    const reg = registryWith('idfirst', { projects: [project('zeta', 'Zeta'), project('other', 'Other', ['zeta'])] });
    assert.equal(cos(['retire', 'zeta'], reg).code, 0);
    assert.deepEqual(read(reg).projects.map((p) => p.id), ['other']);
  });

  test('an alias shared by two projects, active or retired, refuses', () => {
    const reg = registryWith('ambig', { projects: [project('a', 'A', ['shared']), project('b', 'B', ['shared'])] });
    const before = readFileSync(reg, 'utf8');
    const r = cos(['retire', 'shared'], reg);
    assert.equal(r.code, 1);
    assert.match(r.err, /more than one project \(a, b\)/);
    assert.equal(readFileSync(reg, 'utf8'), before);
    const mixed = registryWith('ambig2', { projects: [project('a', 'A', ['shared'])], retired: [{ ...project('b', 'B', ['shared']), retiredOn: '2026-11-06' }] });
    assert.equal(cos(['retire', 'shared'], mixed).code, 1);
  });

  test('ids that differ only by case across the lists are a registry error', () => {
    const reg = registryWith('case', { projects: [project('Zeta', 'Zeta')], retired: [project('zeta', 'Zeta')] });
    assert.match(cos(['status', '--no-gh'], reg).err, /both projects and retired/);
  });

  test('status, route and secrets skip a retired project; route says it is retired', () => {
    const reg = registryWith('skip', { projects: [project('keep', 'Keeper')], retired: [{ ...project('zeta', 'Zeta Quiz', ['zeta game']), retiredOn: '2026-11-06' }] });
    assert.deepEqual(JSON.parse(cos(['status', '--json', '--no-gh'], reg).out).projects.map((p) => p.id), ['keep']);
    assert.match(cos(['route', 'fix the zeta game'], reg).out, /Zeta Quiz is retired \(projects\.json `retired`\)/);
    const routed = JSON.parse(cos(['route', '--json', 'fix the zeta game'], reg).out);
    assert.equal(routed.match, null);
    assert.equal(routed.retired, 'zeta');
    assert.match(cos(['route', 'work on keeper'], reg).out, /^keep\t/);
    assert.doesNotMatch(cos(['secrets'], reg).out, /zeta/i);
  });

  test('an id in both lists is a registry error', () => {
    const reg = registryWith('dupe', { projects: [project('zeta', 'Zeta')], retired: [project('zeta', 'Zeta')] });
    const r = cos(['status', '--no-gh'], reg);
    assert.equal(r.code, 1);
    assert.match(r.err, /both projects and retired/);
  });

  test('new refuses an id that is retired', () => {
    const reg = registryWith('taken', { projects: [], retired: [project('zeta', 'Zeta')] });
    const r = spawnSync('node', [COS, 'new', 'zeta', '--what', 'x', '--root', join(tmp, 'roots'), '--registry', reg], { env: GIT_ENV, encoding: 'utf8' });
    assert.equal(r.status, 2);
    assert.match(r.stderr, /already registered/);
  });

  test('the starter leak scan still catches a retired project', { skip: !existsSync(join(ROOT, 'make-starter.mjs')) && 'the starter does not ship the generator' }, () => {
    const src = mkdtempSync(join(tmp, 'src-'));
    const files = { 'starter/README.md': '# Harness\n', 'notes.md': 'We shipped the Quuxbazzle app.\n', 'projects.json': '{"projects": [], "retired": []}\n' };
    for (const [path, text] of Object.entries(files)) {
      mkdirSync(dirname(join(src, path)), { recursive: true });
      writeFileSync(join(src, path), text);
    }
    const vcs = (...args) => execFileSync('git', args, { cwd: src, env: GIT_ENV, stdio: 'pipe' });
    vcs('init', '-b', 'main');
    vcs('add', '-A');
    vcs('commit', '-m', 'init');
    const reg = registryWith('leak', { projects: [project('keep', 'Keeper')], retired: [{ ...project('qbz', 'Quuxbazzle'), retiredOn: '2026-11-06' }] });
    const r = spawnSync('node', [join(ROOT, 'make-starter.mjs'), join(tmp, 'leak-dest'), '--src', src, '--registry', reg, '--starter-repo', 'acme-test/claude-harness-starter'], { env: GIT_ENV, encoding: 'utf8' });
    assert.equal(r.status, 1);
    assert.match(r.stderr, /notes\.md:1: "quuxbazzle" \(project name of qbz\)/i);
  });

  test('wiki lint does not need a page for a retired project', () => {
    const wiki = join(tmp, 'wiki');
    for (const [rel, text] of Object.entries({ 'WIKI.md': '# Schema\n', 'index.md': '# Index\n', 'log.md': '# Log\n' })) {
      mkdirSync(dirname(join(wiki, rel)), { recursive: true });
      writeFileSync(join(wiki, rel), text);
    }
    const reg = registryWith('wiki', { projects: [], retired: [project('zeta', 'Zeta')] });
    const r = spawnSync('node', [join(ROOT, 'wiki.mjs'), 'lint', '--wiki', wiki, '--registry', reg], { env: GIT_ENV, encoding: 'utf8' });
    assert.doesNotMatch(r.stdout, /zeta/);
    assert.equal(r.status, 0, r.stdout + r.stderr);
  });
});
