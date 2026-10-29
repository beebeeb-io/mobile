#!/usr/bin/env bash
# Task 1669 — iOS app compile gate (main app + modules/beebeeb-crypto Swift).
#
# Until this existed NOTHING compiled the app's own Swift in CI (ci.yml had ubuntu
# jobs only; the sister Share-Extension gate, task 1671, covers only ios/BeebeebShare).
# A Swift error in modules/beebeeb-crypto/ios/*.swift (NativeBackupEngine.swift,
# BeebeebAppDelegate.swift, ...) therefore only surfaced in a TestFlight build.
#
# Builds the `Beebeeb` scheme for the iOS simulator, UNSIGNED, arm64 only, Debug
# (Debug skips the Metro "Bundle React Native code" phase). ios/ is committed, so no
# `expo prebuild` (and no scripts/restore-vendored-ios.sh — that only repairs what a
# prebuild destroys). Needs macOS + Xcode + CocoaPods + node + bun. Not runnable on Linux.
#
# Truth lines (asserted, not just the exit code): the log must contain
# `** BUILD SUCCEEDED **` exactly once AND show the BeebeebCrypto pod compiling
# NativeBackupEngine.swift and BeebeebAppDelegate.swift — a build that never touched
# the files this gate exists for is a RED, not a pass.
set -uo pipefail
cd "$(dirname "$0")/../.."

LOG_DIR="${SWIFT_CI_LOG_DIR:-$(mktemp -d)}"
mkdir -p "$LOG_DIR"
POD_LOG="$LOG_DIR/pod-install.log"
BUILD_LOG="$LOG_DIR/xcodebuild.log"

# The xcframework's static libs are Git LFS objects; without `git lfs pull` they are ~130-byte
# pointer files and the link step dies with "unknown file type" (first CI run of this gate).
SIM_LIB="ios/BeebeebCore.xcframework/ios-arm64_x86_64-simulator/libbeebeeb_uniffi_sim_fat.a"
if [ "$(wc -c <"$SIM_LIB")" -lt 1000000 ]; then
  echo "$SIM_LIB is not the real static library (Git LFS pointer?): run git lfs pull" >&2
  exit 1
fi

xcodebuild -version
xcrun --sdk iphonesimulator --show-sdk-version

bun install --frozen-lockfile || { echo "bun install failed" >&2; exit 1; }

echo "== pod install"
( cd ios && pod install ) >"$POD_LOG" 2>&1
pod_status=$?
tail -n 15 "$POD_LOG"
if [ "$pod_status" -ne 0 ]; then
  echo "POD INSTALL FAILED (exit $pod_status)" >&2
  exit 1
fi

echo "== xcodebuild (Beebeeb, iphonesimulator, Debug, arm64, unsigned)"
xcodebuild \
  -workspace ios/Beebeeb.xcworkspace \
  -scheme Beebeeb \
  -sdk iphonesimulator \
  -configuration Debug \
  -destination 'generic/platform=iOS Simulator' \
  -derivedDataPath "$LOG_DIR/DerivedData" \
  ONLY_ACTIVE_ARCH=YES ARCHS=arm64 \
  CODE_SIGNING_ALLOWED=NO CODE_SIGNING_REQUIRED=NO CODE_SIGN_IDENTITY="" \
  build >"$BUILD_LOG" 2>&1
build_status=$?

errors=$(grep -c ': error:' "$BUILD_LOG" || true)
succeeded=$(grep -c '\*\* BUILD SUCCEEDED \*\*' "$BUILD_LOG" || true)
engine=$(grep -c 'NativeBackupEngine\.swift' "$BUILD_LOG" || true)
delegate=$(grep -c 'BeebeebAppDelegate\.swift' "$BUILD_LOG" || true)
echo "xcodebuild exit=$build_status errors=$errors build_succeeded=$succeeded engine_lines=$engine delegate_lines=$delegate"

if [ "$build_status" -ne 0 ] || [ "$succeeded" -ne 1 ] || [ "$errors" -ne 0 ]; then
  echo "---- first errors ----"
  grep -E ': error:|error: ' "$BUILD_LOG" | head -n 40
  echo "---- log tail ----"
  tail -n 60 "$BUILD_LOG"
  echo "IOS BUILD GATE: FAIL"
  exit 1
fi
if [ "$engine" -lt 1 ] || [ "$delegate" -lt 1 ]; then
  echo "build succeeded but never compiled NativeBackupEngine.swift / BeebeebAppDelegate.swift: refusing a vacuous pass" >&2
  echo "IOS BUILD GATE: FAIL (vacuous)"
  exit 1
fi
echo "IOS BUILD GATE: PASS (BUILD SUCCEEDED, 0 error lines, NativeBackupEngine.swift x$engine, BeebeebAppDelegate.swift x$delegate)"
