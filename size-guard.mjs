// Prompt-time size guard: when a chat has grown well past its own starting size, tell it once to write a handoff and
// continue in a fresh session. Reads only the first and last 1MB of the transcript, so it stays fast.
import { closeSync, mkdirSync, openSync, readFileSync, readSync, fstatSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';

// A chat starts at 85k-123k tokens in the desktop app (system prompt, tools, skills), so the warning
// measures growth over the chat's own first reply. The backstop covers a chat whose baseline is unknown.
export const GROWTH_WARN = 80_000;
// The hub re-reads its history on every worker note, so it warns sooner than a worker.
export const HUB_GROWTH_WARN = 40_000;
export const BACKSTOP = 250_000;
export const REWARN_STEP = 60_000;
const CHUNK_BYTES = 1024 * 1024;

const tokensOf = (line) => {
  if (!line.includes('"usage"') || !line.includes('"assistant"')) return null;
  try {
    const e = JSON.parse(line);
    const u = e.type === 'assistant' && !e.isSidechain ? e.message?.usage : null;
    if (!u) return null;
    const n = (x) => (Number.isFinite(x) ? x : 0);
    const total = n(u.input_tokens) + n(u.cache_creation_input_tokens) + n(u.cache_read_input_tokens);
    return total > 0 ? total : null;
  } catch { return null; }
};

function readChunk(transcriptPath, fromEnd) {
  let fd;
  try {
    fd = openSync(transcriptPath, 'r');
    const size = fstatSync(fd).size;
    const len = Math.min(size, CHUNK_BYTES);
    const buf = Buffer.alloc(len);
    readSync(fd, buf, 0, len, fromEnd ? size - len : 0);
    const lines = buf.toString('utf8').split('\n');
    if (size > len) { if (fromEnd) lines.shift(); else lines.pop(); }
    return lines;
  } catch { return []; }
  finally { if (fd !== undefined) try { closeSync(fd); } catch {} }
}

/** Context size of the latest main-thread reply (input + cache write + cache read), or null when the tail has none. */
export function latestHistory(transcriptPath) {
  const lines = readChunk(transcriptPath, true);
  for (let i = lines.length - 1; i >= 0; i--) {
    const t = tokensOf(lines[i]);
    if (t !== null) return t;
  }
  return null;
}

/** Context size of the first main-thread reply, or null when the head of the transcript has none. */
export function firstHistory(transcriptPath) {
  for (const line of readChunk(transcriptPath, false)) {
    const t = tokensOf(line);
    if (t !== null) return t;
  }
  return null;
}

export const defaultStateDir = () => process.env.COS_SIZE_STATE_DIR || join(homedir(), '.claude', 'size-warned');

export function sizeMessage(tokens, baseline = null, hub = false) {
  const total = `about ${Math.round(tokens / 1000)}k tokens`;
  const grown = baseline === null ? total : `${total}, up ${Math.round((tokens - baseline) / 1000)}k from ${Math.round(baseline / 1000)}k when it started`;
  if (hub) return `This hub chat's history is ${grown}, and every worker note makes it re-read all of it. Do nothing else now: write the handoff (what is in flight, branches, next step) and tell the owner to start a fresh /cos. Don't start workers or answer status-only notes.`;
  return `This chat's history is ${grown}, and every reply re-reads all of it. Before doing more, write your state (goal, branch, what's done, next step) to the project's wiki page or a handoff note, tell the owner it is saved, and continue the work in a fresh session with a short brief (start_session if you have it; otherwise ask the owner to open one). Don't start new work in this chat.`;
}

/** The message to inject, or null. Warns at GROWTH_WARN over the chat's first reply (re-based when compaction shrinks it) (BACKSTOP when that is unknown), then again each REWARN_STEP above the last warning. */
export function sizeWarning({ transcriptPath, sessionId, stateDir = defaultStateDir(), hub = false }) {
  const growthWarn = hub ? HUB_GROWTH_WARN : GROWTH_WARN;
  if (typeof transcriptPath !== 'string' || !/^[\w.-]+$/.test(String(sessionId ?? ''))) return null;
  const tokens = latestHistory(transcriptPath);
  if (tokens === null) return null;
  const marker = join(stateDir, String(sessionId));
  const baseFile = join(stateDir, 'base', String(sessionId));
  let baseline = null;
  try { baseline = Number(readFileSync(baseFile, 'utf8')) || null; } catch {}
  const saved = baseline;
  if (baseline === null) baseline = firstHistory(transcriptPath);
  if (baseline !== null && tokens < baseline) baseline = tokens;
  if (baseline !== null && baseline !== saved) {
    try { mkdirSync(join(stateDir, 'base'), { recursive: true }); writeFileSync(baseFile, String(baseline)); } catch {}
  }
  if (baseline === null ? tokens < BACKSTOP : tokens - baseline < growthWarn) return null;
  let last = 0;
  try { last = Number(readFileSync(marker, 'utf8')) || 0; } catch {}
  if (tokens < last) last = 0;
  if (last && tokens < last + REWARN_STEP) return null;
  try {
    mkdirSync(stateDir, { recursive: true });
    writeFileSync(marker, String(tokens));
  } catch {}
  return sizeMessage(tokens, baseline, hub);
}
