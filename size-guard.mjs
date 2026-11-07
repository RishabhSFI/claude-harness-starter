// Prompt-time size guard: when a chat's history passes a threshold, tell it once to write a handoff and
// continue in a fresh session. Reads only the tail of the transcript, so it stays fast.
import { closeSync, mkdirSync, openSync, readFileSync, readSync, fstatSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';

export const WARN_AT = 120_000;
export const REWARN_STEP = 60_000;
const TAIL_BYTES = 1024 * 1024;

/** History of the latest reply (input + cache write + cache read), or null when the tail has no usage line. */
export function latestHistory(transcriptPath) {
  let fd;
  try {
    fd = openSync(transcriptPath, 'r');
    const size = fstatSync(fd).size;
    const len = Math.min(size, TAIL_BYTES);
    const buf = Buffer.alloc(len);
    readSync(fd, buf, 0, len, size - len);
    const lines = buf.toString('utf8').split('\n');
    if (size > len) lines.shift();
    for (let i = lines.length - 1; i >= 0; i--) {
      if (!lines[i].includes('"usage"') || !lines[i].includes('"assistant"')) continue;
      try {
        const e = JSON.parse(lines[i]);
        const u = e.type === 'assistant' && !e.isSidechain ? e.message?.usage : null;
        if (!u) continue;
        const n = (x) => (Number.isFinite(x) ? x : 0);
        return n(u.input_tokens) + n(u.cache_creation_input_tokens) + n(u.cache_read_input_tokens);
      } catch {}
    }
  } catch {}
  finally { if (fd !== undefined) try { closeSync(fd); } catch {} }
  return null;
}

export const defaultStateDir = () => process.env.COS_SIZE_STATE_DIR || join(homedir(), '.claude', 'size-warned');

export function sizeMessage(tokens) {
  return `This chat's history is about ${Math.round(tokens / 1000)}k tokens, and every reply re-reads all of it. Before doing more, write your state (goal, branch, what's done, next step) to the project's wiki page or a handoff note, tell the owner it is saved, and continue the work in a fresh session with a short brief (start_session if you have it; otherwise ask the owner to open one). Don't start new work in this chat.`;
}

/** The message to inject, or null. Warns at WARN_AT, then again each REWARN_STEP above the last warning. */
export function sizeWarning({ transcriptPath, sessionId, stateDir = defaultStateDir() }) {
  if (typeof transcriptPath !== 'string' || !/^[\w.-]+$/.test(String(sessionId ?? ''))) return null;
  const tokens = latestHistory(transcriptPath);
  if (tokens === null || tokens < WARN_AT) return null;
  const marker = join(stateDir, String(sessionId));
  let last = 0;
  try { last = Number(readFileSync(marker, 'utf8')) || 0; } catch {}
  if (tokens < last) last = 0;
  if (last && tokens < last + REWARN_STEP) return null;
  try {
    mkdirSync(stateDir, { recursive: true });
    writeFileSync(marker, String(tokens));
  } catch {}
  return sizeMessage(tokens);
}
