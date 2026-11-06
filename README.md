# claude-harness

One chat runs all your projects. You tell it what you want ("add a dark mode
to the recipe app"), and it starts a worker session in that project. The
worker keeps going until the project's own checks pass (tests, build, lint),
then opens a pull request. Nothing public happens without you: anything that
puts work in front of other people (a production deploy, merging into the
live branch, sending email) waits for your go-ahead in the chat.

What's in here:

- `cos.mjs` and `skills/cos/`: the Chief of Staff, the hub chat (`/cos`).
- `gate/` and `skills/until-ready/`: the loop that won't let a worker stop
  until the checks pass (`/until-ready`). `gate/security-audit.mjs` and
  `skills/security-audit/` (Cloudflare's skill, MIT) add a security audit of
  each change as one gate step.
- `global/CLAUDE.md`: rules for every session.
- `wiki.mjs`, `skills/wiki/` and `starter-wiki/`: a wiki your sessions keep,
  so facts survive from one chat to the next.
- `mc/`: mission control, a local page showing every project and a task
  queue (`node cos.mjs mc`).
- `projects.json`: your project list, made empty on first run.
  `projects.example.json` shows a filled-in one. Projects you stop working
  on move to its `retired` list (`node cos.mjs retire <id>`).
- `CHANGELOG.md`: what changed in each starter release.

## What you need

- The Claude desktop app. The Chief of Staff starts and messages other
  sessions, and those session tools only exist in the desktop app.
- Node 20 or newer (`node --version`).
- The GitHub CLI, signed in (`gh auth login`, then `gh auth status`).
- Auto mode, if your plan has it. Workers then run without asking you about
  every command.

## Install

1. Install pstack, the way of working the workers follow. In Claude Code,
   run these one at a time:

   ```
   /plugin marketplace add michael-denyer/pstack-claude
   /plugin install pstack@pstack-claude
   /setup-pstack
   ```

2. Clone the starter to `~/Projects/claude-harness`. The skills and rules
   point there. Keep the starter as the remote called `upstream`, which is
   how you get updates later:

   ```
   git clone https://github.com/RishabhSFI/claude-harness-starter.git ~/Projects/claude-harness
   cd ~/Projects/claude-harness
   git remote rename origin upstream
   ```

   A different folder works too, but then search the files for
   `~/Projects/claude-harness` and change it.

3. From the folder, see what the installer will do, then run it:

   ```
   sh install.sh --dry-run
   sh install.sh
   ```

   It links the four skills and the global rules into `~/.claude`, and adds
   two hooks to `~/.claude/settings.json` (it saves a `.bak` copy first).
   It's safe to run again.

   If you already have a `~/.claude/CLAUDE.md`, it won't overwrite it. Copy
   the rules from `global/CLAUDE.md` into yours by hand.

4. Keep your copy in a private GitHub repo:

   ```
   gh repo create claude-harness --private --source . --push
   ```

   Or add a remote by hand: `git remote add origin
   https://github.com/<your GitHub name>/claude-harness.git`, then
   `git push -u origin main`.

## Getting updates

The starter gets new commits when its author improves the harness. To pull
them in:

```
node cos.mjs update --check    # lists what's new, changes nothing
node cos.mjs update            # merges it, then runs install.sh and the tests
```

`update` needs a clean tree (commit your changes first). It merges the
`upstream` remote and never touches your own files (see below). If one of
the starter's files conflicts with a change you made, it stops, undoes the
merge and lists the files, so nothing is left half done. Then merge by hand
with `git merge upstream/main`, fix the files, commit, and run `update`
again.

Your copy is older than this feature? Fetch the update command once, by hand:

```
git remote add upstream https://github.com/RishabhSFI/claude-harness-starter.git   # skip if you already have it
git fetch upstream
git checkout upstream/main -- starter-update.mjs
git commit -m "Get the update command"
node starter-update.mjs
```

If you downloaded a zip instead of cloning, first make it a git repo
(`git init && git add -A && git commit -m "My harness"`), run the lines
above, and end with `node starter-update.mjs --adopt`. That one time, the
starter's version wins for the harness files, and your own files stay as
they are.

## Your files

These are yours. The starter never ships them, `update` never changes them,
and `.gitignore` lists them so they stay out of the harness history:

- `projects.json`: your project list.
- `wiki/`: your notes, made from `starter-wiki/` on the first run.
- `ledger.md`: lessons the daily review keeps.
- `reports/`: reports the Chief of Staff writes.
- `mc/state/`: mission control's queue and settings.

Install (or any `cos` command) creates the ones that are missing. If you
want them backed up in your private repo, run `git add -f projects.json`
once (and likewise for the others); git then tracks them even though
`.gitignore` lists them.

## Add your projects

For each project folder you already have:

```
node cos.mjs add ~/Projects/my-app --what "One line on what it is" --keywords "words,you,use,for,it"
```

It changes nothing in the folder. It reads the GitHub repo and default
branch, adds an entry to `projects.json`, and marks the default branch as
public. For a brand new project, ask the Chief of Staff to start one, or
run `node cos.mjs new <name> --what "..." --github`.

Then fill in `public` for each project in `projects.json`, carefully. It
decides what the Chief of Staff may merge or deploy on its own:

- `branches`: branches that go live when something lands in them.
- `remotes`: git remotes that put the site out when pushed to.
- `notes`: anything else that's public, such as `vercel deploy --prod`, live
  database changes, or a job that emails people.

Anything not listed there, the Chief of Staff may do without asking. When
it's unsure, it treats the action as public and asks you. If you leave
`public` out entirely, the default branch counts as public.

## Give each project its checks

The loop only runs in a project that has a `.claude/gate.json` listing its
checks. Open a session in the project and type `/until-ready`. With no gate
yet, it drafts one from the project's real checks and asks you to approve
it. Or ask the Chief of Staff: "add a gate to my-app".

## Use it

Open a session in this folder in the desktop app and type `/cos`. It tells
you where each project stands and what needs you. Then ask for things in
plain words. `node cos.mjs status` prints the same overview in a terminal.

## Optional: a morning brief

You can have the brief waiting for you each morning. In the desktop app,
make a scheduled task that runs in this folder on the days you want, with
`/cos` as its prompt plus a line saying it should only read and report, not
merge or deploy anything. The Chief of Staff already treats its scheduled
run as read-only, and writes the brief to `reports/cos-<date>.md`.

## Cost

Each worker is a full Claude session, and several running at once use a lot
of your plan's usage. Start with one or two projects and one task at a time
until you know what it costs you.
