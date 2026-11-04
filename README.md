# Claude harness: Chief of Staff + until-ready

Run all your projects from one Claude chat.

- **Chief of Staff** (`/cos`). One hub chat. It reads every project (unsaved
  work, open PRs, failing checks), sends work to a separate Claude session per
  task, checks what comes back, and tells you only what needs you.
- **until-ready** (`/until-ready`). A worker keeps going until the project's
  own checks pass (its `.claude/gate.json`), in its own copy of the code, and
  ends in a PR.
- **pstack**. Workers design first, hand coding to helper agents, and get an
  independent review before the PR.
- **Nothing public happens without you.** The Chief of Staff may merge PRs
  into private branches once checks are green. Anything public waits for your
  OK: production deploys, merges into a live branch, live database changes,
  anything that emails or messages people.

## What you need

- The **Claude desktop app** (Code tab). Starting and messaging sessions only
  works there.
- Node 20 or newer, git, and the GitHub CLI signed in (`gh auth login`).
- **Auto mode**, if your plan has it. Without it, workers stop at permission
  prompts.

## Install

1. **pstack.** In Claude Code, run these, then `/setup-pstack` to pick which
   models do which job:

   ```
   /plugin marketplace add michael-denyer/pstack-claude
   /plugin install pstack@pstack-claude
   ```

2. **This folder.** Clone it to `~/Projects/claude-harness`, make it a
   private GitHub repo of your own (your projects list will live in it), and
   install:

   ```bash
   git clone https://github.com/RishabhSFI/claude-harness-starter ~/Projects/claude-harness
   cd ~/Projects/claude-harness
   git remote remove origin
   gh repo create claude-harness --private --source . --push
   sh install.sh --dry-run
   sh install.sh
   ```

   Got it as a zip instead? Unzip it to `~/Projects/claude-harness`, run
   `git init -b main && git add -A && git commit -m "Start my harness"` in
   it, then the last three commands.

   It links the `cos` and `until-ready` skills into `~/.claude/skills`, links
   `global/CLAUDE.md` to `~/.claude/CLAUDE.md`, and adds two hooks to
   `~/.claude/settings.json` (it saves a `.bak` first). It never overwrites a
   file you already have: if you have your own `~/.claude/CLAUDE.md`, it says
   so and leaves it. Copy the rules from `global/CLAUDE.md` into yours by
   hand.

3. **Your projects.** Copy each project from `projects.example.json` into
   `projects.json`. Or open a chat in this folder, run `/cos`, and say "add my
   project at ~/Projects/my-app". For each one, fill in:
   - `checkouts`: the folders it lives in;
   - `aliases`: names you call it, used to file sessions;
   - `keywords`: words that point to it, used to route requests;
   - `public`: what makes it publicly visible (live branches, remotes,
     deploy commands, anything that emails people).

   **Get `public` right.** It decides what the Chief of Staff may merge or
   deploy without asking. When a project has no `public` entry, its default
   branch counts as public.

4. **Gates.** In each project, ask for something with `/until-ready`. If the
   project has no `.claude/gate.json`, it drafts one from the project's real
   tests and build and asks you to OK it once. Or have `/cos` send a worker
   to every project without one.

5. **New projects.** Ask `/cos` to start one. It runs
   `node cos.mjs new <slug> --what "..." --github`, which makes the folder,
   git, a CLAUDE.md and a private GitHub repo under your account.

## Daily use

Open one chat in this folder and run `/cos`. Ask in plain words: "status of
everything", "tell my-app to add dark mode", "start a new project for X".
Each worker shows up as its own session in the sidebar.

Optional: a morning brief. Make a scheduled task in the desktop app that runs
`/cos` on weekdays and saves the brief to `reports/`, read-only.

## Things to know

- **Usage.** Several workers at once, each with helper agents and a reviewer,
  use a lot of your plan's limit. Start with one or two.
- **Trust prompts.** The first time a worker starts in a folder, the app asks
  you to trust it. Only one prompt shows at a time.
- **Checks.** `node --test test/*.test.mjs` runs this harness's own tests.
