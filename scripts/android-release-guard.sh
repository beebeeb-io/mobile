#!/usr/bin/env bash
# Task 1943 mobile M1 — Android release guard (spec S6, decision D15).
#
# Runs from `package.json`'s `eas-build-pre-install` hook on EVERY EAS build, cloud or
# `--local`. EVERY Android build is refused — any profile (`production`, `production-local`,
# `preview`, `development`, `simulator`) — while `docs/_qa-evidence/1943-mobile/android-m7.md`
# is missing or does not carry M7's recorded results. There is no profile allowlist on
# purpose: `preview` is an installable APK for testers, and spec §2 says no Android build
# reaches a tester before M7. iOS builds are never refused.
#
# What the evidence file must contain:
#   - the heading line `## Android M7 evidence`, and
#   - at least one line with `passed` and a number, e.g.
#     `- connectedDebugAndroidTest: 33 passed / 0 failed`.
# An empty file, a heading with nothing under it, or a placeholder is refused.
#
# NOT covered by this guard (follow-up for s3-lead): `eas submit` (it never runs
# `eas-build-pre-install`) and a direct Gradle `bundleRelease`/`assembleRelease`. Those
# paths need their own hook; this script only sees EAS *builds*.
#
# Local use: `EAS_BUILD_PLATFORM=android EAS_BUILD_PROFILE=production scripts/android-release-guard.sh`
# Test: `src/lib/android-release-guard.test.ts`. The test passes platform and profile as
# positional arguments ($1, $2) so it does not need to set EAS_BUILD*. BB_GUARD_ROOT is a
# test-only hook, honoured only when BB_GUARD_TEST=1 and no EAS_BUILD* variable is set, so a
# real EAS build can never be pointed at a different evidence file.
set -euo pipefail

SCRIPT_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
ROOT="$SCRIPT_ROOT"
if [ -n "${BB_GUARD_ROOT:-}" ]; then
  if [ "${BB_GUARD_TEST:-}" = "1" ] && ! env | grep -Eq '^EAS_BUILD[A-Z_]*='; then
    ROOT="$BB_GUARD_ROOT"
  else
    echo "android-release-guard: ignoring BB_GUARD_ROOT (test-only: needs BB_GUARD_TEST=1 and no EAS_BUILD* variable)" >&2
  fi
fi

EVIDENCE="docs/_qa-evidence/1943-mobile/android-m7.md"
PLATFORM="$(printf '%s' "${1:-${EAS_BUILD_PLATFORM:-}}" | tr '[:upper:]' '[:lower:]')"
PROFILE="${2:-${EAS_BUILD_PROFILE:-}}"

if [ "$PLATFORM" != "android" ]; then
  echo "android-release-guard: platform '${PLATFORM:-unset}' — not an Android build, allowed"
  exit 0
fi

# M7's recorded results: the heading AND a `passed` line carrying a count.
if [ -f "$ROOT/$EVIDENCE" ] && awk '
  BEGIN { heading = 0; passed = 0 }
  /^## Android M7 evidence[[:space:]]*$/ { heading = 1 }
  tolower($0) ~ /passed/ && $0 ~ /[0-9]/ { passed = 1 }
  END { exit !(heading && passed) }
' "$ROOT/$EVIDENCE"; then
  echo "android-release-guard: $EVIDENCE carries M7 evidence — Android build allowed"
  exit 0
fi

cat >&2 <<EOF
android-release-guard: REFUSED — every Android EAS build is refused (profile '${PROFILE:-unset}').
$EVIDENCE is missing or does not carry M7's results.

Task 1943 M1 (spec S6 / D15): no Android build reaches a tester before M7 has run the emulator
cells and the device KAT and recorded them in that file — it must contain the heading
"## Android M7 evidence" and a "passed" line with a count. See
docs/superpowers/plans/2026-10-25-1943-mobile-chunk-format.md, task M7.
EOF
exit 1
