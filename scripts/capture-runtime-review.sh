#!/usr/bin/env bash
set -euo pipefail

SIMULATOR_ID="${SIMULATOR_ID:-booted}"
DURATION_SECONDS=300
OUT_DIR=""

usage() {
  cat <<'USAGE'
Usage:
  scripts/capture-runtime-review.sh [--simulator booted] [--duration 300] [--out diagnostics/runtime-review-...]

Captures synchronized simulator evidence for Face ID, thumbnail, and settings
debugging:
  - screen.mp4 from simctl recordVideo
  - simulator.log from unified logging
  - beebeeb-runtime-filtered.log with Beebeeb-only markers
  - runtime-trace.jsonl parsed from [BeebeebRuntimeTrace] log lines

For physical iPhone Face ID sessions, run this same app build with runtime
trace enabled, capture device logs with scripts/capture-backup-device-logs.sh,
and record the screen from Control Center or QuickTime. The simulator is still
useful for thumbnails/settings and for proving the log/video alignment.
USAGE
}

while [[ $# -gt 0 ]]; do
  case "$1" in
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
  OUT_DIR="diagnostics/runtime-review-$timestamp"
fi
mkdir -p "$OUT_DIR"

video="$OUT_DIR/screen.mp4"
raw_log="$OUT_DIR/simulator.log"
filtered_log="$OUT_DIR/beebeeb-runtime-filtered.log"
trace_jsonl="$OUT_DIR/runtime-trace.jsonl"

predicate='process == "Beebeeb" OR subsystem CONTAINS[c] "beebeeb" OR composedMessage CONTAINS[c] "BeebeebRuntimeTrace" OR composedMessage CONTAINS[c] "BeebeebDiagnostics" OR composedMessage CONTAINS[c] "LocalAuthentication" OR composedMessage CONTAINS[c] "Face ID" OR composedMessage CONTAINS[c] "thumbnail" OR eventMessage CONTAINS[c] "BeebeebRuntimeTrace" OR eventMessage CONTAINS[c] "BeebeebDiagnostics" OR eventMessage CONTAINS[c] "LocalAuthentication" OR eventMessage CONTAINS[c] "Face ID" OR eventMessage CONTAINS[c] "thumbnail"'
grep_filter='BeebeebRuntimeTrace|BeebeebDiagnostics|BeebeebPerf|LocalAuthentication|Face ID|thumbnail|ThumbnailService|NativeBackupEngine|settings\.|photos\.|vault\.|keychain\.|backup\.native'

cleanup() {
  if [[ -n "${video_pid:-}" ]]; then
    kill -INT "$video_pid" >/dev/null 2>&1 || true
    wait "$video_pid" >/dev/null 2>&1 || true
  fi
  if [[ -n "${log_pid:-}" ]]; then
    kill -INT "$log_pid" >/dev/null 2>&1 || true
    wait "$log_pid" >/dev/null 2>&1 || true
  fi
}
trap cleanup EXIT INT TERM

xcrun simctl io "$SIMULATOR_ID" recordVideo --codec=h264 "$video" &
video_pid=$!

xcrun simctl spawn "$SIMULATOR_ID" log stream --style compact --predicate "$predicate" >"$raw_log" 2>&1 &
log_pid=$!

sleep "$DURATION_SECONDS"
cleanup
trap - EXIT INT TERM

grep -E "$grep_filter" "$raw_log" >"$filtered_log" || true
grep 'BeebeebRuntimeTrace' "$raw_log" \
  | sed -E 's/^.*BeebeebRuntimeTrace[] ]*//' \
  | sed -n '/^{/p' >"$trace_jsonl" || true

cat >"$OUT_DIR/README.txt" <<EOF
Beebeeb runtime review capture
generated_at_utc=$timestamp
simulator_id=$SIMULATOR_ID
duration_seconds=$DURATION_SECONDS

Artifacts:
  video=$video
  raw_log=$raw_log
  filtered_log=$filtered_log
  runtime_trace_jsonl=$trace_jsonl

Recommended review order:
  1. Watch screen.mp4 and note timestamps where Face ID appears, thumbnails stall, or Settings feels confusing.
  2. Search runtime-trace.jsonl for events at the same wall-clock second.
  3. Use beebeeb-runtime-filtered.log when native keychain/PhotoKit details are needed.
EOF

echo "Wrote $video"
echo "Wrote $filtered_log"
echo "Wrote $trace_jsonl"
