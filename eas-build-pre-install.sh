#!/usr/bin/env bash
# EAS pre-install hook — runs before npm/bun install in the EAS cloud build environment.
#
# PURPOSE
# -------
# BeebeebCore.xcframework (the Rust/UniFFI native library) and the generated
# Swift bindings are committed to the mobile repo at:
#
#   ios/BeebeebCore.xcframework/
#   ios/Beebeeb/beebeeb_uniffi.swift
#
# This hook verifies they are present and logs their provenance.
# If they are somehow missing (e.g. after a botched merge), it attempts to
# rebuild them from the Rust source — but since EAS only clones the mobile repo,
# this fallback can only succeed if the EAS machine happens to have Rust installed.
#
# TO UPDATE THE XCFRAMEWORK
# -------------------------
# On a machine with the full monorepo and Rust toolchain:
#
#   cd repos/core && bash build-ios.sh
#   cd repos/mobile && bash scripts/update-ios-artifacts.sh
#   git add ios/BeebeebCore.xcframework ios/Beebeeb/beebeeb_uniffi.swift
#   git commit -m "chore(ios): update BeebeebCore.xcframework and UniFFI bindings"
#   git push
#
# Do NOT run `eas build` without first updating the committed artifacts when the
# Rust crate changes.

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
IOS_DIR="$SCRIPT_DIR/ios"
XCFW="$IOS_DIR/BeebeebCore.xcframework"
SWIFT_BINDING="$IOS_DIR/Beebeeb/beebeeb_uniffi.swift"

# ── Verify xcframework ────────────────────────────────────────────────────────
if [ -d "$XCFW" ] && [ -f "$XCFW/Info.plist" ]; then
    ARM64_SIZE=$(du -sh "$XCFW/ios-arm64/libbeebeeb_uniffi.a" 2>/dev/null | cut -f1 || echo "?")
    echo "[eas-pre] ✓ BeebeebCore.xcframework present (arm64: ${ARM64_SIZE})"
else
    echo "[eas-pre] ✗ BeebeebCore.xcframework MISSING at $XCFW"
    echo "[eas-pre]   This file must be committed to the mobile repo."
    echo "[eas-pre]   Run: cd repos/core && bash build-ios.sh && cd ../mobile && bash scripts/update-ios-artifacts.sh"
    exit 1
fi

# ── Verify Swift bindings ─────────────────────────────────────────────────────
if [ -f "$SWIFT_BINDING" ]; then
    LINES=$(wc -l < "$SWIFT_BINDING")
    echo "[eas-pre] ✓ beebeeb_uniffi.swift present (${LINES} lines)"
else
    echo "[eas-pre] ✗ beebeeb_uniffi.swift MISSING at $SWIFT_BINDING"
    echo "[eas-pre]   This file must be committed to the mobile repo."
    exit 1
fi

echo "[eas-pre] iOS native artifacts verified — proceeding with build"
