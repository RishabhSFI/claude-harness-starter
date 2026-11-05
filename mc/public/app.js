const STATE_CHIP = {
  queued: ['Waiting', ''],
  starting: ['Starting', 'accent'],
  working: ['Working', 'accent'],
  blocked: ['Needs you', 'warn'],
  in_review: ['In review', 'accent'],
  ready_to_merge: ['Ready to merge', 'ok'],
  merged: ['Merged', 'ok'],
  failed: ['Failed', 'bad'],
  stopped: ['Stopped', ''],
  cancelled: ['Cancelled', ''],
};
const PRIORITY = { 1: ['P1', 'bad'], 2: ['P2', ''], 3: ['P3', ''] };
const SVG_NS = 'http://www.w3.org/2000/svg';
const ICONS = {
  overview: 'M4 4h7v7H4zM13 4h7v7h-7zM4 13h7v7H4zM13 13h7v7h-7z',
  work: 'M3 12h4l3-8 4 16 3-8h4',
  prs: 'M6 3a3 3 0 1 0 0 6a3 3 0 1 0 0-6zM6 15a3 3 0 1 0 0 6a3 3 0 1 0 0-6zM18 15a3 3 0 1 0 0 6a3 3 0 1 0 0-6zM6 9v6M18 15v-5a3 3 0 0 0-3-3h-4M13 5l-2 2l2 2',
  queue: 'M9 6h11M9 12h11M9 18h11M4.5 6h.01M4.5 12h.01M4.5 18h.01',
  usage: 'M5 20V11M12 20V5M19 20v-6M3 20h18',
  system: 'M4 5h16v11H4zM9 20h6M12 16v4',
  settings: 'M4 6h9m4 0h3M4 12h3m4 0h9M4 18h11m4 0h1M15 4v4M9 10v4M17 16v4',
};
const VIEWS = [
  { id: 'overview', label: 'Overview' },
  { id: 'work', label: 'Work' },
  { id: 'prs', label: 'Pull requests' },
  { id: 'queue', label: 'Queue' },
  { id: 'usage', label: 'Usage' },
  { id: 'system', label: 'System' },
  { id: 'settings', label: 'Settings' },
];

const $ = (id) => document.getElementById(id);
let token = null;
let state = null;
let pingAt = null;
let view = 'overview';
let workFilter = 'all';
const openPlans = new Set();
const ui = { feed: [], feedNodes: new Map(), feedReady: false, chartKey: '', chartIdx: null };

function h(tag, attrs = {}, ...children) {
  const el = document.createElement(tag);
  for (const [k, v] of Object.entries(attrs)) {
    if (v === null || v === undefined || v === false) continue;
    if (k === 'class') el.className = v;
    else if (k.startsWith('on')) el.addEventListener(k.slice(2), v);
    else el.setAttribute(k, v === true ? '' : v);
  }
  for (const c of children.flat()) if (c !== null && c !== undefined && c !== false) el.append(c.nodeType ? c : String(c));
  return el;
}

function s(tag, attrs = {}, ...children) {
  const el = document.createElementNS(SVG_NS, tag);
  for (const [k, v] of Object.entries(attrs)) if (v !== null && v !== undefined) el.setAttribute(k, String(v));
  for (const c of children) if (c) el.append(c.nodeType ? c : document.createTextNode(String(c)));
  return el;
}

const icon = (name) => s('svg', { viewBox: '0 0 24 24', 'aria-hidden': 'true', fill: 'none', stroke: 'currentColor', 'stroke-width': 1.75, 'stroke-linecap': 'round', 'stroke-linejoin': 'round' }, s('path', { d: ICONS[name] }));
const chip = (text, tone = '') => h('span', { class: `chip ${tone}` }, text);
const btn = (label, onclick, cls = '') => h('button', { type: 'button', class: `btn ${cls}`, onclick }, label);
const safeHref = (url) => (/^https:\/\/github\.com\//.test(String(url ?? '')) ? url : null);
const projectName = (id) => state?.projects.find((p) => p.id === id)?.name ?? id ?? 'Other';
const compact = new Intl.NumberFormat('en', { notation: 'compact', maximumFractionDigits: 1 });
const whole = new Intl.NumberFormat('en');
const plural = (n, one, many = `${one}s`) => `${n} ${n === 1 ? one : many}`;

function span(at) {
  if (!at) return null;
  const sec = Math.max(0, Math.round((Date.now() - (typeof at === 'number' ? at : Date.parse(at))) / 1000));
  if (sec < 60) return `${sec}s`;
  if (sec < 3600) return `${Math.floor(sec / 60)}m`;
  if (sec < 86400) return `${Math.floor(sec / 3600)}h`;
  return `${Math.floor(sec / 86400)}d`;
}
const ago = (at) => (at ? (span(at) === '0s' ? 'just now' : `${span(at)} ago`) : 'never');
const clock = (iso) => new Date(iso).toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' });
const hourLabel = (iso) => new Date(iso).toLocaleTimeString([], { hour: 'numeric' });

function notice(text, tone = 'warn') {
  const b = $('banner');
  b.hidden = !text;
  b.textContent = text ?? '';
  b.dataset.tone = tone;
}

async function post(path, body = {}) {
  const res = await fetch(path, {
    method: 'POST',
    headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw Object.assign(new Error(data.error || `Request failed (${res.status})`), { data });
  return data;
}

async function act(path, body) {
  try {
    const r = await post(path, body);
    if (r.message) notice(r.message, 'info');
    return r;
  } catch (e) {
    notice(e.message, 'bad');
    return null;
  }
}

/** Resolves true when the owner confirms. With `phrase`, the OK button waits for it to be typed exactly. */
function confirmAction({ title, body, okLabel = 'Confirm', phrase = null, focusCancel = false }) {
  const dlg = $('confirm');
  const input = $('confirm-input');
  const ok = $('confirm-ok');
  $('confirm-title').textContent = title;
  $('confirm-body').textContent = body;
  ok.textContent = okLabel;
  $('confirm-typed').hidden = !phrase;
  $('confirm-phrase').textContent = phrase ?? '';
  input.value = '';
  ok.disabled = Boolean(phrase);
  input.oninput = () => (ok.disabled = input.value.trim() !== phrase);
  return new Promise((done) => {
    dlg.onclose = () => done(dlg.returnValue === 'ok' && (!phrase || input.value.trim() === phrase));
    dlg.returnValue = '';
    dlg.showModal();
    (phrase ? input : focusCancel ? dlg.querySelector('button[value="cancel"]') : $('confirm-ok')).focus();
  });
}

async function stopSession(row) {
  const queueStarted = Boolean(row.taskId);
  const yes = await confirmAction({
    title: `Stop ${row.name}?`,
    body: queueStarted
      ? 'The queue started this session. Stopping keeps its conversation, and the task moves to stopped.'
      : "The queue didn't start this session. Stopping it ends whatever it's doing. Its conversation is kept.",
    okLabel: 'Stop session',
  });
  if (!yes) return;
  if (queueStarted) await act(`/api/tasks/${row.taskId}/stop`);
  else await act(`/api/sessions/${encodeURIComponent(row.sessionId)}/stop`, { confirm: true });
}

async function openSession(sessionId) {
  const r = await act(`/api/sessions/${encodeURIComponent(sessionId)}/open`);
  if (!r) return;
  if (!r.ok) return notice(r.message, 'bad');
  notice(`Search the Claude app's sidebar for "${r.search}".${r.attach ? ` Or run ${r.attach} in a terminal.` : ''}`, 'info');
}

/** "2 passed, 1 failing" from a check summary, or null when the page has none for this PR. */
function checksLine(c) {
  if (!c) return null;
  if (!c.total) return 'It has no checks.';
  const parts = [[c.pass, 'passed'], [c.fail, 'failing'], [c.pending, 'running']].filter(([n]) => n).map(([n, w]) => `${n} ${w}`);
  return `Checks: ${parts.join(', ')}.`;
}

async function merge(pr) {
  // A public merge takes this second, explicit click; the server refuses one without its confirm.
  const live = pr.classification === 'review';
  const green = pr.checks ? pr.checks.total > 0 && pr.checks.pass === pr.checks.total : null;
  const checks = checksLine(pr.checks);
  const yes = await confirmAction({
    title: `Merge ${pr.repo}#${pr.number}?`,
    body: live
      ? [`This goes live: it lands in ${pr.base ?? 'a public branch'}, which is public. It squashes and deletes the branch.`, checks ?? 'GitHub is checked again before it merges.', green === false ? 'Checks that aren\'t green need a typed override next.' : null].filter(Boolean).join(' ')
      : 'Every check is green and the base is private. It squashes and deletes the branch.',
    okLabel: live ? `Merge into ${pr.base ?? 'live'}` : 'Merge',
    focusCancel: live,
  });
  if (yes) await sendMerge(pr, live ? { confirm: `${pr.repo}#${pr.number}` } : {});
}

/** Posts the merge. When the server, reading GitHub fresh, says what confirm it needs, asks for exactly that once and retries. */
async function sendMerge(pr, extra, asked = false) {
  try {
    const r = await post('/api/merge', { repo: pr.repo, number: pr.number, ...extra });
    if (r.message) notice(r.message, 'info');
    return r;
  } catch (e) {
    const n = e.data?.needs;
    if (!n || asked) return notice(e.message, 'bad');
    const yes = await confirmAction({
      title: n.override ? `Merge ${n.phrase} without green checks?` : `Merge ${n.phrase}?`,
      body: `${e.message}${n.live ? ' It squashes and deletes the branch.' : ''}`,
      okLabel: n.override ? 'Merge anyway' : n.live ? `Merge into ${n.base ?? 'live'}` : 'Merge',
      phrase: n.typed ? n.phrase : null,
      focusCancel: true,
    });
    if (yes) return sendMerge(pr, { confirm: n.phrase, ...(n.override ? { override: n.phrase } : {}) }, true);
  }
}

async function stopTask(id, title) {
  if (await confirmAction({ title: `Stop ${title}?`, body: 'The session stops and the task moves to stopped. Its conversation is kept.', okLabel: 'Stop task' })) {
    act(`/api/tasks/${id}/stop`);
  }
}

/** Monotone cubic through the points, so the curve never overshoots below zero. */
function smoothPath(pts) {
  if (pts.length < 2) return pts.length ? `M${pts[0][0]},${pts[0][1]}` : '';
  const n = pts.length;
  const dx = [];
  const m = [];
  for (let i = 0; i < n - 1; i++) {
    dx[i] = pts[i + 1][0] - pts[i][0];
    m[i] = (pts[i + 1][1] - pts[i][1]) / dx[i];
  }
  const t = [m[0]];
  for (let i = 1; i < n - 1; i++) t[i] = m[i - 1] * m[i] <= 0 ? 0 : (m[i - 1] + m[i]) / 2;
  t[n - 1] = m[n - 2];
  for (let i = 0; i < n - 1; i++) {
    if (m[i] === 0) {
      t[i] = 0;
      t[i + 1] = 0;
      continue;
    }
    const a = t[i] / m[i];
    const b = t[i + 1] / m[i];
    const q = a * a + b * b;
    if (q > 9) {
      const k = 3 / Math.sqrt(q);
      t[i] = k * a * m[i];
      t[i + 1] = k * b * m[i];
    }
  }
  let d = `M${pts[0][0].toFixed(1)},${pts[0][1].toFixed(1)}`;
  for (let i = 0; i < n - 1; i++) {
    const [x0, y0] = pts[i];
    const [x1, y1] = pts[i + 1];
    const c = dx[i] / 3;
    d += ` C${(x0 + c).toFixed(1)},${(y0 + t[i] * c).toFixed(1)} ${(x1 - c).toFixed(1)},${(y1 - t[i + 1] * c).toFixed(1)} ${x1.toFixed(1)},${y1.toFixed(1)}`;
  }
  return d;
}

function sparkline(series) {
  if (!series?.length || series.every((v) => !v)) return null;
  const [w, hgt, pad] = [84, 32, 2];
  const max = Math.max(...series) || 1;
  const pts = series.map((v, i) => [pad + (i * (w - 2 * pad)) / (series.length - 1), hgt - pad - (v / max) * (hgt - 2 * pad)]);
  const line = smoothPath(pts);
  return s('svg', { class: 'spark', viewBox: `0 0 ${w} ${hgt}`, 'aria-hidden': 'true' },
    s('path', { class: 'area', d: `${line} L${pts.at(-1)[0]},${hgt} L${pts[0][0]},${hgt} Z` }),
    s('path', { class: 'line', d: line }),
  );
}

function kpiCard({ label, value, sub, series }) {
  return h('div', { class: 'kpi' },
    h('div', { class: 'label' }, label),
    h('div', { class: 'value' }, value),
    sparkline(series),
    h('div', { class: 'sub' }, sub),
  );
}

function checksChip(c) {
  if (!c) return null;
  if (!c.total) return chip('No checks', 'warn');
  if (c.fail) return chip(`${c.fail} failing`, 'bad');
  if (c.pending) return chip(`${c.pending} running`, 'accent');
  return chip(`${c.pass} passed`, 'ok');
}

function prChip(pr) {
  if (!pr) return null;
  const tone = pr.conflict || pr.checks?.fail ? 'bad' : pr.checks?.pending ? 'accent' : pr.checks?.total ? 'ok' : '';
  const label = pr.conflict ? `PR #${pr.number}, merge conflict` : `PR #${pr.number}`;
  const href = safeHref(pr.url);
  return href ? h('a', { class: `chip ${tone}`, href, target: '_blank', rel: 'noopener noreferrer' }, label) : chip(label, tone);
}

function progress(plan) {
  const pct = plan.total ? Math.round((plan.done / plan.total) * 100) : 0;
  return h('div', { class: 'bar', role: 'progressbar', 'aria-valuemin': '0', 'aria-valuemax': String(plan.total), 'aria-valuenow': String(plan.done), 'aria-label': `${plan.done} of ${plan.total} steps done` }, h('span', { 'data-pct': pct }));
}

/** Width comes from data-pct; CSP blocks inline style attributes, so it is set through the CSSOM. */
function applyBars(root) {
  for (const el of root.querySelectorAll('[data-pct]')) el.style.width = `${el.dataset.pct}%`;
}

function stepLine(plan) {
  if (!plan) return null;
  if (plan.current) return h('div', { class: 'step' }, h('span', { class: 'of' }, `Step ${plan.step} of ${plan.total}: `), plan.current);
  if (plan.done === plan.total) return h('div', { class: 'step' }, h('span', { class: 'of' }, `All ${plan.total} steps done`));
  return h('div', { class: 'step' }, h('span', { class: 'of' }, `${plan.done} of ${plan.total} steps done`));
}

const stateWords = (w) => (w.busy ? `Working for ${span(w.since) ?? 'a moment'}` : `${w.status === 'idle' ? 'Idle' : w.status} for ${span(w.since) ?? 'a moment'}`);

function activeCard(w) {
  return h('article', { class: 'card' },
    h('div', { class: 'card-top' },
      h('div', {},
        h('div', { class: 'name' }, w.name),
        h('div', { class: 'proj' }, `${w.projectName}, ${stateWords(w).toLowerCase()}`),
      ),
      prChip(w.pr),
    ),
    stepLine(w.plan),
    w.plan ? progress(w.plan) : null,
    h('div', { class: 'doing' },
      h('span', { class: 'what' }, w.doing?.text ?? 'Nothing read from its transcript yet'),
      w.doing ? h('span', { class: 'when' }, ago(w.doing.at)) : null,
    ),
    w.said ? h('div', { class: 'said' }, w.said.text) : null,
  );
}

/** cos status lines ("Alpha: 1 uncommitted file(s)") in plain words. The project shows under the line, so its prefix goes. */
function plainStatus(text, name) {
  const words = (n, one, many) => `${n} ${Number(n) === 1 ? one : many}`;
  const line = String(text);
  return (name && line.startsWith(`${name}: `) ? line.slice(name.length + 2) : line)
    .replace(/^(\d+) uncommitted file\(s\)/, (_, n) => `${words(n, 'file', 'files')} not saved to git`)
    .replace(/^(\d+) commit\(s\) not pushed on (.+)$/, (_, n, b) => `${words(n, 'change', 'changes')} on ${b} not pushed`)
    .replace(/\b(\d+) (\w+)\(s\)/g, (_, n, w) => words(n, w, `${w}s`))
    .replace(/^./, (c) => c.toUpperCase());
}

function needsActions(item) {
  const acts = [];
  if (item.kind === 'paused') acts.push(btn('Resume', () => act('/api/settings', { paused: false })));
  if (item.kind === 'approve') {
    acts.push(btn('Approve start', () => act(`/api/tasks/${item.taskId}/approve`), 'primary'));
    acts.push(btn('Cancel', async () => {
      if (await confirmAction({ title: 'Cancel this task?', body: item.text.replace(/^Approve start: /, ''), okLabel: 'Cancel task' })) act(`/api/tasks/${item.taskId}/cancel`);
    }, 'danger'));
  }
  if (item.kind === 'blocked') {
    if (item.sessionId) acts.push(btn('Open', () => openSession(item.sessionId)));
    acts.push(btn('Stop', () => stopTask(item.taskId, item.text), 'danger'));
  }
  if (item.kind === 'system') acts.push(h('a', { class: 'btn', href: '#system' }, 'Open System'));
  if (item.kind === 'review' && item.link) {
    const m = item.link.match(/github\.com\/([^/]+\/[^/]+)\/pull\/(\d+)/);
    const href = safeHref(item.link);
    if (href) acts.push(h('a', { class: 'btn', href, target: '_blank', rel: 'noopener noreferrer' }, 'Open PR'));
    if (m) acts.push(btn('Merge', () => merge({ repo: m[1], number: Number(m[2]), classification: 'review', base: item.base, checks: item.checks }), 'danger'));
  }
  return acts;
}

function renderOverview() {
  const k = state.kpis;
  const sessions = state.work.length;
  $('kpis').replaceChildren(
    kpiCard({ label: 'Sessions working', value: k.working.value, sub: `of ${plural(sessions, 'open session')}`, series: k.working.series }),
    kpiCard({ label: 'PRs waiting on you', value: k.prsWaiting.value, sub: 'to review or merge', series: k.prsWaiting.series }),
    kpiCard({ label: 'In the queue', value: k.queueLength.value, sub: `${state.meta.working} started and running`, series: k.queueLength.series }),
    kpiCard({ label: 'Merged today', value: k.mergedToday.value, sub: 'pull requests', series: k.mergedToday.series }),
    kpiCard({ label: 'Usage today', value: compact.format(k.usageToday.value), sub: 'weighted tokens', series: k.usageToday.series }),
  );
  const busy = state.work.filter((w) => w.busy);
  $('active').replaceChildren(...(busy.length ? busy.map(activeCard) : [h('p', { class: 'empty' }, state.meta.errors?.sessions ?? "Nothing's running right now.")]));
  applyBars($('active'));

  const items = state.needsYou;
  $('needs-count').textContent = items.length ? String(items.length) : '';
  $('needs').replaceChildren(
    ...(items.length
      ? items.map((it) => {
          const acts = needsActions(it);
          const meta = [it.kind === 'system' ? 'This computer' : it.project ? projectName(it.project) : null, it.waiting].filter(Boolean).join(', ');
          return h('li', {},
            h('div', { class: 'body' },
              h('div', { class: 'title' }, it.kind === 'status' ? plainStatus(it.text, projectName(it.project)) : it.text),
              meta ? h('div', { class: 'meta' }, meta) : null,
            ),
            acts.length ? h('div', { class: 'acts' }, acts) : null,
          );
        })
      : [h('li', { class: 'empty' }, 'Nothing needs you right now.')]),
  );
  renderFeed();
}

const feedKey = (e) => `${e.at}|${e.sessionId}|${e.kind}|${e.text}`;

const FEED_MAX = 40;

/**
 * Keeps the newest FEED_MAX events by time and inserts only new ones in place, so the polite live region
 * announces what's new and not the whole list.
 */
function renderFeed() {
  const list = $('feed');
  if (!ui.feedReady) list.removeAttribute('aria-live');
  const byKey = new Map(ui.feed.map((e) => [feedKey(e), e]));
  for (const e of state.feed) byKey.set(feedKey(e), e);
  ui.feed = [...byKey.values()].sort((x, y) => y.at.localeCompare(x.at)).slice(0, FEED_MAX);
  const keep = new Set(ui.feed.map(feedKey));
  for (const [key, node] of ui.feedNodes) {
    if (keep.has(key)) continue;
    node.remove();
    ui.feedNodes.delete(key);
  }
  list.querySelector('.empty')?.remove();
  let prev = null;
  for (const e of ui.feed) {
    const key = feedKey(e);
    let node = ui.feedNodes.get(key);
    if (!node) {
      node = h('li', {},
        h('time', { datetime: e.at, 'data-at': e.at }, ago(e.at)),
        h('div', {}, h('div', { class: 'who' }, `${e.name}, ${e.projectName ?? projectName(e.project)}`), h('div', { class: 'text', 'data-kind': e.kind }, e.text)),
      );
      ui.feedNodes.set(key, node);
      list.insertBefore(node, prev ? prev.nextSibling : list.firstChild);
    }
    prev = node;
  }
  if (!ui.feed.length) list.replaceChildren(h('li', { class: 'empty' }, 'No activity in open sessions yet.'));
  if (!ui.feedReady) {
    list.setAttribute('aria-live', 'polite');
    ui.feedReady = true;
  }
}

function sessionPanel(w) {
  const plan = w.plan;
  const details = plan
    ? h('details', { class: 'plan', open: openPlans.has(w.sessionId), ontoggle: (e) => (e.target.open ? openPlans.add(w.sessionId) : openPlans.delete(w.sessionId)) },
        h('summary', {}, plan.current ? `Step ${plan.step} of ${plan.total}: ${plan.current}` : `${plan.done} of ${plan.total} steps done`, progress(plan)),
        h('ol', { class: 'checklist' }, ...plan.items.map((x) => h('li', { 'data-status': x.status }, h('span', { class: 'box', 'aria-hidden': 'true' }), h('span', { class: 'sr-only' }, `${x.status.replace('_', ' ')}: `), x.content))),
      )
    : null;
  return h('article', { class: 'panel session' },
    h('div', { class: 'session-head' },
      h('h3', { class: 'name' }, h('span', { class: `dot ${w.busy ? 'busy' : ''}`, 'aria-hidden': 'true' }), w.name),
      chip(w.projectName),
      w.taskId ? chip('From the queue', 'accent') : null,
      h('span', { class: 'state' }, stateWords(w)),
      prChip(w.pr),
      h('div', { class: 'acts' }, btn('Open', () => openSession(w.sessionId)), btn('Stop', () => stopSession(w), 'danger')),
    ),
    h('dl', { class: 'session-body' },
      h('div', { class: 'kv' }, h('dt', {}, w.busy ? 'Doing now' : 'Last did'), h('dd', {}, w.doing ? `${w.doing.text}, ${ago(w.doing.at)}` : 'Nothing read yet')),
      h('div', { class: 'kv' }, h('dt', {}, 'Last said'), h('dd', {}, w.said?.text ?? 'Nothing yet')),
    ),
    details,
  );
}

const groupOf = (w) => w.project ?? `folder:${w.projectName}`;

function renderWork() {
  const groups = new Map();
  for (const w of state.work) groups.set(groupOf(w), w.projectName);
  if (workFilter !== 'all' && !groups.has(workFilter)) workFilter = 'all';
  const count = (id) => state.work.filter((w) => id === 'all' || groupOf(w) === id).length;
  const option = (id, label) => h('button', { type: 'button', 'aria-pressed': String(workFilter === id), onclick: () => { workFilter = id; renderWork(); } }, label, h('span', { class: 'n' }, count(id)));
  $('work-filter').replaceChildren(option('all', 'All'), ...[...groups].map(([id, name]) => option(id, name)));
  const rows = state.work.filter((w) => workFilter === 'all' || groupOf(w) === workFilter);
  const busy = rows.filter((w) => w.busy);
  const idle = rows.filter((w) => !w.busy);
  $('work').replaceChildren(
    ...(rows.length
      ? [busy.length ? h('h2', { class: 'group-h' }, `Working (${busy.length})`) : null, ...busy.map(sessionPanel), idle.length ? h('h2', { class: 'group-h' }, `Idle (${idle.length})`) : null, ...idle.map(sessionPanel)].filter(Boolean)
      : [h('p', { class: 'panel empty' }, state.meta.errors?.sessions ?? 'No sessions are open.')]),
  );
  applyBars($('work'));
}

function renderLanes() {
  $('lanes').replaceChildren(
    ...state.lanes.map((lane) =>
      h('section', { class: 'lane', 'aria-label': lane.label },
        h('div', { class: 'lane-head' }, h('h2', {}, lane.label), h('span', { class: 'count' }, lane.cards.length)),
        h('ul', {},
          ...(lane.cards.length
            ? lane.cards.map((c) =>
                h('li', { class: 'card' },
                  h('div', { class: 'proj' }, projectName(c.project)),
                  h('div', { class: 'name' }, c.title),
                  h('div', { class: 'chips' },
                    c.pr && safeHref(c.pr.url) ? h('a', { class: 'chip', href: safeHref(c.pr.url), target: '_blank', rel: 'noopener noreferrer' }, `#${c.pr.number}`) : chip('No PR yet'),
                    c.pr?.draft ? chip('Draft') : null,
                    c.pr?.conflict ? chip('Merge conflict', 'bad') : null,
                    checksChip(c.checks),
                  ),
                  c.pr && ['ready_to_merge', 'needs_you'].includes(lane.id) && ['mergeable-by-cos', 'review'].includes(c.pr.classification) && c.pr.repo
                    ? h('div', { class: 'acts' }, btn('Merge', () => merge({ ...c.pr, checks: c.checks }), c.pr.classification === 'review' ? 'danger' : 'primary'))
                    : null,
                ),
              )
            : [h('li', { class: 'empty' }, 'None')]),
        ),
      ),
    ),
  );
}

function taskRow(t, { waiting }) {
  const [label, tone] = STATE_CHIP[t.state];
  const [pLabel, pTone] = PRIORITY[t.priority];
  const acts = [];
  if (waiting) {
    acts.push(btn('Up', () => act(`/api/tasks/${t.id}/up`), 'ghost'));
    acts.push(btn('Down', () => act(`/api/tasks/${t.id}/down`), 'ghost'));
    if (t.risky && !t.approved) acts.push(btn('Approve start', () => act(`/api/tasks/${t.id}/approve`), 'primary'));
    acts.push(btn('Cancel', async () => {
      if (await confirmAction({ title: 'Cancel this task?', body: t.title, okLabel: 'Cancel task' })) act(`/api/tasks/${t.id}/cancel`);
    }, 'danger'));
  } else if (['starting', 'working', 'blocked', 'in_review', 'ready_to_merge'].includes(t.state)) {
    if (t.sessionId) acts.push(btn('Open', () => openSession(t.sessionId)));
    acts.push(btn('Stop', () => stopTask(t.id, t.title), 'danger'));
  }
  const note = waiting ? t.waitingFor : t.history.at(-1)?.note;
  return h('li', {},
    h('div', { class: 'body' },
      h('div', { class: 'title' }, chip(pLabel, pTone), ' ', t.title, t.risky ? ' ' : null, t.risky ? chip(t.approved ? 'Risky, approved' : 'Risky', 'warn') : null),
      h('div', { class: 'meta' }, `${projectName(t.project)}, added ${ago(t.createdAt)}${note ? `, ${note}` : ''}`),
    ),
    h('div', { class: 'acts' }, chip(label, tone), acts),
  );
}

function renderQueue() {
  const m = state.meta;
  const running = m.working ? `${plural(m.working, 'task')} running now.` : 'Nothing from the queue is running now.';
  const paused = m.paused ? ` Starts are paused${m.pauseReason ? `: ${m.pauseReason}` : ''}.` : '';
  $('queue-lead').textContent = m.cap
    ? `You've set a limit of ${m.cap} at once, so a task waits while ${m.cap} are running. ${running}${paused} Change it in Settings.`
    : `Every task you add starts right away in its own worktree, so tasks in one project run side by side. ${running}${paused}`;
  const { waiting, active } = state.queue;
  $('waiting-count').textContent = waiting.length ? String(waiting.length) : '';
  $('queue').replaceChildren(...(waiting.length ? waiting.map((t) => taskRow(t, { waiting: true })) : [h('li', { class: 'empty' }, 'Nothing is waiting.')]));
  $('started').replaceChildren(...(active.length ? active.map((t) => taskRow(t, { waiting: false })) : [h('li', { class: 'empty' }, 'Nothing started from the queue yet.')]));
  const select = $('add-project');
  if (select.options.length !== state.projects.length) select.replaceChildren(...state.projects.map((p) => h('option', { value: p.id }, p.name)));
}

function niceStep(max) {
  const raw = max / 3;
  const mag = 10 ** Math.floor(Math.log10(raw || 1));
  return [1, 2, 2.5, 5, 10].map((f) => f * mag).find((v) => v >= raw) ?? raw;
}

function renderChart() {
  const box = $('chart');
  const hours = state.usage?.hours ?? [];
  const width = box.clientWidth;
  const height = box.clientHeight;
  const key = JSON.stringify([hours, width, height]);
  if (key === ui.chartKey) return;
  ui.chartKey = key;
  if (!hours.length || !width) {
    box.replaceChildren(h('p', { class: 'empty' }, 'Reading transcripts. The chart shows up within a minute.'));
    return;
  }
  const [left, right, top, bottom] = [48, 8, 8, 24];
  const max = Math.max(...hours.map((x) => x.weighted), 1);
  const step = niceStep(max);
  const yMax = Math.ceil(max / step) * step;
  const x = (i) => left + (i * (width - left - right)) / (hours.length - 1);
  const y = (v) => top + (1 - v / yMax) * (height - top - bottom);
  const pts = hours.map((p, i) => [x(i), y(p.weighted)]);
  const line = smoothPath(pts);
  const ticks = [];
  for (let v = 0; v <= yMax + 1e-9; v += step) ticks.push(v);
  const guide = s('line', { class: 'guide', y1: top, y2: height - bottom, visibility: 'hidden' });
  const dot = s('circle', { class: 'pt', r: 4, visibility: 'hidden' });
  const svg = s('svg', { viewBox: `0 0 ${width} ${height}`, 'aria-hidden': 'true' },
    ...ticks.map((v) => s('line', { class: 'grid', x1: left, x2: width - right, y1: y(v), y2: y(v) })),
    ...ticks.map((v) => s('text', { class: 'axis', x: left - 8, y: y(v) + 4, 'text-anchor': 'end' }, compact.format(v))),
    ...hours.map((p, i) => (i % 4 === 3 || i === hours.length - 1 ? s('text', { class: 'axis', x: x(i), y: height - 6, 'text-anchor': i === hours.length - 1 ? 'end' : 'middle' }, hourLabel(p.start)) : null)).filter(Boolean),
    s('path', { class: 'area', d: `${line} L${pts.at(-1)[0]},${y(0)} L${pts[0][0]},${y(0)} Z` }),
    s('path', { class: 'line', d: line }),
    guide,
    dot,
  );
  const show = (i) => {
    for (const el of [guide, dot]) el.setAttribute('visibility', i === null ? 'hidden' : 'visible');
    if (i === null) {
      $('chart-readout').textContent = '';
      return;
    }
    ui.chartIdx = i;
    const p = hours[i];
    guide.setAttribute('x1', pts[i][0]);
    guide.setAttribute('x2', pts[i][0]);
    dot.setAttribute('cx', pts[i][0]);
    dot.setAttribute('cy', pts[i][1]);
    $('chart-readout').textContent = `${clock(p.start)}: ${whole.format(p.weighted)} weighted tokens, ${plural(p.sessions, 'session')}`;
  };
  const at = (clientX) => {
    const r = box.getBoundingClientRect();
    return Math.max(0, Math.min(hours.length - 1, Math.round(((clientX - r.left - left) / (width - left - right)) * (hours.length - 1))));
  };
  box.onpointermove = (e) => show(at(e.clientX));
  box.onpointerleave = () => (document.activeElement === box ? null : show(null));
  box.onfocus = () => show(ui.chartIdx ?? hours.length - 1);
  box.onblur = () => show(null);
  box.onkeydown = (e) => {
    const i = ui.chartIdx ?? hours.length - 1;
    const next = { ArrowLeft: i - 1, ArrowRight: i + 1, Home: 0, End: hours.length - 1 }[e.key];
    if (next === undefined) return;
    e.preventDefault();
    show(Math.max(0, Math.min(hours.length - 1, next)));
  };
  box.replaceChildren(svg);
  if (document.activeElement === box && ui.chartIdx !== null) show(ui.chartIdx);
}

function renderUsage() {
  const u = state.usage ?? { hours: [], today: 0, top: [] };
  const total = u.hours.reduce((n, x) => n + x.weighted, 0);
  const peak = u.hours.reduce((best, x) => (x.weighted > (best?.weighted ?? -1) ? x : best), null);
  $('usage-kpis').replaceChildren(
    kpiCard({ label: 'Today', value: compact.format(u.today), sub: 'weighted tokens since midnight', series: state.kpis.usageToday.series }),
    kpiCard({ label: 'Last 24 hours', value: compact.format(total), sub: 'weighted tokens', series: null }),
    kpiCard({ label: 'Busiest hour', value: peak?.weighted ? compact.format(peak.weighted) : '0', sub: peak?.weighted ? `at ${clock(peak.start)}` : 'nothing yet', series: null }),
  );
  renderChart();
  const most = u.top[0]?.weighted || 1;
  $('top').replaceChildren(
    ...(u.top.length
      ? u.top.map((t) =>
          h('li', {},
            h('div', { class: 'who' }, t.name, h('span', { class: 'proj' }, t.projectName)),
            h('span', { class: 'amt' }, compact.format(t.weighted)),
            h('div', { class: 'bar' }, h('span', { 'data-pct': Math.max(1, Math.round((t.weighted / most) * 100)) })),
          ),
        )
      : [h('li', { class: 'empty' }, 'No usage in the last 24 hours.')]),
  );
  applyBars($('top'));
}

function renderSettings() {
  const m = state.meta;
  $('limit-now').textContent = m.cap ? `At most ${m.cap} queue tasks run at once. The rest wait their turn.` : 'No limit. Every queued task starts right away.';
  if (!$('limit').contains(document.activeElement)) {
    $('limit-on').checked = Boolean(m.cap);
    if (m.cap) $('limit-n').value = String(m.cap);
    $('limit-n').disabled = !m.cap;
  }
  $('pause-now').textContent = m.paused
    ? `Starts are paused${m.pauseReason ? `: ${m.pauseReason}` : ''}. Tasks already running carry on.`
    : "Starts are on. If a start hits your plan's usage limit, starts pause on their own and the reason shows here.";
  const pause = $('pause');
  pause.setAttribute('aria-pressed', String(m.paused));
  pause.textContent = m.paused ? 'Resume starts' : 'Pause starts';
  const p = m.paths ?? {};
  $('where').replaceChildren(
    ...[['Sign-in token', p.token], ['Queue and settings', p.state], ['Action log', p.log], ['Transcripts read', p.transcripts]]
      .filter(([, v]) => v)
      .flatMap(([k, v]) => [h('dt', {}, k), h('dd', {}, h('code', {}, v))]),
  );
  const n = m.leftover ?? 0;
  $('leftover').textContent = n
    ? `${n === 1 ? '1 finished task still has its folder' : `${n} finished tasks still have their folders`} in a <project>-tasks folder. Mission control never deletes them; remove one with git worktree remove when you're done with it.`
    : 'No finished task folders left on disk.';
  const review = state.fromReview;
  $('review-meta').textContent = review?.items.length ? `Proposed changes in ${review.file.split('/').pop()}. Act on them in the harness chat.` : 'No proposals in the latest daily review.';
  $('review-items').replaceChildren(...(review?.items ?? []).map((text) => h('li', {}, h('div', { class: 'body' }, h('div', { class: 'title' }, text)))));
}

function renderErrors() {
  const m = state.meta;
  const errors = [m.errors?.sessions, m.errors?.status && `PR status: ${m.errors.status}`].filter(Boolean);
  if (errors.length) notice(errors.join(' '), 'state');
  else if ($('banner').dataset.tone === 'state') notice(null);
}


const bytesText = (b) => (b >= 1024 ** 3 ? `${(b / 1024 ** 3).toFixed(1)} GB` : `${Math.round(b / 1024 ** 2)} MB`);
const uptimeText = (sec) => (sec >= 86400 ? `${Math.floor(sec / 86400)}d ${Math.floor((sec % 86400) / 3600)}h` : `${Math.floor(sec / 3600)}h ${Math.floor((sec % 3600) / 60)}m`);
const pctText = (n) => `${n >= 10 ? Math.round(n) : n}%`;
const diskName = (mount) => (mount === '/' || mount === '/System/Volumes/Data' ? 'Main disk' : mount);
const OTHER_SHOWN = 5;
let showAllOther = false;
const KIND_CHIP = { session: ['Claude session', 'accent'], 'dev-server': ['Dev server', 'ok'], gate: ['Test run', 'warn'], 'mission-control': ['Mission control', 'accent'] };

async function stopProcesses(rows, title) {
  const first = rows[0];
  const where = [first.ports?.length ? `port ${first.ports.join(', ')}` : null, first.project ? projectName(first.project) : null, first.kind !== 'session' && first.session ? `started by ${first.session}` : null].filter(Boolean).join(', ');
  const body = rows.length === 1 ? `${first.name} (process ${first.pid}${where ? `, ${where}` : ''}) will be asked to quit. This can't be undone.` : `${rows.map((r) => `${r.name} (${r.pid})`).join(', ')} will be asked to quit. This can't be undone.`;
  if (!(await confirmAction({ title, body, okLabel: 'Stop', focusCancel: true }))) return;
  await act('/api/system/stop', { processes: rows.map((r) => ({ pid: r.pid, startedAt: r.startedAt })) });
}

function processRow(p) {
  const kind = KIND_CHIP[p.kind];
  const owned = p.kind !== 'session' && p.session;
  const age = span(p.startedAt);
  const meta = [`${pctText(p.cpuPct)} CPU`, `${bytesText(p.memBytes)} memory`, age ? `running ${age}` : null, p.ports?.length ? `port ${p.ports.join(', ')}` : null].filter(Boolean).join(', ');
  return h('li', {},
    h('div', { class: 'body' },
      h('div', { class: 'title' }, p.name, ' ', kind ? chip(kind[0], kind[1]) : null),
      owned ? h('div', { class: 'meta' }, `Started by ${p.session}`) : null,
      h('div', { class: 'meta num' }, meta),
    ),
    p.stoppable ? h('div', { class: 'acts' }, btn('Stop', () => stopProcesses([p], `Stop ${p.name}?`), 'danger')) : null,
  );
}

function volumeRow(d) {
  const used = d.totalBytes ? Math.round(((d.totalBytes - d.freeBytes) / d.totalBytes) * 100) : 0;
  return h('li', {},
    h('div', { class: 'body' },
      h('div', { class: 'title' }, diskName(d.mount), ' ', d.freePct < 10 ? chip('Low', 'bad') : null),
      h('div', { class: 'meta num' }, `${bytesText(d.freeBytes)} free of ${bytesText(d.totalBytes)}${d.holds?.length ? `, holds ${d.holds.join(', ')}` : ''}`),
      h('div', { class: 'bar', role: 'progressbar', 'aria-valuemin': '0', 'aria-valuemax': '100', 'aria-valuenow': String(used), 'aria-label': `${used}% of ${diskName(d.mount)} used` }, h('span', { 'data-pct': used })),
    ),
  );
}

function renderSystem() {
  const sys = state.system;
  if (!sys) {
    $('system-kpis').replaceChildren();
    $('system-alerts').replaceChildren(h('li', { class: 'empty' }, 'System details are only collected when mission control starts from the command line.'));
    for (const id of ['system-suggest', 'system-procs', 'system-other', 'system-sessions', 'system-disks', 'system-folders', 'system-errors']) $(id).replaceChildren();
    $('system-machine').replaceChildren();
    $('system-other-head').hidden = $('system-other-more').hidden = true;
    return;
  }
  const { cpu, memory: mem, machine } = sys;
  const home = sys.disks.find((d) => d.holds?.includes('harness')) ?? sys.disks[0];
  const kpis = [
    kpiCard({ label: 'CPU', value: cpu.pct === null ? '...' : `${Math.round(cpu.pct)}%`, sub: plural(machine.cores, 'core'), series: cpu.history.map((x) => x.pct) }),
    kpiCard({ label: 'Memory', value: mem.pct === null ? '...' : `${Math.round(mem.pct)}%`, sub: `${bytesText(mem.usedBytes ?? 0)} of ${bytesText(mem.totalBytes)}, ${bytesText(mem.swapUsedBytes)} swap`, series: mem.history.map((x) => x.pct) }),
    kpiCard({ label: 'Disk free', value: home ? bytesText(home.freeBytes) : '...', sub: home ? `${Math.round(home.freePct)}% of ${bytesText(home.totalBytes)}` : 'No reading yet' }),
  ];
  if (cpu.load) kpis.push(kpiCard({ label: 'Load', value: cpu.load[0].toFixed(2), sub: `5 min ${cpu.load[1].toFixed(2)}, 15 min ${cpu.load[2].toFixed(2)}` }));
  $('system-kpis').className = `kpis ${kpis.length === 4 ? 'four' : 'three'}`;
  $('system-kpis').replaceChildren(...kpis);

  $('system-alerts-count').textContent = sys.alerts.length ? String(sys.alerts.length) : '';
  $('system-alerts').replaceChildren(...(sys.alerts.length ? sys.alerts.map((a) => h('li', {}, h('div', { class: 'body' }, h('div', { class: 'title' }, a.text)))) : [h('li', { class: 'empty' }, 'Nothing is overloaded.')]));

  $('system-machine').replaceChildren(
    ...[['System', `${machine.os} ${machine.version}`.trim()], ['Processor', `${machine.cpuModel}, ${plural(machine.cores, 'core')}`], ['Memory', bytesText(machine.totalBytes)], ['Up for', machine.uptimeSec ? uptimeText(machine.uptimeSec) : 'unknown']].flatMap(([k, v]) => [h('dt', {}, k), h('dd', {}, v)]),
  );

  const byPid = new Map(sys.processes.map((p) => [p.pid, p]));
  $('system-suggest').replaceChildren(
    ...sys.suggestions.map((sg) => {
      const rows = sg.pids.map((pid) => byPid.get(pid)).filter(Boolean);
      return h('li', {}, h('div', { class: 'body' }, h('div', { class: 'title' }, sg.text)), rows.length ? h('div', { class: 'acts' }, btn('Stop', () => stopProcesses(rows, sg.text), 'danger')) : null);
    }),
  );
  // Rows with Stop buttons keep their place between refreshes, so a click lands on the row it was aimed at.
  const kinds = Object.keys(KIND_CHIP);
  const ours = sys.processes.filter((p) => KIND_CHIP[p.kind]).sort((a, b) => kinds.indexOf(a.kind) - kinds.indexOf(b.kind) || a.pid - b.pid);
  const other = sys.processes.filter((p) => !KIND_CHIP[p.kind]);
  $('system-procs-count').textContent = String(ours.length);
  $('system-procs').replaceChildren(...(ours.length ? ours.map(processRow) : [h('li', { class: 'empty' }, sys.processes.length ? 'No sessions, dev servers or test runs are running.' : 'Waiting for the first reading.')]));
  $('system-other-head').hidden = !other.length;
  $('system-other-count').textContent = String(other.length);
  $('system-other').replaceChildren(...(showAllOther ? other : other.slice(0, OTHER_SHOWN)).map(processRow));
  const more = $('system-other-more');
  more.hidden = other.length <= OTHER_SHOWN;
  more.textContent = showAllOther ? 'Show fewer' : `Show ${other.length - OTHER_SHOWN} more`;
  more.onclick = () => { showAllOther = !showAllOther; renderSystem(); };

  const biggest = Math.max(1, ...sys.sessions.map((t) => t.memBytes));
  $('system-sessions').replaceChildren(
    ...(sys.sessions.length
      ? sys.sessions.map((t) => h('li', {}, h('div', { class: 'who' }, t.name, h('span', { class: 'proj' }, plural(t.processes, 'process', 'processes'))), h('div', { class: 'amt' }, `${bytesText(t.memBytes)}, ${pctText(t.cpuPct)} CPU`), h('div', { class: 'bar' }, h('span', { 'data-pct': Math.round((t.memBytes / biggest) * 100) }))))
      : [h('li', { class: 'empty' }, 'No session processes found.')]),
  );
  $('system-disks').replaceChildren(...sys.disks.map(volumeRow));
  const folders = sys.folders.filter((f) => f.bytes !== 0).sort((a, b) => (b.bytes ?? Infinity) - (a.bytes ?? Infinity));
  $('system-folders').replaceChildren(...(sys.folders.length ? folders.map((f) => h('li', {}, h('div', { class: 'body' }, h('div', { class: 'title' }, f.label), h('div', { class: 'meta num' }, f.bytes === null ? 'Too large to size' : bytesText(f.bytes))))) : [h('li', { class: 'empty' }, 'Folder sizes are measured in the background.')]));
  $('system-errors').replaceChildren(...sys.errors.map((e) => h('li', {}, e)));
  applyBars(document.querySelector('section[data-view="system"]'));
}

const RENDER = { overview: renderOverview, work: renderWork, prs: renderLanes, queue: renderQueue, usage: renderUsage, system: renderSystem, settings: renderSettings };

function renderNav() {
  const needs = state?.needsYou.length ?? 0;
  for (const a of $('nav').querySelectorAll('a')) {
    const id = a.dataset.view;
    if (id === view) a.setAttribute('aria-current', 'page');
    else a.removeAttribute('aria-current');
    const badge = a.querySelector('.badge');
    const count = id === 'overview' ? needs : id === 'system' ? state?.system?.alerts.length ?? 0 : 0;
    if (badge) {
      badge.hidden = !count;
      badge.textContent = String(count);
    }
  }
}

function render() {
  if (!state) return;
  renderErrors();
  renderNav();
  RENDER[view]();
  renderClock();
}

function renderClock() {
  $('refreshed').textContent = state ? `Sessions checked ${ago(pingAt)}, PRs ${state.meta.statusAt ? ago(state.meta.statusAt) : 'loading'}` : 'No data yet';
  for (const t of document.querySelectorAll('#feed time')) t.textContent = ago(t.dataset.at);
}

function route() {
  const id = location.hash.slice(1);
  view = VIEWS.some((v) => v.id === id) ? id : 'overview';
  for (const sec of document.querySelectorAll('.view')) sec.hidden = sec.dataset.view !== view;
  $('view-title').textContent = VIEWS.find((v) => v.id === view).label;
  ui.chartKey = '';
  render();
  renderNav();
}

function buildNav() {
  $('nav').replaceChildren(
    ...VIEWS.map((v) =>
      h('li', {},
        h('a', { href: `#${v.id}`, 'data-view': v.id, 'aria-label': v.label }, icon(v.id), h('span', { class: 'label', 'aria-hidden': 'true' }, v.label), ['overview', 'system'].includes(v.id) ? h('span', { class: 'badge', hidden: true }) : null),
      ),
    ),
  );
}

function connect() {
  const conn = $('conn');
  const es = new EventSource(`/api/events?token=${encodeURIComponent(token)}`);
  es.addEventListener('open', () => {
    conn.dataset.state = 'live';
    conn.textContent = 'Live';
  });
  es.addEventListener('state', (e) => {
    state = JSON.parse(e.data);
    render();
  });
  es.addEventListener('ping', (e) => {
    pingAt = JSON.parse(e.data).sessionsAt;
    renderClock();
  });
  es.addEventListener('error', () => {
    conn.dataset.state = 'lost';
    conn.textContent = 'Reconnecting';
  });
}

function wireControls() {
  $('pause').addEventListener('click', () => act('/api/settings', { paused: !state?.meta.paused }));
  $('refresh').addEventListener('click', () => act('/api/refresh'));
  $('limit-on').addEventListener('change', (e) => ($('limit-n').disabled = !e.target.checked));
  $('limit').addEventListener('submit', (e) => {
    e.preventDefault();
    const on = $('limit-on').checked;
    const n = Number($('limit-n').value);
    if (on && !(Number.isInteger(n) && n >= 1)) return notice('The limit is a whole number of 1 or more.', 'bad');
    act('/api/settings', { cap: on ? n : null });
    document.activeElement?.blur();
  });
  $('add').addEventListener('submit', async (e) => {
    e.preventDefault();
    const form = e.target;
    const data = new FormData(form);
    const err = $('add-error');
    try {
      await post('/api/tasks', {
        project: data.get('project'),
        title: data.get('title'),
        prompt: data.get('prompt'),
        priority: Number(data.get('priority')),
        risky: data.get('risky') === 'on',
      });
      form.reset();
      err.hidden = true;
    } catch (ex) {
      err.textContent = ex.message;
      err.hidden = false;
    }
  });
  window.addEventListener('hashchange', route);
  window.addEventListener('resize', () => view === 'usage' && state && renderChart());
}

function init() {
  buildNav();
  const params = new URLSearchParams(location.search);
  if (params.has('token')) {
    try {
      sessionStorage.setItem('mc-token', params.get('token'));
    } catch {}
    token = params.get('token');
    history.replaceState(null, '', `/${location.hash}`);
  } else {
    try {
      token = sessionStorage.getItem('mc-token');
    } catch {}
  }
  route();
  if (!token) {
    $('conn').textContent = 'Not signed in';
    notice('Open the link mission control printed when it started (it has ?token= on the end).', 'bad');
    return;
  }
  wireControls();
  connect();
  setInterval(renderClock, 1000);
}

init();
