#!/usr/bin/env bash
# Task 1943 mobile M1 — Android release guard (spec S6, decision D15).
#
# D15 amendment 2026-10-30 (workspace lead ruling; guard owner s3-lead; plan "Amendment 2026-10-30 (2)"):
# the guard ships WITH the change it protects. An Android build may reach a tester only while its UniFFI
# binding AND its Android content readers are the last Android-verified ones. Any change to them re-arms
# the guard on its own until the reviewed PR that records Android verification (M7) moves the pins.
#
# Runs from `package.json`'s `eas-build-pre-install` hook on EVERY EAS build, cloud or `--local`.
# Inside an EAS build (any `EAS_BUILD*` variable set) the platform comes from `EAS_BUILD_PLATFORM`:
#   - ios                → allowed;
#   - android            → allowed ONLY if, under modules/beebeeb-crypto/:
#                            * CORE_REV equals ANDROID_VERIFIED_CORE_REV, and
#                            * every file in ANDROID_VERIFIED_FILES hashes to its pinned sha256
#                              (the Kotlin binding, both .so files, the Android content readers), and
#                            * no other .so exists under android/src/main/jniLibs (no unpinned ABI);
#                          anything else (a new CORE_REV, a rebuilt or added artifact, an edited reader,
#                          a missing file, a re-armed pin) is REFUSED;
#   - unset / unknown    → refused (failing closed).
# ANDROID_VERIFIED_CORE_REV="unverified" (the sentinel; an empty value counts the same) refuses every
# Android build. 1943 M2 needs no CORE_REV bump — the binding at c08defc already exports the pin-aware
# readers (decryptChunkFrame, ChunkDecryptorHandle, decryptThumbnail, decryptChunksToFile) — so M2 sets
# the pin to "unverified" in the SAME commit as its Android reader changes. Only the M7 PR sets a real
# revision, and re-pins every file below.
#
# There is deliberately NO evidence-file unlock: a text check on a repo file can be satisfied by anything.
# Moving a pin is a reviewed code change. `eas submit` and direct Gradle `bundleRelease`/`assembleRelease`
# are not covered (follow-up in the M1 PR body).
#
# The .so pins are the sha256 of the real binaries (their Git LFS oids). A Git LFS pointer stub on disk is
# refused with "run git lfs pull": it would ship a broken library anyway.
#
# Local use: `EAS_BUILD=true EAS_BUILD_PLATFORM=android bash scripts/android-release-guard.sh`
# Test: `src/lib/android-release-guard.test.ts`. Outside an EAS build, positional `$1` is a test
# convenience only, with the same rule; `$2` is accepted and ignored. bash 3.2 compatible.
# iOS exits FIRST, before `set -euo pipefail` and before anything multi-line: each of these two lines
# ends in ` #`, so even a CRLF copy of this script (a trailing \r lands inside the comment) still allows
# an iOS build. Inside an EAS build only EAS_BUILD_PLATFORM counts; outside, positional $1.
__p="${EAS_BUILD_PLATFORM:-}"; [ -n "${!EAS_BUILD*}" ] || __p="${1:-}"; __p="$(printf '%s' "$__p" | tr '[:upper:]' '[:lower:]')" #
[ "$__p" = "ios" ] && { echo "android-release-guard: platform 'ios' — not an Android build, allowed"; exit 0; } #
set -euo pipefail

# --- Android-verified pins: move ONLY in a reviewed PR that records Android verification (M7) -----------
# c08defc is GRANDFATHERED: it is the binding Android shipped through internal testing up to versionCode 10,
# before M7 existed; it was not M7-measured. The M7 PR replaces it with a measured revision.
ANDROID_VERIFIED_CORE_REV="unverified"
# "<path under modules/beebeeb-crypto> <sha256>", one per line.
ANDROID_VERIFIED_FILES="
android/src/main/java/uniffi/beebeeb_uniffi/beebeeb_uniffi.kt 042176240f99e9444a6f3a09ca6132290bf988a74be97a96f518d7fa759d38e3
android/src/main/jniLibs/arm64-v8a/libbeebeeb_uniffi.so 44a3c481542e952025ae8433ffd8fba0c7c6985432f0bcc7031f058c9c985202
android/src/main/jniLibs/x86_64/libbeebeeb_uniffi.so c7a70b2392fefb82fdd9ef0f09426a19c61a50211976f03123e1f348cfe888bd
android/src/main/java/expo/modules/beebeebcrypto/BeebeebCryptoModule.kt 838e4a5d8b1897f778403a1584f51b83a5dce8fb1bba8c9af61d39a78dbfe094
android/src/main/java/expo/modules/beebeebcrypto/VideoStreamer.kt e51bc23e5ecf28001dc19e3ef358bdec821fe63970d2f6745276a61b57f71cf5
android/src/main/java/expo/modules/beebeebcrypto/VideoChunkMath.kt b20937abdbe00416f22845bf5c6ce6894e860bdfba3342bea77d86093ba2edf3
android/src/main/java/expo/modules/beebeebcrypto/PreviewDownloadProgress.kt ab17d5fe4c1e58700609db24998ea41ed9828601b0ad46c116d11b6db627b8dd
android/src/main/java/expo/modules/beebeebcrypto/SharedKeyOps.kt 8701b3d6b07a5bc96c11fa6a39cdc5b8ae64b7a16d52e301e8f64475e5c32cf9
android/src/main/java/expo/modules/beebeebcrypto/SharedKeyRegistry.kt 714b8dfea48a7960784ce0cfec5ee68866163321a462945288ca39d699515427
android/src/main/java/expo/modules/beebeebcrypto/BeebeebCryptoHandleRegistry.kt 6534d83e1d453ac26a72139e208fa4ea823236f187ade8739ca3d8aa31e69c4b
android/src/main/java/expo/modules/beebeebcrypto/NativeManualUploader.kt 3d2a1ca9e2a1bcf241d3ddd4e81e2e6524e23ad2f6d65d45803b7209e09b7b7f
"
# ----------------------------------------------------------------------------------------------------------

# Prefix expansion, no pipe. `${!EAS_BUILD@}` would split the names into separate words and
# break `[ -n ... ]` once two or more are set; `${!EAS_BUILD*}` quotes into one string.
if [ -n "${!EAS_BUILD*}" ]; then
  PLATFORM="$(printf '%s' "${EAS_BUILD_PLATFORM:-}" | tr '[:upper:]' '[:lower:]')"
else
  PLATFORM="$(printf '%s' "${1:-}" | tr '[:upper:]' '[:lower:]')"
fi

# Builtins only, so a refusal is always reported even if external tools are missing.
refuse() {
  printf 'android-release-guard: REFUSED — %s.\n' "$1" >&2
  printf '%s\n' "Android reaches a tester only on the last Android-verified binding and readers (D15, amended" \
    "2026-10-30). A change to them re-arms this guard until the reviewed PR that records Android" \
    "verification (M7) moves the pins in scripts/android-release-guard.sh. \`eas submit\` and direct" \
    "Gradle \`bundleRelease\`/\`assembleRelease\` are not covered." >&2
  exit 1
}

if [ "$PLATFORM" = "ios" ]; then
  echo "android-release-guard: platform 'ios' — not an Android build, allowed"
  exit 0
fi

# Resolved only AFTER the iOS exit, so nothing about the tree can refuse an iOS build. `CDPATH=` and
# `>/dev/null` keep an exported CDPATH from printing the target or resolving a different directory.
ROOT="$(CDPATH= cd -- "$(dirname -- "${BASH_SOURCE[0]}")/.." >/dev/null && pwd)"
MOD="$ROOT/modules/beebeeb-crypto"

case "$PLATFORM" in
  android) ;;
  "") refuse "no build platform (failing closed)" ;;
  *) refuse "unknown platform '${PLATFORM}' (failing closed)" ;;
esac

case "$ANDROID_VERIFIED_CORE_REV" in
  ""|unverified) refuse "the guard is re-armed (Android-verified pin is '${ANDROID_VERIFIED_CORE_REV:-<empty>}')" ;;
esac

if command -v shasum >/dev/null 2>&1; then HASH="shasum -a 256"
elif command -v sha256sum >/dev/null 2>&1; then HASH="sha256sum"
else refuse "no sha256 tool (shasum or sha256sum) to check the Android-verified pins (failing closed)"; fi

CORE_REV_FILE="$MOD/CORE_REV"
[ -f "$CORE_REV_FILE" ] || refuse "CORE_REV is missing, so this is not the last Android-verified binding (failing closed)"
CURRENT_REV="$(tr -d '[:space:]' < "$CORE_REV_FILE")"
[ "$CURRENT_REV" = "$ANDROID_VERIFIED_CORE_REV" ] \
  || refuse "CORE_REV ${CURRENT_REV:-<empty>} is not the last Android-verified binding (${ANDROID_VERIFIED_CORE_REV})"

PINNED_SO=""
while read -r rel expected; do
  [ -n "$rel" ] || continue
  f="$MOD/$rel"
  [ -f "$f" ] || refuse "$rel is missing, so this is not the last Android-verified binding (failing closed)"
  case "$rel" in *.so) PINNED_SO="$PINNED_SO|$rel|" ;; esac
  case "$(head -c 64 "$f" 2>/dev/null | LC_ALL=C tr -d '\000')" in
    "version https://git-lfs.github.com/spec"*) refuse "$rel is a Git LFS pointer stub, not the library (run git lfs pull)" ;;
  esac
  got="$($HASH "$f" | cut -c1-64)"
  [ "$got" = "$expected" ] || refuse "$rel (sha256 $got) is not the last Android-verified binding"
done <<EOF
$ANDROID_VERIFIED_FILES
EOF

JNI="$MOD/android/src/main/jniLibs"
if [ -d "$JNI" ]; then
  while IFS= read -r so; do
    [ -n "$so" ] || continue
    rel="${so#"$MOD"/}"
    case "$PINNED_SO" in
      *"|$rel|"*) ;;
      *) refuse "$rel is an unpinned native library, so this is not the last Android-verified binding" ;;
    esac
  done <<EOF
$(find "$JNI" -type f -name '*.so')
EOF
fi

echo "android-release-guard: android on the Android-verified binding and readers (CORE_REV ${CURRENT_REV}), allowed"
exit 0
