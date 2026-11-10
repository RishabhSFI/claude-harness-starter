---
name: until-ready
description: Work on a change without stopping until it passes the project's checks (its .claude/gate.json), in its own worktree, ending in a PR. Turns on a Stop hook that sends Claude back to work on every failure, up to 5 tries. Use for /until-ready, "keep going until it works", "loop till it's ready", "don't stop until QA passes". In a project with no gate yet, it drafts one first.
---

# Keep going until it's ready

One task, one worktree, one branch, one PR. Other sessions may work in the
same repo, so never edit, switch branches or commit in the main checkout for
an until-ready task.

The scripts live in `~/Projects/claude-harness/gate`. Below, `G` means that
folder.

## 1. Get a folder of your own

- If this session already runs in a worktree the app made (`git rev-parse
  --show-toplevel` is not the main checkout), run `G/worktree.sh setup` there.
- Otherwise make one, with a short slug for the task:

  ```bash
  ~/Projects/claude-harness/gate/worktree.sh new <slug>
  cd ../<repo>-tasks/<slug>
  ```

  It prints the base branch. The PR goes against that branch.

Setup clones `node_modules` and the untracked files listed in `gate.json`
`local` (env files, data) from the main checkout. It never installs anything.

## 2. Turn the gate on

From inside the worktree, with the goal in the owner's own words:

```bash
node ~/Projects/claude-harness/gate/until-ready.mjs on "<the goal>"
```

It prints the checks you must pass and the project's rules. Follow those
rules for the whole task. If it says the project has no gate, do "No gate
yet" first.

## 3. Work

Don't ask the owner anything routine. Decide, note the decision for the
report, and keep going. The gate checks code, not looks: when the work
changes what people see, look at it in the browser pane at 1440px and 375px
before ending a turn. Commit as you go on the task branch.

## 4. End your turn

For a UI change, first check it at 375px and 390px wide: walk the changed
flows end to end, take phone screenshots for the PR, and fix sideways scroll,
tap targets under 44px and hover-only controls.

The Stop hook runs the project's checks. It can take a few minutes.

- **It fails:** you get the output. Fix the cause, never the check: don't edit
  the check scripts or tests, skip a test or loosen a pass rule to get
  through. End your turn again.
- **It passes:** commit, then `git push -u origin task/<slug>` and
  `gh pr create --base <base> --fill-first` with a body: the goal, what
  changed, decisions you made, the QA lines the hook gave you. Then report
  with the PR link.
- **Last try fails:** stop. Report what still fails and what you tried. Push
  the branch and open a draft PR (`--draft`) so the work isn't lost.

If the repo has no remote, skip the push and PR and report the branch name.

Never merge the PR, push the base branch, deploy or publish. The owner
reviews the PR.

To turn the gate off early: `node ~/Projects/claude-harness/gate/until-ready.mjs off`.
When the PR is merged: `git worktree remove ../<repo>-tasks/<slug>`.

## No gate yet

A gate is `.claude/gate.json` in the repo. It defines "ready" for the
project, so the owner approves it once:

1. Read `package.json` scripts, CLAUDE.md and any test or QA scripts.
2. Draft the file:
   - `steps`: the project's own checks in order, cheapest first (tests,
     lint, typecheck, build). Use only commands that exist.
   - `serve` and `qa` (optional): for a web app with a page-check script,
     a command that serves the build on `{port}` and one that checks `{url}`.
   - `local`: untracked files a worktree needs (`.env.local`, data folders).
   - `rules`: the project's hard rules from CLAUDE.md (files not to touch,
     what never to run, what "done" also needs). For a web app, add the
     phone rule: QA also checks pages at 375px and 390px wide.
   - `tries`: 5.
3. Show the owner the draft in one short message and ask for an OK. This is
   the one question worth asking: the gate decides when work counts as done.
4. Once approved, commit it on the task branch with the work. Make sure
   `.gitignore` doesn't hide it, and that `.claude/loop/` is ignored.

Example (Next.js):

```json
{
  "env": { "NEXT_DIST_DIR": ".next-gate" },
  "steps": [{ "name": "lint", "run": "npm run lint" }, { "name": "build", "run": "npm run build" }],
  "serve": "npx next start -p {port}",
  "qa": "node qa/run.mjs {url}",
  "local": [".env.local"],
  "rules": ["Don't edit qa/ to get through the gate."],
  "tries": 5
}
```

`NEXT_DIST_DIR` needs `distDir: process.env.NEXT_DIST_DIR || ".next"` in
`next.config`, so gate builds never break a running dev server.
