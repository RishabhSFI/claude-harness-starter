// Where the Claude usage goes: reads transcripts under ~/.claude/projects (main chats and subagents) and prints
// a short summary. Never prints transcript text. Run: node usage-report.mjs [--hours 48] [--cap 120000] [--projects-dir <dir>]
import { readFileSync, readdirSync, statSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

export const WEIGHTS = { input: 1, write: 1.25, read: 0.1, output: 5 };
const num = (x) => (Number.isFinite(x) ? x : 0);

export const weigh = (u) => u.input * WEIGHTS.input + u.write * WEIGHTS.write + u.read * WEIGHTS.read + u.output * WEIGHTS.output;
export const historyOf = (u) => u.input + u.write + u.read;

/** `<folder>/<id>.jsonl` is a chat; `<folder>/<id>/subagents/*.jsonl` are its helpers. */
export function listTranscripts(dir) {
  const out = [];
  const ls = (p) => { try { return readdirSync(p, { withFileTypes: true }); } catch { return []; } };
  for (const d of ls(dir).filter((e) => e.isDirectory())) {
    const folder = join(dir, d.name);
    for (const e of ls(folder)) {
      if (e.isFile() && e.name.endsWith('.jsonl')) out.push({ path: join(folder, e.name), folder: d.name, session: e.name.slice(0, -6), sub: false });
      else if (e.isDirectory()) {
        for (const f of ls(join(folder, e.name, 'subagents'))) {
          if (f.isFile() && f.name.endsWith('.jsonl')) out.push({ path: join(folder, e.name, 'subagents', f.name), folder: d.name, session: e.name, sub: true });
        }
      }
    }
  }
  return out;
}

/** One record per assistant message id (a streamed message repeats; keep its largest usage). */
export function collect(dir, { hours = 48, now = Date.now() } = {}) {
  const since = now - hours * 3_600_000;
  const byId = new Map();
  for (const t of listTranscripts(dir)) {
    try { if (statSync(t.path).mtimeMs < since) continue; } catch { continue; }
    for (const line of readFileSync(t.path, 'utf8').split('\n')) {
      if (!line.includes('"usage"') || !line.includes('"assistant"')) continue;
      let e;
      try { e = JSON.parse(line); } catch { continue; }
      const m = e?.message;
      if (e.type !== 'assistant' || !m?.usage) continue;
      const at = Date.parse(e.timestamp);
      if (!(at >= since)) continue;
      const key = m.id ?? e.requestId;
      if (typeof key !== 'string') continue;
      const u = { input: num(m.usage.input_tokens), write: num(m.usage.cache_creation_input_tokens), read: num(m.usage.cache_read_input_tokens), output: num(m.usage.output_tokens) };
      const w = weigh(u);
      const seen = byId.get(key);
      if (!seen || w > seen.w) byId.set(key, { ...u, w, model: String(m.model ?? 'unknown'), folder: t.folder, session: t.session, sub: t.sub });
    }
  }
  return [...byId.values()];
}

const sum = (rs, f) => rs.reduce((a, r) => a + f(r), 0);
const pct = (x, total) => (total ? `${((100 * x) / total).toFixed(0)}%` : '0%');
const k = (n) => `${Math.round(n / 1000)}k`;
const M = (n) => `${(n / 1e6).toFixed(1)}M`;

/** Project folder name without the home prefix, worktree suffix collapsed, shortened. */
export function labelFolder(folder) {
  let s = folder.replace(/^-Users-[^-]+-/, '').replace(/^Projects-/, '');
  const wt = /--claude-worktrees-/.test(s);
  s = s.replace(/--claude-worktrees-.*$/, '').replace(/^Library-Application-Support-Claude-scratch-workspaces-.*$/, 'scratch');
  return (s.length > 28 ? s.slice(0, 28) : s) + (wt ? ' (worktree)' : '');
}

/** Cost if every reply's history had been served at no more than `cap` tokens (cache read trimmed first). */
export function capped(records, cap) {
  let over = 0, overW = 0, newW = 0, total = 0;
  for (const r of records) {
    total += r.w;
    if (historyOf(r) <= cap) { newW += r.w; continue; }
    over++; overW += r.w;
    const read = Math.max(0, Math.min(r.read, cap - r.input - r.write));
    newW += weigh({ ...r, read });
  }
  return { over, overW, newW, total };
}

export function summarize(records, { cap = 120_000, hours = 48 } = {}) {
  const total = sum(records, (r) => r.w);
  const raw = { input: sum(records, (r) => r.input), write: sum(records, (r) => r.write), read: sum(records, (r) => r.read), output: sum(records, (r) => r.output) };
  const rawTotal = raw.input + raw.write + raw.read + raw.output;
  const wt = { input: raw.input, write: raw.write * 1.25, read: raw.read * 0.1, output: raw.output * 5 };
  const lines = [`Usage, last ${hours}h: ${records.length} replies, ${M(rawTotal)} raw tokens, ${M(total)} price-weighted.`, '', '| Kind | Raw share | Weighted share |', '| --- | --- | --- |'];
  for (const [name, key] of [['Input', 'input'], ['Cache write', 'write'], ['Cache read', 'read'], ['Output', 'output']]) lines.push(`| ${name} | ${pct(raw[key], rawTotal)} | ${pct(wt[key], total)} |`);

  const chats = new Map();
  for (const r of records.filter((x) => !x.sub)) {
    const id = `${r.folder}/${r.session}`;
    const c = chats.get(id) ?? { label: `${labelFolder(r.folder)} ${r.session.slice(0, 8)}`, w: 0, n: 0, hist: 0 };
    c.w += r.w; c.n++; c.hist += historyOf(r);
    chats.set(id, c);
  }
  lines.push('', '| Top chats | Share | Replies | Avg history per reply |', '| --- | --- | --- | --- |');
  for (const c of [...chats.values()].sort((a, b) => b.w - a.w).slice(0, 8)) lines.push(`| ${c.label} | ${pct(c.w, total)} | ${c.n} | ${k(c.hist / c.n)} |`);

  const models = new Map();
  for (const r of records) models.set(r.model, (models.get(r.model) ?? 0) + r.w);
  lines.push('', `By model: ${[...models].sort((a, b) => b[1] - a[1]).map(([m, w]) => `${m} ${pct(w, total)}`).join(', ')}.`);
  const subW = sum(records.filter((r) => r.sub), (r) => r.w);
  lines.push(`Subagents ${pct(subW, total)}, main chats ${pct(total - subW, total)}.`);

  const c = capped(records, cap);
  lines.push('', `Size cap at ${k(cap)}: ${c.over} of ${records.length} replies (${pct(c.over, records.length)}) had history above it, ${pct(c.overW, total)} of weighted cost.`,
    `If those had been served at ${k(cap)} instead (cache read trimmed, writes and output unchanged), weighted cost falls ${pct(total - c.newW, total)}. Ceiling only: it ignores the cost of writing handoffs and starting fresh chats.`);
  return lines.join('\n');
}

export function main(argv = process.argv.slice(2)) {
  const opt = (name, d) => { const i = argv.indexOf(`--${name}`); return i >= 0 && argv[i + 1] ? argv[i + 1] : d; };
  const hours = Number(opt('hours', 48)), cap = Number(opt('cap', 120000));
  if (!(hours > 0) || !(cap > 0)) { console.error('usage: usage-report.mjs [--hours 48] [--cap 120000] [--projects-dir <dir>]'); process.exitCode = 2; return; }
  const dir = opt('projects-dir', join(homedir(), '.claude', 'projects'));
  console.log(summarize(collect(dir, { hours }), { cap, hours }));
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) main();
