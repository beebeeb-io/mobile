#!/usr/bin/env bash
set -euo pipefail
cd "$(dirname "$0")/.."
# remote-run and EAS staging directories have no Git metadata.
[ -e .git ] || exit 0
# Git expands home-relative paths; only a still-relative value is repo-relative.
current="$(git config --path --get core.hooksPath || true)"
hooks="$(git rev-parse --absolute-git-dir)/prebuild-guard-hooks"
if [ "$current" = "$hooks" ] || [ "$current" = '.githooks' ]; then
  previous="$(git config --get prebuildguard.previousHooksPath)"
elif [ -n "$current" ]; then
  case "$current" in
    /*) previous="$current" ;;
    *) previous="$(pwd)/$current" ;;
  esac
else
  previous="$(git rev-parse --path-format=absolute --git-common-dir)/hooks"
fi
# Preserve ALL existing hooks, including Git LFS pre-push/post-checkout hooks.
# Generated symlinks stay in this worktree's Git metadata, outside the checkout.
mkdir -p "$hooks"
for hook in "$previous"/*; do
  [ -f "$hook" ] && [ -x "$hook" ] || continue
  ln -sf "$hook" "$hooks/$(basename "$hook")"
done
ln -sf "$(pwd)/.githooks/pre-commit" "$hooks/pre-commit"
# Scope the hook to THIS worktree. Other checkouts retain their existing hooks.
git config extensions.worktreeConfig true
git config --worktree prebuildguard.previousHooksPath "$previous"
git config --worktree core.hooksPath "$hooks"
