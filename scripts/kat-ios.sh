#!/usr/bin/env bash
# kat-ios.sh — local gate for task 1382 (audit item K2, mobile half).
#
# Runs the CoreVectorsKATTests XCTest target (ios/BeebeebNativeTests/CoreVectorsKATTests.swift),
# which drives repos/core/test-vectors/vectors.json (vendored at
# ios/BeebeebNativeTests/Vectors/core-vectors.v4.json) through the SAME production UniFFI Swift
# bindings the app links, proving mobile decrypts/derives byte-identically to core for every
# vector family the UniFFI surface exposes.
#
# THIS IS A LOCAL GATE, NOT A CI GATE. The mobile repo's GitHub Actions workflow runs `typecheck`
# only — macOS runners are not enabled here (Guus: Actions minutes are exhausted). Run this by
# hand after any change that touches beebeeb_uniffi.swift, BeebeebCore.xcframework, or
# repos/core/test-vectors/vectors.json. See CLAUDE.md "Tests" section.
#
# Usage: scripts/kat-ios.sh [simulator-udid]
#   Defaults to bb-qa-2 (C44A5FD9-42B4-4334-934C-E4D9C3D76041). NEVER pass bb-qa-1310
#   (D41C3AA1-D520-4CEF-A286-5F8717A03B7F) — reserved, see mobile CLAUDE.md "Simulators — three
#   QA sims, one lane per sim".
#
# Serializes under the shared ios-build semaphore (scripts/coord/with-lock.sh, workspace-wide) and
# retries up to 10x / 60s apart if another lane holds the lock — matches the "wait 60s and retry
# up to 10x" convention used by lanes dispatched against this same semaphore.
set -euo pipefail

DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$(cd "$DIR/.." && pwd)"

# Resolve the workspace root via git-common-dir, NOT a naive "../.." — this script must work both
# from the primary checkout (repos/mobile) and from any `git worktree` (e.g.
# ~/code/bb-worktrees/mobile-NNNN), where "two levels up" does not land on the workspace root.
# --git-common-dir always resolves to the PRIMARY repo's .git regardless of which worktree calls
# it (task 1382 hit this directly: kat-ios.sh is committed and run from worktrees routinely).
GIT_COMMON_DIR="$(cd "$REPO_ROOT" && git rev-parse --git-common-dir 2>/dev/null || true)"
if [ -n "$GIT_COMMON_DIR" ]; then
  case "$GIT_COMMON_DIR" in
    /*) : ;;
    *) GIT_COMMON_DIR="$REPO_ROOT/$GIT_COMMON_DIR" ;;
  esac
  PRIMARY_REPO_DIR="$(cd "$(dirname "$GIT_COMMON_DIR")" && pwd)"
  WORKSPACE_ROOT="$(cd "$PRIMARY_REPO_DIR/../.." && pwd)"
else
  WORKSPACE_ROOT="$(cd "$REPO_ROOT/../.." && pwd)"
fi
WITH_LOCK="$WORKSPACE_ROOT/scripts/coord/with-lock.sh"

BB_QA_2="C44A5FD9-42B4-4334-934C-E4D9C3D76041"
BB_QA_1310="D41C3AA1-D520-4CEF-A286-5F8717A03B7F"

UDID="${1:-$BB_QA_2}"
if [ "$UDID" = "$BB_QA_1310" ]; then
  echo "kat-ios.sh: refusing bb-qa-1310 ($BB_QA_1310) — that sim is reserved, never drive it from this script." >&2
  exit 64
fi

if [ ! -x "$WITH_LOCK" ]; then
  echo "kat-ios.sh: expected the shared semaphore at $WITH_LOCK — not found or not executable." >&2
  exit 66
fi

DERIVED_DATA="${KAT_IOS_DERIVED_DATA:-/tmp/dd-kat-ios}"
LOG="${KAT_IOS_LOG:-/tmp/kat-ios-$(date +%s).log}"

echo "kat-ios.sh: running CoreVectorsKATTests on sim $UDID"
echo "kat-ios.sh: log at $LOG"

attempt=0
max_attempts=10
while true; do
  if "$WITH_LOCK" ios-build -- xcodebuild test \
      -project "$REPO_ROOT/ios/Beebeeb.xcodeproj" \
      -scheme CoreVectorsKATTests \
      -destination "id=$UDID" \
      -derivedDataPath "$DERIVED_DATA" \
      > "$LOG" 2>&1; then
    break
  fi
  status=$?
  if grep -q "is locked" "$LOG" 2>/dev/null && [ "$attempt" -lt "$max_attempts" ]; then
    attempt=$((attempt + 1))
    echo "kat-ios.sh: ios-build semaphore busy, retry $attempt/$max_attempts in 60s..." >&2
    sleep 60
    continue
  fi
  echo "kat-ios.sh: xcodebuild test failed (exit $status) — see $LOG" >&2
  tail -n 80 "$LOG" >&2
  exit "$status"
done

# A check must prove it did something before it may report success — assert the count, never
# just the absence of "FAILED".
if grep -qE "Executed [0-9]+ test" "$LOG"; then
  grep -E "Executed [0-9]+ test" "$LOG"
  echo "kat-ios.sh: PASS — full log at $LOG"
else
  echo "kat-ios.sh: no 'Executed N tests' line found in $LOG — treat as RED, the harness never proved it ran anything" >&2
  tail -n 80 "$LOG" >&2
  exit 1
fi
