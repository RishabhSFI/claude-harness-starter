#!/bin/sh
# One worktree per task, so parallel sessions never share a folder.
#   ~/Projects/claude-harness/gate/worktree.sh new <slug>   make ../<repo>-tasks/<slug> on branch task/<slug>, ready to work
#   ~/Projects/claude-harness/gate/worktree.sh setup        make the current worktree ready (e.g. one the app made)
# Ready means: node_modules (an APFS clone of the main checkout's, instant and
# no extra disk), plus the untracked local files listed in .claude/gate.json
# "local" (env files, settings). Nothing is installed or fetched.
set -e
main=$(cd "$(git rev-parse --path-format=absolute --git-common-dir)/.." && pwd)

setup() {
  dir=$(git rev-parse --show-toplevel)
  [ "$dir" = "$main" ] && { echo "This is the main checkout, nothing to set up."; return; }
  if [ ! -e "$dir/node_modules" ] && [ -d "$main/node_modules" ]; then
    cp -cR "$main/node_modules" "$dir/node_modules"
  fi
  files=$(node -e 'try{console.log((require(process.argv[1]).local||[]).join("\n"))}catch{}' "$dir/.claude/gate.json")
  for f in $files .claude/settings.json; do
    if [ -e "$main/$f" ] && [ ! -e "$dir/$f" ]; then
      mkdir -p "$(dirname "$dir/$f")" && cp -cR "$main/$f" "$dir/$f"
    fi
  done
  echo "Ready: $dir"
}

case "$1" in
  new)
    [ -n "$2" ] || { echo "usage: worktree.sh new <slug>"; exit 2; }
    dir="$main/../$(basename "$main")-tasks/$2"
    # The repo's default branch: origin's HEAD, else main, else master.
    base=$(git -C "$main" symbolic-ref --short refs/remotes/origin/HEAD 2>/dev/null | sed 's#^origin/##')
    [ -n "$base" ] || { git -C "$main" rev-parse -q --verify main >/dev/null && base=main || base=master; }
    git -C "$main" worktree add -b "task/$2" "$dir" "$base"
    cd "$dir" && setup
    echo "Base branch: $base (open the PR against it)"
    ;;
  setup) setup ;;
  *) echo "usage: worktree.sh new <slug> | setup"; exit 2 ;;
esac
