// `node cos.mjs update`: pulls new starter commits into your copy of the harness.
// It merges the starter's main branch (kept as the `upstream` remote) and never touches your
// own files (USER_FILES). Any conflict aborts the merge and leaves everything as it was.
// It imports nothing from the harness, so an old install can fetch this one file and run it:
// `node starter-update.mjs` is the same as `node cos.mjs update`.
import { spawnSync } from 'node:child_process';
import { cpSync, existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, realpathSync, rmSync, statSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

/** Files the user owns: never shipped by the starter, never changed by an update. */
export const USER_FILES = ['projects.json', 'wiki/', 'reports/', 'ledger.md', 'mc/state/'];
const isUserFile = (file) => USER_FILES.some((spec) => (spec.endsWith('/') ? file.startsWith(spec) : file === spec));

const git = (cwd, ...args) => {
  const r = spawnSync('git', args, { cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'], maxBuffer: 1 << 28 });
  return { ok: r.status === 0, out: (r.stdout ?? '').trim(), err: (r.stderr ?? r.error?.message ?? '').trim() };
};

const mergeInProgress = (dir) => git(dir, 'rev-parse', '-q', '--verify', 'MERGE_HEAD').ok;

function say(message) {
  console.log(message);
}

function stop(message, code) {
  console.error(`cos update: ${message}`);
  return code;
}

function* filesUnder(root, rel = '') {
  const abs = join(root, rel);
  if (!existsSync(abs)) return;
  if (!statSync(abs).isDirectory()) {
    yield rel;
    return;
  }
  for (const name of readdirSync(abs)) yield* filesUnder(root, join(rel, name));
}

/** path -> sha256 for every file of yours that exists on disk. */
function fingerprint(dir) {
  const map = new Map();
  for (const spec of USER_FILES) {
    for (const file of filesUnder(dir, spec.replace(/\/$/, ''))) map.set(file, createHash('sha256').update(readFileSync(join(dir, file))).digest('hex'));
  }
  return map;
}

function backUp(dir) {
  const backup = mkdtempSync(join(tmpdir(), 'cos-update-'));
  for (const spec of USER_FILES) {
    const rel = spec.replace(/\/$/, '');
    if (existsSync(join(dir, rel))) {
      mkdirSync(dirname(join(backup, rel)), { recursive: true });
      cpSync(join(dir, rel), join(backup, rel), { recursive: true });
    }
  }
  return backup;
}

/** Puts back any of your files that differ from `before`. @returns {string[]} the files it restored */
function restoreChanged(dir, backup, before) {
  const now = fingerprint(dir);
  const restored = [...before.keys()].filter((f) => now.get(f) !== before.get(f));
  for (const f of restored) {
    mkdirSync(dirname(join(dir, f)), { recursive: true });
    cpSync(join(backup, f), join(dir, f));
  }
  return restored;
}

function newInChangelog(dir, base) {
  const log = base ? git(dir, 'diff', base, 'upstream/main', '--', 'CHANGELOG.md').out.split('\n').filter((l) => l.startsWith('+') && !l.startsWith('+++')).map((l) => l.slice(1)) : [];
  if (log.length) return log;
  const top = git(dir, 'show', 'upstream/main:CHANGELOG.md');
  if (!top.ok) return [];
  const lines = top.out.split('\n');
  const start = lines.findIndex((l) => l.startsWith('## '));
  if (start === -1) return [];
  const end = lines.findIndex((l, i) => i > start && l.startsWith('## '));
  return lines.slice(start, end === -1 ? undefined : end);
}

function findUpstream(dir, from) {
  if (git(dir, 'remote', 'get-url', 'upstream').ok) return { ok: true };
  const file = join(dir, 'HARNESS_VERSION');
  const url = from ?? (existsSync(file) ? readFileSync(file, 'utf8').match(/^upstream (\S+)/m)?.[1] : undefined);
  if (!url) return { ok: false };
  const added = git(dir, 'remote', 'add', 'upstream', url);
  return added.ok ? { ok: true, added: url } : { ok: false, err: added.err };
}

/** @returns {number} exit code */
export function update({ dir, check = false, adopt = false, from, install = true, tests = true }) {
  if (git(dir, 'config', '--get', 'harness.starterRepo').out) {
    return stop('this checkout publishes the starter, so it is the source harness. Nothing to pull.', 2);
  }
  const top = git(dir, 'rev-parse', '--show-toplevel');
  if (!top.ok || realpathSync(top.out) !== realpathSync(dir)) {
    return stop(`${dir} is not a git repo of its own. Make it one first:\n  git init && git add -A && git commit -m "My harness"\nthen run: node cos.mjs update --adopt`, 2);
  }
  if (mergeInProgress(dir)) return stop('a merge is already in progress. Finish or abort it (git merge --abort) first.', 2);
  const dirty = git(dir, 'status', '--porcelain', '--untracked-files=no').out;
  if (dirty) return stop(`you have uncommitted changes to tracked files:\n${dirty}\nCommit them (git commit -am "my changes") or set them aside, then run update again.`, 2);

  const remote = findUpstream(dir, from);
  if (!remote.ok) {
    return stop(`no remote called upstream${remote.err ? ` (${remote.err})` : ''}. Add the starter, then run update again:\n  git remote add upstream https://github.com/<owner>/claude-harness-starter.git`, 2);
  }
  if (remote.added) say(`added remote upstream ${remote.added}`);
  const fetched = git(dir, 'fetch', '-q', 'upstream');
  if (!fetched.ok) return stop(`git fetch upstream failed: ${fetched.err}`, 1);
  const tip = git(dir, 'rev-parse', '--verify', '-q', 'upstream/main^{commit}');
  if (!tip.ok) return stop('the starter has no main branch to update from', 1);
  if (git(dir, 'merge-base', '--is-ancestor', tip.out, 'HEAD').ok) {
    say('up to date');
    return 0;
  }

  const base = git(dir, 'merge-base', 'HEAD', tip.out);
  const related = base.ok && base.out;
  const news = newInChangelog(dir, related ? base.out : null);
  const count = related ? git(dir, 'rev-list', '--count', `HEAD..${tip.out}`).out : 'all';
  say(`${count} new starter commit${count === '1' ? '' : 's'}:`);
  say(news.length ? news.join('\n') : git(dir, 'log', '--format=- %s', '-n', '10', tip.out).out);
  if (check) return 0;

  if (!related && !adopt) {
    return stop(`your copy and the starter share no history (it was unzipped, or copied, not cloned). To join them once, run:\n  node cos.mjs update --adopt\nThe starter's version wins for every harness file, so your edits to them stay in your previous commit only. Your own files are kept.`, 2);
  }

  if (!related) {
    const differ = git(dir, 'diff', '--name-only', '--diff-filter=d', 'HEAD', tip.out).out.split('\n').filter((f) => f && !isUserFile(f));
    say(differ.length ? `the starter's version replaces these harness files (your edits stay in the previous commit):\n${differ.map((f) => `  ${f}`).join('\n')}` : 'no harness file differs from the starter');
  }

  const before = fingerprint(dir);
  const backup = backUp(dir);
  try {
    const merge = git(dir, 'merge', '--no-ff', '--no-commit', ...(related ? [] : ['--allow-unrelated-histories', '-X', 'theirs']), tip.out);
    const merging = mergeInProgress(dir);

    for (const spec of USER_FILES) {
      const tracked = git(dir, 'ls-tree', '-r', '--name-only', 'HEAD', '--', spec.replace(/\/$/, '')).out.split('\n').filter(Boolean);
      if (tracked.length) git(dir, 'checkout', 'HEAD', '--', ...tracked);
    }
    restoreChanged(dir, backup, before);

    const unmerged = git(dir, 'diff', '--name-only', '--diff-filter=U').out.split('\n').filter(Boolean);
    if (unmerged.length) {
      git(dir, 'merge', '--abort');
      restoreChanged(dir, backup, before);
      return stop(
        `could not merge cleanly; these files conflict:\n  ${unmerged.join('\n  ')}\nNothing was changed. To merge by hand: git merge upstream/main, fix the files, commit, then run: node cos.mjs update`,
        1,
      );
    }
    if (!merge.ok && !merging) return stop(`git merge failed before it started: ${merge.err}`, 1);

    const version = git(dir, 'show', 'upstream/main:HARNESS_VERSION').out.match(/^harness ([0-9a-f]{7,40})/m)?.[1] ?? tip.out;
    const commit = git(dir, 'commit', '-q', '-m', `Update from the starter (harness ${version.slice(0, 7)})`);
    if (!commit.ok) {
      git(dir, 'merge', '--abort');
      restoreChanged(dir, backup, before);
      return stop(`git commit failed: ${commit.err}`, 1);
    }
  } finally {
    rmSync(backup, { recursive: true, force: true });
  }
  say(related ? 'merged the starter into your copy' : 'joined your copy to the starter; its version won for every harness file, and your edits to them stay in the previous commit');

  let code = 0;
  if (install) {
    const r = spawnSync('sh', ['install.sh'], { cwd: dir, stdio: 'inherit' });
    if (r.status !== 0) code = 1;
  }
  if (tests) {
    const files = readdirSync(join(dir, 'test')).filter((f) => f.endsWith('.test.mjs')).map((f) => join('test', f));
    const r = spawnSync('node', ['--test', ...files], { cwd: dir, stdio: 'inherit' });
    if (r.status !== 0) {
      code = 1;
      console.error('cos update: merged, but the tests fail. Your files are untouched; the failing tests say what to fix.');
    }
  }
  return code;
}

export async function runCommand({ flags, harness }) {
  return update({
    dir: harness,
    check: !!flags.check,
    adopt: !!flags.adopt,
    from: typeof flags.from === 'string' ? flags.from : undefined,
    install: !flags['no-install'],
    tests: !flags['no-tests'],
  });
}

if (process.argv[1] && realpathSync(process.argv[1]) === realpathSync(fileURLToPath(import.meta.url))) {
  const args = process.argv.slice(2);
  const flags = {};
  for (let i = 0; i < args.length; i++) {
    const m = args[i].match(/^--(.+)$/);
    if (!m) continue;
    flags[m[1]] = m[1] === 'from' ? args[++i] : true;
  }
  process.exitCode = await runCommand({ flags, harness: dirname(fileURLToPath(import.meta.url)) });
}
