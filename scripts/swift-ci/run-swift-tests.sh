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
  "native-preview-working-storage-test.swift|modules/beebeeb-crypto/ios/NativePreviewWorkingStorage.swift"
  "native-video-streamer-harness.swift|scripts/swift-tests/native-video-streamer-stubs.swift modules/beebeeb-crypto/ios/NativePreviewWorkingStorage.swift modules/beebeeb-crypto/ios/NativeVideoStreamer.swift"
  "preview-chunk-pipeline-test.swift|modules/beebeeb-crypto/ios/NativePreviewWorkingStorage.swift modules/beebeeb-crypto/ios/PreviewChunkPipeline.swift"
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

for entry in "${MANIFEST[@]}"; do
  base="${entry%%|*}"
  srcs="${entry#*|}"
  driver="scripts/swift-tests/$base"
  [ -f "$driver" ] || { echo "MANIFEST entry has no driver on disk: $driver"; rc=1; continue; }
  tmp="$(mktemp -d)"
  cp "$driver" "$tmp/main.swift"
  echo "== $base  (sources: $srcs)"
  flags=(-swift-version 5 -O)
  extra_objs=()
  case "$base" in
    native-video-streamer-harness.swift|native-preview-working-storage-test.swift) flags+=(-DDEBUG) ;;
    manifest-shm-two-copies-test.swift)
      # Task 2033: two SQLite copies, as in the app. expo-sqlite's own copy is
      # built from the exact vendored amalgamation with ExpoSQLite.podspec's
      # flags (loaded by the test with dlopen). The engine's copy is a vanilla
      # SQLite linked INTO the test binary, as the Rust core's bundled one is
      # in the app; by default expo's amalgamation with its exsqlite3 rename
      # reversed, or BB_ENGINE_SQLITE_SRC (e.g. libsqlite3-sys 0.30.1's
      # sqlite3.c, the app's exact 3.46.0). Never the macOS system library:
      # Apple's copy hides the bug (see the test's header).
      expo_src=node_modules/expo-sqlite/vendor/sqlite3/sqlite3.c
      if [ ! -f "$expo_src" ]; then
        echo "MISSING $expo_src (run bun install first): $base cannot run"
        rc=1
        continue
      fi
      expo_cflags=(-DHAVE_USLEEP=1 -DSQLITE_ENABLE_LOCKING_STYLE=0 -DSQLITE_ENABLE_BYTECODE_VTAB=1 -DSQLITE_TEMP_STORE=2
        -DSQLITE_ENABLE_SESSION=1 -DSQLITE_ENABLE_PREUPDATE_HOOK=1 -DSQLITE_ENABLE_MATH_FUNCTIONS=1
        -DSQLITE_ENABLE_FTS4=1 -DSQLITE_ENABLE_FTS3_PARENTHESIS=1 -DSQLITE_ENABLE_FTS5=1)
      engine_src="${BB_ENGINE_SQLITE_SRC:-}"
      if [ -z "$engine_src" ]; then
        engine_src="$tmp/engine-sqlite3.c"
        sed 's/exsqlite3/sqlite3/g' "$expo_src" >"$engine_src"
      fi
      if ! xcrun clang -dynamiclib -O1 -w "${expo_cflags[@]}" "$expo_src" -o "$tmp/libexpo-sqlite3.dylib" >"$LOG_DIR/$base.expo-sqlite.log" 2>&1 \
        || ! xcrun clang -c -O1 -w -DSQLITE_THREADSAFE=1 "$engine_src" -o "$tmp/engine-sqlite3.o" >"$LOG_DIR/$base.engine-sqlite.log" 2>&1; then
        cat "$LOG_DIR/$base.expo-sqlite.log" "$LOG_DIR/$base.engine-sqlite.log" 2>/dev/null
        echo "COMPILE FAILED: $base (SQLite copies)"
        rc=1
        continue
      fi
      extra_objs+=("$tmp/engine-sqlite3.o")
      export BB_EXPO_SQLITE_DYLIB="$tmp/libexpo-sqlite3.dylib"
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
