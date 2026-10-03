#!/usr/bin/env bash
set -euo pipefail

# Task 1600 [P1] structural guard: `chunkUploadContinuations`, `uploadTaskMap`
# and `chunkResponseBodyBuffers` on NativeBackupEngine must ALWAYS go through
# the `LockedDictionary` wrapper (a plain Dictionary there is unsafe — see the
# wrapper's doc comment in the source file for why: they're written from the
# URLSession delegate queue, Swift concurrency Tasks, dbQueue, and whatever
# thread calls stop(), with no synchronization between those). This is a
# grep-based structural check, not a runtime test — it can't prove the
# wrapper itself is race-free (the standalone TSan harness under
# .claude/tasks/_qa-evidence/1600-crash/r2-tsan-harness-locked_dict_stress.swift
# does that), only that nobody has re-introduced a raw Dictionary for these
# properties, or bypassed the wrapper's public API to reach its private
# `storage` directly.
#
# Task 1605 review round 3 (P2): extended rule 5 (call-site allowlist) to
# `chunkResponseBodyBuffers`, and rule 6 (computed-property + lock-backed) to
# `accountRefusalStopReason` — the same sibling-property extensions the
# round-1/round-2 comments above already describe for rules 3/4.
#
# `--self-test`: mutates a THROWAWAY COPY of the target file (never the real
# one) to break each of the two extended checks in turn, asserts this script
# reports FAIL for the mutated copy AND still reports PASS for the real,
# unmodified file, then exits 0. Run before trusting a change to this script
# (CLAUDE.md "How we work" — a guard must demonstrate it can go red before
# it is trusted to pass).
#
# NOTE: uses /usr/bin/grep explicitly, not the bare `grep`/`rg` names — on
# this machine both are shadowed (ugrep function / Claude Code's own `rg`
# wrapper) with different behavior than the real GNU/BSD binaries; see
# repos/mobile CLAUDE.md's "macOS shell gotchas" note. A repo guard must not
# depend on an interactive shell's aliases.
GREP=/usr/bin/grep

REAL_FILE="modules/beebeeb-crypto/ios/NativeBackupEngine.swift"

# Runs every check against $1 (a file path) and echoes PASS/FAIL text to
# stdout/stderr exactly as the top-level script used to. Returns 0/1.
run_check() {
  local file="$1"
  local fail=0

  if [ ! -f "$file" ]; then
    echo "Expected file not found: $file" >&2
    return 1
  fi

  # 1. The LockedDictionary wrapper class must exist.
  if ! "$GREP" -q 'private final class LockedDictionary<Key: Hashable, Value>' "$file"; then
    echo "LockedDictionary wrapper class not found in $file" >&2
    fail=1
  fi

  # 2. Its backing storage must stay private — otherwise callers could reach
  #    in and mutate `storage` directly, unlocked, defeating the whole point.
  if ! "$GREP" -Eq '^[[:space:]]*private var storage: \[Key: Value\] = \[:\]' "$file"; then
    echo "LockedDictionary.storage is missing or no longer private" >&2
    fail=1
  fi

  # 3. Every LockedDictionary property must be declared AS a LockedDictionary
  #    instance, not a plain [Int: ...] Dictionary. (chunkResponseBodyBuffers,
  #    task 1605: the same URLSession-delegate-queue/dbQueue/Task cross-thread
  #    shape as the other two — written in `didReceive`, read+removed in
  #    `didCompleteWithError`, cleared from `stop()`.)
  for prop in chunkUploadContinuations uploadTaskMap chunkResponseBodyBuffers; do
    if ! "$GREP" -q "private let ${prop} = LockedDictionary<" "$file"; then
      echo "'$prop' is not declared as 'private let $prop = LockedDictionary<...>()' — a plain Dictionary here is a P1 (task 1600): concurrent access from the URLSession delegate queue / Tasks / dbQueue can corrupt it" >&2
      fail=1
    fi
  done

  # 4. Guard against a raw-dictionary regression: neither property name may
  #    appear with a bare Dictionary type annotation ([Int: ...]) anywhere in
  #    the file (their one legitimate declaration is already checked above).
  for prop in chunkUploadContinuations uploadTaskMap chunkResponseBodyBuffers; do
    bad_decl=$("$GREP" -En "var ${prop}[[:space:]]*:[[:space:]]*\[" "$file" || true)
    if [ -n "$bad_decl" ]; then
      echo "Found a raw-Dictionary-typed declaration of '$prop':" >&2
      echo "$bad_decl" >&2
      fail=1
    fi
  done

  # 5. Every call site of the three LockedDictionary properties must use
  #    only the wrapper's sanctioned API: the subscript ('name[...]'),
  #    .removeValue(forKey:, .removeAll(), .keys, or .mutate(key: (the
  #    compound get-transform-set task 1605 round 3 added — see its doc
  #    comment on LockedDictionary) — never anything else (which would mean
  #    either a stale plain-Dictionary method, like .count/.values/.forEach,
  #    or a reach into a private implementation detail).
  for prop in chunkUploadContinuations uploadTaskMap chunkResponseBodyBuffers; do
    while IFS= read -r line; do
      [ -z "$line" ] && continue
      # skip pure comment/doc-comment lines
      trimmed="$(echo "$line" | sed -E 's/^[[:space:]]*//')"
      case "$trimmed" in
        "//"*|"///"*) continue ;;
      esac
      # skip the sanctioned declaration line itself
      if echo "$line" | "$GREP" -q "private let ${prop} = LockedDictionary<"; then
        continue
      fi
      rest="$(echo "$line" | sed -E "s/.*${prop}//")"
      if ! echo "$rest" | "$GREP" -Eq '^(\[|\.removeValue\(forKey:|\.removeAll\(\)|\.keys\b|\.mutate\(key:)'; then
        echo "Unexpected accessor on '$prop' (not subscript/.removeValue/.removeAll/.keys/.mutate):" >&2
        echo "  $line" >&2
        fail=1
      fi
    done < <("$GREP" -n "\b${prop}\b" "$file" | cut -d: -f2-)
  done

  # 6. Task 1599 followups (round 2) / task 1605 review round 3: each of
  #    these reasons is written from a background thread (the URLSession
  #    delegate queue, via the upload error path) and read from
  #    `currentProgress()` (JS's poll timer queue) — the same cross-thread
  #    shape as every `engineStateLock`-backed property above. Each must stay
  #    a computed property backed by a private `_<name>` storage var,
  #    guarded by `engineStateLock` in both the getter and the setter — never
  #    a bare `private var <name>: String?` stored property again.
  for prop in accountMismatchStopReason accountRefusalStopReason; do
    if "$GREP" -Eq "^[[:space:]]*private var ${prop}:[[:space:]]*String\?[[:space:]]*\$" "$file"; then
      echo "'$prop' is a bare stored var again — must be a computed property backed by engineStateLock" >&2
      fail=1
    fi
    if ! "$GREP" -Eq "^[[:space:]]*private var _${prop}: String\?[[:space:]]*\$" "$file"; then
      echo "'_$prop' backing storage not found in $file" >&2
      fail=1
    fi
    accessor_block=$(awk "/private var ${prop}: String\? \{/,/^  }/" "$file")
    if [ -z "$accessor_block" ]; then
      echo "'$prop' computed property accessor block not found in $file" >&2
      fail=1
    else
      get_line=$(echo "$accessor_block" | "$GREP" -c "get { engineStateLock.lock(); defer { engineStateLock.unlock() }; return _${prop} }" || true)
      set_line=$(echo "$accessor_block" | "$GREP" -c "set { engineStateLock.lock(); _${prop} = newValue; engineStateLock.unlock() }" || true)
      if [ "$get_line" -lt 1 ] || [ "$set_line" -lt 1 ]; then
        echo "'$prop' getter/setter no longer lock/unlock engineStateLock around the backing storage" >&2
        fail=1
      fi
    fi
  done

  if [ "$fail" -ne 0 ]; then
    echo "FAIL: NativeBackupEngine locked-dictionary structural guard" >&2
    return 1
  fi

  echo "PASS: chunkUploadContinuations, uploadTaskMap and chunkResponseBodyBuffers are LockedDictionary-backed, accountMismatchStopReason and accountRefusalStopReason are engineStateLock-backed, storage stays private, no raw-Dictionary regression, all call sites use the sanctioned API"
  return 0
}

self_test() {
  local st_fail=0
  local tmp
  tmp="$(mktemp -d)"
  trap 'rm -rf "$tmp"' RETURN

  # Baseline: the real, unmodified file must pass.
  if ! run_check "$REAL_FILE" >/dev/null 2>&1; then
    echo "SELF-TEST FAIL: the real, unmodified $REAL_FILE does not pass run_check — fix the source or the check before trusting either" >&2
    return 1
  fi
  echo "self-test: baseline (real file) PASSES — ok"

  # Rule 5 red-proof, chunkResponseBodyBuffers: replace the sanctioned
  # .removeAll() call site with an unsanctioned .count read.
  local copy1="$tmp/rule5.swift"
  cp "$REAL_FILE" "$copy1"
  if ! "$GREP" -q 'chunkResponseBodyBuffers.removeAll()' "$copy1"; then
    echo "SELF-TEST FAIL: expected mutation target 'chunkResponseBodyBuffers.removeAll()' not found — the source moved out from under this self-test" >&2
    return 1
  fi
  sed -i '' 's/chunkResponseBodyBuffers\.removeAll()/let _ = chunkResponseBodyBuffers.count/' "$copy1"
  if out="$(run_check "$copy1" 2>&1)"; then
    echo "SELF-TEST FAIL: rule 5 did not catch an unsanctioned '.count' accessor on chunkResponseBodyBuffers" >&2
    st_fail=1
  else
    if ! echo "$out" | "$GREP" -q "Unexpected accessor on 'chunkResponseBodyBuffers'"; then
      echo "SELF-TEST FAIL: rule 5 failed for the wrong reason — expected an 'Unexpected accessor on chunkResponseBodyBuffers' message, got:" >&2
      echo "$out" >&2
      st_fail=1
    else
      echo "self-test: rule 5 (chunkResponseBodyBuffers call-site allowlist) correctly FAILS on an unsanctioned accessor —"
      echo "  $(echo "$out" | "$GREP" "Unexpected accessor on 'chunkResponseBodyBuffers'")"
    fi
  fi

  # Rule 6 red-proof, accountRefusalStopReason: drop the setter's lock/unlock
  # around the backing store — a real regression that would let two threads
  # race a plain, unguarded assignment.
  local copy2="$tmp/rule6.swift"
  cp "$REAL_FILE" "$copy2"
  if ! "$GREP" -q 'set { engineStateLock.lock(); _accountRefusalStopReason = newValue; engineStateLock.unlock() }' "$copy2"; then
    echo "SELF-TEST FAIL: expected mutation target (accountRefusalStopReason's setter) not found — the source moved out from under this self-test" >&2
    return 1
  fi
  sed -i '' 's/set { engineStateLock\.lock(); _accountRefusalStopReason = newValue; engineStateLock\.unlock() }/set { _accountRefusalStopReason = newValue }/' "$copy2"
  if out="$(run_check "$copy2" 2>&1)"; then
    echo "SELF-TEST FAIL: rule 6 did not catch an unlocked setter on accountRefusalStopReason" >&2
    st_fail=1
  else
    if ! echo "$out" | "$GREP" -q "'accountRefusalStopReason' getter/setter no longer lock/unlock"; then
      echo "SELF-TEST FAIL: rule 6 failed for the wrong reason — expected an 'accountRefusalStopReason getter/setter no longer lock/unlock' message, got:" >&2
      echo "$out" >&2
      st_fail=1
    else
      echo "self-test: rule 6 (accountRefusalStopReason engineStateLock backing) correctly FAILS on an unlocked setter —"
      echo "  $(echo "$out" | "$GREP" "'accountRefusalStopReason' getter/setter no longer lock/unlock")"
    fi
  fi

  if [ "$st_fail" -ne 0 ]; then
    echo "SELF-TEST: FAIL" >&2
    return 1
  fi
  echo "SELF-TEST: PASS — both extended rules (5: chunkResponseBodyBuffers call sites, 6: accountRefusalStopReason locking) go red under a deliberate mutation and green on the real file"
  return 0
}

if [ "${1:-}" = "--self-test" ]; then
  self_test
  exit $?
fi

run_check "$REAL_FILE"
