#!/usr/bin/env bash
# Restore the files `expo prebuild` (with or without --clean) deletes or
# overwrites but which are NOT reproducible from config plugins (task 1305):
#   - ios/BeebeebCore.xcframework      vendored Rust static libs (from core's build-ios.sh)
#   - ios/Beebeeb/beebeeb_uniffi.swift vendored UniFFI Swift bindings
#   - ios/.xcode.env                   ENTRY_FILE pin (task 0671) — prebuild resets it
#   - ios/BeebeebWidget/BeebeebWidget.swift   widget source (not plugin-managed)
#   - ios/Beebeeb/PrivacyInfo.xcprivacy, workspace data
# The uniffi-bridge plugin only re-copies the first two when ../../core exists
# next to the project (never true in a worktree or an eas staging dir), so the
# committed copies are the source of truth. Run after EVERY prebuild:
#   bunx expo prebuild --platform ios [--clean] && scripts/restore-vendored-ios.sh
set -euo pipefail
cd "$(dirname "$0")/.."
git checkout -- \
  ios/BeebeebCore.xcframework \
  ios/Beebeeb/beebeeb_uniffi.swift \
  ios/.xcode.env \
  ios/BeebeebWidget/BeebeebWidget.swift \
  ios/Beebeeb/PrivacyInfo.xcprivacy \
  ios/Beebeeb.xcworkspace/contents.xcworkspacedata 2>/dev/null || true
grep -q 'ENTRY_FILE="src/App.tsx"' ios/.xcode.env || { echo "ERROR: ios/.xcode.env lost the ENTRY_FILE pin (0671)"; exit 1; }
[ -d ios/BeebeebCore.xcframework/ios-arm64 ] || { echo "ERROR: BeebeebCore.xcframework missing"; exit 1; }
echo "vendored iOS files restored"
