import { mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { dirname } from 'node:path';
import { prBlockReason } from '../cos.mjs';
import { checkState, parseFreshPr } from './actions.mjs';

/**
 * @typedef {object} QaCard A thing waiting for the owner to look at. Every string is plain text; the page renders text only.
 * @property {string} key                `${repo}#${number}`, or `req:<id>` for a request with no PR
 * @property {'pr' | 'request'} kind
 * @property {string} [repo]
 * @property {number} [number]
 * @property {string} project
 * @property {string} projectName
 * @property {string} [url]
 * @property {string} [filesUrl]         url + '/files'
 * @property {string} title              without "feat:", "[WIP]" and similar prefixes
 * @property {string} [summary]          first prose paragraph of the body, at most 280 characters
 * @property {string} waitingSince       the PR's createdAt, or a request's Asked date
 * @property {string} [base]
 * @property {boolean} [live]            the base is a public branch
 * @property {{text: string, green: boolean, fail: number, pending: number}} [checks]
 * @property {{url: string, source: 'vercel-comment' | 'deployment' | 'body'} | null} [preview]
 * @property {string | null} [previewMissing] the body's own instruction for getting a preview, when there is none
 * @property {{url: string, source: 'review' | 'comment' | 'body', text: string} | null} [review]
 * @property {string} nextAction
 * @property {string[]} [checklist]
 * @property {string | null} [blockedBy] plain-words reason it can't merge yet (the merge refusal's own words)
 * @property {string | null} reviewedAt  the owner's local "mark reviewed" note
 */

const SUMMARY_MAX = 280;
const REVIEW_MAX = 400;
const ITEM_MAX = 300;
const CHECKLIST_MAX = 12;
const DEPLOYMENTS_LOOKED_AT = 5;
const GH_TIMEOUT_MS = 60_000;

export const PR_FIELDS = [
  'number', 'title', 'body', 'url', 'createdAt', 'updatedAt', 'baseRefName', 'headRefName', 'headRefOid',
  'isDraft', 'labels', 'comments', 'reviews', 'statusCheckRollup', 'mergeable', 'reviewDecision', 'state',
];

/** The URL when it is https, else null. Anything else (http:, javascript:, data:) never reaches the page. */
export function safeUrl(u) {
  try {
    const text = String(u ?? '').trim();
    return new URL(text).protocol === 'https:' ? text : null;
  } catch {
    return null;
  }
}

const truncate = (s, max) => {
  if (s.length <= max) return s;
  const cut = s.slice(0, max - 1);
  const at = cut.lastIndexOf(' ');
  return `${(at > max * 0.6 ? cut.slice(0, at) : cut).trimEnd()}…`;
};

/** Markdown and HTML to plain text on one line. */
function plain(md) {
  return String(md ?? '')
    .replace(/<!--[\s\S]*?-->/g, ' ')
    .replace(/!\[[^\]]*\]\([^)]*\)/g, ' ')
    .replace(/\[\[(?:[^\]|]*\/)?([^\]|]+)(?:\|[^\]]*)?\]\]/g, '$1')
    .replace(/\[([^\]]*)\]\([^)]*\)/g, '$1')
    .replace(/<[^>\n]*>/g, ' ')
    .replace(/\*\*([^*]+)\*\*/g, '$1')
    .replace(/(^|[\s(])\*([^*\s][^*]*?)\*(?=[\s).,;:]|$)/g, '$1$2')
    .replace(/`([^`]*)`/g, '$1')
    .replace(/~~([^~]+)~~/g, '$1')
    .replace(/[\u0000-\u0008\u000b-\u001f\u007f]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

const CONVENTIONAL = /^(?:feat|fix|chore|docs|refactor|perf|test|build|ci|style|revert)(?:\([^)]*\))?!?:\s*/i;

export function plainTitle(title) {
  let t = String(title ?? '').trim();
  for (let prev = null; prev !== t; ) {
    prev = t;
    t = t.replace(/^(?:\[[^\]]*\]|\bWIP\b:?|\(WIP\))\s*/i, '').replace(CONVENTIONAL, '');
  }
  t = plain(t);
  return t.charAt(0).toUpperCase() + t.slice(1);
}

/** Blocks of the body split on blank lines, with fenced code dropped. */
function blocks(body) {
  const text = String(body ?? '').replace(/\r\n?/g, '\n').replace(/```[\s\S]*?```/g, '\n\n');
  return text.split(/\n\s*\n/).map((b) => b.trim()).filter(Boolean);
}

const NOT_PROSE = /^(?:#{1,6}\s|\||!\[|>|<|[-*+]\s|\d+[.)]\s|---|===)/;

export function firstParagraph(body) {
  const para = blocks(body).find((b) => !NOT_PROSE.test(b) && plain(b));
  return para ? truncate(plain(para), SUMMARY_MAX) : '';
}

/** @returns {{heading: string, lines: string[]}[]} the body cut at markdown headings; text before the first is heading ''. */
function sections(body) {
  const out = [{ heading: '', lines: [] }];
  let fenced = false;
  for (const line of String(body ?? '').replace(/\r\n?/g, '\n').split('\n')) {
    if (/^\s*```/.test(line)) fenced = !fenced;
    const h = !fenced && line.match(/^#{1,6}\s+(.*?)\s*#*\s*$/);
    if (h) out.push({ heading: plain(h[1]), lines: [] });
    else out.at(-1).lines.push(line);
  }
  return out;
}

const BULLET = /^(\s*)(?:[-*+]|\d+[.)])\s+(?:\[[ xX]\]\s+)?(.*)$/;

/** @returns {{text: string, subs: string[]}[]} top-level bullets with their nested bullets (any depth) attached. */
function bullets(lines) {
  const items = [];
  let topIndent = null;
  for (const line of lines) {
    const m = line.match(BULLET);
    if (!m) {
      if (line.trim() && items.length && /^\s+\S/.test(line)) items.at(-1).text += ` ${line.trim()}`;
      continue;
    }
    const indent = m[1].replace(/\t/g, '    ').length;
    if (topIndent === null || indent <= topIndent) {
      topIndent = indent;
      items.push({ text: m[2], subs: [] });
    } else if (items.length) items.at(-1).subs.push(m[2]);
  }
  return items;
}

const CHECKLIST_HEADING = /^(?:test plan|qa\b|owner to-?do|left for you|for the owner|for you\b|what to check|to check)/i;
const OWNER_HEADING = /^(?:left for you|owner to-?do|for the owner|for you\b)/i;

export function extractChecklist(body) {
  const items = sections(body)
    .filter((s) => CHECKLIST_HEADING.test(s.heading))
    .flatMap((s) => bullets(s.lines));
  return items
    .map((i) => truncate(plain(i.subs.length ? `${i.text} ${i.subs.map(plain).join('; ')}` : i.text), ITEM_MAX))
    .filter(Boolean)
    .slice(0, CHECKLIST_MAX);
}

/** The body's own line about getting a preview, from the owner's to-do section. */
function previewInstruction(body) {
  const lines = sections(body).filter((s) => OWNER_HEADING.test(s.heading)).flatMap((s) => bullets(s.lines));
  const hit = lines.find((i) => /preview/i.test(i.text));
  return hit ? truncate(plain(hit.text), ITEM_MAX) : null;
}

const vercelAppUrl = (u) => {
  const s = safeUrl(u);
  return s && /\.vercel\.app$/.test(new URL(s).hostname) ? s : null;
};
const isVercelBot = (c) => /^vercel(\[bot\])?$/i.test(c?.author?.login ?? '');
const BARE_URL = /https:\/\/[^\s)"'<>\]`]+/g;

/** Ordered rules: the first that finds an https URL wins. */
const PREVIEW_RULES = [
  {
    source: 'vercel-comment',
    find: (detail) => {
      for (const c of [...(detail.comments ?? [])].reverse().filter(isVercelBot)) {
        const body = String(c.body ?? '');
        const link = body.match(/\[(?:Visit )?Preview\]\((https:[^)\s]+)\)/i) ?? body.match(/<a href="(https:[^"]+)"[^>]*>\s*(?:Visit )?Preview\s*<\/a>/i);
        const url = vercelAppUrl(link?.[1]);
        if (url) return url;
      }
      return null;
    },
  },
  {
    source: 'deployment',
    find: (_detail, deployments) => (deployments ?? []).map((d) => safeUrl(d?.environment_url)).find(Boolean) ?? null,
  },
  {
    source: 'body',
    find: (detail) => {
      const body = String(detail.body ?? '');
      const labelled = body.split('\n').filter((l) => /\bpreview\s*:/i.test(l)).flatMap((l) => l.match(BARE_URL) ?? []);
      return [...labelled, ...(body.match(BARE_URL) ?? [])].map(vercelAppUrl).find(Boolean) ?? null;
    },
  },
];

/** @returns {{url: string, source: 'vercel-comment' | 'deployment' | 'body'} | null} */
export function extractPreview(detail, deployments = []) {
  for (const rule of PREVIEW_RULES) {
    const url = rule.find(detail, deployments);
    if (url) return { url, source: rule.source };
  }
  return null;
}

const REVIEW_WORD = /review|verdict|\blgtm\b|approved?/i;
const COMMENT_REVIEW_HEAD = /^(?:#{1,6}\s+.*\breview(?:er)?\b|\*\*[^*\n]*\breview(?:er)?\b[^*\n]*\*\*)/im;

const anchored = (detail, anchor, id) => (/^\d+$/.test(String(id ?? '')) ? `${detail.url}#${anchor}-${id}` : detail.url);

/** Ordered rules for where the independent review is recorded; each returns `{url, text}` or null. */
const REVIEW_RULES = [
  {
    source: 'review',
    find: (detail) => {
      const r = [...(detail.reviews ?? [])].reverse().find((x) => String(x.body ?? '').trim() && REVIEW_WORD.test(x.body) && !isVercelBot(x));
      return r && { url: safeUrl(r.url) ?? anchored(detail, 'pullrequestreview', r.id), text: r.body };
    },
  },
  {
    source: 'comment',
    find: (detail) => {
      const c = [...(detail.comments ?? [])].reverse().find((x) => !isVercelBot(x) && COMMENT_REVIEW_HEAD.test(String(x.body ?? '')));
      return c && { url: safeUrl(c.url) ?? anchored(detail, 'issuecomment', c.id), text: c.body };
    },
  },
  {
    source: 'body',
    find: (detail) => {
      const all = sections(detail.body);
      for (const s of all) {
        const item = bullets(s.lines).find((i) => /independent review/i.test(i.text));
        if (item) return { url: detail.url, text: [plain(item.text), ...item.subs.map((x) => `- ${plain(x)}`)].join('\n') };
      }
      const s = all.find((x) => /^(?:independent )?review\b/i.test(x.heading));
      return s && { url: detail.url, text: s.lines.join('\n').trim() };
    },
  },
];

const multiline = (text) =>
  String(text ?? '')
    .split('\n')
    .map((l) => l.replace(/^#{1,6}\s+/, ''))
    .map((l) => (/^\s*[-*+]\s/.test(l) ? `- ${plain(l.replace(/^\s*[-*+]\s+/, ''))}` : plain(l)))
    .filter(Boolean)
    .join('\n');

/** @returns {{url: string, source: 'review' | 'comment' | 'body', text: string} | null} */
export function extractReview(detail) {
  for (const rule of REVIEW_RULES) {
    const hit = rule.find(detail);
    const url = hit && safeUrl(hit.url);
    const text = hit && truncate(multiline(hit.text), REVIEW_MAX);
    if (url && text) return { url, source: rule.source, text };
  }
  return null;
}

const MIGRATION = /\bmigrations?\b/i;

/** Ordered rules, first match wins. */
const NEXT_ACTIONS = [
  { when: (c) => c.blockedBy, text: (c) => `Not ready. ${c.blockedBy} The worker has to fix this first.` },
  { when: (c, ctx) => ctx.missingKeys?.[c.project]?.length, text: (c, ctx) => `Add these keys first: ${ctx.missingKeys[c.project].join(', ')}. Then review and merge.` },
  { when: (c, ctx) => c.live && MIGRATION.test(ctx.body), text: (c) => `Review, then merge into ${c.base} to go live. Run the migration after merging.` },
  { when: (c) => c.live, text: (c) => `Review, then merge into ${c.base} to go live.` },
  { when: () => true, text: () => 'Review, then merge.' },
];

/**
 * Whether a PR becomes a card: it targets a public branch, carries a "waiting on owner" label, or a request row the
 * owner is waiting on names it.
 * @param {{baseRefName?: string, labels?: {name: string}[], number: number}} pr
 * @param {{repo: string, publicBranches?: string[], waitingRefs?: Set<string>}} ctx waitingRefs holds lowercase `repo#n` and `owner/repo#n`
 */
export function isQaPr(pr, ctx) {
  const publicBranches = ctx.publicBranches ?? ['main'];
  const repo = ctx.repo.toLowerCase();
  const refs = [`${repo}#${pr.number}`, `${repo.split('/').pop()}#${pr.number}`];
  return (
    publicBranches.includes(pr.baseRefName) ||
    (pr.labels ?? []).some((l) => /waiting.?on.?owner/i.test(l?.name ?? '')) ||
    refs.some((r) => ctx.waitingRefs?.has(r))
  );
}

/**
 * @param {object} detail `gh pr view --json PR_FIELDS` output
 * @param {{environment_url?: string}[]} deployments newest first, one status each (see createQaFetcher)
 * @param {{repo: string, project: string, projectName?: string, publicBranches?: string[], missingKeys?: Record<string, string[]>, reviewed?: Record<string, string>}} ctx
 * @returns {QaCard}
 */
export function buildQaCard(detail, deployments, ctx) {
  const publicBranches = ctx.publicBranches ?? ['main'];
  const key = `${ctx.repo}#${detail.number}`;
  const fresh = parseFreshPr(detail);
  const blockedBy = prBlockReason(fresh, { branches: publicBranches }, publicBranches[0]);
  const state = checkState(fresh.checks);
  const preview = extractPreview(detail, deployments);
  const url = safeUrl(detail.url);
  const card = {
    key,
    kind: 'pr',
    repo: ctx.repo,
    number: detail.number,
    project: ctx.project,
    projectName: ctx.projectName ?? ctx.project,
    url,
    filesUrl: url && `${url}/files`,
    title: plainTitle(detail.title),
    summary: firstParagraph(detail.body),
    waitingSince: detail.createdAt,
    base: detail.baseRefName,
    live: publicBranches.includes(detail.baseRefName),
    checks: { text: state.text, green: state.green, fail: state.fail, pending: state.pending },
    preview,
    previewMissing: preview ? null : previewInstruction(detail.body),
    review: extractReview(detail),
    checklist: extractChecklist(detail.body),
    blockedBy,
    reviewedAt: ctx.reviewed?.[key] ?? null,
  };
  card.nextAction = NEXT_ACTIONS.find((r) => r.when(card, { ...ctx, body: String(detail.body ?? '') })).text(card, ctx);
  return card;
}

/** The request list writes dates as `11-04`. Dates Date.parse would read as 2001 become this year's (or last year's, if that is still ahead). */
export function askedToIso(asked, now = new Date()) {
  const m = String(asked ?? '').trim().match(/^(\d{1,2})-(\d{1,2})$/);
  if (!m) return asked;
  const at = (year) => new Date(Date.UTC(year, Number(m[1]) - 1, Number(m[2])));
  const date = at(now.getUTCFullYear());
  return (date.getTime() > now.getTime() + 86_400_000 ? at(now.getUTCFullYear() - 1) : date).toISOString().slice(0, 10);
}

/**
 * Waiting-on-the-owner request rows that name no PR become cards of their own; the ones with a PR show up through it.
 * @param {{id: string, section: string, asked: string, text: string, project: string, stands: string, prs: string[]}[]} requests
 * @returns {QaCard[]}
 */
export function requestCards(requests, now = new Date()) {
  return requests
    .filter((r) => r.section === 'waiting' && !r.prs?.length)
    .map((r) => ({
      key: `req:${r.id}`,
      kind: 'request',
      project: r.project,
      projectName: r.project,
      title: plain(r.text),
      waitingSince: askedToIso(r.asked, now),
      nextAction: plain(r.stands),
      reviewedAt: null,
    }));
}

const since = (c) => Date.parse(c.waitingSince) || Infinity;

/**
 * @param {{details: {repo: string, detail: object, deployments?: object[]}[], requests?: object[], reviewed?: Record<string, string>,
 *   ctx: {projects: Record<string, {project: string, projectName?: string, publicBranches?: string[]}>, missingKeys?: Record<string, string[]>}}} input
 *   ctx.projects is keyed by lowercase `owner/repo`
 * @returns {QaCard[]} oldest waiting first
 */
export function buildQa({ details, requests = [], reviewed = {}, ctx }) {
  const waitingRefs = new Set(requests.filter((r) => r.section === 'waiting').flatMap((r) => (r.prs ?? []).map((p) => p.toLowerCase())));
  const cards = [];
  for (const { repo, detail, deployments } of details) {
    const project = ctx.projects?.[repo.toLowerCase()];
    if (!project || (detail.state && detail.state !== 'OPEN')) continue;
    const per = { ...project, repo, missingKeys: ctx.missingKeys, reviewed, waitingRefs };
    if (isQaPr(detail, per)) cards.push(buildQaCard(detail, deployments, per));
  }
  const asks = requestCards(requests).map((c) => ({ ...c, reviewedAt: reviewed[c.key] ?? null }));
  return [...cards, ...asks].sort((a, b) => since(a) - since(b));
}

/**
 * Fetches a PR's detail and the preview deployments of its head commit through the injected `exec` (mc/actions.mjs
 * `exec`). Cached per `repo#n@updatedAt`, so a PR is fetched once per change; a failure is not cached.
 * @param {{exec: Function, ghBin?: string}} deps
 */
export function createQaFetcher({ exec, ghBin = 'gh' }) {
  const cache = new Map();
  const gh = (args) => exec(ghBin, args, { timeout: GH_TIMEOUT_MS });
  const json = async (args) => {
    const r = await gh(args);
    if (!r.ok) return { ok: false, message: (r.err || r.out || 'gh failed').split('\n')[0] };
    try {
      return { ok: true, data: JSON.parse(r.out) };
    } catch {
      return { ok: false, message: 'gh returned unparseable output' };
    }
  };

  async function load(repo, number) {
    const view = await json(['pr', 'view', String(number), '-R', repo, '--json', PR_FIELDS.join(',')]);
    if (!view.ok) return view;
    const detail = view.data;
    const list = detail.headRefOid ? await json(['api', `repos/${repo}/deployments?sha=${detail.headRefOid}`]) : { ok: false };
    const deployments = [];
    for (const d of (list.ok && Array.isArray(list.data) ? list.data : []).slice(0, DEPLOYMENTS_LOOKED_AT)) {
      const statuses = await json(['api', `repos/${repo}/deployments/${d.id}/statuses`]);
      const s = statuses.ok && Array.isArray(statuses.data) ? statuses.data.find((x) => x?.environment_url) : null;
      if (s) deployments.push({ environment: d.environment ?? null, environment_url: s.environment_url, state: s.state ?? null });
    }
    return { ok: true, detail, deployments };
  }

  return {
    /** @returns {Promise<{ok: true, detail: object, deployments: object[]} | {ok: false, message: string}>} */
    get({ repo, number, updatedAt }) {
      const prefix = `${repo}#${number}@`;
      const key = `${prefix}${updatedAt ?? ''}`;
      if (updatedAt && cache.has(key)) return cache.get(key);
      for (const k of cache.keys()) if (k.startsWith(prefix)) cache.delete(k);
      const pending = load(repo, number).then((r) => {
        if (!r.ok) cache.delete(key);
        return r;
      });
      if (updatedAt) cache.set(key, pending);
      return pending;
    },
  };
}

/** The owner's "reviewed" marks as `{[cardKey]: isoTime}`. A missing or damaged file is no marks. */
export function loadReviewed(file) {
  try {
    const raw = JSON.parse(readFileSync(file, 'utf8'));
    return Object.fromEntries(Object.entries(raw ?? {}).filter(([, v]) => typeof v?.at === 'string').map(([k, v]) => [k, v.at]));
  } catch {
    return {};
  }
}

export function saveReviewed(file, reviewed) {
  mkdirSync(dirname(file), { recursive: true });
  const tmp = `${file}.${process.pid}.tmp`;
  writeFileSync(tmp, `${JSON.stringify(Object.fromEntries(Object.entries(reviewed).map(([k, at]) => [k, { at }])), null, 2)}\n`);
  renameSync(tmp, file);
}
