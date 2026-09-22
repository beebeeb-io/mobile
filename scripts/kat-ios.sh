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
  # Do NOT gate on this command's own process exit status (see the note below the loop for why)
  # — `set +e`/`set -e` bracket it so a nonzero return never trips this script's own `errexit`.
  set +e
  "$WITH_LOCK" ios-build -- xcodebuild test \
      -project "$REPO_ROOT/ios/Beebeeb.xcodeproj" \
      -scheme CoreVectorsKATTests \
      -destination "id=$UDID" \
      -derivedDataPath "$DERIVED_DATA" \
      > "$LOG" 2>&1
  status=$?
  set -e

  if grep -q "is locked" "$LOG" 2>/dev/null && [ "$attempt" -lt "$max_attempts" ]; then
    attempt=$((attempt + 1))
    echo "kat-ios.sh: ios-build semaphore busy, retry $attempt/$max_attempts in 60s..." >&2
    sleep 60
    continue
  fi
  break
done

# Do NOT trust $status as the pass/fail signal. Reproduced directly (task 1382 Codex review):
# `xcodebuild test` against this host-less bundle.unit-test target returns process exit 0 even for
# a hard failure ("xcodebuild: error: Unable to find a device matching the provided destination
# specifier") when invoked as the condition of a shell `if` inside a script — the SAME command run
# directly at a prompt correctly returns 70. Confirmed with `bash -x` + manual instrumentation:
# `status=$?` really does read 0 immediately after the failed command, with nothing in between that
# could reset it. Root cause not fully pinned (this Mac's Xcode is an iOS/watchOS 27 beta — plausibly
# a reporting quirk there), and not worth chasing further: the fix is to stop depending on a process
# exit code we've proven unreliable, and gate on the one signal xcodebuild always writes truthfully —
# the structured "Executed N tests, with S skipped and F failures (U unexpected)" summary line.
#
# A check must prove it did something before it may report success — assert the count, never just
# the absence of "FAILED" or a trusted-blindly exit code.
SUMMARY_LINE="$(grep -E "Executed [0-9]+ test" "$LOG" | tail -1 || true)"

if [ -z "$SUMMARY_LINE" ]; then
  echo "kat-ios.sh: no 'Executed N tests' line found in $LOG (process exit was $status) — treat as RED, the harness never proved it ran anything" >&2
  tail -n 80 "$LOG" >&2
  exit 1
fi

echo "$SUMMARY_LINE"

if echo "$SUMMARY_LINE" | grep -qE "[1-9][0-9]* failures?"; then
  echo "kat-ios.sh: RED — summary line reports a nonzero failure count (process exit was $status, not trusted — see comment above)" >&2
  tail -n 80 "$LOG" >&2
  exit 1
fi

echo "kat-ios.sh: PASS — full log at $LOG"
