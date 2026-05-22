#!/usr/bin/env bash
set -euo pipefail

BUNDLE_ID="${BUNDLE_ID:-io.beebeeb.app}"
DEVICE_ID="${DEVICE_ID:-}"
SIMULATOR_ID=""
DURATION_SECONDS=180
OUT_DIR=""
PRINT_COMMAND=0

usage() {
  cat <<'USAGE'
Usage:
  scripts/capture-backup-device-logs.sh [--device <udid>] [--bundle-id io.beebeeb.app] [--duration 180] [--out <dir>]
  scripts/capture-backup-device-logs.sh --simulator booted [--duration 60] [--out <dir>]

Capture filtered Beebeeb backup/unlock diagnostics from an iPhone or simulator.

Options:
  --bundle-id <id>    App bundle identifier. Default: io.beebeeb.app
  --device <udid>     Physical iPhone UDID.
  --simulator <id>    Simulator id, name, or "booted" for simctl log stream.
  --duration <secs>   Capture duration. Default: 180
  --out <dir>         Output directory. Default: diagnostics/backup-logs-<timestamp>
  --print-command     Print the selected log command before running it.
  -h, --help          Show this help.

The filter keeps Beebeeb process logs plus diagnostic markers:
  [BeebeebDiagnostics] vault.unlock
  [BeebeebDiagnostics] backup.snapshot
  [BeebeebPerf] backup.native.*
  NativeBackupEngine / LocalAuthentication / Face ID messages

Physical device capture prefers idevicesyslog when installed. If that is not
available, the script can use devicectl process launch --console, which
terminates and relaunches the app to attach console output. Xcode Console is
the manual fallback.
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
    --simulator)
      SIMULATOR_ID="${2:?missing simulator id}"
      shift 2
      ;;
    --duration)
      DURATION_SECONDS="${2:?missing duration}"
      shift 2
      ;;
    --out)
      OUT_DIR="${2:?missing output dir}"
      shift 2
      ;;
    --print-command)
      PRINT_COMMAND=1
      shift
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
  OUT_DIR="diagnostics/backup-logs-$timestamp"
fi
mkdir -p "$OUT_DIR"

raw_log="$OUT_DIR/device.log"
filtered_log="$OUT_DIR/beebeeb-backup-filtered.log"
predicate="process == \"Beebeeb\" OR subsystem CONTAINS[c] \"beebeeb\" OR composedMessage CONTAINS[c] \"BeebeebDiagnostics\" OR composedMessage CONTAINS[c] \"NativeBackupEngine\" OR composedMessage CONTAINS[c] \"backup.native\" OR composedMessage CONTAINS[c] \"LocalAuthentication\" OR composedMessage CONTAINS[c] \"Face ID\" OR eventMessage CONTAINS[c] \"BeebeebDiagnostics\" OR eventMessage CONTAINS[c] \"NativeBackupEngine\" OR eventMessage CONTAINS[c] \"backup.native\""
grep_filter="Beebeeb|BeebeebDiagnostics|NativeBackupEngine|backup\\.native|LocalAuthentication|Face ID|${BUNDLE_ID}"

run_for_duration() {
  local pid
  local elapsed=0
  local status=0
  "$@" >"$raw_log" 2>&1 &
  pid=$!
  while [[ "$elapsed" -lt "$DURATION_SECONDS" ]]; do
    if ! kill -0 "$pid" >/dev/null 2>&1; then
      wait "$pid" || status=$?
      return "$status"
    fi
    sleep 1
    elapsed=$((elapsed + 1))
  done
  kill -INT "$pid" >/dev/null 2>&1 || true
  wait "$pid" >/dev/null 2>&1 || true
}

if [[ -n "$SIMULATOR_ID" ]]; then
  cmd=(xcrun simctl spawn "$SIMULATOR_ID" log stream --style compact --predicate "$predicate")
  if [[ "$PRINT_COMMAND" == 1 ]]; then
    printf 'Running:'
    printf ' %q' "${cmd[@]}"
    printf '\n'
  fi
  run_for_duration "${cmd[@]}"
elif command -v idevicesyslog >/dev/null 2>&1; then
  idevice_args=()
  if [[ -n "$DEVICE_ID" ]]; then
    idevice_args=(-u "$DEVICE_ID")
  fi
  cmd=(idevicesyslog "${idevice_args[@]}")
  if [[ "$PRINT_COMMAND" == 1 ]]; then
    printf 'Running:'
    printf ' %q' "${cmd[@]}"
    printf '\n'
  fi
  run_for_duration "${cmd[@]}"
elif xcrun devicectl --help >/dev/null 2>&1; then
  cmd=(xcrun devicectl device process launch --console --terminate-existing "$BUNDLE_ID")
  if [[ -n "$DEVICE_ID" ]]; then
    cmd=(xcrun devicectl device process launch --device "$DEVICE_ID" --console --terminate-existing "$BUNDLE_ID")
  fi
  if [[ "$PRINT_COMMAND" == 1 ]]; then
    printf 'Running:'
    printf ' %q' "${cmd[@]}"
    printf '\n'
  fi
  run_for_duration "${cmd[@]}"
else
  cat >&2 <<EOF
No supported device log tool found.

Install libimobiledevice for idevicesyslog, or use Xcode Console.

Xcode Console filter:
  $predicate

Then save logs that include:
  $grep_filter
EOF
  exit 1
fi

if grep -Eq '^(ERROR:|Error:|error:)|The specified device was not found|Unable to locate device' "$raw_log"; then
  if grep -Eq 'ERROR: An error occurred while communicating with a remote process' "$raw_log" \
    && grep -Eq "$grep_filter" "$raw_log"; then
    printf 'Log capture ended after remote process disconnect; keeping captured logs.\n' >&2
  else
  echo "Log capture command failed; see $raw_log" >&2
  exit 1
  fi
fi

grep -E "$grep_filter" "$raw_log" >"$filtered_log" || true

cat >"$OUT_DIR/README.txt" <<EOF
Beebeeb backup diagnostic log capture
generated_at_utc=$timestamp
bundle_id=$BUNDLE_ID
device_id=${DEVICE_ID:-<not provided>}
simulator_id=${SIMULATOR_ID:-<not used>}
duration_seconds=$DURATION_SECONDS
raw_log=$raw_log
filtered_log=$filtered_log

Review filtered log markers:
  [BeebeebDiagnostics] vault.unlock
  [BeebeebDiagnostics] backup.snapshot
  [BeebeebPerf] backup.native.*
EOF

echo "Wrote $raw_log"
echo "Wrote $filtered_log"
