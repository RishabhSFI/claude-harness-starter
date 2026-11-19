import assert from 'node:assert/strict';
import { spawn, spawnSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { createServer } from 'node:http';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { after, before, describe, test } from 'node:test';
import { fileURLToPath } from 'node:url';
import { scanDir, scanSite, scanText } from '../gate/leak-scan.mjs';

const SCRIPT = join(realpathSync(join(fileURLToPath(import.meta.url), '..', '..')), 'gate', 'leak-scan.mjs');
const rand = (n) => 'aB3xZ9qL'.repeat(Math.ceil(n / 8)).slice(0, n);
const STRIPE = ['sk', 'live', rand(24)].join('_');
const OPENAI = ['sk', 'proj', rand(40)].join('-');
const jwt = (role) => {
  const b = (o) => Buffer.from(JSON.stringify(o)).toString('base64url');
  return `${b({ alg: 'HS256', typ: 'JWT' })}.${b({ role, iss: 'x' })}.${rand(20)}`;
};

let tmp;
let leaky;
let clean;

const serve = (handler) => new Promise((res) => {
  const s = createServer(handler);
  s.listen(0, '127.0.0.1', () => res({ s, url: `http://127.0.0.1:${s.address().port}` }));
});

before(async () => {
  tmp = realpathSync(mkdtempSync(join(tmpdir(), 'leak-scan-')));
  leaky = await serve((req, res) => {
    if (req.url === '/') {
      res.setHeader('content-type', 'text/html');
      return res.end('<html><script src="/app.js"></script></html>');
    }
    if (req.url === '/app.js') {
      res.setHeader('content-type', 'text/javascript');
      return res.end(`const a="${STRIPE}";const b="${OPENAI}";`);
    }
    if (req.url === '/.env') {
      res.setHeader('content-type', 'application/octet-stream');
      return res.end('X=1\n');
    }
    res.statusCode = 404;
    res.end('no');
  });
  clean = await serve((req, res) => {
    res.setHeader('content-type', 'text/html');
    if (req.url === '/') return res.end('<html><script src="/app.js"></script></html>');
    if (req.url === '/app.js') {
      res.setHeader('content-type', 'text/javascript');
      return res.end(`const k="${jwt('anon')}";`);
    }
    res.end('<html>spa fallback</html>');
  });
});

after(() => {
  leaky.s.close();
  clean.s.close();
  rmSync(tmp, { recursive: true, force: true });
});

describe('positive control', () => {
  test('live site: keys in the bundle and an octet-stream /.env are caught, never printed whole', async () => {
    const r = await scanSite(leaky.url);
    const kinds = r.findings.map((f) => f.kind);
    assert.ok(kinds.includes('stripe secret key'));
    assert.ok(kinds.includes('openai key'));
    assert.ok(r.findings.some((f) => f.kind === 'exposed file' && f.where.startsWith('/.env ')));
    assert.ok(!JSON.stringify(r).includes(STRIPE));
    assert.ok(!JSON.stringify(r).includes(OPENAI));
  });

  test('build folder: keys are caught', () => {
    mkdirSync(join(tmp, 'dist', 'assets'), { recursive: true });
    writeFileSync(join(tmp, 'dist', 'assets', 'index.js'), `x="${STRIPE}";y="${OPENAI}"`);
    const kinds = scanDir(join(tmp, 'dist')).findings.map((f) => f.kind);
    assert.ok(kinds.includes('stripe secret key') && kinds.includes('openai key'));
  });

  test('cli exits 1 on findings, prints a masked prefix only, and --json works', () => {
    const j = spawnSync('node', [SCRIPT, '--dir', join(tmp, 'dist'), '--json'], { encoding: 'utf8' });
    assert.equal(j.status, 1);
    assert.ok(!j.stdout.includes(STRIPE));
    assert.equal(JSON.parse(j.stdout).ok, false);
    const t = spawnSync('node', [SCRIPT, '--dir', join(tmp, 'dist')], { encoding: 'utf8' });
    assert.ok(t.stdout.includes(`${STRIPE.slice(0, 8)}...(${STRIPE.length} chars)`));
  });
});

describe('negative control', () => {
  test('an html fallback for /.env and an anon JWT are not flagged', async () => {
    const r = await scanSite(clean.url);
    assert.deepEqual(r.findings, []);
  });

  test('anon jwt is clean, service_role is not', () => {
    assert.deepEqual(scanText(jwt('anon'), 'x'), []);
    assert.equal(scanText(jwt('service_role'), 'x')[0].kind, 'jwt with role service_role');
  });

  test('clean folder exits 0', () => {
    mkdirSync(join(tmp, 'ok'), { recursive: true });
    writeFileSync(join(tmp, 'ok', 'a.js'), 'console.log(1)');
    assert.equal(spawnSync('node', [SCRIPT, '--dir', join(tmp, 'ok')]).status, 0);
  });
});

describe('patterns and chunks', () => {
  test('an anthropic key is one finding, an sb_secret key is caught', () => {
    const ant = ['sk', 'ant', 'api03', rand(40)].join('-');
    assert.deepEqual(scanText(ant, 'x').map((f) => f.kind), ['anthropic key']);
    assert.deepEqual(scanText(['sb', 'secret', rand(30)].join('_'), 'x').map((f) => f.kind), ['sb_secret key']);
  });

  test('a google api key is a note, not a finding', () => {
    const f = scanText(`k="AIza${rand(35)}"`, 'x');
    assert.equal(f.length, 1);
    assert.equal(f[0].note, true);
    const dir = join(tmp, 'g');
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, 'a.js'), `k="AIza${rand(35)}"`);
    const p = spawnSync('node', [SCRIPT, '--dir', dir]);
    assert.equal(p.status, 0);
    assert.ok(p.stdout.toString().includes('note'));
  });

  test('a key in a lazy chunk named inside the main script is found', async () => {
    const lazy = await serve((req, res) => {
      res.setHeader('content-type', req.url === '/' ? 'text/html' : 'text/javascript');
      if (req.url === '/') return res.end('<script src="/assets/index.js"></script>');
      if (req.url === '/assets/index.js') return res.end('import("./Admin-1a2b.js")');
      if (req.url === '/assets/Admin-1a2b.js') return res.end(`k="${STRIPE}"`);
      res.statusCode = 404;
      res.end('no');
    });
    try {
      const r = await scanSite(lazy.url);
      assert.ok(r.findings.some((f) => f.kind === 'stripe secret key' && f.where === 'Admin-1a2b.js'));
    } finally {
      lazy.s.close();
    }
  });
});

describe('could not run', () => {
  test('missing folder and no mode exit 2', () => {
    assert.equal(spawnSync('node', [SCRIPT, '--dir', join(tmp, 'nope')]).status, 2);
    assert.equal(spawnSync('node', [SCRIPT]).status, 2);
  });

  test('--sites reads projects.json, skips retired, exits 1 on a leaky site', async () => {
    const file = join(tmp, 'projects.json');
    writeFileSync(file, JSON.stringify({ projects: [{ id: 'a', site: leaky.url }, { id: 'b', site: clean.url, retired: true }] }));
    const p = await new Promise((res) => {
      const c = spawn('node', [SCRIPT, '--sites', '--projects', file, '--json']);
      let stdout = '';
      c.stdout.on('data', (d) => { stdout += d; });
      c.on('close', (status) => res({ status, stdout }));
    });
    assert.equal(p.status, 1);
    assert.equal(JSON.parse(p.stdout).results.length, 1);
  });
});
