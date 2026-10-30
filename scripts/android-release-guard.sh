#!/usr/bin/env bash
# Task 1943 mobile M1 — Android release guard (spec S6, decision D15).
#
# Android ships nothing until task 1943 M7 passes. The PR that records M7's evidence removes
# this guard from `eas-build-pre-install`, reviewed. `eas submit` and direct Gradle
# `bundleRelease`/`assembleRelease` are not covered (a follow-up in the PR body).
#
# Runs from `package.json`'s `eas-build-pre-install` hook on EVERY EAS build, cloud or
# `--local`. It fails closed: inside an EAS build (any `EAS_BUILD*` variable set) only an
# `EAS_BUILD_PLATFORM` of `ios` is allowed. `android`, an unset platform and an unknown
# platform are all refused — every Android profile (`production`, `production-local`,
# `preview`, `development`, `simulator`) is refused, because `preview` is an installable APK
# for testers and spec §2 says no Android build reaches a tester before M7.
#
# There is deliberately NO evidence-file unlock: a text check on a repo file can be satisfied
# by anything ("0 passed / 33 failed" unlocked an earlier version), so the guard cannot fail
# open. Removing it is a reviewed code change in the PR that records M7's evidence.
#
# Local use: `EAS_BUILD_PLATFORM=android scripts/android-release-guard.sh`
# Test: `src/lib/android-release-guard.test.ts`, which drives this script through `bash` with
# the EAS_* variables EAS sets. Outside an EAS build, positional `$1` is a test convenience
# only, with the same rule; `$2` is accepted and ignored.
set -euo pipefail

# Prefix expansion, no pipe. `${!EAS_BUILD@}` would split the names into separate words and
# break `[ -n ... ]` once two or more are set; `${!EAS_BUILD*}` quotes into one string.
if [ -n "${!EAS_BUILD*}" ]; then
  PLATFORM="$(printf '%s' "${EAS_BUILD_PLATFORM:-}" | tr '[:upper:]' '[:lower:]')"
else
  PLATFORM="$(printf '%s' "${1:-}" | tr '[:upper:]' '[:lower:]')"
fi

if [ "$PLATFORM" = "ios" ]; then
  echo "android-release-guard: platform 'ios' — not an Android build, allowed"
  exit 0
fi

case "$PLATFORM" in
  android) REASON="an Android build" ;;
  "") REASON="no build platform (failing closed)" ;;
  *) REASON="unknown platform '${PLATFORM}' (failing closed)" ;;
esac

cat >&2 <<EOF
android-release-guard: REFUSED — ${REASON}.
Android ships nothing until task 1943 M7 passes. The PR that records M7's evidence removes
this guard from \`eas-build-pre-install\`, reviewed. \`eas submit\` and direct Gradle
\`bundleRelease\`/\`assembleRelease\` are not covered (a follow-up in the PR body).
EOF
exit 1
