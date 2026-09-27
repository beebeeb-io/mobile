#!/usr/bin/env bash
#
# run-preview-matrix.sh — task 1565, mobile half. Runs the generated
# e2e/maestro/1565-preview-matrix/run.yaml against ONE named simulator,
# capturing one screenshot per fixture plus a PASS/FAIL/UNKNOWN summary
# table derived from Maestro's own stdout — never run bare `maestro test`
# for this (see CLAUDE.md "Always pass --udid naming the sim the lane owns"
# and "One maestro test at a time, machine-wide").
#
# PRECONDITIONS (this script does not do any of these for you):
#   1. Local API (:3001) + Postgres (:5434) + local web dev server (:5173) up.
#   2. node e2e/scripts/seed-preview-matrix-web.mjs has already run —
#      uploads every fixture to qa0688content@beebeeb.io's Drive.
#   3. The target sim is booted, signed in as qa0688content (local API),
#      sitting anywhere in the app (Files tab or not — run.yaml taps "Files"
#      itself). e2e/maestro/local-qa-signin-unlock.yaml gets a cold app there.
#   4. This lane holds the machine-wide Maestro driver — the lead grants it.
#
# Usage:
#   ./e2e/scripts/run-preview-matrix.sh <UDID> [evidence-dir]
#
# Example:
#   ./e2e/scripts/run-preview-matrix.sh 6A2C9171-813B-443E-A19D-B7869D5D0A20 \
#     .claude/evidence/1565-preview-matrix-mobile
set -euo pipefail

UDID="${1:?Usage: run-preview-matrix.sh <UDID> [evidence-dir]}"
EVIDENCE_DIR="${2:-$(pwd)/.run-1565-mobile/evidence}"
FLOW_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/../maestro/1565-preview-matrix" && pwd)"
LOG_FILE="${EVIDENCE_DIR}/maestro-stdout.log"

mkdir -p "$EVIDENCE_DIR"
echo "[run-1565] UDID=$UDID"
echo "[run-1565] evidence dir: $EVIDENCE_DIR"
echo "[run-1565] flow: $FLOW_DIR/run.yaml"

# NODE_OPTIONS unset per CLAUDE.md precedent (env -u NODE_OPTIONS maestro ...)
# — an inherited NODE_OPTIONS (e.g. --max-old-space-size from an agent shell)
# has broken the maestro CLI's own bundled node runtime before.
set +e
env -u NODE_OPTIONS maestro --udid "$UDID" test "$FLOW_DIR/run.yaml" \
  -e EVIDENCE_DIR="$EVIDENCE_DIR" \
  2>&1 | tee "$LOG_FILE"
MAESTRO_EXIT="${PIPESTATUS[0]}"
set -e

echo ""
echo "[run-1565] maestro exit code: $MAESTRO_EXIT"

# Build the PASS/FAIL/UNKNOWN table the task's Verification field asks for.
# PASS  — the fixture's own screenshot exists AND no "optional" assertion
#         failure line for that fixture's SHOT_NAME appears in the log
#         (Maestro logs a failed-but-optional assertVisible distinctly from
#         a hard failure — grep for its warning marker).
# FAIL  — a screenshot exists but the optional assertion for it failed (the
#         expected preview-render-* id never appeared — investigate the
#         screenshot, this is exactly the blank/spinner/wrong-type case).
# NO-RUN — no screenshot at all for that fixture — the flow stopped before
#         reaching it (check maestro-stdout.log for the hard failure, most
#         likely fixture N-1's row/preview-close step, not a render bug).
echo ""
echo "=== 1565 mobile preview-matrix summary ==="
PASS=0
FAIL=0
NORUN=0
TOTAL=0
while IFS= read -r shot; do
  name="$(basename "$shot" .png)"
  TOTAL=$((TOTAL + 1))
  # Maestro's optional-failure line names the command's own id/selector, not
  # the flow's SHOT_NAME — so this greps a window AROUND the fixture's own
  # screenshot line in the log instead of an exact per-fixture tag. Good
  # enough for a first pass; the lead still looks at every screenshot
  # (task's own rule) before trusting any row as PASS.
  if grep -B4 "$name" "$LOG_FILE" | grep -qiE "optional.*fail|failed.*optional"; then
    echo "FAIL   $name"
    FAIL=$((FAIL + 1))
  else
    echo "PASS?  $name"
    PASS=$((PASS + 1))
  fi
done < <(find "$EVIDENCE_DIR" -maxdepth 1 -name '1565-*.png' | sort)

EXPECTED_TOTAL=59
NORUN=$((EXPECTED_TOTAL - TOTAL))
echo "-------------------------------------------"
echo "$PASS likely-PASS, $FAIL likely-FAIL (optional assert missed), $NORUN never reached, of $EXPECTED_TOTAL fixtures"
echo "Screenshots + this log: $EVIDENCE_DIR"
echo "PASS?/FAIL above is a first-pass signal only — task 1565's own rule"
echo "applies: the lead looks at every screenshot before recording PASS/FAIL."

exit "$MAESTRO_EXIT"
