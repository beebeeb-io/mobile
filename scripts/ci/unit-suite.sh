#!/usr/bin/env bash
# Task 1669 round 2 — CI gate for the mobile unit suite, asserting the truth line CLAUDE.md
# defines ("How we work"): `isolated: N pass, 0 fail across F files` with N > 0.
#
#   scripts/ci/unit-suite.sh              run `bun run test`, then assert (what the CI job does)
#   scripts/ci/unit-suite.sh --check FILE EXIT_CODE
#                                         assert an already-captured log + the suite's exit code
#   scripts/ci/unit-suite.sh --self-test  prove the assertion goes RED on every bad shape
#
# A green exit code with no count, with N=0, or with a failing file is a RED: absence of failure is
# not evidence of success.
set -uo pipefail

ROOT="$(cd "$(dirname "$0")/../.." && pwd)"

print_failure_blocks() {
  local log="$1"
  awk '
    /^={70}$/ { block = $0 "\n"; capture = 1; next }
    capture {
      block = block $0 "\n"
      if ($0 ~ /^={70}$/ && block ~ /\n(FAIL|error|Error|panic|fatal error|COMPILE FAILED|TEST FAILED)/) {
        printf "%s", block
        block = ""
        capture = 0
        next
      }
      next
    }
    /^FAIL / { print }
  ' "$log"
}

# check_log LOG EXIT_CODE -> prints the verdict, returns 0 (pass) / 1 (red)
check_log() {
  local log="$1" code="$2" lines n fail files broken
  if [ ! -s "$log" ]; then echo "UNIT SUITE GATE: FAIL (empty log)"; return 1; fi
  lines="$(grep -cE '^isolated: [0-9]+ pass, [0-9]+ fail across [0-9]+ files' "$log" || true)"
  if [ "$lines" != "1" ]; then
    echo "UNIT SUITE GATE: FAIL (expected exactly 1 'isolated: N pass, F fail across X files' line, found $lines)"
    return 1
  fi
  local line
  line="$(grep -E '^isolated: [0-9]+ pass, [0-9]+ fail across [0-9]+ files' "$log")"
  n="$(printf '%s' "$line" | sed -E 's/^isolated: ([0-9]+) pass.*/\1/')"
  fail="$(printf '%s' "$line" | sed -E 's/^isolated: [0-9]+ pass, ([0-9]+) fail.*/\1/')"
  files="$(printf '%s' "$line" | sed -E 's/.* across ([0-9]+) files.*/\1/')"
  broken="$(grep -cE '^FAIL ' "$log" || true)"
  if [ "$code" != "0" ]; then echo "UNIT SUITE GATE: FAIL (bun run test exited $code; $line)"; return 1; fi
  if [ "$n" -le 0 ]; then echo "UNIT SUITE GATE: FAIL (N=$n: the suite proved nothing)"; return 1; fi
  if [ "$files" -le 0 ]; then echo "UNIT SUITE GATE: FAIL (0 files ran)"; return 1; fi
  if [ "$fail" != "0" ]; then echo "UNIT SUITE GATE: FAIL ($fail failing; $line)"; return 1; fi
  if [ "$broken" != "0" ]; then echo "UNIT SUITE GATE: FAIL ($broken 'FAIL <file>' lines; $line)"; return 1; fi
  echo "UNIT SUITE GATE: PASS ($line)"
  return 0
}

self_test() {
  local dir; dir="$(mktemp -d)"; trap 'rm -rf "$dir"' RETURN
  local failures=0
  expect() { # name expected(0|1) log-content exit-code
    local name="$1" want="$2" content="$3" code="$4"
    printf '%b' "$content" > "$dir/log"
    if check_log "$dir/log" "$code" >/dev/null 2>&1; then got=0; else got=1; fi
    if [ "$got" = "$want" ]; then echo "  ok   $name (gate=$([ $got = 0 ] && echo pass || echo red))"
    else echo "  BAD  $name: wanted $([ $want = 0 ] && echo pass || echo red)"; failures=$((failures + 1)); fi
  }
  echo "unit-suite gate self-test:"
  expect "good run passes"                      0 'ok   a.test.ts  (3 pass, 0 fail)\n\nisolated: 1792 pass, 0 fail across 149 files\n' 0
  expect "N=0 is RED (green with no count)"     1 '\nisolated: 0 pass, 0 fail across 149 files\n' 0
  expect "0 files is RED"                       1 '\nisolated: 5 pass, 0 fail across 0 files\n' 0
  expect "a failing test is RED"                1 '\nisolated: 1791 pass, 1 fail across 149 files — 1 file(s) failing\n' 1
  expect "failing count with exit 0 is RED"     1 '\nisolated: 1791 pass, 1 fail across 149 files\n' 0
  expect "exit code 1 with a clean line is RED" 1 '\nisolated: 1792 pass, 0 fail across 149 files\n' 1
  expect "missing truth line is RED"            1 'ok   a.test.ts  (3 pass, 0 fail)\n' 0
  expect "empty log is RED"                     1 '' 0
  expect "a FAIL file line is RED"              1 'FAIL src/x.test.ts  (2 pass, 1 fail)\n\nisolated: 10 pass, 0 fail across 2 files\n' 0
  expect "two truth lines is RED (ambiguous)"   1 'isolated: 5 pass, 0 fail across 1 files\nisolated: 5 pass, 0 fail across 1 files\n' 0
  expect "an old-style word, no count, is RED"  1 'all tests passed\n' 0
  if [ "$failures" != "0" ]; then echo "SELF-TEST: FAIL ($failures wrong verdicts)"; return 1; fi
  echo "SELF-TEST: PASS (11 verdicts correct, 10 of them red-proofs)"
}

case "${1:-}" in
  --self-test) self_test; exit $? ;;
  --check) check_log "${2:?log file}" "${3:?exit code}"; exit $? ;;
  "")
    cd "$ROOT" || exit 1
    LOG="${UNIT_SUITE_LOG:-$(mktemp)}"
    bun run test > "$LOG" 2>&1
    CODE=$?
    # keep the tail visible in the job log even when the gate passes
    tail -n 5 "$LOG"
    if [ "$CODE" != "0" ]; then
      echo
      echo "UNIT SUITE FAILURE DETAILS:"
      print_failure_blocks "$LOG"
    fi
    check_log "$LOG" "$CODE"
    exit $?
    ;;
  *) echo "usage: $0 [--self-test | --check LOG EXIT_CODE]" >&2; exit 2 ;;
esac
