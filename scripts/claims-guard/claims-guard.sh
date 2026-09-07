#!/usr/bin/env bash
# claims-guard — fail a build when a closed compliance or copy decision reopens.
#
#   claims-guard.sh                # scan the repo this script lives in
#   claims-guard.sh --canon FILE   # also assert LIVE_REGIONS == the canon block
#
# Exit 0 clean · 1 violations · 2 misconfiguration.
# Bypass is ONLY through <repo>/.claims-allow (path|token|evidence), which lives
# in the diff and is reviewed like any other change. There is no env override.
#
# Markdown handling differs by check family (decided 2026-09-07, see PR #9):
#   - origin/host checks (banned-origin, host-allowlist) exclude *.md entirely.
#     A URL written in a doc is not a runtime data-path origin.
#   - claim checks (provider-name, banned-claim, phantom-region, region-claim)
#     do NOT blanket-exclude *.md, because README.md is user-facing copy (it is
#     the trust document on the public repos) and must be scanned. docs/* and
#     graphify-out/* stay excluded either way (internal, not user-facing), and
#     CHANGELOG.md/CLAUDE.md/RELEASE_NOTES.md are excluded explicitly wherever
#     they'd otherwise be swept in under src/public (changelogs and agent docs
#     legitimately discuss banned words in the negative/historical sense).
set -uo pipefail

HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
ROOT="$(git -C "$HERE" rev-parse --show-toplevel)" || { echo "claims-guard: not a git repo" >&2; exit 2; }
[ -f "$HERE/policy.conf" ] || { echo "claims-guard: policy.conf missing next to the engine" >&2; exit 2; }
# shellcheck source=policy.conf
. "$HERE/policy.conf"

ALLOW_FILE="$ROOT/.claims-allow"
RED=$'\033[0;31m'; NC=$'\033[0m'
FAIL=0

report() { printf '%sclaims-guard: %s%s\n' "$RED" "$1" "$NC"; FAIL=1; }

allow_lines() {
  [ -f "$ALLOW_FILE" ] || return 0
  grep -v '^[[:space:]]*#' "$ALLOW_FILE" 2>/dev/null | grep -v '^[[:space:]]*$' || true
}

validate_allow_file() {
  local line n=0 rest ev
  while IFS= read -r line; do
    n=$((n + 1))
    rest="${line#*|}"
    if [ "$rest" = "$line" ]; then report "$ALLOW_FILE line $n: expected path|token|evidence"; continue; fi
    ev="${rest#*|}"
    if [ "$ev" = "$rest" ]; then report "$ALLOW_FILE line $n: missing evidence field"; continue; fi
    if [ -z "${ev//[[:space:]]/}" ]; then report "$ALLOW_FILE line $n: evidence field is empty"; fi
  done < <(allow_lines)
}

is_allowed() { # is_allowed <path> <token>
  allow_lines | cut -d'|' -f1,2 | grep -qxiF "$1|$2"
}

in_allowed_hosts() { # in_allowed_hosts <host>
  printf '%s\n' "${ALLOWED_HOSTS[@]}" | grep -qxF "$1"
}

scan() { # scan <label> <ci|cs> <ERE> <origin|claims> <pathspec...>
  local label="$1" case="$2" re="$3" exclset="$4"; shift 4
  local flags="-nEI" gflags="-oE"
  [ "$case" = "ci" ] && { flags="-nEIi"; gflags="-oEi"; }
  local -a excl=(':(exclude)docs/*' ':(exclude,glob)**/graphify-out/**')
  if [ "$exclset" = "origin" ]; then
    excl+=(':(exclude)*.md')
  else
    excl+=(':(exclude)CHANGELOG.md' ':(exclude)CLAUDE.md' ':(exclude)RELEASE_NOTES.md'
           ':(exclude,glob)**/CHANGELOG.md' ':(exclude,glob)**/CLAUDE.md' ':(exclude,glob)**/RELEASE_NOTES.md')
  fi
  local hit path rest matched
  while IFS= read -r hit; do
    [ -n "$hit" ] || continue
    path="${hit%%:*}"; rest="${hit#*:}"; rest="${rest#*:}"
    matched="$(printf '%s\n' "$rest" | grep $gflags -- "$re" | head -1)"
    if is_allowed "$path" "$matched"; then continue; fi
    report "$label  $hit"
    printf '      allow with: %s|%s|<why this is true>\n' "$path" "$matched"
  done < <(git -C "$ROOT" grep $flags -e "$re" -- "$@" "${excl[@]}" 2>/dev/null || true)
}

check_hosts() {
  local hit path host
  while IFS= read -r hit; do
    [ -n "$hit" ] || continue
    path="${hit%%:*}"
    while IFS= read -r host; do
      [ -n "$host" ] || continue
      if in_allowed_hosts "$host"; then continue; fi
      if is_allowed "$path" "$host"; then continue; fi
      report "host-allowlist  $path  unknown host: $host"
      printf '      allow with: %s|%s|<why this host is in the data path>\n' "$path" "$host"
    done < <(printf '%s\n' "$hit" | grep -oE 'https?://[A-Za-z0-9._-]+' | sed -E 's#^https?://##' | sort -u)
  done < <(git -C "$ROOT" grep -nEI -e 'https?://[A-Za-z0-9._-]+' -- "${RUNTIME_PATHS[@]}" ':(exclude)*.md' ':(exclude)docs/*' ':(exclude,glob)**/graphify-out/**' 2>/dev/null || true)
}

check_canon() { # check_canon <file>
  local f="$1" have want
  [ -f "$f" ] || { echo "claims-guard: canon file not found: $f" >&2; exit 2; }
  have="$(awk '/claims-guard:live-regions -->/{on=1;next} /\/claims-guard:live-regions/{on=0} on' "$f" \
          | tr -d ' \t' | grep -v '^$' | sort | tr '\n' ' ')"
  want="$(printf '%s\n' "${LIVE_REGIONS[@]}" | sort | tr '\n' ' ')"
  [ "$have" = "$want" ] || report "canon-drift  $f live-regions [$have] != policy.conf LIVE_REGIONS [$want]"
}

echo "claims-guard: scanning $ROOT"
validate_allow_file
scan "banned-origin"  ci "$DENIED_ORIGINS" origin "${RUNTIME_PATHS[@]}"
check_hosts
scan "provider-name"  cs "$PROVIDER_NAMES" claims "${USER_FACING_PATHS[@]}"
scan "banned-claim"   ci "$BANNED_CLAIMS"  claims "${USER_FACING_PATHS[@]}"
scan "phantom-region" ci "$PHANTOM_REGIONS" claims "${USER_FACING_PATHS[@]}"
if [ "${#LIVE_REGIONS[@]}" -eq 1 ]; then
  scan "region-claim (only ${LIVE_REGIONS[0]} is live)" ci "$MULTI_REGION_CLAIMS" claims "${USER_FACING_PATHS[@]}"
fi
[ "${1:-}" = "--canon" ] && check_canon "${2:?--canon needs a file}"

if [ "$FAIL" -ne 0 ]; then
  echo "claims-guard: FAILED — fix the copy/origin, or add a reviewed line to .claims-allow" >&2
  exit 1
fi
echo "claims-guard: clean"
