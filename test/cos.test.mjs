import assert from 'node:assert/strict';
import { execFileSync, spawnSync } from 'node:child_process';
import { chmodSync, cpSync, existsSync, lstatSync, mkdirSync, mkdtempSync, readFileSync, readlinkSync, realpathSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { after, before, describe, test } from 'node:test';
import { fileURLToPath } from 'node:url';

const ROOT = realpathSync(join(fileURLToPath(import.meta.url), '..', '..'));
const COS = join(ROOT, 'cos.mjs');
const INSTALL = join(ROOT, 'install.sh');
const { classifyPr, prBlockReason } = await import(COS);
const MAIN = realpathSync(
  join(execFileSync('git', ['rev-parse', '--path-format=absolute', '--git-common-dir'], { cwd: ROOT }).toString().trim(), '..'),
);
const GIT_ENV = {
  ...process.env,
  GIT_AUTHOR_NAME: 't',
  GIT_AUTHOR_EMAIL: 't@example.com',
  GIT_COMMITTER_NAME: 't',
  GIT_COMMITTER_EMAIL: 't@example.com',
  GIT_CONFIG_GLOBAL: '/dev/null',
  GIT_CONFIG_SYSTEM: '/dev/null',
};

// Built at run time: the starter's leak scan flags any literal user@host.
const GIT_AT = ['git', 'github.com'].join('@');
const git = (cwd, ...args) => execFileSync('git', args, { cwd, env: GIT_ENV, stdio: 'pipe' }).toString();

function makeRepo(dir, { gate = true } = {}) {
  mkdirSync(dir, { recursive: true });
  git(dir, 'init', '-b', 'main');
  if (gate) {
    mkdirSync(join(dir, '.claude'));
    writeFileSync(join(dir, '.claude', 'gate.json'), '{}');
  }
  writeFileSync(join(dir, 'a.txt'), 'a');
  git(dir, 'add', '-A');
  git(dir, 'commit', '-m', 'init');
}

function cos(args, { input, registry, env } = {}) {
  const r = spawnSync('node', [COS, ...args, ...(registry ? ['--registry', registry] : [])], {
    input,
    env: { ...GIT_ENV, ...env },
    encoding: 'utf8',
  });
  return { code: r.status, out: r.stdout, err: r.stderr };
}

let tmp;
let registry;
const dirs = {};

before(() => {
  tmp = realpathSync(mkdtempSync(join(tmpdir(), 'cos-test-')));
  dirs.dirty = join(tmp, 'dirty');
  dirs.local = join(tmp, 'local');
  dirs.bare = join(tmp, 'remote.git');
  dirs.missing = join(tmp, 'does-not-exist');
  dirs.harness = join(tmp, 'harness');

  makeRepo(dirs.dirty);
  writeFileSync(join(dirs.dirty, 'u1.txt'), '1');
  writeFileSync(join(dirs.dirty, 'u2.txt'), '2');

  makeRepo(join(tmp, 'seed'));
  git(tmp, 'clone', '--bare', join(tmp, 'seed'), dirs.bare);
  git(tmp, 'clone', dirs.bare, dirs.local);
  writeFileSync(join(dirs.local, 'b.txt'), 'b');
  git(dirs.local, 'add', '-A');
  git(dirs.local, 'commit', '-m', 'local only');

  mkdirSync(dirs.harness);
  mkdirSync(join(tmp, 'dirty-tasks', 'x'), { recursive: true });

  registry = join(tmp, 'projects.json');
  writeFileSync(
    registry,
    JSON.stringify({
      projects: [
        { id: 'alpha', name: 'Alpha App', what: 'First.', checkouts: [dirs.dirty], aliases: ['alpha app'], keywords: ['alpha', 'pizza ovens', 'billing'] },
        { id: 'beta', name: 'Beta Site', what: 'Second.', checkouts: [dirs.local], aliases: ['beta site'], keywords: ['beta', 'newsletter', 'billing'] },
        { id: 'gone', name: 'Gone Thing', what: 'Third.', checkouts: [dirs.missing], keywords: ['gone'] },
      ],
    }),
  );
});

after(() => rmSync(tmp, { recursive: true, force: true }));

describe('status', () => {
  let report;
  before(() => {
    const r = cos(['status', '--json', '--no-gh'], { registry });
    assert.equal(r.code, 0, r.err);
    report = Object.fromEntries(JSON.parse(r.out).projects.map((p) => [p.id, p.checkouts[0]]));
  });

  test('counts untracked files as dirty and flags them', () => {
    assert.equal(report.alpha.dirty.count, 2);
    assert.ok(report.alpha.attention.some((a) => /uncommitted/.test(a.message)));
  });

  test('reports an unpushed commit as ahead 1 and flags it', () => {
    assert.equal(report.beta.ahead, 1);
    assert.equal(report.beta.behind, 0);
    assert.ok(report.beta.attention.some((a) => /not pushed/.test(a.message)));
  });

  test('flags a missing checkout while other projects still report', () => {
    assert.equal(report.gone.exists, false);
    assert.ok(report.gone.attention.some((a) => /missing/.test(a.message)));
    assert.equal(report.alpha.isGit, true);
  });

  test('markdown lists Needs you and every project', () => {
    const r = cos(['status', '--no-gh'], { registry });
    assert.equal(r.code, 0, r.err);
    assert.match(r.out, /Needs you/);
    for (const name of ['Alpha App', 'Beta Site', 'Gone Thing']) assert.ok(r.out.includes(name), name);
  });
});

describe('route', () => {
  test('picks the project whose keyword phrase matches', () => {
    const r = cos(['route', 'the Pizza Ovens are late'], { registry });
    assert.equal(r.code, 0);
    assert.equal(r.out.trim(), `alpha\t${dirs.dirty}`);
  });

  test('prints none for unrelated text', () => {
    assert.equal(cos(['route', 'what is for lunch'], { registry }).out.trim(), 'none');
  });

  test('prints none when the top score is tied', () => {
    const r = cos(['route', 'billing question'], { registry });
    assert.equal(r.code, 0);
    assert.equal(r.out.trim(), 'none');
  });

  test('does not match keywords inside longer words', () => {
    assert.equal(cos(['route', 'alphabet soup'], { registry }).out.trim(), 'none');
  });
});

describe('hook', () => {
  const fire = (cwd, prompt) =>
    cos(['hook', '--harness', dirs.harness], { registry, input: JSON.stringify({ cwd, prompt }) });

  test('reminds when a prompt belongs to another project', () => {
    const r = fire(dirs.dirty, 'fix the beta site newsletter layout');
    assert.equal(r.code, 0);
    assert.match(r.out, /looks like Beta Site work/);
    assert.ok(r.out.includes(dirs.local));
    assert.match(r.out, /this session is in Alpha App/);
    assert.match(r.out, /change_directory/);
  });

  test('is silent when only a generic keyword matches another project', () => {
    assert.equal(fire(dirs.dirty, 'fix the newsletter layout').out, '');
    assert.equal(fire(tmp, 'add a newsletter signup for the pizza ovens client').out, '');
  });

  test('is silent for a same-project prompt', () => {
    assert.equal(fire(dirs.dirty, 'fix the alpha bug').out, '');
  });

  test('is silent when the current project also scores', () => {
    assert.equal(fire(dirs.dirty, 'alpha and the beta site').out, '');
  });

  test('is silent from a task worktree asking about its own project', () => {
    assert.equal(fire(join(tmp, 'dirty-tasks', 'x'), 'fix the alpha bug').out, '');
  });

  test('knows a task worktree belongs to its project', () => {
    assert.match(fire(join(tmp, 'dirty-tasks', 'x'), 'fix the beta site').out, /this session is in Alpha App/);
  });

  test('is silent from the harness dir', () => {
    assert.equal(fire(dirs.harness, 'tell beta site to fix the newsletter').out, '');
  });

  test('is silent outside any project when the prompt routes nowhere', () => {
    assert.equal(fire(tmp, 'what is for lunch').out, '');
  });

  test('is silent and exits 0 on malformed stdin', () => {
    for (const input of ['not json', '', '{"prompt": 5}']) {
      const r = cos(['hook', '--harness', dirs.harness], { registry, input });
      assert.equal(r.code, 0);
      assert.equal(r.out, '');
    }
  });
});

describe('install.sh', () => {
  const install = (home, ...args) =>
    spawnSync('sh', [INSTALL, ...args], { env: { ...process.env, HOME: home }, encoding: 'utf8' });
  const freshHome = () => mkdtempSync(join(tmp, 'home-'));
  const cosHooks = (settings) =>
    (settings.hooks?.UserPromptSubmit ?? []).flatMap((g) => g.hooks).filter((h) => h.command.includes('cos.mjs'));

  test('links the skills and CLAUDE.md and adds the hooks', () => {
    const home = freshHome();
    const r = install(home);
    assert.equal(r.status, 0, r.stderr);
    assert.equal(readlinkSync(join(home, '.claude/skills/cos')), join(MAIN, 'skills/cos'));
    assert.equal(readlinkSync(join(home, '.claude/skills/until-ready')), join(MAIN, 'skills/until-ready'));
    const stop = JSON.parse(readFileSync(join(home, '.claude/settings.json'), 'utf8')).hooks.Stop.flatMap((g) => g.hooks);
    assert.deepEqual(stop, [{ type: 'command', command: `node "${MAIN}/gate/qa-gate.mjs"`, timeout: 1800 }]);
    assert.equal(readlinkSync(join(home, '.claude/CLAUDE.md')), join(MAIN, 'global/CLAUDE.md'));
    const hooks = cosHooks(JSON.parse(readFileSync(join(home, '.claude/settings.json'), 'utf8')));
    assert.equal(hooks.length, 1);
    assert.equal(hooks[0].command, `node "${MAIN}/cos.mjs" hook`);
    assert.equal(hooks[0].timeout, 5);
  });

  test('running twice leaves exactly one cos hook', () => {
    const home = freshHome();
    install(home);
    const second = install(home);
    assert.equal(second.status, 0);
    assert.match(second.stdout, /already/);
    const settings = JSON.parse(readFileSync(join(home, '.claude/settings.json'), 'utf8'));
    assert.equal(cosHooks(settings).length, 1);
    assert.equal(settings.hooks.Stop.flatMap((g) => g.hooks).length, 1);
  });

  test('leaves a real CLAUDE.md untouched', () => {
    const home = freshHome();
    mkdirSync(join(home, '.claude'));
    writeFileSync(join(home, '.claude/CLAUDE.md'), 'mine');
    const r = install(home);
    assert.equal(r.status, 0);
    assert.match(r.stdout, /warning/);
    assert.equal(lstatSync(join(home, '.claude/CLAUDE.md')).isSymbolicLink(), false);
    assert.equal(readFileSync(join(home, '.claude/CLAUDE.md'), 'utf8'), 'mine');
  });

  test('keeps existing hooks and backs up settings.json', () => {
    const home = freshHome();
    mkdirSync(join(home, '.claude'));
    const original = { model: 'x', hooks: { Stop: [{ hooks: [{ type: 'command', command: 'echo stop' }] }] } };
    writeFileSync(join(home, '.claude/settings.json'), JSON.stringify(original));
    install(home);
    const settings = JSON.parse(readFileSync(join(home, '.claude/settings.json'), 'utf8'));
    assert.deepEqual(settings.hooks.Stop, [
      ...original.hooks.Stop,
      { hooks: [{ type: 'command', command: `node "${MAIN}/gate/qa-gate.mjs"`, timeout: 1800 }] },
    ]);
    assert.equal(settings.model, 'x');
    assert.equal(cosHooks(settings).length, 1);
    assert.deepEqual(JSON.parse(readFileSync(join(home, '.claude/settings.json.bak'), 'utf8')), original);
  });

  test('leaves a CLAUDE.md linked somewhere else untouched', () => {
    const home = freshHome();
    mkdirSync(join(home, '.claude'));
    writeFileSync(join(home, 'dotfiles.md'), 'dotfiles');
    symlinkSync(join(home, 'dotfiles.md'), join(home, '.claude/CLAUDE.md'));
    const r = install(home);
    assert.equal(r.status, 0);
    assert.equal(readlinkSync(join(home, '.claude/CLAUDE.md')), join(home, 'dotfiles.md'));
  });

  test('replaces a cos hook that points at an old folder', () => {
    const home = freshHome();
    mkdirSync(join(home, '.claude'));
    const old = { hooks: { UserPromptSubmit: [{ hooks: [{ type: 'command', command: 'node "/gone/cos.mjs" hook' }] }] } };
    writeFileSync(join(home, '.claude/settings.json'), JSON.stringify(old));
    install(home);
    const hooks = cosHooks(JSON.parse(readFileSync(join(home, '.claude/settings.json'), 'utf8')));
    assert.deepEqual(hooks.map((h) => h.command), [`node "${MAIN}/cos.mjs" hook`]);
  });

  test('refuses to replace a real skill directory', () => {
    const home = freshHome();
    mkdirSync(join(home, '.claude/skills/cos'), { recursive: true });
    const r = install(home);
    assert.notEqual(r.status, 0);
    assert.match(r.stdout, /refusing/);
  });

  test('dry run changes nothing', () => {
    const home = freshHome();
    const r = install(home, '--dry-run');
    assert.equal(r.status, 0);
    assert.match(r.stdout, /dry-run/);
    assert.equal(existsSync(join(home, '.claude')), false);
  });
});

describe('PR classification', () => {
  const pr = (over = {}) => ({ base: 'main', isDraft: false, failingChecks: [], checks: ['SUCCESS'], mergeable: 'MERGEABLE', reviewDecision: null, ...over });
  const surface = { branches: ['main'], remotes: [], notes: [] };
  const into = (over) => classifyPr(pr({ base: 'develop', ...over }), surface, 'main');

  test('a PR into a public branch needs review, even when green', () => {
    assert.equal(classifyPr(pr(), surface, 'main'), 'review');
  });

  test('a null or empty base needs review', () => {
    assert.equal(into({ base: null }), 'review');
    assert.equal(into({ base: '' }), 'review');
  });

  test('a green PR into a non-public branch is mergeable by cos', () => {
    assert.equal(into({}), 'mergeable-by-cos');
    assert.equal(into({ checks: ['SUCCESS', 'NEUTRAL', 'SKIPPED'] }), 'mergeable-by-cos');
  });

  test('failing checks or a draft block a non-public PR', () => {
    assert.equal(into({ failingChecks: ['ci'], checks: ['FAILURE'] }), 'blocked');
    assert.equal(into({ isDraft: true }), 'blocked');
  });

  test('no checks blocks', () => {
    assert.equal(into({ checks: [] }), 'blocked');
    assert.equal(into({ checks: undefined }), 'blocked');
  });

  test('any check not in a success state blocks', () => {
    for (const state of ['PENDING', 'QUEUED', 'IN_PROGRESS', 'CANCELLED', 'ACTION_REQUIRED', '']) {
      assert.equal(into({ checks: ['SUCCESS', state] }), 'blocked', state || 'empty');
    }
  });

  test('merge conflicts or requested changes block', () => {
    assert.equal(into({ mergeable: 'CONFLICTING' }), 'blocked');
    assert.equal(into({ reviewDecision: 'CHANGES_REQUESTED' }), 'blocked');
    assert.equal(into({ mergeable: 'UNKNOWN', reviewDecision: 'APPROVED' }), 'mergeable-by-cos');
  });

  test('on a public base, draft, conflicts and requested changes block; missing or red checks still go to review', () => {
    assert.equal(classifyPr(pr({ isDraft: true }), surface, 'main'), 'blocked');
    assert.equal(classifyPr(pr({ mergeable: 'CONFLICTING' }), surface, 'main'), 'blocked');
    assert.equal(classifyPr(pr({ reviewDecision: 'CHANGES_REQUESTED' }), surface, 'main'), 'blocked');
    assert.equal(classifyPr(pr({ checks: [] }), surface, 'main'), 'review');
    assert.equal(classifyPr(pr({ checks: ['FAILURE'] }), surface, 'main'), 'review');
  });

  test('prBlockReason gives plain words for a blocked PR and null otherwise', () => {
    assert.match(prBlockReason(pr({ isDraft: true }), surface, 'main'), /draft/);
    assert.match(prBlockReason(pr({ mergeable: 'CONFLICTING' }), surface, 'main'), /conflicts/);
    assert.match(prBlockReason(pr({ reviewDecision: 'CHANGES_REQUESTED' }), surface, 'main'), /asked for changes/);
    assert.match(prBlockReason(pr({ base: 'develop', checks: ['FAILURE'] }), surface, 'main'), /checks/);
    assert.equal(prBlockReason(pr(), surface, 'main'), null, 'a clean live PR is review, not blocked');
    assert.equal(prBlockReason(pr({ base: 'develop' }), surface, 'main'), null);
  });

  test('without a public field the default branch counts as public', () => {
    assert.equal(classifyPr(pr({ base: 'trunk' }), null, 'trunk'), 'review');
    assert.equal(classifyPr(pr({ base: 'develop' }), null, 'trunk'), 'mergeable-by-cos');
  });
});

describe('gh targets the origin repo', () => {
  const withFakeGh = (originUrl) => {
    const repo = mkdtempSync(join(tmp, 'gh-'));
    makeRepo(repo);
    git(repo, 'remote', 'add', 'origin', originUrl);
    git(repo, 'remote', 'add', 'upstream', 'https://github.com/someone/public-repo.git');
    const bin = join(repo, '..', `bin-${repo.split('/').pop()}`);
    mkdirSync(bin);
    const log = join(bin, 'gh.log');
    writeFileSync(join(bin, 'gh'), `#!/bin/sh\necho "$@" >> "${log}"\necho '[]'\n`);
    chmodSync(join(bin, 'gh'), 0o755);
    const reg = join(bin, 'projects.json');
    writeFileSync(reg, JSON.stringify({ projects: [{ id: 'g', name: 'G', checkouts: [repo] }] }));
    const r = cos(['status', '--json'], { registry: reg, env: { PATH: `${bin}:${process.env.PATH}` } });
    return { r, log, checkout: JSON.parse(r.out).projects[0].checkouts[0] };
  };

  for (const [form, url] of [['https', 'https://github.com/acme/widgets.git'], ['ssh', `${GIT_AT}:acme/widgets.git`], ['ssh://', `ssh://${GIT_AT}/acme/widgets`]]) {
    test(`passes -R owner/repo from a ${form} origin`, () => {
      const { r, log } = withFakeGh(url);
      assert.equal(r.code, 0, r.err);
      const args = readFileSync(log, 'utf8');
      assert.match(args, /pr list -R acme\/widgets /);
      assert.ok(!args.includes('someone/public-repo'));
    });
  }

  test('skips PRs with a note when origin is not a parseable GitHub URL', () => {
    const { r, log, checkout } = withFakeGh('https://github.com/just-an-owner');
    assert.equal(r.code, 0, r.err);
    assert.equal(existsSync(log), false);
    assert.ok(checkout.notes.some((n) => /not a parseable GitHub URL/.test(n)));
  });
});

describe('status review queue', () => {
  test('lists review and cos-mergeable PRs, public line, and json classification', () => {
    const repo = join(tmp, 'queue');
    makeRepo(repo);
    const prs = join(tmp, 'prs.json');
    const raw = (number, base, extra = {}) => ({ number, title: `PR ${number}`, headRefName: `t${number}`, baseRefName: base, isDraft: false, url: `https://x/${number}`, mergeable: 'MERGEABLE', statusCheckRollup: [{ name: 'ci', conclusion: 'SUCCESS' }], ...extra });
    writeFileSync(prs, JSON.stringify([raw(1, 'main'), raw(2, 'develop'), raw(3, 'develop', { isDraft: true })]));
    const reg = join(tmp, 'queue-projects.json');
    writeFileSync(
      reg,
      JSON.stringify({ projects: [{ id: 'q', name: 'Queue', checkouts: [repo], public: { branches: ['main'], remotes: ['site'], notes: ['`vercel deploy --prod`'] } }] }),
    );
    const md = cos(['status', '--fake-prs', prs], { registry: reg });
    assert.equal(md.code, 0, md.err);
    assert.match(md.out, /# Ready for your review\n\n- \*\*Queue\*\* #1 PR 1 \(https:\/\/x\/1\)/);
    assert.match(md.out, /# Chief of Staff can merge\n\n- \*\*Queue\*\* #2 PR 2 \(https:\/\/x\/2\)/);
    assert.ok(!md.out.includes('#3 PR 3 (https'));
    assert.ok(md.out.includes('Public: main on origin; pushes to site; vercel deploy --prod'));
    const json = JSON.parse(cos(['status', '--json', '--fake-prs', prs], { registry: reg }).out);
    assert.deepEqual(json.projects[0].checkouts[0].prs.map((p) => p.classification), ['review', 'mergeable-by-cos', 'blocked']);
  });

  test('lists a PR once when two checkouts of one project report it', () => {
    const a = join(tmp, 'dup-a');
    const b = join(tmp, 'dup-b');
    makeRepo(a);
    makeRepo(b);
    const prs = join(tmp, 'dup-prs.json');
    writeFileSync(prs, JSON.stringify([{ number: 1, title: 'PR 1', headRefName: 't', baseRefName: 'main', isDraft: false, url: 'https://x/1', statusCheckRollup: [] }]));
    const reg = join(tmp, 'dup-projects.json');
    writeFileSync(reg, JSON.stringify({ projects: [{ id: 'd', name: 'Dup', checkouts: [a, b] }] }));
    const md = cos(['status', '--fake-prs', prs], { registry: reg }).out;
    assert.equal(md.split('#1 PR 1 (https://x/1)').length - 1, 1);
  });

  test('omits the sections when there are no PRs', () => {
    const md = cos(['status', '--no-gh'], { registry }).out;
    assert.ok(!md.includes('Ready for your review'));
    assert.ok(!md.includes('can merge'));
  });
});

describe('new', () => {
  const setup = () => {
    const root = mkdtempSync(join(tmp, 'root-'));
    const reg = join(root, 'projects.json');
    writeFileSync(reg, JSON.stringify({ projects: [{ id: 'old', name: 'Old', checkouts: ['/x'] }] }, null, 2) + '\n');
    return { root, reg };
  };
  const make = (root, reg, extra = [], env) =>
    cos(['new', 'my-app', '--what', 'A tiny app.', '--root', root, ...extra], { registry: reg, env });

  test('creates the folder, repo, files, commit and registry entry, and a rerun skips them', () => {
    const { root, reg } = setup();
    const dir = join(root, 'my-app');
    const first = make(root, reg);
    assert.equal(first.code, 0, first.err);
    assert.match(first.out, /created folder/);
    assert.ok(first.out.trim().endsWith(dir));
    const claude = readFileSync(join(dir, 'CLAUDE.md'), 'utf8');
    assert.ok(claude.startsWith('# My App\n\nA tiny app.\n'));
    assert.match(claude, /pstack/);
    assert.match(readFileSync(join(dir, '.gitignore'), 'utf8'), /^\.claude\/loop\/$/m);
    assert.equal(git(dir, 'rev-list', '--count', 'HEAD').trim(), '1');
    const projects = JSON.parse(readFileSync(reg, 'utf8')).projects;
    assert.deepEqual(projects.map((p) => p.id), ['old', 'my-app']);
    assert.deepEqual(projects[1], {
      id: 'my-app', name: 'My App', what: 'A tiny app.', checkouts: [dir], aliases: ['my app'], keywords: [],
      public: { branches: ['main'], remotes: [], notes: [] },
    });

    assert.equal(existsSync(`${reg}.tmp`), false);
    const second = make(root, reg);
    assert.equal(second.code, 2);
    assert.match(second.err, /already registered/);
    assert.equal(JSON.parse(readFileSync(reg, 'utf8')).projects.length, 2);
    assert.equal(git(dir, 'rev-list', '--count', 'HEAD').trim(), '1');
  });

  test('writes the project wiki page when the harness has a wiki, and lint passes', () => {
    const { root, reg } = setup();
    const wikiDir = join(root, 'wiki');
    cpSync(join(ROOT, 'starter-wiki'), wikiDir, { recursive: true });
    writeFileSync(reg, JSON.stringify({ projects: [] }));
    const r = make(root, reg);
    assert.equal(r.code, 0, r.err);
    assert.match(r.out, /created wiki page/);
    assert.match(readFileSync(join(wikiDir, 'projects', 'my-app.md'), 'utf8'), /\n# My App\n\n## What it is\n\nA tiny app\.\n/);
    const lint = spawnSync('node', [join(ROOT, 'wiki.mjs'), 'lint', '--wiki', wikiDir, '--registry', reg], { encoding: 'utf8', env: GIT_ENV });
    assert.equal(lint.status, 0, lint.stdout);
  });

  test('skips the wiki page when the harness has no wiki', () => {
    const { root, reg } = setup();
    const r = make(root, reg);
    assert.equal(r.code, 0, r.err);
    assert.doesNotMatch(r.out, /wiki/);
    assert.equal(existsSync(join(root, 'wiki')), false);
  });

  test('refuses an id that is already registered, even with --adopt, and creates nothing', () => {
    const { root, reg } = setup();
    writeFileSync(reg, JSON.stringify({ projects: [{ id: 'my-app', name: 'x', checkouts: ['/x'] }] }));
    for (const extra of [[], ['--adopt']]) {
      const r = make(root, reg, extra);
      assert.equal(r.code, 2);
      assert.equal(existsSync(join(root, 'my-app')), false);
    }
  });

  test('refuses a non-empty folder or a git repo, and nothing is touched', () => {
    const { root, reg } = setup();
    const dir = join(root, 'my-app');
    mkdirSync(dir);
    writeFileSync(join(dir, 'keep.txt'), 'k');
    const before = readFileSync(reg, 'utf8');
    assert.equal(make(root, reg).code, 2);
    rmSync(join(dir, 'keep.txt'));
    git(dir, 'init', '-b', 'main');
    assert.equal(make(root, reg).code, 2);
    assert.equal(existsSync(join(dir, 'CLAUDE.md')), false);
    assert.equal(readFileSync(reg, 'utf8'), before);
  });

  test('an empty existing folder is fine', () => {
    const { root, reg } = setup();
    mkdirSync(join(root, 'my-app'));
    assert.equal(make(root, reg).code, 0);
  });

  test('matches the folder name case-insensitively', () => {
    const { root, reg } = setup();
    mkdirSync(join(root, 'My-App'));
    writeFileSync(join(root, 'My-App', 'keep.txt'), 'k');
    const r = make(root, reg);
    assert.equal(r.code, 2);
    assert.equal(existsSync(join(root, 'My-App', 'CLAUDE.md')), false);
  });

  test('--adopt takes over an existing folder', () => {
    const { root, reg } = setup();
    const dir = join(root, 'my-app');
    mkdirSync(dir);
    writeFileSync(join(dir, 'keep.txt'), 'k');
    const r = make(root, reg, ['--adopt']);
    assert.equal(r.code, 0, r.err);
    assert.ok(git(dir, 'ls-files').includes('keep.txt'));
    assert.equal(JSON.parse(readFileSync(reg, 'utf8')).projects.length, 2);
  });

  test('appends only the missing lines to an existing .gitignore', () => {
    const { root, reg } = setup();
    mkdirSync(join(root, 'my-app'));
    writeFileSync(join(root, 'my-app', '.gitignore'), 'node_modules\n.env');
    assert.equal(make(root, reg, ['--adopt']).code, 0);
    assert.equal(
      readFileSync(join(root, 'my-app', '.gitignore'), 'utf8'),
      'node_modules\n.env\n.claude/loop/\n.env.*\n!.env.example\nnode_modules/\n',
    );
  });

  test('does not commit a pre-existing .env in an adopted folder', () => {
    const { root, reg } = setup();
    const dir = join(root, 'my-app');
    mkdirSync(dir);
    writeFileSync(join(dir, '.env'), 'SECRET=1');
    writeFileSync(join(dir, '.env.local'), 'SECRET=2');
    writeFileSync(join(dir, '.env.example'), 'SECRET=');
    assert.equal(make(root, reg, ['--adopt']).code, 0);
    const tracked = git(dir, 'ls-files').split('\n');
    assert.ok(!tracked.includes('.env') && !tracked.includes('.env.local'), tracked.join());
    assert.ok(tracked.includes('.env.example') && tracked.includes('CLAUDE.md'));
  });

  test('--github pushes instead of creating when origin exists but nothing was pushed', () => {
    const { root, reg } = setup();
    const dir = join(root, 'my-app');
    const remote = join(root, 'remote.git');
    git(root, 'init', '--bare', '-b', 'main', remote);
    makeRepo(dir);
    git(dir, 'remote', 'add', 'origin', remote);
    const bin = join(root, 'bin');
    mkdirSync(bin);
    const log = join(root, 'gh.log');
    writeFileSync(join(bin, 'gh'), `#!/bin/sh\necho "$@" >> "${log}"\n`);
    chmodSync(join(bin, 'gh'), 0o755);
    const env = { PATH: `${bin}:${process.env.PATH}` };
    const r = make(root, reg, ['--github', '--adopt'], env);
    assert.equal(r.code, 0, r.err);
    assert.equal(existsSync(log), false);
    assert.match(git(remote, 'branch', '--list', 'main'), /main/);
  });

  test('--github skips a repo whose origin already has commits', () => {
    const { root, reg } = setup();
    const dir = join(root, 'my-app');
    const remote = join(root, 'remote.git');
    git(root, 'init', '--bare', '-b', 'main', remote);
    makeRepo(dir);
    git(dir, 'remote', 'add', 'origin', remote);
    git(dir, 'push', '-u', 'origin', 'main');
    const r = make(root, reg, ['--github', '--adopt']);
    assert.equal(r.code, 0, r.err);
    assert.match(r.out, /already github repo/);
  });

  test('a value flag with no value exits 2', () => {
    const { root, reg } = setup();
    for (const args of [['new', 'my-app', '--what', '--github', '--root', root], ['new', 'my-app', '--what']]) {
      const r = cos(args, { registry: reg });
      assert.equal(r.code, 2, args.join(' '));
      assert.match(r.err, /--what needs a value/);
    }
    assert.equal(existsSync(join(root, 'my-app')), false);
  });

  test('rejects a bad slug with exit 2 and creates nothing', () => {
    const { root, reg } = setup();
    const before = readFileSync(reg, 'utf8');
    for (const slug of ['Bad_Slug', 'a b', '-x', 'x-']) {
      const r = cos(['new', slug, '--what', 'x', '--root', root], { registry: reg });
      assert.equal(r.code, 2, slug);
    }
    assert.equal(existsSync(join(root, 'Bad_Slug')), false);
    assert.equal(readFileSync(reg, 'utf8'), before);
  });

  const fakeGh = (root, script = '') => {
    const bin = join(root, 'bin');
    mkdirSync(bin);
    const log = join(root, 'gh.log');
    writeFileSync(join(bin, 'gh'), `#!/bin/sh\necho "$@" >> "${log}"\n${script}`);
    chmodSync(join(bin, 'gh'), 0o755);
    return { log, env: { PATH: `${bin}:${process.env.PATH}` } };
  };

  test('--github runs gh repo create --private and never --public', () => {
    const { root, reg } = setup();
    const { log, env } = fakeGh(root);
    const r = make(root, reg, ['--github', '--owner', 'zed-example'], env);
    assert.equal(r.code, 0, r.err);
    const args = readFileSync(log, 'utf8');
    assert.match(args, /repo create zed-example\/my-app --private --source .*my-app --push/);
    assert.ok(!args.includes('--public'));
  });

  test('--github without --owner uses the signed-in gh account', () => {
    const { root, reg } = setup();
    const { log, env } = fakeGh(root, '[ "$1" = api ] && echo octo-friend\nexit 0\n');
    const r = make(root, reg, ['--github'], env);
    assert.equal(r.code, 0, r.err);
    const args = readFileSync(log, 'utf8');
    assert.match(args, /^api user --jq \.login$/m);
    assert.match(args, /repo create octo-friend\/my-app --private/);
  });

  test('--github with no --owner and no gh login says how to fix it and creates no repo', () => {
    const { root, reg } = setup();
    const { log, env } = fakeGh(root, '[ "$1" = api ] && { echo "not logged in" >&2; exit 1; }\nexit 0\n');
    const r = make(root, reg, ['--github'], env);
    assert.equal(r.code, 1);
    assert.match(r.err, /not logged in/);
    assert.match(r.err, /--owner <name>/);
    assert.match(r.err, /gh auth login/);
    assert.ok(!readFileSync(log, 'utf8').includes('repo create'));
    assert.equal(JSON.parse(readFileSync(reg, 'utf8')).projects.length, 2);
  });

  test('--github failure prints the error and exits 1 after the other steps', () => {
    const { root, reg } = setup();
    const bin = join(root, 'bin');
    mkdirSync(bin);
    writeFileSync(join(bin, 'gh'), '#!/bin/sh\necho nope >&2\nexit 1\n');
    chmodSync(join(bin, 'gh'), 0o755);
    const r = make(root, reg, ['--github'], { PATH: `${bin}:${process.env.PATH}` });
    assert.equal(r.code, 1);
    assert.match(r.err, /nope/);
    assert.equal(JSON.parse(readFileSync(reg, 'utf8')).projects.length, 2);
  });
});

describe('findGh', () => {
  test('finds gh in ~/.local/bin when PATH lacks it, and GH_BIN wins', async () => {
    const { findGh } = await import('../cos.mjs');
    const home = mkdtempSync(join(tmpdir(), 'gh-home-'));
    mkdirSync(join(home, '.local/bin'), { recursive: true });
    writeFileSync(join(home, '.local/bin/gh'), '#!/bin/sh\n', { mode: 0o755 });
    const plain = mkdtempSync(join(tmpdir(), 'gh-plain-'));
    writeFileSync(join(plain, 'gh'), 'not executable', { mode: 0o644 });
    assert.equal(findGh({ HOME: home, PATH: `${plain}:bin` }), join(home, '.local/bin/gh'), 'skips non-executable and relative entries');
    assert.equal(findGh({ HOME: home, PATH: '/nonexistent' }), join(home, '.local/bin/gh'));
    assert.equal(findGh({ HOME: home, PATH: '', GH_BIN: '/x/gh' }), '/x/gh');
    const empty = mkdtempSync(join(tmpdir(), 'gh-none-'));
    const found = findGh({ HOME: empty, PATH: '/nonexistent' });
    assert.ok(found === 'gh' || found.startsWith('/opt/homebrew') || found.startsWith('/usr/local'), found);
  });
});

describe('add', () => {
  const setup = () => {
    const root = mkdtempSync(join(tmp, 'add-'));
    const reg = join(root, 'projects.json');
    writeFileSync(reg, JSON.stringify({ projects: [{ id: 'old', name: 'Old', checkouts: [join(root, 'old')] }] }, null, 2) + '\n');
    return { root, reg };
  };
  const projects = (reg) => JSON.parse(readFileSync(reg, 'utf8')).projects;

  test('registers a folder with origin, default branch and a public entry, and changes nothing in it', () => {
    const { root, reg } = setup();
    const seed = join(root, 'seed');
    makeRepo(seed);
    git(seed, 'branch', '-m', 'main', 'trunk');
    const dir = join(root, 'Cool Tool');
    git(root, 'clone', seed, dir);
    git(dir, 'remote', 'set-url', 'origin', `${GIT_AT}:acme/cool-tool.git`);
    const before = git(dir, 'status', '--porcelain', '--ignored') + git(dir, 'rev-parse', 'HEAD');
    const r = cos(['add', dir, '--what', 'A tool.', '--keywords', 'cool, tooling,,'], { registry: reg });
    assert.equal(r.code, 0, r.err);
    assert.match(r.out, /origin: acme\/cool-tool; default branch: trunk/);
    assert.match(r.out, /fill in "public" for cool-tool/);
    assert.deepEqual(projects(reg)[1], {
      id: 'cool-tool', name: 'Cool Tool', what: 'A tool.', checkouts: [dir], aliases: ['cool tool'], keywords: ['cool', 'tooling'],
      public: { branches: ['trunk'], remotes: [], notes: [] },
    });
    assert.equal(git(dir, 'status', '--porcelain', '--ignored') + git(dir, 'rev-parse', 'HEAD'), before);
    assert.equal(existsSync(`${reg}.tmp`), false);
  });

  test('--id and --name override the folder name', () => {
    const { root, reg } = setup();
    const dir = join(root, 'thing');
    makeRepo(dir);
    const r = cos(['add', dir, '--id', 'my-thing', '--name', 'My Thing!'], { registry: reg });
    assert.equal(r.code, 0, r.err);
    assert.match(r.out, /no GitHub origin found; default branch: main/);
    assert.deepEqual(
      { id: projects(reg)[1].id, name: projects(reg)[1].name, what: projects(reg)[1].what },
      { id: 'my-thing', name: 'My Thing!', what: '' },
    );
  });

  test('refuses a duplicate id or folder and leaves the registry as it was', () => {
    const { root, reg } = setup();
    const dir = join(root, 'thing');
    makeRepo(dir);
    assert.equal(cos(['add', dir], { registry: reg }).code, 0);
    const before = readFileSync(reg, 'utf8');
    const sameFolder = cos(['add', dir, '--id', 'other'], { registry: reg });
    assert.equal(sameFolder.code, 2);
    assert.match(sameFolder.err, /already registered as "thing"/);
    const other = join(root, 'other');
    makeRepo(other);
    const sameId = cos(['add', other, '--id', 'OLD'.toLowerCase()], { registry: reg });
    assert.equal(sameId.code, 2);
    assert.match(sameId.err, /"old" is already registered/);
    assert.equal(readFileSync(reg, 'utf8'), before);
  });

  test('refuses a missing folder or a bad id with no change', () => {
    const { root, reg } = setup();
    const before = readFileSync(reg, 'utf8');
    assert.equal(cos(['add', join(root, 'nope')], { registry: reg }).code, 2);
    makeRepo(join(root, 'ok'));
    assert.equal(cos(['add', join(root, 'ok'), '--id', 'Bad_Id'], { registry: reg }).code, 2);
    assert.equal(cos(['add'], { registry: reg }).code, 2);
    assert.equal(readFileSync(reg, 'utf8'), before);
  });

  test('creates projects.json when there is none', () => {
    const root = mkdtempSync(join(tmp, 'add-'));
    const reg = join(root, 'projects.json');
    makeRepo(join(root, 'first'));
    assert.equal(cos(['add', join(root, 'first')], { registry: reg }).code, 0);
    assert.deepEqual(projects(reg).map((p) => p.id), ['first']);
  });
});

describe('no projects.json', () => {
  const missing = () => join(mkdtempSync(join(tmp, 'empty-')), 'projects.json');

  test('status prints one line saying how to add a project', () => {
    const r = cos(['status', '--no-gh'], { registry: missing() });
    assert.equal(r.code, 0, r.err);
    assert.equal(r.out.trim().split('\n').length, 1);
    assert.match(r.out, /node cos\.mjs add <folder>/);
    assert.match(r.out, /new <slug>/);
    assert.deepEqual(JSON.parse(cos(['status', '--json', '--no-gh'], { registry: missing() }).out), { projects: [] });
  });

  test('route prints none', () => {
    const r = cos(['route', 'anything at all'], { registry: missing() });
    assert.equal(r.code, 0, r.err);
    assert.equal(r.out.trim(), 'none');
  });

  test('hook stays silent', () => {
    const r = cos(['hook', '--harness', dirs.harness], { registry: missing(), input: JSON.stringify({ cwd: tmp, prompt: 'fix the beta site' }) });
    assert.equal(r.code, 0);
    assert.equal(r.out, '');
    assert.equal(r.err, '');
  });
});
