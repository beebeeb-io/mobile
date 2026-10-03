#!/usr/bin/env bash
# Task 1671 — compile and run every scripts/swift-tests/*-test.swift.
#
# Each driver is compiled with the REAL shipped source file(s) it tests
# (never a re-typed copy), same pattern as scripts/test-account-refusal-detection.sh:
# swiftc only allows top-level statements in a file named main.swift, so the
# driver is copied in under that name. Needs a Swift toolchain (macOS runner).
#
# The MANIFEST below maps driver -> sources under test. A driver present in
# scripts/swift-tests/ but missing from the manifest FAILS the run, so a new
# test can never be silently skipped.
#
# Truth line: `swift-tests: N assertions across F files, 0 failed` (asserts
# the counts, not a terminator string; F must equal the drivers on disk).
set -uo pipefail
cd "$(dirname "$0")/../.."

# driver basename | space-separated sources under test
MANIFEST=(
  "account-refusal-detection-test.swift|modules/beebeeb-crypto/ios/AccountRefusalDetection.swift"
  "share-upload-request-policy-test.swift|targets/share-extension/ShareUploadRequestPolicy.swift targets/file-provider/AccountMismatchDetection.swift"
  "share-recent-folders-test.swift|targets/share-extension/ShareRecentFolders.swift"
)

LOG_DIR="${SWIFT_CI_LOG_DIR:-$(mktemp -d)}"
mkdir -p "$LOG_DIR"
rc=0
files=0
assertions=0

on_disk=$(ls scripts/swift-tests/*-test.swift | wc -l | tr -d ' ')
for driver in scripts/swift-tests/*-test.swift; do
  base="$(basename "$driver")"
  found=0
  for entry in "${MANIFEST[@]}"; do
    [ "${entry%%|*}" = "$base" ] && found=1
  done
  if [ "$found" -eq 0 ]; then
    echo "UNREGISTERED TEST: $base is not in the MANIFEST of scripts/swift-ci/run-swift-tests.sh"
    rc=1
  fi
done

for entry in "${MANIFEST[@]}"; do
  base="${entry%%|*}"
  srcs="${entry#*|}"
  driver="scripts/swift-tests/$base"
  [ -f "$driver" ] || { echo "MANIFEST entry has no driver on disk: $driver"; rc=1; continue; }
  tmp="$(mktemp -d)"
  cp "$driver" "$tmp/main.swift"
  echo "== $base  (sources: $srcs)"
  # shellcheck disable=SC2086
  if ! xcrun swiftc -swift-version 5 -O $srcs "$tmp/main.swift" -o "$tmp/t" >"$LOG_DIR/$base.build.log" 2>&1; then
    cat "$LOG_DIR/$base.build.log"
    echo "COMPILE FAILED: $base"
    rc=1
    continue
  fi
  "$tmp/t" >"$LOG_DIR/$base.run.log" 2>&1
  status=$?
  cat "$LOG_DIR/$base.run.log"
  n=$(sed -n 's/^.*: \([0-9][0-9]*\) assertions, 0 failed$/\1/p' "$LOG_DIR/$base.run.log")
  if [ "$status" -ne 0 ] || [ -z "$n" ]; then
    echo "TEST FAILED: $base (exit $status, passing-count line ${n:-absent})"
    rc=1
    continue
  fi
  files=$((files + 1))
  assertions=$((assertions + n))
done

if [ "$files" -ne "$on_disk" ]; then
  echo "only $files of $on_disk test files passed"
  rc=1
fi
if [ "$rc" -eq 0 ]; then
  echo "swift-tests: $assertions assertions across $files files, 0 failed"
else
  echo "swift-tests: FAILED ($files of $on_disk files passed, $assertions assertions counted)"
fi
exit "$rc"
