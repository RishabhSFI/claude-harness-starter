// Finds Claude Code sessions that stopped at a usage limit, and when each limit resets.
import { closeSync, existsSync, fstatSync, mkdirSync, openSync, readdirSync, readFileSync, readSync, renameSync, statSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { basename, dirname, join } from 'node:path';

/**
 * @typedef {{sessionId: string, localId: string | null, archived: boolean, cwd: string | null, title: string | null, pausedAt: string,
 *   resetsAt: string, resetGuessed: boolean, due: boolean, handled: boolean, message: string, file: string}} Pause
 * @typedef {Record<string, {pausedAt: string, markedAt: string}>} Marks
 */

export const DEFAULT_PROJECTS_DIR = join(homedir(), '.claude', 'projects');
/** Where the desktop app keeps one JSON file per chat, which names the CLI transcript it runs (`cliSessionId`). */
export const DEFAULT_DESKTOP_DIR = join(homedir(), 'Library', 'Application Support', 'Claude', 'claude-code-sessions');
/** Weekly limits reset up to 7 days later, so look a little further back than that. */
const LOOKBACK_MS = 8 * 24 * 3600_000;
/** When a limit record names no reset time, assume the five-hour session window. */
const FALLBACK_WINDOW_MS = 5 * 3600_000;
const TAIL_BYTES = [256 * 1024, 4 * 1024 * 1024];
const MARK_TTL_MS = 30 * 24 * 3600_000;
/** The first line of `scheduled/resume-paused.md`'s prompt. A transcript whose first prompt holds it is the resume task itself, never a chat to wake. */
export const RESUME_TASK_MARKER = 'This is the resume-paused-sessions task.';
const HEAD_BYTES = 256 * 1024;
const MONTHS = ['jan', 'feb', 'mar', 'apr', 'may', 'jun', 'jul', 'aug', 'sep', 'oct', 'nov', 'dec'];

const textOf = (record) => {
  const c = record?.message?.content;
  if (typeof c === 'string') return c;
  return Array.isArray(c) ? c.map((x) => (typeof x?.text === 'string' ? x.text : '')).join('') : '';
};

/** True for the synthetic assistant record Claude Code writes when a request is refused for a usage limit. */
export function isLimitRecord(record) {
  if (record?.type !== 'assistant' || record.isApiErrorMessage !== true) return false;
  if (record.error === 'rate_limit' || record.apiError === 'usage_limit_reached') return true;
  return /usage limit reached|hit your .*limit|limit reached/i.test(textOf(record));
}

/** Milliseconds `tz` is ahead of UTC at `instant`. Throws RangeError for an unknown zone. */
function zoneOffset(instant, tz) {
  const parts = Object.fromEntries(
    new Intl.DateTimeFormat('en-US', { timeZone: tz, hourCycle: 'h23', year: 'numeric', month: 'numeric', day: 'numeric', hour: 'numeric', minute: 'numeric', second: 'numeric' })
      .formatToParts(new Date(instant))
      .map((p) => [p.type, Number(p.value)]),
  );
  return Date.UTC(parts.year, parts.month - 1, parts.day, parts.hour, parts.minute, parts.second) - Math.floor(instant / 1000) * 1000;
}

/**
 * The instant a wall-clock time in `tz` names. Day overflow (day 32) rolls into the next month.
 * Tries the zone's offsets from a day either side: a time that exists once has one match; a repeated fall-back time takes
 * the later instant; a time skipped by spring-forward takes the matching time after the change (2:30 becomes 3:30).
 */
function zonedInstant({ year, month, day, hour, minute }, tz) {
  const wall = Date.UTC(year, month, day, hour, minute);
  const offsets = [...new Set([-1, 0, 1].map((d) => zoneOffset(wall + d * 24 * 3600_000, tz)))];
  const exact = offsets.map((o) => wall - o).filter((at) => wall - zoneOffset(at, tz) === at);
  return Math.max(...(exact.length ? exact : offsets.map((o) => wall - o)));
}

function wallDate(instant, tz) {
  const parts = Object.fromEntries(
    new Intl.DateTimeFormat('en-US', { timeZone: tz, year: 'numeric', month: 'numeric', day: 'numeric' }).formatToParts(new Date(instant)).map((p) => [p.type, Number(p.value)]),
  );
  return { year: parts.year, month: parts.month - 1, day: parts.day };
}

const RESET = /\bresets?\s+(?:at\s+)?(?:(?:on\s+)?([a-z]{3})[a-z]*\.?\s+(\d{1,2})(?:st|nd|rd|th)?,?\s+(?:at\s+)?)?(\d{1,2})(?::(\d{2}))?\s*(am|pm)?(?:\s*\(([^)]+)\))?/i;

/**
 * The reset instant a limit message names, or null when it names none.
 * Handles "resets 6:20pm (America/Toronto)", "resets Nov 7, 6pm (America/Toronto)", "resets Nov 7 at 18:00"
 * and the older "Claude AI usage limit reached|<epoch seconds>". A time with no date is its next occurrence
 * after `pausedAt`; a date with no year is the nearest one not before `pausedAt`. With no zone named, `defaultZone` applies.
 * @returns {Date | null}
 */
export function parseResetText(text, pausedAt, defaultZone = Intl.DateTimeFormat().resolvedOptions().timeZone) {
  const s = String(text ?? '');
  const epoch = s.match(/limit reached\|(\d{9,11})\b/i);
  if (epoch) return new Date(Number(epoch[1]) * 1000);
  const m = s.match(RESET);
  if (!m) return null;
  const [, mon, dayText, hourText, minuteText, ampm, zoneText] = m;
  let hour = Number(hourText);
  const minute = Number(minuteText ?? 0);
  if (ampm) {
    if (hour < 1 || hour > 12) return null;
    hour = (hour % 12) + (ampm.toLowerCase() === 'pm' ? 12 : 0);
  }
  if (hour > 23 || minute > 59) return null;
  const tz = zoneText?.trim() || defaultZone;
  const from = pausedAt.getTime();
  try {
    const today = wallDate(from, tz);
    if (mon) {
      const month = MONTHS.indexOf(mon.toLowerCase());
      if (month < 0) return null;
      const day = Number(dayText);
      let at = zonedInstant({ year: today.year, month, day, hour, minute }, tz);
      if (at < from - 24 * 3600_000) at = zonedInstant({ year: today.year + 1, month, day, hour, minute }, tz);
      return new Date(at);
    }
    let at = zonedInstant({ ...today, hour, minute }, tz);
    if (at <= from) at = zonedInstant({ ...today, day: today.day + 1, hour, minute }, tz);
    return new Date(at);
  } catch (e) {
    if (e instanceof RangeError) return null;
    throw e;
  }
}

/** The reset time a limit record carries: its structured `resetsAt` first, then the message text. */
export function resetOf(record, pausedAt) {
  const epoch = record.quotaLimits?.resetsAt ?? record.apiErrorParams?.rate_limit_info?.resetsAt;
  if (Number.isFinite(epoch) && epoch > 0) return new Date(epoch * 1000);
  return parseResetText(textOf(record), pausedAt);
}

/** Up to the last `bytes` of a file, as whole lines (the first, possibly cut, line dropped unless the read hit the start). */
function tailLines(file, bytes) {
  const fd = openSync(file, 'r');
  try {
    const size = fstatSync(fd).size;
    const start = Math.max(0, size - bytes);
    const buf = Buffer.alloc(size - start);
    readSync(fd, buf, 0, buf.length, start);
    const lines = buf.toString('utf8').split('\n');
    return { lines: start > 0 ? lines.slice(1) : lines, whole: start === 0 };
  } finally {
    closeSync(fd);
  }
}

function parseLines(lines) {
  const out = [];
  for (const line of lines) {
    if (!line.trim()) continue;
    try {
      out.push(JSON.parse(line));
    } catch {
      /* a line cut by the tail read, or one still being written */
    }
  }
  return out;
}

const isMain = (r) => r && r.isSidechain !== true;

/** True when the transcript's first prompt is the resume task's own. The app puts system reminders before the prompt text, so this looks inside it. */
function isResumeTask(file) {
  const fd = openSync(file, 'r');
  try {
    const buf = Buffer.alloc(Math.min(HEAD_BYTES, fstatSync(fd).size));
    readSync(fd, buf, 0, buf.length, 0);
    const first = parseLines(buf.toString('utf8').split('\n')).find((r) => isMain(r) && r.type === 'user' && r.isMeta !== true);
    return Boolean(first) && textOf(first).includes(RESUME_TASK_MARKER);
  } finally {
    closeSync(fd);
  }
}
/** A message someone sent the session. Background-task notices are queued without starting a turn, so they don't count. */
const isPrompt = (r) =>
  isMain(r) && r.type === 'user' && r.isMeta !== true && r.queueTranscriptOnly !== true && !textOf(r).trimStart().startsWith('<task-notification>');

/**
 * Reads one transcript's tail and decides whether its session is stopped at a usage limit.
 * Paused means the last main-thread assistant record is a limit record and nobody has written to the session since the
 * reset (a user message after the reset means someone already resumed it, and its reply is on the way).
 * @returns {Omit<Pause, 'due' | 'handled'> | null}
 */
export function readPause(file) {
  for (const bytes of TAIL_BYTES) {
    const { lines, whole } = tailLines(file, bytes);
    const records = parseLines(lines);
    const last = records.findLastIndex((r) => isMain(r) && r.type === 'assistant');
    if (last < 0 && !whole && bytes !== TAIL_BYTES.at(-1)) continue;
    if (last < 0 || !isLimitRecord(records[last]) || isResumeTask(file)) return null;
    const record = records[last];
    const pausedAt = new Date(record.timestamp);
    if (Number.isNaN(pausedAt.getTime())) return null;
    const reset = resetOf(record, pausedAt);
    const resetAt = reset ?? new Date(pausedAt.getTime() + FALLBACK_WINDOW_MS);
    const later = records.slice(last + 1);
    const resumed = later.some((r) => isPrompt(r) && Date.parse(r.timestamp) >= resetAt.getTime());
    if (resumed) return null;
    let cwd = record.cwd ?? null;
    let title = null;
    for (const r of records) {
      if (isMain(r) && typeof r.cwd === 'string') cwd = r.cwd;
      if (r.type === 'relocated' && typeof r.relocatedCwd === 'string') cwd = r.relocatedCwd;
      if (r.type === 'custom-title' && r.customTitle) title = r.customTitle;
      if (r.type === 'agent-name' && r.agentName && !title) title = r.agentName;
    }
    return {
      sessionId: record.sessionId ?? basename(file, '.jsonl'),
      cwd,
      title,
      pausedAt: pausedAt.toISOString(),
      resetsAt: resetAt.toISOString(),
      resetGuessed: !reset,
      message: textOf(record).trim(),
      file,
    };
  }
  return null;
}

export function loadMarks(file) {
  if (!existsSync(file)) return {};
  try {
    const raw = JSON.parse(readFileSync(file, 'utf8'));
    return raw && typeof raw === 'object' && !Array.isArray(raw) ? raw : {};
  } catch {
    return {};
  }
}

function saveMarks(file, marks) {
  mkdirSync(dirname(file), { recursive: true });
  const tmp = `${file}.${process.pid}.tmp`;
  writeFileSync(tmp, `${JSON.stringify(marks, null, 2)}\n`);
  renameSync(tmp, file);
}

/**
 * Desktop chats by the transcript UUID they run: `local_…` id and whether the chat is archived.
 * The files are the desktop app's own and undocumented, so anything unreadable is skipped and the caller falls back to
 * matching `list_sessions` rows by cwd and title.
 * @returns {Map<string, {localId: string, archived: boolean}>}
 */
export function desktopSessions(dir) {
  const byCli = new Map();
  eachDesktopFile(dir, (raw, path) => {
    const entry = { localId: typeof raw.sessionId === 'string' ? raw.sessionId : basename(path, '.json'), archived: raw.isArchived === true };
    for (const cli of [raw.cliSessionId, raw.lastAssistantCliSessionId]) if (typeof cli === 'string' && !byCli.has(cli)) byCli.set(cli, entry);
  });
  return byCli;
}

/** Calls `fn(parsedJson, path)` for every desktop chat file under `dir`. A file mid-write or in a format this doesn't know is skipped. */
function eachDesktopFile(dir, fn) {
  if (!dir || !existsSync(dir)) return;
  const walk = (d, depth) => {
    for (const e of readdirSync(d, { withFileTypes: true })) {
      const path = join(d, e.name);
      if (e.isDirectory() && depth < 3) walk(path, depth + 1);
      else if (e.isFile() && /^local_[\w-]+\.json$/.test(e.name)) {
        try {
          fn(JSON.parse(readFileSync(path, 'utf8')), path);
        } catch {
          /* unreadable or unexpected shape */
        }
      }
    }
  };
  walk(dir, 0);
}

const str = (v) => (typeof v === 'string' && v ? v : null);

/**
 * Every desktop chat with what the owner-facing page needs: its `local_…` id, title, whether it is archived or was started by a
 * scheduled task, when it last moved, and how its last turn ended (`blocked` with the action it needs, `completed`, `review_ready`).
 * Undocumented app files, so every field is checked and a missing one is null. Text is raw; callers clean it before showing it.
 * @returns {Array<{localId: string, cliId: string | null, cwd: string | null, title: string | null, archived: boolean, scheduledTaskId: string | null,
 *   lastActivityAt: string | null, status: string | null, needsAction: string | null}>}
 */
export function desktopChats(dir) {
  const out = [];
  eachDesktopFile(dir, (raw, path) => {
    const last = Number.isFinite(raw.lastActivityAt) ? new Date(raw.lastActivityAt).toISOString() : null;
    const summary = raw.postTurnSummary && typeof raw.postTurnSummary === 'object' ? raw.postTurnSummary : {};
    out.push({
      localId: str(raw.sessionId) ?? basename(path, '.json'),
      cliId: str(raw.cliSessionId) ?? str(raw.lastAssistantCliSessionId),
      cwd: str(raw.cwd),
      title: str(raw.title),
      archived: raw.isArchived === true,
      scheduledTaskId: str(raw.scheduledTaskId),
      lastActivityAt: last,
      status: str(summary.status_category),
      needsAction: str(summary.needs_action),
    });
  });
  return out;
}

/** A pause counts as handled when this exact pause (same session, same pausedAt) was marked. A later pause is new. */
const isHandled = (marks, p) => marks[p.sessionId]?.pausedAt === p.pausedAt;

/**
 * Every session under `projectsDir` that is stopped at a usage limit, oldest pause first.
 * Reads only top-level transcripts touched in the last eight days, and only their tails.
 * @returns {Pause[]}
 */
export function findPaused({ projectsDir = DEFAULT_PROJECTS_DIR, desktopDir = DEFAULT_DESKTOP_DIR, marksFile, now = new Date() } = {}) {
  if (!existsSync(projectsDir)) return [];
  const marks = marksFile ? loadMarks(marksFile) : {};
  const pauses = [];
  for (const folder of readdirSync(projectsDir, { withFileTypes: true })) {
    if (!folder.isDirectory()) continue;
    const dir = join(projectsDir, folder.name);
    for (const name of readdirSync(dir)) {
      if (!name.endsWith('.jsonl')) continue;
      const file = join(dir, name);
      let mtime;
      try {
        mtime = statSync(file).mtimeMs;
      } catch {
        continue;
      }
      if (now.getTime() - mtime > LOOKBACK_MS) continue;
      const p = readPause(file);
      if (!p) continue;
      pauses.push({ ...p, due: now.getTime() >= Date.parse(p.resetsAt), handled: isHandled(marks, p) });
    }
  }
  const desktop = pauses.length ? desktopSessions(desktopDir) : new Map();
  for (const p of pauses) Object.assign(p, { localId: desktop.get(p.sessionId)?.localId ?? null, archived: desktop.get(p.sessionId)?.archived ?? false });
  return pauses.sort((a, b) => a.pausedAt.localeCompare(b.pausedAt));
}

/**
 * Records that a session's pause was resumed (by transcript UUID or desktop `local_…` id). Marks only a pause that is due,
 * and when `pausedAt` is given only that exact pause: a chat that hit a new limit right after waking stays unmarked, so its
 * next reset wakes it again. A marked pause drops out of `--due`. Idempotent.
 * @returns {'marked' | 'already' | 'not-paused' | 'not-due' | 'new-pause'}
 */
export function markResumed(id, { projectsDir, desktopDir, marksFile, pausedAt = null, now = new Date() }) {
  const pause = findPaused({ projectsDir, desktopDir, marksFile, now }).find((p) => p.sessionId === id || p.localId === id);
  if (!pause) return 'not-paused';
  if (pausedAt && Date.parse(pausedAt) !== Date.parse(pause.pausedAt)) return 'new-pause';
  if (pause.handled) return 'already';
  if (!pause.due) return 'not-due';
  const marks = loadMarks(marksFile);
  for (const [id, m] of Object.entries(marks)) if (now.getTime() - Date.parse(m.markedAt) > MARK_TTL_MS) delete marks[id];
  marks[pause.sessionId] = { pausedAt: pause.pausedAt, markedAt: now.toISOString() };
  saveMarks(marksFile, marks);
  return 'marked';
}
