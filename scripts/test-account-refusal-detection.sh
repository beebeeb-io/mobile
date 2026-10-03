#!/usr/bin/env bash
set -euo pipefail

# Task 1605 (PR #155 review thread PRRT_kwDOSLX6T86nRLw0) — standalone
# swiftc unit test for `modules/beebeeb-crypto/ios/AccountRefusalDetection.swift`.
# No Xcode project, no simulator, no Pods dependency: compiles the REAL
# shipped source file together with the test driver
# (`scripts/swift-tests/account-refusal-detection-test.swift`) and runs it
# directly. Mirrors `AccountMismatchDetection.swift`'s own doc comment,
# which documents this exact pattern for that sibling file.
#
# This does NOT run in CI (no Swift toolchain there, same as `kat-ios.sh` —
# see repos/mobile CLAUDE.md's "Native crypto KAT" section) — run by hand
# after touching AccountRefusalDetection.swift.

cd "$(dirname "$0")/.."

SRC="modules/beebeeb-crypto/ios/AccountRefusalDetection.swift"
DRIVER="scripts/swift-tests/account-refusal-detection-test.swift"

if [ ! -f "$SRC" ]; then
  echo "Expected file not found: $SRC" >&2
  exit 1
fi
if [ ! -f "$DRIVER" ]; then
  echo "Expected file not found: $DRIVER" >&2
  exit 1
fi

TMP="$(mktemp -d)"
trap 'rm -rf "$TMP"' EXIT

# swiftc only allows top-level executable statements in a file literally
# named `main.swift` when compiling more than one file together — copy the
# driver in under that name (the REAL source file, AccountRefusalDetection.swift,
# is compiled unmodified, straight from its real path).
cp "$DRIVER" "$TMP/main.swift"

swiftc -O "$SRC" "$TMP/main.swift" -o "$TMP/account_refusal_detection_test"
"$TMP/account_refusal_detection_test"
