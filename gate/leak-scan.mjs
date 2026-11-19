// Leak scan: looks at what actually ships, not at the code diff.
//   node gate/leak-scan.mjs --sites [--projects <file>] [--json]
//     Fetches every `site` in projects.json (skipping retired projects): the
//     page, its scripts and Next.js build-manifest chunks, public source maps,
//     lazy chunks named inside those scripts (same origin, up to 200 files),
//     and a few dotfile probes. Only GETs, on the page, the scripts it names
//     and fixed paths.
//   node gate/leak-scan.mjs --dir <build output> [--json]
//     Scans a local build folder (.next/static, dist, build, out) for the same
//     patterns. Use it as a project gate step after the build.
// Exit 0 clean, 1 findings, 2 could not run. A site that answers non-200 is
// reported as "not scanned" and does not change the exit code. Notes (Google
// API keys, often public by design) are printed but never count as findings. Output never holds a full secret,
// only a masked prefix and the length.

import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const PATTERNS = [
  ['stripe secret key', /\b[sr]k_live_[A-Za-z0-9]{10,}/g],
  ['stripe test secret key', /\bsk_test_[A-Za-z0-9]{10,}/g],
  ['stripe webhook secret', /\bwhsec_[A-Za-z0-9]{10,}/g],
  ['anthropic key', /\bsk-ant-[A-Za-z0-9_-]{20,}/g],
  ['openai key', /\bsk-(?!ant-)(?:proj-)?[A-Za-z0-9_-]{32,}/g],
  ['sb_secret key', /\bsb_secret_[A-Za-z0-9_-]{20,}/g],
  ['resend key', /\bre_[A-Za-z0-9]{8,}_[A-Za-z0-9]{8,}/g],
  ['aws access key id', /\bAKIA[0-9A-Z]{16}\b/g],
  ['github token', /\b(?:ghp_[A-Za-z0-9]{30,}|github_pat_[A-Za-z0-9_]{30,})/g],
  ['slack token', /\bxox[baprs]-[A-Za-z0-9-]{10,}/g],
  ['database url with password', /\b(?:postgres(?:ql)?|mysql|mongodb(?:\+srv)?):\/\/[^:\s"'`]+:[^@\s"'`]+@[^\s"'`]+/g],
  ['private key', /-----BEGIN [A-Z ]*PRIVATE KEY-----/g],
  ['telegram bot token', /\b\d{8,10}:AA[A-Za-z0-9_-]{30,}/g],
  ['google api key (often public by design)', /\bAIza[0-9A-Za-z_-]{35}\b/g, true],
];
const JWT = /\beyJ[A-Za-z0-9_-]{10,}\.eyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}/g;
const PROBES = ['/.env', '/.env.local', '/.env.production', '/.git/config', '/.git/HEAD', '/.vercel/project.json', '/.DS_Store'];
const SCAN_EXT = /\.(?:m?js|cjs|map|html?|json|css|txt|env[^/]*)$/i;
const MAX_FILE = 20_000_000;
const TIMEOUT_MS = 20_000;
const MAX_SCRIPTS = 200;
const UA = { 'user-agent': 'harness-leak-scan' };

export const mask = (s) => `${s.slice(0, 8)}...(${s.length} chars)`;

export function scanText(text, where) {
  const out = [];
  for (const [name, re, note] of PATTERNS) {
    for (const m of text.matchAll(re)) out.push({ kind: name, where, masked: mask(m[0]), ...(note && { note: true }) });
  }
  for (const m of text.matchAll(JWT)) {
    try {
      const p = JSON.parse(Buffer.from(m[0].split('.')[1], 'base64url').toString());
      if (p.role && p.role !== 'anon') out.push({ kind: `jwt with role ${/^[A-Za-z0-9_-]{1,32}$/.test(p.role) ? p.role : '(unrecognized)'}`, where, masked: mask(m[0]) });
    } catch {}
  }
  return out;
}

const dedupe = (list) => {
  const seen = new Set();
  return list.filter((f) => {
    const k = `${f.kind}|${f.where}|${f.masked || ''}`;
    return seen.has(k) ? false : (seen.add(k), true);
  });
};

export function scanDir(root) {
  const findings = [];
  let files = 0;
  const walk = (d) => {
    for (const name of readdirSync(d)) {
      if (name === 'node_modules' || name === '.git') continue;
      const p = join(d, name);
      const st = statSync(p);
      if (st.isDirectory()) { walk(p); continue; }
      const rel = p.slice(root.length + 1);
      if (/^\.env(\.|$)/.test(name)) findings.push({ kind: 'env file in build output', where: rel });
      if (!SCAN_EXT.test(name) || st.size > MAX_FILE) continue;
      files++;
      findings.push(...scanText(readFileSync(p, 'utf8'), rel));
    }
  };
  walk(root);
  return { target: root, files, findings: dedupe(findings) };
}

// Redirects are followed only within the starting origin; a hop to any other host counts as unreachable.
async function get(url) {
  try {
    let cur = url;
    for (let hop = 0; hop < 5; hop++) {
      const r = await fetch(cur, { redirect: 'manual', signal: AbortSignal.timeout(TIMEOUT_MS), headers: UA });
      const loc = r.status >= 300 && r.status < 400 ? r.headers.get('location') : null;
      if (!loc) return { status: r.status, type: r.headers.get('content-type') || '', text: await r.text() };
      const next = new URL(loc, cur);
      if (next.origin !== new URL(url).origin) break;
      cur = next.href;
    }
  } catch {}
  return { status: 0, type: '', text: '' };
}

// JS paths named inside a script: Vite dynamic imports and Next.js chunk lists.
function chunkRefs(text, fromUrl, base) {
  const refs = new Set();
  for (const m of text.matchAll(/["'`]((?:\.{0,2}\/)?[A-Za-z0-9_@.~-]+(?:\/[A-Za-z0-9_@.~%\[\]-]+)*\.js)["'`]/g)) {
    const ref = m[1];
    try {
      let u;
      if (ref.startsWith('/')) u = new URL(ref, base);
      else if (ref.startsWith('static/')) u = new URL(`/_next/${ref}`, base);
      else if (ref.startsWith('./') || ref.startsWith('../')) u = new URL(ref, fromUrl);
      else if (ref.includes('/')) u = new URL(`/${ref}`, base);
      else continue;
      if (u.origin === base) refs.add(u.href);
    } catch {}
  }
  return refs;
}

export async function scanSite(site) {
  const base = new URL(site).origin;
  const res = { target: site, skipped: null, scripts: 0, maps: 0, findings: [] };
  const home = await get(site);
  if (home.status !== 200) { res.skipped = home.status ? `HTTP ${home.status}` : 'unreachable'; return res; }
  const out = scanText(home.text, 'html');
  const scripts = new Set();
  for (const m of home.text.matchAll(/(?:src|href)="([^"]+\.js(?:\?[^"]*)?)"/g)) scripts.add(new URL(m[1], site).href);
  const bm = home.text.match(/\/_next\/static\/([^/"]+)\/_buildManifest\.js/);
  if (bm) {
    const man = await get(`${base}/_next/static/${bm[1]}/_buildManifest.js`);
    for (const m of man.text.matchAll(/"(static\/[^"]+\.js)"/g)) scripts.add(`${base}/_next/${m[1]}`);
  }
  for (const js of scripts) {
    if (new URL(js).origin !== base) continue;
    const r = await get(js);
    if (/text\/html/i.test(r.type)) continue;
    for (const c of chunkRefs(r.text, js, base)) if (scripts.size < MAX_SCRIPTS) scripts.add(c);
    const file = new URL(js).pathname.split('/').pop();
    out.push(...scanText(r.text, file));
    const sm = await get(`${js.split('?')[0]}.map`);
    if (sm.status === 200 && sm.text.startsWith('{')) {
      res.maps++;
      out.push({ kind: 'public source map', where: file });
      out.push(...scanText(sm.text, 'sourcemap'));
    }
  }
  for (const p of PROBES) {
    const r = await get(base + p);
    if (r.status === 200 && !/text\/html/i.test(r.type) && r.text.length > 0) {
      out.push({ kind: 'exposed file', where: `${p} (HTTP 200, ${(r.type.match(/^[\w.+\/-]{1,64}/) || ['no type'])[0]}, ${r.text.length} bytes)` });
    }
  }
  res.scripts = scripts.size;
  res.findings = dedupe(out);
  return res;
}

export function sitesFromProjects(file) {
  const seen = new Set();
  const sites = [];
  for (const p of JSON.parse(readFileSync(file, 'utf8')).projects || []) {
    if (p.retired || !p.site || seen.has(p.site)) continue;
    seen.add(p.site);
    sites.push({ id: p.id, site: p.site });
  }
  return sites;
}

const line = (f) => `  ${f.note ? 'note' : '!'} ${f.kind} in ${f.where}${f.masked ? `: ${f.masked}` : ''}`;

async function main(argv) {
  const flag = (n) => argv.includes(n);
  const val = (n) => (argv.indexOf(n) >= 0 ? argv[argv.indexOf(n) + 1] : undefined);
  const json = flag('--json');
  const results = [];
  if (flag('--dir')) {
    const d = val('--dir');
    if (!d || !existsSync(d) || !statSync(d).isDirectory()) { console.error(`leak-scan: not a folder: ${d}`); return 2; }
    results.push(scanDir(resolve(d)));
  } else if (flag('--sites')) {
    const file = val('--projects') || join(dirname(fileURLToPath(import.meta.url)), '..', 'projects.json');
    let list;
    try { list = sitesFromProjects(file); } catch (e) { console.error(`leak-scan: cannot read ${file}: ${e.message}`); return 2; }
    if (!list.length) { console.error('leak-scan: no sites in projects.json'); return 2; }
    for (const s of list) results.push({ id: s.id, ...(await scanSite(s.site)) });
    if (results.every((r) => r.skipped)) { console.error('leak-scan: no site could be fetched'); return 2; }
  } else {
    console.error('usage: leak-scan.mjs --sites [--projects <file>] | --dir <build output> [--json]');
    return 2;
  }
  const total = results.reduce((n, r) => n + r.findings.filter((f) => !f.note).length, 0);
  if (json) {
    console.log(JSON.stringify({ ok: total === 0, findings: total, results }, null, 2));
  } else {
    for (const r of results) {
      const meta = r.skipped ? `skipped (${r.skipped})` : r.files !== undefined ? `${r.files} files` : `${r.scripts} scripts, ${r.maps} public source maps`;
      console.log(`\n${r.id ? `${r.id} ` : ''}${r.target}: ${meta}`);
      if (!r.skipped) console.log(r.findings.length ? r.findings.map(line).join('\n') : '  clean');
    }
    for (const r of results.filter((x) => x.skipped)) {
      console.log(`not scanned: ${r.target} ${r.skipped}`);
    }
    console.log(total ? `\nleak-scan: ${total} finding(s)` : '\nleak-scan: clean');
  }
  return total ? 1 : 0;
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  process.exitCode = await main(process.argv.slice(2));
}
