# How this wiki works

This is the schema. Read it before you touch the wiki. It follows Andrej
Karpathy's "LLM Wiki" pattern: raw sources you never edit, pages the LLM
writes and keeps current, and this file saying how.

The owner reads the wiki. You (the LLM) write it. Its job is to carry facts
between chats, so a session that starts cold can read one page and know
what the last ten sessions learned.

## Layout

```
WIKI.md        this schema
index.md       every page, one line each, by section
log.md         append-only timeline of ingests, updates, queries and lints
projects/      one page per project in projects.json, named <id>.md
people/        people the projects serve or involve
vendors/       outside services, tools and companies
topics/        ideas, policies and terms that cut across projects
raw/           sources, copied in once and never edited
```

`wiki.mjs` sits next to the wiki folder. It checks the wiki, copies sources
in, finds a project's page and searches. It never writes pages; you do.

```
node wiki.mjs lint
node wiki.mjs ingest <file> --title "<title>" --origin "<where it came from>"
node wiki.mjs record <project-id> --pr <owner/repo#n>
node wiki.mjs page <project-id>
node wiki.mjs search <words>
```

## Page conventions

Every page under `projects/`, `people/`, `vendors/` and `topics/` starts
with frontmatter:

```yaml
---
updated: 2026-01-31
sources:
  - "[[raw/2026-01-31-some-source]]"
tags: [project]
---
```

- `updated` is the day you last changed a fact on the page.
- `sources` lists the raw sources the page draws on, as links. When a fact
  came from the owner in chat, ingest a short note of what they said first,
  then cite it. A fact that lives in a file kept current elsewhere (like
  `projects.json`) can cite that file by its path instead.
- `tags` is a short list. Use `project`, `person`, `vendor` or `topic`,
  plus anything that helps.

Then a `# Title` and the facts. Rules:

- **Facts only, each with its source.** End a fact with its source link,
  like `([[raw/2026-01-31-some-source]])`. Say who decided something and
  when. Mark a guess as a guess.
- **Link generously.** Use `[[folder/name]]` links to other pages. A page
  nobody links to gets lost. The links work in Obsidian, but Obsidian isn't
  needed.
- **Newest decisions win, old ones stay.** When a fact changes, update it
  and keep the old one under "Earlier" with its date, so the history reads
  straight.
- **Never copy secrets, keys, passwords, emails or phone numbers** into any
  page. Name the setting ("the Gmail app password in the repo secrets"), not
  its value.
- Plain words, short sentences.
- To show a literal double bracket, put it in backticks, like
  `` `[[ ]]` ``, so it isn't read as a link.

A project page has these sections, in this order. Write "Nothing yet" rather
than leave one out.

1. **What it is.** One paragraph: vision and the problem.
2. **Who it's for.** Users and customers, linked to `people/` pages.
3. **What's built.** What works today, and how real it is.
4. **Decisions.** A dated list: `- 2026-01-31: <decision> (by <who>) ([[source]])`.
5. **Tools and vendors.** What it uses, linked to `vendors/` pages.
6. **Open items.** What's left, and who it waits on.
7. **What's public.** What makes it visible to the world, and what needs
   the owner's review.
8. **Links.** Repos, live URLs, folders, related pages.

A project page may end with a ninth section, **Changes**, which only
`wiki.mjs record` writes: one line per merged PR, in date order,
`- 2026-01-31: <PR title> ([owner/repo#n](url)) ([[raw/<file>|raw]])`. The
raw file is the PR's body, named `<merge date>-pr-<owner>-<repo>-<n>`.
`updated` moves to the merge date if that is newer. Don't edit these lines;
add decisions and open items in their own sections.

`projects/_template.md` has the empty shape. Files starting with `_` are
templates and the lint skips them.

## Raw sources

`raw/` holds sources exactly as they came: reports, research, chat extracts,
pasted notes. Each starts with a header giving its title, date and origin.
`wiki.mjs ingest` writes that header, makes a best-effort pass to blank
emails, phone numbers and secrets, and names the file
`raw/<date>-<slug>.md`. The pass misses formats it doesn't know, so never
paste secrets into a source; take them out first. Never edit a raw file
after that. A newer version is a new source.

## Operations

### Ingest (a new source)

1. `node wiki.mjs ingest <file> --title "..." --origin "..."`. It copies the
   file into `raw/` and adds a line to `log.md`.
2. Read the source. Update every page it touches: project, people, vendors,
   topics. Add new pages where something deserves one. One source often
   touches many pages.
3. Cite the source on each page you changed, and bump `updated`.
4. Add new pages to `index.md`.
5. Run the lint.

### Record (a merged PR)

`node wiki.mjs record <project-id> --pr <owner/repo#n>` does the
mechanical part of an update for one merged PR: raw source, Changes line,
`updated`, and a `log.md` entry. It refuses a PR that isn't merged or whose
repo isn't in the project's `repos`, and a rerun changes nothing.

### Update (after work happens)

When a session's work is checked and real (a merged PR, a decision the
owner made, a fact confirmed), update the project's page: Decisions, What's
built, Open items. Bump `updated`. Append to `log.md`:

```
## [2026-01-31] update | <project>: <what changed>

<one or two lines, with links>
```

If the fact came from chat rather than a file, ingest a short note of it
first so the page has a source.

### Query (a question)

1. Read `index.md`, then the pages it points to. `node wiki.mjs search
   <words>` helps when you don't know where to look.
2. Answer from the wiki, citing pages. Say plainly when the wiki doesn't
   know, then look in the project itself.
3. If the answer took real work and will be asked again, file it as a page
   (or add it to one) and log it as `query`.

### Lint (a health check)

`node wiki.mjs lint` lists:

- broken `[[links]]` (error),
- a project in `projects.json` with no page (error; `wiki.mjs new-page
  <id>` writes one from the template),
- pages missing frontmatter, raw sources missing their header,
- pages missing from `index.md`, and pages nothing links to,
- project pages whose `updated` date is more than 14 days older than the
  project's last commit,
- `log.md` headings in the wrong shape.

It exits 1 on errors and only warns on the rest. Fix errors right away. For
a stale page, read the project's recent commits and update the page. Also
look for what the script can't: facts that contradict each other, claims a
newer source has replaced, and things mentioned often that deserve a page.
Log the pass as `lint`.

## index.md and log.md

`index.md` lists every page under a section heading (Projects, People,
Vendors, Topics), one line each: link, then a few words. Update it whenever
you add a page.

`log.md` only grows. Every entry starts `## [YYYY-MM-DD] <op> | <title>`,
where op is `ingest`, `create`, `update`, `query` or `lint`.
`grep "^## \[" log.md | tail -5` shows the last five.
