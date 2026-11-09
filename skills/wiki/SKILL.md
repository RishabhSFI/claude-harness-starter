---
name: wiki
description: The owner's project wiki, which carries facts between chats. Use to look up what was decided, who someone is, what a term means, or which tools a project uses ("what did we decide about X", "who is Y", "what does Z mean"), to file a report or chat notes into it ("add this to the wiki", "ingest this"), to update a project's page after work lands, or to check the wiki's health.
---

# Project wiki

Below, `H` means the harness folder, the one `install.sh` linked this skill
from: `~/.claude/skills/wiki` is a link to `H/skills/wiki`, so
`readlink ~/.claude/skills/wiki` shows it. The wiki is `H/wiki/`. Its
schema, `H/wiki/WIKI.md`, has the full rules. Read it before you write a
page.

## Ask it first

For any question about past decisions, people, vendors, terms or a
project's state, read the wiki before you guess or search chats:

1. Read `H/wiki/index.md`, then the pages it points to.
2. If you don't know where to look: `node H/wiki.mjs search <words>`.
3. Answer with the page and its source. If the wiki doesn't know, say so,
   then look in the project. If you find the answer, add it to the wiki.

A project's page: `node H/wiki.mjs page <project-id>`. A project with no
page yet: `node H/wiki.mjs new-page <project-id>` writes one from the
template (`cos.mjs new` does this for new projects).

## Add a source (ingest)

A report, a research note, a chat extract, or something the owner told you:

1. Save it as a file if it isn't one, then
   `node H/wiki.mjs ingest <file> --title "<title>" --origin "<where from>"`.
   It copies the file into `H/wiki/raw/` with a header, makes a best-effort
   pass to blank emails, phone numbers and secrets, and logs it. The pass
   misses formats it doesn't know, so never paste secrets into a source:
   take them out before you ingest. Never edit a raw file afterwards.
2. Read it and update every page it touches. Cite it on each page and bump
   `updated`. Add new pages to `index.md`.

## Record a merged PR

`node H/wiki.mjs record <project-id> --pr <owner/repo#n>` files a merged
PR: its body goes to `raw/` (secrets blanked), and a dated bullet goes under
`## Changes` at the end of the project's page, with `updated` and `log.md`
kept in step. Rerunning it changes nothing. The daily review runs it after
merges, so don't write these
bullets by hand.

## Update a page

When work is checked and real, update the project page's Decisions, What's
built and Open items, bump `updated`, and append to `H/wiki/log.md`:
`## [YYYY-MM-DD] update | <project>: <what changed>`. Then commit the wiki
changes in `H`.

## Check it (lint)

`node H/wiki.mjs lint`. Errors (broken links, a project with no page) exit
1; fix them now. Warnings list stale pages, orphans, pages missing from the
index and missing frontmatter. Fix what you can and log the pass as `lint`.

## Rules

- Facts only, each with its source. Mark guesses as guesses.
- Never write secrets, keys, passwords, emails or phone numbers into the
  wiki.
- The wiki holds notes about real people. It stays private and never goes
  into a public repo.
