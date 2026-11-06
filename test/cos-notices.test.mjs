import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { homedir, tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { after, before, describe, test } from 'node:test';
import { fileURLToPath } from 'node:url';

const ROOT = realpathSync(join(fileURLToPath(import.meta.url), '..', '..'));
const COS = join(ROOT, 'cos.mjs');
const uptimeMod = await import(join(ROOT, 'uptime.mjs'));
const { uptimeWarning, UPTIME_WARN_DAYS } = uptimeMod;
const sys = await import(join(ROOT, 'mc', 'system.mjs'));
const { buildNeedsYou } = await import(join(ROOT, 'mc', 'snapshot.mjs'));
const DAY = 86_400;

let tmp;
let registry;
before(() => {
  tmp = realpathSync(mkdtempSync(join(tmpdir(), 'cos-notices-')));
  registry = join(tmp, 'projects.json');
  writeFileSync(registry, JSON.stringify({ projects: [{ id: 'a', name: 'Alpha', what: 'x', checkouts: [join(tmp, 'missing')] }] }));
});
after(() => rmSync(tmp, { recursive: true, force: true }));

function cos(args, env = {}) {
  const r = spawnSync('node', [COS, ...args, '--registry', registry], { env: { ...process.env, ...env }, encoding: 'utf8' });
  return { code: r.status, out: r.stdout, err: r.stderr };
}

describe('uptime warning', () => {
  test('is null under 40 days and a restart sentence from 40 days on', () => {
    assert.equal(UPTIME_WARN_DAYS, 40);
    assert.equal(uptimeWarning(40 * DAY - 1), null);
    assert.equal(uptimeWarning(null), null);
    assert.equal(
      uptimeWarning(46 * DAY + 5),
      'The Mac has been up 46 days. Restart it soon: past about 49.7 days macOS stops freeing network connections and nothing can reach GitHub.',
    );
  });

  test('status puts it first under Needs you, and --json carries machine', () => {
    const env = { COS_UPTIME_SEC: String(46 * DAY), COS_SCHEDULED_DIR: join(tmp, 'none') };
    const lines = cos(['status', '--no-gh'], env).out.split('\n');
    assert.equal(lines[0], '# Needs you');
    assert.match(lines[2], /^- The Mac has been up 46 days\. Restart it soon/);
    const json = JSON.parse(cos(['status', '--no-gh', '--json'], env).out);
    assert.equal(json.machine.uptimeDays, 46);
    assert.match(json.machine.warning, /Restart it soon/);
    const calm = JSON.parse(cos(['status', '--no-gh', '--json'], { ...env, COS_UPTIME_SEC: String(2 * DAY) }).out);
    assert.deepEqual(calm.machine, { uptimeDays: 2, warning: null });
  });

  test('only macOS gets the warning; a fake uptime counts as macOS', () => {
    const { uptimeWarningOn } = uptimeMod;
    assert.match(uptimeWarningOn('darwin', 50 * DAY), /Restart it soon/);
    assert.equal(uptimeWarningOn('linux', 50 * DAY), null);
    assert.equal(uptimeWarningOn('win32', 50 * DAY), null);
    assert.equal(sys.ALERTS.find((a) => a.id === 'uptime').check({ platform: 'win32', machine: { uptimeSec: 50 * DAY } }), null);
  });

  test('mission control raises it as a system alert in the Needs you lane', () => {
    const alert = sys.ALERTS.find((a) => a.id === 'uptime');
    assert.equal(alert.check({ machine: { uptimeSec: 39 * DAY } }), null);
    const text = alert.check({ machine: { uptimeSec: 41 * DAY } });
    assert.match(text, /^The Mac has been up 41 days\./);
    const rows = buildNeedsYou({ status: null, prs: [], tasks: [], settings: { paused: false }, waiting: {}, systemAlerts: [{ id: 'uptime', text }] });
    assert.deepEqual(rows.map((r) => [r.kind, r.text]), [['system', text]]);
  });
});

describe('scheduled task drift', () => {
  function install(dir, name, body) {
    mkdirSync(join(dir, name), { recursive: true });
    writeFileSync(join(dir, name, 'SKILL.md'), `---\nname: ${name}\ndescription: x\n---\n\n${body}`);
  }
  const repoPrompt = (file) => {
    const text = readFileSync(join(ROOT, 'scheduled', file), 'utf8');
    return text.slice(text.indexOf('\n---\n') + 5).trim();
  };

  test('an installed prompt matching the repo copy (home dir mapped to ~) is quiet', () => {
    const dir = join(tmp, 'same');
    install(dir, 'daily-harness-review', repoPrompt('daily-review.md').replaceAll('~/', `${homedir()}/`));
    assert.doesNotMatch(cos(['status', '--no-gh'], { COS_SCHEDULED_DIR: dir, COS_UPTIME_SEC: '100' }).out, /Scheduled task/);
  });

  test('a changed prompt adds one Needs-you line; a missing folder adds none', () => {
    const dir = join(tmp, 'older');
    install(dir, 'cos-morning-brief', 'An older brief prompt.');
    const out = cos(['status', '--no-gh'], { COS_SCHEDULED_DIR: dir, COS_UPTIME_SEC: '100' }).out;
    const hits = out.split('\n').filter((l) => l.includes('Scheduled task'));
    assert.deepEqual(hits, ['- Scheduled task cos-morning-brief differs from scheduled/morning-brief.md; paste the new prompt in its settings (or have the hub update it).']);
    const json = JSON.parse(cos(['status', '--no-gh', '--json'], { COS_SCHEDULED_DIR: dir }).out);
    assert.deepEqual(json.scheduledDrift.map((d) => d.task), ['cos-morning-brief']);
  });
});

describe('cos learned', () => {
  test('the fallback ignores cos-* names that are not dated briefs', () => {
    const h = mkdtempSync(join(tmp, 'rep-'));
    mkdirSync(join(h, 'reports'));
    writeFileSync(join(h, 'reports', 'cos-notes.md'), '## What the last hub learned\n\n- stray\n');
    assert.equal(cos(['learned', '--harness', h]).out, '');
  });

  function reports(files) {
    const harness = mkdtempSync(join(tmp, 'h-'));
    for (const [name, text] of Object.entries(files)) {
      mkdirSync(dirname(join(harness, 'reports', name)), { recursive: true });
      writeFileSync(join(harness, 'reports', name), text);
    }
    return harness;
  }
  const learned = (harness) => cos(['learned', '--harness', harness]);

  test('prints the section from the newest handoff, up to the next heading', () => {
    const h = reports({
      'cos-handoff-2026-11-05.md': '## What the last hub learned\n\n- old\n',
      'cos-handoff-2026-11-06.md': '# Handoff\n\n## In flight\n\n- x\n\n## What the last hub learned (keep doing this)\n\n- new one\n- new two\n\n## Later\n\n- no\n',
    });
    const r = learned(h);
    assert.equal(r.code, 0);
    assert.equal(r.out, '## What the last hub learned (keep doing this)\n\n- new one\n- new two\n');
  });

  test('falls back to the newest other cos report that has the heading', () => {
    const h = reports({ 'cos-2026-11-04.md': '## What the last hub learned\n\n- from a brief\n', 'cos-2026-11-03.md': '# nothing\n', '2026-11-05.md': '## What the last hub learned\n\n- not a cos report\n' });
    assert.match(learned(h).out, /from a brief/);
  });

  test('prints nothing and exits 0 when no report has it', () => {
    const r = learned(reports({ 'cos-2026-11-04.md': '# Brief\n' }));
    assert.equal(r.code, 0);
    assert.equal(r.out, '');
    assert.equal(learned(mkdtempSync(join(tmp, 'empty-'))).out, '');
  });
});
