#!/usr/bin/env bash
set -euo pipefail

# Task 1600 [P1] structural guard: `chunkUploadContinuations` and
# `uploadTaskMap` on NativeBackupEngine must ALWAYS go through the
# `LockedDictionary` wrapper (a plain Dictionary there is unsafe — see the
# wrapper's doc comment in the source file for why: they're written from the
# URLSession delegate queue, Swift concurrency Tasks, dbQueue, and whatever
# thread calls stop(), with no synchronization between those). This is a
# grep-based structural check, not a runtime test — it can't prove the
# wrapper itself is race-free (the standalone TSan harness under
# .claude/tasks/_qa-evidence/1600-crash/r2-tsan-harness-locked_dict_stress.swift
# does that), only that nobody has re-introduced a raw Dictionary for these
# two properties, or bypassed the wrapper's public API to reach its private
# `storage` directly.
#
# NOTE: uses /usr/bin/grep explicitly, not the bare `grep`/`rg` names — on
# this machine both are shadowed (ugrep function / Claude Code's own `rg`
# wrapper) with different behavior than the real GNU/BSD binaries; see
# repos/mobile CLAUDE.md's "macOS shell gotchas" note. A repo guard must not
# depend on an interactive shell's aliases.
GREP=/usr/bin/grep

file="modules/beebeeb-crypto/ios/NativeBackupEngine.swift"

if [ ! -f "$file" ]; then
  echo "Expected file not found: $file" >&2
  exit 1
fi

fail=0

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

# 3. Both properties must be declared AS a LockedDictionary instance, not a
#    plain [Int: ...] Dictionary. (chunkResponseBodyBuffers, task 1605: the
#    same URLSession-delegate-queue/dbQueue/Task cross-thread shape as the
#    other two — written in `didReceive`, read+removed in
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

# 5. Every call site of the two properties must use only the wrapper's
#    sanctioned API: the subscript ('name[...]'), .removeValue(forKey:,
#    .removeAll(), or .keys — never anything else (which would mean either
#    a stale plain-Dictionary method, like .count/.values/.forEach, or a
#    reach into a private implementation detail).
for prop in chunkUploadContinuations uploadTaskMap; do
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
    if ! echo "$rest" | "$GREP" -Eq '^(\[|\.removeValue\(forKey:|\.removeAll\(\)|\.keys\b)'; then
      echo "Unexpected accessor on '$prop' (not subscript/.removeValue/.removeAll/.keys):" >&2
      echo "  $line" >&2
      fail=1
    fi
  done < <("$GREP" -n "\b${prop}\b" "$file" | cut -d: -f2-)
done

# 6. Task 1599 followups (round 2): `accountMismatchStopReason` is written
#    from `handleConfirmedAccountMismatch()` (URLSession delegate queue, via
#    the upload error path) and cleared from `bindAccount(userId:)` (Expo's
#    shared serial queue), read from `currentProgress()` (JS's poll timer
#    queue) — the same cross-thread shape as every `engineStateLock`-backed
#    property above. Must stay a computed property backed by a private
#    `_accountMismatchStopReason` storage var, guarded by `engineStateLock`
#    in both the getter and the setter — never a bare `private var
#    accountMismatchStopReason: String?` stored property again.
if "$GREP" -Eq '^[[:space:]]*private var accountMismatchStopReason:[[:space:]]*String\?[[:space:]]*$' "$file"; then
  echo "'accountMismatchStopReason' is a bare stored var again — must be a computed property backed by engineStateLock (task 1599 followups round 2)" >&2
  fail=1
fi
if ! "$GREP" -Eq '^[[:space:]]*private var _accountMismatchStopReason: String\?[[:space:]]*$' "$file"; then
  echo "'_accountMismatchStopReason' backing storage not found in $file" >&2
  fail=1
fi
accessor_block=$(awk '/private var accountMismatchStopReason: String\? \{/,/^  }/' "$file")
if [ -z "$accessor_block" ]; then
  echo "'accountMismatchStopReason' computed property accessor block not found in $file" >&2
  fail=1
else
  get_line=$(echo "$accessor_block" | "$GREP" -c 'get { engineStateLock.lock(); defer { engineStateLock.unlock() }; return _accountMismatchStopReason }' || true)
  set_line=$(echo "$accessor_block" | "$GREP" -c 'set { engineStateLock.lock(); _accountMismatchStopReason = newValue; engineStateLock.unlock() }' || true)
  if [ "$get_line" -lt 1 ] || [ "$set_line" -lt 1 ]; then
    echo "'accountMismatchStopReason' getter/setter no longer lock/unlock engineStateLock around the backing storage" >&2
    fail=1
  fi
fi

if [ "$fail" -ne 0 ]; then
  echo "FAIL: NativeBackupEngine locked-dictionary structural guard" >&2
  exit 1
fi

echo "PASS: chunkUploadContinuations and uploadTaskMap are LockedDictionary-backed, accountMismatchStopReason is engineStateLock-backed, storage stays private, no raw-Dictionary regression, all call sites use the sanctioned API"
