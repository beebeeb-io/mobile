#!/usr/bin/env bash
set -euo pipefail

usage() {
  cat <<'USAGE'
Usage:
  scripts/perf-smoke-sample.sh --pid PID --out DIR [--samples N] [--delay SECONDS] [--ui-snapshot PATH ...]

Purpose:
  Lightweight simulator perf smoke sampler for Photos preview swiping and Files listing.
  Run the app and drive UI with XcodeBuildMCP, then sample the app process while you swipe
  previews or scroll/list Files. Save XcodeBuildMCP snapshot_ui output to files and pass
  them with --ui-snapshot to track hierarchy size/max y over time.

Inputs:
  --pid PID              Process id to sample. Use the simulator app process PID.
  --out DIR              Output directory for samples.csv and summary.txt.
  --samples N            Number of process samples. Default: 20.
  --delay SECONDS        Delay between samples. Default: 1.
  --ui-snapshot PATH     Optional XcodeBuildMCP snapshot output file. Can be repeated.

Outputs:
  samples.csv            timestamp,pid,cpu_percent,rss_kb,rss_mb,command
  summary.txt            average/max CPU, average/max RSS, and optional UI snapshot stats.

Example:
  # Terminal A / MCP: build_run_sim, open Photos, start preview swiping.
  # Terminal B:
  pgrep -fl Beebeeb
  scripts/perf-smoke-sample.sh --pid 12345 --out perf-smoke/photos-preview --samples 30 --delay 0.5

  # With saved XcodeBuildMCP snapshot_ui output:
  scripts/perf-smoke-sample.sh --pid 12345 --out perf-smoke/files-list \
    --samples 20 --delay 1 \
    --ui-snapshot perf-smoke/files-list/snapshot-before.txt \
    --ui-snapshot perf-smoke/files-list/snapshot-after.txt
USAGE
}

die() {
  echo "ERROR: $*" >&2
  exit 1
}

pid=""
out_dir=""
samples="20"
delay="1"
ui_snapshots=()

while [ "$#" -gt 0 ]; do
  case "$1" in
    --pid)
      [ "$#" -ge 2 ] || die "--pid requires a value"
      pid="$2"
      shift 2
      ;;
    --out)
      [ "$#" -ge 2 ] || die "--out requires a value"
      out_dir="$2"
      shift 2
      ;;
    --samples)
      [ "$#" -ge 2 ] || die "--samples requires a value"
      samples="$2"
      shift 2
      ;;
    --delay)
      [ "$#" -ge 2 ] || die "--delay requires a value"
      delay="$2"
      shift 2
      ;;
    --ui-snapshot)
      [ "$#" -ge 2 ] || die "--ui-snapshot requires a value"
      ui_snapshots+=("$2")
      shift 2
      ;;
    -h|--help)
      usage
      exit 0
      ;;
    *)
      die "unknown argument: $1"
      ;;
  esac
done

[ -n "$pid" ] || die "--pid is required"
[ -n "$out_dir" ] || die "--out is required"
case "$pid" in
  ''|*[!0-9]*) die "--pid must be numeric" ;;
esac
case "$samples" in
  ''|*[!0-9]*) die "--samples must be a positive integer" ;;
esac
[ "$samples" -gt 0 ] || die "--samples must be greater than zero"

if ! awk -v value="$delay" 'BEGIN { exit !(value ~ /^[0-9]+([.][0-9]+)?$/) }'; then
  die "--delay must be a non-negative number"
fi

if ! ps -p "$pid" >/dev/null 2>&1; then
  die "process $pid is not running"
fi

mkdir -p "$out_dir"
csv="$out_dir/samples.csv"
summary="$out_dir/summary.txt"

echo "timestamp,pid,cpu_percent,rss_kb,rss_mb,command" > "$csv"

i=1
while [ "$i" -le "$samples" ]; do
  if ! row="$(ps -p "$pid" -o %cpu= -o rss= -o comm=)"; then
    echo "WARN: process $pid exited before sample $i of $samples" >&2
    break
  fi

  cpu="$(awk '{ print $1 }' <<<"$row")"
  rss_kb="$(awk '{ print $2 }' <<<"$row")"
  command="$(awk '{$1=""; $2=""; sub(/^  */, ""); print}' <<<"$row")"
  rss_mb="$(awk -v kb="$rss_kb" 'BEGIN { printf "%.2f", kb / 1024 }')"
  timestamp="$(date -u +"%Y-%m-%dT%H:%M:%SZ")"

  printf '%s,%s,%s,%s,%s,"%s"\n' \
    "$timestamp" "$pid" "$cpu" "$rss_kb" "$rss_mb" "${command//\"/\"\"}" >> "$csv"

  if [ "$i" -lt "$samples" ] && awk -v value="$delay" 'BEGIN { exit !(value + 0 > 0) }'; then
    sleep "$delay"
  fi
  i=$((i + 1))
done

sample_count="$(awk 'NR > 1 { count++ } END { print count + 0 }' "$csv")"
[ "$sample_count" -gt 0 ] || die "no samples were collected"

{
  echo "Perf smoke summary"
  echo "PID: $pid"
  echo "Samples requested: $samples"
  echo "Samples collected: $sample_count"
  echo "Delay seconds: $delay"
  echo "CSV: $csv"
  echo ""
  awk -F, '
    NR > 1 {
      cpu += $3
      rss += $4
      if ($3 > max_cpu || count == 0) max_cpu = $3
      if ($4 > max_rss || count == 0) max_rss = $4
      count++
    }
    END {
      printf "CPU avg: %.2f%%\n", cpu / count
      printf "CPU max: %.2f%%\n", max_cpu
      printf "RSS avg: %.2f MB\n", (rss / count) / 1024
      printf "RSS max: %.2f MB\n", max_rss / 1024
    }
  ' "$csv"

  if [ "${#ui_snapshots[@]}" -gt 0 ]; then
    echo ""
    echo "UI snapshot summaries"
    for snapshot in "${ui_snapshots[@]}"; do
      if [ ! -f "$snapshot" ]; then
        echo "$snapshot: missing"
        continue
      fi

      line_count="$(wc -l < "$snapshot" | tr -d ' ')"
      # XcodeBuildMCP snapshot output may be text or JSON-like. Capture common y-coordinate shapes.
      max_y="$(
        tr ',' '\n' < "$snapshot" \
          | awk '
              match($0, /[" ]y[" ]*[:=][ ]*-?[0-9]+(\.[0-9]+)?/) {
                value = substr($0, RSTART, RLENGTH)
                sub(/^.*[:=][ ]*/, "", value)
                if (value + 0 > max || seen == 0) max = value + 0
                seen = 1
              }
              END {
                if (seen) printf "%.0f", max
                else print "n/a"
              }
            '
      )"
      echo "$snapshot: lines=$line_count max_y=$max_y"
    done
  fi
} > "$summary"

cat "$summary"
