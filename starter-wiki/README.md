# Project wiki

A wiki your Claude sessions keep for you, so facts survive from one chat to
the next. It follows Andrej Karpathy's
[LLM Wiki](https://gist.github.com/karpathy/442a6bf555914893e9891c11519de94f)
pattern: raw sources you never edit, pages the LLM writes and keeps current,
an index, an append-only log, and a schema that says how.

To start:

1. Copy this folder to `wiki/` next to `wiki.mjs` and `projects.json`.
2. Run `node wiki.mjs lint`. It lists every project in `projects.json` that
   has no page yet.
3. Ask Claude to write those pages. `WIKI.md` tells it how.
4. When you have a report, notes or a chat worth keeping, run
   `node wiki.mjs ingest <file> --title "..." --origin "..."` and ask Claude
   to work it into the pages.

The wiki holds notes about real people and your own work. Keep it private.
