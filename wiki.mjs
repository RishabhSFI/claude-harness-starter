#!/usr/bin/env node
// A project wiki kept by the LLM, after Karpathy's "LLM Wiki" pattern.
// This script only checks, copies raw sources in, finds pages and searches.
// The LLM writes the pages. See wiki/WIKI.md for the schema.
import { spawnSync } from 'node:child_process';
import { appendFileSync, existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { basename, dirname, extname, join, relative, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';

const SELF_DIR = dirname(fileURLToPath(import.meta.url));
const STALE_DAYS = 14;
const DAY_MS = 86_400_000;
const SPECIAL = new Set(['WIKI.md', 'index.md', 'log.md', 'README.md']);
const PAGE_DIRS = ['projects', 'people', 'vendors', 'topics'];
const DATE = /^\d{4}-\d{2}-\d{2}$/;
const LOG_HEADING = /^## \[\d{4}-\d{2}-\d{2}\] [a-z]+ \| \S/;
const VALUE_FLAGS = new Set(['wiki', 'registry', 'title', 'origin', 'date']);
const PROJECT_ID = /^[a-z0-9-]+$/;

/**
 * @typedef {'special' | 'page' | 'raw' | 'template'} Kind
 * @typedef {{rel: string, kind: Kind, meta: Record<string, string | string[]> | null, text: string, links: string[]}} Page
 * @typedef {{id: string, name: string, what: string, checkouts: string[]}} Project
 * @typedef {{wikiDir: string, pages: Page[], files: Set<string>, projects: Project[], lastCommit: (p: Project) => Date | null, today: Date}} Wiki
 * @typedef {{file: string, detail: string}} Finding
 */

const expandHome = (p) => (p === '~' ? homedir() : p.startsWith('~/') ? join(homedir(), p.slice(2)) : p);
const tilde = (p) => (p.startsWith(homedir() + sep) ? `~${p.slice(homedir().length)}` : p);
const stripMd = (p) => p.replace(/\.md$/i, '');
const toPosix = (p) => p.split(sep).join('/');

function localDate(d = new Date()) {
  const pad = (n) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
}

function parseDate(s) {
  if (typeof s !== 'string' || !DATE.test(s)) return null;
  const d = new Date(`${s}T00:00:00`);
  return Number.isNaN(d.getTime()) || localDate(d) !== s ? null : d;
}

/** A small YAML subset: `key: value`, `key: [a, b]`, and `key:` followed by `  - item` lines. */
export function parseFrontmatter(text) {
  const m = text.match(/^---\r?\n([\s\S]*?)\r?\n---(?:\r?\n|$)/);
  if (!m) return null;
  const unquote = (s) => s.trim().replace(/^(["'])(.*)\1$/, '$2');
  const meta = {};
  let listKey = null;
  for (const line of m[1].split(/\r?\n/)) {
    const item = line.match(/^\s+-\s+(.*)$/);
    if (item && listKey) {
      meta[listKey].push(unquote(item[1]));
      continue;
    }
    const kv = line.match(/^([A-Za-z0-9_-]+):\s*(.*)$/);
    if (!kv) continue;
    const [, key, value] = kv;
    listKey = null;
    if (value === '') {
      meta[key] = [];
      listKey = key;
    } else if (value.startsWith('[') && value.endsWith(']')) {
      meta[key] = value.slice(1, -1).split(',').map(unquote).filter(Boolean);
    } else {
      meta[key] = unquote(value);
    }
  }
  return meta;
}

/** Drops fenced blocks (``` or ~~~, 3 or more, indented or not) and code spans of any backtick count. */
function withoutCode(text) {
  const kept = [];
  let fence = null;
  for (const line of text.split('\n')) {
    const open = line.match(/^\s*(`{3,}|~{3,})/);
    if (fence) {
      const close = line.match(/^\s*(`{3,}|~{3,})\s*$/);
      if (close && close[1][0] === fence[0] && close[1].length >= fence.length) fence = null;
    } else if (open) fence = open[1];
    else kept.push(line);
  }
  return kept.join('\n').replace(/(?<!`)(`+)(?!`)[\s\S]*?(?<!`)\1(?!`)/g, '');
}

/** Targets of [[links]], ignoring code. `[[page\\|Alias]]` is the table-safe form of `[[page|Alias]]`. */
export function linksIn(text) {
  return [...withoutCode(text).matchAll(/\[\[([^\]\n]*)\]\]/g)].map((m) =>
    m[1].split('|')[0].replace(/\\$/, '').split('#')[0].trim(),
  );
}

function walk(dir, root = dir, out = []) {
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    if (entry.name.startsWith('.')) continue;
    const full = join(dir, entry.name);
    if (entry.isDirectory()) walk(full, root, out);
    else out.push(toPosix(relative(root, full)));
  }
  return out;
}

function kindOf(rel) {
  if (!rel.includes('/') && SPECIAL.has(rel)) return 'special';
  if (rel.startsWith('raw/')) return 'raw';
  if (basename(rel).startsWith('_')) return 'template';
  return 'page';
}

function loadProjects(registry) {
  if (!existsSync(registry)) throw new Error(`no project list at ${registry}; pass --registry`);
  const raw = JSON.parse(readFileSync(registry, 'utf8'));
  if (!Array.isArray(raw?.projects)) throw new Error(`${registry}: expected {"projects": [...]}`);
  return raw.projects.map((p) => ({
    id: String(p.id),
    name: String(p.name ?? p.id),
    what: String(p.what ?? ''),
    checkouts: (Array.isArray(p.checkouts) ? p.checkouts : []).map((c) => resolve(expandHome(String(c)))),
  }));
}

function lastCommitOf(project) {
  let latest = null;
  for (const dir of project.checkouts) {
    if (!existsSync(dir)) continue;
    const r = spawnSync('git', ['log', '-1', '--format=%cI'], { cwd: dir, encoding: 'utf8', timeout: 10_000 });
    if (r.status !== 0 || !r.stdout.trim()) continue;
    const d = new Date(r.stdout.trim());
    if (!latest || d > latest) latest = d;
  }
  return latest;
}

function requireWiki(wikiDir) {
  if (!existsSync(wikiDir)) throw new Error(`no wiki at ${wikiDir}; to start one, copy starter-wiki/ there`);
}

/** @returns {Wiki} */
export function loadWiki(wikiDir, registry, { today = new Date() } = {}) {
  requireWiki(wikiDir);
  const all = walk(wikiDir);
  const pages = all
    .filter((rel) => extname(rel).toLowerCase() === '.md')
    .map((rel) => {
      const text = readFileSync(join(wikiDir, rel), 'utf8');
      return { rel, kind: kindOf(rel), meta: parseFrontmatter(text), text, links: linksIn(text) };
    });
  const cache = new Map();
  const lastCommit = (p) => {
    if (!cache.has(p.id)) cache.set(p.id, lastCommitOf(p));
    return cache.get(p.id);
  };
  return { wikiDir, pages, files: new Set(all), projects: loadProjects(registry), lastCommit, today };
}

/** Obsidian-style lookup: a link matches a path from the wiki root, or a file name anywhere. */
function resolver(wiki) {
  const byPath = new Map();
  const byName = new Map();
  for (const rel of wiki.files) {
    const keys = extname(rel).toLowerCase() === '.md' ? [stripMd(rel)] : [rel];
    for (const key of keys) {
      byPath.set(key.toLowerCase(), rel);
      byName.set(basename(key).toLowerCase(), rel);
    }
  }
  return (target) => {
    const t = stripMd(target).toLowerCase();
    return t ? (byPath.get(t) ?? (t.includes('/') ? undefined : byName.get(t))) : undefined;
  };
}

const content = (wiki) => wiki.pages.filter((p) => p.kind === 'page');
const linked = (wiki) => wiki.pages.filter((p) => p.kind !== 'raw' && p.kind !== 'template');

/** @type {{id: string, level: 'error' | 'warn', check: (wiki: Wiki) => Finding[]}[]} */
export const RULES = [
  {
    id: 'broken-link',
    level: 'error',
    check: (wiki) => {
      const find = resolver(wiki);
      return linked(wiki).flatMap((p) =>
        p.links.filter((t) => !find(t)).map((t) => ({ file: p.rel, detail: `[[${t}]] points at no page` })),
      );
    },
  },
  {
    id: 'missing-project-page',
    level: 'error',
    check: (wiki) =>
      wiki.projects
        .filter((proj) => !wiki.files.has(`projects/${proj.id}.md`))
        .map((proj) => ({ file: `projects/${proj.id}.md`, detail: `project "${proj.id}" in projects.json has no page` })),
  },
  {
    id: 'frontmatter',
    level: 'warn',
    check: (wiki) =>
      content(wiki).flatMap((p) => {
        const m = p.meta ?? {};
        const missing = [];
        if (!parseDate(m.updated)) missing.push('updated (YYYY-MM-DD)');
        if (!Array.isArray(m.sources) || m.sources.length === 0) missing.push('sources (a list)');
        if (!Array.isArray(m.tags) || m.tags.length === 0) missing.push('tags (a list)');
        return missing.length ? [{ file: p.rel, detail: `frontmatter needs ${missing.join(', ')}` }] : [];
      }),
  },
  {
    id: 'raw-header',
    level: 'warn',
    check: (wiki) =>
      wiki.pages
        .filter((p) => p.kind === 'raw')
        .flatMap((p) => {
          const m = p.meta ?? {};
          const missing = ['title', 'origin'].filter((k) => typeof m[k] !== 'string' || !m[k]);
          if (!parseDate(m.date)) missing.push('date');
          return missing.length ? [{ file: p.rel, detail: `raw source header needs ${missing.join(', ')}` }] : [];
        }),
  },
  {
    id: 'not-in-index',
    level: 'warn',
    check: (wiki) => {
      const index = wiki.pages.find((p) => p.rel === 'index.md');
      const find = resolver(wiki);
      const listed = new Set((index?.links ?? []).map(find));
      return content(wiki)
        .filter((p) => !listed.has(p.rel))
        .map((p) => ({ file: p.rel, detail: 'not listed in index.md' }));
    },
  },
  {
    id: 'orphan',
    level: 'warn',
    check: (wiki) => {
      const find = resolver(wiki);
      const inbound = new Set();
      for (const p of linked(wiki)) {
        if (p.rel === 'index.md' || p.rel === 'log.md') continue;
        for (const t of p.links) {
          const hit = find(t);
          if (hit && hit !== p.rel) inbound.add(hit);
        }
      }
      return wiki.pages
        .filter((p) => (p.kind === 'page' || p.kind === 'raw') && !inbound.has(p.rel))
        .map((p) => ({ file: p.rel, detail: p.kind === 'raw' ? 'raw source no page cites' : 'no other page links here' }));
    },
  },
  {
    id: 'stale',
    level: 'warn',
    check: (wiki) =>
      wiki.projects.flatMap((proj) => {
        const page = wiki.pages.find((p) => p.rel === `projects/${proj.id}.md`);
        const updated = parseDate(page?.meta?.updated);
        const commit = updated && wiki.lastCommit(proj);
        if (!commit) return [];
        const days = Math.floor((commit - updated) / DAY_MS);
        if (days <= STALE_DAYS) return [];
        return [{ file: page.rel, detail: `updated ${page.meta.updated}, but the project's last commit is ${localDate(commit)} (${days} days later)` }];
      }),
  },
  {
    id: 'log-format',
    level: 'warn',
    check: (wiki) => {
      const log = wiki.pages.find((p) => p.rel === 'log.md');
      if (!log) return [{ file: 'log.md', detail: 'missing' }];
      return log.text
        .split('\n')
        .map((line, i) => ({ line, n: i + 1 }))
        .filter(({ line }) => line.startsWith('## ') && !LOG_HEADING.test(line))
        .map(({ line, n }) => ({ file: 'log.md', detail: `line ${n} should read "## [YYYY-MM-DD] <op> | <title>": ${line}` }));
    },
  },
];

export function lint(wiki) {
  return RULES.flatMap((rule) => rule.check(wiki).map((f) => ({ rule: rule.id, level: rule.level, ...f })));
}

/** The secret words a NAME=value pair can end in. */
const SECRET_WORD = /(?:^|[_.-])(?:key|token|secret|password|passwd|pass|pwd)(?:[_.-]base)?$/i;
const BARE_NAME = /^(?:api[_-]?key|apikey|token|secret|password|passwd|pwd)$/i;
/**
 * A compound name (DB_PASS, smtp.password, SECRET_KEY_BASE) counts anywhere; a bare
 * one (Password, token) only where it can't be prose: a line start, after a quote,
 * or as a URL query param. Names start at a token boundary and are at most 80
 * characters, so a long run of identifiers is scanned once, not backtracked.
 */
function secretName(name, offset, text) {
  if (/[_.-]/.test(name) && SECRET_WORD.test(name)) return true;
  if (!BARE_NAME.test(name)) return false;
  const before = text.slice(text.lastIndexOf('\n', offset - 1) + 1, offset);
  return /^[ \t>*-]*$/.test(before) || /["'?&]$/.test(before);
}
const digitCount = (s) => s.replace(/\D/g, '').length;

/** Best effort, in order: each rule sees the text after the rules above it. */
const REDACTIONS = [
  [/-----BEGIN [A-Z ]*PRIVATE KEY(?: BLOCK)?-----[\s\S]*?(?:-----END [A-Z ]*PRIVATE KEY(?: BLOCK)?-----|(?=\n[ \t]*\n)|$)/g, '[secret]'],
  [/\b((?:Proxy-)?Authorization:[ \t]*(?:Bearer|Basic|Token)[ \t]+)[^\s"']+/gi, '$1[secret]'],
  [/^([ \t>*-]*(?:Set-)?Cookie:[ \t]*)[^\n]+/gim, '$1[secret]'],
  [/(?<![a-z0-9+.-])([a-z][a-z0-9+.-]*:\/\/)[^\s\/@:]+:[^\s\/@]+@(?=[^\s\/@]+)/gi, (_, scheme) => `${scheme}[secret]@`],
  [
    /(?:sk_live_|sk_test_|rk_live_|sb_secret_|github_pat_|npg_)[A-Za-z0-9_-]{6,}|sbp_[A-Za-z0-9]{30,}|whsec_[A-Za-z0-9+/=]{20,}|glpat-[A-Za-z0-9_-]{20,}|hf_[A-Za-z0-9]{30,}|AKIA[0-9A-Z]{16}|xox[abprs]-[A-Za-z0-9-]{10,}|gh[pousr]_[A-Za-z0-9]{20,}|AIza[0-9A-Za-z_-]{20,}|AQ\.[0-9A-Za-z_-]{20,}|sk-[A-Za-z0-9_-]{20,}|re_[A-Za-z0-9]{20,}|eyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9._-]{10,}/g,
    '[secret]',
  ],
  [
    /(?<![A-Za-z0-9_.-])([A-Za-z0-9_.-]{1,80})(["']?[ \t]*[:=](?!\/\/)\**[ \t]*)("[^"\n]*"|'[^'\n]*'|[a-z]{4}(?: [a-z]{4}){3}(?![a-z])|[^\s,;&]+)/gm,
    (whole, name, sep, value, offset, text) =>
      secretName(name, offset, text) ? `${name}${sep}${/^["']/.test(value) ? `${value[0]}[secret]${value[0]}` : '[secret]'}` : whole,
  ],
  [/((?:password|passwd|secret|token|api[_ -]?key)[^"\n.;)]{0,40}?)"([^"\n]{4,})"/gi, '$1"[secret]"'],
  [/(?<![A-Za-z0-9._%+-])[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}/g, '[email]'],
  [/(?<![\w.+-])\+\d{1,3}(?:[ .-]?\(?\d{1,4}\)?){2,5}(?![\w-])/g, (m) => (digitCount(m) >= 8 ? '[phone]' : m)],
  [/(?<![\w.+-])(?:1[ .-]?)?(?:\([2-9]\d{2}\)[ .-]?[2-9]\d{2}[ .-]?|[2-9]\d{2}([ .-]?)[2-9]\d{2}\1)\d{4}(?![\w-]|\.\d)/g, '[phone]'],
];

export function redact(text) {
  return REDACTIONS.reduce((t, [re, to]) => t.replace(re, to), text);
}

/** For one-line fields (title, origin): redacted, with newlines and control characters folded to spaces. */
const oneLine = (s) => redact(s).replace(/[\x00-\x1f\x7f]+/g, ' ').replace(/ {2,}/g, ' ').trim();

const slugify = (s) =>
  s.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 60).replace(/-+$/, '') || 'source';

function ensureLog(wikiDir) {
  const file = join(wikiDir, 'log.md');
  if (!existsSync(file)) writeFileSync(file, '# Log\n\nAppend only. Each entry starts `## [YYYY-MM-DD] <op> | <title>`.\n');
  return file;
}

const RAW_MARK = '\n> Raw source';
const rawBody = (doc) => doc.slice(doc.indexOf(RAW_MARK));

function cmdIngest(wikiDir, flags, positional) {
  const src = positional[0];
  if (!src) throw new UsageError('ingest needs a file');
  requireWiki(wikiDir);
  const body = redact(readFileSync(src, 'utf8'));
  const title = oneLine(flags.title ?? body.match(/^#\s+(.+)$/m)?.[1] ?? basename(src, extname(src))) || 'Source';
  const date = flags.date ?? localDate();
  if (!parseDate(date)) throw new UsageError('--date must be YYYY-MM-DD');
  const origin = oneLine(flags.origin ?? tilde(resolve(src)));
  const slug = slugify(title);
  const name = `${date}-${slug}.md`;
  const rawDir = join(wikiDir, 'raw');
  const dest = join(rawDir, name);
  const doc = [
    '---',
    `title: ${JSON.stringify(title)}`,
    `date: ${date}`,
    `origin: ${JSON.stringify(origin)}`,
    `ingested: ${localDate()}`,
    '---',
    '',
    '> Raw source, copied in by `wiki.mjs ingest`. Never edit it. Emails, phone numbers and secrets were blanked on the way in.',
    '',
    body.trimEnd(),
    '',
  ].join('\n');
  const sameSlug = existsSync(rawDir) ? readdirSync(rawDir).filter((f) => f.endsWith(`-${slug}.md`) && DATE.test(f.slice(0, 10))) : [];
  const twin = sameSlug.find((f) => rawBody(readFileSync(join(rawDir, f), 'utf8')) === rawBody(doc));
  if (twin) {
    console.log(`already ingested: ${join(rawDir, twin)}`);
    return 0;
  }
  if (existsSync(dest)) {
    console.error(`${dest} already exists with different text. Raw sources don't change; ingest it under a new --title.`);
    return 1;
  }
  mkdirSync(dirname(dest), { recursive: true });
  writeFileSync(dest, doc);
  appendFileSync(ensureLog(wikiDir), `\n## [${localDate()}] ingest | ${title}\n\nRaw source [[raw/${stripMd(name)}]], from ${origin}.\n`);
  console.log(dest);
  return 0;
}

function cmdLint(wiki) {
  const findings = lint(wiki);
  const errors = findings.filter((f) => f.level === 'error');
  console.log(`wiki lint: ${tilde(wiki.wikiDir)} (${content(wiki).length} pages, ${wiki.projects.length} projects)`);
  for (const f of [...errors, ...findings.filter((f) => f.level === 'warn')]) {
    console.log(`${f.level.padEnd(5)}  ${f.rule.padEnd(20)}  ${f.file}: ${f.detail}`);
  }
  console.log(findings.length ? `${errors.length} errors, ${findings.length - errors.length} warnings` : 'clean');
  return errors.length ? 1 : 0;
}

function projectId(positional, command) {
  const id = positional[0];
  if (!id || !PROJECT_ID.test(id)) throw new UsageError(`${command} needs a project id (lowercase letters, digits, hyphens)`);
  return id;
}

function cmdPage(wikiDir, positional) {
  const id = projectId(positional, 'page');
  const file = join(wikiDir, 'projects', `${id}.md`);
  if (!existsSync(file)) {
    console.error(`no page for "${id}" yet; it belongs at ${file}`);
    return 1;
  }
  console.log(file);
  return 0;
}

/** A project's page from projects/_template.md, listed under "## Projects" in index.md and logged. Rerunning changes nothing. */
function cmdNewPage(wikiDir, registry, positional) {
  const id = projectId(positional, 'new-page');
  requireWiki(wikiDir);
  const project = loadProjects(registry).find((p) => p.id === id);
  if (!project) throw new UsageError(`project "${id}" is not in ${tilde(registry)}`);
  const file = join(wikiDir, 'projects', `${id}.md`);
  if (existsSync(file)) {
    console.log(`already has a page: ${file}`);
    return 0;
  }
  const template = join(wikiDir, 'projects', '_template.md');
  if (!existsSync(template)) throw new Error(`no template at ${template}`);
  const today = localDate();
  const text = readFileSync(template, 'utf8')
    .replace(/^updated: .*$/m, `updated: ${today}`)
    .replace(/^ {2}- "\[\[raw\/YYYY-MM-DD-source-name\]\]"$/m, `  - "projects.json (cos.mjs new, ${today})"`)
    .replace(/^# Project name$/m, `# ${oneLine(project.name)}`)
    .replace(/(## What it is\n\n)Nothing yet\./, `$1${oneLine(project.what) || 'Nothing yet.'}`)
    .replace(/^- YYYY-MM-DD: .*$/m, 'Nothing yet.');
  writeFileSync(file, text);

  const indexFile = join(wikiDir, 'index.md');
  const index = existsSync(indexFile) ? readFileSync(indexFile, 'utf8') : '# Index\n';
  const link = `- [[projects/${id}]]`;
  const what = oneLine(project.what).replace(/\.$/, '');
  const entry = what ? `${link}: ${what}` : link;
  if (!index.split('\n').some((l) => l.startsWith(link))) {
    writeFileSync(
      indexFile,
      /^## Projects\n/m.test(index) ? index.replace(/^## Projects\n\n?(## )?/m, (_, next) => `## Projects\n\n${entry}\n${next ? `\n${next}` : ''}`) : `${index.trimEnd()}\n\n## Projects\n\n${entry}\n`,
    );
  }
  appendFileSync(ensureLog(wikiDir), `\n## [${today}] create | ${id}: new project page\n\nFrom the template, for the new entry in projects.json.\n`);
  console.log(file);
  return 0;
}

const words = (s) => s.toLowerCase().match(/[a-z0-9]+/g) ?? [];

const STOPWORDS = new Set('a an and are about as at be by did do does for from how in is it of on or that the this to was we what when where which who why with'.split(' '));

/** BM25 over whole words (a trailing "s" allowed), with a bonus for words in the page's path. */
export function search(wiki, query, limit = 10) {
  const terms = [...new Set(words(query))].filter((t) => !STOPWORDS.has(t));
  const hits = (ws, t) => ws.filter((w) => w === t || w === `${t}s`).length;
  const docs = wiki.pages.map((p) => ({ p, text: words(p.text), path: words(p.rel) }));
  const avgLen = docs.reduce((n, d) => n + d.text.length, 0) / Math.max(docs.length, 1);
  const weight = new Map(
    terms.map((t) => {
      const df = docs.filter((d) => hits(d.text, t) || hits(d.path, t)).length;
      return [t, df ? Math.log(1 + (docs.length - df + 0.5) / (df + 0.5)) : 0];
    }),
  );
  const scoreOf = (ws, path = []) =>
    terms.reduce((s, t) => {
      const tf = hits(ws, t);
      const bm25 = (tf * 2.2) / (tf + 1.2 * (0.25 + (0.75 * ws.length) / avgLen));
      return s + weight.get(t) * (bm25 + 2 * hits(path, t));
    }, 0);
  return docs
    .map(({ p, text, path }) => {
      const lines = p.text.split('\n').filter((l) => l.trim() && l !== '---');
      const best = lines.reduce((a, l) => {
        const s = terms.reduce((n, t) => n + (hits(words(l), t) ? weight.get(t) : 0), 0);
        return s > a.s ? { s, l } : a;
      }, { s: 0, l: '' });
      return { rel: p.rel, score: Math.round(scoreOf(text, path) * 10) / 10, line: best.l.trim().slice(0, 160) };
    })
    .filter((r) => r.score > 0)
    .sort((a, b) => b.score - a.score || a.rel.localeCompare(b.rel))
    .slice(0, limit);
}

function cmdSearch(wiki, positional) {
  if (!positional.length) throw new UsageError('search needs words');
  const hits = search(wiki, positional.join(' '));
  if (!hits.length) console.log('no matches');
  for (const h of hits) console.log(`${h.rel}  (${h.score})${h.line ? `\n    ${h.line}` : ''}`);
  return 0;
}

class UsageError extends Error {}

function parseArgs(argv) {
  const flags = {};
  const positional = [];
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a.startsWith('--') && VALUE_FLAGS.has(a.slice(2))) {
      const value = argv[++i];
      if (value === undefined) throw new UsageError(`${a} needs a value`);
      flags[a.slice(2)] = value;
    } else if (a.startsWith('--')) throw new UsageError(`unknown flag ${a}`);
    else positional.push(a);
  }
  return { flags, positional };
}

const USAGE = `usage: node wiki.mjs <command> [--wiki <dir>] [--registry <projects.json>]
  lint                                        check links, index, frontmatter, stale pages
  ingest <file> [--title t] [--origin o] [--date YYYY-MM-DD]
                                              copy a source into raw/ and log it
  page <project-id>                           print the project's page path
  new-page <project-id>                       write a project's page from projects/_template.md
  search <words>                              ranked search over the wiki`;

function main() {
  const [command, ...rest] = process.argv.slice(2);
  try {
    const { flags, positional } = parseArgs(rest);
    const wikiDir = resolve(flags.wiki ?? join(SELF_DIR, 'wiki'));
    const registry = resolve(flags.registry ?? join(SELF_DIR, 'projects.json'));
    switch (command) {
      case 'lint': return cmdLint(loadWiki(wikiDir, registry));
      case 'ingest': return cmdIngest(wikiDir, flags, positional);
      case 'page': return cmdPage(wikiDir, positional);
      case 'new-page': return cmdNewPage(wikiDir, registry, positional);
      case 'search': return cmdSearch(loadWiki(wikiDir, registry), positional);
      default:
        console.error(USAGE);
        return 2;
    }
  } catch (e) {
    console.error(e instanceof UsageError ? `${e.message}\n${USAGE}` : e.message);
    return 2;
  }
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) process.exitCode = main();
