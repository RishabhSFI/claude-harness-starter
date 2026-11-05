import { open, readdir, stat } from 'node:fs/promises';
import { join } from 'node:path';
import { StringDecoder } from 'node:string_decoder';
import { DEFAULT_PROJECTS_DIR, clean } from './activity.mjs';
import { projectOfPath } from './queue.mjs';

const HOUR = 3_600_000;
const WINDOW_MS = 24 * HOUR;
const CHUNK = 4 * 1024 * 1024;
const TOP = 8;

/** Weighted tokens, with the price ratios reports/usage-2026-11-05.md uses: input 1, cache write 1.25, cache read 0.1, output 5. */
export function weigh(u) {
  const n = (x) => (Number.isFinite(x) ? x : 0);
  return n(u?.input_tokens) + 1.25 * n(u?.cache_creation_input_tokens) + 0.1 * n(u?.cache_read_input_tokens) + 5 * n(u?.output_tokens);
}

/** `<id>.jsonl` is a session; `<id>/subagents/*.jsonl` are its helpers, which count toward it. */
async function transcripts(projectsDir) {
  const out = [];
  for (const d of await readdir(projectsDir, { withFileTypes: true }).catch(() => [])) {
    if (!d.isDirectory()) continue;
    const folder = join(projectsDir, d.name);
    for (const e of await readdir(folder, { withFileTypes: true }).catch(() => [])) {
      if (e.isFile() && e.name.endsWith('.jsonl')) out.push({ path: join(folder, e.name), sessionId: e.name.slice(0, -6), folder: d.name });
      else if (e.isDirectory()) {
        const sub = join(folder, e.name, 'subagents');
        for (const f of await readdir(sub).catch(() => [])) {
          if (f.endsWith('.jsonl')) out.push({ path: join(sub, f), sessionId: e.name, folder: d.name });
        }
      }
    }
  }
  return out;
}

/** Folder names are the cwd with dashes for slashes; drop the home part so it reads as a place. */
const placeOf = (folder) => clean(folder.replace(/^-Users-[^-]+-/, '').replace(/^Projects-/, '').replace(/--claude-worktrees-.*$/, '') || folder);

/**
 * Tokens per hour from transcripts, read incrementally: each file is read from where the last refresh
 * stopped. A message streamed over several lines counts once, at its largest usage. Never calls a model.
 */
export function createUsageTracker({ projectsDir = DEFAULT_PROJECTS_DIR } = {}) {
  const files = new Map();
  const messages = new Map();
  const meta = new Map();
  let running = null;
  let stopped = false;

  function take(line, sessionId, since) {
    if (line.includes('"custom-title"') || line.includes('"agent-name"')) {
      try {
        const e = JSON.parse(line);
        const name = e.customTitle ?? e.agentName;
        if (typeof name === 'string' && e.sessionId === sessionId) meta.set(sessionId, { ...meta.get(sessionId), name: clean(name) });
      } catch {}
      return;
    }
    if (!line.includes('"usage"') || !line.includes('"assistant"')) return;
    let e;
    try {
      e = JSON.parse(line);
    } catch {
      return;
    }
    const id = e?.message?.id;
    const at = Date.parse(e?.timestamp);
    if (e.type !== 'assistant' || typeof id !== 'string' || !e.message.usage || !(at >= since)) return;
    const weighted = weigh(e.message.usage);
    const seen = messages.get(id);
    if (!seen || weighted > seen.weighted) messages.set(id, { at: seen?.at ?? at, weighted, sessionId });
    if (typeof e.cwd === 'string' && !e.isSidechain) meta.set(sessionId, { ...meta.get(sessionId), cwd: e.cwd });
  }

  async function readNew(t, size, since) {
    let f = files.get(t.path);
    if (!f || size < f.offset) f = { offset: 0, partial: '', decoder: new StringDecoder('utf8'), sessionId: t.sessionId };
    files.set(t.path, f);
    if (size === f.offset) return;
    const fh = await open(t.path, 'r');
    try {
      const buf = Buffer.alloc(Math.min(CHUNK, size - f.offset));
      while (f.offset < size && !stopped) {
        const { bytesRead } = await fh.read(buf, 0, Math.min(buf.length, size - f.offset), f.offset);
        if (!bytesRead) break;
        f.offset += bytesRead;
        const lines = (f.partial + f.decoder.write(buf.subarray(0, bytesRead))).split('\n');
        f.partial = lines.pop();
        for (const line of lines) take(line, t.sessionId, since);
      }
    } finally {
      await fh.close();
    }
    if (!meta.has(t.sessionId)) meta.set(t.sessionId, {});
    meta.get(t.sessionId).folder ??= t.folder;
  }

  async function scan(now) {
    const since = now - WINDOW_MS;
    const recent = new Set();
    for (const t of await transcripts(projectsDir)) {
      if (stopped) return;
      const st = await stat(t.path).catch(() => null);
      if (!st || st.mtimeMs < since) continue;
      recent.add(t.path);
      await readNew(t, st.size, since).catch(() => {});
    }
    for (const [id, m] of messages) if (m.at < since) messages.delete(id);
    for (const path of files.keys()) if (!recent.has(path)) files.delete(path);
    const live = new Set([...files.values()].map((f) => f.sessionId));
    for (const id of meta.keys()) if (!live.has(id)) meta.delete(id);
  }

  return {
    /** One scan at a time; a call during a scan shares it. */
    refresh(now = Date.now()) {
      running ??= scan(now).finally(() => (running = null));
      return running;
    },
    /** How many transcripts and sessions it holds state for. */
    get held() {
      return { files: files.size, sessions: meta.size };
    },
    async stop() {
      stopped = true;
      await running;
    },
    /**
     * @param {{now?: number, sessions?: {sessionId: string, name?: string, cwd?: string}[], roots?: {id: string, root: string}[], projects?: {id: string, name: string}[]}} live
     * @returns {{hours: {start: string, weighted: number, sessions: number}[], today: number, top: {sessionId: string, name: string, project: string | null, projectName: string, weighted: number}[]}}
     */
    summary({ now = Date.now(), sessions = [], roots = [], projects = [] } = {}) {
      const hourStart = new Date(now);
      hourStart.setMinutes(0, 0, 0);
      const first = hourStart.getTime() - 23 * HOUR;
      const midnight = new Date(now);
      midnight.setHours(0, 0, 0, 0);
      const hours = Array.from({ length: 24 }, (_, i) => ({ start: first + i * HOUR, weighted: 0, ids: new Set() }));
      const bySession = new Map();
      let today = 0;
      for (const m of messages.values()) {
        const i = Math.floor((m.at - first) / HOUR);
        if (i < 0 || i > 23) continue;
        hours[i].weighted += m.weighted;
        hours[i].ids.add(m.sessionId);
        if (m.at >= midnight.getTime()) today += m.weighted;
        bySession.set(m.sessionId, (bySession.get(m.sessionId) ?? 0) + m.weighted);
      }
      const top = [...bySession]
        .sort((x, y) => y[1] - x[1])
        .slice(0, TOP)
        .map(([sessionId, weighted]) => {
          const live = sessions.find((s) => s.sessionId === sessionId);
          const known = meta.get(sessionId) ?? {};
          const project = projectOfPath(roots, live?.cwd ?? known.cwd);
          const projectName = projects.find((p) => p.id === project)?.name ?? placeOf(known.folder ?? '');
          return { sessionId, name: clean(live?.name || known.name || sessionId.slice(0, 8)), project, projectName, weighted: Math.round(weighted) };
        });
      return {
        hours: hours.map((h) => ({ start: new Date(h.start).toISOString(), weighted: Math.round(h.weighted), sessions: h.ids.size })),
        today: Math.round(today),
        top,
      };
    },
  };
}
