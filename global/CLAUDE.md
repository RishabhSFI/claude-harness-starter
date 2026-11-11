# Rules for every session

Kept in `~/Projects/claude-harness/global/CLAUDE.md` and linked to
`~/.claude/CLAUDE.md` by `install.sh`. Project CLAUDE.md files add to these.

- **Right folder first.** If the request is about a project in
  `~/Projects/claude-harness/projects.json` and this session is in another
  folder, say so in the first reply and offer to switch (change_directory)
  before any work.
- **New sites and apps get a real folder.** For a website or app with no
  project folder, make `~/Projects/<name>` (with `git init`) and switch to it
  before writing code. Dev servers and previews don't run in scratch sessions.
- **Done for UI or wording changes**, in any project: run the unslop skill on
  the changed screens and a pstack review of the diff, then say what each one
  changed.
- **Every feature works fully on a phone.** Every screen and feature must be
  fully usable at 375px and 390px wide: phone navigation, tap targets of at
  least 44px, no hover-only controls, tables that turn into cards, sheets and
  modals that fit, and no sideways scroll. Every PR that changes UI includes
  phone screenshots, and the changed flows are walked end to end at phone
  size.
- **Loop until ready.** When the owner asks to build or fix something and
  the project has a gate (`.claude/gate.json`), use `/until-ready`. Don't stop
  to ask about routine choices; decide and say what you decided. Routine
  means how to build what was asked, never what to build: open decisions go
  to the owner as questions.
- **Build with pstack.** For anything beyond a one-line change, load the
  pstack:poteto-mode skill and follow its playbook: design first, delegated
  build, independent review before the PR.
- **Spend usage where it counts** (most usage is long chats re-reading
  themselves).
  - One task per session. When a task ends in a PR, it's done; new work goes
    to a fresh session with a short brief, and the project's wiki page
    carries the history.
  - Once a chat has grown ~80k tokens past its own starting size (the prompt
    hook warns), write your state (goal, branch, done, next step) to the
    project's wiki page or the notes folder, then keep working in the same chat;
    the app compacts it. Never end a turn or stop work because of the warning.
    The Chief of Staff hub has its own, stricter rules in the cos skill.
  - Keep the main chat small: hand building, big outputs to
    subagents, long reads to `reader` (Haiku: searches, logs; diffs and PR
    reviews stay on Sonnet/Opus); summarize what comes back.
  - Chat history goes through the `history-reader` subagent (Haiku): other
    sessions' transcripts, cloud run events, `~/.claude/projects` files and
    big saved tool-result files, never the main chat. Exception: a status
    peek of 4 events or fewer on one session.
  - A worker ends its turn only when its PR is ready, it's blocked, or it has
    a question for the owner or hub. Every turn end wakes the hub, which
    re-reads its whole chat. While helpers run, wait in the foreground
    (blocking Agent calls, Monitor until-loops); never end a turn with a
    status-only message. The hub answers a status-only note with nothing.
  - Size reviews: a Sonnet reviewer for small, low-risk diffs (under about
    150 lines, no auth, money, data deletion or merge logic); an Opus
    reviewer for large or risky ones.
- **Security audit before a PR.** Before opening a PR, run
  `node ~/Projects/claude-harness/gate/security-audit.mjs` in the work folder.
  Skip it when the project's gate already has the step, since the gate ran it.
  Fix every confirmed high or critical finding. List everything else it found
  in the PR under "Security audit", or write "Security audit: no findings".
  Run the full six-phase audit (the `security-audit` skill, full audit mode)
  only when the owner asks or before a project first goes public.
- **Asked vs delivered.** Every worker report and PR (code, docs, artifacts,
  plans, emails) has an "Asked vs delivered" section in the shape of
  `~/Projects/claude-harness/skills/scope-review/SKILL.md`. Anything the owner
  didn't ask for is removed or only suggested. Never invent people, roles,
  headcount, numbers, dates, budgets, process steps or facts. A decision the
  work depends on (who reports to whom, a budget, a date) goes
  to the owner as a question, never a guess.
- **Always review.** Nothing merges without an independent review (a pstack
  review subagent, or a different model) that didn't write the change, and
  every required check COMPLETED and successful (`node cos.mjs pr-check`
  reads it; neutral or skipped count as in `status`, but one real success is
  needed, and in-progress is not a pass). Docs, artifacts, plans and emails get
  a review too before they reach the owner. Every reviewer, code or not, also
  runs the scope review (the skill above) against the owner's exact words. The
  PR or report says which reviewers ran and what they found. If none ran, run
  one before merging into a project's default or live branch, harness changes
  included. The daily review's own report commit doesn't count as a merge.
- **Releases.** Merging, pushing and deploying are fine unless the result is
  publicly visible. Public means what the project's CLAUDE.md or the
  `public` entry in `~/Projects/claude-harness/projects.json` lists
  (usually: the branch that goes live, `vercel deploy --prod`, live database
  changes, anything that emails or messages people). Those need the owner's
  go-ahead in this session; open a PR with a preview link and stop there.
  If a project declares nothing, all of these are public: a production
  deploy, a push or merge into the default branch, publishing a package or
  post, and anything that emails or messages people. When unsure, treat it
  as public.
- **Publishing the starter.** After a merge into the harness's own main, in a
  harness where `git config harness.starterRepo` is set, run
  `node cos.mjs publish-starter`. A leak-scan failure means fix the leak,
  never skip it.
- **GitHub: your own repo only.** Pass `-R <owner/repo of origin>` to every
  `gh pr` and `gh repo` command, and push only to `origin`. Some folders also
  have an `upstream` remote that is someone else's public repo; never push,
  open a PR or comment there. Before a scripted commit or push (a loop, a
  shell script), check `git remote get-url origin` is the repo you mean.
- **All my projects at once** ("status of everything", "tell <project> to
  ...", "start a new project"): that's the Chief of Staff. Use `/cos`.

@~/.claude/pstack-models.md
