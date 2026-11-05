import { createHash } from 'node:crypto';
import { mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { dirname } from 'node:path';
import { sameSession } from './queue.mjs';

/**
 * @typedef {{ id: string, section: 'open'|'waiting'|'working'|'done', asked: string, text: string, project: string | null,
 *   stands: string, prs: string[], links: string[] }} Request
 * @typedef {{ link: Record<string, string[]>, unlink: Record<string, string[]> }} Links
 */

const SECTIONS = [
  ['open', /^open\b/i],
  ['waiting', /^waiting on the owner\b/i],
  ['working', /^working\b/i],
  ['done', /^done\b/i],
];

const PR_REF = /\b([A-Za-z0-9_.-]+(?:\/[A-Za-z0-9_.-]+)?)#(\d+)\b/g;
const URL_RE = /(?:https?:\/\/|github\.com\/)[^\s)|`]+/g;
const IDLE_LIMIT_MS = 2 * 3600e3;

const plain = (s) => String(s ?? '').replace(/\[\[([^\]|]+)(?:\|[^\]]*)?\]\]/g, '$1').replace(/[`*]|(?<![A-Za-z0-9])_|_(?![A-Za-z0-9])/g, '').replace(/\s+/g, ' ').trim();

/** Same text in a different section keeps its id, so a row moving tables keeps its manual links. */
const requestId = (asked, text) => createHash('sha1').update(`${plain(asked).toLowerCase()}|${plain(text).toLowerCase()}`).digest('hex').slice(0, 8);

const splitRow = (line) => line.replace(/^\s*\|/, '').replace(/\|\s*$/, '').split(/(?<!\\)\|/).map((c) => c.replace(/\\\|/g, '|').trim());

/** @returns {string | null} `owner/repo#n`, or null when a bare name matches no known repo. */
export function resolvePrRef(name, number, repos = []) {
  const all = repos;
  if (name.includes('/')) return `${name}#${number}`;
  const hit = all.find((r) => r.split('/')[1].toLowerCase() === name.toLowerCase());
  return hit ? `${hit}#${number}` : null;
}

export function prRefsIn(text, repos = []) {
  const refs = [...String(text ?? '').matchAll(PR_REF)].map((m) => resolvePrRef(m[1], m[2], repos));
  return [...new Set(refs.filter(Boolean))];
}

const urlsIn = (text) => [...new Set([...String(text ?? '').matchAll(URL_RE)].map((m) => m[0].replace(/[.,;]+$/, '')).map((u) => (u.startsWith('github.com') ? `https://${u}` : u)))];

/**
 * Reads wiki/topics/owner-requests.md: one table per section. Done rows have no Project column, their last cell is the result.
 * @param {string} markdown
 * @param {{ repos?: string[] }} [opts] `owner/repo` names used to resolve bare `repo#n` references
 * @returns {Request[]}
 */
export function parseRequests(markdown, { repos = [] } = {}) {
  const out = [];
  let section = null;
  let rowInTable = 0;
  for (const line of String(markdown ?? '').split('\n')) {
    const heading = line.match(/^##\s+(.*)$/);
    if (heading) {
      section = SECTIONS.find(([, re]) => re.test(heading[1].trim()))?.[0] ?? null;
      rowInTable = 0;
      continue;
    }
    if (!section || !/^\s*\|/.test(line)) continue;
    rowInTable += 1;
    if (rowInTable <= 2) continue;
    const cells = splitRow(line);
    const done = section === 'done';
    const [asked, text, third, fourth] = cells;
    if (!text || /^none right now/i.test(plain(text))) continue;
    const projectCell = done ? '' : third ?? '';
    const stands = plain(done ? third : fourth);
    const slug = projectCell.match(/\[\[projects\/([^\]|]+)/)?.[1];
    const project = (slug ?? plain(projectCell)).toLowerCase() || null;
    const body = `${text} ${done ? third ?? '' : fourth ?? ''}`;
    out.push({ id: requestId(asked, text), section, asked: plain(asked), text: plain(text), project, stands, prs: prRefsIn(body, repos), links: urlsIn(body) });
  }
  return out;
}

const STOPWORDS = new Set(
  ('the and for with that this from into are was were has have had not but all any can its our out you your they them then than when what which who how why '
    + 'new now one two per via too off get got let use used using make made see run runs add adds fix fixes build building start started full fully '
    + 'chat chats session sessions project worker owner owners left needs need next step waiting working work done open show shows main branch '
    + 'just only also more most some such each other after before still here there their about over under between harness update updates')
    .split(' '),
);

const wordsOf = (text) => new Set((String(text ?? '').toLowerCase().match(/[a-z0-9]{3,}/g) ?? []).filter((w) => !STOPWORDS.has(w)));

/** The session's project in the request file's terms: a session outside projects.json is named after its repo folder. */
const sessionProject = (s) => {
  const name = String(s.project ?? s.projectName ?? '').toLowerCase();
  return name === 'claude-harness' ? 'harness' : name;
};

const currentStep = (s) => s.plan?.current ?? s.plan?.items?.find((i) => i.status === 'in_progress')?.content ?? null;

const hasId = (ids, sessionId) => (ids ?? []).some((id) => sameSession(id, sessionId) || sameSession(sessionId, id));

const sessionPrKey = (s) => (s.pr?.repo && s.pr?.number ? `${s.pr.repo}#${s.pr.number}`.toLowerCase() : null);

/**
 * Which sessions work on which request: manual links first, then the session's PR, then shared words.
 * @returns {Map<string, Array<{ session: object, how: 'manual'|'pr'|'words', words: string[], why: string }>>} keyed by request id
 */
export function matchSessions(requests, work, links = { link: {}, unlink: {} }) {
  const sessionWords = new Map(work.map((s) => [s.sessionId, wordsOf(`${s.name} ${currentStep(s) ?? ''}`)]));
  const result = new Map();
  for (const r of requests) {
    const matches = [];
    if (r.section !== 'done') {
      const reqWords = wordsOf(`${r.text} ${r.stands}`);
      const reqPrs = new Set(r.prs.map((p) => p.toLowerCase()));
      const byWords = [];
      for (const s of work) {
        if (hasId(links.unlink?.[r.id], s.sessionId)) continue;
        if (hasId(links.link?.[r.id], s.sessionId)) {
          matches.push({ session: s, how: 'manual', words: [], why: 'You linked this session to the request.' });
          continue;
        }
        if (!r.project || r.project !== sessionProject(s)) continue;
        const prKey = sessionPrKey(s);
        if (prKey && reqPrs.has(prKey)) {
          matches.push({ session: s, how: 'pr', words: [], why: `It has ${s.pr.repo}#${s.pr.number} open, which the request names.` });
          continue;
        }
        const shared = [...sessionWords.get(s.sessionId)].filter((w) => reqWords.has(w));
        if (shared.length >= 2) byWords.push({ session: s, how: 'words', words: shared, why: `Shares the words: ${shared.join(', ')}.` });
      }
      // Sibling sessions in one project share its topic words; only the closest matches count.
      const best = Math.max(0, ...byWords.map((m) => m.words.length));
      matches.push(...byWords.filter((m) => m.words.length >= best - 1));
    }
    result.set(r.id, matches);
  }
  return result;
}

const lastActive = (s) => s.lastAt ?? s.since ?? null;
const idleMs = (s, now) => (lastActive(s) ? Math.max(0, now.getTime() - Date.parse(lastActive(s))) : Infinity);

function ago(ms) {
  if (!Number.isFinite(ms)) return 'a while';
  const min = Math.round(ms / 60e3);
  if (min < 60) return `${Math.max(min, 1)}m`;
  const h = ms / 3600e3;
  return h < 24 ? `${Math.round(h)}h` : `${Math.round(h / 24)}d`;
}

const byRecent = (a, b) => String(lastActive(b) ?? '').localeCompare(String(lastActive(a) ?? ''));

/**
 * The six states a request can be in. First match wins, so the order is the precedence.
 * Each `reason` is the sentence the owner reads; `at` is an ISO time the page may show beside it.
 */
export const STATES = [
  {
    id: 'done',
    when: (c) => c.req.section === 'done',
    reason: (c) => ({ reason: c.req.stands || 'Done.' }),
  },
  {
    id: 'working',
    when: (c) => c.sessions.some((s) => s.busy),
    reason: (c) => {
      const s = c.sessions.filter((x) => x.busy).sort(byRecent)[0];
      const step = currentStep(s) ?? s.doing?.text;
      return { reason: `${s.name} is working on it now${step ? `: ${step}` : '.'}`, at: s.since ?? null };
    },
  },
  {
    id: 'paused',
    when: (c) => c.pauses.length > 0,
    reason: (c) => ({ reason: `${c.sessions.find((s) => hasId(c.pauses.map((p) => p.sessionId), s.sessionId)).name} stopped at a usage limit and will resume when it resets.`, at: c.pauses[0].resetsAt ?? null }),
  },
  {
    id: 'waiting_you',
    when: (c) => c.req.section === 'waiting' || c.card != null,
    reason: (c) => ({ reason: c.card?.nextAction || c.req.stands || 'Waiting for you.', at: c.card?.waitingSince ?? null }),
  },
  {
    id: 'waiting_helper',
    when: (c) => c.sessions.some((s) => currentStep(s) || idleMs(s, c.now) < IDLE_LIMIT_MS),
    reason: (c) => {
      const s = c.sessions.slice().sort(byRecent)[0];
      const step = currentStep(s);
      const idle = Number.isFinite(idleMs(s, c.now)) ? `idle for ${ago(idleMs(s, c.now))}` : 'idle';
      return { reason: `${s.name} is ${idle}${step ? `, with "${step}" still in progress` : ', between steps'}.`, at: lastActive(s) };
    },
  },
  {
    id: 'not_worked',
    when: () => true,
    reason: (c) => {
      if (!c.sessions.length) {
        return { reason: c.req.section === 'working' ? 'It is listed as being worked on, but no session is open.' : 'No session is on this.' };
      }
      const s = c.sessions.slice().sort(byRecent)[0];
      const idle = idleMs(s, c.now);
      return { reason: `Its session stopped ${Number.isFinite(idle) ? `${ago(idle)} ago` : 'a while ago'} with nothing in progress.`, at: lastActive(s) };
    },
  },
];

const PR_URL = /github\.com\/[^/\s]+\/[^/\s]+\/pull\/\d+/;
const refUrl = (ref) => `https://github.com/${ref.replace('#', '/pull/')}`;

function prUrlOf(req, sessions) {
  const fromLink = req.links.find((u) => PR_URL.test(u));
  if (fromLink) return fromLink;
  const ref = req.prs[0];
  if (ref) return refUrl(ref);
  return sessions.find((s) => s.pr?.url)?.pr.url ?? null;
}

const sessionRow = (s) => ({ sessionId: s.sessionId, name: s.name, busy: s.busy, status: s.status, since: s.since ?? null, lastAt: s.lastAt ?? null, pr: s.pr?.url ?? null });

/**
 * One row per request with the state it is in and why, plus the sessions that match no request.
 * @param {{ requests: Request[], work: object[], limitPauses?: object[], qaCards?: object[], links?: Links, now?: Date }} input
 */
export function buildWorkMap({ requests, work, limitPauses = [], qaCards = [], links = { link: {}, unlink: {} }, now = new Date() }) {
  const matches = matchSessions(requests, work, links);
  const cards = new Map(qaCards.map((c) => [String(c.key).toLowerCase(), c]));
  const matched = new Set();
  const rows = requests.map((req) => {
    const ms = matches.get(req.id);
    for (const m of ms) matched.add(m.session.sessionId);
    const sessions = ms.map((m) => m.session);
    const pauses = limitPauses.filter((p) => !p.handled && sessions.some((s) => hasId([p.sessionId], s.sessionId)));
    const card = req.prs.map((p) => cards.get(p.toLowerCase())).find(Boolean) ?? cards.get(`req:${req.id}`) ?? null;
    const ctx = { req, sessions, pauses, card, now };
    const state = STATES.find((s) => s.when(ctx));
    const { reason, at = null } = state.reason(ctx);
    return {
      ...req,
      state: state.id,
      reason,
      at,
      sessions: ms.map((m) => ({ ...sessionRow(m.session), how: m.how, words: m.words, why: m.why })),
      prUrl: prUrlOf(req, sessions),
      qaKey: state.id === 'waiting_you' ? card?.key ?? null : null,
      canStart: state.id === 'not_worked',
    };
  });
  const counts = Object.fromEntries(STATES.map((s) => [s.id, 0]));
  for (const r of rows) counts[r.state] += 1;
  const other = work
    .filter((s) => !matched.has(s.sessionId))
    .map((s) => ({ ...sessionRow(s), project: s.project ?? null, projectName: s.projectName ?? null, doing: currentStep(s) ?? s.doing?.text ?? null }));
  return { rows, other, counts };
}

const EMPTY_LINKS = () => ({ link: {}, unlink: {} });

export function loadLinks(file) {
  let raw;
  try {
    raw = JSON.parse(readFileSync(file, 'utf8'));
  } catch {
    return EMPTY_LINKS();
  }
  const clean = (m) => Object.fromEntries(Object.entries(m && typeof m === 'object' ? m : {}).map(([k, v]) => [k, Array.isArray(v) ? v.filter((x) => typeof x === 'string') : []]).filter(([, v]) => v.length));
  return { link: clean(raw?.link), unlink: clean(raw?.unlink) };
}

export function saveLinks(file, links) {
  mkdirSync(dirname(file), { recursive: true });
  const tmp = `${file}.${process.pid}.tmp`;
  writeFileSync(tmp, `${JSON.stringify(links, null, 2)}\n`);
  renameSync(tmp, file);
}

/** Returns new links: `on` pins the session to the request, off keeps it off even if the words would match. */
export function setLink(links, reqId, sessionId, on) {
  const without = (m) => ({ ...m, [reqId]: (m[reqId] ?? []).filter((id) => id !== sessionId) });
  const withId = (m) => ({ ...m, [reqId]: [...new Set([...(m[reqId] ?? []), sessionId])] });
  const next = on ? { link: withId(links.link ?? {}), unlink: without(links.unlink ?? {}) } : { link: without(links.link ?? {}), unlink: withId(links.unlink ?? {}) };
  for (const m of [next.link, next.unlink]) if (!m[reqId].length) delete m[reqId];
  return next;
}
