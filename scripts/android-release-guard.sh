#!/usr/bin/env bash
# Task 1943 mobile M1 — Android release guard (spec S6, decision D15).
#
# D15 amendment 2026-10-30 (workspace lead ruling, guard owner s3-lead): the guard ships WITH the
# change it protects. An Android build may reach a tester only while its UniFFI binding is the last
# Android-verified one; any binding bump re-arms the guard on its own until the reviewed M7 PR (or a
# later Android verification) moves the pins below.
#
# Runs from `package.json`'s `eas-build-pre-install` hook on EVERY EAS build, cloud or `--local`.
# Inside an EAS build (any `EAS_BUILD*` variable set) the platform comes from `EAS_BUILD_PLATFORM`:
#   - ios                       → allowed;
#   - android                   → allowed ONLY if modules/beebeeb-crypto/CORE_REV equals
#                                 ANDROID_VERIFIED_CORE_REV AND the Kotlin binding and both .so files
#                                 hash to their pinned sha256; anything else (a new CORE_REV, a rebuilt
#                                 artifact, a missing file, an empty pin) is REFUSED;
#   - unset / unknown           → refused (failing closed).
# ANDROID_VERIFIED_CORE_REV="unverified" (the sentinel; an empty value counts the same) refuses every
# Android build: that is how a PR that changes the Android readers WITHOUT a binding bump re-arms the
# guard (1943 M2 does this; plan "Amendment 2026-10-30 (2)"). Only the M7 PR sets a real revision.
#
# There is deliberately NO evidence-file unlock: a text check on a repo file can be satisfied by
# anything. Moving a pin is a reviewed code change. `eas submit` and direct Gradle
# `bundleRelease`/`assembleRelease` are not covered (follow-up in the M1 PR body).
#
# The .so pins are the sha256 of the real binaries (the Git LFS oids). If LFS was not pulled the
# files on disk are pointer stubs, their hashes do not match, and the build is refused — it would
# ship a broken library anyway.
#
# Local use: `EAS_BUILD_PLATFORM=android EAS_BUILD=true scripts/android-release-guard.sh`
# Test: `src/lib/android-release-guard.test.ts`. Outside an EAS build, positional `$1` is a test
# convenience only, with the same rule; `$2` is accepted and ignored.
set -euo pipefail

# --- Android-verified binding pins (move ONLY in a reviewed PR that records Android verification) ---
ANDROID_VERIFIED_CORE_REV="c08defc70c35428926be6784d18ff091be6d004c"
ANDROID_VERIFIED_KT_SHA256="042176240f99e9444a6f3a09ca6132290bf988a74be97a96f518d7fa759d38e3"
ANDROID_VERIFIED_SO_ARM64_SHA256="44a3c481542e952025ae8433ffd8fba0c7c6985432f0bcc7031f058c9c985202"
ANDROID_VERIFIED_SO_X86_64_SHA256="c7a70b2392fefb82fdd9ef0f09426a19c61a50211976f03123e1f348cfe888bd"
# ------------------------------------------------------------------------------------------------------

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
MOD="$ROOT/modules/beebeeb-crypto"

# Prefix expansion, no pipe. `${!EAS_BUILD@}` would split the names into separate words and
# break `[ -n ... ]` once two or more are set; `${!EAS_BUILD*}` quotes into one string.
if [ -n "${!EAS_BUILD*}" ]; then
  PLATFORM="$(printf '%s' "${EAS_BUILD_PLATFORM:-}" | tr '[:upper:]' '[:lower:]')"
else
  PLATFORM="$(printf '%s' "${1:-}" | tr '[:upper:]' '[:lower:]')"
fi

refuse() {
  cat >&2 <<EOF
android-release-guard: REFUSED — $1.
Android reaches a tester only on the last Android-verified UniFFI binding (D15, amended 2026-10-30).
A binding bump re-arms this guard until the reviewed PR that records Android verification (M7)
moves the pins in scripts/android-release-guard.sh. \`eas submit\` and direct Gradle
\`bundleRelease\`/\`assembleRelease\` are not covered.
EOF
  exit 1
}

sha256_of() {
  if command -v shasum >/dev/null 2>&1; then shasum -a 256 "$1" | cut -c1-64
  else sha256sum "$1" | cut -c1-64; fi
}

if [ "$PLATFORM" = "ios" ]; then
  echo "android-release-guard: platform 'ios' — not an Android build, allowed"
  exit 0
fi

case "$PLATFORM" in
  android) ;;
  "") refuse "no build platform (failing closed)" ;;
  *) refuse "unknown platform '${PLATFORM}' (failing closed)" ;;
esac

case "$ANDROID_VERIFIED_CORE_REV" in
  ""|unverified) refuse "the guard is re-armed (Android-verified pin is '${ANDROID_VERIFIED_CORE_REV:-<empty>}')" ;;
esac

CORE_REV_FILE="$MOD/CORE_REV"
[ -f "$CORE_REV_FILE" ] || refuse "CORE_REV is missing, so this is not the last Android-verified binding (failing closed)"
CURRENT_REV="$(tr -d '[:space:]' < "$CORE_REV_FILE")"
[ "$CURRENT_REV" = "$ANDROID_VERIFIED_CORE_REV" ] \
  || refuse "CORE_REV ${CURRENT_REV:-<empty>} is not the last Android-verified binding (${ANDROID_VERIFIED_CORE_REV})"

check_pin() { # <relative path> <expected sha256>
  local f="$MOD/$1"
  [ -f "$f" ] || refuse "$1 is missing, so this is not the last Android-verified binding (failing closed)"
  local got; got="$(sha256_of "$f")"
  [ "$got" = "$2" ] || refuse "$1 (sha256 ${got}) is not the last Android-verified binding"
}
check_pin "android/src/main/java/uniffi/beebeeb_uniffi/beebeeb_uniffi.kt" "$ANDROID_VERIFIED_KT_SHA256"
check_pin "android/src/main/jniLibs/arm64-v8a/libbeebeeb_uniffi.so" "$ANDROID_VERIFIED_SO_ARM64_SHA256"
check_pin "android/src/main/jniLibs/x86_64/libbeebeeb_uniffi.so" "$ANDROID_VERIFIED_SO_X86_64_SHA256"

echo "android-release-guard: android on the Android-verified binding (CORE_REV ${CURRENT_REV}), allowed"
exit 0
