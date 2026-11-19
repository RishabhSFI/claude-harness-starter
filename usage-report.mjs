// Where the Claude usage goes: reads transcripts under ~/.claude/projects (main chats and subagents) and prints
// a short summary. Never prints transcript text. Run: node usage-report.mjs [--hours 48] [--growth 80000 | --cap <tokens>] [--projects-dir <dir>]
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
      if (!seen || w > seen.w) byId.set(key, { ...u, w, at, model: String(m.model ?? 'unknown'), folder: t.folder, session: t.session, sub: t.sub });
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

/** Each main chat's starting size: the history of its earliest reply in the window. Subagents get their own first reply. */
export function baselines(records) {
  const first = new Map();
  for (const r of records) {
    const id = `${r.folder}/${r.session}/${r.sub ? 'sub' : 'main'}`;
    const f = first.get(id);
    if (!f || r.at < f.at) first.set(id, r);
  }
  return (r) => historyOf(first.get(`${r.folder}/${r.session}/${r.sub ? 'sub' : 'main'}`));
}

/** Cost if every reply's history had been served at no more than its cap (cache read trimmed first). `cap` is a number or a function of the record. */
export function capped(records, capArg) {
  let over = 0, overW = 0, newW = 0, total = 0;
  for (const r of records) {
    total += r.w;
    const cap = typeof capArg === 'function' ? capArg(r) : capArg;
    if (historyOf(r) <= cap) { newW += r.w; continue; }
    over++; overW += r.w;
    const read = Math.max(0, Math.min(r.read, cap - r.input - r.write));
    newW += weigh({ ...r, read });
  }
  return { over, overW, newW, total };
}

export function summarize(records, { cap = null, growth = 80_000, hours = 48 } = {}) {
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

  const start = baselines(records);
  const c = capped(records, cap === null ? (r) => start(r) + growth : cap);
  const rule = cap === null ? `Growth cap of ${k(growth)} over each chat's own start` : `Size cap at ${k(cap)}`;
  lines.push('', `${rule}: ${c.over} of ${records.length} replies (${pct(c.over, records.length)}) had history above it, ${pct(c.overW, total)} of weighted cost.`,
    `If those had been served at the cap instead (cache read trimmed, writes and output unchanged), weighted cost falls ${pct(total - c.newW, total)}. Ceiling only: it ignores the cost of writing handoffs and starting fresh chats.`);
  return lines.join('\n');
}

const READ_LIKE = /^(cat|sed|head|tail|awk|grep|rg|find|ls|tree|wc|git (-C \S+ )?(diff|log|show|status)|gh (pr (diff|view)|run view))\b/;
const WRITES = /(^|[^<>=-])>(?!&)|\bsed -i|\s-(delete|exec)\b|\|\s*(sh|bash)\b|--output/;
const IMAGE = /\.(png|jpe?g|gif|webp)$/i;

/** Which kind of tool output a result is: a read a Haiku reader could take, or something else. */
export function readKind(tool, input) {
  if (tool === 'Read') return IMAGE.test(String(input?.file_path ?? '')) ? 'Read (image, stays)' : 'Read (text)';
  if (tool === 'Bash') {
    const cmd = String(input?.command ?? '').trim().replace(/^(cd [^;&|]+(&&|;)\s*)+/, '');
    return READ_LIKE.test(cmd) && !WRITES.test(cmd) ? 'Bash (read-like)' : 'Bash (other)';
  }
  return 'other tools';
}

/**
 * Where tool output goes. Each result costs its tokens once to write, then a tenth of that on every later reply in
 * its chat. Tokens are estimated as characters / 4 (an image counts 1500), so read the shares, not the totals.
 * Text of a transcript is never printed.
 */
export function readsReport(dir, { hours = 48, now = Date.now() } = {}) {
  const since = now - hours * 3_600_000;
  const rows = new Map();
  let total = 0;
  for (const t of listTranscripts(dir)) {
    try { if (statSync(t.path).mtimeMs < since) continue; } catch { continue; }
    const uses = new Map();
    const seen = new Set();
    const results = [];
    let replies = 0;
    for (const line of readFileSync(t.path, 'utf8').split('\n')) {
      if (!line.includes('"assistant"') && !line.includes('"tool_result"')) continue;
      let e;
      try { e = JSON.parse(line); } catch { continue; }
      if (!(Date.parse(e.timestamp) >= since) || !Array.isArray(e.message?.content)) continue;
      if (e.type === 'assistant') {
        if (!seen.has(e.message.id ?? e.requestId)) { seen.add(e.message.id ?? e.requestId); replies++; }
        for (const b of e.message.content) if (b.type === 'tool_use') uses.set(b.id, b);
      } else if (e.type === 'user') {
        for (const b of e.message.content) {
          if (b.type !== 'tool_result') continue;
          const use = uses.get(b.tool_use_id);
          if (!use) continue;
          const parts = Array.isArray(b.content) ? b.content : [{ type: 'text', text: String(b.content ?? '') }];
          const tok = parts.reduce((a, p) => a + (p.type === 'image' ? 1500 : String(p.text ?? '').length / 4), 0);
          results.push({ kind: readKind(use.name, use.input), tok, after: replies });
        }
      }
    }
    for (const r of results) {
      const w = r.tok * WEIGHTS.write + r.tok * WEIGHTS.read * Math.max(0, replies - r.after);
      const key = `${t.sub ? 'subagent' : 'main chat'} | ${r.kind}`;
      const row = rows.get(key) ?? { n: 0, tok: 0, w: 0 };
      row.n++; row.tok += r.tok; row.w += w; total += w;
      rows.set(key, row);
    }
  }
  const lines = [`Tool output, last ${hours}h (estimated; read the shares):`, '', '| Who | Kind | Results | Tokens | Share |', '| --- | --- | --- | --- | --- |'];
  for (const [key, r] of [...rows].sort((a, b) => b[1].w - a[1].w)) {
    const [who, kind] = key.split(' | ');
    lines.push(`| ${who} | ${kind} | ${r.n} | ${M(r.tok)} | ${pct(r.w, total)} |`);
  }
  const cand = [...rows].filter(([key]) => /Bash \(read-like\)|Read \(text\)/.test(key)).reduce((a, [, r]) => a + r.w, 0);
  lines.push('', `Reads a Haiku reader could take (read-like Bash plus text Read): ${pct(cand, total)} of tool-output cost. Some of it is files a worker must read to edit them, which stays direct.`);
  return lines.join('\n');
}

export function main(argv = process.argv.slice(2)) {
  const opt = (name, d) => { const i = argv.indexOf(`--${name}`); return i >= 0 && argv[i + 1] ? argv[i + 1] : d; };
  const hours = Number(opt('hours', 48)), cap = opt('cap', null) === null ? null : Number(opt('cap', null)), growth = Number(opt('growth', 80000));
  if (!(hours > 0) || (cap !== null && !(cap > 0)) || !(growth > 0)) { console.error('usage: usage-report.mjs [--hours 48] [--growth 80000 | --cap <tokens>] [--projects-dir <dir>] [--reads]'); process.exitCode = 2; return; }
  const dir = opt('projects-dir', join(homedir(), '.claude', 'projects'));
  if (argv.includes('--reads')) { console.log(readsReport(dir, { hours })); return; }
  console.log(summarize(collect(dir, { hours }), { cap, growth, hours }));
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) main();
