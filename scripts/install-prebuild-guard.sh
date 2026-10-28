#!/usr/bin/env bash
set -euo pipefail
cd "$(dirname "$0")/.."
# remote-run and EAS staging directories have no Git metadata.
[ -e .git ] || exit 0
current="$(git config --get core.hooksPath || true)"
[ "$current" != '.githooks' ] || exit 0
if [ -n "$current" ]; then
  case "$current" in
    /*) previous="$current" ;;
    *) previous="$(pwd)/$current" ;;
  esac
else
  previous="$(git rev-parse --path-format=absolute --git-common-dir)/hooks"
fi
# Scope the hook to THIS worktree. Other checkouts retain their existing hooks.
git config extensions.worktreeConfig true
git config --worktree prebuildguard.previousHooksPath "$previous"
git config --worktree core.hooksPath .githooks
