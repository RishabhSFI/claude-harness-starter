import { open, readdir, readFile, stat } from 'node:fs/promises';
import { homedir } from 'node:os';
import { dirname, join, relative, resolve, sep } from 'node:path';
import { redact } from '../wiki.mjs';
import { sameSession } from './queue.mjs';

/**
 * What a session is doing, read from its transcript. Transcript text is data: every string that leaves
 * this module goes through `clean`, which redacts secrets and cuts it to one short line.
 *
 * @typedef {{content: string, status: 'pending'|'in_progress'|'completed'}} PlanItem
 * @typedef {{items: PlanItem[], step: number, total: number, done: number, current: string | null}} Plan
 * @typedef {{at: string, kind: 'tool'|'said'|'plan', text: string}} ActivityEvent
 * @typedef {{plan: Plan | null, doing: {text: string, tool: string, at: string} | null, said: {text: string, at: string} | null,
 *   lastAt: string | null, turnAt: string | null, events: ActivityEvent[]}} Activity
 */

export const DEFAULT_PROJECTS_DIR = join(homedir(), '.claude', 'projects');
export const TAIL_BYTES = 256 * 1024;
export const LOOK_BACK_BYTES = 16 * 1024 * 1024;
const MAX_TEXT = 160;
const MAX_EVENTS = 20;
export const PLAN_TOOL = 'mcp__ccd_turn__update_plan';
export const WRAP_TOOL = 'mcp__ccd_turn__wrap_up';
const HOME = homedir();

export function clean(text) {
  const line = redact(String(text ?? '')).replace(/[\x00-\x1f\x7f\s]+/g, ' ').trim();
  return line.length > MAX_TEXT ? `${line.slice(0, MAX_TEXT - 1).trimEnd()}…` : line;
}

function shortPath(p, cwd) {
  if (!p) return 'a file';
  const abs = resolve(cwd ?? '/', String(p));
  if (cwd && (abs === cwd || abs.startsWith(cwd + sep))) return relative(cwd, abs) || '.';
  return abs.startsWith(HOME + sep) ? `~${abs.slice(HOME.length)}` : abs;
}

const is = (...names) => (name) => names.includes(name);
const bash = (re) => (name, input) => name === 'Bash' && re.test(String(input?.command ?? ''));
const shortTool = (name) => (name.startsWith('mcp__') ? name.split('__').at(-1).replace(/_/g, ' ') : name);

/** Tool call to plain words. First match wins; the last entry matches everything. */
export const TOOL_WORDS = [
  { match: bash(/\b(node --test|npm (run )?test|pytest|vitest|jest)\b/), words: () => 'Running tests' },
  { match: bash(/\bgit\b[^|;&\n]*\bcommit\b/), words: () => 'Committing' },
  { match: bash(/\bgit\b[^|;&\n]*\bpush\b/), words: () => 'Pushing' },
  { match: bash(/\bgh pr\b/), words: () => 'Working on the PR' },
  { match: is('Bash'), words: (input) => input?.description || 'Running a command' },
  { match: is('Edit', 'MultiEdit', 'Write', 'NotebookEdit'), words: (input, cwd) => `Editing ${shortPath(input?.file_path ?? input?.notebook_path, cwd)}` },
  { match: is('Read'), words: (input, cwd) => `Reading ${shortPath(input?.file_path, cwd)}` },
  { match: is('Grep', 'Glob'), words: () => 'Searching the code' },
  { match: is('Agent', 'Task'), words: (input) => (input?.description ? `Waiting on a helper: ${input.description}` : 'Waiting on a helper') },
  { match: is('Skill'), words: (input) => `Loading the ${input?.skill ?? ''} skill` },
  { match: is('WebSearch', 'WebFetch'), words: () => 'Reading the web' },
  { match: (name) => name.startsWith('mcp__Claude_Browser__'), words: () => 'Checking the page in the browser' },
  { match: is(PLAN_TOOL), words: () => 'Updating the plan' },
  { match: is(WRAP_TOOL), words: () => 'Wrapping up' },
  { match: is('mcp__ccd_session__start_session'), words: () => 'Starting a session' },
  { match: is('SendMessage'), words: () => 'Messaging a session' },
  { match: is('ScheduleWakeup', 'Monitor'), words: () => 'Waiting' },
  { match: is('ReadNotifications'), words: () => 'Checking on its helpers' },
  { match: is('ToolSearch'), words: () => 'Loading tools' },
  { match: () => true, words: (_, __, name) => `Using ${shortTool(name)}` },
];

export function toolWords(name, input, cwd) {
  return clean(TOOL_WORDS.find((r) => r.match(name, input)).words(input, cwd, name));
}

const STATUSES = new Set(['pending', 'in_progress', 'completed']);
const setStatus = (items, i, status) => items.map((x, j) => (j === i ? { ...x, status } : x));

/** Each update_plan input shape and what it does to the list. `{completeAll}` stands for wrap_up. */
const PLAN_OPS = [
  {
    when: (input) => Array.isArray(input.items),
    apply: (_, input) => input.items.map((x) => ({ content: clean(x?.content), status: STATUSES.has(x?.status) ? x.status : 'pending' })),
  },
  { when: (input) => input.completeAll === true, apply: (items) => items.map((x) => ({ ...x, status: 'completed' })) },
  {
    when: (input) => input.advance === true,
    apply: (items) => {
      const cur = items.findIndex((x) => x.status === 'in_progress');
      const done = cur < 0 ? items : setStatus(items, cur, 'completed');
      const after = done.findIndex((x, j) => j > cur && x.status === 'pending');
      const next = after >= 0 ? after : done.findIndex((x) => x.status === 'pending');
      return next >= 0 ? setStatus(done, next, 'in_progress') : done;
    },
  },
  {
    when: (input) => Array.isArray(input.done) || Number.isInteger(input.start),
    apply: (items, input) => {
      let out = items;
      for (const n of input.done ?? []) if (Number.isInteger(n) && out[n - 1]) out = setStatus(out, n - 1, 'completed');
      const start = Number.isInteger(input.start) && out[input.start - 1] ? input.start - 1 : -1;
      if (start < 0) return out;
      return out.map((x, j) => (j === start ? { ...x, status: 'in_progress' } : x.status === 'in_progress' ? { ...x, status: 'pending' } : x));
    },
  },
];

/** @returns {Plan | null} */
function planView(items) {
  if (!items.length) return null;
  const done = items.filter((x) => x.status === 'completed').length;
  const cur = items.findIndex((x) => x.status === 'in_progress');
  return { items, step: cur >= 0 ? cur + 1 : done, total: items.length, done, current: cur >= 0 ? items[cur].content : null };
}

/** @returns {Plan | null} the plan after one update_plan input. An update with no list to update keeps null. */
export function reducePlan(plan, input) {
  const op = input && typeof input === 'object' ? PLAN_OPS.find((o) => o.when(input)) : null;
  if (!op || (!plan && !Array.isArray(input.items))) return plan;
  return planView(op.apply(plan?.items ?? [], input));
}

function firstLine(text) {
  const line = String(text ?? '')
    .split('\n')
    .map((l) => l.replace(/^\s*(#+|[-*>]|\d+\.)\s+/, '').replace(/\[([^\]]+)\]\([^)]*\)/g, '$1').replace(/\*\*|__|`/g, '').trim())
    .find(Boolean);
  return line ? clean(line) : null;
}

const isPrompt = (e) => {
  const c = e.message?.content;
  return typeof c === 'string' || (Array.isArray(c) && c.some((b) => b?.type === 'text'));
};

/** Folds transcript entries, oldest first, into an Activity. Helper (sidechain) entries are skipped. */
function createReducer(cwd) {
  let plan = null;
  let doing = null;
  let said = null;
  let lastAt = null;
  let turnAt = null;
  let events = [];
  const push = (at, kind, text) => {
    if (!text) return;
    events.push({ at, kind, text });
    if (events.length > 2 * MAX_EVENTS) events = events.slice(-MAX_EVENTS);
  };
  return {
    step(e) {
      const at = typeof e?.timestamp === 'string' ? e.timestamp : null;
      if (!at || e.isSidechain) return;
      if (!lastAt || at > lastAt) lastAt = at;
      if (e.type === 'user' && !e.isMeta && isPrompt(e)) turnAt = at;
      if (e.type !== 'assistant' || !Array.isArray(e.message?.content)) return;
      for (const b of e.message.content) {
        if (b?.type === 'tool_use' && typeof b.name === 'string') {
          const bookkeeping = b.name === PLAN_TOOL || b.name === WRAP_TOOL;
          if (!bookkeeping || !doing) doing = { text: toolWords(b.name, b.input, cwd), tool: clean(b.name), at };
          if (b.name === PLAN_TOOL) {
            const before = plan?.current;
            plan = reducePlan(plan, b.input);
            if (plan?.current && plan.current !== before) push(at, 'plan', clean(`Step ${plan.step} of ${plan.total}: ${plan.current}`));
          } else if (b.name === WRAP_TOOL) {
            plan = reducePlan(plan, { completeAll: true });
            const recap = firstLine(b.input?.recap);
            if (recap) said = { text: recap, at };
            push(at, 'said', recap);
          } else push(at, 'tool', doing.text);
        } else if (b?.type === 'text') {
          const line = firstLine(b.text);
          if (line) {
            said = { text: line, at };
            push(at, 'said', line);
          }
        }
      }
    },
    /** @returns {Activity} */
    view: () => ({ plan, doing, said, lastAt, turnAt, events: events.slice(-MAX_EVENTS) }),
  };
}

/** @returns {Activity} from transcript entries, oldest first. Helper (sidechain) entries are skipped. */
export function sessionActivity(entries, { cwd } = {}) {
  const r = createReducer(cwd);
  for (const e of entries) r.step(e);
  return r.view();
}

function parseLines(buf) {
  const entries = [];
  for (const line of buf.toString('utf8').split('\n')) {
    if (!line) continue;
    try {
      entries.push(JSON.parse(line));
    } catch {}
  }
  return entries;
}

async function readRange(fh, from, to) {
  const buf = Buffer.alloc(to - from);
  let got = 0;
  while (got < buf.length) {
    const { bytesRead } = await fh.read(buf, got, buf.length - got, from + got);
    if (!bytesRead) break;
    got += bytesRead;
  }
  return buf.subarray(0, got);
}

/**
 * What the tail left unknown, found by reading backward from `pos`: the latest plan list and the updates after it,
 * the latest prompt, the latest thing said, the latest tool. `carry` is the start of the line that runs past `pos`.
 * Returns just those pieces as entries, oldest first, ready to fold in before the tail. Reads at most LOOK_BACK_BYTES;
 * whatever lies further back stays unknown.
 */
async function lookBack(fh, pos, carry, need) {
  const found = [];
  const take = (e) => {
    const at = typeof e?.timestamp === 'string' ? e.timestamp : null;
    if (!at || e.isSidechain) return;
    if (e.type === 'user' && !e.isMeta && isPrompt(e) && need.turn) {
      need.turn = false;
      found.push({ type: 'user', timestamp: at, message: { content: '' } });
      return;
    }
    if (e.type !== 'assistant' || !Array.isArray(e.message?.content)) return;
    const keep = [];
    for (const b of [...e.message.content].reverse()) {
      if (b?.type === 'tool_use' && b.name === PLAN_TOOL) {
        if (!need.plan) continue;
        keep.push(b);
        if (Array.isArray(b.input?.items)) need.plan = false;
      } else if (b?.type === 'tool_use' && b.name === WRAP_TOOL) {
        const recap = need.said && firstLine(b.input?.recap);
        if (need.plan || recap) keep.push(b);
        if (recap) need.said = false;
      } else if (b?.type === 'tool_use' && need.doing) {
        keep.push(b);
        need.doing = false;
      } else if (b?.type === 'text' && need.said && firstLine(b.text)) {
        keep.push(b);
        need.said = false;
      }
    }
    if (keep.length) found.push({ type: 'assistant', timestamp: at, message: { content: keep.reverse() } });
  };
  const wanted = () => need.plan || need.turn || need.said || need.doing;
  const stop = Math.max(0, pos - LOOK_BACK_BYTES);
  let parts = [carry];
  while (pos > stop && wanted()) {
    const from = Math.max(stop, pos - TAIL_BYTES);
    const chunk = await readRange(fh, from, pos);
    pos = from;
    const nl = pos > 0 ? chunk.indexOf(10) : -1;
    if (pos > 0 && nl < 0) {
      parts.unshift(chunk);
      continue;
    }
    const entries = parseLines(Buffer.concat([chunk.subarray(nl + 1), ...parts]));
    parts = [pos > 0 ? chunk.subarray(0, nl) : Buffer.alloc(0)];
    for (let i = entries.length - 1; i >= 0 && wanted(); i--) take(entries[i]);
  }
  return found.reverse();
}

/**
 * Activity per transcript, read incrementally. A file seen for the first time is read from its last
 * TAIL_BYTES, then backward once until the plan list, turn start and last message are found (or the
 * file's start, or LOOK_BACK_BYTES). After that only appended bytes are read. A file that shrank is read fresh.
 */
export function createTranscriptCache() {
  const files = new Map();

  async function first(file, size, cwd) {
    const fh = await open(file, 'r');
    try {
      const start = Math.max(0, size - TAIL_BYTES);
      let buf = await readRange(fh, start, size);
      const readTo = start + buf.length;
      let carry = Buffer.alloc(0);
      if (start > 0) {
        const nl = buf.indexOf(10);
        carry = nl < 0 ? buf : buf.subarray(0, nl);
        buf = nl < 0 ? Buffer.alloc(0) : buf.subarray(nl + 1);
      }
      const end = buf.lastIndexOf(10) + 1;
      const tail = parseLines(buf.subarray(0, end));
      const seen = sessionActivity(tail, { cwd });
      const need = { plan: !seen.plan, turn: !seen.turnAt, said: !seen.said, doing: !seen.doing };
      const older = await lookBack(fh, start, carry, need);
      const reducer = createReducer(cwd);
      for (const e of older) reducer.step(e);
      for (const e of tail) reducer.step(e);
      return { offset: readTo, partial: Buffer.from(buf.subarray(end)), reducer, view: reducer.view() };
    } finally {
      await fh.close();
    }
  }

  async function more(f, file, size) {
    const fh = await open(file, 'r');
    try {
      const buf = Buffer.concat([f.partial, await readRange(fh, f.offset, size)]);
      f.offset = size;
      const end = buf.lastIndexOf(10) + 1;
      f.partial = Buffer.from(buf.subarray(end));
      for (const e of parseLines(buf.subarray(0, end))) f.reducer.step(e);
      f.view = f.reducer.view();
    } finally {
      await fh.close();
    }
  }

  async function update(file, cwd) {
    const { size } = await stat(file);
    let f = files.get(file);
    if (f && (size < f.offset || f.cwd !== cwd)) f = null;
    if (!f) {
      f = { ...(await first(file, size, cwd)), cwd };
      files.set(file, f);
    } else if (size > f.offset) await more(f, file, size);
    return f.view;
  }

  const running = new Map();
  return {
    /** @returns {Promise<Activity>} One read per file at a time; a call during a read waits for it. */
    async read(file, cwd) {
      while (running.has(file)) await running.get(file).catch(() => {});
      const p = update(file, cwd);
      running.set(file, p);
      try {
        return await p;
      } finally {
        running.delete(file);
      }
    },
    /** Forgets every file not in `keep`. */
    retain(keep) {
      for (const file of files.keys()) if (!keep.has(file)) files.delete(file);
    },
    get size() {
      return files.size;
    },
  };
}

const transcriptPaths = new Map();
const misses = new Map();
/** How long a transcript that wasn't found anywhere is not searched for again (the cwd guess is still checked). */
export const MISS_TTL_MS = 30_000;
const exists = (p) => stat(p).then(() => true, () => false);
/** Claude Code names a transcript folder after the cwd with every other character turned into a dash. */
const folderOf = (cwd) => String(cwd).replace(/[^a-zA-Z0-9]/g, '-');

/** @returns {Promise<string | null>} `<projectsDir>/<folder>/<sessionId>.jsonl`, found by cwd first, then by scanning. */
export async function findTranscript(projectsDir, sessionId, cwd, now = Date.now()) {
  const key = `${projectsDir}\0${sessionId}`;
  const known = transcriptPaths.get(key);
  if (known && (await exists(known))) return known;
  const guess = cwd ? join(projectsDir, folderOf(cwd), `${sessionId}.jsonl`) : null;
  let found = guess && (await exists(guess)) ? guess : null;
  if (!found && !(misses.get(key) > now)) {
    const dirs = await readdir(projectsDir, { withFileTypes: true }).catch(() => []);
    for (const d of dirs.filter((x) => x.isDirectory())) {
      const files = await readdir(join(projectsDir, d.name)).catch(() => []);
      const name = files.find((f) => f.endsWith('.jsonl') && sameSession(sessionId, f.slice(0, -6)));
      if (name) {
        found = join(projectsDir, d.name, name);
        break;
      }
    }
    if (!found) misses.set(key, now + MISS_TTL_MS);
  }
  if (found) {
    transcriptPaths.set(key, found);
    misses.delete(key);
  }
  for (const [k, until] of misses) if (until <= now) misses.delete(k);
  return found;
}

/** @returns {Promise<string | null>} the branch checked out at `cwd`, read from `.git` without running git. */
export async function readBranch(cwd) {
  for (let dir = resolve(cwd), i = 0; i < 8; dir = dirname(dir), i++) {
    const dotGit = join(dir, '.git');
    const st = await stat(dotGit).catch(() => null);
    if (st) {
      let gitDir = dotGit;
      if (st.isFile()) {
        const m = (await readFile(dotGit, 'utf8')).match(/^gitdir:\s*(.+)$/m);
        if (!m) return null;
        gitDir = resolve(dir, m[1].trim());
      }
      const head = await readFile(join(gitDir, 'HEAD'), 'utf8').catch(() => '');
      return head.match(/^ref: refs\/heads\/(.+)$/m)?.[1].trim() ?? null;
    }
    if (dirname(dir) === dir) break;
  }
  return null;
}

/** Reads sessions' activity and branches, keeping per-transcript state only for the sessions it was last asked about. */
export function createActivityReader({ projectsDir = DEFAULT_PROJECTS_DIR } = {}) {
  const transcripts = createTranscriptCache();
  /** @returns {Promise<{activity: Activity | null, branch: string | null, file: string | null}>} never rejects. */
  async function read(session) {
    const branch = session.cwd ? await readBranch(session.cwd).catch(() => null) : null;
    const file = await findTranscript(projectsDir, session.sessionId, session.cwd).catch(() => null);
    if (!file) return { activity: null, branch, file };
    const activity = await transcripts.read(file, session.cwd).catch(() => null);
    return { activity, branch, file };
  }
  return {
    /** @returns {Promise<Map<string, {activity: Activity | null, branch: string | null}>>} by session id. Never rejects. */
    async readAll(sessions) {
      const reads = await Promise.all(sessions.map(async (x) => [x.sessionId, await read(x)]));
      transcripts.retain(new Set(reads.map(([, r]) => r.file).filter(Boolean)));
      return new Map(reads.map(([id, { activity, branch }]) => [id, { activity, branch }]));
    },
    get cached() {
      return transcripts.size;
    },
  };
}
