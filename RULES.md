# Rule table

Each rule in `global/CLAUDE.md`, paired with what enforces it. The daily
review reads this (REVIEW.md, "Rule table"). A lesson that repeats on a rule
whose enforcer is "nothing" or a warning is a repeat: propose the fix at the
highest rung that works (structure, then a check whose error names the fix,
then a test, docs last). When an enforcer lands, change its row in the same
change. Drop a row once its mistake can't happen.

Enforcer kinds: **hook** (Claude Code runs it; a block stops the tool call),
**check** (a command whose FAIL a hook or gate acts on), **gate** (a
`.claude/gate.json` step), **test** (`node --test test/*.test.mjs`),
**review** (the daily review looks for it after the fact), **nothing**.

| Rule (global/CLAUDE.md) | Enforced by | Kind |
| --- | --- | --- |
| Right folder first | `cos.mjs hook` (UserPromptSubmit) adds a note when the prompt names a project in another folder; nothing blocks work in the wrong folder | hook, warn only |
| New sites and apps get a real folder | nothing | nothing |
| Done for UI or wording changes: unslop and a pstack review | `cos.mjs pr-check` `reviewer` line needs a named review; nothing checks that unslop ran | check (review only) |
| Every feature works on a phone (375 and 390, screenshots in the PR) | `pr-check` `phone-shots` line, FLAG only: it never blocks | check, warn only |
| Loop until ready | `gate/qa-gate.mjs` Stop hook, once `/until-ready` is on; nothing turns it on | hook, opt-in |
| Build with pstack | the pstack SessionStart hook injects the mandate; nothing checks it was followed | hook, warn only |
| One task per session | nothing | nothing |
| Write state down at ~80k tokens of growth | `size-guard.mjs` via `cos.mjs hook` warns once | hook, warn only |
| Big reads and chat history go to `reader` / `history-reader` | nothing | nothing |
| A worker ends its turn only at a PR, blocked, or with a question | nothing | nothing |
| Size reviews: Opus for 150+ lines or auth, money, deletion or merge logic | `pr-check` `review-model` line; `walls.mjs` blocks `gh pr merge` until pr-check passes | check + hook |
| Security audit before a PR | `gate/security-audit.mjs` as a gate step where a project's gate has it; `pr-check` `security-audit` line (needs the section), blocked at merge by `walls.mjs` | gate, check + hook |
| Frontends run `leak-scan.mjs --dir <build>` | nothing per PR; the daily review runs `leak-scan.mjs --sites` on what is live | review |
| Asked vs delivered in every report and PR | `pr-check` `asked-vs-delivered` and `scope-check` lines, blocked at merge by `walls.mjs`; `scope-check.mjs --file` for reports with no PR | check + hook |
| Always review: an independent reviewer, required checks COMPLETED and green | `pr-check` `reviewer` and `checks` lines; `walls.mjs` blocks `gh pr merge` until pr-check passes. Docs, artifacts and emails: nothing | check + hook |
| Releases: public merges need the owner's go-ahead in this session | `pr-check` `owner-questions` FAILs a public (or undeclared) base with open owner questions, blocked at merge by `walls.mjs`. Nothing checks the go-ahead itself | check + hook (partial) |
| Publishing the starter | `make-starter.mjs` refuses to publish when its leak scan finds anything; nothing runs `publish-starter` after a merge | check (partial) |
| GitHub: your own repo only | `walls.mjs`: `git push` only to `origin`, `gh pr`/`gh repo` only with `-R <origin>` | hook |
| Lessons on the right layer | the daily review's ledger (rung per row) and this table | review |
| All my projects at once goes to `/cos` | nothing | nothing |
| `global/CLAUDE.md` stays under 6600 bytes, the cos skill under 16 KB | `test/cos-tools.test.mjs` | test |
