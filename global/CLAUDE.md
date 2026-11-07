# Rules for every session

Kept in `~/Projects/claude-harness/global/CLAUDE.md` and linked to
`~/.claude/CLAUDE.md` by `install.sh`. Project CLAUDE.md files add to these.

- **Right folder first.** If the request is about one of the projects in
  `~/Projects/claude-harness/projects.json` and this session is in another
  folder, say so in the first reply and offer to switch (change_directory)
  before doing any work.
- **New sites and apps get a real folder.** If the request is to build a
  website or app and this session has no project folder, make
  `~/Projects/<name>` first (with `git init`) and switch to it before writing
  code. Dev servers and previews don't run in scratch sessions.
- **Done for UI or wording changes**, in any project: run the unslop skill on
  the changed screens and a pstack review of the diff, then say what each one
  changed.
- **Loop until ready.** When the owner asks to build or fix something and
  the project has a gate (`.claude/gate.json`), use `/until-ready`. Don't stop
  to ask about routine choices; decide and say what you decided.
- **Build with pstack.** For anything beyond a one-line change, load the
  pstack:poteto-mode skill and follow its playbook: design first, delegated
  build, independent review before the PR.
- **Spend usage where it counts** (most usage is long chats re-reading
  themselves).
  - One task per session. When a task ends in a PR, it's done; new work goes
    to a fresh session with a short brief, and the project's wiki page
    carries the history.
  - Keep the main chat small: hand building, long reads and big outputs to
    subagents, and summarize what comes back.
  - Chat history goes through the `history-reader` subagent (Haiku):
    reading or searching other sessions' transcripts, cloud run events,
    `~/.claude/projects` files and big saved tool-result files. Never read
    them in the main chat. The one exception is a status peek of 4 events or
    fewer on one session.
  - While waiting on a helper, end the turn without a status-only message;
    write to the owner when there's something to report or decide.
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
- **Always review.** Nothing merges without an independent review (a
  pstack review subagent, or a different model) that didn't write the change.
  The PR says which reviewer ran and what it found. If none ran, run one
  before merging into a project's default or live branch, harness changes
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
  open a PR or comment there.
- **All my projects at once** ("status of everything", "tell <project> to
  ...", "start a new project"): that's the Chief of Staff. Use `/cos`.

@~/.claude/pstack-models.md
