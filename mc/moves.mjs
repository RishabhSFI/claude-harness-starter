import { createHash } from 'node:crypto';
import { clean } from './activity.mjs';
import { askedToIso } from './qa.mjs';

/**
 * @typedef {{ type: 'merge', repo: string, number: number, base: string | null, live: boolean, green: boolean | null, checksText: string | null }
 *   | { type: 'copy', text: string, label: string }
 *   | { type: 'keys', place: string, href: string | null, keys: Array<{ name: string, purpose: string, command: string, where: string, href: string | null }> }
 *   | { type: 'resume', sessionId: string }
 *   | { type: 'open-chat', href: string }
 *   | { type: 'approve', taskId: string }
 *   | { type: 'unpause' }
 *   | { type: 'link', href: string, label: string }} Action
 * @typedef {{ id: string, kind: keyof typeof KINDS, label: string, project: string | null, projectName: string, title: string, why: string, since: string,
 *   group: string, first: string | null, firstNote: string | null, action: Action, detail: string[], version: string, hidden: boolean, checkedAt: string | null }} Move
 * @typedef {{ running: number, waiting: number, stalled: number, idleProjects: Array<{ id: string, name: string, next: string | null }>,
 *   next: { action: object, label: string } | null }} Running
 */

/** Idle with a plan step still open, or busy and silent, this long counts as stopped. */
export const STALLED_IDLE_MS = 10 * 60_000;
export const STALLED_BUSY_MS = 30 * 60_000;

/** One row per kind. A lower tier ranks higher: what restarts work first, then what ships it, then what takes thought. */
export const KINDS = {
  wake: { tier: 1, label: 'Keep work running' },
  unblock: { tier: 1, label: 'Keep work running' },
  merge: { tier: 3, label: 'Merge' },
  key: { tier: 4, label: 'Add keys' },
  command: { tier: 5, label: 'Run a command' },
  answer: { tier: 6, label: 'Answer' },
};

/** A move another move names as `first` ranks this far above its dependent's tier. */
const PREREQUISITE_STEP = 0.5;
const RESUME_TITLE = /^resume paused sessions\b/i;
const CHAT_ID = /^local_[A-Za-z0-9-]{1,64}$/;

const hash = (...parts) => createHash('sha1').update(parts.join('\u0000')).digest('hex').slice(0, 10);
const ms = (iso) => (iso ? Date.parse(iso) : NaN);
const oldest = (...isos) => isos.filter((x) => Number.isFinite(ms(x))).sort((a, b) => ms(a) - ms(b))[0] ?? null;
const short = (text, n = 80) => (String(text).length > n ? `${String(text).slice(0, n - 1).trimEnd()}…` : String(text));
const capital = (text) => text.charAt(0).toUpperCase() + text.slice(1);
/** Drops a leading "<project>:" from a title the project name already sits beside. */
const withoutPrefix = (text, prefixes) => {
  for (const p of prefixes.filter(Boolean)) {
    const cut = text.match(new RegExp(`^${p.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}\\s*:\\s*(.+)$`, 'i'));
    if (cut) return cut[1];
  }
  return text;
};
const names = (list) => (list.length <= 3 ? list.join(', ') : `${list.length} keys`);
const word = (name) => new RegExp(`(?<![A-Za-z0-9_])${name}(?![A-Za-z0-9_])`);
const projectLabel = (projects, id, fallback) => projects.find((p) => p.id === id)?.name ?? fallback ?? id ?? 'Other';

export const chatLink = (localId) => (CHAT_ID.test(localId ?? '') ? `claude://code/continue?session=${localId}` : null);

const DONE_STATUS = new Set(['completed', 'review_ready']);

const isClutterChat = (chat) => Boolean(chat && (chat.archived || chat.scheduledTaskId || RESUME_TITLE.test(chat.title ?? '')));

/**
 * What each live session is to the owner: running, waiting on them, stopped mid-step, finished, or housekeeping
 * (a scheduled run or an archived chat). Only the first three count as work.
 * @returns {Map<string, { w: object, chat: object | null, state: 'running' | 'waiting' | 'stalled' | 'finished' | 'idle' | 'housekeeping' }>}
 */
export function classifyWork(work, desktop = [], now = new Date()) {
  const byCli = new Map(desktop.filter((c) => c.cliId).map((c) => [c.cliId, c]));
  const out = new Map();
  for (const w of work) {
    const chat = byCli.get(w.sessionId) ?? null;
    out.set(w.sessionId, { w, chat, state: stateOf(w, chat, now) });
  }
  return out;
}

function stateOf(w, chat, now) {
  if (isClutterChat(chat) || RESUME_TITLE.test(w.name ?? '')) return 'housekeeping';
  const quiet = now.getTime() - (ms(w.lastAt ?? w.since) || now.getTime());
  if (w.busy) return quiet >= STALLED_BUSY_MS ? 'stalled' : 'running';
  if (chat?.status === 'blocked' && chat.needsAction) return 'waiting';
  if (w.plan?.current) return quiet >= STALLED_IDLE_MS ? 'stalled' : 'running';
  return chat && DONE_STATUS.has(chat.status) ? 'finished' : 'idle';
}

function wakeMoves(classes, projects, queueSessions) {
  return [...classes.values()]
    .filter((c) => c.state === 'stalled')
    .map(({ w, chat }) => {
      const projectName = projectLabel(projects, w.project, w.projectName);
      const step = w.plan?.current ?? null;
      const link = chatLink(chat?.localId);
      const queueStarted = w.kind === 'background' && queueSessions.has(w.sessionId);
      const action = queueStarted
        ? { type: 'resume', sessionId: w.sessionId }
        : link
          ? { type: 'open-chat', href: link }
          : { type: 'copy', text: w.name, label: 'Copy chat name' };
      return {
        id: `wake:${w.sessionId}`,
        kind: 'wake',
        project: w.project,
        projectName,
        title: `Wake ${projectName}: ${withoutPrefix(w.name, [w.project, projectName, w.projectName])}`,
        why: step ? `It stopped partway through "${step}".` : w.busy ? 'It has been busy with no sign of activity.' : 'It stopped partway through its plan.',
        since: w.lastAt ?? w.since ?? null,
        action,
        detail: queueStarted ? [] : [link ? 'Open the chat and type "continue".' : 'Find it in the Claude app sidebar, then type "continue".'],
        version: hash(w.sessionId, w.lastAt, step),
      };
    });
}

function unblockMoves({ queue, settings, projects }) {
  const waiting = queue?.waiting ?? [];
  const out = waiting
    .filter((t) => t.risky && !t.approved)
    .map((t) => ({
      id: `unblock:approve:${t.id}`,
      kind: 'unblock',
      project: t.project,
      projectName: projectLabel(projects, t.project),
      title: `Approve starting "${t.title}"`,
      why: 'It is marked risky, so it waits for your yes before a worker starts.',
      since: t.createdAt ?? null,
      action: { type: 'approve', taskId: t.id },
      detail: [],
      version: hash(t.id, t.approved),
    }));
  if (settings?.paused && waiting.length) {
    out.push({
      id: 'unblock:unpause',
      kind: 'unblock',
      project: null,
      projectName: 'All projects',
      title: 'Start the paused tasks again',
      why: settings.pauseReason ? `Starts are paused: ${clean(settings.pauseReason)}.` : 'Starts are paused.',
      since: null,
      action: { type: 'unpause' },
      detail: [`${waiting.length} ${waiting.length === 1 ? 'task is' : 'tasks are'} waiting.`],
      version: hash(settings.pauseReason, settings.pausedUntil, waiting.length),
    });
  }
  return out;
}

/** Where the owner goes to add a key. GitHub keys have a settings page per repo; a variable sits on a sibling page. */
function keyPlace(where, sample) {
  const kind = where.split(':')[0];
  const rest = where.slice(kind.length + 1);
  if (kind === 'github') {
    const valid = /^[\w.-]+\/[\w.-]+$/.test(rest);
    const page = / variable set /.test(sample.add ?? '') ? 'variables' : 'secrets';
    return { place: `GitHub → ${rest} → Settings → ${page === 'secrets' ? 'Secrets' : 'Variables'} → Actions`, href: valid ? `https://github.com/${rest}/settings/${page}/actions` : null, short: 'on GitHub' };
  }
  if (kind === 'vercel') return { place: `Vercel → ${rest.split(':')[0]} → Settings → Environment Variables`, href: null, short: 'on Vercel' };
  return { place: `Local file ${rest}`, href: null, short: 'in a local file' };
}

function keyMoves({ secrets, secretsAt, projects }) {
  const moves = [];
  for (const p of secrets ?? []) {
    const groups = new Map();
    for (const s of p.secrets ?? []) {
      if (s.status !== 'missing' || s.required === false) continue;
      groups.set(s.where, [...(groups.get(s.where) ?? []), s]);
    }
    for (const [where, list] of groups) {
      const place = keyPlace(where, list[0]);
      const projectName = projectLabel(projects, p.id, p.name);
      moves.push({
        id: `key:${p.id}:${where}`,
        kind: 'key',
        project: p.id,
        projectName,
        title: `Add ${names(list.map((s) => s.name))} to ${projectName} ${place.short}`,
        why: `Only you have ${list.length === 1 ? 'this value' : 'these values'}.`,
        since: null,
        action: {
          type: 'keys',
          place: place.place,
          href: place.href,
          keys: list.map((s) => ({ name: s.name, purpose: s.purpose ?? '', command: s.add ?? '', where: place.place, href: place.href })),
        },
        detail: [place.place],
        version: hash(...list.map((s) => s.name).sort()),
        checkedAt: secretsAt ?? null,
        _names: list.map((s) => s.name),
      });
    }
  }
  return moves;
}

/** A row's stands text with each command swapped for "the command below" (the copy box shows it), and a bare "Run" dropped. */
function standsWithout(r) {
  const text = r.commands.reduce((t, c) => t.split(c).join('the command below'), r.stands).replace(/\s+/g, ' ').replace(/\s+([.,;])/g, '$1').trim();
  return /^(owner to )?run( the command below)?[\s.:,;]*$/i.test(text) ? '' : text;
}

/**
 * A waiting row that names a PR with its own merge move adds nothing new: its "where it stands" becomes that move's
 * reason, and it waits as long as the older of the two. Returns the ids of the rows it absorbed.
 */
function foldIntoMerges({ requests, merges, now, covered }) {
  const folded = new Set();
  for (const r of requests.filter((x) => x.section === 'waiting' && !covered.has(x.id) && !x.commands?.length)) {
    const m = merges.find((x) => r.prs.some((p) => p.toLowerCase() === x._pr));
    if (!m) continue;
    folded.add(r.id);
    m.detail = [m._title, ...m.detail];
    m.why = r.stands || m.why;
    m.since = oldest(m.since, askedToIso(r.asked, now));
    m.version = hash(m.version, r.stands);
  }
  return folded;
}

function rowMoves({ requests, projects, now, covered }) {
  const out = [];
  for (const r of requests.filter((x) => x.section === 'waiting')) {
    if (covered.has(r.id)) continue;
    const projectName = projectLabel(projects, r.project, r.project);
    const base = { project: r.project, projectName, since: askedToIso(r.asked, now) };
    const title = capital(withoutPrefix(r.text, [projectName, r.project]));
    if (r.commands?.length) {
      r.commands.forEach((text, i) =>
        out.push({
          ...base,
          id: `command:${r.id}:${i}`,
          kind: 'command',
          title: `${short(title)}${r.commands.length > 1 ? ` (${i + 1} of ${r.commands.length})` : ''}`,
          why: standsWithout(r),
          action: { type: 'copy', text, label: 'Copy command' },
          detail: [],
          version: hash(text, r.stands),
        }),
      );
      continue;
    }
    const pr = r.prs[0]?.match(/^(.+)#(\d+)$/);
    out.push({
      ...base,
      id: `answer:request:${r.id}`,
      kind: 'answer',
      title: short(title),
      why: r.stands,
      action: pr
        ? { type: 'link', href: `https://github.com/${pr[1]}/pull/${pr[2]}`, label: `Open PR #${pr[2]}` }
        : { type: 'link', href: `#qa/${encodeURIComponent(`req:${r.id}`)}`, label: 'Open request' },
      detail: [],
      version: hash(r.text, r.stands),
    });
  }
  return out;
}

function chatAnswerMoves(classes, desktop, projects) {
  const live = new Map([...classes.values()].filter((c) => c.chat).map((c) => [c.chat.localId, c.w]));
  return desktop
    .filter((c) => c.status === 'blocked' && c.needsAction && !c.archived && !RESUME_TITLE.test(c.title ?? '') && chatLink(c.localId))
    .map((c) => ({
      id: `answer:chat:${c.localId}`,
      kind: 'answer',
      project: live.get(c.localId)?.project ?? null,
      projectName: live.has(c.localId) ? projectLabel(projects, live.get(c.localId).project, live.get(c.localId).projectName) : 'A chat',
      title: `Answer in "${clean(c.title ?? 'a chat')}"`,
      why: clean(c.needsAction),
      since: c.lastActivityAt,
      action: { type: 'open-chat', href: chatLink(c.localId) },
      detail: [],
      version: hash(c.localId, c.needsAction, c.lastActivityAt),
    }));
}

const checkWords = (c) => {
  if (!c.total) return 'no checks';
  return [[c.pass, 'passing'], [c.fail, 'failing'], [c.pending, 'pending']].filter(([n]) => n).map(([n, w]) => `${n} ${w}`).join(', ');
};

/** PRs the owner can merge: waiting in the Needs you lane against a public base, plus Ready to QA cards that aren't blocked. */
function mergeMoves({ lanes, qaCards, projects }) {
  const found = new Map();
  const put = (key, v) => found.set(key, { ...found.get(key), ...v });
  for (const card of lanes?.find((l) => l.id === 'needs_you')?.cards ?? []) {
    const pr = card.pr;
    if (!pr?.repo || pr.classification !== 'review' || pr.draft || pr.conflict) continue;
    const c = card.checks;
    put(`${pr.repo}#${pr.number}`.toLowerCase(), { repo: pr.repo, number: pr.number, base: pr.base ?? null, live: true, title: card.title, project: card.project, url: pr.url, checks: c ? { green: c.total > 0 && c.pass === c.total, text: checkWords(c) } : null });
  }
  for (const c of qaCards ?? []) {
    const key = c.kind === 'pr' && c.repo ? `${c.repo}#${c.number}`.toLowerCase() : null;
    if (!key) continue;
    if (c.blockedBy) {
      found.delete(key);
      continue;
    }
    put(key, { repo: c.repo, number: c.number, base: c.base ?? null, live: Boolean(c.live), title: c.title, project: c.project, url: c.url, summary: c.summary, waitingSince: c.waitingSince, checks: c.checks ? { green: c.checks.green, text: c.checks.text } : null });
  }
  return [...found.values()].map((m) => ({
    id: `merge:${m.repo}#${m.number}`,
    kind: 'merge',
    project: m.project,
    projectName: projectLabel(projects, m.project),
    title: `Merge ${projectLabel(projects, m.project)} #${m.number}${m.base ? ` into ${m.base}` : ''}`,
    why: m.summary && !m.summary.startsWith(m.title) ? `${m.title}. ${m.summary}` : `${m.title}.`,
    since: m.waitingSince ?? null,
    action: { type: 'merge', repo: m.repo, number: m.number, base: m.base, live: m.live, green: m.checks?.green ?? null, checksText: m.checks?.text ?? null },
    detail: [m.checks?.text ? `Checks: ${m.checks.text}.` : 'GitHub is checked again at merge time.', ...(m.url ? [m.url] : [])],
    version: hash(m.url ?? m.number, m.checks?.text, m.base),
    _pr: `${m.repo}#${m.number}`.toLowerCase(),
    _title: m.title,
  }));
}

/**
 * A waiting row that names a missing key is that key's move, not a second one: it sets the key's age, and when the row
 * also names a PR in the same project, that PR's merge waits on the key.
 */
function linkRows({ requests, keys, merges, now }) {
  const covered = new Set();
  const sinceByKey = new Map();
  for (const r of requests.filter((x) => x.section === 'waiting')) {
    const text = `${r.text} ${r.stands}`;
    const hits = keys.filter((k) => k._names.some((n) => word(n).test(text)));
    if (!hits.length) continue;
    covered.add(r.id);
    for (const k of hits) sinceByKey.set(k.id, oldest(sinceByKey.get(k.id), askedToIso(r.asked, now)));
    for (const m of merges.filter((x) => r.prs.some((p) => p.toLowerCase() === x._pr))) {
      const hit = hits.find((k) => k.project === m.project);
      if (hit && !m.first) {
        m.first = hit.id;
        m.firstNote = `First: add ${hit._names.filter((n) => word(n).test(text)).join(', ')}`;
      }
    }
  }
  return { covered, sinceByKey };
}

/**
 * Everything only the owner can do, ranked: moves that restart work, then moves another move waits on, then merges,
 * keys and commands, then answers. Within a rank the longest wait comes first.
 * `seen` maps move id to when it first appeared; `hidden` maps move id to the version the owner hid.
 * @returns {Move[]}
 */
export function buildMoves({ work = [], queue = null, settings = {}, lanes = [], qaCards = [], requests = [], secrets = [], secretsAt = null, desktop = [], projects = [], seen = {}, hidden = {}, now = new Date() }) {
  const classes = classifyWork(work, desktop, now);
  const queueSessions = new Set(work.filter((w) => w.taskId).map((w) => w.sessionId));
  const merges = mergeMoves({ lanes, qaCards, projects });
  const keys = keyMoves({ secrets, secretsAt, projects });
  const { covered, sinceByKey } = linkRows({ requests, keys, merges, now });
  for (const id of foldIntoMerges({ requests, merges, now, covered })) covered.add(id);
  const all = [
    ...wakeMoves(classes, projects, queueSessions),
    ...unblockMoves({ queue, settings, projects }),
    ...merges,
    ...keys.map((k) => ({ ...k, since: sinceByKey.get(k.id) ?? null })),
    ...rowMoves({ requests, projects, now, covered }),
    ...chatAnswerMoves(classes, desktop, projects),
  ].map((m) => ({
    first: null,
    firstNote: null,
    checkedAt: null,
    ...m,
    label: KINDS[m.kind].label,
    group: KINDS[m.kind].label,
    since: oldest(seen[m.id], m.since) ?? now.toISOString(),
    hidden: hidden[m.id] === m.version,
  }));
  return rank(all).map((m) => Object.fromEntries(Object.entries(m).filter(([k]) => !k.startsWith('_'))));
}

function rank(moves) {
  const tier = new Map(moves.map((m) => [m.id, KINDS[m.kind].tier]));
  for (const m of moves) {
    const dependent = moves.find((d) => d.first === m.id);
    if (dependent) {
      tier.set(m.id, Math.min(tier.get(m.id), KINDS[dependent.kind].tier - PREREQUISITE_STEP));
      m.group = dependent.group;
    }
  }
  return [...moves].sort((a, b) => tier.get(a.id) - tier.get(b.id) || ms(a.since) - ms(b.since) || a.id.localeCompare(b.id));
}

/**
 * How much work is going on, and what would start more.
 * `next` is set only when nothing is running: a held task to approve or unpause, else a request nobody is on.
 * @returns {Running}
 */
export function buildRunning({ work = [], queue = null, settings = {}, desktop = [], projects = [], requests = [], now = new Date() }) {
  const classes = [...classifyWork(work, desktop, now).values()];
  const count = (state) => classes.filter((c) => c.state === state).length;
  const running = count('running');
  const busyIn = new Set(classes.filter((c) => c.state === 'running').map((c) => c.w.project));
  const waiting = queue?.waiting ?? [];
  const idleProjects = projects
    .filter((p) => !busyIn.has(p.id))
    .map((p) => ({ id: p.id, name: p.name, next: waiting.find((t) => t.project === p.id)?.title ?? null }));
  return { running, waiting: count('waiting'), stalled: count('stalled'), idleProjects, next: running ? null : nextStart({ waiting, settings, requests, projects }) };
}

function nextStart({ waiting, settings, requests, projects }) {
  const risky = waiting.find((t) => t.risky && !t.approved);
  if (risky) return { action: { type: 'approve', taskId: risky.id }, label: `Approve and start: ${risky.title}` };
  if (settings?.paused && waiting.length) return { action: { type: 'unpause' }, label: `Unpause and start: ${waiting[0].title}` };
  const open = requests.find((r) => r.section === 'open' && projects.some((p) => p.id === r.project));
  return open ? { action: { type: 'start', requestId: open.id }, label: `Start: ${short(open.text, 60)}` } : null;
}

/** Each live session's state by id: running, waiting, stalled, finished, or archived and scheduled for housekeeping. */
export function sessionStates(work, desktop, now = new Date()) {
  return Object.fromEntries([...classifyWork(work, desktop, now).values()].map(({ w, chat, state }) => [w.sessionId, state === 'housekeeping' ? (chat?.archived ? 'archived' : 'scheduled') : state]));
}

/** `{id: since}` for the moves on the list, so a move that left the list also leaves the first-seen map. */
export const seenFrom = (moves) => Object.fromEntries(moves.map((m) => [m.id, m.since]));

/** Keeps a hidden entry only while its move is still on the list at the version the owner hid. */
export const hiddenFrom = (moves, hidden) => Object.fromEntries(moves.filter((m) => hidden[m.id] === m.version).map((m) => [m.id, m.version]));
