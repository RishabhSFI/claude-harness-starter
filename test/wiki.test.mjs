import assert from 'node:assert/strict';
import { execFileSync, spawnSync } from 'node:child_process';
import { cpSync, existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, readlinkSync, realpathSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { before, describe, test } from 'node:test';
import { fileURLToPath } from 'node:url';

const ROOT = realpathSync(join(fileURLToPath(import.meta.url), '..', '..'));
const WIKI = join(ROOT, 'wiki.mjs');
const { redact, linksIn } = await import(WIKI);
const j = (...parts) => parts.join('');
const STARTER = join(ROOT, 'starter-wiki');
const MAIN = realpathSync(
  join(execFileSync('git', ['rev-parse', '--path-format=absolute', '--git-common-dir'], { cwd: ROOT }).toString().trim(), '..'),
);
const GIT_ENV = {
  ...process.env,
  GIT_AUTHOR_NAME: 't',
  GIT_AUTHOR_EMAIL: 't@example.com',
  GIT_COMMITTER_NAME: 't',
  GIT_COMMITTER_EMAIL: 't@example.com',
  GIT_CONFIG_GLOBAL: '/dev/null',
  GIT_CONFIG_SYSTEM: '/dev/null',
};

let tmp;
before(() => {
  tmp = realpathSync(mkdtempSync(join(tmpdir(), 'wiki-test-')));
});

function wiki(dir, registry, ...args) {
  const r = spawnSync('node', [WIKI, ...args, '--wiki', dir, '--registry', registry], { encoding: 'utf8', env: GIT_ENV });
  return { code: r.status, out: r.stdout, err: r.stderr };
}

function write(dir, files) {
  for (const [rel, text] of Object.entries(files)) {
    mkdirSync(join(dir, rel, '..'), { recursive: true });
    writeFileSync(join(dir, rel), text);
  }
}

const page = (updated, body, sources = ['[[raw/2026-01-02-notes]]']) =>
  `---\nupdated: ${updated}\nsources:\n${sources.map((s) => `  - "${s}"`).join('\n')}\ntags: [project]\n---\n\n${body}\n`;

const RAW = '---\ntitle: "Notes"\ndate: 2026-01-02\norigin: "made up"\n---\n\nThe acme thing uses `[[ ]]` placeholders and [[Brand]] text.\n';

/** A clean made-up wiki: one project (alpha, no checkout), one person, one raw source. */
function makeWiki(name, extra = {}, projects = [{ id: 'alpha', checkouts: [] }]) {
  const dir = join(tmp, name);
  write(dir, {
    'WIKI.md': '# Schema\n',
    'index.md': '# Index\n\n- [[projects/alpha]]\n- [[people/pat]]\n',
    'log.md': '# Log\n\n## [2026-01-02] ingest | Notes\n',
    'projects/alpha.md': page('2026-01-02', '# Alpha\n\nBuilt for [[people/pat]]. Literal `[[ ]]` stays code.'),
    'people/pat.md': page('2026-01-02', '# Pat\n\nUses [[alpha]].'),
    'raw/2026-01-02-notes.md': RAW,
    ...extra,
  });
  const registry = join(tmp, `${name}.json`);
  writeFileSync(registry, JSON.stringify({ projects }));
  return { dir, registry };
}

describe('wiki lint', () => {
  test('a clean wiki passes, and code spans and raw sources are not link-checked', () => {
    const { dir, registry } = makeWiki('clean');
    const r = wiki(dir, registry, 'lint');
    assert.equal(r.code, 0, r.out);
    assert.match(r.out, /clean/);
  });

  test('a broken link fails', () => {
    const { dir, registry } = makeWiki('broken', {
      'people/pat.md': page('2026-01-02', '# Pat\n\nUses [[alpha]] and [[vendors/nowhere|Nowhere]].'),
    });
    const r = wiki(dir, registry, 'lint');
    assert.equal(r.code, 1);
    assert.match(r.out, /error\s+broken-link\s+people\/pat\.md: \[\[vendors\/nowhere\]\]/);
  });

  test('a project with no page fails', () => {
    const { dir, registry } = makeWiki('nopage', {}, [{ id: 'alpha', checkouts: [] }, { id: 'beta', checkouts: [] }]);
    const r = wiki(dir, registry, 'lint');
    assert.equal(r.code, 1);
    assert.match(r.out, /missing-project-page\s+projects\/beta\.md/);
  });

  test('orphans, pages missing from the index, bad frontmatter and bad log lines only warn', () => {
    const { dir, registry } = makeWiki('warns', {
      'topics/lonely.md': '# Lonely\n\nNo frontmatter, nobody links here.\n',
      'raw/2026-01-03-unread.md': '---\ntitle: "Unread"\n---\nNo date or origin.\n',
      'log.md': '# Log\n\n## [2026-01-02] ingest | Notes\n## Tuesday stuff\n',
    });
    const r = wiki(dir, registry, 'lint');
    assert.equal(r.code, 0, r.out);
    assert.match(r.out, /warn\s+frontmatter\s+topics\/lonely\.md: frontmatter needs updated/);
    assert.match(r.out, /warn\s+not-in-index\s+topics\/lonely\.md/);
    assert.match(r.out, /warn\s+orphan\s+topics\/lonely\.md/);
    assert.match(r.out, /warn\s+orphan\s+raw\/2026-01-03-unread\.md: raw source no page cites/);
    assert.match(r.out, /warn\s+raw-header\s+raw\/2026-01-03-unread\.md: raw source header needs origin, date/);
    assert.match(r.out, /warn\s+log-format\s+log\.md: line 4/);
    assert.doesNotMatch(r.out, /projects\/alpha\.md/);
  });

  test('a project page more than 14 days older than its last commit is stale', () => {
    const repo = join(tmp, 'repo');
    mkdirSync(repo);
    const git = (...args) => execFileSync('git', args, { cwd: repo, env: { ...GIT_ENV, GIT_COMMITTER_DATE: '2026-03-01T12:00:00' }, stdio: 'pipe' });
    git('init', '-b', 'main');
    writeFileSync(join(repo, 'a.txt'), 'a');
    git('add', '-A');
    git('commit', '-m', 'init');

    const stale = makeWiki('stale', { 'projects/alpha.md': page('2026-02-01', '# Alpha\n\nFor [[people/pat]].') }, [{ id: 'alpha', checkouts: [repo] }]);
    const r = wiki(stale.dir, stale.registry, 'lint');
    assert.equal(r.code, 0);
    assert.match(r.out, /warn\s+stale\s+projects\/alpha\.md: updated 2026-02-01, but the project's last commit is 2026-03-01 \(28 days later\)/);

    const fresh = makeWiki('fresh', { 'projects/alpha.md': page('2026-02-20', '# Alpha\n\nFor [[people/pat]].') }, [{ id: 'alpha', checkouts: [repo] }]);
    assert.doesNotMatch(wiki(fresh.dir, fresh.registry, 'lint').out, /stale/);
  });

  test('links skip every kind of code, and an escaped table pipe still finds the page', () => {
    const text = [
      'See [[people/pat\\|Pat]] and [[alpha|Alpha]].',
      '````md', '```', '[[in-a-long-fence]]', '```', '````',
      '  ~~~', '  [[in-an-indented-fence]]', '  ~~~',
      'A ``span with ` and [[in-a-double-span]]`` here.',
    ].join('\n');
    assert.deepEqual(linksIn(text), ['people/pat', 'alpha']);
  });

  test('a page linked only from log.md is still an orphan', () => {
    const { dir, registry } = makeWiki('logonly', {
      'topics/lonely.md': page('2026-01-02', '# Lonely\n\nAbout [[alpha]].'),
      'index.md': '# Index\n\n- [[projects/alpha]]\n- [[people/pat]]\n- [[topics/lonely]]\n',
      'log.md': '# Log\n\n## [2026-01-02] ingest | Notes\n\nMade [[topics/lonely]].\n',
    });
    assert.match(wiki(dir, registry, 'lint').out, /warn\s+orphan\s+topics\/lonely\.md/);
  });

  test('a missing project list is an error, not an empty one', () => {
    const { dir } = makeWiki('noreg');
    const r = wiki(dir, join(tmp, 'nope.json'), 'lint');
    assert.equal(r.code, 2);
    assert.match(r.err, /no project list/);
  });
});

describe('wiki ingest', () => {
  test('copies a source into raw/ with a header, blanks private details, and logs it', () => {
    const { dir, registry } = makeWiki('ingest');
    const src = join(tmp, 'call notes.md');
    writeFileSync(src, `# Call notes\n\nMail sam@example.com or call ${j('416-555', '-0199')}.\nKey sk-abcdefghijklmnopqrstuvwxyz123.\nDEMO_PASSWORD ("hunter22") is in the seed.\n`);
    const r = wiki(dir, registry, 'ingest', src, '--origin', 'phone call', '--date', '2026-01-05');
    assert.equal(r.code, 0, r.err);
    const dest = join(dir, 'raw', '2026-01-05-call-notes.md');
    assert.equal(r.out.trim(), dest);
    const text = readFileSync(dest, 'utf8');
    assert.match(text, /^---\ntitle: "Call notes"\ndate: 2026-01-05\norigin: "phone call"\n/);
    for (const leak of ['sam@example.com', j('416-555', '-0199'), 'sk-abc', 'hunter22']) assert.ok(!text.includes(leak), leak);
    assert.match(text, /\[email\].*\[phone\]/);
    assert.match(readFileSync(join(dir, 'log.md'), 'utf8'), /\n## \[\d{4}-\d{2}-\d{2}\] ingest \| Call notes\n\nRaw source \[\[raw\/2026-01-05-call-notes\]\], from phone call\.\n$/);
  });

  test('ingesting the same source twice changes nothing; a different one under the same name is refused', () => {
    const { dir, registry } = makeWiki('reingest');
    const src = join(tmp, 'memo.md');
    writeFileSync(src, 'first\n');
    const args = ['ingest', src, '--title', 'Memo', '--origin', 'x', '--date', '2026-01-06'];
    assert.equal(wiki(dir, registry, ...args).code, 0);
    const log = readFileSync(join(dir, 'log.md'), 'utf8');
    const again = wiki(dir, registry, ...args);
    assert.equal(again.code, 0);
    assert.match(again.out, /already ingested/);
    assert.equal(readFileSync(join(dir, 'log.md'), 'utf8'), log);

    writeFileSync(src, 'second\n');
    const changed = wiki(dir, registry, ...args);
    assert.equal(changed.code, 1);
    assert.match(changed.err, /already exists/);
    assert.match(readFileSync(join(dir, 'raw', '2026-01-06-memo.md'), 'utf8'), /first/);
  });

  test('the same source ingested on another day changes nothing', () => {
    const { dir, registry } = makeWiki('nextday');
    const src = join(tmp, 'daily.md');
    writeFileSync(src, '# Daily\n\nSame text.\n');
    assert.equal(wiki(dir, registry, 'ingest', src, '--origin', 'x', '--date', '2026-01-08').code, 0);
    const log = readFileSync(join(dir, 'log.md'), 'utf8');
    const again = wiki(dir, registry, 'ingest', src, '--origin', 'x', '--date', '2026-01-09');
    assert.equal(again.code, 0, again.err);
    assert.match(again.out, /already ingested: .*2026-01-08-daily\.md/);
    assert.equal(existsSync(join(dir, 'raw', '2026-01-09-daily.md')), false);
    assert.equal(readFileSync(join(dir, 'log.md'), 'utf8'), log);
  });

  test('title and origin are redacted and kept to one line', () => {
    const { dir, registry } = makeWiki('oneline');
    const src = join(tmp, 'x.md');
    writeFileSync(src, 'body\n');
    const r = wiki(dir, registry, 'ingest', src, '--title', 'Call\n## [2026-01-01] fake | entry', '--origin', 'mail from sam@example.com\r\x07', '--date', '2026-01-10');
    assert.equal(r.code, 0, r.err);
    const log = readFileSync(join(dir, 'log.md'), 'utf8');
    assert.doesNotMatch(log, /^## \[2026-01-01\]/m);
    assert.ok(!log.includes('sam@example.com'));
    assert.ok(!/[\x00-\x08\x0b-\x1f\x7f]/.test(log), 'control characters in log.md');
    const raw = readdirSync(join(dir, 'raw')).find((f) => f.startsWith('2026-01-10-'));
    assert.match(readFileSync(join(dir, 'raw', raw), 'utf8'), /^title: "Call ## \[2026-01-01\] fake \| entry"\norigin: |\norigin: "mail from \[email\]"\n/);
  });

  test('ingest refuses when the wiki folder does not exist', () => {
    const src = join(tmp, 'y.md');
    writeFileSync(src, 'body\n');
    const missing = join(tmp, 'no-wiki-here');
    const r = wiki(missing, join(tmp, 'nope.json'), 'ingest', src);
    assert.equal(r.code, 2);
    assert.match(r.err, /no wiki at/);
    assert.equal(existsSync(missing), false);
  });

  test('an ingested source with a page citing it lints clean', () => {
    const { dir, registry } = makeWiki('cited');
    const src = join(tmp, 'brief.md');
    writeFileSync(src, '# Brief\n\nPlain text.\n');
    wiki(dir, registry, 'ingest', src, '--origin', 'x', '--date', '2026-01-07');
    write(dir, { 'people/pat.md': page('2026-01-07', '# Pat\n\nUses [[alpha]].', ['[[raw/2026-01-07-brief]]']) });
    const r = wiki(dir, registry, 'lint');
    assert.equal(r.code, 0, r.out);
    assert.match(r.out, /clean/);
  });
});

describe('redact', () => {
  test('hides whole key blocks, auth headers, cookies and more token shapes', () => {
    const k = ['-----BEGIN ', 'RSA PRIVATE KEY-----\nMIIEowIBAAKCAQEAabc\nqrsTUV==\n-----END RSA PRIVATE KEY-----'].join('');
    assert.equal(redact(`key:\n${k}\nafter`), 'key:\n[secret]\nafter');
    assert.equal(redact('Authorization: Bearer abc.def-123'), 'Authorization: Bearer [secret]');
    assert.equal(redact('Cookie: session=abc; theme=dark'), 'Cookie: [secret]');
    for (const p of ['sbp_', 'whsec_', 'glpat-', 'hf_']) assert.equal(redact(`x ${p}${'AbCdEf1234'.repeat(4)} y`), 'x [secret] y', p);
    assert.equal(redact('my sbp_config_file and the hf_model loader'), 'my sbp_config_file and the hf_model loader');
    assert.equal(redact('SECRET_KEY_BASE=abc123def'), 'SECRET_KEY_BASE=[secret]');
    assert.equal(redact('monkey business and turkey dinner'), 'monkey business and turkey dinner');
    for (const prose of ['token_budget: 500', 'pass_rate: 98%', 'key_points: three of them', 'max_token_count: 4096', 'secret_sauce: butter',
      'keyboard_shortcut: ctrl-k', 'See the Cookie: banner section.', 'Authorization: required on all routes']) assert.equal(redact(prose), prose, prose);
    assert.equal(redact('Mention -----BEGIN PRIVATE KEY----- in prose\n\n# Rest of doc'), '[secret]\n\n# Rest of doc'.replace('[secret]', 'Mention [secret]'));
    assert.equal(redact('DB_PASSWORD=hunter22 and api.secret: abc'), 'DB_PASSWORD=[secret] and api.secret: [secret]');
    assert.equal(redact('see https://a.com/cb?token=abc123&x=1 and https://b.io/?api_key=zz9'), 'see https://a.com/cb?token=[secret]&x=1 and https://b.io/?api_key=[secret]');
  });

  test('stays fast on long runs of identifiers', () => {
    for (const s of ['key.a.'.repeat(4000), 'user_api_key_token_id_pass_'.repeat(800), 'a_'.repeat(20000)]) {
      const t0 = performance.now();
      redact(s);
      assert.ok(performance.now() - t0 < 1000, `slow on ${s.slice(0, 20)}... (${s.length} chars)`);
    }
  });
  const blanked = (input, gone) => {
    const out = redact(input);
    assert.ok(!out.includes(gone), `${gone} survived in: ${out}`);
    return out;
  };

  test('blanks NAME_KEY / TOKEN / SECRET / PASSWORD / PASS values, quoted or not', () => {
    blanked('GMAIL_APP_PASSWORD="abcd efgh ijkl mnop"', 'efgh');
    blanked("GMAIL_APP_PASSWORD='abcd efgh ijkl mnop'", 'efgh');
    blanked('GMAIL_APP_PASSWORD=abcd efgh ijkl mnop', 'efgh');
    blanked('smtp_pass: hunter2xyz', 'hunter2xyz');
    blanked('API_KEY = plainvalue123', 'plainvalue123');
    blanked('Password: correcthorse', 'correcthorse');
    blanked('  auth_token: "tok en with spaces"', 'tok en');
    assert.equal(redact('DB_SECRET=s3cr3t # note'), 'DB_SECRET=[secret] # note');
    blanked('- **Password:** correcthorse', 'correcthorse');
    blanked('{"password": "correcthorse"}', 'correcthorse');
    blanked('https://api.example.com/v1?user=1&token=abc123def&x=2', 'abc123def');
    for (const prose of ['Key decisions: ship Friday.', 'Customer-generated token: no approval needed.', 'The secret: ship small.']) {
      assert.equal(redact(prose), prose);
    }
  });

  test('blanks known key prefixes and JWTs', () => {
    for (const key of [
      j('sk_live_', '4eC39HqLyjWDarjtT1zdp7dc'), j('sk_test_', '4eC39HqLyjWDarjtT1zdp7dc'), j('rk_live_', '51Habc123def456ghi'),
      j('AKIA', 'IOSFODNN7EXAMPLE'), j('xoxb-', '1234567890-abcdefghij'), j('github_pat_', '11ABCDEFG0123456789_abcdefghijklmnop'),
      j('ghp_', 'abcdefghijklmnopqrstuvwxyz0123'), j('sb_secret_', 'abcdEFGH1234ijkl'), j('npg_', 'aB3dE5gH7jK9'),
      j('AIza', 'SyA-abcdefghijklmnopqrstuvwxyz012'), j('eyJhbGciOiJIUzI1NiJ9.eyJzdWIi', 'OiIxMjM0NTY3ODkwIn0.dozjgNryP4J3jVmNHl0w5N_XgL0n3I9PlFUP0THsR8U'),
    ]) blanked(`use ${key} here`, key.slice(-8));
  });

  test('blanks the whole credential in scheme://user:pass@host', () => {
    const out = blanked(j('DATABASE_URL is postgres://admin:pa55word', '@db.internal:5432/app'), 'pa55word');
    assert.ok(!out.includes('admin'), out);
    assert.match(out, /postgres:\/\/\[secret\]@db\.internal:5432\/app/);
    assert.equal(redact('clone https://github.com/acme/tool'), 'clone https://github.com/acme/tool');
  });

  test('blanks phone numbers but not dates, years or ids', () => {
    for (const phone of [j('41655', '50199'), j('(416)', '555-0199'), j('(416) ', '555-0199'), j('416.555', '.0199'), j('+44 20 ', '7946 0958'), j('+1 416 ', '555 0199')]) {
      assert.match(redact(`call ${phone} today`), /^call \[phone\] today$/, phone);
    }
    for (const fine of ['on 2026-11-04', '183046 rows', 'in 2026', 'order #12345678901234', 'version 1.2.3', '10:30-11:45']) {
      assert.equal(redact(fine), fine);
    }
  });
});

describe('wiki page and search', () => {
  test('page prints the project page path, or fails when there is none', () => {
    const { dir, registry } = makeWiki('page');
    const r = wiki(dir, registry, 'page', 'alpha');
    assert.equal(r.code, 0);
    assert.equal(r.out.trim(), join(dir, 'projects', 'alpha.md'));
    const missing = wiki(dir, registry, 'page', 'beta');
    assert.equal(missing.code, 1);
    assert.match(missing.err, /projects\/beta\.md/);
  });

  test('page refuses an id that is not a slug', () => {
    const { dir, registry } = makeWiki('pageid');
    for (const id of ['../people/pat', 'Alpha', 'a b']) {
      const r = wiki(dir, registry, 'page', id);
      assert.equal(r.code, 2, id);
      assert.match(r.err, /project id/);
    }
  });

  test('new-page writes a project page from the template, lists and logs it, and lints without errors', () => {
    const dir = join(tmp, 'newpage');
    cpSync(STARTER, dir, { recursive: true });
    const registry = join(tmp, 'newpage.json');
    writeFileSync(registry, JSON.stringify({ projects: [{ id: 'my-app', name: 'My App', what: 'A tiny app.', checkouts: [] }] }));
    assert.equal(wiki(dir, registry, 'lint').code, 1);
    const r = wiki(dir, registry, 'new-page', 'my-app');
    assert.equal(r.code, 0, r.err);
    const file = join(dir, 'projects', 'my-app.md');
    assert.equal(r.out.trim(), file);
    const text = readFileSync(file, 'utf8');
    assert.match(text, /^---\nupdated: \d{4}-\d{2}-\d{2}\n/);
    assert.match(text, /\n# My App\n\n## What it is\n\nA tiny app\.\n/);
    assert.doesNotMatch(text, /YYYY|Project name/);
    assert.match(readFileSync(join(dir, 'index.md'), 'utf8'), /## Projects\n\n- \[\[projects\/my-app\]\]: A tiny app\n\n## People/);
    assert.match(readFileSync(join(dir, 'log.md'), 'utf8'), /## \[\d{4}-\d{2}-\d{2}\] create \| my-app: new project page\n/);
    const lint = wiki(dir, registry, 'lint');
    assert.equal(lint.code, 0, lint.out);
    assert.doesNotMatch(lint.out, /frontmatter|broken|not-in-index|missing-project-page/);

    const index = readFileSync(join(dir, 'index.md'), 'utf8');
    const again = wiki(dir, registry, 'new-page', 'my-app');
    assert.equal(again.code, 0);
    assert.match(again.out, /already/);
    assert.equal(readFileSync(join(dir, 'index.md'), 'utf8'), index);
    assert.equal(readFileSync(file, 'utf8'), text);
  });

  test('new-page refuses an id not in the project list', () => {
    const { dir, registry } = makeWiki('newpage-unknown');
    const r = wiki(dir, registry, 'new-page', 'ghost');
    assert.equal(r.code, 2);
    assert.match(r.err, /not in/);
  });

  test('search ranks pages matching more words, then more hits', () => {
    const { dir, registry } = makeWiki('search', {
      'topics/rates.md': page('2026-01-02', '# Rates\n\nLane rates. Rates rates rates.'),
      'topics/lanes.md': page('2026-01-02', '# Lanes\n\nLane rates from history.'),
    });
    const r = wiki(dir, registry, 'search', 'lane', 'history');
    assert.equal(r.code, 0);
    const files = r.out.split('\n').filter((l) => l && !l.startsWith(' ')).map((l) => l.split(/\s/)[0]);
    assert.deepEqual(files.slice(0, 2), ['topics/lanes.md', 'topics/rates.md']);
    assert.match(r.out, /\n {4}Lane rates from history\./);
    assert.match(wiki(dir, registry, 'search', 'zzzz').out, /no matches/);
  });
});

describe('starter-wiki', () => {
  const emptyRegistry = () => {
    const f = join(tmp, 'empty.json');
    writeFileSync(f, JSON.stringify({ projects: [] }));
    return f;
  };

  test('lints clean on an empty project list', () => {
    const r = wiki(STARTER, emptyRegistry(), 'lint');
    assert.equal(r.code, 0, r.out);
    assert.match(r.out, /clean/);
  });

  test('a page written from the template lints clean', () => {
    const dir = join(tmp, 'from-template');
    cpSync(STARTER, dir, { recursive: true });
    const tpl = readFileSync(join(dir, 'projects', '_template.md'), 'utf8');
    write(dir, {
      'projects/demo.md': tpl.replaceAll('YYYY-MM-DD-source-name', '2026-01-02-notes').replaceAll('YYYY-MM-DD', '2026-01-02'),
      'raw/2026-01-02-notes.md': RAW,
      'index.md': readFileSync(join(dir, 'index.md'), 'utf8').replace('## Projects\n', '## Projects\n\n- [[projects/demo]]\n'),
    });
    const registry = join(tmp, 'demo.json');
    writeFileSync(registry, JSON.stringify({ projects: [{ id: 'demo', checkouts: [] }] }));
    const r = wiki(dir, registry, 'lint');
    assert.equal(r.code, 0, r.out);
    assert.match(r.out, /orphan\s+projects\/demo\.md/);
    assert.doesNotMatch(r.out, /frontmatter|broken|not-in-index/);
  });

  test('ships the same schema as the personal wiki', () => {
    const personal = join(ROOT, 'wiki', 'WIKI.md');
    if (!existsSync(personal)) return;
    assert.equal(readFileSync(join(STARTER, 'WIKI.md'), 'utf8'), readFileSync(personal, 'utf8'));
  });
});

const SHIPS = ['starter-wiki', 'skills/wiki/SKILL.md', 'wiki.mjs', 'test/wiki.test.mjs'];

/** Names that only the owner's own setup knows: project ids, names, aliases and keywords, people pages, the GitHub owner. */
function privateNames() {
  const names = new Set();
  const registry = join(ROOT, 'projects.json');
  if (existsSync(registry)) {
    for (const p of JSON.parse(readFileSync(registry, 'utf8')).projects) {
      for (const w of [p.id, p.name, ...(p.aliases ?? []), ...(p.keywords ?? [])]) names.add(w);
      for (const r of p.repos ?? []) for (const part of r.split('/')) names.add(part);
      if (p.site) names.add(new URL(p.site).hostname);
    }
  }
  const people = join(ROOT, 'wiki', 'people');
  if (existsSync(people)) for (const f of readdirSync(people)) names.add(f.replace(/\.md$/, ''));
  const cos = join(ROOT, 'cos.mjs');
  const owner = existsSync(cos) ? readFileSync(cos, 'utf8').match(/DEFAULT_OWNER = '([^']+)'/)?.[1] : null;
  if (owner) names.add(owner);
  return [...names].filter((w) => w && w.length > 2 && !w.startsWith('_'));
}

const LEAKS = [
  ['email', /[A-Za-z0-9._%+-]+@(?!example\.com\b)[A-Za-z0-9.-]+\.[A-Za-z]{2,}/g],
  ['phone', /(?<![\w.-])(?:\+\d{1,3}[ .-]?)?(?:\(\d{3}\)[ .-]?|\d{3}[ .-])\d{3}[ .-]\d{4}(?![\w-])/g],
  ['phone', /(?<![\w+])\+\d{1,3}(?:[ .-]\d{1,4}){2,4}(?!\w)/g],
  ['key', /(?:sk_live_|sk_test_|rk_live_|sb_secret_|github_pat_|npg_)[A-Za-z0-9_]{8,}|AKIA[0-9A-Z]{16}|xox[abprs]-[A-Za-z0-9-]{10,}|gh[pousr]_[A-Za-z0-9]{20,}|AIza[0-9A-Za-z_-]{20,}|eyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}/g],
  ['path', new RegExp(['~/Proj', 'ects/|/Use', 'rs/'].join(''), 'g')],
];

function leaksIn(text, names = []) {
  const found = LEAKS.flatMap(([kind, re]) => [...text.matchAll(re)].map((m) => `${kind}: ${m[0]}`));
  for (const name of names) {
    const escaped = name.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    if (new RegExp(`(?<![a-z0-9])${escaped}(?![a-z0-9])`, 'i').test(text)) found.push(`name: ${name}`);
  }
  return found;
}

function shippedFiles() {
  const out = [];
  const visit = (rel) => {
    const full = join(ROOT, rel);
    if (statSync(full).isDirectory()) for (const e of readdirSync(full)) visit(join(rel, e));
    else out.push(rel);
  };
  SHIPS.forEach(visit);
  return out;
}

describe('what ships', () => {
  test('the leak scan catches a planted email and key', () => {
    const planted = `notes\nmail ${j('jane.doe', '@gmail.com')}\nkey ${j('AKIA', 'IOSFODNN7EXAMPLE')}\nfine: pat@example.com\n`;
    assert.deepEqual(leaksIn(planted), [`email: ${j('jane.doe', '@gmail.com')}`, `key: ${j('AKIA', 'IOSFODNN7EXAMPLE')}`]);
    assert.deepEqual(leaksIn(`call ${j('(416)', '555-0199')} or ${j('+44 20', ' 7946 0958')}`).length, 2);
    assert.deepEqual(leaksIn('on 2026-11-04, 183046 rows'), []);
  });

  test('holds no emails, phones, keys, home paths or private names', () => {
    const names = privateNames();
    const found = shippedFiles().flatMap((rel) => leaksIn(`${rel}\n${readFileSync(join(ROOT, rel), 'utf8')}`, names).map((l) => `${rel}: ${l}`));
    assert.deepEqual(found, []);
  });
});

describe('install.sh links the wiki skill', () => {
  test('alongside cos', () => {
    const home = mkdtempSync(join(tmp, 'home-'));
    const r = spawnSync('sh', [join(ROOT, 'install.sh')], { env: { ...process.env, HOME: home }, encoding: 'utf8' });
    assert.equal(r.status, 0, r.stdout + r.stderr);
    assert.equal(readlinkSync(join(home, '.claude/skills/wiki')), join(MAIN, 'skills/wiki'));
  });
});
