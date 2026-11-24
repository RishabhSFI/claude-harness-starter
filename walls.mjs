#!/usr/bin/env node
// PreToolUse hook on Bash: turns three CLAUDE.md rules into walls.
//   1. `git push` goes only to `origin` (a named remote, a URL, or the branch's default push remote).
//   2. `gh pr ...` and `gh repo ...` name the repo (-R/--repo) and it is the owner/repo of the folder's origin.
//   3. `gh pr merge` runs only when `cos.mjs pr-check` passes: checks green, a named reviewer (Opus for risky
//      diffs), Asked vs delivered with a scope pass, a Security audit line, and no open owner questions on a public base.
// Any error of its own lets the command through (exit 0, no output), so a bug here never blocks all Bash.
import { spawnSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { basename, dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const HARNESS = dirname(fileURLToPath(import.meta.url));

export const OPEN = '(';
export const CLOSE = ')';

const HEREDOC = /^<<(-?)[ \t]*(['"]?)([A-Za-z0-9_.-]+)\2/;

/** At a `<<`, the heredoc it starts ({delim, strip, end: index past the delimiter word}), or null. */
function heredocAt(src, i) {
  if (src[i + 2] === '<' || src[i - 1] === '<') return null;
  const m = src.slice(i, i + 200).match(HEREDOC);
  return m ? { delim: m[3], strip: m[1] === '-', end: i + m[0].length } : null;
}

/** From the newline at `nl`, skips the bodies of the pending heredocs; returns the newline that ends the last one. */
function skipBodies(src, nl, pending) {
  let i = nl;
  for (const { delim, strip } of pending.splice(0)) {
    while (i < src.length) {
      const next = src.indexOf('\n', i + 1);
      const line = src.slice(i + 1, next < 0 ? src.length : next);
      i = next < 0 ? src.length : next;
      if ((strip ? line.replace(/^\t+/, '') : line) === delim) break;
    }
  }
  return i;
}

/** Index just past the `)` that closes the `$(` whose `(` is at `at`. Skips quoted text and heredoc bodies. */
function closeParen(src, at) {
  let depth = 0;
  const pending = [];
  for (let i = at; i < src.length; i++) {
    const c = src[i];
    if (c === '\\') i++;
    else if (c === "'") {
      const j = src.indexOf("'", i + 1);
      i = j < 0 ? src.length : j;
    } else if (c === '"') {
      for (i++; i < src.length && src[i] !== '"'; i++) if (src[i] === '\\') i++;
    } else if (c === '<' && src[i + 1] === '<') {
      const h = heredocAt(src, i);
      if (h) {
        pending.push(h);
        i = h.end - 1;
      } else i += 2;
    } else if (c === '\n' && pending.length) i = skipBodies(src, i, pending);
    else if (c === '(') depth++;
    else if (c === ')' && --depth === 0) return i + 1;
  }
  return src.length;
}

/** Index of the backtick that closes the one at `at`. */
function closeTick(src, at) {
  for (let i = at + 1; i < src.length; i++) {
    if (src[i] === '\\') i++;
    else if (src[i] === '`') return i;
  }
  return src.length;
}

/**
 * Splits a shell command into simple commands, each a list of words, with quotes removed.
 * Separators: && || ; | & newline. A subshell `( ... )` comes out as [OPEN], its commands, [CLOSE];
 * so does a `$( ... )` or backtick substitution, even inside double quotes. Heredoc bodies are
 * text, not commands, and are skipped. Best effort: no globbing.
 * @returns {string[][]}
 */
export function splitCommands(src) {
  const cmds = [];
  const subs = [];
  const heredocs = [];
  let words = [];
  let word = '';
  let inWord = false;
  const endWord = () => {
    if (inWord) words.push(word);
    word = '';
    inWord = false;
  };
  const endCmd = () => {
    endWord();
    if (words.length) cmds.push(words);
    words = [];
    for (const inner of subs.splice(0)) cmds.push([OPEN], ...splitCommands(inner), [CLOSE]);
  };
  const substitution = (i) => {
    const end = src[i] === '`' ? closeTick(src, i) : closeParen(src, i + 1);
    subs.push(src[i] === '`' ? src.slice(i + 1, end) : src.slice(i + 2, end - 1));
    word += src.slice(i, end + (src[i] === '`' ? 1 : 0));
    inWord = true;
    return src[i] === '`' ? end : end - 1;
  };
  for (let i = 0; i < src.length; i++) {
    const c = src[i];
    if (c === "'") {
      const j = src.indexOf("'", i + 1);
      word += j < 0 ? src.slice(i + 1) : src.slice(i + 1, j);
      inWord = true;
      i = j < 0 ? src.length : j;
    } else if (c === '"') {
      inWord = true;
      for (i++; i < src.length && src[i] !== '"'; i++) {
        if (src[i] === '`' || (src[i] === '$' && src[i + 1] === '(')) {
          i = substitution(i);
          continue;
        }
        if (src[i] === '\\' && i + 1 < src.length && '"\\$`\n'.includes(src[i + 1])) i++;
        word += src[i];
      }
    } else if (c === '`') i = substitution(i);
    else if (c === '$' && src[i + 1] === '(' && src[i + 2] === '(') {
      const end = closeParen(src, i + 1);
      word += src.slice(i, end);
      inWord = true;
      i = end - 1;
    } else if (c === '$' && src[i + 1] === '(') i = substitution(i);
    else if (c === '\\') {
      if (src[i + 1] !== '\n') {
        word += src[i + 1] ?? '';
        inWord = true;
      }
      i++;
    } else if (c === '#' && !inWord) {
      while (i < src.length && src[i] !== '\n') i++;
      endCmd();
    } else if (c === '<' && src[i + 1] === '<' && heredocAt(src, i)) {
      endWord();
      const h = heredocAt(src, i);
      heredocs.push(h);
      i = h.end - 1;
    } else if (c === '\n') {
      endCmd();
      if (heredocs.length) i = skipBodies(src, i, heredocs);
    } else if (' \t'.includes(c)) endWord();
    else if (c === '(' || c === ')') {
      endCmd();
      cmds.push([c === '(' ? OPEN : CLOSE]);
    } else if (';&|\n'.includes(c)) endCmd();
    else {
      word += c;
      inWord = true;
    }
  }
  endCmd();
  return cmds;
}

const ENV_ASSIGN = /^[A-Za-z_][A-Za-z0-9_]*=/;
// Prefix commands that run the rest of the line, with the options of theirs that take a value.
const WRAPPERS = {
  command: [],
  builtin: [],
  exec: ['-a'],
  time: [],
  nohup: [],
  env: ['-u', '--unset', '-C', '--chdir', '-S', '--split-string'],
  sudo: ['-u', '--user', '-g', '--group', '-U', '--other-user', '-C', '--close-from', '-D', '--chdir', '-h', '--host', '-p', '--prompt', '-r', '--role', '-t', '--type', '-T', '--command-timeout'],
  nice: ['-n', '--adjustment'],
  stdbuf: ['-i', '-o', '-e', '--input', '--output', '--error'],
  caffeinate: ['-t', '-w'],
  xargs: ['-I', '-J', '-L', '-n', '-P', '-R', '-s', '-S', '-d', '-E', '-a'],
  timeout: ['-s', '--signal', '-k', '--kill-after'],
};
const SHELLS = new Set(['sh', 'bash', 'zsh', 'dash']);
const REMOTE_CONFIG = /^(remote\.|url\.|branch\.[^=]*\.(remote|pushremote)=)/i;

/** Drops `FOO=1`, `env`, `sudo`, `timeout 30` and similar prefixes. Returns {env, words}. */
function unwrap(words) {
  const env = {};
  let i = 0;
  while (i < words.length) {
    const w = words[i];
    if (ENV_ASSIGN.test(w)) {
      env[w.slice(0, w.indexOf('='))] = w.slice(w.indexOf('=') + 1);
      i++;
      continue;
    }
    const valued = WRAPPERS[basename(w)];
    if (!valued) break;
    for (i++; i < words.length && words[i].startsWith('-'); i++) if (valued.includes(words[i])) i++;
    if (basename(w) === 'timeout') i++;
  }
  return { env, words: words.slice(i) };
}

/** `owner/repo` (lowercase) from `[HOST/]OWNER/REPO`, a github URL or an scp-style remote; null otherwise. */
export function repoOf(s) {
  const t = String(s ?? '').trim().replace(/\.git\/?$/, '').replace(/\/$/, '');
  const url = t.match(/github\.com[:/]+([^/\s]+)\/([^/\s#?]+)/i);
  if (url) return `${url[1]}/${url[2]}`.toLowerCase();
  const bare = t.match(/^(?:[\w.-]+\/)?([\w.-]+)\/([\w.-]+)$/);
  if (bare && !t.includes(':')) return `${bare[1]}/${bare[2]}`.toLowerCase();
  return null;
}

const looksLikeUrl = (s) => /^[a-z][a-z0-9+.-]*:\/\//i.test(s) || /^[^/\s]+@[^:\s]+:/.test(s) || /^file:/.test(s) || s.startsWith('/') || s.startsWith('.') || s.startsWith('~');

function git(cwd, args) {
  const r = spawnSync('git', ['-C', cwd, ...args], { encoding: 'utf8', timeout: 5000 });
  return r.status === 0 ? r.stdout.trim() : null;
}

/** The default deps: real git and the real pr-check. Tests swap pr-check through GH_BIN (cos-tools reads it). */
export const realDeps = {
  originUrl: (cwd) => git(cwd, ['remote', 'get-url', 'origin']),
  config: (cwd, key) => git(cwd, ['config', '--get', key]),
  branch: (cwd) => git(cwd, ['symbolic-ref', '--quiet', '--short', 'HEAD']),
  prCheck: (ref) => {
    const r = spawnSync(process.execPath, [join(HARNESS, 'cos.mjs'), 'pr-check', ref], { encoding: 'utf8', timeout: 60_000 });
    return { code: r.status, out: `${r.stdout ?? ''}${r.stderr ?? ''}`, error: r.error?.message };
  },
};

const expandHome = (p) => {
  const t = p.replace(/^(\$HOME|\$\{HOME\})(?=\/|$)/, '~');
  return t === '~' ? homedir() : t.startsWith('~/') ? join(homedir(), t.slice(2)) : t;
};

// ---- git push ----

const GIT_GLOBAL_VALUE = new Set(['-C', '-c', '--git-dir', '--work-tree', '--namespace', '--exec-path', '--config-env']);
const PUSH_VALUE = new Set(['-o', '--push-option', '--receive-pack', '--exec']);

/** Returns a reason string when this `git ...` invocation pushes somewhere other than origin, else null. */
function checkGit(args, cwd, deps) {
  let dir = cwd;
  let override = null;
  let i = 0;
  for (; i < args.length; i++) {
    const a = args[i];
    if (!a.startsWith('-')) break;
    if (a === '-C') dir = resolve(dir, expandHome(args[++i] ?? '.'));
    else if (a === '-c' && REMOTE_CONFIG.test(args[i + 1] ?? '')) override = args[++i];
    else if (GIT_GLOBAL_VALUE.has(a)) i++;
  }
  if (args[i] !== 'push') return null;
  if (override) return `\`git -c ${override} push\` changes where the push goes. Push only to origin as configured: \`git push origin <branch>\`.`;
  let remote = null;
  for (let j = i + 1; j < args.length; j++) {
    const a = args[j];
    if (a === '--') {
      remote ??= args[j + 1] ?? null;
      break;
    }
    if (a.startsWith('--repo=')) remote = a.slice(7);
    else if (a === '--repo') remote = args[++j] ?? null;
    else if (PUSH_VALUE.has(a)) j++;
    else if (!a.startsWith('-')) {
      remote ??= a;
      break;
    }
  }
  if (remote === null) {
    const b = deps.branch(dir);
    remote = (b && deps.config(dir, `branch.${b}.pushRemote`)) || deps.config(dir, 'remote.pushDefault') || (b && deps.config(dir, `branch.${b}.remote`)) || 'origin';
    if (remote === 'origin') return null;
    return `\`git push\` with no remote would push to "${remote}" (this branch's default push remote), not origin. Push only to origin: \`git push origin <branch>\`.`;
  }
  if (remote === 'origin') return null;
  if (looksLikeUrl(remote)) {
    const target = repoOf(remote);
    const origin = repoOf(deps.originUrl(dir));
    if (target && origin && target === origin) return null;
    return `\`git push ${remote}\` pushes to a URL, not to origin${origin ? ` (${origin})` : ''}. Push only to origin: \`git push origin <branch>\`.`;
  }
  return `\`git push ${remote}\` pushes to the "${remote}" remote. Push only to origin, never to another remote such as someone else's upstream: \`git push origin <branch>\`.`;
}

// ---- gh pr / gh repo ----

// `gh repo` subcommands that don't act on the folder's repo: making a new one, listing, copying someone else's.
const REPO_FREE = new Set(['create', 'new', 'list', 'ls', 'clone', 'fork', 'gitignore', 'license', 'help']);
const MERGE_VALUE = new Set(['-b', '--body', '-F', '--body-file', '-t', '--subject', '-A', '--author-email', '--match-head-commit', '-R', '--repo']);
const PR_URL = /^https?:\/\/github\.com\/([^/]+\/[^/]+)\/pull\/(\d+)/i;

/** Takes -R/--repo out of the arguments wherever it sits (gh accepts it before the subcommand too). */
function takeRepoFlag(args) {
  let repo = null;
  const rest = [];
  for (let j = 0; j < args.length; j++) {
    const a = args[j];
    if (a === '-R' || a === '--repo') repo = args[++j] ?? '';
    else if (a.startsWith('--repo=')) repo = a.slice(7);
    else if (/^-R[^-\s]*\/./.test(a)) repo = a.slice(2);
    else rest.push(a);
  }
  return { repo, rest };
}

/** @returns {string | null} a reason to block, or null */
function checkGh(all, env, cwd, deps) {
  const { repo: flagged, rest: args } = takeRepoFlag(all);
  const group = args[0];
  if (group !== 'pr' && group !== 'repo') return null;
  const sub = args[1];
  const help = (a) => a === '--help' || a === '-h';
  if (!sub || sub.startsWith('-') || sub === 'help' || help(args[2] ?? '') || (help(args.at(-1)) && !args.at(-2).startsWith('-'))) return null;
  if (group === 'repo' && REPO_FREE.has(sub)) return null;

  const rest = args.slice(2);
  // Most `gh repo` subcommands take the repo as an argument instead of -R. Every repo-shaped argument
  // must be the origin, since an option value (`--source x/y`) can name a repo too.
  const repoArgs = group === 'repo' ? rest.filter((a) => !a.startsWith('-') && repoOf(a)) : [];
  const url = rest.map((a) => a.match(PR_URL)).find(Boolean);
  const named = flagged ?? env.GH_REPO ?? url?.[1] ?? repoArgs[0] ?? null;
  // After `cd $X` the folder is unknown: trust the named repo, but a merge still goes through pr-check.
  const origin = cwd === null ? repoOf(named) : repoOf(deps.originUrl(cwd));
  if (cwd === null && !origin) return null;
  const cmd = `gh ${group} ${sub}`;
  if (!origin) return `\`${cmd}\` runs in ${cwd}, which has no GitHub origin remote, so its repo can't be checked. cd into the project's folder first and pass -R <owner/repo of its origin>.`;
  if (named === null) return `\`${cmd}\` names no repo. Pass ${group === 'repo' ? 'as its argument the repo' : '-R'} ${origin}, the owner/repo of this folder's origin; without it gh may pick another remote such as upstream.`;
  const other = [named, ...repoArgs].find((r) => repoOf(r) !== origin);
  if (other) return `\`${cmd}\` targets ${other}, but this folder's origin is ${origin}. Act only on your own repo: pass -R ${origin}, or cd into that repo's folder first.`;
  if (url && url[1].toLowerCase() !== origin) return `\`${cmd}\` names a PR in ${url[1]}, but this folder's origin is ${origin}.`;

  if (group === 'pr' && sub === 'merge') return checkMerge(rest, origin, url, deps, env);
  return null;
}

function checkMerge(rest, origin, url, deps, env = {}) {
  let number = url ? url[2] : null;
  for (let j = 0; j < rest.length && !number; j++) {
    const a = rest[j];
    if (MERGE_VALUE.has(a)) j++;
    else if (/^#?\d+$/.test(a)) number = a.replace('#', '');
    else if (!a.startsWith('-')) return `\`gh pr merge ${a}\`: name the PR by number so its checks can be read first.`;
  }
  if (!number) return '`gh pr merge` with no PR number: name the PR by number so its checks can be read first.';
  const ref = `${origin}#${number}`;
  const r = deps.prCheck(ref);
  const out = (r.out ?? '').split('\n');
  if (env.HARNESS_AUTOMERGE === '1') return checkAutoMerge(rest, ref, r, out);
  if (r.code === 0 && /^pr-check \S+: PASS\b/.test(out[0] ?? '')) return null;
  // Only lines before the fenced PR text are check output; the PR body itself is untrusted.
  const fence = out.findIndex((l) => l.startsWith('--- BEGIN'));
  const failing = out.slice(1, fence < 0 ? undefined : fence).filter((l) => /^[\w-]+: FAIL\b/.test(l));
  const why = failing.length ? failing.join('; ') : r.error ? `pr-check did not finish (${r.error})` : out.join(' ').trim().slice(0, 300) || `pr-check exited ${r.code}`;
  return `\`gh pr merge\` blocked: ${ref} is not ready. pr-check says ${why}. Fix each FAIL line as it says, then run \`node ${join(HARNESS, 'cos.mjs')} pr-check ${ref}\` and merge once it shows PASS.`;
}

/**
 * The PR steward's own merge (`HARNESS_AUTOMERGE=1 gh pr merge N -R repo --squash --delete-branch --match-head-commit <sha>`).
 * Allowed only when pr-check says "auto-merge: pass - ELIGIBLE head=<sha>" (routine tier, private base, clean review of that
 * commit, every step passing) and the command is exactly that shape with the same sha. Anything else is denied.
 * A merge without HARNESS_AUTOMERGE is the hub's, after the owner's yes, and is checked as before.
 */
function checkAutoMerge(rest, ref, r, out) {
  const deny = (why) => `auto-merge of ${ref} blocked: ${why}. Only a routine PR into a private branch with a clean review of its latest commit may merge without the owner's yes; list this one for the owner instead.`;
  const flags = [];
  let match = null;
  for (let j = 0; j < rest.length; j++) {
    const a = rest[j];
    if (/^#?\d+$/.test(a)) continue;
    if (a === '--match-head-commit') match = rest[++j] ?? '';
    else if (a.startsWith('--match-head-commit=')) match = a.slice(20);
    else flags.push(a);
  }
  if (flags.length !== 2 || !flags.includes('--squash') || !flags.includes('--delete-branch')) return deny('the flags must be exactly --squash --delete-branch --match-head-commit <sha>');
  const fence = out.findIndex((l) => l.startsWith('--- BEGIN'));
  const head = out.slice(1, fence < 0 ? undefined : fence).map((l) => l.match(/^auto-merge: pass - ELIGIBLE head=([0-9a-f]{40})\b/)).find(Boolean);
  if (r.code !== 0 || !head) return deny(r.error ? `pr-check did not finish (${r.error})` : 'pr-check does not show "auto-merge: pass - ELIGIBLE"');
  if (match?.toLowerCase() !== head[1]) return deny('--match-head-commit must be the exact commit pr-check reviewed');
  return null;
}

// ---- the whole command ----

/**
 * @param {string} command the Bash command
 * @param {string} cwd the folder it runs in
 * @returns {string | null} why it is blocked, or null to let it run
 */
export function decide(command, cwd, deps = realDeps, depth = 0) {
  if (/harness-steward\.key/.test(command) && !/\bcos\.mjs['"]?\s+pr-marker\b/.test(command)) return "the PR steward's signing key (harness-steward.key) is read only by `cos.mjs pr-marker`; a review can't be signed by hand.";
  if (!/\b(git|gh)\b/.test(command)) return null;
  let dir = cwd;
  const saved = [];
  for (const raw of splitCommands(command)) {
    if (raw.length === 1 && raw[0] === OPEN) {
      saved.push(dir);
      continue;
    }
    if (raw.length === 1 && raw[0] === CLOSE) {
      if (saved.length) dir = saved.pop();
      continue;
    }
    const { env, words } = unwrap(raw);
    if (!words.length) continue;
    const name = basename(words[0]);
    const args = words.slice(1);
    if (name === 'cd' || name === 'pushd') {
      const target = args.find((a) => !a.startsWith('-') || a === '-');
      if (target === '-') continue;
      const t = expandHome(target ?? '~');
      // A folder named by a variable or command can't be known here; checks that need it are skipped.
      dir = dir === null || /[$`]/.test(t) ? null : resolve(dir, t);
      continue;
    }
    if (name === 'eval' && depth < 3) {
      const inner = decide(args.join(' '), dir, deps, depth + 1);
      if (inner) return inner;
      continue;
    }
    if (SHELLS.has(name) && depth < 3) {
      const c = args.indexOf('-c');
      const flagC = c >= 0 ? c : args.findIndex((a) => /^-[a-z]*c[a-z]*$/.test(a));
      if (flagC >= 0 && args[flagC + 1] != null) {
        const inner = decide(args[flagC + 1], dir, deps, depth + 1);
        if (inner) return inner;
      }
      continue;
    }
    const reason = name === 'git' ? checkGit(args, dir ?? cwd, deps) : name === 'gh' ? checkGh(args, env, dir, deps) : null;
    if (reason) return reason;
  }
  return null;
}

/** Reads the hook input, prints a deny decision when a wall applies. Never throws. */
export function main(stdin, deps = realDeps, write = (s) => process.stdout.write(s)) {
  try {
    const input = JSON.parse(stdin);
    if (input?.tool_name !== 'Bash') return;
    const command = input?.tool_input?.command;
    if (typeof command !== 'string') return;
    const reason = decide(command, input.cwd || process.cwd(), deps);
    if (!reason) return;
    write(JSON.stringify({ hookSpecificOutput: { hookEventName: 'PreToolUse', permissionDecision: 'deny', permissionDecisionReason: `Harness wall (walls.mjs): ${reason}` } }));
  } catch {
    // fail open: a bug in this hook must never block Bash
  }
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  let stdin = '';
  try {
    stdin = readFileSync(0, 'utf8');
  } catch {}
  main(stdin);
  process.exitCode = 0;
}
