#!/usr/bin/env bash
# check-prebuild-test-targets.sh — CI-friendly gate for task 1562.
#
# ProvenanceHeadersTests and CoreVectorsKATTests (tasks 1439/1382) are
# host-less XCTest bundle targets, now owned by plugins/native-tests/
# withNativeTestTargets.js. Before that plugin existed they were hand-added
# straight into ios/Beebeeb.xcodeproj/project.pbxproj with no config plugin
# behind them (unlike every extension target — see plugins/lib/
# extension-target.js), so a `expo prebuild --clean` silently dropped both
# targets — and, at the time, the ios/BeebeebNativeTests/ source files
# themselves, which lived ONLY inside ios/ — with no warning short of
# `scripts/kat-ios.sh` failing outright ("scheme not found"). This script
# re-runs a clean prebuild and asserts both targets, their autocreated
# schemes (no .xcscheme is committed for either — same as before task 1562;
# xcodebuild autocreates one per target when none is shared), and their
# canonical source files all survive it.
#
# THIS IS A LOCAL GATE, NOT A CI GATE — same caveat as scripts/kat-ios.sh:
# the mobile repo's GitHub Actions workflow runs `typecheck` only, on a Linux
# runner with no Xcode (macOS runner minutes are exhausted). Run this by hand
# after touching app.json's plugin list, plugins/native-tests/,
# plugins/lib/xctest-target.js, plugins/lib/extension-target.js, or
# targets/native-tests/. No simulator is needed — `xcodebuild -list` only
# enumerates the project's targets/schemes, it does not build or run
# anything.
#
# Usage:
#   scripts/check-prebuild-test-targets.sh                 # runs a clean prebuild + restore, then checks
#   scripts/check-prebuild-test-targets.sh --skip-prebuild  # checks whatever's already in ios/ (fast re-check; also what kat-ios.sh's own prior prebuild step leaves behind)
set -euo pipefail

DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$(cd "$DIR/.." && pwd)"
cd "$REPO_ROOT"

REQUIRED_TARGETS=(ProvenanceHeadersTests CoreVectorsKATTests)
REQUIRED_FILES=(
  "targets/native-tests/ProvenanceHeadersTests.swift"
  "targets/native-tests/CoreVectorsKATTests.swift"
  "targets/native-tests/Vectors/core-vectors.v4.json"
)

if [ "${1:-}" != "--skip-prebuild" ]; then
  echo "check-prebuild-test-targets.sh: running a clean prebuild (bunx expo prebuild --platform ios --clean --no-install)..."
  bunx expo prebuild --platform ios --clean --no-install
  echo "check-prebuild-test-targets.sh: restoring vendored files (scripts/restore-vendored-ios.sh)..."
  ./scripts/restore-vendored-ios.sh
fi

fail=0

for f in "${REQUIRED_FILES[@]}"; do
  if [ ! -f "$f" ]; then
    echo "check-prebuild-test-targets.sh: RED — missing source file $f (a clean prebuild must never delete this — it lives outside ios/ precisely so --clean can't touch it)" >&2
    fail=1
  fi
done

if [ ! -f ios/Beebeeb.xcodeproj/project.pbxproj ]; then
  echo "check-prebuild-test-targets.sh: RED — ios/Beebeeb.xcodeproj/project.pbxproj not found; did prebuild run?" >&2
  exit 1
fi

# A check must prove it did something before it may report success — assert
# on the structured `xcodebuild -list` output, never a bare text grep of the
# pbxproj (a target can appear in a PBXFileReference comment without being a
# real, buildable PBXNativeTarget wired into PBXProject.targets).
LIST_LOG="$(mktemp -t check-prebuild-test-targets)"
trap 'rm -f "$LIST_LOG"' EXIT
/usr/bin/xcodebuild -list -project ios/Beebeeb.xcodeproj > "$LIST_LOG" 2>&1 || true

if ! /usr/bin/grep -q "^Information about project" "$LIST_LOG"; then
  echo "check-prebuild-test-targets.sh: RED — 'xcodebuild -list' never printed project info; treat as RED, not a pass by absence of failure" >&2
  cat "$LIST_LOG" >&2
  exit 1
fi

targets_block="$(awk '/^    Targets:/{flag=1; next} /^$/{flag=0} flag' "$LIST_LOG" | awk '{$1=$1};1')"
schemes_block="$(awk '/^    Schemes:/{flag=1; next} /^$/{flag=0} flag' "$LIST_LOG" | awk '{$1=$1};1')"

for target in "${REQUIRED_TARGETS[@]}"; do
  if ! printf '%s\n' "$targets_block" | /usr/bin/grep -qx "$target"; then
    echo "check-prebuild-test-targets.sh: RED — target '$target' missing from 'xcodebuild -list' Targets: after a clean prebuild" >&2
    fail=1
  fi
  if ! printf '%s\n' "$schemes_block" | /usr/bin/grep -qx "$target"; then
    echo "check-prebuild-test-targets.sh: RED — scheme '$target' missing from 'xcodebuild -list' Schemes: (target exists but autocreation did not pick it up, or no shared scheme is committed for it)" >&2
    fail=1
  fi
done

if [ "$fail" -ne 0 ]; then
  echo "--- xcodebuild -list output ---" >&2
  cat "$LIST_LOG" >&2
  exit 1
fi

echo "check-prebuild-test-targets.sh: PASS — ProvenanceHeadersTests + CoreVectorsKATTests survive a clean prebuild (targets + schemes + source files all present)"
