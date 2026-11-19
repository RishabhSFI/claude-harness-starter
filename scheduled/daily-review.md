# Daily harness review

Prompt for a scheduled task that runs every morning before the brief. It
reviews the last 24 hours of sessions and sweeps every project.

The owner creates the task; no session creates it on its own. Proposed
schedule: daily at 7:30 (cron `30 7 * * *`), task name
`daily-harness-review`, folder `~/Projects/claude-harness`. `node cos.mjs
status` warns when the installed prompt differs from this file.

Everything below the line is the prompt.

---

Run the daily harness review. Read ~/Projects/claude-harness/REVIEW.md in full and follow it exactly. It tells you how to build the digest of the last 24 hours of Claude Code sessions (python3 -I ~/Projects/claude-harness/digest.py), what to look for, what you may change on your own (only memory notes, ledger.md and the report), and the report format.

Also run `node ~/Projects/claude-harness/gate/leak-scan.mjs --sites` as REVIEW.md says; any finding goes at the top of the report under "Needs you".

Read ~/Projects/claude-harness/RULES.md too: a lesson that repeats on a rule nothing enforces gets a fix one rung up, never another note. For every ledger row whose Result says `check <date>` on or before today, check whether its Expected happened, as REVIEW.md's "Ledger format" says: write `held` with the evidence, or `missed` with the evidence and set the row back to `reopened` instead of counting it as done. When you mark a row `applied`, write its Expected and a `check` date three days on.

Write the report to ~/Projects/claude-harness/reports/<today's date>.md and update ~/Projects/claude-harness/ledger.md. Then commit both in ~/Projects/claude-harness (git add -f reports ledger.md && git commit -m "Harness review <date>"). That folder is the only git repo you may commit in.

Never edit files inside other project folders, never run git there, never start or stop servers, never change settings, and never copy a secret into any file. End with the report's one-line summary and its path.
