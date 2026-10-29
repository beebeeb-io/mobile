#!/usr/bin/env bash
# Task 1943 mobile M1 — Android release guard (spec S6, decision D15).
#
# Runs from `package.json`'s `eas-build-pre-install` hook on every EAS build. An Android
# release build (a `production*` profile, or an `internal`/`production` submit track) is
# refused while `docs/_qa-evidence/1943-mobile/android-m7.md` is absent: M7 writes that file
# when the emulator cells and the device KAT have run, so no Android build on the post-1908
# core reaches a tester before its Android side is proven (§2: Android ships nothing until then).
# iOS builds are never affected — this guard is Android-only by construction.
#
# Local use: `EAS_BUILD_PLATFORM=android EAS_BUILD_PROFILE=production scripts/android-release-guard.sh`
# Test: `src/lib/android-release-guard.test.ts` (drives this script with a throwaway BB_GUARD_ROOT).
set -euo pipefail

ROOT="${BB_GUARD_ROOT:-$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)}"
EVIDENCE="docs/_qa-evidence/1943-mobile/android-m7.md"

PLATFORM="$(printf '%s' "${EAS_BUILD_PLATFORM:-}" | tr '[:upper:]' '[:lower:]')"
PROFILE="${EAS_BUILD_PROFILE:-}"
TRACK="$(printf '%s' "${EAS_SUBMIT_TRACK:-${EAS_BUILD_TRACK:-${BEEBEEB_ANDROID_TRACK:-}}}" | tr '[:upper:]' '[:lower:]')"

if [ "$PLATFORM" != "android" ]; then
  echo "android-release-guard: platform '${PLATFORM:-unset}' — not an Android build, allowed"
  exit 0
fi

release=0
case "$PROFILE" in
  production|production-*|internal|internal-*) release=1 ;;
esac
case "$TRACK" in
  internal|production) release=1 ;;
esac

if [ "$release" -eq 0 ]; then
  echo "android-release-guard: profile '${PROFILE:-unset}' is not an Android release build, allowed"
  exit 0
fi

if [ -f "$ROOT/$EVIDENCE" ]; then
  echo "android-release-guard: $EVIDENCE present — Android release build allowed"
  exit 0
fi

cat >&2 <<EOF
android-release-guard: REFUSED — Android release build (profile '${PROFILE:-unset}', track '${TRACK:-unset}').
$EVIDENCE is missing.

Task 1943 M1 (spec S6 / D15): no Android build reaches a tester before M7 has run the emulator
cells and the device KAT and recorded them in that file. See
docs/superpowers/plans/2026-10-25-1943-mobile-chunk-format.md, task M7.
EOF
exit 1
