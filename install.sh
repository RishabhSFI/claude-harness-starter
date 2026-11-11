#!/bin/sh
# Links the cos, wiki, until-ready, security-audit and scope-review skills, the history-reader and reader agents and global CLAUDE.md into ~/.claude and
# registers the hooks: the wrong-folder and chat-size warning (UserPromptSubmit) and the
# until-ready gate (Stop), and sets CLAUDE_CODE_AUTO_COMPACT_WINDOW=300000 in settings.json env when unset. Safe to rerun. Pass --dry-run to only print actions.
set -eu

DRY=0
[ "${1:-}" = "--dry-run" ] && DRY=1

# Always the main checkout, even when run from a task worktree, so the links
# and the hook outlive the worktree.
HERE=$(cd "$(dirname "$0")" && pwd -P)
# Outside git (an unzipped copy) it is just this folder.
if COMMON=$(git -C "$HERE" rev-parse --path-format=absolute --git-common-dir 2>/dev/null); then
  HARNESS=$(cd "$COMMON/.." && pwd -P)
else
  HARNESS=$HERE
fi
CLAUDE_DIR="$HOME/.claude"

# The skills refer to ~/Projects/claude-harness by name.
if [ "$HARNESS" != "$(cd "$HOME" && pwd -P)/Projects/claude-harness" ]; then
  printf 'warning: this folder is %s, but the skills expect ~/Projects/claude-harness. Move it there and rerun.\n' "$HARNESS"
fi
STATUS=0

say() {
  if [ "$DRY" -eq 1 ]; then printf '[dry-run] %s\n' "$*"; else printf '%s\n' "$*"; fi
}

# link TARGET DEST REPLACE_REAL_FILE_POLICY(refuse|warn)
link() {
  target=$1 dest=$2 policy=$3
  if [ -L "$dest" ] && [ "$(readlink "$dest")" = "$target" ]; then
    printf 'already linked %s -> %s\n' "$dest" "$target"
    return
  fi
  # A real file, or a link to something else that still exists, belongs to the owner.
  if [ -e "$dest" ]; then
    if [ "$policy" = refuse ]; then
      printf 'refusing: %s already exists, move it away first\n' "$dest"
      STATUS=1
    else
      printf 'warning: %s already exists, left untouched\n' "$dest"
    fi
    return
  fi
  say "linked $dest -> $target"
  if [ "$DRY" -eq 0 ]; then
    mkdir -p "$(dirname "$dest")"
    ln -sfn "$target" "$dest"
  fi
}

link "$HARNESS/skills/cos" "$CLAUDE_DIR/skills/cos" refuse
link "$HARNESS/skills/wiki" "$CLAUDE_DIR/skills/wiki" refuse
link "$HARNESS/skills/until-ready" "$CLAUDE_DIR/skills/until-ready" refuse
link "$HARNESS/skills/security-audit" "$CLAUDE_DIR/skills/security-audit" refuse
link "$HARNESS/skills/scope-review" "$CLAUDE_DIR/skills/scope-review" refuse
# Vendored emilkowalski/skills (MIT): one link per skill folder.
for d in "$HARNESS"/skills/vendor/emilkowalski/*/; do
  [ -f "${d}SKILL.md" ] || continue
  n=$(basename "$d")
  link "$HARNESS/skills/vendor/emilkowalski/$n" "$CLAUDE_DIR/skills/$n" refuse
done
link "$HARNESS/agents/history-reader.md" "$CLAUDE_DIR/agents/history-reader.md" refuse
link "$HARNESS/agents/reader.md" "$CLAUDE_DIR/agents/reader.md" refuse
link "$HARNESS/global/CLAUDE.md" "$CLAUDE_DIR/CLAUDE.md" warn
link "$HARNESS/global/pstack-models.md" "$CLAUDE_DIR/pstack-models.md" warn

# Keep settings.json as it was before the first install, once. Later runs
# never overwrite that copy.
BACKUP="$CLAUDE_DIR/settings.json.before-harness"
if [ "$DRY" -eq 0 ] && [ -f "$CLAUDE_DIR/settings.json" ] && [ ! -e "$BACKUP" ]; then
  cp "$CLAUDE_DIR/settings.json" "$BACKUP"
fi

# Your own files (projects.json, wiki/, ledger.md, reports/) are made when missing.
if [ "$DRY" -eq 1 ]; then
  say "would create any of projects.json, ledger.md, wiki/ and reports/ that are missing"
else
  node "$HERE/cos.mjs" init --harness "$HARNESS" || STATUS=1
fi

node - "$HARNESS" "$CLAUDE_DIR/settings.json" "$DRY" <<'EOF' || STATUS=1
const fs = require('node:fs');
const path = require('node:path');
const [harness, file, dry] = process.argv.slice(2);

// One row per hook. `ours` recognises an older copy of the same hook (another
// folder) so a rerun replaces it instead of adding a second one.
const HOOKS = [
  { event: 'UserPromptSubmit', command: `node "${harness}/cos.mjs" hook`, timeout: 5, ours: /cos\.mjs"? hook$/ },
  { event: 'Stop', command: `node "${harness}/gate/qa-gate.mjs"`, timeout: 1800, ours: /gate\/qa-gate\.mjs"?$/ },
];

// Settings env values set only when the owner has not set them. A fresh desktop chat already holds 85k-123k tokens,
// so a 150k window compacted after ~50k of real work. 300k leaves room for the size warning in `cos.mjs hook`
// (80k of growth) to fire first; compaction is the fallback (the setting accepts 100000 to 1000000).
const ENV = { CLAUDE_CODE_AUTO_COMPACT_WINDOW: '300000' };
// Values an earlier install.sh wrote; a rerun upgrades these but never touches a value the owner chose.
const OLD_ENV = { CLAUDE_CODE_AUTO_COMPACT_WINDOW: '150000' };

const exists = fs.existsSync(file);
const settings = exists ? JSON.parse(fs.readFileSync(file, 'utf8')) : {};
settings.hooks ??= {};
const todo = HOOKS.filter((h) => {
  const groups = settings.hooks[h.event] ?? [];
  const all = groups.flatMap((g) => g.hooks ?? []);
  const current = all.some((x) => x.command === h.command) && !all.some((x) => h.ours.test(x.command ?? '') && x.command !== h.command);
  if (current) console.log(`already hook ${h.command} in ${file}`);
  return !current;
});

const envTodo = Object.entries(ENV).filter(([k]) => {
  const have = settings.env?.[k];
  if (have !== undefined && String(have) !== OLD_ENV[k]) console.log(`already env ${k}=${have} in ${file}`);
  return have === undefined || String(have) === OLD_ENV[k];
});

if (!todo.length && !envTodo.length) {
  // nothing to write
} else if (dry === '1') {
  for (const h of todo) console.log(`[dry-run] added hook ${h.command} to ${file}`);
  for (const [k, v] of envTodo) console.log(`[dry-run] set env ${k}=${v} in ${file}`);
} else {
  if (exists) fs.copyFileSync(file, `${file}.bak`);
  for (const [k, v] of envTodo) {
    settings.env = { ...settings.env, [k]: v };
    console.log(`set env ${k}=${v} in ${file}`);
  }
  for (const h of todo) {
    const groups = settings.hooks[h.event] ?? [];
    for (const g of groups) g.hooks = (g.hooks ?? []).filter((x) => !h.ours.test(x.command ?? ''));
    settings.hooks[h.event] = groups.filter((g) => g.hooks.length);
    settings.hooks[h.event].push({ hooks: [{ type: 'command', command: h.command, timeout: h.timeout }] });
    console.log(`added hook ${h.command} to ${file}`);
  }
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, JSON.stringify(settings, null, 2) + '\n');
}
EOF

exit "$STATUS"
