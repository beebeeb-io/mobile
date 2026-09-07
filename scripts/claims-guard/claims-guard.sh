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

# Scheme URLs (case-insensitive; http/https/ws/wss) and scheme-relative URLs
# (`//host` — requires a dot in the host, which is what stops a bare `//`
# line-comment or a Rust `///` doc-comment from matching literally anything).
HOST_URL_RE='(https?|wss?)://[A-Za-z0-9._-]+|//[A-Za-z0-9-]+\.[A-Za-z0-9._-]+'

TMPFILES=()
cleanup_tmp() { local f; for f in ${TMPFILES[@]+"${TMPFILES[@]}"}; do rm -f "$f"; done; }
trap cleanup_tmp EXIT

new_tmp() { local f; f="$(mktemp)"; TMPFILES+=("$f"); printf '%s' "$f"; }

report() { printf '%sclaims-guard: %s%s\n' "$RED" "$1" "$NC"; FAIL=1; }

git_grep_or_die() { # git_grep_or_die <outfile> <git-grep-args...>
  # `git grep` exits 1 when it simply finds no match — not an error. Any
  # other non-zero exit (128 = fatal, e.g. an invalid ERE in policy.conf) is
  # a real operational failure; the old `2>/dev/null || true` swallowed it
  # and reported a false "clean" instead of failing loud. Distinguish the
  # two: print git's own stderr and hard-exit 2 (misconfiguration) on
  # anything but "no match".
  local outfile="$1"; shift
  local errfile rc
  errfile="$(new_tmp)"
  git -C "$ROOT" grep "$@" >"$outfile" 2>"$errfile"
  rc=$?
  if [ "$rc" -gt 1 ]; then
    echo "claims-guard: git grep failed (exit $rc): $(cat "$errfile")" >&2
    exit 2
  fi
}

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

in_non_network_host() { # in_non_network_host <host> — namespace URIs and
  # RFC-reserved test/doc hosts that are not a real network destination.
  local low
  low="$(printf '%s' "$1" | tr '[:upper:]' '[:lower:]')"
  case "$low" in
    *.test|*.invalid|*.example) return 0 ;;
  esac
  printf '%s\n' "${NON_NETWORK_HOSTS[@]}" | grep -qxF "$low"
}

extract_hosts() { # extract_hosts <line> — every host referenced by a
  # network-shaped URL on the line: scheme URLs (case-insensitive; http,
  # https, ws, wss) and scheme-relative URLs (`//host`, once any real
  # scheme:// prefix has been stripped so it isn't double-counted).
  local line="$1" bare
  printf '%s\n' "$line" | grep -oEi '(https?|wss?)://[A-Za-z0-9._-]+' | sed -E 's#^[A-Za-z]+://##'
  bare="$(printf '%s\n' "$line" | sed -E 's#[A-Za-z][A-Za-z0-9+.-]*://##g')"
  printf '%s\n' "$bare" | grep -oE '//[A-Za-z0-9-]+\.[A-Za-z0-9._-]+' | sed -E 's#^//##'
}

scan() { # scan <label> <ci|cs> <ERE> <origin|claims> <pathspec...>
  local label="$1" case="$2" re="$3" exclset="$4"; shift 4
  local flags="-nEI" gflags="-oE"
  [ "$case" = "ci" ] && { flags="-nEIi"; gflags="-oEi"; }
  local -a excl=(':(exclude)docs/*' ':(exclude,glob)**/graphify-out/**'
                 ':(exclude,glob)**/node_modules/**' ':(exclude,glob)**/target/**' ':(exclude,glob)**/dist/**')
  if [ "$exclset" = "origin" ]; then
    excl+=(':(exclude)*.md')
  else
    excl+=(':(exclude)CHANGELOG.md' ':(exclude)CLAUDE.md' ':(exclude)RELEASE_NOTES.md'
           ':(exclude,glob)**/CHANGELOG.md' ':(exclude,glob)**/CLAUDE.md' ':(exclude,glob)**/RELEASE_NOTES.md')
  fi
  local hit path rest matched outfile
  outfile="$(new_tmp)"
  git_grep_or_die "$outfile" $flags -e "$re" -- "$@" "${excl[@]}"
  while IFS= read -r hit; do
    [ -n "$hit" ] || continue
    path="${hit%%:*}"; rest="${hit#*:}"; rest="${rest#*:}"
    # A line can carry more than one DISTINCT match — e.g. an already-allowed
    # token followed by a newly-banned one. The old code took only the first
    # match (`head -1`) and let an allow-line for THAT token `continue` past
    # the whole line, so a second prohibited token on the same line was never
    # checked. Walk every distinct match; an allow-line covers only its own
    # token, never the rest of the line.
    while IFS= read -r matched; do
      [ -n "$matched" ] || continue
      if is_allowed "$path" "$matched"; then continue; fi
      report "$label  $hit"
      printf '      allow with: %s|%s|<why this is true>\n' "$path" "$matched"
    done < <(printf '%s\n' "$rest" | grep $gflags -- "$re" | sort -u)
  done < "$outfile"
}

check_hosts() {
  local hit path outfile
  outfile="$(new_tmp)"
  git_grep_or_die "$outfile" -nEI -i -e "$HOST_URL_RE" -- "${RUNTIME_PATHS[@]}" \
    ':(exclude)*.md' ':(exclude)docs/*' ':(exclude,glob)**/graphify-out/**' \
    ':(exclude,glob)**/node_modules/**' ':(exclude,glob)**/target/**' ':(exclude,glob)**/dist/**' \
    "${TEST_FILE_EXCLUDES[@]}"
  while IFS= read -r hit; do
    [ -n "$hit" ] || continue
    path="${hit%%:*}"
    while IFS= read -r host; do
      [ -n "$host" ] || continue
      if in_non_network_host "$host"; then continue; fi
      if in_allowed_hosts "$host"; then continue; fi
      if is_allowed "$path" "$host"; then continue; fi
      report "host-allowlist  $path  unknown host: $host"
      printf '      allow with: %s|%s|<why this host is in the data path>\n' "$path" "$host"
    done < <(extract_hosts "$hit" | sed -E 's/[]).,;:!?}"]+$//' | sort -u)
  done < "$outfile"
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
scan "provider-name"  ci "$PROVIDER_NAMES" claims "${USER_FACING_PATHS[@]}"
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
