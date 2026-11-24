# Changelog

## 2026-11-24, harness 49f2879

- 51 changes

## 2026-11-22, harness 1539dc9

- 61 changes

## 2026-11-19, harness 27a2f8b

- 9 changes

## 2026-11-19, harness 72104a9

- 45 changes

## 2026-11-19, harness 7ee6db7

History was reset to one commit. This release includes:

- Chief of Staff hub (`/cos`, `cos.mjs`): project status, worker sessions per project, PR checks (`pr-check`), usage limits and paused-session resume.
- until-ready gate: loops a worker until the project's checks pass, stops early when the same failure repeats twice, and carries a dead-ends list into each retry.
- Security audit step, scope review and "Asked vs delivered" checks for every PR.
- Wiki (`wiki.mjs`, `skills/wiki/`), history-reader and reader agents, global rules and pstack model sheet.
- Scheduled tasks: morning brief, daily review, resume paused sessions.
- `cos.mjs update` to pull new starter releases.
