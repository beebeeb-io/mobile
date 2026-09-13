#!/usr/bin/env bash
# Pre-mortem 12 / task 0300 — read the exclude-from-backup attribute back off a
# REAL simulator app container. Two independent checks:
#   1. the extended attribute iOS actually stores for isExcludedFromBackup;
#   2. the app's own audit JSON, written by auditPlaintextStorage() on a
#      __DEV__ launch.
# Usage: bash scripts/verify-backup-exclusion.sh <simulator-udid>
set -euo pipefail

UDID="${1:?usage: verify-backup-exclusion.sh <simulator-udid>}"
BUNDLE_ID="io.beebeeb.app"
XATTR_KEY="com.apple.metadata:com_apple_backup_excludeItem"

DATA_DIR="$(xcrun simctl get_app_container "$UDID" "$BUNDLE_ID" data)"
GROUP_DIR="$(xcrun simctl get_app_container "$UDID" "$BUNDLE_ID" groups 2>/dev/null | head -1 || true)"
BUNDLE_SUPPORT="$DATA_DIR/Library/Application Support/$BUNDLE_ID"

PATHS=(
  "$DATA_DIR/Documents/beebeeb-thumbnails-v3"
  "$DATA_DIR/Documents/beebeeb-photokit-cache"
  "$DATA_DIR/Documents/offline"
  "$DATA_DIR/Documents/PendingShareUploads"
  "$DATA_DIR/Documents/SQLite"
  "$DATA_DIR/Documents/beebeeb-name-cache-v1.json"
  "$DATA_DIR/Documents/beebeeb-file-index-cache-v1.json"
  "$DATA_DIR/Documents/local-id-map.json"
  "$DATA_DIR/Documents/thumbnail_queue.sqlite"
  "$DATA_DIR/Documents/beebeeb-simulator-master-key.txt"
  "$DATA_DIR/Library/Application Support/NativeBackupStaging"
  "$DATA_DIR/Library/Application Support/Beebeeb"
  "$BUNDLE_SUPPORT/RCTAsyncLocalStorage_V1"
)
if [ -n "$GROUP_DIR" ]; then
  PATHS+=(
    "$GROUP_DIR/IncomingShares" "$GROUP_DIR/widget-data.json"
    "$GROUP_DIR/pinned" "$GROUP_DIR/temp"
  )
fi

echo "container: $DATA_DIR"
echo "checked:   $(date -u +%Y-%m-%dT%H:%M:%SZ)"
echo

failed=0
for p in "${PATHS[@]}"; do
  if [ ! -e "$p" ]; then
    printf 'SKIP     %s (not created yet)\n' "${p#"$DATA_DIR"/}"
    continue
  fi
  if xattr -px "$XATTR_KEY" "$p" >/dev/null 2>&1; then
    value="$(xattr -px "$XATTR_KEY" "$p" | xxd -r -p | plutil -p - 2>/dev/null | tr -d '\n')"
    printf 'EXCLUDED %s  (%s)\n' "${p#"$DATA_DIR"/}" "$value"
  else
    printf 'LEAKING  %s  <-- no %s\n' "${p#"$DATA_DIR"/}" "$XATTR_KEY"
    failed=1
  fi
done

AUDIT="$DATA_DIR/Library/Caches/beebeeb-plaintext-audit.json"
echo
if [ -f "$AUDIT" ]; then
  echo "in-app audit report ($AUDIT):"
  cat "$AUDIT"
  if grep -q '"exists" : true' "$AUDIT" && \
     python3 -c "
import json,sys
rows=json.load(open('$AUDIT'))
bad=[r for r in rows if r['exists'] and (not r['excludedFromBackup'] or r['protection']!='NSFileProtectionCompleteUntilFirstUserAuthentication')]
sys.exit(1 if bad else 0)
"; then
    echo "in-app audit: OK"
  else
    echo "in-app audit: FAILED — an existing path is unexcluded or unprotected"
    failed=1
  fi
else
  echo "in-app audit: MISSING — launch the app once in __DEV__ so auditPlaintextStorage() runs"
  failed=1
fi

exit "$failed"
