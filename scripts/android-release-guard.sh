#!/usr/bin/env bash
# Task 1943 D15 — the structural Android build guard (workspace lead ruling, 2026-10-30;
# workspace docs/superpowers/plans/2026-10-25-1943-mobile-chunk-format.md, "Amendment 2026-10-30 (2)").
#
# An Android build may only carry Android readers and a binding that task 1943 M7 verified.
# `ANDROID_VERIFIED_CORE_REV` below pins the last core revision whose Android readers M7 verified.
#   - An Android EAS build is REFUSED when the build's `modules/beebeeb-crypto/CORE_REV` differs
#     from the pin, when the pin is the sentinel `unverified`, or when CORE_REV cannot be read.
#   - Any PR that changes an Android content reader (the files listed in
#     `scripts/android-verified-readers.sha256`) sets the pin to `unverified` IN THE SAME COMMIT;
#     `src/lib/android-verified-readers.test.ts` fails otherwise. The binding at the pinned
#     revision already exports the pin-aware readers, so a reader change needs no CORE_REV bump.
#   - Only the reviewed M7 PR sets a real revision (and records the readers' new hashes).
#   - iOS is never refused.
#
# Runs from `package.json`'s `eas-build-pre-install` hook on every EAS build, cloud or `--local`.
# Inside an EAS build (any `EAS_BUILD*` variable set) the platform is `EAS_BUILD_PLATFORM`;
# outside one, positional `$1` (a test convenience; `$2` is ignored). An unset or unknown
# platform fails closed. `eas submit` and direct Gradle `bundleRelease`/`assembleRelease` are
# not covered (follow-up S3-0001). Test: `src/lib/android-release-guard.test.ts`.
set -euo pipefail

# The last core revision whose Android readers task 1943 M7 verified. M7's reviewed PR moves it.
ANDROID_VERIFIED_CORE_REV=c08defc70c35428926be6784d18ff091be6d004c

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
CORE_REV_FILE="$ROOT/modules/beebeeb-crypto/CORE_REV"

# Prefix expansion, no pipe. `${!EAS_BUILD*}` quotes into one string, safe for `[ -n ]`.
if [ -n "${!EAS_BUILD*}" ]; then
  PLATFORM="$(printf '%s' "${EAS_BUILD_PLATFORM:-}" | tr '[:upper:]' '[:lower:]')"
else
  PLATFORM="$(printf '%s' "${1:-}" | tr '[:upper:]' '[:lower:]')"
fi

refuse() {
  cat >&2 <<EOF
android-release-guard: REFUSED — $1.
An Android build may only carry Android readers and a binding that task 1943 M7 verified
(pinned ANDROID_VERIFIED_CORE_REV=${ANDROID_VERIFIED_CORE_REV} in scripts/android-release-guard.sh).
Only the reviewed M7 PR moves that pin. iOS builds are not affected.
EOF
  exit 1
}

case "$PLATFORM" in
  ios)
    echo "android-release-guard: platform 'ios' — not an Android build, allowed"
    exit 0
    ;;
  android) ;;
  "") refuse "no build platform (failing closed)" ;;
  *) refuse "unknown platform '${PLATFORM}' (failing closed)" ;;
esac

if [ "$ANDROID_VERIFIED_CORE_REV" = "unverified" ]; then
  refuse "Android readers changed since the last M7 verification (pin is 'unverified')"
fi

if [ ! -f "$CORE_REV_FILE" ] || [ ! -r "$CORE_REV_FILE" ]; then
  refuse "cannot read ${CORE_REV_FILE#"$ROOT"/} (failing closed)"
fi

# Exactly one line holding a full 40-hex revision; anything else fails closed.
CORE_REV="$(tr -d '\r' < "$CORE_REV_FILE")"
CORE_REV="${CORE_REV%$'\n'}"
case "$CORE_REV" in
  *[!0-9a-f]* | "") refuse "CORE_REV '${CORE_REV}' is not a core revision (failing closed)" ;;
esac
if [ "${#CORE_REV}" -ne 40 ]; then
  refuse "CORE_REV '${CORE_REV}' is not a core revision (failing closed)"
fi

if [ "$CORE_REV" != "$ANDROID_VERIFIED_CORE_REV" ]; then
  refuse "CORE_REV differs from the Android-verified revision (build ${CORE_REV}, verified ${ANDROID_VERIFIED_CORE_REV})"
fi

echo "android-release-guard: Android build at the M7-verified core revision ${CORE_REV}, allowed"
exit 0
