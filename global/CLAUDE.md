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
- **GitHub: your own repo only.** Pass `-R <owner/repo of origin>` to every
  `gh pr` and `gh repo` command, and push only to `origin`. Some folders also
  have an `upstream` remote that is someone else's public repo; never push,
  open a PR or comment there.
- **All my projects at once** ("status of everything", "tell <project> to
  ...", "start a new project"): that's the Chief of Staff. Use `/cos`.
