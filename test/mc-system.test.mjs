import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { request } from 'node:http';
import { createServer as netServer } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { after, describe, test } from 'node:test';

const sys = await import('../mc/system.mjs');
const { buildNeedsYou } = await import('../mc/snapshot.mjs');
const { createMissionControl } = await import('../mc/server.mjs');

const FIX = new URL('./fixtures/system/', import.meta.url);
const fx = (name) => readFileSync(new URL(name, FIX), 'utf8');
const NOW = 1793850000000;
const GB = 1024 ** 3;

const ROOTS = [
  { id: 'harness', root: '/Volumes/Work/owner/Projects/claude-harness' },
  { id: 'harness', root: '/Volumes/Work/owner/Projects/claude-harness-tasks' },
  { id: 'alpha', root: '/Volumes/Work/owner/Projects/alpha' },
  { id: 'alpha', root: '/Volumes/Work/owner/Projects/alpha-tasks' },
  { id: 'beta', root: '/Volumes/Work/owner/Projects/beta' },
];
const AGENTS = JSON.parse(fx('darwin-agents.json'));
const MC_PID = 90002;

describe('darwin parsers', () => {
  test('vm_stat: used is app + wired + compressed, in the header line\'s page size', () => {
    assert.equal(sys.parseVmStat(fx('darwin-vm_stat.txt')).usedBytes, (455608 + 205670 + 192037) * 16384);
    assert.throws(() => sys.parseVmStat('nothing useful'));
  });

  test('swap usage in megabytes', () => {
    assert.deepEqual(sys.parseSwapUsage(fx('darwin-swapusage.txt')), { swapTotalBytes: 10240 * 1024 * 1024, swapUsedBytes: Math.round(9275.19 * 1024 * 1024) });
  });

  test('sw_vers', () => {
    assert.deepEqual(sys.parseSwVers(fx('darwin-sw_vers.txt')), { os: 'macOS', version: '26.2' });
  });

  test('etime in every shape ps prints', () => {
    assert.equal(sys.parseEtime('00:05'), 5);
    assert.equal(sys.parseEtime('02:10:11'), 2 * 3600 + 10 * 60 + 11);
    assert.equal(sys.parseEtime('185-23:17:33'), ((185 * 24 + 23) * 60 + 17) * 60 + 33);
    assert.equal(sys.parseEtime('garbage'), 0);
  });

  test('ps rows: basename of a comm path with spaces, rss in bytes, start time from the age', () => {
    const rows = sys.parsePs(fx('darwin-ps.txt'), NOW);
    assert.equal(rows.length, 62);
    const claude = rows.find((r) => r.pid === 77420);
    assert.equal(claude.name, 'claude');
    assert.equal(claude.uid, 501);
    assert.equal(claude.ppid, 77419);
    assert.equal(claude.memBytes, 336000 * 1024);
    assert.equal(claude.startedAt, NOW - claude.ageSec * 1000);
    assert.equal(rows.find((r) => r.pid === 1).name, 'launchd');
    assert.equal(rows.find((r) => r.pid === 36101).name, 'next-server (v16.4.3)');
  });

  test('command lines reduce to which pids are test runs', () => {
    assert.deepEqual([...sys.parseGatePids(fx('darwin-args.txt'))], [90001]);
  });

  test('listening ports per pid, sorted and unique', () => {
    const ports = sys.parseLsofListen(fx('darwin-lsof-listen.txt'));
    assert.deepEqual(ports.get(636), [5000, 7000]);
    assert.deepEqual(ports.get(90003), [3100]);
    assert.deepEqual(ports.get(42263), [42050]);
  });

  test('working folders per pid', () => {
    const cwd = sys.parseLsofCwd(fx('darwin-lsof-cwd.txt'));
    assert.equal(cwd.get(90003), '/Volumes/Work/owner/Projects/alpha-tasks/mc-ab12cd');
    assert.equal(cwd.get(36101), '/Volumes/Work/owner/Desktop/sites/site');
  });

  test('df rows, with a mount point that holds a space', () => {
    const rows = sys.parseDf(fx('darwin-df-two-volumes.txt'));
    assert.deepEqual(rows.map((r) => r.mount), ['/System/Volumes/Data', '/Volumes/Fast Drive']);
    assert.equal(rows[1].freeBytes, 25490576 * 1024);
  });

  test('disks asked about three times show once, with what they hold', () => {
    const targets = [{ label: 'harness', path: '/Volumes/Work/owner/Projects/claude-harness' }, { label: 'projects', path: '/Volumes/Work/owner/Projects' }, { label: '~/.claude', path: '/Volumes/Work/owner/.claude' }];
    const disks = sys.diskRows(sys.parseDf(fx('darwin-df.txt')), targets, 'darwin');
    assert.equal(disks.length, 1);
    assert.deepEqual(disks[0].holds, ['harness', 'projects', '~/.claude']);
    assert.equal(disks[0].freePct, 35.7);
  });

  test('du sizes', () => {
    assert.deepEqual([...sys.parseDu('2048\t/a/b\n12\t/c d')], [['/a/b', 2048 * 1024], ['/c d', 12 * 1024]]);
  });
});

describe('linux parsers', () => {
  test('meminfo: used is total minus available', () => {
    assert.deepEqual(sys.parseMeminfo(fx('linux-meminfo.txt')), { usedBytes: (16384000 - 4096000) * 1024, swapTotalBytes: 2097152 * 1024, swapUsedBytes: 1048576 * 1024 });
  });

  test('ps, os-release and df', () => {
    const rows = sys.parsePs(fx('linux-ps.txt'), NOW);
    assert.deepEqual(rows.map((r) => [r.pid, r.name, r.cpuPct]), [[1, 'systemd', 0.1], [900, 'node', 0.5], [1000, 'node', 55], [1100, 'bash', 0]]);
    assert.equal(rows[0].ageSec, ((10 * 24 + 2) * 60 + 11) * 60 + 11);
    assert.deepEqual(sys.parseOsRelease(fx('linux-os-release.txt')), { os: 'Ubuntu', version: '24.04' });
    assert.equal(sys.parseDf(fx('linux-df.txt'))[0].mount, '/');
  });
});

describe('win32 parser', () => {
  const parsed = sys.parseWin32(fx('win32-snapshot.json'), { roots: [{ id: 'alpha', root: 'C:\\Users\\owner\\Projects\\alpha' }, { id: 'alpha', root: 'C:\\Users\\owner\\Projects\\alpha-tasks' }, { id: 'harness', root: 'C:\\Users\\owner\\Projects\\claude-harness' }], nowMs: NOW });
  const byPid = (pid) => parsed.procs.find((p) => p.pid === pid);

  test('machine, memory, swap and disks', () => {
    assert.equal(parsed.machine.os, 'Microsoft Windows 11 Pro');
    assert.equal(parsed.machine.uptimeSec, 5 * 86400);
    assert.equal(parsed.memory.totalBytes, 16 * GB);
    assert.equal(parsed.memory.usedBytes, 14 * GB);
    assert.equal(parsed.memory.swapUsedBytes, 3072 * 1024 * 1024);
    assert.deepEqual(parsed.disks.map((d) => [d.mount, d.freeBytes]), [['C:', 40000000000], ['D:', 600000000000]]);
  });

  test('processes: /Date(ms)/ start times, no idle process, working set as memory', () => {
    assert.equal(byPid(0), undefined);
    assert.equal(byPid(7100).startedAt, NOW - 3 * 86400 * 1000);
    assert.equal(byPid(7100).ageSec, 3 * 86400);
    assert.equal(byPid(7100).memBytes, 450000000);
    assert.equal(byPid(7100).winSession, 1);
    assert.equal(byPid(7500).winSession, 0);
  });

  test('the command line only becomes a gate flag and a project id', () => {
    assert.equal(byPid(7200).gate, true);
    assert.equal(byPid(7100).gate, false);
    assert.equal(byPid(7100).cmdProject, 'alpha');
    assert.equal(byPid(7200).cmdProject, 'alpha', 'forward slashes and case do not matter');
    assert.equal(byPid(7300).cmdProject, 'harness');
    assert.equal(byPid(7400).cmdProject, null);
    assert.ok(!JSON.stringify(parsed.procs).includes('FIXTURE-ARG'));
  });

  test('a project is the folder holding the program or script, at a path boundary, not any folder named later', () => {
    const roots = [{ id: 'foo', root: 'C:\\Users\\x\\Projects\\foo' }, { id: 'spaced', root: 'C:\\Users\\x\\My Projects\\bar\\' }];
    const of = (cmd) => sys.projectOfCommand(roots, cmd);
    assert.equal(of('node C:\\Users\\x\\Projects\\foo\\server.js'), 'foo');
    assert.equal(of('node C:\\Users\\x\\Projects\\foobar\\server.js'), null, 'foobar is not foo');
    assert.equal(of('node C:\\Users\\x\\Projects\\foo'), 'foo');
    assert.equal(of('node C:\\tools\\serve.js --root C:\\Users\\x\\Projects\\foo'), null, 'a mere mention');
    assert.equal(of('node C:\\tools\\serve.js C:\\Users\\x\\Projects\\foo\\a.txt'), null, 'a later argument');
    assert.equal(of('C:\\Users\\x\\Projects\\foo\\node_modules\\.bin\\esbuild.exe --serve'), 'foo', 'the program itself');
    assert.equal(of('"C:\\Program Files\\nodejs\\node.exe" --inspect "C:\\Users\\x\\My Projects\\bar\\app.js"'), 'spaced', 'quoted paths with spaces');
  });

  test('listening ports are unique per pid', () => {
    assert.deepEqual(parsed.ports.get(7100), [3000]);
  });

  test('a single object where PowerShell collapses a one-item list', () => {
    const one = JSON.stringify({ os: { Caption: 'Windows', TotalVisibleMemorySize: 1024, FreePhysicalMemory: 512 }, disks: { DeviceID: 'C:', Size: 10, FreeSpace: 5 }, procs: [], ports: [] });
    assert.equal(sys.parseWin32(one, { nowMs: NOW }).disks.length, 1);
  });

  test('cpu is the change in cpu time over wall time and cores, 0 on the first sample', () => {
    const cores = 4;
    const first = sys.winCpuPcts(new Map(), [{ pid: 1, startedAt: 5, cpuTicks: 0 }], NOW, cores);
    const next = [{ pid: 1, startedAt: 5, cpuTicks: 10_000 * 1000 * cores / 2 }];
    sys.winCpuPcts(first, next, NOW + 1000, cores);
    assert.equal(next[0].cpuPct, 50);
    const reused = [{ pid: 1, startedAt: 6, cpuTicks: 9e9 }];
    sys.winCpuPcts(first, reused, NOW + 1000, cores);
    assert.equal(reused[0].cpuPct, 0, 'a reused pid starts over');
  });
});

describe('alerts', () => {
  const calm = () => ({ cpu: { history: [] }, memory: { totalBytes: 16 * GB, pct: 50, swapUsedBytes: 0 }, disks: [{ mount: '/', freePct: 50, freeBytes: 100 * GB }], processes: [] });
  const steady = (pct, points = 31) => Array.from({ length: points }, (_, i) => ({ t: NOW + i * 10_000, pct }));
  const fire = (id, system) => sys.ALERTS.find((a) => a.id === id).check(system);

  test('cpu: over 90% averaged across five minutes, naming the top process', () => {
    const system = { ...calm(), cpu: { history: steady(90.1) }, processes: [{ name: 'node', cpuPct: 80, session: 'Recipe Box', kind: 'dev-server', ageSec: 1 }, { name: 'sleep', cpuPct: 1, kind: 'other', ageSec: 1 }] };
    assert.equal(fire('cpu', system), 'CPU over 90% for 5 minutes. Top is node (from Recipe Box).');
    assert.equal(fire('cpu', { ...system, cpu: { history: steady(90) } }), null, 'exactly 90 is quiet');
    assert.equal(fire('cpu', { ...system, cpu: { history: steady(99, 28) } }), null, 'needs five minutes of samples');
    const spike = steady(50);
    spike[30] = { t: spike[30].t, pct: 100 };
    assert.equal(fire('cpu', { ...system, cpu: { history: spike } }), null, 'one spike is not sustained');
  });

  test('memory: over 85% in use', () => {
    const at = (pct) => ({ ...calm(), memory: { totalBytes: 16 * GB, pct, swapUsedBytes: 9.1 * GB } });
    assert.equal(fire('memory', at(85.1)), 'Memory pressure high: 85% in use, swap 9.1 GB.');
    assert.equal(fire('memory', at(85)), null);
    assert.equal(fire('memory', { ...calm(), memory: { totalBytes: 0, pct: null } }), null, 'no reading, no alert');
  });

  test('swap: over a quarter of RAM', () => {
    const at = (bytes) => ({ ...calm(), memory: { totalBytes: 16 * GB, pct: 10, swapUsedBytes: bytes } });
    assert.match(fire('swap', at(4 * GB + 1)), /Swap is heavy: 4\.0 GB used/);
    assert.equal(fire('swap', at(4 * GB)), null);
  });

  test('disk: under 10% free, one line per low volume', () => {
    const at = (...pcts) => ({ ...calm(), disks: pcts.map((p, i) => ({ mount: `/v${i}`, freePct: p, freeBytes: 18 * GB })) });
    assert.equal(fire('disk', at(9.9)), 'Disk under 10% free on /v0: 18.0 GB left.');
    assert.equal(fire('disk', at(10)), null);
    assert.match(fire('disk', at(5, 50, 1)), /\/v0.*\/v2/);
  });

  test('dev servers: two or more days old, counted', () => {
    const day = 86_400;
    const procs = (...ages) => ({ ...calm(), processes: ages.map((ageSec) => ({ kind: 'dev-server', ageSec })).concat([{ kind: 'other', ageSec: 9 * day }]) });
    assert.equal(fire('dev-servers', procs(2 * day - 1)), null);
    assert.equal(fire('dev-servers', procs(2 * day)), '1 dev server has been running 2+ days.');
    assert.equal(fire('dev-servers', procs(3 * day, 5 * day, 1)), '2 dev servers have been running 2+ days.');
  });

  test('a calm machine has no alerts and system alerts become Needs-you rows', () => {
    assert.deepEqual(sys.buildAlerts(calm()), []);
    const items = buildNeedsYou({ status: null, prs: [], tasks: [], settings: { paused: false }, waiting: {}, systemAlerts: [{ id: 'disk', text: 'Disk low.' }] });
    assert.deepEqual(items.map((i) => [i.kind, i.text]), [['system', 'Disk low.']]);
  });
});

/** Fake exec: answers each command from the fixtures and remembers what it was asked. */
function fakeExec({ calls = [], fail = () => false, delay = 0 } = {}) {
  return async (bin, args, opts = {}) => {
    calls.push({ bin, args, timeout: opts.timeout });
    if (delay) await new Promise((r) => setTimeout(r, delay));
    const done = (out) => ({ ok: true, code: 0, out, err: '' });
    if (fail(bin, args)) return { ok: false, code: 2, out: '', err: `${bin}: boom` };
    if (bin === 'vm_stat') return done(fx('darwin-vm_stat.txt'));
    if (bin === 'sysctl') return done(fx('darwin-swapusage.txt'));
    if (bin === 'sw_vers') return done(fx('darwin-sw_vers.txt'));
    if (bin === 'ps') return done(fx(args[1] === 'pid=,args=' ? 'darwin-args.txt' : 'darwin-ps.txt'));
    if (bin === 'lsof') return done(fx(args.includes('-iTCP') ? 'darwin-lsof-listen.txt' : 'darwin-lsof-cwd.txt'));
    if (bin === 'df') return done(fx('darwin-df.txt'));
    if (bin === 'du') return done(args.slice(1).map((p) => `1048576\t${p}`).join('\n'));
    if (bin === 'cat' && args[0] === '/proc/meminfo') return done(fx('linux-meminfo.txt'));
    return { ok: false, code: 127, out: '', err: 'no such command' };
  };
}

function fakeSys() {
  let n = 0;
  return {
    cpus: () => {
      n += 1;
      return Array.from({ length: 12 }, () => ({ model: 'Apple M2 Pro', times: { user: n * 700, nice: 0, sys: n * 100, idle: n * 200, irq: 0 } }));
    },
    totalmem: () => 16 * GB,
    freemem: () => 2 * GB,
    loadavg: () => [3.456, 2, 1],
    uptime: () => 5000,
    userInfo: () => ({ username: 'owner', uid: 501 }),
  };
}

const DISK_TARGETS = [{ label: 'harness', path: '/Volumes/Work/owner/Projects/claude-harness' }, { label: 'projects', path: '/Volumes/Work/owner/Projects' }, { label: '~/.claude', path: '/Volumes/Work/owner/.claude' }];
const envFor = (over = {}) => ({ sessions: () => AGENTS, active: () => true, roots: ROOTS, diskTargets: DISK_TARGETS, folderTargets: [{ label: 'Session transcripts', path: '/Volumes/Work/owner/.claude/projects' }], ...over });

function darwinSampler(execOpts) {
  const calls = [];
  const sampler = sys.createSystemSampler({ exec: fakeExec({ calls, ...execOpts }), platform: 'darwin', sys: fakeSys(), now: () => NOW, selfPid: MC_PID, uid: 501 });
  return { sampler, calls };
}

describe('labels and the darwin sampler', () => {
  async function sampled() {
    const { sampler, calls } = darwinSampler();
    sampler.start(envFor({ active: () => false }));
    await sampler.lightTick();
    await sampler.lightTick();
    await sampler.fullTick();
    await sampler.stop();
    return { snap: sampler.snapshot(), calls, sampler };
  }
  const row = (snap, pid) => snap.processes.find((p) => p.pid === pid);

  test('a session is labelled by pid with its name', async () => {
    const { snap } = await sampled();
    assert.equal(row(snap, 77420).kind, 'session');
    assert.equal(row(snap, 77420).session, 'Harness: System page');
    assert.equal(row(snap, 77420).stoppable, false);
  });

  test('a process under a session is "from" that session and not a session itself', async () => {
    const { snap } = await sampled();
    const sleeper = snap.processes.find((p) => p.pid === 90004) ?? { kind: 'other', session: 'Harness: System page' };
    assert.equal(sleeper.kind, 'other');
    assert.equal(sleeper.session, 'Harness: System page');
    const totals = snap.sessions.find((t) => t.name === 'Harness: System page');
    assert.ok(totals.processes >= 5, 'the session, its test run, mission control, a dev server and the sleeper');
    assert.ok(totals.memBytes > 336000 * 1024);
  });

  test('a listening node is a dev server with its ports, and stoppable only inside project folders', async () => {
    const { snap } = await sampled();
    const alpha = row(snap, 90003);
    assert.deepEqual([alpha.kind, alpha.ports, alpha.project, alpha.stoppable], ['dev-server', [3100], 'alpha', true]);
    assert.equal(alpha.session, 'Harness: System page');
    const site = row(snap, 36101);
    assert.deepEqual([site.kind, site.ports, site.stoppable], ['dev-server', [3123], false], 'its folder is outside every project');
  });

  test('a test run is a gate by its arguments, with no ports', async () => {
    const { snap } = await sampled();
    const gate = row(snap, 90001);
    assert.deepEqual([gate.kind, gate.ports, gate.stoppable, gate.project], ['gate', [], true, 'harness']);
  });

  test('mission control is itself and never stoppable', async () => {
    const { snap } = await sampled();
    assert.deepEqual([row(snap, MC_PID).kind, row(snap, MC_PID).stoppable], ['mission-control', false]);
  });

  test('everything else is other, and system listeners are not dev servers', async () => {
    const { snap } = await sampled();
    const all = snap.processes;
    assert.ok(all.every((p) => p.kind !== 'dev-server' || /node|next-server|Python/.test(p.name)));
    assert.equal(all.find((p) => p.name === 'ControlCenter')?.kind ?? 'other', 'other');
  });

  test('rows: the busiest by cpu and memory, plus every dev server and test run', async () => {
    const { snap } = await sampled();
    assert.ok(snap.processes.length < 62);
    for (const pid of [90001, 90002, 90003, 36101]) assert.ok(row(snap, pid), `pid ${pid} listed`);
    const cpus = snap.processes.map((p) => p.cpuPct);
    assert.deepEqual(cpus, [...cpus].sort((a, b) => b - a));
  });

  test('numbers on this machine\'s fixtures', async () => {
    const { snap } = await sampled();
    assert.equal(snap.platform, 'darwin');
    assert.deepEqual([snap.machine.os, snap.machine.version, snap.machine.cores, snap.machine.cpuModel], ['macOS', '26.2', 12, 'Apple M2 Pro']);
    assert.equal(snap.memory.usedBytes, (455608 + 205670 + 192037) * 16384);
    assert.equal(snap.memory.pct, 81.4);
    assert.equal(snap.memory.swapTotalBytes, 10240 * 1024 * 1024);
    assert.equal(snap.cpu.pct, 80);
    assert.deepEqual(snap.cpu.load, [3.46, 2, 1]);
    assert.equal(snap.disks.length, 1);
    assert.deepEqual(snap.alerts.map((a) => a.id), ['swap', 'dev-servers']);
    assert.deepEqual(snap.suggestions.map((s) => s.id), ['old-dev-servers', 'hot-gates']);
    assert.deepEqual(snap.suggestions[1].pids, [90001], 'the test run at 97% for 7 minutes');
    assert.deepEqual(snap.errors, []);
  });

  test('every command is a fixed-argument execFile with a timeout, and no snapshot carries a command line', async () => {
    const { snap, calls } = await sampled();
    assert.ok(calls.length > 5);
    for (const c of calls) {
      assert.ok(Array.isArray(c.args));
      assert.ok(c.args.every((a) => typeof a === 'string'));
      assert.ok(c.timeout > 0, `${c.bin} has a timeout`);
    }
    const json = JSON.stringify(snap);
    assert.ok(!json.includes('FIXTURE-ARG') && !json.includes('--flag'));
    for (const line of fx('darwin-args.txt').split('\n').filter(Boolean)) {
      assert.ok(!json.includes(line.replace(/^\d+\s+/, '')), `args of pid ${line.split(' ')[0]} stay out of the snapshot`);
    }
  });

  test('a probe still running is not started again', async () => {
    const { sampler, calls } = darwinSampler({ delay: 30 });
    sampler.start(envFor({ active: () => false }));
    await Promise.all([sampler.fullTick(), sampler.fullTick(), sampler.fullTick()]);
    await sampler.stop();
    assert.equal(calls.filter((c) => c.bin === 'ps' && c.args[1] !== 'pid=,args=').length, 1);
  });

  test('a failed command keeps the last good value and shows as a line', async () => {
    let broken = false;
    const { sampler } = darwinSampler({ fail: (bin, args) => broken && bin === 'ps' && args[1] !== 'pid=,args=' });
    sampler.start(envFor({ active: () => false }));
    await sampler.fullTick();
    broken = true;
    await sampler.fullTick();
    await sampler.stop();
    const snap = sampler.snapshot();
    assert.ok(snap.processes.length > 0, 'old rows stay');
    assert.deepEqual(snap.errors, ["Couldn't read processes: ps: boom"]);
  });

  test('a claude process whose prompt runs /until-ready is a session, never a test run, even when no session lists its pid', async () => {
    const base = fakeExec();
    const exec = async (bin, args, o) => {
      const r = await base(bin, args, o);
      if (bin === 'ps' && args[1] === 'pid=,args=') r.out = r.out.replace(/^77420 .*$/m, '77420 /Applications/claude --bg "/until-ready Fix the jest and playwright tests"');
      if (bin === 'lsof' && !args.includes('-iTCP')) r.out += '\np77420\nfcwd\nn/Volumes/Work/owner/Projects/alpha';
      return r;
    };
    const sampler = sys.createSystemSampler({ exec, platform: 'darwin', sys: fakeSys(), now: () => NOW, selfPid: MC_PID, uid: 501 });
    sampler.start(envFor({ active: () => false, sessions: () => [] }));
    await sampler.fullTick();
    await sampler.stop();
    const claude = sampler.snapshot().processes.find((p) => p.pid === 77420);
    assert.deepEqual([claude.kind, claude.stoppable], ['session', false]);
  });

  test('yours means the same numeric uid as mission control, whatever ps would print for the name', async () => {
    const stoppableAs = async (uid) => {
      const sampler = sys.createSystemSampler({ exec: fakeExec(), platform: 'darwin', sys: { ...fakeSys(), userInfo: () => ({ username: 'a-name-longer-than-eight', uid }) }, now: () => NOW, selfPid: MC_PID });
      sampler.start(envFor({ active: () => false }));
      await sampler.fullTick();
      await sampler.stop();
      return sampler.snapshot().processes.find((p) => p.pid === 90003).stoppable;
    };
    assert.equal(await stoppableAs(501), true);
    assert.equal(await stoppableAs(502), false);
  });

  test('start times are taken against the clock after ps returns, so a slow ps never reads as a restart', async () => {
    let clock = NOW;
    const base = fakeExec();
    const exec = async (bin, args, o) => {
      if (bin === 'ps' && args[1] !== 'pid=,args=') clock += 3_000;
      return base(bin, args, o);
    };
    const sampler = sys.createSystemSampler({ exec, platform: 'darwin', sys: fakeSys(), now: () => clock, selfPid: MC_PID, uid: 501 });
    sampler.start(envFor({ active: () => false }));
    const dev = (await sampler.probeNow()).procs.find((p) => p.pid === 90003);
    await sampler.stop();
    assert.equal(dev.startedAt, clock - dev.ageSec * 1000);
  });

  test('nothing is stoppable until the session list has been read', async () => {
    const { sampler } = darwinSampler();
    sampler.start(envFor({ active: () => false, sessions: () => null }));
    await sampler.fullTick();
    await sampler.stop();
    const snap = sampler.snapshot();
    assert.equal(snap.processes.find((p) => p.pid === 90003).kind, 'dev-server');
    assert.deepEqual(snap.processes.filter((p) => p.stoppable), []);
  });

  test('a probe that fails resolves null, though the page keeps the last good rows', async () => {
    let broken = false;
    const { sampler } = darwinSampler({ fail: (bin, args) => broken && bin === 'ps' && args[1] !== 'pid=,args=' });
    sampler.start(envFor({ active: () => false }));
    assert.ok((await sampler.probeNow()).procs.some((p) => p.pid === 90003));
    broken = true;
    assert.equal(await sampler.probeNow(), null);
    await sampler.stop();
    assert.ok(sampler.snapshot().processes.some((p) => p.pid === 90003));
  });

  test('timers are unref\'d and stopped, so a sampler never keeps the process alive', async () => {
    const { sampler } = darwinSampler();
    sampler.start(envFor({ active: () => false }));
    await sampler.stop();
    const before = process.getActiveResourcesInfo().filter((r) => r === 'Timeout').length;
    sampler.start(envFor({ active: () => false }));
    assert.equal(process.getActiveResourcesInfo().filter((r) => r === 'Timeout').length, before, 'a started sampler adds no ref\'d timer');
    await sampler.stop();
  });

  test('a probe in flight when the sampler stops starts nothing after it, folder sizes included', async () => {
    const { sampler, calls } = darwinSampler({ delay: 30 });
    sampler.start(envFor({ active: () => false }));
    const inFlight = sampler.fullTick();
    await sampler.stop();
    await inFlight;
    assert.deepEqual(calls.filter((c) => c.bin === 'du'), []);
    const before = calls.length;
    assert.equal(await sampler.probeNow(), null);
    assert.equal(calls.length, before);
  });

  test('folder sizes arrive in the background', async () => {
    const { sampler } = darwinSampler();
    sampler.start(envFor({ active: () => false }));
    await sampler.fullTick();
    await sampler.stop();
    assert.deepEqual(sampler.snapshot().folders.map((f) => [f.label, f.bytes]), [['Session transcripts', 1048576 * 1024]]);
  });
});

describe('other platforms through the sampler', () => {
  test('linux: meminfo for memory and ps for rows', async () => {
    const calls = [];
    const exec = async (bin, args, o) => {
      calls.push([bin, args]);
      if (bin === 'ps') return { ok: true, code: 0, out: bin && args[0] === '-eo' && args[1] === 'pid=,args=' ? '1000 node --test x' : fx('linux-ps.txt'), err: '' };
      return fakeExec()(bin, args, o);
    };
    const sampler = sys.createSystemSampler({ exec, platform: 'linux', sys: fakeSys(), now: () => NOW, selfPid: 900, uid: 1000 });
    sampler.start(envFor({ active: () => false, diskTargets: [] }));
    await sampler.lightTick();
    await sampler.fullTick();
    await sampler.stop();
    const snap = sampler.snapshot();
    assert.equal(snap.memory.usedBytes, (16384000 - 4096000) * 1024);
    assert.equal(snap.processes.find((p) => p.pid === 1000).kind, 'gate');
    assert.ok(calls.some(([bin, args]) => bin === 'ps' && args[0] === '-eo'));
  });

  test('win32: one powershell call per refresh, memory from the machine, cpu from deltas', async () => {
    const calls = [];
    const exec = async (bin, args, o) => {
      calls.push({ bin, args, timeout: o.timeout });
      return { ok: true, code: 0, out: fx('win32-snapshot.json'), err: '' };
    };
    let now = NOW;
    const winRoots = [{ id: 'alpha', root: 'C:\\Users\\owner\\Projects\\alpha' }, { id: 'alpha', root: 'C:\\Users\\owner\\Projects\\alpha-tasks' }];
    const sampler = sys.createSystemSampler({ exec, platform: 'win32', sys: fakeSys(), now: () => now, selfPid: 7300, uid: null });
    sampler.start(envFor({ active: () => false, roots: winRoots, diskTargets: [{ label: 'harness', path: 'C:\\Users\\owner\\Projects\\claude-harness' }, { label: 'projects', path: 'D:\\Projects' }], sessions: () => [{ pid: 7000, name: 'Win session' }] }));
    await sampler.fullTick();
    now += 10_000;
    await sampler.fullTick();
    await sampler.stop();
    const snap = sampler.snapshot();
    assert.equal(calls.filter((c) => c.bin === 'powershell.exe').length, 2);
    assert.deepEqual(calls[0].args.slice(0, 3), ['-NoProfile', '-NonInteractive', '-Command']);
    assert.ok(calls[0].timeout >= 10_000);
    assert.equal(snap.cpu.load, null);
    assert.equal(snap.machine.os, 'Microsoft Windows 11 Pro');
    assert.deepEqual(snap.disks.map((d) => [d.mount, d.holds]), [['C:', ['harness']], ['D:', ['projects']]]);
    const byPid = (pid) => snap.processes.find((p) => p.pid === pid);
    assert.equal(byPid(7000).kind, 'session');
    assert.deepEqual([byPid(7100).kind, byPid(7100).ports, byPid(7100).session, byPid(7100).stoppable], ['dev-server', [3000], 'Win session', true]);
    assert.deepEqual([byPid(7200).kind, byPid(7200).stoppable], ['gate', true]);
    assert.equal(byPid(7400).stoppable, false, 'its command line names no project folder');
    assert.equal(byPid(7500)?.stoppable ?? false, false, 'another Windows session is not yours');
    assert.ok(!JSON.stringify(snap).includes('FIXTURE-ARG'));
  });

  test('an unknown platform falls back to the linux commands', () => {
    assert.equal(sys.ADAPTERS.linux.machine().args[0], '/etc/os-release');
    assert.deepEqual(Object.keys(sys.ADAPTERS).sort(), ['darwin', 'linux', 'win32']);
  });
});

describe('canStop', () => {
  const base = { pid: 5000, ppid: 4000, uid: 501, name: 'node', kind: 'dev-server', cwd: '/Volumes/Work/owner/Projects/alpha', startedAt: NOW };
  const ctx = { platform: 'darwin', selfPid: MC_PID, ancestors: new Set([77420, 1]), sessionPids: new Set([77420, 6000]), uid: 501, roots: ROOTS, startedAt: NOW };

  test('allowed: a dev server of yours in a project folder, with the start time the client saw', () => {
    assert.deepEqual(sys.canStop(base, ctx), { ok: true });
    assert.deepEqual(sys.canStop({ ...base, kind: 'gate', cwd: '/Volumes/Work/owner/Projects/alpha-tasks/mc-1/sub' }, ctx), { ok: true });
    assert.deepEqual(sys.canStop(base, { ...ctx, startedAt: NOW + 2000 }), { ok: true });
  });

  const refused = [
    ['a session', { pid: 6000 }, {}, 'session'],
    ['anything, before the session list has been read', {}, { sessionPids: null }, 'sessions-unknown'],
    ['a process that is not yours', { uid: 0 }, {}, 'not-owned'],
    ['a folder outside the projects', { cwd: '/Volumes/Work/owner/Desktop/sites/site' }, {}, 'outside'],
    ['no known folder', { cwd: null }, {}, 'outside'],
    ['a system pid', { pid: 1 }, {}, 'system'],
    ['pid 0', { pid: 0 }, {}, 'system'],
    ['mission control', { pid: MC_PID }, {}, 'mission-control'],
    ['an ancestor of mission control', { pid: 1234 }, { ancestors: new Set([1234]) }, 'mission-control'],
    ['a start time that does not match (pid reuse)', {}, { startedAt: NOW + 2001 }, 'restarted'],
    ['no start time', {}, { startedAt: undefined }, 'restarted'],
    ['kind other', { kind: 'other' }, {}, 'kind'],
    ['kind session', { kind: 'session' }, {}, 'kind'],
    ['kind mission-control', { kind: 'mission-control' }, {}, 'kind'],
  ];
  for (const [what, procOver, ctxOver, reason] of refused) {
    test(`refused: ${what}`, () => {
      assert.deepEqual(sys.canStop({ ...base, ...procOver }, { ...ctx, ...ctxOver }), { ok: false, reason });
    });
  }

  test('refused: a process that is gone', () => {
    assert.deepEqual(sys.canStop(undefined, ctx), { ok: false, reason: 'gone' });
  });

  test('windows: same Windows session, a project folder in the command line, and never pid 4', () => {
    const win = { ...base, uid: null, winSession: 1, cmdProject: 'alpha', cwd: null };
    const wctx = { ...ctx, platform: 'win32', ownWinSession: 1, uid: null };
    assert.deepEqual(sys.canStop(win, wctx), { ok: true });
    assert.equal(sys.canStop({ ...win, winSession: 0 }, wctx).reason, 'not-owned');
    assert.equal(sys.canStop({ ...win, cmdProject: null }, wctx).reason, 'outside');
    assert.equal(sys.canStop({ ...win, pid: 4 }, wctx).reason, 'system');
  });

  test('ancestors are everything above mission control', () => {
    const procs = [{ pid: 1, ppid: 0 }, { pid: 10, ppid: 1 }, { pid: 20, ppid: 10 }, { pid: 30, ppid: 20 }, { pid: 99, ppid: 1 }];
    assert.deepEqual([...sys.ancestorsOf(30, procs)].sort((a, b) => a - b), [1, 10, 20]);
  });
});

describe('POST /api/system/stop', () => {
  const tmp = realpathSync(mkdtempSync(join(tmpdir(), 'mc-system-test-')));
  after(() => rmSync(tmp, { recursive: true, force: true }));

  const freePort = () =>
    new Promise((done) => {
      const s = netServer().listen(0, '127.0.0.1', () => {
        const { port } = s.address();
        s.close(() => done(port));
      });
    });
  const call = (port, { method = 'GET', path, headers = {}, body }) =>
    new Promise((done, fail) => {
      const req = request({ host: '127.0.0.1', port, method, path, headers: { Host: `127.0.0.1:${port}`, ...headers } }, (res) => {
        let data = '';
        res.on('data', (c) => (data += c));
        res.on('end', () => done({ status: res.statusCode, json: (() => { try { return JSON.parse(data); } catch { return null; } })() }));
      });
      req.on('error', fail);
      if (body !== undefined) req.write(JSON.stringify(body));
      req.end();
    });

  const proc = (over) => ({ pid: 5000, ppid: 1, uid: 501, name: 'node', kind: 'dev-server', cwd: join(tmp, 'alpha'), startedAt: NOW, cpuPct: 1, memBytes: 1, ageSec: 1, ports: [3000], session: null, sessionPid: null, ...over });

  async function boot({ system } = {}) {
    const alpha = join(tmp, 'alpha');
    mkdirSync(alpha, { recursive: true });
    const registryFile = join(tmp, 'projects.json');
    writeFileSync(registryFile, JSON.stringify({ projects: [{ id: 'alpha', name: 'Alpha', checkouts: [alpha], aliases: [], keywords: [], repos: [], public: { branches: ['main'], remotes: [], notes: [] } }] }));
    const kills = [];
    const state = { procs: [proc(), proc({ pid: 6000, kind: 'session', name: 'claude' }), proc({ pid: 7000, cwd: '/etc' })], probes: 0, started: null, stopped: false };
    const stub = {
      alerts: [{ id: 'disk', text: 'Disk under 10% free on /: 18.0 GB left.' }],
    };
    const fake = {
      snapshot: () => ({ at: 'now', platform: 'darwin', processes: [], alerts: stub.alerts }),
      probeNow: async () => {
        state.probes += 1;
        return { at: NOW, procs: state.procs, ctx: { platform: 'darwin', selfPid: process.pid, ancestors: new Set(), sessionPids: new Set([6000]), uid: 501, roots: [{ id: 'alpha', root: alpha }], ownWinSession: null } };
      },
      wake: () => {},
      start: (env) => (state.started = env),
      stop: async () => (state.stopped = true),
    };
    const port = await freePort();
    const stateDir = join(tmp, `state-${port}`);
    const mc = createMissionControl({
      port, registryFile, stateDir, tokenFile: join(tmp, 'home', '.claude', 'mission-control.token'), projectsDir: join(tmp, 'projects'), claudeBin: null,
      intervals: { sessionsMs: 3_600_000, statusMs: 3_600_000, sweepMs: 3_600_000, usageMs: 3_600_000 },
      system: system ?? fake, kill: (pid, sig) => kills.push([pid, sig]),
    });
    await mc.listen();
    const auth = { Authorization: `Bearer ${mc.token}` };
    const post = (body, headers = {}) => call(port, { method: 'POST', path: '/api/system/stop', body, headers: { ...auth, Origin: `http://127.0.0.1:${port}`, 'Content-Type': 'application/json', ...headers } });
    const log = () => (readFileSyncSafe(join(stateDir, 'actions.log')) ?? '').split('\n').filter(Boolean).map((l) => JSON.parse(l)).filter((l) => l.action === 'system-stop');
    return { mc, port, auth, post, kills, state, log };
  }
  const readFileSyncSafe = (f) => { try { return readFileSync(f, 'utf8'); } catch { return null; } };

  test('the sampler is started with the server, rides the snapshot, and is stopped on close', async () => {
    const { mc, port, auth, state } = await boot();
    try {
      assert.equal(typeof state.started.active, 'function');
      assert.ok(state.started.roots.some((r) => r.id === 'alpha'));
      const snap = (await call(port, { path: '/api/state', headers: auth })).json;
      assert.equal(snap.system.platform, 'darwin');
      assert.deepEqual(snap.needsYou.filter((i) => i.kind === 'system').map((i) => i.text), ['Disk under 10% free on /: 18.0 GB left.']);
    } finally {
      await mc.close();
    }
    assert.equal(state.stopped, true);
  });

  test('without a sampler the snapshot has system: null and the route says so', async () => {
    const port = await freePort();
    const alpha = join(tmp, 'alpha');
    mkdirSync(alpha, { recursive: true });
    const mc = createMissionControl({ port, registryFile: join(tmp, 'projects.json'), stateDir: join(tmp, 'state-none'), tokenFile: join(tmp, 'home2', 'token'), projectsDir: join(tmp, 'projects'), claudeBin: null, intervals: { sessionsMs: 3_600_000, statusMs: 3_600_000, sweepMs: 3_600_000, usageMs: 3_600_000 } });
    await mc.listen();
    try {
      const auth = { Authorization: `Bearer ${mc.token}` };
      assert.equal((await call(port, { path: '/api/state', headers: auth })).json.system, null);
      const r = await call(port, { method: 'POST', path: '/api/system/stop', body: { pid: 5000, startedAt: NOW }, headers: { ...auth, Origin: `http://127.0.0.1:${port}`, 'Content-Type': 'application/json' } });
      assert.equal(r.status, 404);
    } finally {
      await mc.close();
    }
  });

  test('it needs the token, the origin and JSON like every other action', async () => {
    const { mc, port, post, kills } = await boot();
    try {
      assert.equal((await call(port, { method: 'POST', path: '/api/system/stop', body: { pid: 5000, startedAt: NOW }, headers: { Origin: `http://127.0.0.1:${port}`, 'Content-Type': 'application/json' } })).status, 401);
      assert.equal((await post({ pid: 5000, startedAt: NOW }, { Origin: 'http://evil.example' })).status, 403);
      assert.equal((await post({ pid: 5000, startedAt: NOW }, { 'Content-Type': 'text/plain' })).status, 415);
      assert.deepEqual(kills, []);
    } finally {
      await mc.close();
    }
  });

  test('a stoppable dev server gets SIGTERM, and the attempt is logged without arguments', async () => {
    const { mc, post, kills, log, state } = await boot();
    try {
      const r = await post({ pid: 5000, startedAt: NOW });
      assert.equal(r.status, 200);
      assert.deepEqual(kills, [[5000, 'SIGTERM']]);
      assert.equal(state.probes, 1, 'it took a fresh probe');
      const [line] = log();
      assert.deepEqual({ ...line, at: undefined }, { at: undefined, action: 'system-stop', pid: 5000, name: 'node', kind: 'dev-server', project: 'alpha', ok: true, reason: null });
    } finally {
      await mc.close();
    }
  });

  test('refuses what the guard refuses, and logs the refusal', async () => {
    const { mc, post, kills, log } = await boot();
    try {
      const session = await post({ pid: 6000, startedAt: NOW });
      assert.equal(session.status, 409);
      assert.match(session.json.error, /Work page/);
      assert.equal((await post({ pid: 7000, startedAt: NOW })).status, 409, 'outside project folders');
      assert.equal((await post({ pid: 4242, startedAt: NOW })).status, 409, 'not in the fresh list');
      assert.deepEqual(kills, []);
      assert.deepEqual(log().map((l) => [l.pid, l.ok, l.reason]), [[6000, false, 'session'], [7000, false, 'outside'], [4242, false, 'gone']]);
    } finally {
      await mc.close();
    }
  });

  test('decides on a fresh probe, not on what the page was told', async () => {
    const { mc, post, kills, state } = await boot();
    try {
      assert.equal((await post({ pid: 5000, startedAt: NOW + 60_000 })).status, 409, 'pid reuse: start time differs');
      state.procs = [proc({ kind: 'other' })];
      assert.equal((await post({ pid: 5000, startedAt: NOW })).status, 409, 'it stopped being a dev server');
      assert.deepEqual(kills, []);
      assert.equal(state.probes, 2, 'one probe per request');
    } finally {
      await mc.close();
    }
  });

  test('a list of processes is checked on one fresh probe, each one stopped or refused on its own and logged', async () => {
    const { mc, post, kills, log, state } = await boot();
    state.procs = [proc(), proc({ pid: 5001 }), proc({ pid: 7000, cwd: '/etc' })];
    try {
      const both = await post({ processes: [{ pid: 5000, startedAt: NOW }, { pid: 5001, startedAt: NOW }] });
      assert.equal(both.status, 200);
      assert.equal(state.probes, 1, 'one probe for the batch');
      assert.deepEqual(kills, [[5000, 'SIGTERM'], [5001, 'SIGTERM']]);
      const mixed = await post({ processes: [{ pid: 7000, startedAt: NOW }, { pid: 5000, startedAt: NOW }] });
      assert.equal(mixed.status, 200);
      assert.match(mixed.json.message, /node \(7000\): .*project folders/);
      assert.equal(state.probes, 2);
      assert.equal((await post({ processes: [{ pid: 7000, startedAt: NOW }, { pid: 6000, startedAt: NOW }] })).status, 409, 'nothing in the list could be stopped');
      assert.equal((await post({ processes: [] })).status, 400);
      assert.equal((await post({ processes: [{ pid: 5000 }] })).status, 400);
      assert.deepEqual(log().map((l) => [l.pid, l.ok]), [[5000, true], [5001, true], [7000, false], [5000, true], [7000, false], [6000, false]]);
    } finally {
      await mc.close();
    }
  });

  test('a probe that fails is a 503 and stops nothing, though an older reading had the process', async () => {
    let broken = false;
    const { sampler } = darwinSampler({ fail: (bin, args) => broken && bin === 'ps' && args[1] !== 'pid=,args=' });
    const { mc, post, kills } = await boot({ system: sampler });
    try {
      await sampler.fullTick();
      const seen = sampler.snapshot().processes.find((p) => p.pid === 90003);
      assert.ok(seen);
      broken = true;
      assert.equal((await post({ pid: 90003, startedAt: seen.startedAt })).status, 503);
      assert.deepEqual(kills, []);
    } finally {
      await mc.close();
    }
  });

  test('a body without a pid and start time is a 400', async () => {
    const { mc, post, log } = await boot();
    try {
      assert.equal((await post({ pid: '5000', startedAt: NOW })).status, 400);
      assert.equal((await post({ pid: 5000 })).status, 400);
      assert.equal((await post({})).status, 400);
    } finally {
      await mc.close();
    }
    assert.deepEqual(log(), []);
  });
});

describe('claude command lines are sessions, never test runs', () => {
  const launcher = 'node /usr/local/bin/claude --bg "/until-ready Fix the jest suite"';
  const args = [
    `4101 ${launcher}`,
    '4102 /usr/local/bin/node --no-warnings /opt/homebrew/lib/node_modules/@anthropic-ai/claude-code/cli.js -p "run playwright"',
    '4103 node --test test/a.test.mjs',
    '4104 node gate/until-ready.mjs on "tidy the jest suite"',
    '4105 node /usr/local/bin/npx @anthropic-ai/claude-code "/until-ready x"',
    `4106 zsh -c "cd /Volumes/Work/owner/Projects/alpha && claude --bg '/until-ready y'"`,
  ].join('\n');

  test('an npm, npx or shell-wrapped claude whose prompt says /until-ready is not a gate', () => {
    assert.deepEqual([...sys.parseGatePids(args)].sort(), [4103, 4104]);
    assert.deepEqual([...sys.parseClaudePids(args)].sort(), [4101, 4102, 4105, 4106]);
    assert.equal(sys.isClaudeCommand('"C:\\Program Files\\nodejs\\node.exe" "C:\\Program Files\\npm\\node_modules\\@anthropic-ai\\claude-code\\cli.js" --bg "/until-ready x"'), true);
    assert.equal(sys.isClaudeCommand('cmd.exe /d /s /c "claude.cmd --bg /until-ready"'), true);
    assert.equal(sys.isClaudeCommand('node /Volumes/Work/owner/Projects/claude-harness/gate/until-ready.mjs on x'), false, 'a folder named claude-harness is not claude');
  });

  test('so it is labelled a session and offered no Stop, even before claude agents lists it', () => {
    const [row] = sys.labelProcesses([{ pid: 4101, ppid: 1, name: 'node', gate: sys.isGateCommand(launcher), claude: sys.isClaudeCommand(launcher) }], { sessions: [], selfPid: 999 });
    assert.equal(row.kind, 'session');
  });

  test('the desktop app called Claude is not a session', () => {
    const [row] = sys.labelProcesses([{ pid: 4200, ppid: 1, name: 'Claude', gate: false, claude: sys.isClaudeCommand('/Applications/Claude.app/Contents/MacOS/Claude') }], { sessions: [], selfPid: 999 });
    assert.equal(row.kind, 'other');
  });
});
