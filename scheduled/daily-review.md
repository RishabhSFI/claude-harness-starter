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

Write the report to ~/Projects/claude-harness/reports/<today's date>.md and update ~/Projects/claude-harness/ledger.md. Then commit both in ~/Projects/claude-harness (git add reports ledger.md && git commit -m "Harness review <date>"). That folder is the only git repo you may commit in.

Never edit files inside other project folders, never run git there, never start or stop servers, never change settings, and never copy a secret into any file. End with the report's one-line summary and its path.
