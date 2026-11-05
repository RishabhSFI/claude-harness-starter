import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { describe, test } from 'node:test';

const { prBlockReason } = await import('../cos.mjs');
const { parseFreshPr } = await import('../mc/actions.mjs');
const { askedToIso, buildQa, buildQaCard, createQaFetcher, extractChecklist, extractPreview, extractReview, firstParagraph, isQaPr, plainTitle, requestCards, safeUrl } = await import('../mc/qa.mjs');

const fx = (name) => JSON.parse(readFileSync(new URL(`./fixtures/qa/${name}.json`, import.meta.url), 'utf8'));
const ctx = { repo: 'example-owner/example-site', project: 'site', projectName: 'Site', publicBranches: ['main'] };
const withOver = (name, over) => ({ ...fx(name), ...over });

describe('a PR with no preview and its review in the body', () => {
  const card = buildQaCard(fx('portfolio-no-preview'), [], ctx);

  test('has no preview, and says what the body tells the owner to do about it', () => {
    assert.equal(card.preview, null);
    assert.match(card.previewMissing, /^Preview deploy\. .*Run npx vercel@latest deploy --scope example-team on this branch for one\.$/);
  });

  test('finds the independent review under the Checks heading', () => {
    assert.equal(card.review.source, 'body');
    assert.equal(card.review.url, 'https://github.com/example-owner/example-site/pull/4');
    assert.match(card.review.text, /^Independent review \(separate agent\):\n- No runtime breakage/);
    assert.match(card.review.text, /\n- Open: old anchors #model and #risks/);
    assert.ok(card.review.text.length <= 400);
  });

  test('takes the checklist from "Left for you", folding nested bullets into their parent', () => {
    assert.equal(card.checklist.length, 3);
    assert.match(card.checklist[0], /^Preview deploy\./);
    assert.equal(card.checklist[1], 'PLAN.md "your call" items: 6: Slide 8 wording; 8: Sign-off to show the deck; 10: custom domain');
  });

  test('is a live card with the go-live next action and no missing keys', () => {
    assert.equal(card.nextAction, 'Review, then merge into main to go live.');
    assert.deepEqual([card.live, card.blockedBy, card.kind, card.key], [true, null, 'pr', 'example-owner/example-site#4']);
    assert.equal(card.filesUrl, 'https://github.com/example-owner/example-site/pull/4/files');
    assert.equal(card.checks.text, 'no checks');
    assert.equal(card.waitingSince, '2026-11-04T21:19:01Z');
    for (const k of ['summary', 'title', 'projectName', 'reviewedAt']) assert.notEqual(card[k], undefined, k);
  });

  test('summary is the first prose paragraph as plain text, not a heading or table', () => {
    assert.match(card.summary, /^QA change, please review first\. With your OK in session, commit 1061bc4 touches only qa\/page\.mjs/);
    assert.ok(card.summary.length <= 280);
    assert.doesNotMatch(card.summary, /[*`|#]/);
  });
});

describe('preview links', () => {
  test('come from the Vercel bot comment first, even when the body and a deployment have URLs', () => {
    const detail = withOver('app-vercel-comment', { body: 'Preview: https://other.vercel.app' });
    const p = extractPreview(detail, [{ environment_url: 'https://dep.vercel.app' }]);
    assert.deepEqual(p, { url: 'https://app-git-claude-sweet-633b19-example-team.vercel.app', source: 'vercel-comment' });
  });

  test('the comment must come from the vercel bot, not a person quoting a link', () => {
    const detail = withOver('app-vercel-comment', { comments: fx('app-vercel-comment').comments.map((c) => ({ ...c, author: { login: 'someone' } })) });
    assert.equal(extractPreview(detail, []), null);
  });

  test('fall back to a deployment status, then to a vercel.app URL in the body', () => {
    const noComment = withOver('app-vercel-comment', { comments: [] });
    assert.deepEqual(extractPreview(noComment, [{ environment_url: 'https://dep.vercel.app' }]), { url: 'https://dep.vercel.app', source: 'deployment' });
    assert.deepEqual(extractPreview(fx('jobs-body-url'), []), { url: 'https://example-hub.vercel.app', source: 'body' });
    assert.deepEqual(extractPreview(withOver('jobs-body-url', { body: 'Preview: https://x-git-b.vercel.app/path.\nSee https://y.vercel.app' }), []).url, 'https://x-git-b.vercel.app/path.');
  });

  test('only https survives', () => {
    assert.equal(extractPreview(withOver('app-vercel-comment', { comments: [] }), [{ environment_url: 'http://dep.vercel.app' }, { environment_url: 'javascript:alert(1)' }]), null);
    assert.equal(extractPreview(withOver('jobs-body-url', { body: 'Preview: http://evil.vercel.app' }), []), null);
    assert.equal(safeUrl('https://a.example/x'), 'https://a.example/x');
    for (const bad of ['http://a.example', 'javascript:alert(1)', 'data:text/html,x', '//a.example', '', null]) assert.equal(safeUrl(bad), null, String(bad));
  });

  test('a card with a preview has no previewMissing', () => {
    const card = buildQaCard(fx('app-vercel-comment'), [], { ...ctx, repo: 'example-owner/app' });
    assert.equal(card.preview.source, 'vercel-comment');
    assert.equal(card.previewMissing, null);
    assert.equal(card.title, 'Add a gate so /until-ready can loop');
  });
});

describe('review links', () => {
  test('a GitHub review that gives a verdict wins; a node id cannot anchor, so it links the PR', () => {
    const r = extractReview(fx('pipeline-review-comment'));
    assert.deepEqual(r, { url: 'https://github.com/example-owner/pipeline/pull/7', source: 'review', text: 'Verdict: ship it once the migration has run.' });
    const numeric = withOver('pipeline-review-comment', { reviews: [{ id: 99, author: { login: 'x' }, body: 'Review: fine', state: 'COMMENTED' }] });
    assert.equal(extractReview(numeric).url, 'https://github.com/example-owner/pipeline/pull/7#pullrequestreview-99');
  });

  test('else a comment with a review heading or bold lead, linked by its own url', () => {
    const r = extractReview(withOver('pipeline-review-comment', { reviews: [] }));
    assert.equal(r.source, 'comment');
    assert.equal(r.url, 'https://github.com/example-owner/pipeline/pull/7#issuecomment-6650000002');
    assert.equal(r.text, 'Independent review\nNo blocking findings. Two lows noted.');
    const bold = extractReview(withOver('pipeline-review-comment', { reviews: [], comments: [{ id: 5, author: { login: 'a' }, body: '**Reviewer notes:** all fine', url: 'https://github.com/o/r/pull/7#issuecomment-5' }] }));
    assert.equal(bold.source, 'comment');
  });

  test("the Vercel bot's comment is never taken as a review", () => {
    assert.equal(extractReview(fx('app-vercel-comment')), null);
  });

  test('else a "## Review" section of the body', () => {
    const r = extractReview(fx('jobs-body-url'));
    assert.equal(r.source, 'body');
    assert.match(r.text, /^An independent reviewer \(Opus\) found no high-severity issues/);
    assert.match(r.text, /\n- Medium: the tests could load a real \.env/);
  });

  test('long review text is cut to about 400 characters', () => {
    const body = `## Review\n${'word '.repeat(200)}`;
    const r = extractReview({ url: 'https://github.com/o/r/pull/1', body });
    assert.ok(r.text.length <= 400);
    assert.match(r.text, /…$/);
  });

  test('none recorded means null', () => {
    assert.equal(extractReview({ url: 'https://github.com/o/r/pull/1', body: 'Just a change.', comments: [], reviews: [] }), null);
  });
});

describe('plain text', () => {
  test('titles lose conventional prefixes and WIP tags', () => {
    assert.equal(plainTitle('feat(ui): add a thing'), 'Add a thing');
    assert.equal(plainTitle('[WIP] fix: stop the leak'), 'Stop the leak');
    assert.equal(plainTitle('WIP: chore(deps)!: bump it'), 'Bump it');
    assert.equal(plainTitle('Fix the thing'), 'Fix the thing');
    assert.equal(plainTitle('Prefix: not conventional'), 'Prefix: not conventional');
  });

  test('summary skips headings, tables, images and fences, and strips markdown and HTML', () => {
    const body = '# Title\n\n| a | b |\n|---|---|\n\n![shot](https://x.example/a.png)\n\n```\ncode\n```\n\nSee **the [docs](https://x.example)** and `run it` <script>alert(1)</script> now.\n\nSecond paragraph.';
    assert.equal(firstParagraph(body), 'See the docs and run it alert(1) now.');
    assert.equal(firstParagraph('## Only a heading'), '');
    assert.ok(firstParagraph('word '.repeat(200)).length <= 280);
  });

  test('checklist items keep checkbox text without the box, from the known sections only', () => {
    const body = '## Notes\n- not this\n\n## Test plan\n- [ ] first\n- [x] second\n  - nested\n\n## QA\n1. third';
    assert.deepEqual(extractChecklist(body), ['first', 'second nested', 'third']);
  });

  test('links to a person are text, and a javascript: card url is dropped', () => {
    const card = buildQaCard({ ...fx('portfolio-no-preview'), url: 'javascript:alert(1)' }, [], ctx);
    assert.equal(card.url, null);
    assert.equal(card.filesUrl, null);
  });
});

describe('blocked PRs and next actions', () => {
  const blockedCase = (over) => buildQaCard(withOver('portfolio-no-preview', over), [], ctx);

  for (const [name, over] of [['a draft', { isDraft: true }], ['conflicts', { mergeable: 'CONFLICTING' }], ['requested changes', { reviewDecision: 'CHANGES_REQUESTED' }]]) {
    test(`${name} on a live PR is blocked in the merge rule's own words, and still shown`, () => {
      const detail = withOver('portfolio-no-preview', over);
      const card = blockedCase(over);
      assert.equal(card.blockedBy, prBlockReason(parseFreshPr(detail), { branches: ['main'] }, 'main'));
      assert.ok(card.blockedBy);
      assert.equal(card.nextAction, `Not ready. ${card.blockedBy} The worker has to fix this first.`);
      assert.equal(card.live, true);
    });
  }

  test('missing keys come before the merge advice', () => {
    const card = buildQaCard(fx('portfolio-no-preview'), [], { ...ctx, missingKeys: { site: ['STRIPE_KEY', 'RESEND_KEY'] } });
    assert.equal(card.nextAction, 'Add these keys first: STRIPE_KEY, RESEND_KEY. Then review and merge.');
    assert.equal(buildQaCard(fx('portfolio-no-preview'), [], { ...ctx, missingKeys: { other: ['X'] } }).nextAction, 'Review, then merge into main to go live.');
  });

  test('a migration in the body adds the run-it step; a private base just says review and merge', () => {
    const migrating = buildQaCard(withOver('portfolio-no-preview', { body: 'Adds a table.\n\nRun the migration after merge.' }), [], ctx);
    assert.equal(migrating.nextAction, 'Review, then merge into main to go live. Run the migration after merging.');
    assert.equal(buildQaCard(fx('pipeline-review-comment'), [], ctx).nextAction, 'Review, then merge.');
  });
});

describe('which PRs become cards', () => {
  const pr = { number: 7, baseRefName: 'develop', labels: [] };
  const c = { repo: 'Acme/Beta', publicBranches: ['main'] };

  test('a public base, a waiting-on-owner label, or a waiting request that names it', () => {
    assert.equal(isQaPr({ ...pr, baseRefName: 'main' }, c), true);
    assert.equal(isQaPr(pr, c), false);
    assert.equal(isQaPr({ ...pr, labels: [{ name: 'Waiting on Owner' }] }, c), true);
    assert.equal(isQaPr({ ...pr, labels: [{ name: 'waiting-on-owner' }] }, c), true);
    assert.equal(isQaPr(pr, { ...c, waitingRefs: new Set(['acme/beta#7']) }), true, 'owner/repo ref');
    assert.equal(isQaPr(pr, { ...c, waitingRefs: new Set(['beta#7']) }), true, 'bare repo ref');
    assert.equal(isQaPr(pr, { ...c, waitingRefs: new Set(['beta#8']) }), false);
  });
});

describe('request cards', () => {
  const row = (over) => ({ id: 'ab12cd34', section: 'waiting', asked: '2026-11-03', text: 'Pick the logo from [[projects/site]]', project: 'site', stands: 'Three options are in the **brand** folder.', prs: [], ...over });

  test('a waiting row with no PR becomes a request card', () => {
    assert.deepEqual(requestCards([row()]), [{
      key: 'req:ab12cd34', kind: 'request', project: 'site', projectName: 'site', title: 'Pick the logo from site',
      waitingSince: '2026-11-03', nextAction: 'Three options are in the brand folder.', reviewedAt: null,
    }]);
  });

  test('rows in other sections, and rows that name a PR, make no request card', () => {
    assert.deepEqual(requestCards([row({ section: 'open' }), row({ section: 'working' }), row({ section: 'done' }), row({ prs: ['acme/site#4'] })]), []);
  });
});

describe('the whole list', () => {
  const projects = {
    'example-owner/example-site': { project: 'site', projectName: 'Site', publicBranches: ['main'] },
    'example-owner/pipeline': { project: 'pipeline', publicBranches: ['main'] },
    'example-owner/app': { project: 'app', publicBranches: ['main'] },
  };
  const details = [
    { repo: 'example-owner/app', detail: fx('app-vercel-comment') },
    { repo: 'example-owner/example-site', detail: fx('portfolio-no-preview') },
    { repo: 'example-owner/pipeline', detail: fx('pipeline-review-comment') },
    { repo: 'example-owner/unknown', detail: fx('app-vercel-comment') },
  ];

  test('keeps public-base and labelled PRs, adds request cards, and sorts oldest waiting first', () => {
    const requests = [{ id: 'r1', section: 'waiting', asked: '2026-11-04T21:00:00Z', text: 'Choose a name', project: 'site', stands: 'Waiting on you.', prs: [] }];
    const cards = buildQa({ details, requests, reviewed: {}, ctx: { projects } });
    assert.deepEqual(cards.map((c) => c.key), ['example-owner/app#1', 'req:r1', 'example-owner/example-site#4', 'example-owner/pipeline#7']);
  });

  test('a private-base PR joins only through the label or a waiting request', () => {
    const unlabelled = { repo: 'example-owner/pipeline', detail: withOver('pipeline-review-comment', { labels: [] }) };
    assert.deepEqual(buildQa({ details: [unlabelled], ctx: { projects } }), []);
    const requests = [{ id: 'r2', section: 'waiting', asked: '2026-11-04', text: 'Check lists', project: 'pipeline', stands: 'Look at pipeline#7', prs: ['pipeline#7'] }];
    assert.deepEqual(buildQa({ details: [unlabelled], requests, ctx: { projects } }).map((c) => c.key), ['example-owner/pipeline#7']);
  });

  test('closed PRs are skipped and the reviewed note is attached', () => {
    const closed = { repo: 'example-owner/app', detail: withOver('app-vercel-comment', { state: 'MERGED' }) };
    assert.deepEqual(buildQa({ details: [closed], ctx: { projects } }), []);
    const cards = buildQa({ details, reviewed: { 'example-owner/app#1': '2026-11-05T00:00:00Z', 'req:r1': 'noted' }, requests: [{ id: 'r1', section: 'waiting', asked: '', text: 'x', project: 'site', stands: 'y', prs: [] }], ctx: { projects } });
    assert.equal(cards.find((c) => c.key === 'example-owner/app#1').reviewedAt, '2026-11-05T00:00:00Z');
    assert.equal(cards.find((c) => c.key === 'req:r1').reviewedAt, 'noted');
    assert.equal(cards.at(-1).key, 'req:r1', 'an undated ask sorts last');
  });
});

describe('the fetcher', () => {
  function fakeGh({ view = fx('portfolio-no-preview'), deployments = [], statuses = {}, fail = false } = {}) {
    const calls = [];
    const exec = async (bin, args, opts) => {
      calls.push({ bin, args, opts });
      if (fail) return { ok: false, code: 1, out: '', err: 'HTTP 502' };
      if (args[0] === 'pr') return { ok: true, code: 0, out: JSON.stringify(view), err: '' };
      const path = args[1];
      if (path.includes('/statuses')) return { ok: true, code: 0, out: JSON.stringify(statuses[path.split('/')[4]] ?? []), err: '' };
      return { ok: true, code: 0, out: JSON.stringify(deployments), err: '' };
    };
    return { exec, calls };
  }

  test('runs gh pr view for the card fields with the repo pinned, then the head commit’s deployments and their statuses', async () => {
    const { exec, calls } = fakeGh({ deployments: [{ id: 11, environment: 'Preview' }, { id: 12, environment: 'Preview' }], statuses: { 11: [{ state: 'success', environment_url: 'https://pr4.vercel.app' }], 12: [] } });
    const r = await createQaFetcher({ exec, ghBin: '/bin/gh' }).get({ repo: 'o/r', number: 4, updatedAt: 'u1' });
    assert.equal(r.ok, true);
    assert.deepEqual(r.deployments, [{ environment: 'Preview', environment_url: 'https://pr4.vercel.app', state: 'success' }]);
    assert.equal(calls[0].bin, '/bin/gh');
    assert.deepEqual(calls[0].args.slice(0, 5), ['pr', 'view', '4', '-R', 'o/r']);
    assert.match(calls[0].args[6], /^number,title,body,url,createdAt,updatedAt,baseRefName,headRefName,headRefOid,isDraft,labels,comments,reviews,statusCheckRollup,mergeable,reviewDecision/);
    assert.deepEqual(calls[1].args, ['api', `repos/o/r/deployments?sha=${r.detail.headRefOid}`]);
    assert.deepEqual(calls[2].args, ['api', 'repos/o/r/deployments/11/statuses']);
    assert.equal(extractPreview(r.detail, r.deployments).source, 'deployment');
  });

  test('fetches a PR once per updatedAt and again when it changes', async () => {
    const { exec, calls } = fakeGh();
    const f = createQaFetcher({ exec });
    const a = await f.get({ repo: 'o/r', number: 4, updatedAt: 'u1' });
    const b = await f.get({ repo: 'o/r', number: 4, updatedAt: 'u1' });
    assert.equal(a, b);
    const viewCalls = () => calls.filter((c) => c.args[0] === 'pr').length;
    assert.equal(viewCalls(), 1);
    await f.get({ repo: 'o/r', number: 4, updatedAt: 'u2' });
    assert.equal(viewCalls(), 2);
    await f.get({ repo: 'o/r', number: 5, updatedAt: 'u1' });
    assert.equal(viewCalls(), 3);
    await f.get({ repo: 'o/r', number: 4, updatedAt: 'u1' });
    assert.equal(viewCalls(), 4, 'the old entry for a PR is dropped when it changes');
  });

  test('two callers at once share one fetch', async () => {
    const { exec, calls } = fakeGh();
    const f = createQaFetcher({ exec });
    await Promise.all([f.get({ repo: 'o/r', number: 4, updatedAt: 'u1' }), f.get({ repo: 'o/r', number: 4, updatedAt: 'u1' })]);
    assert.equal(calls.filter((c) => c.args[0] === 'pr').length, 1);
  });

  test('a failure comes back as a message and is retried next time', async () => {
    const bad = fakeGh({ fail: true });
    const f = createQaFetcher({ exec: bad.exec });
    const r = await f.get({ repo: 'o/r', number: 4, updatedAt: 'u1' });
    assert.deepEqual(r, { ok: false, message: 'HTTP 502' });
    await f.get({ repo: 'o/r', number: 4, updatedAt: 'u1' });
    assert.equal(bad.calls.length, 2);
  });
});

describe('request dates', () => {
  test('a month-day date becomes this year, or last year when that would be in the future', () => {
    const now = new Date('2026-11-04T12:00:00Z');
    assert.equal(askedToIso('11-02', now), '2026-11-02');
    assert.equal(askedToIso('12-30', now), '2025-12-30');
    assert.equal(askedToIso('2026-11-03', now), '2026-11-03');
  });
});
