#!/usr/bin/env bash
set -euo pipefail

BUNDLE_ID="${BUNDLE_ID:-io.beebeeb.app}"
DEVICE_ID="${DEVICE_ID:-}"
DB_PATH=""
OUT_DIR=""

usage() {
  cat <<'USAGE'
Usage:
  scripts/backup-db-diagnostics.sh [--device <udid>] [--bundle-id io.beebeeb.app] [--out <dir>]
  scripts/backup-db-diagnostics.sh --db <path/to/beebeeb-backup.db> [--out <dir>]

Pull and summarize the Beebeeb mobile backup SQLite database.

Options:
  --bundle-id <id>  App bundle identifier. Default: io.beebeeb.app
  --device <udid>   Physical iPhone UDID.
  --db <path>       Summarize an already-pulled beebeeb-backup.db.
  --out <dir>       Output directory. Default: diagnostics/backup-db-<timestamp>
  -h, --help        Show this help.

Notes:
  - Physical iPhone pull first uses the known-working devicectl app-data copy:
      xcrun devicectl device copy from --device <UDID> --domain-type appDataContainer \
        --domain-identifier io.beebeeb.app --source Documents/SQLite/beebeeb-backup.db \
        --destination <out>/beebeeb-backup.db
  - ios-deploy is a fallback when devicectl copy is unavailable.
  - If direct pull is unavailable, export the app container from Xcode Devices
    and pass the database path with --db. The expected in-container path is:
      Documents/SQLite/beebeeb-backup.db
  - The summary intentionally reports counts and error buckets only; it does
    not print local asset identifiers.
USAGE
}

while [[ $# -gt 0 ]]; do
  case "$1" in
    --bundle-id)
      BUNDLE_ID="${2:?missing bundle id}"
      shift 2
      ;;
    --device)
      DEVICE_ID="${2:?missing device udid}"
      shift 2
      ;;
    --db)
      DB_PATH="${2:?missing db path}"
      shift 2
      ;;
    --out)
      OUT_DIR="${2:?missing output dir}"
      shift 2
      ;;
    -h|--help)
      usage
      exit 0
      ;;
    *)
      echo "Unknown argument: $1" >&2
      usage >&2
      exit 2
      ;;
  esac
done

timestamp="$(date -u +%Y%m%dT%H%M%SZ)"
if [[ -z "$OUT_DIR" ]]; then
  OUT_DIR="diagnostics/backup-db-$timestamp"
fi
mkdir -p "$OUT_DIR"

if [[ -z "$DB_PATH" ]]; then
  copied_db="$OUT_DIR/beebeeb-backup.db"
  devicectl_available=0
  if xcrun devicectl --help >/dev/null 2>&1; then
    devicectl_available=1
  fi

  if [[ "$devicectl_available" == 1 ]]; then
    devicectl_args=(xcrun devicectl device copy from --domain-type appDataContainer --domain-identifier "$BUNDLE_ID" --source Documents/SQLite/beebeeb-backup.db --destination "$copied_db")
    if [[ -n "$DEVICE_ID" ]]; then
      devicectl_args=(xcrun devicectl device copy from --device "$DEVICE_ID" --domain-type appDataContainer --domain-identifier "$BUNDLE_ID" --source Documents/SQLite/beebeeb-backup.db --destination "$copied_db")
    fi
    if "${devicectl_args[@]}"; then
      DB_PATH="$copied_db"
    else
      echo "devicectl app-data copy failed; trying ios-deploy fallback." >&2
    fi
  fi

  if [[ -z "$DB_PATH" ]] && command -v ios-deploy >/dev/null 2>&1; then
    pull_dir="$OUT_DIR/app-container"
    mkdir -p "$pull_dir"
    ios_args=(--bundle_id "$BUNDLE_ID" --download=/Documents/SQLite/beebeeb-backup.db --to "$pull_dir")
    if [[ -n "$DEVICE_ID" ]]; then
      ios_args=(--id "$DEVICE_ID" "${ios_args[@]}")
    fi
    ios-deploy "${ios_args[@]}"
    DB_PATH="$(find "$pull_dir" -name beebeeb-backup.db -type f -print -quit)"
  fi

  if [[ -z "$DB_PATH" ]]; then
    cat >&2 <<EOF
Could not pull the physical device backup DB directly.

Tried:
  xcrun devicectl device copy from --device ${DEVICE_ID:-<UDID>} --domain-type appDataContainer --domain-identifier $BUNDLE_ID --source Documents/SQLite/beebeeb-backup.db --destination '$copied_db'

Fallback:
  1. Open Xcode > Window > Devices and Simulators.
  2. Select the physical iPhone.
  3. Select the Beebeeb app for bundle $BUNDLE_ID.
  4. Download/export the app container.
  5. Re-run:
       $0 --db '<container>/AppData/Documents/SQLite/beebeeb-backup.db' --out '$OUT_DIR'
EOF
    exit 1
  fi
fi

if [[ -z "$DB_PATH" || ! -f "$DB_PATH" ]]; then
  echo "Backup DB not found. Expected file: ${DB_PATH:-<unset>}" >&2
  exit 1
fi

if ! command -v sqlite3 >/dev/null 2>&1; then
  echo "sqlite3 is required to summarize $DB_PATH" >&2
  exit 1
fi

summary="$OUT_DIR/backup-db-summary.txt"
summary_db="$OUT_DIR/summary-work.db"
cp "$DB_PATH" "$summary_db"

run_query() {
  local title="$1"
  local sql="$2"
  {
    printf '\n## %s\n' "$title"
    sqlite3 -header -column "$summary_db" "$sql" || true
  } >>"$summary"
}

table_exists() {
  local table="$1"
  sqlite3 "$summary_db" "SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = '$table' LIMIT 1;" | grep -q 1
}

{
  printf '# Beebeeb Backup DB Diagnostic Summary\n'
  printf 'generated_at_utc=%s\n' "$timestamp"
  printf 'bundle_id=%s\n' "$BUNDLE_ID"
  printf 'device_id=%s\n' "${DEVICE_ID:-<not provided>}"
  printf 'source_db_path=%s\n' "$DB_PATH"
  printf 'summary_db_path=%s\n' "$summary_db"
  printf 'db_bytes=%s\n' "$(wc -c <"$DB_PATH" | tr -d ' ')"
} >"$summary"

run_query "Integrity" "PRAGMA integrity_check;"
run_query "Tables" "SELECT name FROM sqlite_master WHERE type = 'table' ORDER BY name;"

if table_exists backup_assets; then
  run_query "Backup Assets Totals" \
    "SELECT COUNT(*) AS total_rows,
            COALESCE(SUM(file_size), 0) AS total_file_bytes,
            MIN(created_at) AS oldest_created_at,
            MAX(created_at) AS newest_created_at
       FROM backup_assets;"

  run_query "Status Counts" \
    "SELECT status,
            COUNT(*) AS rows,
            COALESCE(SUM(file_size), 0) AS file_bytes,
            COALESCE(SUM(staged_original_size), 0) AS staged_original_bytes
       FROM backup_assets
      GROUP BY status
      ORDER BY rows DESC, status ASC;"

  run_query "Task 0423 Queue Contract Counts" \
    "SELECT 'pending_upload' AS bucket, COUNT(*) AS rows FROM backup_assets WHERE status = 'pending_upload'
      UNION ALL SELECT 'staging', COUNT(*) FROM backup_assets WHERE status = 'staging'
      UNION ALL SELECT 'staged_upload', COUNT(*) FROM backup_assets WHERE status = 'staged_upload'
      UNION ALL SELECT 'uploading', COUNT(*) FROM backup_assets WHERE status = 'uploading'
      UNION ALL SELECT 'uploaded', COUNT(*) FROM backup_assets WHERE status = 'uploaded'
      UNION ALL SELECT 'local_missing', COUNT(*) FROM backup_assets WHERE status = 'local_missing'
      UNION ALL SELECT 'failed_retryable', COUNT(*) FROM backup_assets WHERE status = 'failed' AND COALESCE(retry_count, 0) < 10
      UNION ALL SELECT 'failed_terminal', COUNT(*) FROM backup_assets WHERE COALESCE(retry_count, 0) >= 10;"

  run_query "Asset Type Counts" \
    "SELECT asset_type, status, COUNT(*) AS rows
       FROM backup_assets
      GROUP BY asset_type, status
      ORDER BY asset_type ASC, rows DESC;"

  run_query "PhotoKit Missing Evidence" \
    "SELECT COUNT(*) AS photoKitMissingCount
       FROM backup_assets
      WHERE status = 'local_missing'
         OR error_message LIKE '%Photo asset not found%'
         OR error_message LIKE '%not found in library%';"

  run_query "Retry Buckets" \
    "SELECT CASE
              WHEN COALESCE(retry_count, 0) = 0 THEN '0'
              WHEN COALESCE(retry_count, 0) BETWEEN 1 AND 3 THEN '1-3'
              WHEN COALESCE(retry_count, 0) BETWEEN 4 AND 9 THEN '4-9'
              ELSE '10+'
            END AS retry_bucket,
            COUNT(*) AS rows
       FROM backup_assets
      GROUP BY retry_bucket
      ORDER BY retry_bucket;"

  run_query "Top Error Buckets" \
    "SELECT COALESCE(error_message, '<none>') AS error_message,
            COUNT(*) AS rows
       FROM backup_assets
      WHERE error_message IS NOT NULL
      GROUP BY error_message
      ORDER BY rows DESC
      LIMIT 20;"
fi

if table_exists backup_upload_chunks; then
  run_query "Upload Chunk Status Counts" \
    "SELECT status, COUNT(*) AS rows
       FROM backup_upload_chunks
      GROUP BY status
      ORDER BY rows DESC, status ASC;"

  run_query "Upload Chunk Error Buckets" \
    "SELECT COALESCE(last_error, '<none>') AS last_error,
            COUNT(*) AS rows
       FROM backup_upload_chunks
      WHERE last_error IS NOT NULL
      GROUP BY last_error
      ORDER BY rows DESC
      LIMIT 20;"
fi

echo "Wrote $summary"
