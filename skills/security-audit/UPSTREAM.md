# Upstream

This folder is a verbatim copy of `skills/security-audit/` from
https://github.com/cloudflare/security-audit-skill, plus its `LICENSE`.

- Commit: c1c8a8c1471069fb0e188eeaff69b8e8db6564a8
- Copied: 2026-11-05
- License: MIT, Copyright 2025-2026 Cloudflare (see `LICENSE`)

Don't edit the upstream files. The only files that are ours are this one and
`gate/security-audit.mjs` in the harness, which calls the skill in guidance
mode on a diff.

To update: download the repo at the new commit into an empty folder, diff its
`skills/security-audit/` against this one, read the whole diff (the two `.cjs`
validators are the only code; check they still use only `fs`, `path` and
`util`), then copy the files over and change the commit above.
