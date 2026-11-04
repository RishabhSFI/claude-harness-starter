#!/bin/sh
# Links the cos skill and global CLAUDE.md into ~/.claude and registers the
# UserPromptSubmit hook. Safe to rerun. Pass --dry-run to only print actions.
set -eu

DRY=0
[ "${1:-}" = "--dry-run" ] && DRY=1

# Always the main checkout, even when run from a task worktree, so the links
# and the hook outlive the worktree.
HERE=$(cd "$(dirname "$0")" && pwd -P)
HARNESS=$(cd "$(git -C "$HERE" rev-parse --path-format=absolute --git-common-dir)/.." && pwd -P)
CLAUDE_DIR="$HOME/.claude"
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
link "$HARNESS/skills/until-ready" "$CLAUDE_DIR/skills/until-ready" refuse
link "$HARNESS/global/CLAUDE.md" "$CLAUDE_DIR/CLAUDE.md" warn

# One backup of settings.json as it was before this run.
if [ "$DRY" -eq 0 ] && [ -f "$CLAUDE_DIR/settings.json" ]; then
  cp "$CLAUDE_DIR/settings.json" "$CLAUDE_DIR/settings.json.bak"
fi

node - "$HARNESS" "$CLAUDE_DIR/settings.json" "$DRY" <<'EOF' || STATUS=1
const fs = require('node:fs');
const path = require('node:path');
const [harness, file, dry] = process.argv.slice(2);
const command = `node "${harness}/cos.mjs" hook`;

const exists = fs.existsSync(file);
const settings = exists ? JSON.parse(fs.readFileSync(file, 'utf8')) : {};
const groups = ((settings.hooks ??= {}).UserPromptSubmit ??= []);
const isCos = (h) => /cos\.mjs"? hook$/.test(h.command ?? '');
const present = groups.some((g) => (g.hooks ?? []).some((h) => h.command === command));
const stale = groups.some((g) => (g.hooks ?? []).some((h) => isCos(h) && h.command !== command));

if (present && !stale) {
  console.log(`already hook in ${file}`);
} else if (dry === '1') {
  console.log(`[dry-run] added hook ${command} to ${file}`);
} else {
  for (const g of groups) g.hooks = (g.hooks ?? []).filter((h) => !isCos(h));
  settings.hooks.UserPromptSubmit = groups.filter((g) => g.hooks.length);
  settings.hooks.UserPromptSubmit.push({ hooks: [{ type: 'command', command, timeout: 5 }] });
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, JSON.stringify(settings, null, 2) + '\n');
  console.log(`added hook ${command} to ${file}`);
}
EOF

# The gate's Stop hook. It does nothing unless /until-ready turned a gate on
# for that session.
node - "$HARNESS" "$CLAUDE_DIR/settings.json" "$DRY" <<'EOF' || STATUS=1
const fs = require('node:fs');
const path = require('node:path');
const [harness, file, dry] = process.argv.slice(2);
const command = `node "${harness}/gate/qa-gate.mjs"`;

const exists = fs.existsSync(file);
const settings = exists ? JSON.parse(fs.readFileSync(file, 'utf8')) : {};
const groups = ((settings.hooks ??= {}).Stop ??= []);
const isGate = (h) => /qa-gate\.mjs"?$/.test(h.command ?? '');
const present = groups.some((g) => (g.hooks ?? []).some((h) => h.command === command));
const stale = groups.some((g) => (g.hooks ?? []).some((h) => isGate(h) && h.command !== command));

if (present && !stale) {
  console.log(`already gate hook in ${file}`);
} else if (dry === '1') {
  console.log(`[dry-run] added gate hook ${command} to ${file}`);
} else {
  for (const g of groups) g.hooks = (g.hooks ?? []).filter((h) => !isGate(h));
  settings.hooks.Stop = groups.filter((g) => g.hooks.length);
  settings.hooks.Stop.push({ hooks: [{ type: 'command', command, timeout: 1800 }] });
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, JSON.stringify(settings, null, 2) + '\n');
  console.log(`added gate hook ${command} to ${file}`);
}
EOF

exit "$STATUS"
