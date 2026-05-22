#!/usr/bin/env bash
# Update the committed iOS native artifacts from the local Rust build.
#
# Run this after `repos/core/build-ios.sh` produces a new xcframework.
# Then commit the result and push so EAS builds use the fresh artifacts.
#
# Usage:
#   cd repos/core && bash build-ios.sh
#   cd repos/mobile && bash scripts/update-ios-artifacts.sh
#   git add ios/BeebeebCore.xcframework ios/Beebeeb/beebeeb_uniffi.swift
#   git commit -m "chore(ios): update BeebeebCore.xcframework and UniFFI bindings"

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
MOBILE_DIR="$(cd "$SCRIPT_DIR/.." && pwd)"
if [ -d "$MOBILE_DIR/../core" ]; then
    CORE_DIR="$(cd "$MOBILE_DIR/../core" && pwd)"
elif [ -d "$MOBILE_DIR/../../core" ]; then
    CORE_DIR="$(cd "$MOBILE_DIR/../../core" && pwd)"
else
    echo "ERROR: repos/core not found — run from inside the monorepo"
    exit 1
fi

XCFW_SRC="$CORE_DIR/BeebeebCore.xcframework"
XCFW_DST="$MOBILE_DIR/ios/BeebeebCore.xcframework"
SWIFT_SRC="$CORE_DIR/beebeeb-uniffi/bindings/beebeeb_uniffi.swift"
SWIFT_DST="$MOBILE_DIR/ios/Beebeeb/beebeeb_uniffi.swift"

# Verify source xcframework exists
if [ ! -d "$XCFW_SRC" ]; then
    echo "ERROR: $XCFW_SRC not found"
    echo "Run: cd repos/core && bash build-ios.sh"
    exit 1
fi

echo "Stripping debug symbols from arm64 slice..."
xcrun strip -S "$XCFW_SRC/ios-arm64/libbeebeeb_uniffi.a" -o /tmp/libbeebeeb_uniffi_arm64_stripped.a

echo "Copying xcframework to ios/..."
rm -rf "$XCFW_DST"
cp -r "$XCFW_SRC" "$XCFW_DST"
# Replace arm64 .a with stripped version
cp /tmp/libbeebeeb_uniffi_arm64_stripped.a "$XCFW_DST/ios-arm64/libbeebeeb_uniffi.a"
rm -f /tmp/libbeebeeb_uniffi_arm64_stripped.a

echo "Copying Swift bindings..."
cp "$SWIFT_SRC" "$SWIFT_DST"

ARM64_SIZE=$(du -sh "$XCFW_DST/ios-arm64/libbeebeeb_uniffi.a" | cut -f1)
SIM_SIZE=$(du -sh "$XCFW_DST/ios-arm64_x86_64-simulator/"* | tail -1 | cut -f1)
TOTAL=$(du -sh "$XCFW_DST" | cut -f1)
SWIFT_LINES=$(wc -l < "$SWIFT_DST")

echo ""
echo "✓ Updated:"
echo "  ios/BeebeebCore.xcframework  (arm64: ${ARM64_SIZE}, sim: ${SIM_SIZE}, total: ${TOTAL})"
echo "  ios/Beebeeb/beebeeb_uniffi.swift  (${SWIFT_LINES} lines)"
echo ""
echo "Next steps:"
echo "  git add ios/BeebeebCore.xcframework ios/Beebeeb/beebeeb_uniffi.swift"
echo "  git commit -m \"chore(ios): update BeebeebCore.xcframework and UniFFI bindings\""
