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
  "shared-key-registry-test.swift|modules/beebeeb-crypto/ios/SharedKeyRegistry.swift"
  "native-preview-working-storage-test.swift|modules/beebeeb-crypto/ios/NativePreviewWorkingStorage.swift"
  "native-video-streamer-harness.swift|scripts/swift-tests/native-video-streamer-stubs.swift modules/beebeeb-crypto/ios/SharedKeyRegistry.swift modules/beebeeb-crypto/ios/NativePreviewWorkingStorage.swift modules/beebeeb-crypto/ios/NativeVideoStreamer.swift"
  "preview-chunk-pipeline-test.swift|modules/beebeeb-crypto/ios/NativePreviewWorkingStorage.swift modules/beebeeb-crypto/ios/PreviewChunkPipeline.swift"
  "empty-preview-frame-test.swift|modules/beebeeb-crypto/ios/NativePreviewWorkingStorage.swift modules/beebeeb-crypto/ios/PreviewChunkPipeline.swift"
  "account-refusal-detection-test.swift|modules/beebeeb-crypto/ios/AccountRefusalDetection.swift"
  "share-upload-request-policy-test.swift|targets/share-extension/ShareUploadRequestPolicy.swift targets/file-provider/AccountMismatchDetection.swift"
  "share-recent-folders-test.swift|targets/share-extension/ShareRecentFolders.swift"
  "backup-manifest-store-test.swift|modules/beebeeb-crypto/ios/BackupManifestStore.swift modules/beebeeb-crypto/ios/PlaintextStorageProtection.swift modules/beebeeb-crypto/ios/RuntimeTrace.swift"
  "sign-out-mark-flush-test.swift|modules/beebeeb-crypto/ios/SignOutMarkFlush.swift modules/beebeeb-crypto/ios/BackupManifestStore.swift"
  "manifest-rebuild-gate-test.swift|modules/beebeeb-crypto/ios/ManifestRebuildGate.swift modules/beebeeb-crypto/ios/BackupManifestStore.swift"
  "photo-backup-route-responses-test.swift|modules/beebeeb-crypto/ios/PhotoBackupServerResponses.swift modules/beebeeb-crypto/ios/BackupManifestStore.swift modules/beebeeb-crypto/ios/ManifestRebuildGate.swift modules/beebeeb-crypto/ios/SignOutMarkFlush.swift"
  "manifest-reopen-test.swift|modules/beebeeb-crypto/ios/BackupManifestHandle.swift modules/beebeeb-crypto/ios/BackupManifestStore.swift modules/beebeeb-crypto/ios/ManifestRebuildGate.swift modules/beebeeb-crypto/ios/ManifestWriteFence.swift"
  "manifest-fail-closed-test.swift|modules/beebeeb-crypto/ios/BackupManifestStore.swift modules/beebeeb-crypto/ios/BackupManifestHandle.swift modules/beebeeb-crypto/ios/ManifestRebuildGate.swift modules/beebeeb-crypto/ios/PhotoBackupServerResponses.swift modules/beebeeb-crypto/ios/ManifestWriteFence.swift"
  "manifest-write-fence-test.swift|modules/beebeeb-crypto/ios/ManifestWriteFence.swift modules/beebeeb-crypto/ios/BackupManifestHandle.swift modules/beebeeb-crypto/ios/BackupManifestStore.swift modules/beebeeb-crypto/ios/ManifestRebuildGate.swift"
  "manifest-account-deletion-test.swift|modules/beebeeb-crypto/ios/BackupManifestHandle.swift modules/beebeeb-crypto/ios/BackupManifestStore.swift modules/beebeeb-crypto/ios/ManifestRebuildGate.swift modules/beebeeb-crypto/ios/ManifestWriteFence.swift"
  "manifest-js-peer-test.swift|modules/beebeeb-crypto/ios/BackupManifestHandle.swift modules/beebeeb-crypto/ios/BackupManifestStore.swift modules/beebeeb-crypto/ios/ManifestRebuildGate.swift modules/beebeeb-crypto/ios/ManifestWriteFence.swift"
  "backup-engine-lifecycle-test.swift|modules/beebeeb-crypto/ios/BackupEngineLifecycle.swift modules/beebeeb-crypto/ios/ManifestWriteFence.swift modules/beebeeb-crypto/ios/BackupManifestStore.swift"
  "backup-device-id-test.swift|modules/beebeeb-crypto/ios/BackupDeviceId.swift modules/beebeeb-crypto/ios/PendingUploadServerCheck.swift modules/beebeeb-crypto/ios/PhotoBackupServerResponses.swift modules/beebeeb-crypto/ios/ManifestRebuildGate.swift modules/beebeeb-crypto/ios/BackupManifestStore.swift"
  "backup-surface-state-test.swift|modules/beebeeb-crypto/ios/BackupSurfaceState.swift modules/beebeeb-crypto/ios/PendingUploadServerCheck.swift modules/beebeeb-crypto/ios/PhotoBackupServerResponses.swift modules/beebeeb-crypto/ios/ManifestRebuildGate.swift modules/beebeeb-crypto/ios/BackupManifestStore.swift"
  "kept-in-flight-upload-test.swift|modules/beebeeb-crypto/ios/BackupManifestStore.swift modules/beebeeb-crypto/ios/ManifestRebuildGate.swift modules/beebeeb-crypto/ios/SignOutMarkFlush.swift modules/beebeeb-crypto/ios/ManifestWriteFence.swift modules/beebeeb-crypto/ios/BackupManifestHandle.swift modules/beebeeb-crypto/ios/PendingUploadServerCheck.swift modules/beebeeb-crypto/ios/PhotoBackupServerClient.swift modules/beebeeb-crypto/ios/PhotoBackupServerResponses.swift"
  "manifest-shm-two-copies-test.swift|modules/beebeeb-crypto/ios/BackupManifestHandle.swift modules/beebeeb-crypto/ios/BackupManifestStore.swift modules/beebeeb-crypto/ios/ManifestRebuildGate.swift modules/beebeeb-crypto/ios/ManifestWriteFence.swift"
  "pending-upload-server-check-test.swift|modules/beebeeb-crypto/ios/PendingUploadServerCheck.swift modules/beebeeb-crypto/ios/PhotoBackupServerClient.swift modules/beebeeb-crypto/ios/PhotoBackupServerResponses.swift modules/beebeeb-crypto/ios/BackupManifestStore.swift modules/beebeeb-crypto/ios/ManifestRebuildGate.swift modules/beebeeb-crypto/ios/ManifestWriteFence.swift modules/beebeeb-crypto/ios/BackupManifestHandle.swift"
  "thumbnail-queue-purge-test.swift|modules/beebeeb-crypto/ios/ThumbnailQueueDB.swift modules/beebeeb-crypto/ios/ThumbnailErrorCategory.swift modules/beebeeb-crypto/ios/PlaintextStorageProtection.swift modules/beebeeb-crypto/ios/RuntimeTrace.swift"
  "legacy-url-cache-cleanup-test.swift|modules/beebeeb-crypto/ios/LegacyURLCacheCleanup.swift"
  "thumbnail-purge-generation-test.swift|modules/beebeeb-crypto/ios/ThumbnailPurgeGeneration.swift"
  "photo-preview-encoder-test.swift|modules/beebeeb-crypto/ios/PhotoPreviewEncoder.swift"
  "thumbnail-variant-policy-test.swift|modules/beebeeb-crypto/ios/ThumbnailServiceTypes.swift"
)

LOG_DIR="${SWIFT_CI_LOG_DIR:-$(mktemp -d)}"
mkdir -p "$LOG_DIR"
rc=0
files=0
assertions=0

on_disk=$(ls scripts/swift-tests/*-test.swift scripts/swift-tests/*-harness.swift | wc -l | tr -d ' ')
for driver in scripts/swift-tests/*-test.swift scripts/swift-tests/*-harness.swift; do
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

# Task 2033: the camera-roll manifest runs on ONE SQLite copy, expo-sqlite's
# (`exsqlite3_*`). A Swift file that `import ManifestSQLite` (the manifest
# files, and drivers that touch a manifest connection) is compiled with the
# SAME module map the app's BeebeebCrypto pod uses
# (modules/beebeeb-crypto/ios/ManifestSQLite, `-I` here, SWIFT_INCLUDE_PATHS
# there) and linked against expo's exact vendored amalgamation, built once
# with ExpoSQLite.podspec's flags as a dylib. A driver that dlopens it
# (BB_EXPO_SQLITE_DYLIB) gets the same image: one copy, as in the app.
MANIFEST_SQLITE_INCLUDE=modules/beebeeb-crypto/ios/ManifestSQLite
EXPO_SQLITE_SRC=node_modules/expo-sqlite/vendor/sqlite3/sqlite3.c
SQLITE_BUILD_DIR="$(mktemp -d)"
EXPO_SQLITE_DYLIB="$SQLITE_BUILD_DIR/libexpo-sqlite3.dylib"
VANILLA_SQLITE_OBJ="$SQLITE_BUILD_DIR/vanilla-sqlite3.o"
expo_sqlite_state=""   # "", "ok" or "failed"
vanilla_sqlite_state=""
EXPO_CFLAGS=(-DHAVE_USLEEP=1 -DSQLITE_ENABLE_LOCKING_STYLE=0 -DSQLITE_ENABLE_BYTECODE_VTAB=1 -DSQLITE_TEMP_STORE=2
  -DSQLITE_ENABLE_SESSION=1 -DSQLITE_ENABLE_PREUPDATE_HOOK=1 -DSQLITE_ENABLE_MATH_FUNCTIONS=1
  -DSQLITE_ENABLE_FTS4=1 -DSQLITE_ENABLE_FTS3_PARENTHESIS=1 -DSQLITE_ENABLE_FTS5=1)

build_expo_sqlite() {
  [ -n "$expo_sqlite_state" ] && { [ "$expo_sqlite_state" = ok ]; return; }
  expo_sqlite_state=failed
  if [ ! -f "$EXPO_SQLITE_SRC" ]; then
    echo "MISSING $EXPO_SQLITE_SRC (run bun install first)"
    return 1
  fi
  if ! xcrun clang -dynamiclib -O1 -w "${EXPO_CFLAGS[@]}" -install_name "$EXPO_SQLITE_DYLIB" \
    "$EXPO_SQLITE_SRC" -o "$EXPO_SQLITE_DYLIB" >"$LOG_DIR/expo-sqlite.build.log" 2>&1; then
    cat "$LOG_DIR/expo-sqlite.build.log"
    return 1
  fi
  expo_sqlite_state=ok
}

# The Rust core's stand-in for manifest-shm-two-copies-test: a vanilla
# `sqlite3_*` linked INTO the test binary, as libbeebeeb_uniffi.a's bundled
# copy is in the app (expo's amalgamation with its rename reversed, or
# BB_ENGINE_SQLITE_SRC, e.g. libsqlite3-sys 0.30.1's sqlite3.c = the app's
# exact 3.46.0). Never the macOS system library: Apple's copy hides the bug.
build_vanilla_sqlite() {
  [ -n "$vanilla_sqlite_state" ] && { [ "$vanilla_sqlite_state" = ok ]; return; }
  vanilla_sqlite_state=failed
  local src="${BB_ENGINE_SQLITE_SRC:-}"
  if [ -z "$src" ]; then
    src="$SQLITE_BUILD_DIR/vanilla-sqlite3.c"
    sed 's/exsqlite3/sqlite3/g' "$EXPO_SQLITE_SRC" >"$src" || return 1
  fi
  if ! xcrun clang -c -O1 -w -DSQLITE_THREADSAFE=1 "$src" -o "$VANILLA_SQLITE_OBJ" >"$LOG_DIR/vanilla-sqlite.build.log" 2>&1; then
    cat "$LOG_DIR/vanilla-sqlite.build.log"
    return 1
  fi
  vanilla_sqlite_state=ok
}

for entry in "${MANIFEST[@]}"; do
  base="${entry%%|*}"
  srcs="${entry#*|}"
  driver="scripts/swift-tests/$base"
  [ -f "$driver" ] || { echo "MANIFEST entry has no driver on disk: $driver"; rc=1; continue; }
  tmp="$(mktemp -d)"
  cp "$driver" "$tmp/main.swift"
  echo "== $base  (sources: $srcs)"
  if [ "$base" = "native-video-streamer-harness.swift" ]; then
    # MOCK: this existing harness uses fake UniFFI handles. Exercise production
    # registry/pickKey; real SharedKeyOps crypto is covered by platform KATs.
    cat > "$tmp/SharedKeyOps.swift" <<'SWIFT'
import Foundation
enum SharedKeyOps {
  static let registry = SharedKeyRegistry<FileKeyHandle>()
  static func fileKey(master: MasterKeyHandle, fileId: String) throws -> FileKeyHandle {
    try pickKey(table: registry.file(fileId)) { try master.deriveFileKey(fileId: Data(fileId.utf8)) }
  }
}
SWIFT
    srcs="$srcs $tmp/SharedKeyOps.swift"
  fi
  flags=(-swift-version 5 -O)
  extra_objs=()
  # shellcheck disable=SC2086
  if grep -qE '^import ManifestSQLite$' $srcs "$driver"; then
    if ! build_expo_sqlite; then
      echo "COMPILE FAILED: $base (expo-sqlite's SQLite copy)"
      rc=1
      continue
    fi
    flags+=(-I "$MANIFEST_SQLITE_INCLUDE")
    extra_objs+=("$EXPO_SQLITE_DYLIB")
    export BB_EXPO_SQLITE_DYLIB="$EXPO_SQLITE_DYLIB"
  fi
  case "$base" in
    native-video-streamer-harness.swift|native-preview-working-storage-test.swift) flags+=(-DDEBUG) ;;
    manifest-shm-two-copies-test.swift)
      if ! build_expo_sqlite || ! build_vanilla_sqlite; then
        echo "COMPILE FAILED: $base (SQLite copies)"
        rc=1
        continue
      fi
      extra_objs+=("$VANILLA_SQLITE_OBJ")
      ;;
    thumbnail-queue-purge-test.swift)
      # Task 1962 round 5 (P2.2): link the same vanilla SQLite object the app
      # gets through the Rust core. Apple's system SQLite defaults
      # secure_delete to 2, which hides a dropped `PRAGMA secure_delete = ON`.
      if ! build_vanilla_sqlite; then
        echo "COMPILE FAILED: thumbnail-queue-purge-test.swift (vanilla SQLite)"
        rc=1
        continue
      fi
      extra_objs+=("$VANILLA_SQLITE_OBJ")
      ;;
  esac
  # shellcheck disable=SC2086
  if ! xcrun swiftc "${flags[@]}" $srcs "$tmp/main.swift" ${extra_objs[@]+"${extra_objs[@]}"} -o "$tmp/t" >"$LOG_DIR/$base.build.log" 2>&1; then
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
