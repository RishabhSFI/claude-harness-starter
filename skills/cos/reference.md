# Chief of Staff: reference

Rarely needed detail, loaded on demand from `SKILL.md` (`H` is the harness folder, as there).

## Hub handoff

When the size hook warns, and at the end of each day's work, put anything
the brief can't see (a decision, a promise to the owner) on the project's
wiki page and write `H/reports/cos-handoff-<date>.md` with **In flight**
(session id, state), **Waiting on the owner**, **To check**, and **What the
last hub learned**. Carry that last section forward from the previous
handoff, add what's new, and drop lines that a tool now does for you.
`node H/cos.mjs learned` prints the newest one. Then keep working in the
same chat.

If the hub chat was lost and the owner starts a replacement, that one becomes
the permanent hub: it works from the handoff, finds workers with
`mcp__ccd_session_mgmt__list_sessions` and a `list_events` status peek
(through `history-reader` beyond that), and checks their PRs directly.

## Status details

- `node H/cos.mjs status` is compact: worktrees show as a count plus the
  ones with unmerged work, uncommitted files or an open PR; `--full` lists
  every worktree. `node H/cos.mjs worktrees` lists stale worktrees (merged or
  gone from the remote, nothing uncommitted) and removes them only with
  `--remove`.
- Missing required secrets (declared per project in `projects.json` as
  `secrets`) show under Needs you; `node H/cos.mjs secrets` lists them all
  with the command that adds each.
- If Needs you starts with a line that the Mac has been up 40+ days, keep it
  first in the brief: past about 49.7 days nothing can reach GitHub until a
  restart.
- A line that a scheduled task differs from its copy in `H/scheduled/`:
  offer to update the task with `mcp__scheduled-tasks__update_scheduled_task`
  (prompt = the file below its `---` line, `~` written out as the home
  folder) and do it on the owner's yes.
- A session whose title is about one project but whose `cwd` is another
  project's folder is misfiled: list it under Needs you and offer to move it.
- Paused chats: `node H/cos.mjs paused --due --json` lists chats stopped at a
  usage limit whose reset has passed. In a chat with the owner, for each entry
  with a `project` and a `localId`, `SendMessage` (`to`: that id): "Your usage
  limit has reset. Continue the task you were working on from where you
  stopped; check your plan and the branch state first." Then run `node
  H/cos.mjs paused --mark <sessionId> --paused-at <pausedAt>`. List the
  other entries under Needs you, and the ones you woke under In flight. The
  scheduled brief only lists them; `scheduled/resume-paused.md` does the same
  for every chat every 30 minutes once the owner turns that task on.

## Worker brief extras

- Harness work with `git config harness.starterRepo` set: add to the brief
  "After the PR merges into main, run `node cos.mjs publish-starter` from the
  harness. If the leak scan fails, fix the source it names. Never skip the
  publish or the scan."
- Fill in `<H>/wiki/projects/<id>.md` with the real path (`node H/wiki.mjs
  page <id>` prints it). Questions and reviews that change nothing skip the
  `/until-ready` line but keep the wiki line.
- Several projects in one request: one session per project in the same
  message. Never two sessions writing in the same project at once unless
  each has its own worktree.
- Connectors the owner doesn't use daily (Vercel, flovia, Claude Docs, iOS
  simulator) can be turned off to shrink every new chat's start. Don't change
  their settings.

## Fast-forwards

The repos are squash-only, so bringing `main` into a long-lived branch can't
be a merge. Instead: a worker builds a sync branch from `origin/<branch>`
with main merged in, and opens no PR. Then run `node H/cos.mjs ff <checkout>
<sync-branch> <branch>`. It refuses unless `<branch>` is an ancestor of the
sync branch, the sync branch's checks are readable and none failing or
pending, and (when `<branch>` is public) at least one check ran. It prints
the one command for the owner: it fetches, stops if `origin/<sync>` is no
longer the commit it checked, then runs `git push origin
refs/remotes/origin/<sync>:refs/heads/<branch>`. With no checks and a private
target it still prints the command, with a "No checks ran" note. It says when
that branch is public, which makes it a go-live step. Labels like
`migration-order-ok` are blocked as a CI bypass; use `ff`, not a label.

## Retired projects

`node H/cos.mjs retire <id>` moves the project to `retired` in
`projects.json` with the date, so status and routing stop listing it. Its wiki page stays. Rerunning it is harmless. To bring one back,
edit `projects.json` by hand.

## New projects

A folder that already exists: `node H/cos.mjs add <folder> --what "<one
line>" --keywords a,b`. It registers the folder without changing anything in
it, sets `public` to its default branch, and prints what still needs filling
in. Ask the owner what else makes it public (deploy commands, emails) and add
it to `public.notes`.

Something new:

1. Pick a short slug (lowercase, hyphens) and one line on what it is.
2. Run `node H/cos.mjs new <slug> --what "<one line>" --github`. It makes
   `~/Projects/<slug>` with git, a CLAUDE.md that sets pstack and
   `/until-ready` as the way work happens, a private GitHub repo, adds it
   to `projects.json`, and writes its wiki page,
   `H/wiki/projects/<slug>.md`, from the template (through `node H/wiki.mjs
   new-page <slug>`; if that step failed, run it yourself, since the wiki
   lint fails while a project has no page). Commit `projects.json` and
   `wiki/` in `H`. If auto mode blocks the GitHub step, rerun without
   `--github`, carry on, and give the owner the one command to run themselves:
   `gh repo create <your GitHub name>/<slug> --private --source
   ~/Projects/<slug> --push`. The GitHub name comes from `--owner`, else from
   the account `gh` is signed in as.
3. Start its first worker (`cwd` the new folder) with the owner's idea as the
   goal. The brief also asks it to add the project's gate once there is code,
   and to fill in "What's public" in its CLAUDE.md when a deploy exists.
   Update `public` in `projects.json` to match.

## Daily brief

The scheduled task "Chief of Staff morning brief" runs on weekdays and
writes `H/reports/cos-<date>.md`. It lists every request in
`wiki/topics/owner-requests.md` not marked done, oldest first, with how long
each has waited, and every worker in flight with its session id, project, PR
and next step, and the open decisions. If `H/wiki` exists, it also runs `node
H/wiki.mjs lint` and lists stale or broken pages in one line. If the owner
asks "what did I miss", read the latest one first.

## pr-check in a repo with no CI

`pr-check` fails a PR with no checks reported, because missing is not a pass.
For a repo that has no CI at all (status already lists its PRs as mergeable),
rerun with `--allow-no-checks`; the other lines still apply. Don't drop such a
PR from the merge batch for this alone.

## Optional settings

`cos.config.json` next to `cos.mjs` (copy `cos.config.example.json`; the real
file is gitignored) holds optional settings. Absent means today's behaviour.
- `maxWorkers` (default 3), read by `node H/cos.mjs cap --working N`.
- `roleModels` and `workerModelAfterStart` (default null: never switch),
  read by `node H/cos.mjs worker-model <role>`.
- `stopAllModels` 85, `stopFable` 90, `hardStop` 95, `softStopBefore` (compared with `stop-rule --now <ISO time>`, default the current time), and
  `targetLow`/`targetHigh` 90/97, read by `stop-rule` and `rate`.
