import { spawnSync } from 'node:child_process';
import { accessSync, constants as fsConstants, existsSync, mkdirSync, readdirSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, isAbsolute, join, resolve } from 'node:path';

const CLI_TIMEOUT_MS = 15_000;
const NAME = /^[A-Za-z_][A-Za-z0-9_]*$/;
const SLUG_PART = '[A-Za-z0-9._-]+';

/**
 * @typedef {{kind: 'github', repo: string} | {kind: 'vercel', project: string, environment: string} | {kind: 'local', path: string}} Target
 * @typedef {{name: string, where: string, target: Target, purpose: string, required: boolean, variable: boolean}} SecretSpec
 * @typedef {{name: string, where: string, purpose: string, required: boolean, status: 'present' | 'missing' | 'unknown', reason?: string, add?: string}} SecretResult
 */

const tilde = (p) => (p === homedir() || p.startsWith(`${homedir()}/`) ? `~${p.slice(homedir().length)}` : p);

function cli(cmd, args, cwd) {
  const r = spawnSync(cmd, args, {
    cwd,
    timeout: CLI_TIMEOUT_MS,
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'pipe'],
    env: { ...process.env, CI: '1', NO_COLOR: '1' },
  });
  const name = tilde(cmd).split('/').pop();
  if (r.error) return { ok: false, out: '', reason: r.error.code === 'ETIMEDOUT' ? `${name} timed out` : `${name} could not run: ${r.error.message}` };
  if (r.status !== 0) return { ok: false, out: '', err: r.stderr, reason: `${name} failed: ${failureLine(r.stderr) || `exit ${r.status}`}` };
  return { ok: true, out: r.stdout, err: r.stderr, reason: null };
}

/** The line of stderr that says what went wrong: the first `Error:` line, else the last non-empty one (the CLIs print a banner first). Never stdout, which can hold value prefixes. */
function failureLine(stderr) {
  const lines = String(stderr).split('\n').map((l) => l.trim()).filter(Boolean);
  return (lines.find((l) => l.startsWith('Error:')) ?? lines.at(-1) ?? '').slice(0, 200);
}

function findExecutable(name, env) {
  const override = env[`${name.toUpperCase()}_BIN`];
  if (override) return existsSync(override) ? override : null;
  const home = env.HOME || homedir();
  const dirs = [...String(env.PATH || '').split(':'), join(home, '.local/bin'), '/opt/homebrew/bin', '/usr/local/bin'];
  const cached = (() => {
    try {
      const root = join(home, '.npm/_npx');
      const mtime = (dir) => {
        try {
          return statSync(join(dir, name)).mtimeMs;
        } catch {
          return -1;
        }
      };
      return readdirSync(root)
        .map((d) => join(root, d, 'node_modules/.bin'))
        .sort((a, b) => mtime(b) - mtime(a));
    } catch {
      return [];
    }
  })();
  for (const dir of [...dirs, ...cached].filter((d) => d && isAbsolute(d))) {
    const p = join(dir, name);
    try {
      if (statSync(p).isFile()) {
        accessSync(p, fsConstants.X_OK);
        return p;
      }
    } catch {}
  }
  return null;
}

/** First checkout whose Vercel link names this project; the CLI scopes `env` commands to the linked project in its cwd. */
function linkedCheckout(project, target) {
  for (const dir of project.checkouts) {
    try {
      const link = JSON.parse(readFileSync(join(dir, '.vercel', 'project.json'), 'utf8'));
      if (link.projectName === target.project) return dir;
    } catch {}
  }
  return null;
}

/** A link file that exists but does not name its project, so it cannot be matched. */
const unnamedLink = (project) =>
  project.checkouts.find((dir) => {
    try {
      return !JSON.parse(readFileSync(join(dir, '.vercel', 'project.json'), 'utf8')).projectName;
    } catch {
      return false;
    }
  });

const localFile = (project, target) => (project.checkouts[0] ? resolve(project.checkouts[0], target.path) : null);

function listLocal(project, target) {
  const file = localFile(project, target);
  if (!file) return { names: new Set(), error: 'the project has no checkout' };
  if (!existsSync(project.checkouts[0])) return { names: new Set(), error: `checkout ${tilde(project.checkouts[0])} is not on this machine` };
  if (!existsSync(file)) return { names: new Set(), error: null };
  let text;
  try {
    text = readFileSync(file, 'utf8');
  } catch (e) {
    return { names: new Set(), error: `could not read ${tilde(file)}: ${e.code ?? 'error'}` };
  }
  const names = new Set();
  for (const line of text.split('\n')) {
    const text = line.trim().replace(/^export\s+/, '');
    if (!text || text.startsWith('#')) continue;
    const eq = text.indexOf('=');
    const name = (eq < 0 ? text : text.slice(0, eq)).trim();
    if (NAME.test(name)) names.add(name);
  }
  return { names, error: null };
}

function listGithub(project, target, ctx) {
  const names = new Set();
  const errors = [];
  for (const noun of ['secret', 'variable']) {
    const r = cli(ctx.gh, [noun, 'list', '-R', target.repo, '--json', 'name'], project.checkouts[0] ?? process.cwd());
    if (!r.ok) {
      errors.push(r.reason);
      continue;
    }
    try {
      for (const row of JSON.parse(r.out)) if (typeof row?.name === 'string') names.add(row.name);
    } catch {
      errors.push(`gh ${noun} list returned unparseable output`);
    }
  }
  return { names, error: errors[0] ?? null };
}

function listVercel(project, target, ctx) {
  const bin = findExecutable('vercel', ctx.env);
  if (!bin) return { names: new Set(), error: 'the vercel CLI is not installed' };
  const dir = linkedCheckout(project, target);
  if (!dir) {
    const unnamed = unnamedLink(project);
    const hint = unnamed ? `the link in ${tilde(unnamed)} does not name its project; re-run \`vercel link\` there` : 'run `vercel link` in it';
    return { names: new Set(), error: `no checkout is linked to Vercel project ${target.project} (${hint})` };
  }
  const r = cli(bin, ['env', 'ls', '--environment', target.environment], dir);
  if (!r.ok) return { names: new Set(), error: r.reason };
  const lines = r.out.split('\n');
  const header = lines.findIndex((l) => l.trim().split(/\s+/)[0]?.toLowerCase() === 'name');
  if (header < 0) {
    return /no environment variables/i.test(`${r.out}\n${r.err}`) ? { names: new Set(), error: null } : { names: new Set(), error: 'vercel env ls printed something unexpected' };
  }
  const names = new Set();
  for (const line of lines.slice(header + 1)) {
    const first = line.trim().split(/\s+/)[0];
    if (first && NAME.test(first)) names.add(first);
  }
  return { names, error: null };
}

const ghShown = (ctx) => (ctx.gh.includes('/') ? tilde(ctx.gh) : ctx.gh);

/** One row per `where` kind: how to parse it, whether it needs the network, how to list names, and the command that adds one. */
const KINDS = {
  github: {
    network: true,
    parse: (rest) => (new RegExp(`^${SLUG_PART}/${SLUG_PART}$`).test(rest) ? { kind: 'github', repo: rest } : null),
    key: (t) => t.repo,
    list: listGithub,
    add: (spec, _project, t, ctx) => `${ghShown(ctx)} ${spec.variable ? 'variable' : 'secret'} set ${spec.name} -R ${t.repo}`,
  },
  vercel: {
    network: true,
    parse: (rest) => {
      const m = rest.match(new RegExp(`^(${SLUG_PART})(?::(${SLUG_PART}))?$`));
      return m ? { kind: 'vercel', project: m[1], environment: m[2] ?? 'production' } : null;
    },
    key: (t) => `${t.project}:${t.environment}`,
    list: listVercel,
    add: ({ name }, project, t) => {
      const dir = linkedCheckout(project, t) ?? project.checkouts[0];
      return `${dir ? `cd ${tilde(dir)} && ` : ''}vercel env add ${name} ${t.environment}`;
    },
  },
  local: {
    network: false,
    parse: (rest) => (rest && !isAbsolute(rest) && !rest.startsWith('~') && !rest.split(/[\\/]/).includes('..') ? { kind: 'local', path: rest } : null),
    key: (t) => t.path,
    list: listLocal,
    add: ({ name }, project, t) => `add ${name}=... to ${localFile(project, t) ?? t.path}`,
  },
};

const WHERE_GRAMMAR = 'github:<owner/repo> | vercel:<project>[:<environment>] | local:<path relative to the first checkout>';

/** @returns {Target} */
export function parseWhere(where) {
  const m = typeof where === 'string' ? where.match(/^([a-z]+):(.*)$/) : null;
  const target = m && KINDS[m[1]]?.parse(m[2]);
  if (!target) throw new Error(`bad secret location ${JSON.stringify(where)}; use ${WHERE_GRAMMAR}`);
  return target;
}

/** @returns {SecretSpec[]} */
export function parseSecrets(raw, label) {
  if (raw === undefined) return [];
  if (!Array.isArray(raw)) throw new Error(`${label}: secrets must be an array`);
  return raw.map((s, i) => {
    const at = `${label}: secrets[${i}]`;
    if (typeof s?.name !== 'string' || !NAME.test(s.name)) throw new Error(`${at} needs a name like API_URL`);
    let target;
    try {
      target = parseWhere(s.where);
    } catch (e) {
      throw new Error(`${at} (${s.name}): ${e.message}`);
    }
    return {
      name: s.name,
      where: s.where,
      target,
      purpose: typeof s.purpose === 'string' ? s.purpose : '',
      required: s.required !== false,
      variable: s.variable === true,
    };
  });
}

/**
 * Presence by name only. Offline skips the kinds that need the network, leaving them unknown.
 * @param {{id: string, name: string, checkouts: string[], secrets: SecretSpec[]}[]} projects
 * @returns {{id: string, name: string, secrets: SecretResult[]}[]}
 */
export function checkSecrets(projects, { online = true, gh = 'gh', env = process.env } = {}) {
  const ctx = { gh, env };
  const memo = new Map();
  return projects
    .filter((p) => p.secrets.length)
    .map((p) => ({
      id: p.id,
      name: p.name,
      secrets: p.secrets.map((s) => {
        const kind = KINDS[s.target.kind];
        const base = { name: s.name, where: s.where, purpose: s.purpose, required: s.required };
        if (kind.network && !online) return { ...base, status: 'unknown', reason: 'skipped (network checks are off)' };
        const key = `${p.id}|${s.target.kind}|${kind.key(s.target)}`;
        if (!memo.has(key)) memo.set(key, kind.list(p, s.target, ctx));
        const { names, error } = memo.get(key);
        if (names.has(s.name)) return { ...base, status: 'present' };
        if (error) return { ...base, status: 'unknown', reason: error };
        return { ...base, status: 'missing', add: kind.add(s, p, s.target, ctx) };
      }),
    }));
}

export const CACHE_MAX_AGE_MS = 30 * 60_000;

const cacheKey = (p, s) => `${p.id}|${s.name}|${s.where}`;

function readCache(file, now) {
  try {
    const c = JSON.parse(readFileSync(file, 'utf8'));
    return c && c.at <= now && now - c.at < CACHE_MAX_AGE_MS && c.entries && typeof c.entries === 'object' ? c.entries : null;
  } catch {
    return null;
  }
}

/**
 * The online checks, reusing results under 30 minutes old unless `refresh`. Offline never reads the cache.
 * The cache file holds names, statuses, reasons and add commands for present or missing network secrets, never CLI output.
 * Unknown results are not cached, so a fixed login is noticed on the next run.
 */
export function resolveSecrets(projects, { online = true, refresh = false, cacheFile, now = Date.now(), ...opts } = {}) {
  if (!online) return checkSecrets(projects, { ...opts, online: false });
  const network = projects.flatMap((p) => p.secrets.filter((s) => KINDS[s.target.kind].network).map((s) => ({ p, s })));
  const cached = refresh || !cacheFile ? null : readCache(cacheFile, now);
  if (cached && network.every(({ p, s }) => cached[cacheKey(p, s)])) {
    const results = checkSecrets(projects, { ...opts, online: false });
    for (const r of results) {
      const project = projects.find((p) => p.id === r.id);
      r.secrets = r.secrets.map((res, i) => {
        const spec = project.secrets[i];
        if (!KINDS[spec.target.kind].network) return res;
        const { status, add } = cached[cacheKey(project, spec)];
        return { name: res.name, where: res.where, purpose: res.purpose, required: res.required, status, ...(add && { add }) };
      });
    }
    return results;
  }
  const results = checkSecrets(projects, { ...opts, online: true });
  if (cacheFile) {
    const entries = {};
    for (const { p, s } of network) {
      const res = results.find((r) => r.id === p.id).secrets[p.secrets.indexOf(s)];
      if (res.status !== 'unknown') entries[cacheKey(p, s)] = { status: res.status, ...(res.add && { add: res.add }) };
    }
    try {
      mkdirSync(dirname(cacheFile), { recursive: true });
      writeFileSync(cacheFile, JSON.stringify({ at: now, entries }));
    } catch {}
  }
  return results;
}

const missingRequired = (results) =>
  results.flatMap((p) => p.secrets.filter((s) => s.required && s.status === 'missing').map((s) => ({ project: p, secret: s })));

/** Adds `secrets` to each declared project in a status report, and a "Needs you" entry for every missing required one. */
export function attachSecretsToStatus(report, projects, opts) {
  const results = resolveSecrets(projects, opts);
  for (const r of results) {
    const entry = report.find((p) => p.id === r.id);
    if (entry) entry.secrets = r.secrets;
  }
  for (const { project, secret } of missingRequired(results)) {
    const first = report.find((p) => p.id === project.id)?.checkouts[0];
    first?.attention.push({ rule: 'missing-secret', message: `missing secret ${secret.name} (${secret.where})` });
  }
}

function section(title, rows) {
  return rows.length ? [title, '', ...rows.flatMap((r) => [...r, ''])] : [];
}

export function renderSecrets(results) {
  const rows = (pick, detail) =>
    results.flatMap((p) =>
      p.secrets.filter(pick).map((s) => [`- **${p.name}**: ${s.name} (${s.where})`, ...detail(s).map((d) => `  ${d}`)]),
    );
  const all = results.flatMap((p) => p.secrets);
  if (!all.length) return 'No secrets declared in projects.json.';
  const breaks = (s) => (s.purpose ? [`Breaks: ${s.purpose}`] : []);
  const lines = [
    ...section('# Missing, required', rows((s) => s.required && s.status === 'missing', (s) => [...breaks(s), `Add it: ${s.add}`])),
    ...section('# Missing, optional', rows((s) => !s.required && s.status === 'missing', (s) => [...breaks(s), `Add it: ${s.add}`])),
    ...section("# Can't check", rows((s) => s.status === 'unknown', (s) => [`Why: ${s.reason}`])),
    `${all.filter((s) => s.status === 'present').length} present of ${all.length} declared.`,
  ];
  return lines.join('\n');
}

export function secretsJson(results) {
  const all = results.flatMap((p) => p.secrets);
  const count = (status) => all.filter((s) => s.status === status).length;
  return { projects: results, summary: { present: count('present'), missing: count('missing'), unknown: count('unknown') } };
}

const localDate = (d = new Date()) =>
  `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;

const cell = (s) => String(s).replaceAll('|', '/').replace(/\s+/g, ' ');

function pageBody(projects) {
  const declared = projects.filter((p) => p.secrets.length);
  const lines = [
    '# Secrets',
    '',
    'Every secret a project needs, where it goes, and what stops working without it. Names only, never values. Generated from `projects.json` by `node cos.mjs secrets --write-page`, so edit the inventory there, not here. For what is set right now, run `node cos.mjs secrets`.',
    '',
  ];
  if (!declared.length) lines.push('No secrets are declared yet. See [[topics/release-policy]] for what else the owner reviews.', '');
  for (const p of declared) {
    lines.push(`## [[projects/${p.id}]]`, '', '| Name | Where it goes | What it powers | Required |', '| --- | --- | --- | --- |');
    for (const s of p.secrets) lines.push(`| ${s.name} | ${cell(s.where)} | ${cell(s.purpose || 'not described')} | ${s.required ? 'yes' : 'no'} |`);
    lines.push('');
  }
  return lines.join('\n');
}

/** Rewrites wiki/topics/secrets.md; leaves it untouched (date included) when the inventory is unchanged. */
export function writeSecretsPage(projects, wikiDir, today = localDate()) {
  const file = join(wikiDir, 'topics', 'secrets.md');
  const body = pageBody(projects);
  const prior = existsSync(file) ? readFileSync(file, 'utf8') : '';
  if (prior.endsWith(`---\n\n${body}`)) return { file, changed: false };
  mkdirSync(join(wikiDir, 'topics'), { recursive: true });
  const doc = `---\nupdated: ${today}\nsources:\n  - "projects.json"\ntags: [topic, secrets]\n---\n\n${body}`;
  writeFileSync(file, doc);
  return { file, changed: true };
}
