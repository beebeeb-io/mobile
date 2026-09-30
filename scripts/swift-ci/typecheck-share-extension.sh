#!/usr/bin/env bash
# Task 1671 — Swift compile gate for the iOS Share Extension.
#
# Until this existed NO Swift was compiled by CI (ci.yml had only ubuntu jobs),
# so a Swift compile error in the extension (a `static` helper called
# unqualified from an instance method) reached a gated-by-nothing branch and
# would have failed only in a TestFlight build. This runs `swiftc -typecheck`
# over the extension's sources against the iOS simulator SDK.
#
# What it typechecks, twice:
#   1. ios/BeebeebShare/*  — the file list is READ from the BeebeebShare target's
#      "Sources" build phase in project.pbxproj (scripts/swift-ci/share-target-sources.py),
#      so it is exactly what the target compiles.
#   2. targets/share-extension/* — the same list with the ios/BeebeebShare/<f>
#      entries swapped for targets/share-extension/<f>. That directory is the
#      SOURCE OF TRUTH: `expo prebuild` copies it over ios/BeebeebShare/
#      (targets/share-extension/CLAUDE.md).
# Plus a sync check: every ios/BeebeebShare/*.swift must be byte-identical to
# its targets/share-extension/ original (cmp follows the BeebeebKeychainCore
# symlink). No prior guard existed for this drift.
#
# Needs macOS + Xcode (xcrun, iphonesimulator SDK). Not runnable on Linux.
set -uo pipefail
cd "$(dirname "$0")/../.."

rc=0
LOG_DIR="${SWIFT_CI_LOG_DIR:-$(mktemp -d)}"
mkdir -p "$LOG_DIR"

SDK="$(xcrun --sdk iphonesimulator --show-sdk-path)"
HDR="ios/BeebeebCore.xcframework/ios-arm64_x86_64-simulator/Headers"
[ -f "$HDR/module.modulemap" ] || { echo "missing $HDR/module.modulemap" >&2; exit 1; }
xcrun swiftc --version

# The same deployment target the BeebeebShare target uses (IPHONEOS_DEPLOYMENT_TARGET = 16.0),
# simulator arch of the runner. APPLICATION_EXTENSION_API_ONLY = YES in the target
# -> -application-extension. SWIFT_VERSION = 5.
typecheck() {
  local label="$1"; shift
  local log="$LOG_DIR/typecheck-$label.log"
  echo "== typecheck [$label]: $# files"
  printf '   %s\n' "$@"
  xcrun swiftc -typecheck \
    -sdk "$SDK" \
    -target arm64-apple-ios16.0-simulator \
    -swift-version 5 \
    -application-extension \
    -Xcc "-fmodule-map-file=$HDR/module.modulemap" \
    -Xcc "-I$HDR" \
    "$@" >"$log" 2>&1
  local status=$?
  cat "$log"
  local errors
  errors=$(grep -c ': error:' "$log" || true)
  if [ "$status" -ne 0 ]; then
    echo "TYPECHECK FAILED [$label]: swiftc exit $status, $errors error line(s)"
    return 1
  fi
  echo "typecheck [$label]: ok, $# files, 0 errors"
}

SOURCES_FILE="$LOG_DIR/share-sources.txt"
if ! python3 scripts/swift-ci/share-target-sources.py >"$SOURCES_FILE"; then
  echo "could not read the BeebeebShare Sources phase" >&2
  exit 1
fi
XCODE_FILES=()
TARGETS_FILES=()
while IFS= read -r f; do
  XCODE_FILES+=("$f")
  case "$f" in
    ios/BeebeebShare/*.swift) TARGETS_FILES+=("targets/share-extension/${f#ios/BeebeebShare/}") ;;
    *) TARGETS_FILES+=("$f") ;;
  esac
done <"$SOURCES_FILE"
if [ "${#XCODE_FILES[@]}" -lt 5 ]; then
  echo "only ${#XCODE_FILES[@]} sources found in the BeebeebShare target; refusing a vacuous pass" >&2
  exit 1
fi

typecheck "xcodeproj-ios-BeebeebShare" "${XCODE_FILES[@]}" || rc=1
typecheck "targets-share-extension" "${TARGETS_FILES[@]}" || rc=1

echo "== sync check: ios/BeebeebShare/*.swift vs targets/share-extension/*.swift"
checked=0
drift=0
for f in ios/BeebeebShare/*.swift; do
  name="$(basename "$f")"
  checked=$((checked + 1))
  if ! cmp -s "$f" "targets/share-extension/$name"; then
    echo "DRIFT: $f differs from targets/share-extension/$name"
    drift=$((drift + 1))
  fi
done
echo "sync check: $checked files compared, $drift drifted"
[ "$checked" -ge 5 ] || { echo "sync check compared only $checked files" >&2; rc=1; }
[ "$drift" -eq 0 ] || rc=1

# Wiring guard for the 1671 "HTTP 201" bug. The unit tests cover the policy
# function but not that ShareUploader USES it; a hardcoded `statusCode == 200`
# in an upload step is exactly the regression (init returns 201, chunk/complete
# return 200). Every step must go through ShareUploadRequestPolicy.isSuccessResponse.
echo "== wiring guard: no hardcoded 2xx status comparison in ShareUploader.swift"
hard=$(grep -nE 'statusCode[[:space:]]*(==|!=|>=|<)[[:space:]]*(2[0-9][0-9]|300)' \
  ios/BeebeebShare/ShareUploader.swift targets/share-extension/ShareUploader.swift || true)
uses=$(grep -c 'ShareUploadRequestPolicy.isSuccessResponse' targets/share-extension/ShareUploader.swift || true)
if [ -n "$hard" ]; then
  echo "HARDCODED STATUS COMPARISON (use ShareUploadRequestPolicy.isSuccessResponse):"
  echo "$hard"
  rc=1
fi
if [ "$uses" -lt 3 ]; then
  echo "ShareUploader.swift calls isSuccessResponse $uses time(s); expected >= 3 (init, chunk, complete)"
  rc=1
fi
echo "wiring guard: $uses isSuccessResponse call(s), $(printf '%s' "$hard" | grep -c . || true) hardcoded comparison(s)"

if [ "$rc" -eq 0 ]; then
  echo "SHARE EXTENSION GATE: PASS (2 typechecks, ${#XCODE_FILES[@]} files each, $checked files in sync)"
else
  echo "SHARE EXTENSION GATE: FAIL"
fi
exit "$rc"
