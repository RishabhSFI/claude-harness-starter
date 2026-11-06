import { opendir, lstat } from 'node:fs/promises';
import * as nodeOs from 'node:os';
import { basename, win32 as winPath } from 'node:path';
import { clean } from './activity.mjs';
import { exec as defaultExec } from './actions.mjs';
import { projectOfPath } from './queue.mjs';
import { uptimeWarningOn } from '../uptime.mjs';

export const THRESHOLDS = {
  cpuPct: 90,
  cpuMinutes: 5,
  memoryPct: 85,
  swapFractionOfRam: 0.25,
  diskFreePct: 10,
  devServerDays: 2,
};
export const HISTORY_POINTS = 90;
export const SAMPLE_MS = 10_000;
export const FOLDER_MS = 30 * 60_000;
const PROBE_TIMEOUT_MS = 5_000;
const WIN_TIMEOUT_MS = 30_000;
const DU_TIMEOUT_MS = 120_000;
const START_TOLERANCE_MS = 2_000;

/** What each process kind is called on the page. `stoppable` kinds are the only ones the Stop button can ever reach. */
export const KINDS = {
  session: { label: 'Claude session', tone: 'accent', stoppable: false },
  'dev-server': { label: 'Dev server', tone: 'ok', stoppable: true },
  gate: { label: 'Test run', tone: 'warn', stoppable: true },
  'mission-control': { label: 'Mission control', tone: 'accent', stoppable: false },
  other: { label: '', tone: '', stoppable: false },
};

const DEV_RUNTIME = /^(node|bun|deno|python[\d.]*|ruby|php|next-server|vite|java|go)$/;
const GATE_PATTERNS = [
  /until-ready/,
  /gate[\\/]/,
  /\bnode(\.exe)?\s+--test\b/,
  /\bvitest\b/,
  /\bjest\b/,
  /\bpytest\b/,
  /\bplaywright\b/,
  /\bnpm\s+(run\s+)?test\b/,
  /\bpnpm\s+(run\s+)?test\b/,
  /\byarn\s+(run\s+)?test\b/,
];
const CLAUDE_BIN = /^claude(\.exe)?$/;
const isDevRuntime = (name) => DEV_RUNTIME.test(String(name).split(' ')[0].toLowerCase().replace(/\.exe$/, ''));

const CLAUDE_WORD = /(^|[\\/])claude(\.exe|\.cmd)?$|@anthropic-ai[\\/]claude-code([\\/]|$)/;

/**
 * Any word naming the claude program (`claude`, `node .../cli.js` under @anthropic-ai/claude-code, `npx @anthropic-ai/claude-code`,
 * a shell wrapper around claude) makes the line a session. Over-matching only takes a Stop button away.
 */
export function isClaudeCommand(args) {
  return String(args ?? '').split(/[\s"';&|()]+/).some((w) => CLAUDE_WORD.test(w));
}

/** The only thing the command line is used for besides the Windows folder test. It never leaves this function as text. */
export const isGateCommand = (args) => !isClaudeCommand(args) && GATE_PATTERNS.some((re) => re.test(String(args ?? '')));

const MB = 1024 * 1024;
const unit = { K: 1024, M: MB, G: 1024 * MB, T: 1024 * 1024 * MB };
const num = (v) => (Number.isFinite(Number(v)) ? Number(v) : 0);

// ---------- parsers: text in, values out ----------

export function parseVmStat(text) {
  const pageSize = Number(/page size of (\d+) bytes/.exec(text)?.[1]);
  const pages = (label) => Number(new RegExp(`^${label}:\\s+(\\d+)\\.`, 'm').exec(text)?.[1]);
  const [anon, wired, compressor] = [pages('Anonymous pages'), pages('Pages wired down'), pages('Pages occupied by compressor')];
  if (![pageSize, anon, wired, compressor].every(Number.isFinite)) throw new Error('unexpected vm_stat output');
  return { usedBytes: (anon + wired + compressor) * pageSize };
}

export function parseSwapUsage(text) {
  const m = /total = ([\d.]+)([KMGT])\s+used = ([\d.]+)([KMGT])/.exec(text);
  if (!m) throw new Error('unexpected swap output');
  return { swapTotalBytes: Math.round(Number(m[1]) * unit[m[2]]), swapUsedBytes: Math.round(Number(m[3]) * unit[m[4]]) };
}

export function parseSwVers(text) {
  return { os: /ProductName:\s*(.+)/.exec(text)?.[1]?.trim() ?? 'macOS', version: /ProductVersion:\s*(.+)/.exec(text)?.[1]?.trim() ?? '' };
}

export function parseOsRelease(text) {
  const get = (k) => new RegExp(`^${k}="?([^"\\n]*)"?`, 'm').exec(text)?.[1];
  return { os: get('NAME') ?? 'Linux', version: get('VERSION_ID') ?? '' };
}

export function parseMeminfo(text) {
  const kb = (k) => Number(new RegExp(`^${k}:\\s+(\\d+) kB`, 'm').exec(text)?.[1]);
  const [total, available, swapTotal, swapFree] = [kb('MemTotal'), kb('MemAvailable'), kb('SwapTotal'), kb('SwapFree')];
  if (![total, available].every(Number.isFinite)) throw new Error('unexpected meminfo');
  return { usedBytes: (total - available) * 1024, swapTotalBytes: (swapTotal || 0) * 1024, swapUsedBytes: ((swapTotal || 0) - (swapFree || 0)) * 1024 };
}

/** `[[dd-]hh:]mm:ss` to seconds. */
export function parseEtime(text) {
  const m = /^(?:(?:(\d+)-)?(\d+):)?(\d+):(\d+)$/.exec(String(text).trim());
  if (!m) return 0;
  return ((Number(m[1] ?? 0) * 24 + Number(m[2] ?? 0)) * 60 + Number(m[3])) * 60 + Number(m[4]);
}

/** `ps -axo pid=,ppid=,uid=,pcpu=,rss=,etime=,comm=`. comm is a path and may hold spaces. */
export function parsePs(text, nowMs) {
  const out = [];
  for (const line of String(text).split('\n')) {
    const m = /^\s*(\d+)\s+(\d+)\s+(\d+)\s+([\d.]+)\s+(\d+)\s+(\S+)\s+(.+?)\s*$/.exec(line);
    if (!m) continue;
    const ageSec = parseEtime(m[6]);
    out.push({ pid: Number(m[1]), ppid: Number(m[2]), uid: Number(m[3]), cpuPct: Number(m[4]), memBytes: Number(m[5]) * 1024, ageSec, startedAt: nowMs - ageSec * 1000, name: basename(m[7]) });
  }
  return out;
}

/** `ps -axo pid=,args=` reduced at once to a gate yes/no per pid, so no command line leaves the probe. */
export function parseGatePids(text) {
  const gates = new Set();
  for (const line of String(text).split('\n')) {
    const m = /^\s*(\d+)\s+(.*)$/.exec(line);
    if (m && isGateCommand(m[2])) gates.add(Number(m[1]));
  }
  return gates;
}

/** `ps -axo pid=,args=` reduced to the pids whose program is claude. */
export function parseClaudePids(text) {
  const pids = new Set();
  for (const line of String(text).split('\n')) {
    const m = /^\s*(\d+)\s+(.*)$/.exec(line);
    if (m && isClaudeCommand(m[2])) pids.add(Number(m[1]));
  }
  return pids;
}

const parseCommandRoles = (text) => ({ gates: parseGatePids(text), claude: parseClaudePids(text) });

/** `lsof -Fpn` of listening sockets: pid to its sorted, unique ports. */
export function parseLsofListen(text) {
  const ports = new Map();
  let pid = null;
  for (const line of String(text).split('\n')) {
    if (line.startsWith('p')) pid = Number(line.slice(1));
    else if (line.startsWith('n') && pid) {
      const port = Number(/:(\d+)$/.exec(line)?.[1]);
      if (port) ports.set(pid, [...new Set([...(ports.get(pid) ?? []), port])].sort((a, b) => a - b));
    }
  }
  return ports;
}

/** `lsof -a -d cwd -Fpn`: pid to working directory. */
export function parseLsofCwd(text) {
  const cwd = new Map();
  let pid = null;
  for (const line of String(text).split('\n')) {
    if (line.startsWith('p')) pid = Number(line.slice(1));
    else if (line.startsWith('n/') && pid) cwd.set(pid, line.slice(1));
  }
  return cwd;
}

/** `df -kP`: one row per line, the mount point is the rest of the line (it may hold spaces). */
export function parseDf(text) {
  const rows = [];
  for (const line of String(text).split('\n')) {
    const m = /^(\S+)\s+(\d+)\s+(\d+)\s+(\d+)\s+(\d+)%\s+(.+?)\s*$/.exec(line);
    if (m) rows.push({ mount: m[6], totalBytes: Number(m[2]) * 1024, freeBytes: Number(m[4]) * 1024 });
  }
  return rows;
}

export function parseDu(text) {
  const sizes = new Map();
  for (const line of String(text).split('\n')) {
    const m = /^(\d+)\s+(.+)$/.exec(line);
    if (m) sizes.set(m[2], Number(m[1]) * 1024);
  }
  return sizes;
}

/** A PowerShell 5.1 date: `/Date(ms)/`, `\/Date(ms)\/`, an ISO string (PowerShell 7), or already a number. */
export function parseWinDate(v) {
  if (typeof v === 'number') return v;
  const m = /Date\((-?\d+)/.exec(String(v ?? ''));
  if (m) return Number(m[1]);
  const t = Date.parse(String(v ?? ''));
  return Number.isFinite(t) ? t : null;
}

const asList = (v) => (Array.isArray(v) ? v : v && typeof v === 'object' ? [v] : []);
const normWin = (p) => String(p ?? '').toLowerCase().replace(/\//g, '\\');

/**
 * Windows gives no working folder, so a process belongs to the project holding its program or its script
 * (the first argument that isn't a flag). A path named later on the command line doesn't count. Only the id is kept.
 */
export function projectOfCommand(roots, commandLine) {
  const words = (String(commandLine ?? '').match(/(?:"[^"]*"|[^\s"])+/g) ?? []).map((w) => normWin(w.replace(/"/g, '')));
  const paths = [words[0], words.slice(1).find((w) => !/^[-/]/.test(w))].filter(Boolean);
  let best = null;
  for (const { id, root } of roots) {
    const r = normWin(root).replace(/\\+$/, '');
    if (r && paths.some((p) => p === r || p.startsWith(`${r}\\`)) && (!best || r.length > best.len)) best = { id, len: r.length };
  }
  return best?.id ?? null;
}

/** The one JSON object the PowerShell script prints. */
export function parseWin32(text, { roots = [], nowMs }) {
  const o = JSON.parse(text);
  const os = asList(o.os)[0] ?? {};
  const page = asList(o.pagefile);
  const total = num(os.TotalVisibleMemorySize) * 1024;
  const boot = parseWinDate(os.LastBootUpTime);
  const procs = asList(o.procs)
    .filter((p) => Number(p.ProcessId) > 0)
    .map((p) => {
      const startedAt = parseWinDate(p.CreationDate) ?? nowMs;
      const cmd = p.CommandLine ?? '';
      return {
        pid: Number(p.ProcessId),
        ppid: Number(p.ParentProcessId) || 0,
        uid: null,
        winSession: p.SessionId ?? null,
        name: String(p.Name ?? ''),
        memBytes: num(p.WorkingSetSize),
        cpuTicks: num(p.UserModeTime) + num(p.KernelModeTime),
        startedAt,
        ageSec: Math.max(0, Math.round((nowMs - startedAt) / 1000)),
        gate: isGateCommand(cmd),
        claude: isClaudeCommand(cmd),
        cmdProject: projectOfCommand(roots, cmd),
      };
    });
  const ports = new Map();
  for (const c of asList(o.ports)) {
    const pid = Number(c.OwningProcess);
    if (pid && c.LocalPort) ports.set(pid, [...new Set([...(ports.get(pid) ?? []), Number(c.LocalPort)])].sort((a, b) => a - b));
  }
  return {
    machine: { os: os.Caption ?? 'Windows', version: os.Version ?? '', uptimeSec: boot ? Math.round((nowMs - boot) / 1000) : null },
    memory: { totalBytes: total, usedBytes: Math.max(0, total - num(os.FreePhysicalMemory) * 1024), swapUsedBytes: page.reduce((a, p) => a + num(p.CurrentUsage), 0) * MB, swapTotalBytes: page.reduce((a, p) => a + num(p.AllocatedBaseSize), 0) * MB },
    disks: asList(o.disks).map((d) => ({ mount: String(d.DeviceID), totalBytes: num(d.Size), freeBytes: num(d.FreeSpace) })),
    procs,
    ports,
  };
}

/** Windows gives cumulative CPU time in 100 ns ticks. Percent of the whole machine over the time between two samples. */
export function winCpuPcts(prev, procs, nowMs, cores) {
  const next = new Map();
  for (const p of procs) {
    const before = prev.get(p.pid);
    const same = before && before.startedAt === p.startedAt;
    const wallTicks = same ? (nowMs - before.at) * 10_000 : 0;
    p.cpuPct = same && wallTicks > 0 ? Math.max(0, Math.min(100, ((p.cpuTicks - before.ticks) / wallTicks / cores) * 100)) : 0;
    next.set(p.pid, { ticks: p.cpuTicks, startedAt: p.startedAt, at: nowMs });
  }
  return next;
}

// ---------- adapters ----------

const WIN_SCRIPT = [
  "[Console]::OutputEncoding=[Text.Encoding]::UTF8;$ErrorActionPreference='SilentlyContinue';",
  '$o=@{',
  'os=@(Get-CimInstance Win32_OperatingSystem|Select-Object Caption,Version,TotalVisibleMemorySize,FreePhysicalMemory,LastBootUpTime);',
  'pagefile=@(Get-CimInstance Win32_PageFileUsage|Select-Object CurrentUsage,AllocatedBaseSize);',
  "disks=@(Get-CimInstance Win32_LogicalDisk -Filter 'DriveType=3'|Select-Object DeviceID,Size,FreeSpace);",
  'procs=@(Get-CimInstance Win32_Process|Select-Object ProcessId,ParentProcessId,Name,CommandLine,CreationDate,WorkingSetSize,UserModeTime,KernelModeTime,SessionId);',
  'ports=@(try{Get-NetTCPConnection -State Listen -ErrorAction Stop|Select-Object LocalPort,OwningProcess}catch{})',
  '};$o|ConvertTo-Json -Compress -Depth 4',
].join('');

const PS_COLUMNS = 'pid=,ppid=,uid=,pcpu=,rss=,etime=,comm=';
const unixProbes = (extra) => ({
  processes: () => ({ bin: 'ps', args: ['-axo', PS_COLUMNS], parse: parsePs }),
  gates: () => ({ bin: 'ps', args: ['-axo', 'pid=,args='], parse: parseCommandRoles }),
  ports: () => ({ bin: 'lsof', args: ['-nP', '-iTCP', '-sTCP:LISTEN', '-Fpn'], parse: parseLsofListen, soft: true }),
  disks: (paths) => ({ bin: 'df', args: ['-kP', ...paths], parse: parseDf, soft: true }),
  folders: (paths) => ({ bin: 'du', args: ['-sk', ...paths], parse: parseDu, soft: true, timeout: DU_TIMEOUT_MS }),
  ...extra,
});

/** One entry per process.platform. Each probe is `{ bin, args, parse(out, nowMs) }`; every call is execFile with fixed arguments. */
export const ADAPTERS = {
  darwin: unixProbes({
    memory: () => [
      { bin: 'vm_stat', args: [], parse: parseVmStat },
      { bin: 'sysctl', args: ['-n', 'vm.swapusage'], parse: parseSwapUsage },
    ],
    machine: () => ({ bin: 'sw_vers', args: [], parse: parseSwVers }),
    cwd: (pids) => [{ bin: 'lsof', args: ['-a', '-d', 'cwd', '-Fpn', '-p', pids.join(',')], parse: parseLsofCwd, soft: true }],
  }),
  linux: unixProbes({
    processes: () => ({ bin: 'ps', args: ['-eo', PS_COLUMNS], parse: parsePs }),
    gates: () => ({ bin: 'ps', args: ['-eo', 'pid=,args='], parse: parseCommandRoles }),
    memory: () => [{ bin: 'cat', args: ['/proc/meminfo'], parse: parseMeminfo }],
    machine: () => ({ bin: 'cat', args: ['/etc/os-release'], parse: parseOsRelease }),
    cwd: (pids) => pids.map((pid) => ({ bin: 'readlink', args: [`/proc/${pid}/cwd`], parse: (t) => new Map(t.trim() ? [[pid, t.trim()]] : []) })),
  }),
  win32: {
    bundle: () => ({ bin: 'powershell.exe', args: ['-NoProfile', '-NonInteractive', '-Command', WIN_SCRIPT], timeout: WIN_TIMEOUT_MS }),
  },
};
const adapterFor = (platform) => ADAPTERS[platform] ?? ADAPTERS.linux;

// ---------- labels ----------

/** Walks up from a process to the Claude session that owns it, if any. */
function sessionRootOf(proc, byPid, sessionByPid) {
  let cur = proc;
  for (let hops = 0; cur && hops < 64; hops++) {
    if (sessionByPid.has(cur.pid)) return cur.pid;
    cur = byPid.get(cur.ppid);
  }
  return null;
}

const KIND_RULES = [
  // A claude process is a session even before `claude agents` lists it, and its prompt (often `/until-ready ...`) never makes it a test run.
  { kind: 'session', test: (p, c) => c.sessionByPid.has(p.pid) || CLAUDE_BIN.test(p.name) || p.claude },
  { kind: 'mission-control', test: (p, c) => p.pid === c.selfPid },
  { kind: 'dev-server', test: (p, c) => c.ports.length > 0 && isDevRuntime(p.name) },
  { kind: 'gate', test: (p, c) => c.ports.length === 0 && p.gate },
];

/**
 * Adds kind, session (the Claude session's name, for its own process and everything under it), ports and sessionPid to each process.
 * @param {{pid:number, ppid:number, name:string, gate:boolean}[]} procs
 */
export function labelProcesses(procs, { sessions = [], selfPid, ports = new Map() }) {
  const byPid = new Map(procs.map((p) => [p.pid, p]));
  const sessionByPid = new Map(sessions.filter((s) => Number.isInteger(s.pid)).map((s) => [s.pid, s]));
  return procs.map((p) => {
    const c = { sessionByPid, selfPid, ports: ports.get(p.pid) ?? [] };
    const sessionPid = sessionRootOf(p, byPid, sessionByPid);
    return {
      ...p,
      kind: KIND_RULES.find((r) => r.test(p, c))?.kind ?? 'other',
      session: sessionPid ? clean(sessionByPid.get(sessionPid).name || '(unnamed)') : null,
      sessionPid,
      ports: c.ports,
    };
  });
}

/** Per session: the session's process plus everything under it. */
export function sessionTotals(labelled) {
  const by = new Map();
  for (const p of labelled) {
    if (!p.sessionPid) continue;
    const t = by.get(p.sessionPid) ?? { name: p.session, cpuPct: 0, memBytes: 0, processes: 0 };
    t.cpuPct += p.cpuPct;
    t.memBytes += p.memBytes;
    t.processes += 1;
    by.set(p.sessionPid, t);
  }
  return [...by.values()].map((t) => ({ ...t, cpuPct: round1(t.cpuPct) })).sort((a, b) => b.memBytes - a.memBytes);
}

// ---------- stop guard ----------

export const REFUSALS = {
  gone: 'That process has already ended.',
  system: 'That is a system process.',
  session: 'Claude sessions are stopped from the Work page.',
  'sessions-unknown': "Mission control can't read the Claude session list right now, so it won't stop anything.",
  'mission-control': 'That is mission control or the program that started it.',
  kind: 'Only dev servers and test runs can be stopped from here.',
  'not-owned': "That process isn't yours.",
  outside: "That process isn't in one of your project folders.",
  restarted: 'That process was replaced by a newer one. Refresh and look again.',
};

/**
 * Whether the System page may stop `proc`. Pure: everything it needs comes in `ctx`.
 * @returns {{ok: true} | {ok: false, reason: keyof typeof REFUSALS}}
 */
export function canStop(proc, ctx) {
  const no = (reason) => ({ ok: false, reason });
  if (!proc) return no('gone');
  if (!Number.isInteger(proc.pid) || proc.pid <= 1 || (ctx.platform === 'win32' && proc.pid === 4)) return no('system');
  if (!ctx.sessionPids) return no('sessions-unknown');
  if (ctx.sessionPids.has(proc.pid)) return no('session');
  if (proc.pid === ctx.selfPid || ctx.ancestors.has(proc.pid)) return no('mission-control');
  if (!KINDS[proc.kind]?.stoppable) return no('kind');
  const owned = ctx.platform === 'win32' ? proc.winSession !== null && proc.winSession === ctx.ownWinSession : proc.uid === ctx.uid;
  if (!owned) return no('not-owned');
  const project = ctx.platform === 'win32' ? proc.cmdProject : projectOfPath(ctx.roots, proc.cwd);
  if (!project) return no('outside');
  if (!Number.isFinite(ctx.startedAt) || Math.abs(proc.startedAt - ctx.startedAt) > START_TOLERANCE_MS) return no('restarted');
  return { ok: true };
}

/** The pids from `selfPid` up to the root. Stopping any of them would take mission control down. */
export function ancestorsOf(selfPid, procs) {
  const byPid = new Map(procs.map((p) => [p.pid, p]));
  const out = new Set();
  let cur = byPid.get(selfPid);
  while (cur && cur.ppid > 0 && !out.has(cur.ppid)) {
    out.add(cur.ppid);
    cur = byPid.get(cur.ppid);
  }
  return out;
}

// ---------- alerts ----------

const round1 = (n) => Math.round(n * 10) / 10;
export const gb = (bytes) => `${(bytes / 1024 ** 3).toFixed(1)} GB`;
const topName = (system) => {
  const top = [...(system.processes ?? [])].sort((a, b) => b.cpuPct - a.cpuPct)[0];
  return top ? `${top.name}${top.session && top.kind !== 'session' ? ` (from ${top.session})` : ''}` : null;
};

/** The average CPU over the last `minutes`, or null while the history doesn't reach back that far. */
export function sustainedCpu(history, minutes, slackMs = SAMPLE_MS * 1.5) {
  if (!history?.length) return null;
  const end = history.at(-1).t;
  const window = history.filter((h) => h.t >= end - minutes * 60_000 - slackMs && h.pct !== null);
  if (!window.length || end - window[0].t < minutes * 60_000 - slackMs) return null;
  return window.reduce((a, h) => a + h.pct, 0) / window.length;
}

/** One place for every alert. `check` returns the plain-words text, or null when all is well. */
export const ALERTS = [
  {
    id: 'cpu',
    check: (sys) => {
      const avg = sustainedCpu(sys.cpu?.history, THRESHOLDS.cpuMinutes);
      if (avg === null || avg <= THRESHOLDS.cpuPct) return null;
      const top = topName(sys);
      return `CPU over ${THRESHOLDS.cpuPct}% for ${THRESHOLDS.cpuMinutes} minutes.${top ? ` Top is ${top}.` : ''}`;
    },
  },
  {
    id: 'memory',
    check: (sys) => {
      const m = sys.memory;
      if (!m || m.pct === null || m.pct <= THRESHOLDS.memoryPct) return null;
      return `Memory pressure high: ${Math.round(m.pct)}% in use, swap ${gb(m.swapUsedBytes)}.`;
    },
  },
  {
    id: 'swap',
    check: (sys) => {
      const m = sys.memory;
      if (!m || !m.totalBytes || m.swapUsedBytes <= m.totalBytes * THRESHOLDS.swapFractionOfRam) return null;
      return `Swap is heavy: ${gb(m.swapUsedBytes)} used, over a quarter of the ${gb(m.totalBytes)} of RAM.`;
    },
  },
  {
    id: 'disk',
    check: (sys) => {
      const low = (sys.disks ?? []).filter((d) => d.freePct < THRESHOLDS.diskFreePct);
      return low.length ? low.map((d) => `Disk under ${THRESHOLDS.diskFreePct}% free on ${d.mount}: ${gb(d.freeBytes)} left.`).join(' ') : null;
    },
  },
  {
    id: 'uptime',
    check: (sys) => uptimeWarningOn(sys.platform ?? 'darwin', sys.machine?.uptimeSec),
  },
  {
    id: 'dev-servers',
    check: (sys) => {
      const old = (sys.processes ?? []).filter((p) => p.kind === 'dev-server' && p.ageSec >= THRESHOLDS.devServerDays * 86_400);
      return old.length ? `${old.length} dev server${old.length === 1 ? ' has' : 's have'} been running ${THRESHOLDS.devServerDays}+ days.` : null;
    },
  },
];

export function buildAlerts(system) {
  return ALERTS.map((a) => ({ id: a.id, text: a.check(system) })).filter((a) => a.text);
}

/** Things worth stopping, each with the pids the Stop button would send. */
export function buildSuggestions(system, nowMs) {
  const out = [];
  const midnight = new Date(nowMs).setHours(0, 0, 0, 0);
  const stale = (system.processes ?? []).filter((p) => p.kind === 'dev-server' && p.stoppable && p.startedAt < midnight);
  if (stale.length) out.push({ id: 'old-dev-servers', text: `Stop the ${stale.length} dev server${stale.length === 1 ? '' : 's'} nobody started today`, pids: stale.map((p) => p.pid) });
  const hot = (system.processes ?? []).filter((p) => p.kind === 'gate' && p.stoppable && p.cpuPct > THRESHOLDS.cpuPct && p.ageSec >= THRESHOLDS.cpuMinutes * 60);
  if (hot.length) out.push({ id: 'hot-gates', text: `Stop the gate run that has used over ${THRESHOLDS.cpuPct}% CPU for ${THRESHOLDS.cpuMinutes} minutes`, pids: hot.map((p) => p.pid) });
  return out;
}

// ---------- the sampler ----------

/** Folders worth sizing: transcripts, and each project's task and session worktree folders that exist. */
export function folderTargets({ projects, transcriptsDir, harnessDir, exists }) {
  const out = [{ label: 'Session transcripts', path: transcriptsDir }];
  for (const p of projects) {
    for (const c of p.checkouts) {
      out.push({ label: `${p.name} task worktrees`, path: `${c}-tasks` }, { label: `${p.name} session worktrees`, path: `${c}/.claude/worktrees` });
    }
  }
  out.push({ label: 'Harness session worktrees', path: `${harnessDir}/.claude/worktrees` }, { label: 'Harness task worktrees', path: `${harnessDir}-tasks` });
  return out.filter((t) => exists(t.path));
}

/** Folder size without `du`, for Windows. Doesn't follow links. */
export async function walkSize(dir, deadlineMs) {
  let total = 0;
  const stack = [dir];
  while (stack.length) {
    if (Date.now() > deadlineMs) return null;
    const cur = stack.pop();
    try {
      for await (const e of await opendir(cur)) {
        const full = winPath.join(cur, e.name);
        const st = await lstat(full).catch(() => null);
        if (!st) continue;
        if (st.isDirectory()) stack.push(full);
        else if (!st.isSymbolicLink()) total += st.size;
      }
    } catch {}
  }
  return total;
}

/** Matches df rows to the paths asked about: by order when every path got a row, else by the longest mount prefix. */
export function diskRows(rows, targets, platform) {
  const byMount = new Map();
  const put = (row, label) => {
    const cur = byMount.get(row.mount) ?? { ...row, freePct: row.totalBytes ? round1((row.freeBytes / row.totalBytes) * 100) : 0, holds: [] };
    if (label && !cur.holds.includes(label)) cur.holds.push(label);
    byMount.set(row.mount, cur);
  };
  if (platform === 'win32') {
    for (const r of rows) put(r, null);
    for (const t of targets) {
      const drive = winPath.parse(t.path).root.slice(0, 2).toLowerCase();
      const row = rows.find((r) => r.mount.toLowerCase() === drive);
      if (row) put(row, t.label);
    }
  } else if (rows.length === targets.length) {
    rows.forEach((r, i) => put(r, targets[i].label));
  } else {
    for (const t of targets) {
      const row = rows.filter((r) => t.path === r.mount || t.path.startsWith(r.mount.replace(/\/$/, '') + '/')).sort((a, b) => b.mount.length - a.mount.length)[0];
      if (row) put(row, t.label);
    }
  }
  return [...byMount.values()];
}

/**
 * Reads the computer's load and keeps a little history. Nothing here touches HTTP.
 * `exec` is actions.exec (execFile, never a shell). `sys` is the `os` module, or a stand-in in tests.
 */
export function createSystemSampler({ exec = defaultExec, platform = process.platform, sys = nodeOs, now = Date.now, sampleMs = SAMPLE_MS, folderMs = FOLDER_MS, selfPid = process.pid, uid = null } = {}) {
  const adapter = adapterFor(platform);
  const ownUid = uid ?? (() => { try { return sys.userInfo().uid; } catch { return null; } })();
  const st = {
    env: null,
    timers: [],
    stopped: false,
    cpuPrev: null,
    cpuHistory: [],
    memHistory: [],
    mem: null,
    machine: null,
    full: null,
    folders: [],
    foldersAt: 0,
    winPrev: new Map(),
    errors: new Map(),
    runs: new Map(),
  };

  const fail = (name, e) => st.errors.set(name, `Couldn't read ${name}: ${String(e?.message ?? e).split('\n')[0]}`);
  const ok = (name) => st.errors.delete(name);

  async function run(spec) {
    const r = await exec(spec.bin, spec.args, { timeout: spec.timeout ?? PROBE_TIMEOUT_MS });
    if (!r.ok && !(spec.soft && r.code === 1)) throw new Error((r.err || `${spec.bin} failed`).split('\n')[0]);
    return spec.parse(r.out, now());
  }

  /** Runs `fn` unless the last run under `name` is still going or the sampler is stopped. Returns the run, so callers can wait on it. */
  function guarded(name, fn) {
    if (st.stopped) return Promise.resolve(null);
    if (st.runs.has(name)) return st.runs.get(name);
    const p = Promise.resolve()
      .then(fn)
      .catch((e) => {
        fail(name, e);
        return null;
      })
      .finally(() => st.runs.delete(name));
    st.runs.set(name, p);
    return p;
  }

  const notify = () => st.env?.onUpdate?.();
  const push = (arr, t, pct) => {
    arr.push({ t, pct });
    if (arr.length > HISTORY_POINTS) arr.shift();
  };

  function cpuNow() {
    const totals = sys.cpus().reduce((a, c) => ({ idle: a.idle + c.times.idle, all: a.all + c.times.user + c.times.nice + c.times.sys + c.times.idle + c.times.irq }), { idle: 0, all: 0 });
    const prev = st.cpuPrev;
    st.cpuPrev = totals;
    if (!prev || totals.all <= prev.all) return null;
    return round1(100 * (1 - (totals.idle - prev.idle) / (totals.all - prev.all)));
  }

  async function readMemory() {
    if (platform === 'win32') return { usedBytes: sys.totalmem() - sys.freemem(), swapUsedBytes: st.mem?.swapUsedBytes ?? 0, swapTotalBytes: st.mem?.swapTotalBytes ?? 0 };
    const parts = await Promise.all(adapter.memory().map(run));
    return Object.assign({}, ...parts);
  }

  async function lightTick() {
    const t = now();
    await readMachine();
    push(st.cpuHistory, t, cpuNow());
    try {
      st.mem = await readMemory();
      ok('memory');
    } catch (e) {
      fail('memory', e);
    }
    const total = sys.totalmem();
    push(st.memHistory, t, st.mem ? round1((st.mem.usedBytes / total) * 100) : null);
    notify();
  }

  async function readMachine() {
    if (st.machine) return;
    const base = { cpuModel: sys.cpus()[0]?.model?.trim() ?? '', cores: sys.cpus().length, totalBytes: sys.totalmem() };
    if (platform === 'win32') return;
    try {
      st.machine = { ...base, ...(await run(adapter.machine())) };
    } catch (e) {
      fail('machine', e);
    }
  }

  /** `env.sessions()` is null until the session list has been read, and then nothing is stoppable. */
  function context(procs) {
    const sessions = st.env?.sessions?.() ?? null;
    return {
      platform,
      selfPid,
      uid: ownUid,
      ancestors: ancestorsOf(selfPid, procs),
      sessionPids: sessions && new Set(sessions.map((s) => s.pid).filter(Number.isInteger)),
      roots: st.env?.roots ?? [],
      ownWinSession: procs.find((p) => p.pid === selfPid)?.winSession ?? null,
    };
  }

  /** Resolves with this run's reading, or null when the process list couldn't be read. */
  async function fullUnix() {
    const targets = st.env?.diskTargets ?? [];
    const settle = async (name, spec, fallback) => {
      try {
        const v = await run(spec);
        ok(name);
        return v;
      } catch (e) {
        fail(name, e);
        return fallback;
      }
    };
    const [procs, roles, ports, rows] = await Promise.all([
      settle('processes', adapter.processes(), null),
      settle('command lines', adapter.gates(), { gates: new Set(), claude: new Set() }),
      settle('listening ports', adapter.ports(), new Map()),
      targets.length ? settle('disks', adapter.disks(targets.map((x) => x.path)), null) : null,
    ]);
    if (!procs) return null;
    const t = now();
    for (const p of procs) Object.assign(p, { gate: roles.gates.has(p.pid), claude: roles.claude.has(p.pid) });
    const sessions = st.env?.sessions?.() ?? [];
    let labelled = labelProcesses(procs, { sessions, selfPid, ports });
    const need = labelled.filter((p) => p.kind === 'dev-server' || p.kind === 'gate').map((p) => p.pid);
    const cwd = new Map();
    if (need.length) {
      const maps = await Promise.all(adapter.cwd(need).map((spec) => settle('working folders', spec, new Map())));
      for (const m of maps) for (const [k, v] of m) cwd.set(k, v);
    }
    labelled = labelled.map((p) => ({ ...p, cwd: cwd.get(p.pid) ?? null }));
    return { at: t, procs: labelled, disks: rows ? diskRows(rows, targets, platform) : st.full?.disks ?? [] };
  }

  async function fullWin() {
    const targets = st.env?.diskTargets ?? [];
    const cores = Math.max(1, sys.cpus().length);
    const [out, t] = await run({ ...adapter.bundle(), parse: (x, nowMs) => [x, nowMs] });
    const parsed = parseWin32(out, { roots: st.env?.roots ?? [], nowMs: t });
    st.winPrev = winCpuPcts(st.winPrev, parsed.procs, t, cores);
    st.machine = { cpuModel: sys.cpus()[0]?.model?.trim() ?? '', cores, totalBytes: parsed.memory.totalBytes || sys.totalmem(), os: parsed.machine.os, version: parsed.machine.version };
    st.mem = parsed.memory;
    st.bootSec = parsed.machine.uptimeSec;
    const sessions = st.env?.sessions?.() ?? [];
    ok('processes');
    return { at: t, procs: labelProcesses(parsed.procs, { sessions, selfPid, ports: parsed.ports }).map((p) => ({ ...p, cwd: null })), disks: diskRows(parsed.disks, targets, platform) };
  }

  /**
   * One full read: processes, ports, working folders, disks. The page keeps showing the last good reading,
   * but this resolves with what a stop decision needs from this read only, or null when it failed.
   */
  async function fullProbe() {
    await readMachine();
    let fresh = null;
    try {
      fresh = platform === 'win32' ? await fullWin() : await fullUnix();
    } catch (e) {
      fail('processes', e);
    }
    if (fresh) st.full = fresh;
    if (st.full && now() - st.foldersAt > folderMs) guarded('folders', readFolders);
    notify();
    return fresh && { at: fresh.at, procs: fresh.procs, ctx: context(fresh.procs) };
  }

  async function readFolders() {
    st.foldersAt = now();
    const targets = st.env?.folderTargets ?? [];
    if (!targets.length) return;
    let sizes;
    if (platform === 'win32') {
      sizes = new Map();
      for (const t of targets) sizes.set(t.path, await walkSize(t.path, Date.now() + DU_TIMEOUT_MS));
    } else {
      sizes = await run(adapter.folders(targets.map((x) => x.path)));
    }
    st.folders = targets.map((t) => ({ label: t.label, path: t.path, bytes: sizes.get(t.path) ?? null, at: new Date(now()).toISOString() }));
    ok('folders');
    notify();
  }

  const fullGuarded = () => guarded('full', fullProbe);

  function snapshot() {
    const t = now();
    const total = sys.totalmem();
    const full = st.full;
    const procs = full?.procs ?? [];
    const ctx = context(procs);
    const rows = procs.map((p) => ({ ...p, stoppable: canStop(p, { ...ctx, startedAt: p.startedAt }).ok }));
    const byCpu = [...rows].sort((a, b) => b.cpuPct - a.cpuPct);
    const byMem = [...rows].sort((a, b) => b.memBytes - a.memBytes);
    const keep = new Set([...byCpu.slice(0, 12), ...byMem.slice(0, 12), ...rows.filter((p) => ['dev-server', 'gate', 'mission-control'].includes(p.kind))].map((p) => p.pid));
    const processes = byCpu.filter((p) => keep.has(p.pid)).map((p) => ({
      pid: p.pid, name: p.name, cpuPct: round1(p.cpuPct), memBytes: p.memBytes, ageSec: p.ageSec, startedAt: p.startedAt,
      kind: p.kind, session: p.session, ports: p.ports, project: platform === 'win32' ? p.cmdProject : projectOfPath(st.env?.roots ?? [], p.cwd), stoppable: p.stoppable,
    }));
    const mem = st.mem;
    const cpuPct = st.cpuHistory.at(-1)?.pct ?? null;
    const system = {
      at: new Date(t).toISOString(),
      platform,
      machine: { os: st.machine?.os ?? '', version: st.machine?.version ?? '', cpuModel: st.machine?.cpuModel ?? sys.cpus()[0]?.model?.trim() ?? '', cores: sys.cpus().length, totalBytes: total, uptimeSec: st.bootSec ?? Math.round(sys.uptime()) },
      cpu: { pct: cpuPct, load: platform === 'win32' ? null : sys.loadavg().map((n) => Math.round(n * 100) / 100), history: st.cpuHistory.filter((h) => h.pct !== null).map((h) => ({ ...h })) },
      memory: {
        totalBytes: total,
        usedBytes: mem?.usedBytes ?? null,
        pct: mem ? round1((mem.usedBytes / total) * 100) : null,
        swapUsedBytes: mem?.swapUsedBytes ?? 0,
        swapTotalBytes: mem?.swapTotalBytes ?? 0,
        history: st.memHistory.filter((h) => h.pct !== null).map((h) => ({ ...h })),
      },
      disks: full?.disks ?? [],
      folders: st.folders,
      processes,
      sessions: sessionTotals(procs),
      alerts: [],
      suggestions: [],
      errors: [...st.errors.values()],
    };
    system.alerts = buildAlerts(system);
    system.suggestions = buildSuggestions(system, t);
    return system;
  }

  return {
    snapshot,
    /** A read that starts after this call, or null when it fails. The stop route decides on this, never on the page's copy. */
    async probeNow() {
      await st.runs.get('full');
      return guarded('full', fullProbe);
    },
    /** A client just connected: read now instead of waiting for the next tick. */
    wake() {
      return fullGuarded();
    },
    /** @param {{sessions: () => {pid?: number, name?: string}[] | null, active: () => boolean, roots: {id: string, root: string}[], diskTargets: {label: string, path: string}[], folderTargets: {label: string, path: string}[], onUpdate?: () => void}} env */
    start(env) {
      st.env = env;
      st.stopped = false;
      const every = (fn, ms) => st.timers.push(setInterval(fn, ms).unref());
      guarded('light', lightTick);
      every(() => guarded('light', lightTick), sampleMs);
      every(() => st.env.active() && fullGuarded(), sampleMs);
    },
    async stop() {
      st.stopped = true;
      for (const t of st.timers) clearInterval(t);
      st.timers = [];
      await Promise.all([...st.runs.values()]);
    },
    /** Test hooks: run one tick and wait for it. */
    lightTick: () => guarded('light', lightTick),
    fullTick: fullGuarded,
  };
}
