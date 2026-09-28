// @ts-nocheck
/**
 * Task 1593 round 5 — independent security re-review of PR #144 (round 4).
 * Native Swift has no macOS-runnable unit test harness in this repo (round 4
 * Notes), so — same as `plaintext-storage.test.ts` — these tests read the
 * Swift source text off disk and assert on it directly. They are structural
 * proofs (the right code exists, in the right place, in the right order),
 * not behavioural ones; the behavioural proof for P1-1 is the byte-level
 * sqlite3 CLI repro at `_qa-evidence/1593/r5-sqlite-bytes.txt` (RED: 500
 * marker names survive a plain DELETE; GREEN: 0 survive with
 * `secure_delete=ON` + `VACUUM`), and for P1-3/P2-4 it is the successful
 * `xcodebuild` in this task's evidence (both changes compile as written).
 *
 * This file imports no app module (fs only), so it needs no `mock.module`
 * calls per mobile/CLAUDE.md "Tests".
 */
import { describe, expect, test } from 'bun:test';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

const REPO_ROOT = join(import.meta.dir, '..', '..');
const REGISTRY_SWIFT_PATH = join(
  REPO_ROOT, 'modules', 'beebeeb-crypto', 'ios', 'PlaintextStorageProtection.swift',
);
const MODULE_SWIFT_PATH = join(
  REPO_ROOT, 'modules', 'beebeeb-crypto', 'ios', 'BeebeebCryptoModule.swift',
);
const CACHE_MANAGER_SWIFT_PATH = join(
  REPO_ROOT, 'targets', 'file-provider', 'CacheManager.swift',
);
const FILE_PROVIDER_EXTENSION_SWIFT_PATH = join(
  REPO_ROOT, 'targets', 'file-provider', 'FileProviderExtension.swift',
);
const CONSTANTS_SWIFT_PATH = join(
  REPO_ROOT, 'targets', 'file-provider', 'Constants.swift',
);

function functionBody(source: string, signature: string): string {
  const start = source.indexOf(signature);
  if (start === -1) throw new Error(`signature not found: ${signature}`);
  // Top-level closing brace is un-indented; every brace inside the function
  // body is indented at least one level (matches the pattern already used by
  // caches-plaintext-registry.test.ts for populateFileProviderCache).
  const end = source.indexOf('\n}', start);
  if (end === -1) throw new Error(`closing brace not found for: ${signature}`);
  return source.slice(start, end);
}

// Task 1593 round 6 — a brace-counting variant of `functionBody` above.
// `functionBody`'s "first un-indented `\n}`" heuristic only actually lands on
// the target function's own close for TOP-LEVEL free functions; for a member
// of a `class`/`enum` (whose own closing brace is itself indented) it
// silently overshoots into whatever follows, which the existing tests above
// get away with only because nothing later in their slice happens to contain
// the substrings they check for. New tests below use this instead: it counts
// braces to find the TRUE matching close, robust to indentation.
function bracedBody(source: string, signature: string): string {
  const start = source.indexOf(signature);
  if (start === -1) throw new Error(`signature not found: ${signature}`);
  const braceStart = source.indexOf('{', start);
  if (braceStart === -1) throw new Error(`opening brace not found for: ${signature}`);
  let depth = 0;
  let i = braceStart;
  for (; i < source.length; i++) {
    if (source[i] === '{') depth++;
    else if (source[i] === '}') {
      depth--;
      if (depth === 0) break;
    }
  }
  if (depth !== 0) throw new Error(`closing brace not found for: ${signature}`);
  return source.slice(start, i + 1);
}

describe('P1-1: resetSQLiteInPlace (PlaintextStorageProtection.swift) does not leave decrypted names on the freelist', () => {
  const swift = readFileSync(REGISTRY_SWIFT_PATH, 'utf8');
  const body = functionBody(swift, 'private static func resetSQLiteInPlace(_ url: URL, pendingNonce: Data?) -> Bool {');

  test('secure_delete is turned ON (an actual executed pragma, not just a comment) before the deleting transaction begins', () => {
    // Must match the real call, not merely the word `secure_delete` — a
    // doc comment mentioning it (as the one right above this call does) is
    // not a functional fix, and a naive substring check can't tell the two
    // apart (caught by this task's own M1 mutation: removing the call while
    // leaving the comment intact left a bare word-match version of this
    // test green).
    const secureDeleteIdx = body.search(/sqlite3_exec\(db, "PRAGMA secure_delete/);
    const beginIdx = body.indexOf('"BEGIN"');
    expect(secureDeleteIdx).toBeGreaterThan(-1);
    expect(beginIdx).toBeGreaterThan(-1);
    expect(secureDeleteIdx).toBeLessThan(beginIdx);
  });

  test('VACUUM runs after COMMIT', () => {
    const commitIdx = body.indexOf('"COMMIT"');
    const vacuumIdx = body.indexOf('"VACUUM"');
    expect(commitIdx).toBeGreaterThan(-1);
    expect(vacuumIdx).toBeGreaterThan(-1);
    expect(vacuumIdx).toBeGreaterThan(commitIdx);
  });

  test('the misleading wal_checkpoint call is gone — this db is never put into WAL mode', () => {
    // The comment is allowed to name the OLD pragma for context; the actual
    // executed call must be gone.
    expect(body).not.toMatch(/sqlite3_exec\(db, "PRAGMA wal_checkpoint/);
    // Confirms the premise the comment states: no `journal_mode = WAL` is
    // ever set anywhere in the codebase for this db's schema statements.
    const wholeTree = [
      readFileSync(join(REPO_ROOT, 'modules', 'beebeeb-crypto', 'ios', 'BeebeebCryptoModule.swift'), 'utf8'),
      swift,
    ].join('\n');
    expect(wholeTree).not.toMatch(/journal_mode\s*=\s*WAL/);
  });

  test('the fallback branch (db cannot be opened at all) also removes the -journal sibling', () => {
    const fallback = body.slice(0, body.indexOf('defer { sqlite3_close(db) }'));
    expect(fallback).toMatch(/"-journal"/);
  });
});

describe('P1-1 (same finding, second location): resetFileProviderCacheDatabase (BeebeebCryptoModule.swift)', () => {
  const swift = readFileSync(MODULE_SWIFT_PATH, 'utf8');
  const body = functionBody(swift, 'private func resetFileProviderCacheDatabase(at url: URL) -> Bool {');

  test('secure_delete is turned ON (an actual executed pragma) before the deleting transaction begins', () => {
    const secureDeleteIdx = body.search(/sqlite3_exec\(db, "PRAGMA secure_delete/);
    const beginIdx = body.indexOf('"BEGIN"');
    expect(secureDeleteIdx).toBeGreaterThan(-1);
    expect(beginIdx).toBeGreaterThan(-1);
    expect(secureDeleteIdx).toBeLessThan(beginIdx);
  });

  test('VACUUM (now retried once on BUSY, see round 6 new-3) runs after COMMIT, and the misleading wal_checkpoint call is gone', () => {
    const commitIdx = body.indexOf('"COMMIT"');
    const vacuumIdx = body.indexOf('vacuumRetryingOnceOnBusy(db)');
    expect(commitIdx).toBeGreaterThan(-1);
    expect(vacuumIdx).toBeGreaterThan(-1);
    expect(vacuumIdx).toBeGreaterThan(commitIdx);
    expect(body).not.toMatch(/sqlite3_exec\(db, "PRAGMA wal_checkpoint/);
  });
});

describe('P1-2: resetSQLiteInPlace surfaces real failures instead of always returning true', () => {
  const swift = readFileSync(REGISTRY_SWIFT_PATH, 'utf8');
  const body = functionBody(swift, 'private static func resetSQLiteInPlace(_ url: URL, pendingNonce: Data?) -> Bool {');

  test('sets a busy timeout before touching the database', () => {
    expect(body).toMatch(/sqlite3_busy_timeout\(db,\s*\d+\)/);
  });

  test('a failed sqlite_master prepare returns false, not true', () => {
    const prepareIdx = body.indexOf('sqlite3_prepare_v2');
    expect(prepareIdx).toBeGreaterThan(-1);
    // The guard's else-branch, up to the next top-level statement. Widened
    // from 400 to 600 (task 1593 f2) after this branch's comment grew to
    // explain the marker-first "no re-mark call here" rationale — confirmed
    // this still fails correctly against the ORIGINAL 400-char window
    // before widening (i.e. the widening is not papering over a real
    // regression), per this task's convention for widened test windows.
    const elseSlice = body.slice(prepareIdx, prepareIdx + 600);
    expect(elseSlice).toMatch(/else\s*\{[\s\S]*?return false/);
  });

  test('every exec step (secure_delete, BEGIN, each DELETE, COMMIT) is checked against SQLITE_OK', () => {
    // The old code called sqlite3_exec bare (ignoring the return code) five
    // times and always `return true`d. The fixed code must check each call —
    // except the best-effort ROLLBACK on the failure path, whose own result
    // deliberately doesn't gate anything further.
    //
    // Task 1593 round 6 (new-3) — VACUUM itself moved out of this function's
    // own body into the shared `vacuumRetryingOnceOnBusy(db)` retry helper
    // (checked separately below), so this function's OWN body is scoped
    // precisely with `bracedBody`, not the file-wide `functionBody` used by
    // the sibling tests above (which — for an `enum` member like this one,
    // whose real closing brace is itself indented — only happens to work by
    // overshooting all the way to the end of the file; that overshoot used
    // to accidentally re-include this exact VACUUM literal after it moved,
    // which is precisely the kind of accidental pass this task's own review
    // exists to catch).
    const preciseBody = bracedBody(swift, 'private static func resetSQLiteInPlace(_ url: URL, pendingNonce: Data?) -> Bool {');
    // `(?:[^"\\]|\\.)*` (not a plain `[^"]+`) so the interpolated
    // `"DELETE FROM \"\(table)\""` literal — whose escaped inner quotes a
    // simple no-quotes class would stop at — still counts as one call.
    const execCalls = (preciseBody.match(/sqlite3_exec\(db, "(?:[^"\\]|\\.)*", nil, nil, nil\)/g) ?? [])
      .filter((call) => !call.includes('"ROLLBACK"'));
    expect(execCalls.length).toBeGreaterThanOrEqual(4); // secure_delete, BEGIN, DELETE, COMMIT
    for (const call of execCalls) {
      const callIdx = preciseBody.indexOf(call);
      const context = preciseBody.slice(Math.max(0, callIdx - 20), callIdx + call.length + 20);
      expect(context).toMatch(/==\s*SQLITE_OK/);
    }
    expect(preciseBody).toMatch(/vacuumRetryingOnceOnBusy\(db\)/);
    expect(preciseBody).not.toMatch(/\n\s*return true\s*\n/); // no unconditional success path left in THIS function
  });
});

describe('P1-3: the File Provider domain is removed on every purge, not just an ordinary signOut()', () => {
  const swift = readFileSync(MODULE_SWIFT_PATH, 'utf8');

  test('removeFileProviderDomainIfRegistered exists, checks registration first (idempotent), and uses .removeAll', () => {
    const start = swift.indexOf('private func removeFileProviderDomainIfRegistered()');
    expect(start).toBeGreaterThan(-1);
    // Round 6 (new-1/new-2): the function now returns Bool so its caller can
    // count a lookup/removal failure — see the "new-1" describe block below.
    const body = functionBody(swift, 'private func removeFileProviderDomainIfRegistered() -> Bool {');
    // Idempotent: does nothing when the domain is not currently registered.
    expect(body).toMatch(/domains\.contains\(where:/);
    expect(body).toMatch(/guard domains\.contains[\s\S]*?return/);
    // .removeAll, not .preserveDirtyUserData / .preserveDownloadedUserData —
    // this is the privacy purge, nothing should survive it.
    expect(body).toMatch(/NSFileProviderManager\.remove\(domain, mode: \.removeAll\)/);
  });

  test('purgePlaintextStorage — reached by EVERY sign-out incl. forced ones (see signed-out-purge.test.ts + '
    + 'account-cleanup.test.ts, which prove every forced path reaches this native call) — calls it', () => {
    const body = functionBody(swift, 'AsyncFunction("purgePlaintextStorage") { () -> [String: Int] in');
    expect(body).toMatch(/removeFileProviderDomainIfRegistered\(\)/);
  });
});

describe('P2-4: purgePlaintextStorage and syncFileProviderCache share Expo\'s single serial AsyncFunction queue', () => {
  const swift = readFileSync(MODULE_SWIFT_PATH, 'utf8');

  function asyncFunctionSignatureLine(name: string): string {
    const re = new RegExp(`AsyncFunction\\("${name}"\\)[^\\n]*`);
    const match = swift.match(re);
    if (!match) throw new Error(`AsyncFunction("${name}") not found`);
    return match[0];
  }

  // A closure with `async` in its type resolves to `ConcurrentFunctionDefinition`
  // (expo-modules-core Api/Factories/ConcurrentFunctionFactories.swift) instead
  // of `AsyncFunctionDefinition` (.../AsyncFunctionFactories.swift) — a
  // DIFFERENT execution path (Swift Task concurrency) with no ordering
  // relationship to AsyncFunctionDefinition's single shared serial
  // `defaultQueue` (.../Core/Functions/AsyncFunctionDefinition.swift:20).
  // `populateFileProviderCache`'s lease-based "the walk has stopped" guarantee
  // (round 4, file-provider-mount.ts) depends on purgePlaintextStorage and
  // syncFileProviderCache both staying on that one queue, so neither closure
  // may become `async`.
  test('purgePlaintextStorage\'s closure is not async', () => {
    expect(asyncFunctionSignatureLine('purgePlaintextStorage')).not.toMatch(/\basync\b/);
  });

  test('syncFileProviderCache\'s closure is not async', () => {
    expect(asyncFunctionSignatureLine('syncFileProviderCache')).not.toMatch(/\basync\b/);
  });

  test('removeFileProviderDomainIfRegistered (which purgePlaintextStorage calls) is declared synchronous', () => {
    const match = swift.match(/private func removeFileProviderDomainIfRegistered\(\)[^\n{]*/);
    expect(match).not.toBeNull();
    expect(match![0]).not.toMatch(/\basync\b/);
  });

  test('purgePlaintextStorage calls it directly, never with await', () => {
    const body = functionBody(swift, 'AsyncFunction("purgePlaintextStorage") { () -> [String: Int] in');
    expect(body).toMatch(/\bremoveFileProviderDomainIfRegistered\(\)/);
    expect(body).not.toMatch(/await\s+removeFileProviderDomainIfRegistered/);
  });
});

// Task 1593 round 6 — independent security re-review of PR #144 (round 5).
// Behavioural proof for new-3 is the same byte-level sqlite3 CLI repro
// pattern as round 5's r5-sqlite-bytes.txt (see r6-secure-delete-write-path.txt);
// there is still no macOS-runnable Swift unit harness in this repo, so new-1/
// new-2/new-4 stay structural, proven by the successful xcodebuild in this
// round's evidence (the timeout/error/consent-reset code compiles as written).
describe('new-1 (round 6, P1): removeFileProviderDomainIfRegistered never blocks Expo\'s serial queue forever', () => {
  const swift = readFileSync(MODULE_SWIFT_PATH, 'utf8');
  const body = bracedBody(swift, 'private func removeFileProviderDomainIfRegistered() -> Bool {');

  test('no unbounded DispatchSemaphore.wait() remains anywhere in BeebeebCryptoModule.swift', () => {
    // Regex on the WHOLE module, not just this function: a bare `.wait()`
    // (no `timeout:` argument) anywhere in this file is the exact shape the
    // reviewer flagged — this is deliberately whole-file so a future
    // unbounded wait added elsewhere in this module also fails it, not only
    // a regression inside this one function.
    const bareWaits = swift.match(/\.wait\(\)/g) ?? [];
    expect(bareWaits).toEqual([]);
  });

  test('both semaphore waits in this function are bounded with a timeout', () => {
    const timeoutWaits = body.match(/\.wait\(timeout: \.now\(\) \+ \d+\)/g) ?? [];
    expect(timeoutWaits.length).toBe(2);
  });

  test('a getDomains timeout traces storage.purge.failed (no names/paths) and returns false instead of proceeding', () => {
    const idx = body.indexOf('domainsSemaphore.wait(timeout:');
    expect(idx).toBeGreaterThan(-1);
    const after = body.slice(idx, idx + 250);
    expect(after).toMatch(/RuntimeTrace\.event\("storage\.purge\.failed", \["stage": "file_provider_domains_timeout"\]\)/);
    expect(after).toMatch(/return false/);
    // "no names/paths": the timeout trace payload must not reuse the
    // `"path"` key the sibling purge failures use for a real filesystem
    // leaf name (PlaintextStorageProtection.swift's `storage.purge.failed`
    // call) — only a static stage label and, where applicable, a system
    // error description.
    expect(after).not.toMatch(/"path"/);
  });

  test('a domain-remove timeout also traces storage.purge.failed and returns false', () => {
    const idx = body.indexOf('removeSemaphore.wait(timeout:');
    expect(idx).toBeGreaterThan(-1);
    const after = body.slice(idx, idx + 250);
    expect(after).toMatch(/RuntimeTrace\.event\("storage\.purge\.failed", \["stage": "file_provider_domain_remove_timeout"\]\)/);
    expect(after).toMatch(/return false/);
  });

  test('purgePlaintextStorage counts a domain lookup/removal failure (incl. a timeout) into the returned "failed" total', () => {
    const purgeBody = bracedBody(swift, 'AsyncFunction("purgePlaintextStorage") { () -> [String: Int] in');
    // Round 7 (C1) moved `PlaintextStorageProtection.purgeAll()` to the END
    // of this function (see the round-7 describe block below), so `failed`
    // now starts at 0 and `result.failed` is added in afterward — it can no
    // longer be initialized FROM `result.failed` at the top.
    expect(purgeBody).toMatch(/var failed = 0/);
    expect(purgeBody).toMatch(/if !removeFileProviderDomainIfRegistered\(\)\s*\{\s*failed \+= 1\s*\}/);
    expect(purgeBody).toMatch(/failed \+= result\.failed/);
    expect(purgeBody).toMatch(/return \["removed": result\.removed, "failed": failed\]/);
    // The old unconditional shape must be gone, not just supplemented.
    expect(purgeBody).not.toMatch(/"failed": result\.failed\]/);
  });
});

// Task 1593 round 7 — independent security re-review of PR #144 (round 6).
// Same structural-proof rationale as the describe blocks above: no
// macOS-runnable Swift unit harness in this repo. The behavioural proof for
// C1's ordering is that a mutation reverting the order makes the "ordering"
// test below fail (see this task's Notes / mutation table); for C2 it is the
// successful xcodebuild in this round's evidence (the new `protect()` call
// sites compile as written, in both the main app pod and the
// `BeebeebFileProvider` extension target).
describe('C1 (round 7, P1): purgePlaintextStorage resets the DB LAST, after consent + domain removal', () => {
  const swift = readFileSync(MODULE_SWIFT_PATH, 'utf8');
  const purgeBody = bracedBody(swift, 'AsyncFunction("purgePlaintextStorage") { () -> [String: Int] in');

  test('order is: consent reset -> domain removal -> PlaintextStorageProtection.purgeAll(pendingNonce:)', () => {
    // Task 1593 f2 — the real call site's literal text gained
    // `pendingNonce: pendingNonce` (marker-first threads the nonce through).
    const consentIdx = purgeBody.indexOf('resetFileProviderShowInFilesConsent(defaults: sharedDefaults())');
    const removeIdx = purgeBody.indexOf('removeFileProviderDomainIfRegistered()');
    const purgeAllIdx = purgeBody.indexOf('PlaintextStorageProtection.purgeAll(pendingNonce: pendingNonce)');
    expect(consentIdx).toBeGreaterThan(-1);
    expect(removeIdx).toBeGreaterThan(-1);
    expect(purgeAllIdx).toBeGreaterThan(-1);
    expect(consentIdx).toBeLessThan(removeIdx);
    expect(removeIdx).toBeLessThan(purgeAllIdx);
  });

  test('the purge epoch is bumped before the domain removal call, not after', () => {
    // Task 1593 round 8 (R2) — the bump moved from an App Group
    // UserDefaults counter (`bumpFileProviderPurgeEpoch`) to the cache DB's
    // own `PRAGMA user_version` (`bumpFileProviderCacheVersion`); see the
    // "R2" describe block below for the new mechanism's own tests. The
    // ordering guarantee this test protects is unchanged.
    const bumpIdx = purgeBody.indexOf('bumpFileProviderCacheVersion()');
    const removeIdx = purgeBody.indexOf('removeFileProviderDomainIfRegistered()');
    expect(bumpIdx).toBeGreaterThan(-1);
    expect(removeIdx).toBeGreaterThan(-1);
    expect(bumpIdx).toBeLessThan(removeIdx);
  });
});

// Task 1593 round 8 — independent security re-review of PR #144 (round 7).
// R2 replaces the App Group UserDefaults purge-epoch counter with the File
// Provider cache database's own `PRAGMA user_version`, synchronised across
// processes with real SQLite `BEGIN IMMEDIATE` locking instead of
// `cfprefsd`'s no-guaranteed-immediacy propagation. No macOS-runnable Swift
// unit harness in this repo (same rationale as every describe block above),
// so these stay structural; the behavioural proof is the sqlite3 CLI
// session at _qa-evidence/1593/r8-epoch-proof.txt (two connections: one
// holds `BEGIN IMMEDIATE` + a `user_version` read, the other's own
// `BEGIN IMMEDIATE` + bump is shown refused/blocked until the first
// releases) plus the successful xcodebuild in this round's evidence.
describe('R2 (round 8, P2): the old App Group UserDefaults purge-epoch counter is fully gone', () => {
  test('the fileProviderPurgeEpochKey constant / bumpFileProviderPurgeEpoch function are no longer declared', () => {
    // Removal notes are allowed to name the old symbols for context (this
    // file's own history does exactly that elsewhere); only the actual
    // declarations must be gone.
    const swift = readFileSync(MODULE_SWIFT_PATH, 'utf8');
    expect(swift).not.toMatch(/\blet fileProviderPurgeEpochKey\b/);
    expect(swift).not.toMatch(/\bfunc bumpFileProviderPurgeEpoch\b/);
  });

  test('the purgeEpochKey constant is no longer declared in the extension\'s Constants.swift', () => {
    const constants = readFileSync(join(REPO_ROOT, 'targets', 'file-provider', 'Constants.swift'), 'utf8');
    expect(constants).not.toMatch(/\blet purgeEpochKey\b/);
  });

  test('the CacheManager no longer reads the epoch from UserDefaults', () => {
    const cacheManagerSwift = readFileSync(CACHE_MANAGER_SWIFT_PATH, 'utf8');
    expect(cacheManagerSwift).not.toMatch(/UserDefaults\(suiteName: BeebeebConstants\.appGroup\)\?\.integer/);
  });
});

describe('R2 (round 8, P2): bumpFileProviderCacheVersion bumps PRAGMA user_version under BEGIN IMMEDIATE', () => {
  const swift = readFileSync(MODULE_SWIFT_PATH, 'utf8');
  // Task 1593 f2 — signature gained `clearsPendingMarker: Bool = false`.
  const body = bracedBody(swift, 'private func bumpFileProviderCacheVersion(clearsPendingMarker: Bool = false) -> Bool {');

  test('opens a real write transaction with BEGIN IMMEDIATE, not a plain BEGIN', () => {
    expect(body).toMatch(/sqlite3_exec\(db, "BEGIN IMMEDIATE", nil, nil, nil\)/);
  });

  test('reads the current value before writing the incremented one, and commits', () => {
    const readIdx = body.indexOf('PRAGMA user_version');
    const writeIdx = body.indexOf('PRAGMA user_version = \\(current');
    const commitIdx = body.indexOf('"COMMIT"');
    expect(readIdx).toBeGreaterThan(-1);
    expect(writeIdx).toBeGreaterThan(-1);
    expect(commitIdx).toBeGreaterThan(-1);
    expect(readIdx).toBeLessThan(writeIdx);
    expect(writeIdx).toBeLessThan(commitIdx);
  });

  test('is called as the early purge-epoch bump in purgePlaintextStorage, with its result checked (not discarded) — see round 12', () => {
    // Task 1593 round 12 (Codex thread PRRT_kwDOSLX6T86mjO56, P1) changed
    // this call's shape from a discarding `_ = bumpFileProviderCacheVersion()`
    // to a checked, retried one — see that round's own describe block for
    // the retry/count/trace assertions. This test's premise (the call
    // exists here at all, before domain removal) still holds; only HOW its
    // result is handled changed.
    const purgeBody = bracedBody(swift, 'AsyncFunction("purgePlaintextStorage") { () -> [String: Int] in');
    expect(purgeBody).toMatch(/if !bumpFileProviderCacheVersion\(\) \{/);
    const bumpIdx = purgeBody.indexOf('if !bumpFileProviderCacheVersion() {');
    const removeDomainIdx = purgeBody.indexOf('removeFileProviderDomainIfRegistered()');
    expect(bumpIdx).toBeGreaterThan(-1);
    expect(removeDomainIdx).toBeGreaterThan(bumpIdx);
  });
});

describe('R2 (round 8, P2): both DB-reset functions bump PRAGMA user_version inside their own reset transaction', () => {
  test('resetFileProviderCacheDatabase (BeebeebCryptoModule.swift) reads, increments, and writes user_version between BEGIN and COMMIT', () => {
    const swift = readFileSync(MODULE_SWIFT_PATH, 'utf8');
    const body = bracedBody(swift, 'private func resetFileProviderCacheDatabase(at url: URL) -> Bool {');
    const beginIdx = body.indexOf('"BEGIN"');
    const bumpIdx = body.indexOf('PRAGMA user_version = \\(nextVersion)');
    const commitIdx = body.indexOf('"COMMIT"');
    expect(beginIdx).toBeGreaterThan(-1);
    expect(bumpIdx).toBeGreaterThan(-1);
    expect(commitIdx).toBeGreaterThan(-1);
    expect(beginIdx).toBeLessThan(bumpIdx);
    expect(bumpIdx).toBeLessThan(commitIdx);
  });

  test('resetSQLiteInPlace (PlaintextStorageProtection.swift) reads, increments, and writes user_version between BEGIN and COMMIT', () => {
    const swift = readFileSync(REGISTRY_SWIFT_PATH, 'utf8');
    const body = bracedBody(swift, 'private static func resetSQLiteInPlace(_ url: URL, pendingNonce: Data?) -> Bool {');
    const beginIdx = body.indexOf('"BEGIN"');
    const bumpIdx = body.indexOf('PRAGMA user_version = \\(nextVersion)');
    const commitIdx = body.indexOf('"COMMIT"');
    expect(beginIdx).toBeGreaterThan(-1);
    expect(bumpIdx).toBeGreaterThan(-1);
    expect(commitIdx).toBeGreaterThan(-1);
    expect(beginIdx).toBeLessThan(bumpIdx);
    expect(bumpIdx).toBeLessThan(commitIdx);
  });
});

describe('C1 (round 7, P1): the File Provider extension refuses a write whose purge epoch changed during its fetch', () => {
  const cacheManagerSwift = readFileSync(CACHE_MANAGER_SWIFT_PATH, 'utf8');
  const syncEngineSwift = readFileSync(
    join(REPO_ROOT, 'targets', 'file-provider', 'SyncEngine.swift'), 'utf8',
  );

  test('CacheManager.replaceChildren opens BEGIN IMMEDIATE, then checks the CURRENT epoch, before writing', () => {
    // Task 1593 round 8 (R2) — the epoch check now runs AFTER acquiring a
    // real cross-process write lock (`BEGIN IMMEDIATE`), not merely inside
    // this process's own serial queue: the queue only ever protected THIS
    // process's calls to `CacheManager` from each other, never the main
    // app's independent writes to the same file.
    //
    // Task 1593 round 10 (reviewer F-b) — the bare `_currentPurgeEpoch() ==
    // expectedEpoch` comparison and the bare `execute("COMMIT")` this test
    // used to pin were replaced by `currentEpochMatches(_:)` (never matches
    // on a failed read — see its doc comment) and `commitOrRollback()`
    // (ROLLBACK on a failed COMMIT instead of leaving the transaction open).
    // See the dedicated "reviewer F-b" describe block below for the direct
    // behavioural pin on those two helpers; this test only re-pins their
    // call-site ORDER, which is unchanged.
    const body = bracedBody(
      cacheManagerSwift,
      'func replaceChildren(parent: String?, with items: [CachedItem], expectedEpoch: Int) -> Bool {',
    );
    const queueSyncIdx = body.indexOf('queue.sync');
    const beginImmediateIdx = body.indexOf('guard beginImmediate() else { return false }');
    const guardIdx = body.indexOf('guard currentEpochMatches(expectedEpoch) else {');
    const rollbackIdx = body.indexOf('execute("ROLLBACK")');
    const commitIdx = body.indexOf('commitOrRollback()');
    expect(queueSyncIdx).toBeGreaterThan(-1);
    expect(beginImmediateIdx).toBeGreaterThan(-1);
    expect(guardIdx).toBeGreaterThan(-1);
    expect(rollbackIdx).toBeGreaterThan(-1);
    expect(commitIdx).toBeGreaterThan(-1);
    expect(queueSyncIdx).toBeLessThan(beginImmediateIdx);
    expect(beginImmediateIdx).toBeLessThan(guardIdx);
    expect(guardIdx).toBeLessThan(rollbackIdx);
    expect(rollbackIdx).toBeLessThan(commitIdx);
  });

  test('beginImmediate() issues a real BEGIN IMMEDIATE, not a plain deferred BEGIN', () => {
    const body = bracedBody(cacheManagerSwift, 'private func beginImmediate() -> Bool {');
    expect(body).toMatch(/sqlite3_exec\(db, "BEGIN IMMEDIATE", nil, nil, nil\)/);
  });

  test('_currentPurgeEpoch reads PRAGMA user_version, not UserDefaults', () => {
    const body = bracedBody(cacheManagerSwift, 'private func _currentPurgeEpoch() -> Int {');
    expect(body).toMatch(/PRAGMA user_version/);
    expect(body).not.toMatch(/UserDefaults/);
  });

  test('SyncEngine.refreshContainer captures the epoch BEFORE the network fetch, not after', () => {
    const body = bracedBody(syncEngineSwift, 'static func refreshContainer(containerId: String) async {');
    const epochIdx = body.indexOf('CacheManager.shared.currentPurgeEpoch()');
    const fetchIdx = body.indexOf('ApiClient.shared.listFiles(parentId: parentId)');
    expect(epochIdx).toBeGreaterThan(-1);
    expect(fetchIdx).toBeGreaterThan(-1);
    expect(epochIdx).toBeLessThan(fetchIdx);
  });

  test('SyncEngine.refreshContainer passes that captured epoch to replaceChildren and discards on refusal', () => {
    const body = bracedBody(syncEngineSwift, 'static func refreshContainer(containerId: String) async {');
    expect(body).toMatch(/replaceChildren\(\s*parent: parentId, with: rowsToUpsert, expectedEpoch: epochAtStart\s*\)/);
    expect(body).toMatch(/guard committed else \{[\s\S]*?return\s*\}/);
    // A discarded write must not update sync_state as if it had landed.
    const guardIdx = body.indexOf('guard committed else');
    const setSyncStateIdx = body.indexOf('setSyncState(');
    expect(guardIdx).toBeGreaterThan(-1);
    expect(setSyncStateIdx).toBeGreaterThan(guardIdx);
  });
});

describe('C2 (round 7, P1): the File Provider cache DB is protected at the moment of creation, not just at next cold launch', () => {
  const moduleSwift = readFileSync(MODULE_SWIFT_PATH, 'utf8');
  const cacheManagerSwift = readFileSync(CACHE_MANAGER_SWIFT_PATH, 'utf8');

  test('ensureFileProviderCacheDatabase protects the file right after opening, before the schema runs', () => {
    const body = bracedBody(moduleSwift, 'private func ensureFileProviderCacheDatabase() -> Bool {');
    const openIdx = body.indexOf('sqlite3_open_v2');
    const protectIdx = body.indexOf('PlaintextStorageProtection.protect(url)');
    const schemaIdx = body.indexOf('for statement in fileProviderCacheSchemaStatements');
    expect(openIdx).toBeGreaterThan(-1);
    expect(protectIdx).toBeGreaterThan(-1);
    expect(schemaIdx).toBeGreaterThan(-1);
    expect(protectIdx).toBeGreaterThan(openIdx);
    expect(protectIdx).toBeLessThan(schemaIdx);
  });

  test('syncFileProviderCache protects the file right after opening, before any table/DELETE/INSERT', () => {
    const body = bracedBody(
      moduleSwift,
      'AsyncFunction("syncFileProviderCache") { (entries: [[String: Any]], prune: Bool?, pruneParents: [Any]?) -> Int in',
    );
    const openIdx = body.indexOf('sqlite3_open_v2');
    const protectIdx = body.indexOf('PlaintextStorageProtection.protect(URL(fileURLWithPath: dbPath))');
    const createSqlIdx = body.indexOf('CREATE TABLE IF NOT EXISTS file_cache');
    expect(openIdx).toBeGreaterThan(-1);
    expect(protectIdx).toBeGreaterThan(-1);
    expect(createSqlIdx).toBeGreaterThan(-1);
    expect(protectIdx).toBeGreaterThan(openIdx);
    expect(protectIdx).toBeLessThan(createSqlIdx);
  });

  test('the File Provider extension\'s CacheManager.init protects the file right after opening, before secure_delete/migrations', () => {
    const initBody = bracedBody(cacheManagerSwift, 'private init() {');
    const openIdx = initBody.indexOf('sqlite3_open_v2');
    const protectIdx = initBody.indexOf('PlaintextStorageProtection.protect(URL(fileURLWithPath: path))');
    const secureDeleteIdx = initBody.indexOf('execute("PRAGMA secure_delete = ON")');
    expect(openIdx).toBeGreaterThan(-1);
    expect(protectIdx).toBeGreaterThan(-1);
    expect(secureDeleteIdx).toBeGreaterThan(-1);
    expect(protectIdx).toBeGreaterThan(openIdx);
    expect(protectIdx).toBeLessThan(secureDeleteIdx);
  });
});

describe('C3 (round 7, P2, verify only): a getDomains failure is still not treated as absence', () => {
  // Round 6 (new-2) already fixed this and its test lives in the "new-2"
  // describe block above; this block just re-asserts the same invariant
  // under the C3 name the round-7 review thread used, so a future
  // regression on this exact finding fails under either name.
  const swift = readFileSync(MODULE_SWIFT_PATH, 'utf8');
  const body = bracedBody(swift, 'private func removeFileProviderDomainIfRegistered() -> Bool {');

  test('a captured getDomains error is traced and returns false before the "already absent" guard runs', () => {
    expect(body).toMatch(/getDomainsWithCompletionHandler \{ result, error in/);
    const errorCheckIdx = body.indexOf('if let domainsError');
    const containsCheckIdx = body.indexOf('domains.contains(where:');
    expect(errorCheckIdx).toBeGreaterThan(-1);
    expect(containsCheckIdx).toBeGreaterThan(-1);
    expect(errorCheckIdx).toBeLessThan(containsCheckIdx);
  });
});

describe('F1 (round 7, P2): removeFileProviderEntries sets secure_delete before its DELETEs', () => {
  const swift = readFileSync(MODULE_SWIFT_PATH, 'utf8');
  const body = bracedBody(swift, 'AsyncFunction("removeFileProviderEntries") { (ids: [String]) -> Int in');

  test('secure_delete is set right after opening, before the loop that DELETEs rows', () => {
    const openIdx = body.indexOf('sqlite3_open_v2');
    const secureDeleteIdx = body.search(/sqlite3_exec\(db, "PRAGMA secure_delete/);
    const deleteIdx = body.indexOf('"DELETE FROM file_cache WHERE id = ?"');
    expect(openIdx).toBeGreaterThan(-1);
    expect(secureDeleteIdx).toBeGreaterThan(-1);
    expect(deleteIdx).toBeGreaterThan(-1);
    expect(secureDeleteIdx).toBeGreaterThan(openIdx);
    expect(secureDeleteIdx).toBeLessThan(deleteIdx);
  });
});

describe('F2 (round 7, P2): a domain removal completion that outlives its bounded wait cannot silently undo a NEW sign-in', () => {
  const swift = readFileSync(MODULE_SWIFT_PATH, 'utf8');

  test('registerMountedFileProviderDomainLocked bumps the generation counter right after successfully adding the domain', () => {
    // Task 1593 round 10 (reviewer F-a) — the actual registration logic
    // moved to `registerMountedFileProviderDomainLocked`; the now-separate
    // `registerMountedFileProviderDomain` is just the serializing gate
    // wrapper (see the "reviewer F-a" describe block below).
    const body = bracedBody(
      swift,
      'private func registerMountedFileProviderDomainLocked(\n  defaults: UserDefaults?,\n  forceReset: Bool = false\n) async throws -> [String: Any] {',
    );
    const addIdx = body.indexOf('try await addFileProviderDomain(domain)');
    const bumpIdx = body.indexOf('bumpFileProviderGeneration()');
    expect(addIdx).toBeGreaterThan(-1);
    expect(bumpIdx).toBeGreaterThan(-1);
    expect(bumpIdx).toBeGreaterThan(addIdx);
  });

  test('removeFileProviderDomainIfRegistered captures the generation BEFORE calling .remove, not after', () => {
    const body = bracedBody(swift, 'private func removeFileProviderDomainIfRegistered() -> Bool {');
    const captureIdx = body.indexOf('let generationBeforeRemove = currentFileProviderGeneration()');
    const removeCallIdx = body.indexOf('NSFileProviderManager.remove(domain, mode: .removeAll)');
    expect(captureIdx).toBeGreaterThan(-1);
    expect(removeCallIdx).toBeGreaterThan(-1);
    expect(captureIdx).toBeLessThan(removeCallIdx);
  });

  test('a stale completion (generation changed since) re-adds the domain instead of leaving it silently removed', () => {
    const body = bracedBody(swift, 'private func removeFileProviderDomainIfRegistered() -> Bool {');
    const staleCheckIdx = body.indexOf('currentFileProviderGeneration() != generationBeforeRemove');
    expect(staleCheckIdx).toBeGreaterThan(-1);
    // Task 1593 round 10 — widened from 3400: the stale-remove branch grew
    // its own validate-and-undo logic (Codex thread PRRT_kwDOSLX6T86mhUiV),
    // pushing `NSFileProviderManager.add(domain)` further from this check.
    const after = body.slice(staleCheckIdx, staleCheckIdx + 6000);
    expect(after).toMatch(/NSFileProviderManager\.add\(domain\)/);
    expect(after).toMatch(/RuntimeTrace\.event\("storage\.purge\.file_provider_domain_stale_remove"/);
  });

  test('the stale-completion branch does not also mark the removal as failed — the removal itself succeeded', () => {
    // Only a real `error` from the completion handler sets `removeSucceeded
    // = false`; the stale-generation branch is a separate `else if` that
    // must not fall through into that assignment.
    const body = bracedBody(swift, 'NSFileProviderManager.remove(domain, mode: .removeAll) { _, error in');
    expect(body).toMatch(/if let error \{[\s\S]*?removeSucceeded = false[\s\S]*?\}\s*else if currentFileProviderGeneration/);
  });
});

describe('new-2 (round 6, P2): a getDomains error is captured, traced and counted — not discarded', () => {
  const swift = readFileSync(MODULE_SWIFT_PATH, 'utf8');
  const body = bracedBody(swift, 'private func removeFileProviderDomainIfRegistered() -> Bool {');

  test('the completion handler no longer discards its error parameter', () => {
    // The old signature threw the error away: `{ result, _ in ... }`.
    expect(body).not.toMatch(/getDomainsWithCompletionHandler \{ result, _ in/);
    expect(body).toMatch(/getDomainsWithCompletionHandler \{ result, error in/);
  });

  test('a captured error is traced and treated as a failure BEFORE the "already absent" guard runs', () => {
    const errorCheckIdx = body.indexOf('if let domainsError');
    const containsCheckIdx = body.indexOf('domains.contains(where:');
    expect(errorCheckIdx).toBeGreaterThan(-1);
    expect(containsCheckIdx).toBeGreaterThan(-1);
    // Ordering matters: reading `domains.contains` first would let a failed
    // lookup's empty result masquerade as "domain already absent".
    expect(errorCheckIdx).toBeLessThan(containsCheckIdx);
    const slice = body.slice(errorCheckIdx, containsCheckIdx);
    expect(slice).toMatch(/RuntimeTrace\.event\("storage\.purge\.failed"/);
    expect(slice).toMatch(/return false/);
  });
});

describe('new-3 (round 6, P2): secure_delete is set on EVERY connection that WRITES the File Provider cache DB, and purge VACUUMs retry once on BUSY', () => {
  const moduleSwift = readFileSync(MODULE_SWIFT_PATH, 'utf8');
  const cacheManagerSwift = readFileSync(CACHE_MANAGER_SWIFT_PATH, 'utf8');

  test('syncFileProviderCache sets secure_delete = ON right after opening, before any DELETE', () => {
    const body = bracedBody(
      moduleSwift,
      'AsyncFunction("syncFileProviderCache") { (entries: [[String: Any]], prune: Bool?, pruneParents: [Any]?) -> Int in',
    );
    const openIdx = body.indexOf('sqlite3_open_v2');
    const secureDeleteIdx = body.search(/sqlite3_exec\(db, "PRAGMA secure_delete/);
    const deleteIdx = body.indexOf('DELETE FROM file_cache');
    expect(openIdx).toBeGreaterThan(-1);
    expect(secureDeleteIdx).toBeGreaterThan(openIdx);
    expect(deleteIdx).toBeGreaterThan(-1);
    expect(secureDeleteIdx).toBeLessThan(deleteIdx);
  });

  test('the File Provider extension\'s CacheManager sets secure_delete = ON right after opening, before migrations run', () => {
    const initBody = bracedBody(cacheManagerSwift, 'private init() {');
    expect(initBody).toMatch(/execute\("PRAGMA secure_delete = ON"\)/);
    const secureDeleteIdx = initBody.indexOf('execute("PRAGMA secure_delete = ON")');
    const migrationsIdx = initBody.indexOf('runMigrations()');
    expect(secureDeleteIdx).toBeGreaterThan(-1);
    expect(migrationsIdx).toBeGreaterThan(-1);
    expect(secureDeleteIdx).toBeLessThan(migrationsIdx);
  });

  test('resetSQLiteInPlace (PlaintextStorageProtection.swift) retries VACUUM once on SQLITE_BUSY instead of failing immediately', () => {
    const swift = readFileSync(REGISTRY_SWIFT_PATH, 'utf8');
    const resetBody = bracedBody(swift, 'private static func resetSQLiteInPlace(_ url: URL, pendingNonce: Data?) -> Bool {');
    expect(resetBody).toMatch(/vacuumRetryingOnceOnBusy\(db\)/);
    // The bare, unretried call must be gone from the call site, not just
    // supplemented — otherwise a mutation that reverted the retry helper's
    // body to a no-op would still show a passing "calls the helper" check.
    expect(resetBody).not.toMatch(/ok = ok && sqlite3_exec\(db, "VACUUM"/);
    const helperBody = bracedBody(swift, 'private static func vacuumRetryingOnceOnBusy(_ db: OpaquePointer?) -> Bool {');
    expect(helperBody).toMatch(/SQLITE_BUSY/);
    expect((helperBody.match(/"VACUUM"/g) ?? []).length).toBe(2); // first attempt + the retry
  });

  test('resetFileProviderCacheDatabase (BeebeebCryptoModule.swift) retries VACUUM once on SQLITE_BUSY instead of failing immediately', () => {
    const resetBody = bracedBody(moduleSwift, 'private func resetFileProviderCacheDatabase(at url: URL) -> Bool {');
    expect(resetBody).toMatch(/vacuumRetryingOnceOnBusy\(db\)/);
    expect(resetBody).not.toMatch(/ok = ok && sqlite3_exec\(db, "VACUUM"/);
    const helperBody = bracedBody(moduleSwift, 'private func vacuumRetryingOnceOnBusy(_ db: OpaquePointer?) -> Bool {');
    expect(helperBody).toMatch(/SQLITE_BUSY/);
    expect((helperBody.match(/"VACUUM"/g) ?? []).length).toBe(2);
  });
});

describe('new-4 (round 6, P2, privacy consent): a forced-sign-out purge also resets the "show in Files" mount consent', () => {
  const swift = readFileSync(MODULE_SWIFT_PATH, 'utf8');

  test('resetFileProviderShowInFilesConsent resets both consent flags mountFileProviderAccess sets together', () => {
    const body = bracedBody(swift, 'private func resetFileProviderShowInFilesConsent(defaults: UserDefaults?) {');
    expect(body).toMatch(/defaults\?\.set\(false, forKey: fileProviderEnabledKey\)/);
    expect(body).toMatch(/defaults\?\.set\(false, forKey: fileProviderTrustedMountKey\)/);
  });

  test('purgePlaintextStorage — reached by every sign-out, forced or ordinary — calls it', () => {
    const purgeBody = bracedBody(swift, 'AsyncFunction("purgePlaintextStorage") { () -> [String: Int] in');
    expect(purgeBody).toMatch(/resetFileProviderShowInFilesConsent\(defaults: sharedDefaults\(\)\)/);
  });

  test('the consent reset does not also clear the App Group session mirror / simulator key (stays out of scope, overlaps P0 1594)', () => {
    const consentBody = bracedBody(swift, 'private func resetFileProviderShowInFilesConsent(defaults: UserDefaults?) {');
    expect(consentBody).not.toMatch(/sharedSessionTokenKey/);
    expect(consentBody).not.toMatch(/sharedAPIBaseURLKey/);
    expect(consentBody).not.toMatch(/simulatorFileProviderMasterKeyKey/);
  });
});

// Task 1593 round 7 — Codex's automated re-review of 117e11e (round 7's own
// push) surfaced 2 further threads. new-P1 is fixed here; new-P2 is
// deliberately left open — see this task's Notes for why (a real fix would
// need a blocking semaphore across the async register path and the
// synchronous, Expo-serial-queue-bound remove path, which risks starving
// Swift's cooperative thread pool; that is an architectural call, not one
// this round makes unilaterally).
describe('new-P1 (round 7, P1, Codex auto re-review): registerMountedFileProviderDomainLocked rechecks consent immediately before adding', () => {
  const swift = readFileSync(MODULE_SWIFT_PATH, 'utf8');
  const body = bracedBody(
    swift,
    'private func registerMountedFileProviderDomainLocked(\n  defaults: UserDefaults?,\n  forceReset: Bool = false\n) async throws -> [String: Any] {',
  );

  test('both consent flags are rechecked right before addFileProviderDomain, not just trusted from the caller', () => {
    const guardIdx = body.search(/guard \(defaults\?\.bool\(forKey: fileProviderTrustedMountKey\) \?\? false\),\s*\n\s*sharedBoolDefaultTrue\(defaults, key: fileProviderEnabledKey\)/);
    const addIdx = body.indexOf('try await addFileProviderDomain(domain)');
    expect(guardIdx).toBeGreaterThan(-1);
    expect(addIdx).toBeGreaterThan(-1);
    expect(guardIdx).toBeLessThan(addIdx);
  });

  test('a failed recheck returns early via currentFileProviderDomainStatus() instead of adding', () => {
    const guardIdx = body.search(/guard \(defaults\?\.bool\(forKey: fileProviderTrustedMountKey\)/);
    expect(guardIdx).toBeGreaterThan(-1);
    const after = body.slice(guardIdx, guardIdx + 300);
    expect(after).toMatch(/else\s*\{\s*\n\s*return await currentFileProviderDomainStatus\(\)\s*\n\s*\}/);
  });
});

// Task 1593 round 8 — independent security re-review of PR #144 (round 7).
// R1 is the P1/MUST finding: the stale-`.remove`-completion re-add
// (round 7's F2) could land AFTER a second, later purge had already reset
// consent, mounting Files with consent off. No macOS-runnable Swift unit
// harness in this repo, so structural + this task's mutation table (see
// Notes) stand in for a behavioural proof, same as every describe block
// above.
describe('R1 (round 8, P1, MUST): a stale-remove completion only re-adds the domain when consent is still live', () => {
  const swift = readFileSync(MODULE_SWIFT_PATH, 'utf8');
  const removeBody = bracedBody(swift, 'private func removeFileProviderDomainIfRegistered() -> Bool {');

  test('the stale-generation branch rechecks BOTH consent flags before calling .add', () => {
    const staleIdx = removeBody.indexOf('currentFileProviderGeneration() != generationBeforeRemove');
    expect(staleIdx).toBeGreaterThan(-1);
    // Task 1593 round 10 — widened from 3400, same reason as F2's test above.
    const after = removeBody.slice(staleIdx, staleIdx + 6000);
    const guardIdx = after.search(/if \(consentDefaults\?\.bool\(forKey: fileProviderTrustedMountKey\) \?\? false\),\s*\n\s*sharedBoolDefaultTrue\(consentDefaults, key: fileProviderEnabledKey\) \{/);
    const addIdx = after.indexOf('NSFileProviderManager.add(domain)');
    expect(guardIdx).toBeGreaterThan(-1);
    expect(addIdx).toBeGreaterThan(-1);
    // The consent recheck must gate the .add call, not merely follow it.
    expect(guardIdx).toBeLessThan(addIdx);
  });

  test('a consent-off recheck traces a distinct event and does not call .add', () => {
    const staleIdx = removeBody.indexOf('currentFileProviderGeneration() != generationBeforeRemove');
    expect(staleIdx).toBeGreaterThan(-1);
    // Task 1593 round 10 — widened from 3400, same reason as F2's test above.
    const after = removeBody.slice(staleIdx, staleIdx + 6000);
    expect(after).toMatch(/RuntimeTrace\.event\("storage\.purge\.file_provider_domain_stale_remove_consent_off", \[:\]\)/);
    // The consent-off trace must sit in an `else` branch of the same `if`
    // that guards `.add`, not merely appear somewhere in the function.
    const elseIdx = after.indexOf('} else {');
    const consentOffIdx = after.indexOf('storage.purge.file_provider_domain_stale_remove_consent_off');
    expect(elseIdx).toBeGreaterThan(-1);
    expect(consentOffIdx).toBeGreaterThan(elseIdx);
  });

  test('the removal itself is still not marked failed by a consent-off skip — same invariant as F2', () => {
    const body = bracedBody(swift, 'NSFileProviderManager.remove(domain, mode: .removeAll) { _, error in');
    expect(body).toMatch(/if let error \{[\s\S]*?removeSucceeded = false[\s\S]*?\}\s*else if currentFileProviderGeneration/);
  });
});

describe('R1 (round 8, P1): a consent reset also stamps the generation counter, invalidating pending stale re-adds', () => {
  const swift = readFileSync(MODULE_SWIFT_PATH, 'utf8');

  test('resetFileProviderShowInFilesConsent calls bumpFileProviderGeneration after clearing both flags', () => {
    const body = bracedBody(swift, 'private func resetFileProviderShowInFilesConsent(defaults: UserDefaults?) {');
    const enabledIdx = body.indexOf('defaults?.set(false, forKey: fileProviderEnabledKey)');
    const trustedIdx = body.indexOf('defaults?.set(false, forKey: fileProviderTrustedMountKey)');
    const bumpIdx = body.indexOf('bumpFileProviderGeneration()');
    expect(enabledIdx).toBeGreaterThan(-1);
    expect(trustedIdx).toBeGreaterThan(-1);
    expect(bumpIdx).toBeGreaterThan(-1);
    expect(enabledIdx).toBeLessThan(bumpIdx);
    expect(trustedIdx).toBeLessThan(bumpIdx);
  });
});

// Task 1593 round 8 — R3: the OTHER File Provider extension writers
// (create/rename/delete) get the same purge-epoch gate `replaceChildren`
// already has, closing the same "network call is unbounded, a purge can
// land while it's in flight" window for THEIR cache writes.
describe('R3 (round 8, P2): CacheManager gains epoch-gated upsert/delete variants', () => {
  const cacheManagerSwift = readFileSync(CACHE_MANAGER_SWIFT_PATH, 'utf8');

  test('upsert(_:expectedEpoch:) opens BEGIN IMMEDIATE, checks the epoch, aborts on mismatch, else writes + commits', () => {
    // Task 1593 round 10 (reviewer F-b) — see the matching note on
    // replaceChildren's test above: the epoch comparison and the commit are
    // now `currentEpochMatches`/`commitOrRollback`, pinned directly in the
    // "reviewer F-b" describe block below.
    const body = bracedBody(
      cacheManagerSwift,
      'func upsert(_ item: CachedItem, expectedEpoch: Int) -> Bool {',
    );
    const beginIdx = body.indexOf('guard beginImmediate() else { return false }');
    const guardIdx = body.indexOf('guard currentEpochMatches(expectedEpoch) else {');
    const rollbackIdx = body.indexOf('execute("ROLLBACK")');
    const upsertIdx = body.indexOf('_upsert(item)');
    const commitIdx = body.indexOf('commitOrRollback()');
    expect(beginIdx).toBeGreaterThan(-1);
    expect(guardIdx).toBeGreaterThan(-1);
    expect(rollbackIdx).toBeGreaterThan(-1);
    expect(upsertIdx).toBeGreaterThan(-1);
    expect(commitIdx).toBeGreaterThan(-1);
    expect(beginIdx).toBeLessThan(guardIdx);
    expect(guardIdx).toBeLessThan(rollbackIdx);
    expect(rollbackIdx).toBeLessThan(upsertIdx);
    expect(upsertIdx).toBeLessThan(commitIdx);
  });

  test('delete(id:expectedEpoch:) opens BEGIN IMMEDIATE, checks the epoch, aborts on mismatch, else deletes + commits', () => {
    const body = bracedBody(
      cacheManagerSwift,
      'func delete(id: String, expectedEpoch: Int) -> Bool {',
    );
    const beginIdx = body.indexOf('guard beginImmediate() else { return false }');
    const guardIdx = body.indexOf('guard currentEpochMatches(expectedEpoch) else {');
    const rollbackIdx = body.indexOf('execute("ROLLBACK")');
    const deleteIdx = body.indexOf('_delete(id: id)');
    const commitIdx = body.indexOf('commitOrRollback()');
    expect(beginIdx).toBeGreaterThan(-1);
    expect(guardIdx).toBeGreaterThan(-1);
    expect(rollbackIdx).toBeGreaterThan(-1);
    expect(deleteIdx).toBeGreaterThan(-1);
    expect(commitIdx).toBeGreaterThan(-1);
    expect(beginIdx).toBeLessThan(guardIdx);
    expect(guardIdx).toBeLessThan(rollbackIdx);
    expect(rollbackIdx).toBeLessThan(deleteIdx);
    expect(deleteIdx).toBeLessThan(commitIdx);
  });

  test('the plain (non-gated) upsert/delete overloads are unchanged and still exist for internal cache-refresh use', () => {
    expect(cacheManagerSwift).toMatch(/func upsert\(_ item: CachedItem\) \{\s*\n\s*queue\.sync \{ _upsert\(item\) \}/);
    expect(cacheManagerSwift).toMatch(/func delete\(id: String\) \{\s*\n\s*queue\.sync \{ _delete\(id: id\) \}/);
  });
});

describe('R3 (round 8, P2): FileProviderExtension captures the epoch BEFORE its network call and gates the cache write', () => {
  const REPO_ROOT_LOCAL = REPO_ROOT;
  const swift = readFileSync(join(REPO_ROOT_LOCAL, 'targets', 'file-provider', 'FileProviderExtension.swift'), 'utf8');

  test('createItem captures the epoch before streamUpload and passes it to the gated upsert', () => {
    const body = bracedBody(swift, 'func createItem(');
    const epochIdx = body.indexOf('let epochAtStart = CacheManager.shared.currentPurgeEpoch()');
    const uploadIdx = body.indexOf('try await Self.streamUpload(');
    const upsertIdx = body.indexOf('CacheManager.shared.upsert(cached, expectedEpoch: epochAtStart)');
    expect(epochIdx).toBeGreaterThan(-1);
    expect(uploadIdx).toBeGreaterThan(-1);
    expect(upsertIdx).toBeGreaterThan(-1);
    expect(epochIdx).toBeLessThan(uploadIdx);
    expect(uploadIdx).toBeLessThan(upsertIdx);
  });

  test('modifyItem captures the epoch before either network call (streamUpload or patchFile)', () => {
    const body = bracedBody(swift, 'func modifyItem(');
    const epochIdx = body.indexOf('let epochAtStart = CacheManager.shared.currentPurgeEpoch()');
    const uploadIdx = body.indexOf('try await Self.streamUpload(');
    const patchIdx = body.indexOf('try await ApiClient.shared.patchFile(');
    const upsertIdx = body.indexOf('CacheManager.shared.upsert(updated, expectedEpoch: epochAtStart)');
    expect(epochIdx).toBeGreaterThan(-1);
    expect(uploadIdx).toBeGreaterThan(-1);
    expect(patchIdx).toBeGreaterThan(-1);
    expect(upsertIdx).toBeGreaterThan(-1);
    expect(epochIdx).toBeLessThan(uploadIdx);
    expect(epochIdx).toBeLessThan(patchIdx);
    expect(uploadIdx).toBeLessThan(upsertIdx);
    expect(patchIdx).toBeLessThan(upsertIdx);
  });

  test('deleteItem captures the epoch before the network delete and passes it to the gated delete', () => {
    const body = bracedBody(swift, 'func deleteItem(');
    const epochIdx = body.indexOf('let epochAtStart = CacheManager.shared.currentPurgeEpoch()');
    // Task 1594 #143 merge (task 1593 round 12): deleteFile now also takes
    // `expectedUser` (the P0 1594 key-ownership header) — this call's own
    // epoch-gating (round 8/10) is additive to, not replaced by, that.
    const deleteCallIdx = body.indexOf(
      'try await ApiClient.shared.deleteFile(fileId: identifier.rawValue, expectedUser: expectedUser)'
    );
    const cacheDeleteIdx = body.indexOf('CacheManager.shared.delete(id: identifier.rawValue, expectedEpoch: epochAtStart)');
    expect(epochIdx).toBeGreaterThan(-1);
    expect(deleteCallIdx).toBeGreaterThan(-1);
    expect(cacheDeleteIdx).toBeGreaterThan(-1);
    expect(epochIdx).toBeLessThan(deleteCallIdx);
    expect(deleteCallIdx).toBeLessThan(cacheDeleteIdx);
  });

  test('none of the three call sites use the plain, non-gated upsert/delete overloads any more', () => {
    expect(swift).not.toMatch(/CacheManager\.shared\.upsert\(cached\)\s*\n/);
    expect(swift).not.toMatch(/CacheManager\.shared\.upsert\(updated\)\s*\n/);
    expect(swift).not.toMatch(/CacheManager\.shared\.delete\(id: identifier\.rawValue\)\s*\n/);
  });
});

// Task 1593 round 9 — Codex thread PRRT_kwDOSLX6T86mgrDZ (P1), fresh evidence
// on top of round 7b's new-P1 fix: rechecking consent immediately before
// `addFileProviderDomain` does not make the check-then-add atomic. Lead
// decision: validate-and-undo instead of a blocking wait (see the extensive
// doc comment on `registerMountedFileProviderDomain`'s call site and this
// task's Notes for the full rationale — no code duplicated into this
// comment). The decision itself is extracted into a pure, side-effect-free
// function (`shouldUndoFileProviderAdd`) specifically so it can be driven
// directly; this file's structural convention (no macOS-runnable Swift unit
// harness in this repo, same as every describe block above) asserts its
// exact body, and a STANDALONE behavioral proof — extracting this same
// function verbatim from the live source and running it through the `swift`
// interpreter against every branch of its truth table — lives at
// `_qa-evidence/1593/r9-decision-truth-table-green.txt` (plus the two
// mutation reds, `r9-decision-truth-table-red-M1.txt` and `-M2.txt`), not as
// a permanently maintained duplicate-of-Swift test file (that would drift),
// but as one-off verification re-run from `extract_fn.py` +
// `build_and_run.sh` in this task's evidence directory.
describe('round 9 (P1, Codex thread PRRT_kwDOSLX6T86mgrDZ): validate-and-undo replaces the unserialized consent-then-add', () => {
  const swift = readFileSync(MODULE_SWIFT_PATH, 'utf8');

  // Task 1593 round 10 (reviewer F-a) — `shouldUndoFileProviderAdd`'s
  // parameters were renamed `purgeGenerationBeforeAdd`/`purgeGenerationAfterAdd`
  // and its generation check simplified to a bare `!=` (no `&+ 1`
  // allowance): see the "reviewer F-a" describe block below for why the OLD
  // shared add/purge counter false-positived on two concurrent, both-
  // legitimate registrations, and why the NEW purge-only counter does not
  // need the allowance the old one did.

  test('shouldUndoFileProviderAdd: consent off (either flag) always undoes, regardless of the generation delta', () => {
    const body = bracedBody(
      swift,
      'private func shouldUndoFileProviderAdd(\n  purgeGenerationBeforeAdd: Int,\n  purgeGenerationAfterAdd: Int,\n  consentTrustedMount: Bool,\n  consentEnabled: Bool\n) -> Bool {',
    );
    expect(body).toMatch(/guard consentTrustedMount, consentEnabled else \{\s*\n\s*return true\s*\n\s*\}/);
  });

  test('shouldUndoFileProviderAdd: with consent on, undoes only when the purge generation moved at all', () => {
    const body = bracedBody(
      swift,
      'private func shouldUndoFileProviderAdd(\n  purgeGenerationBeforeAdd: Int,\n  purgeGenerationAfterAdd: Int,\n  consentTrustedMount: Bool,\n  consentEnabled: Bool\n) -> Bool {',
    );
    const guardIdx = body.indexOf('guard consentTrustedMount, consentEnabled else');
    expect(guardIdx).toBeGreaterThan(-1);
    const after = body.slice(guardIdx);
    expect(after).toMatch(/return purgeGenerationAfterAdd != purgeGenerationBeforeAdd\s*\n\s*\}/);
  });

  test('the consent check and the generation-delta check both survive as separate lines — neither swallows the other', () => {
    // Guards against a mutation that folds both conditions into one
    // expression and silently drops one of them.
    const body = bracedBody(
      swift,
      'private func shouldUndoFileProviderAdd(\n  purgeGenerationBeforeAdd: Int,\n  purgeGenerationAfterAdd: Int,\n  consentTrustedMount: Bool,\n  consentEnabled: Bool\n) -> Bool {',
    );
    const lines = body.split('\n').map((l) => l.trim()).filter(Boolean);
    expect(lines).toContain('guard consentTrustedMount, consentEnabled else {');
    expect(lines).toContain('return true');
    expect(lines).toContain('return purgeGenerationAfterAdd != purgeGenerationBeforeAdd');
  });

  test('registerMountedFileProviderDomainLocked captures the PURGE generation BEFORE the add, not after', () => {
    const body = bracedBody(
      swift,
      'private func registerMountedFileProviderDomainLocked(\n  defaults: UserDefaults?,\n  forceReset: Bool = false\n) async throws -> [String: Any] {',
    );
    const captureIdx = body.indexOf('let purgeGenerationBeforeAdd = currentFileProviderPurgeGeneration()');
    const addIdx = body.indexOf('try await addFileProviderDomain(domain)');
    const bumpIdx = body.indexOf('bumpFileProviderGeneration()');
    const afterCaptureIdx = body.indexOf('let purgeGenerationAfterAdd = currentFileProviderPurgeGeneration()');
    expect(captureIdx).toBeGreaterThan(-1);
    expect(addIdx).toBeGreaterThan(-1);
    expect(bumpIdx).toBeGreaterThan(-1);
    expect(afterCaptureIdx).toBeGreaterThan(-1);
    expect(captureIdx).toBeLessThan(addIdx);
    expect(addIdx).toBeLessThan(bumpIdx);
    expect(bumpIdx).toBeLessThan(afterCaptureIdx);
  });

  test('the undo branch traces a distinct event, calls the off-cooperative-pool removal wrapper, and reports fresh status instead of success', () => {
    const body = bracedBody(
      swift,
      'private func registerMountedFileProviderDomainLocked(\n  defaults: UserDefaults?,\n  forceReset: Bool = false\n) async throws -> [String: Any] {',
    );
    const callIdx = body.indexOf('if shouldUndoFileProviderAdd(');
    expect(callIdx).toBeGreaterThan(-1);
    const after = body.slice(callIdx, callIdx + 900);
    expect(after).toMatch(/purgeGenerationBeforeAdd: purgeGenerationBeforeAdd,\s*\n\s*purgeGenerationAfterAdd: purgeGenerationAfterAdd,\s*\n\s*consentTrustedMount: defaults\?\.bool\(forKey: fileProviderTrustedMountKey\) \?\? false,\s*\n\s*consentEnabled: sharedBoolDefaultTrue\(defaults, key: fileProviderEnabledKey\)\s*\n\s*\) \{/);
    expect(after).toMatch(/RuntimeTrace\.event\("storage\.purge\.file_provider_domain_add_undone", \[:\]\)/);
    // Task 1593 round 10 (reviewer F-a) — no longer the direct, blocking
    // synchronous call; see the "reviewer F-a" describe block below for the
    // off-cooperative-pool wrapper this now goes through.
    expect(after).toMatch(/_ = await removeFileProviderDomainIfRegisteredOffCooperativePool\(\)/);
    expect(after).not.toMatch(/_ = removeFileProviderDomainIfRegistered\(\)/);
    expect(after).toMatch(/return await currentFileProviderDomainStatus\(\)/);
  });

  test('the consent flags passed into the undo check are freshly re-read, not the guard\'s earlier captured values', () => {
    // The same `defaults?.bool(forKey: ...)` / `sharedBoolDefaultTrue(...)`
    // expressions as the pre-add guard, evaluated again at THIS call site —
    // UserDefaults reads are always live, so re-issuing the same expression
    // (rather than reusing a variable from the guard) is what makes this a
    // real recheck instead of trusting a stale snapshot.
    const body = bracedBody(
      swift,
      'private func registerMountedFileProviderDomainLocked(\n  defaults: UserDefaults?,\n  forceReset: Bool = false\n) async throws -> [String: Any] {',
    );
    const occurrences = (body.match(/defaults\?\.bool\(forKey: fileProviderTrustedMountKey\)/g) ?? []).length;
    // Once in the pre-add guard, once in the post-add undo check.
    expect(occurrences).toBe(2);
  });
});

// Task 1593 round 10 — PR #144's 3 remaining unresolved Codex threads
// (Codex thread ids in each describe block name) plus the lead's own 2
// reviewer follow-ups (F-a, F-b). Same structural-source-scan convention as
// every describe block above: no macOS-runnable Swift unit harness exists
// in this repo.

describe('round 10 (Codex thread PRRT_kwDOSLX6T86mhDqK, P1): every extension write path captures its epoch BEFORE Task.detached spawns', () => {
  const swift = readFileSync(FILE_PROVIDER_EXTENSION_SWIFT_PATH, 'utf8');

  test('createItem captures the epoch before Task.detached, not inside it', () => {
    const body = bracedBody(swift, 'func createItem(');
    const epochIdx = body.indexOf('let epochAtStart = CacheManager.shared.currentPurgeEpoch()');
    const taskIdx = body.indexOf('let task = Task.detached {');
    expect(epochIdx).toBeGreaterThan(-1);
    expect(taskIdx).toBeGreaterThan(-1);
    expect(epochIdx).toBeLessThan(taskIdx);
    // Exactly one capture — not duplicated inside the task body too.
    expect((body.match(/CacheManager\.shared\.currentPurgeEpoch\(\)/g) ?? []).length).toBe(1);
  });

  test('modifyItem captures the epoch before Task.detached AND before the cached-item guard read', () => {
    const body = bracedBody(swift, 'func modifyItem(');
    const epochIdx = body.indexOf('let epochAtStart = CacheManager.shared.currentPurgeEpoch()');
    const cachedReadIdx = body.indexOf('guard var cached = CacheManager.shared.item(id: item.itemIdentifier.rawValue)');
    const taskIdx = body.indexOf('let task = Task.detached {');
    expect(epochIdx).toBeGreaterThan(-1);
    expect(cachedReadIdx).toBeGreaterThan(-1);
    expect(taskIdx).toBeGreaterThan(-1);
    // The fix: epoch capture is no longer downstream of (or inside) the
    // task that reads/restores `cached` — it precedes even the read of
    // `cached` itself, so a purge landing right after that read cannot be
    // missed by a LATER epoch capture.
    expect(epochIdx).toBeLessThan(cachedReadIdx);
    expect(cachedReadIdx).toBeLessThan(taskIdx);
    expect((body.match(/CacheManager\.shared\.currentPurgeEpoch\(\)/g) ?? []).length).toBe(1);
  });

  test('deleteItem captures the epoch before Task.detached, not inside it', () => {
    const body = bracedBody(swift, 'func deleteItem(');
    const epochIdx = body.indexOf('let epochAtStart = CacheManager.shared.currentPurgeEpoch()');
    const taskIdx = body.indexOf('let task = Task.detached {');
    expect(epochIdx).toBeGreaterThan(-1);
    expect(taskIdx).toBeGreaterThan(-1);
    expect(epochIdx).toBeLessThan(taskIdx);
    expect((body.match(/CacheManager\.shared\.currentPurgeEpoch\(\)/g) ?? []).length).toBe(1);
  });
});

describe('round 10 (Codex thread PRRT_kwDOSLX6T86mhUiZ, P2): the File Provider cache DB\'s SQLite sidecars are also hardened', () => {
  const registrySwift = readFileSync(REGISTRY_SWIFT_PATH, 'utf8');
  const moduleSwift = readFileSync(MODULE_SWIFT_PATH, 'utf8');
  const cacheManagerSwift = readFileSync(CACHE_MANAGER_SWIFT_PATH, 'utf8');

  test('protectSQLiteSidecars exists and hardens -journal, -wal and -shm siblings', () => {
    const body = bracedBody(registrySwift, 'public static func protectSQLiteSidecars(_ databaseUrl: URL) -> [String: Bool] {');
    expect(body).toMatch(/"-journal"/);
    expect(body).toMatch(/"-wal"/);
    expect(body).toMatch(/"-shm"/);
    expect(body).toMatch(/protect\(sibling\)/);
  });

  test('hardenAll() calls protectSQLiteSidecars for resettableInPlace entries', () => {
    const body = bracedBody(registrySwift, 'public static func hardenAll() -> [String: Bool] {');
    const protectIdx = body.indexOf('results[entry.url.lastPathComponent] = protect(entry.url)');
    const resettableIdx = body.indexOf('if entry.resettableInPlace {');
    const sidecarIdx = body.indexOf('protectSQLiteSidecars(entry.url)');
    expect(protectIdx).toBeGreaterThan(-1);
    expect(resettableIdx).toBeGreaterThan(-1);
    expect(sidecarIdx).toBeGreaterThan(-1);
    expect(protectIdx).toBeLessThan(resettableIdx);
    expect(resettableIdx).toBeLessThan(sidecarIdx);
  });

  test('ensureFileProviderCacheDatabase hardens the sidecars right after protecting the main file', () => {
    const body = bracedBody(moduleSwift, 'private func ensureFileProviderCacheDatabase() -> Bool {');
    const protectIdx = body.indexOf('PlaintextStorageProtection.protect(url)');
    const sidecarIdx = body.indexOf('PlaintextStorageProtection.protectSQLiteSidecars(url)');
    const schemaIdx = body.indexOf('for statement in fileProviderCacheSchemaStatements');
    expect(protectIdx).toBeGreaterThan(-1);
    expect(sidecarIdx).toBeGreaterThan(-1);
    expect(schemaIdx).toBeGreaterThan(-1);
    expect(protectIdx).toBeLessThan(sidecarIdx);
    expect(sidecarIdx).toBeLessThan(schemaIdx);
  });

  test('syncFileProviderCache hardens the sidecars right after protecting the main file', () => {
    const body = bracedBody(
      moduleSwift,
      'AsyncFunction("syncFileProviderCache") { (entries: [[String: Any]], prune: Bool?, pruneParents: [Any]?) -> Int in',
    );
    const protectIdx = body.indexOf('PlaintextStorageProtection.protect(URL(fileURLWithPath: dbPath))');
    const sidecarIdx = body.indexOf('PlaintextStorageProtection.protectSQLiteSidecars(URL(fileURLWithPath: dbPath))');
    const createSqlIdx = body.indexOf('CREATE TABLE IF NOT EXISTS file_cache');
    expect(protectIdx).toBeGreaterThan(-1);
    expect(sidecarIdx).toBeGreaterThan(-1);
    expect(createSqlIdx).toBeGreaterThan(-1);
    expect(protectIdx).toBeLessThan(sidecarIdx);
    expect(sidecarIdx).toBeLessThan(createSqlIdx);
  });

  test('the File Provider extension\'s CacheManager.init hardens the sidecars right after protecting the main file', () => {
    const initBody = bracedBody(cacheManagerSwift, 'private init() {');
    const protectIdx = initBody.indexOf('PlaintextStorageProtection.protect(URL(fileURLWithPath: path))');
    const sidecarIdx = initBody.indexOf('PlaintextStorageProtection.protectSQLiteSidecars(URL(fileURLWithPath: path))');
    const secureDeleteIdx = initBody.indexOf('execute("PRAGMA secure_delete = ON")');
    expect(protectIdx).toBeGreaterThan(-1);
    expect(sidecarIdx).toBeGreaterThan(-1);
    expect(secureDeleteIdx).toBeGreaterThan(-1);
    expect(protectIdx).toBeLessThan(sidecarIdx);
    expect(sidecarIdx).toBeLessThan(secureDeleteIdx);
  });
});

describe('round 10 (reviewer F-b): CacheManager checks COMMIT results and never lets a failed epoch read "match"', () => {
  const cacheManagerSwift = readFileSync(CACHE_MANAGER_SWIFT_PATH, 'utf8');

  test('_currentPurgeEpoch returns a dedicated sentinel on a failed read, not 0', () => {
    const body = bracedBody(cacheManagerSwift, 'private func _currentPurgeEpoch() -> Int {');
    expect(body).toMatch(/return Self\.epochQueryFailed/);
    expect(body).not.toMatch(/return 0\b/);
  });

  test('the sentinel is a dedicated static constant, not a magic number repeated at call sites', () => {
    expect(cacheManagerSwift).toMatch(/private static let epochQueryFailed = Int\.min/);
  });

  test('currentEpochMatches refuses whenever the current read is the sentinel, even if expectedEpoch also happens to equal it', () => {
    const body = bracedBody(cacheManagerSwift, 'private func currentEpochMatches(_ expectedEpoch: Int) -> Bool {');
    // Must check the sentinel explicitly and independently of the equality
    // — `epoch == expectedEpoch` alone would accidentally return `true` if
    // a caller's own failed capture produced the same sentinel value.
    expect(body).toMatch(/epoch != Self\.epochQueryFailed && epoch == expectedEpoch/);
  });

  test('all three epoch-gated writers use currentEpochMatches, not a bare equality check', () => {
    for (const signature of [
      'func replaceChildren(parent: String?, with items: [CachedItem], expectedEpoch: Int) -> Bool {',
      'func upsert(_ item: CachedItem, expectedEpoch: Int) -> Bool {',
      'func delete(id: String, expectedEpoch: Int) -> Bool {',
    ]) {
      const body = bracedBody(cacheManagerSwift, signature);
      expect(body).toMatch(/guard currentEpochMatches\(expectedEpoch\) else \{/);
      expect(body).not.toMatch(/_currentPurgeEpoch\(\) == expectedEpoch/);
    }
  });

  test('commitOrRollback exists and rolls back a failed COMMIT instead of leaving the transaction open', () => {
    const body = bracedBody(cacheManagerSwift, 'private func commitOrRollback() -> Bool {');
    expect(body).toMatch(/if execute\("COMMIT"\) \{\s*\n\s*return true\s*\n\s*\}/);
    expect(body).toMatch(/execute\("ROLLBACK"\)/);
    expect(body).toMatch(/return false/);
  });

  test('all three epoch-gated writers commit through commitOrRollback, not a bare execute("COMMIT")', () => {
    for (const signature of [
      'func replaceChildren(parent: String?, with items: [CachedItem], expectedEpoch: Int) -> Bool {',
      'func upsert(_ item: CachedItem, expectedEpoch: Int) -> Bool {',
      'func delete(id: String, expectedEpoch: Int) -> Bool {',
    ]) {
      const body = bracedBody(cacheManagerSwift, signature);
      expect(body).toMatch(/return commitOrRollback\(\)/);
      expect(body).not.toMatch(/execute\("COMMIT"\)\s*\n\s*return true/);
    }
  });

  test('execute() now reports whether the statement actually succeeded', () => {
    const body = bracedBody(cacheManagerSwift, 'private func execute(_ sql: String) -> Bool {');
    expect(body).toMatch(/return sqlite3_exec\(db, sql, nil, nil, nil\) == SQLITE_OK/);
    expect(cacheManagerSwift).toMatch(/@discardableResult\s*\n\s*private func execute\(_ sql: String\) -> Bool \{/);
  });
});

describe('round 10 (reviewer F-a): overlapping registrations no longer undo each other, and the undo removal moves off the cooperative pool', () => {
  const swift = readFileSync(MODULE_SWIFT_PATH, 'utf8');

  test('a SEPARATE purge-only generation counter exists, distinct from the shared add/purge one', () => {
    expect(swift).toMatch(/private var _fileProviderPurgeGeneration: Int = 0/);
    const bumpBody = bracedBody(swift, 'private func bumpFileProviderPurgeGeneration() -> Int {');
    expect(bumpBody).toMatch(/_fileProviderPurgeGeneration &\+= 1/);
    const currentBody = bracedBody(swift, 'private func currentFileProviderPurgeGeneration() -> Int {');
    expect(currentBody).toMatch(/return _fileProviderPurgeGeneration/);
  });

  test('resetFileProviderShowInFilesConsent — the ONLY purge event — bumps the purge-only counter (in addition to the pre-existing shared one)', () => {
    const body = bracedBody(swift, 'private func resetFileProviderShowInFilesConsent(defaults: UserDefaults?) {');
    const sharedBumpIdx = body.indexOf('bumpFileProviderGeneration()');
    const purgeBumpIdx = body.indexOf('bumpFileProviderPurgeGeneration()');
    expect(sharedBumpIdx).toBeGreaterThan(-1);
    expect(purgeBumpIdx).toBeGreaterThan(-1);
  });

  test('registerMountedFileProviderDomainLocked never bumps the purge-only counter itself — only reads it', () => {
    // The whole point: a successful add must not move this counter, or
    // concurrent registrations would false-positive each other again.
    const body = bracedBody(
      swift,
      'private func registerMountedFileProviderDomainLocked(\n  defaults: UserDefaults?,\n  forceReset: Bool = false\n) async throws -> [String: Any] {',
    );
    expect(body).not.toMatch(/bumpFileProviderPurgeGeneration\(\)/);
    expect(body).toMatch(/currentFileProviderPurgeGeneration\(\)/);
  });

  test('a FIFO async gate (actor) exists to serialize registerMountedFileProviderDomainLocked calls', () => {
    expect(swift).toMatch(/private actor FileProviderRegistrationGate \{/);
    const body = bracedBody(swift, 'private actor FileProviderRegistrationGate {');
    expect(body).toMatch(/func acquire\(\) async \{/);
    expect(body).toMatch(/func release\(\) \{/);
    expect(body).toMatch(/waiters\.append\(continuation\)/);
    expect(body).toMatch(/waiters\.removeFirst\(\)/);
    // Not a DispatchSemaphore — this gate is held across `async` Task
    // contexts (the cooperative pool), where a semaphore wait would risk
    // starving it (see round 6 new-1's UNRELATED but analogous finding).
    expect(body).not.toMatch(/DispatchSemaphore/);
  });

  test('registerMountedFileProviderDomain (the public entry point) acquires the gate, runs the locked impl, and releases on BOTH success and throw', () => {
    const body = bracedBody(
      swift,
      'private func registerMountedFileProviderDomain(\n  defaults: UserDefaults?,\n  forceReset: Bool = false\n) async throws -> [String: Any] {',
    );
    expect(body).toMatch(/await fileProviderRegistrationGate\.acquire\(\)/);
    expect(body).toMatch(/try await registerMountedFileProviderDomainLocked\(defaults: defaults, forceReset: forceReset\)/);
    // Released in both the success path and the catch path — not just one.
    const releaseCount = (body.match(/await fileProviderRegistrationGate\.release\(\)/g) ?? []).length;
    expect(releaseCount).toBe(2);
    expect(body).toMatch(/\} catch \{\s*\n\s*await fileProviderRegistrationGate\.release\(\)\s*\n\s*throw error\s*\n\s*\}/);
  });

  test('every real caller still calls registerMountedFileProviderDomain (the gate wrapper) by its original name — no caller needed to change', () => {
    const callCount = (swift.match(/try await registerMountedFileProviderDomain\(defaults: defaults(?:, forceReset: true)?\)/g) ?? []).length;
    expect(callCount).toBeGreaterThanOrEqual(3);
  });

  test('removeFileProviderDomainIfRegisteredOffCooperativePool exists and moves the semaphore-based call off-thread via a normal GCD queue', () => {
    const body = bracedBody(
      swift,
      'private func removeFileProviderDomainIfRegisteredOffCooperativePool() async -> Bool {',
    );
    expect(body).toMatch(/DispatchQueue\.global\(qos: \.userInitiated\)\.async \{/);
    expect(body).toMatch(/continuation\.resume\(returning: removeFileProviderDomainIfRegistered\(\)\)/);
  });
});

describe('round 10 (Codex thread PRRT_kwDOSLX6T86mhUiV, P2): the stale-removal restore-add validates and undoes itself too', () => {
  const swift = readFileSync(MODULE_SWIFT_PATH, 'utf8');
  const removeBody = bracedBody(swift, 'private func removeFileProviderDomainIfRegistered() -> Bool {');

  test('the restore .add captures the purge generation BEFORE calling .add, using the purge-only counter', () => {
    const staleIdx = removeBody.indexOf('currentFileProviderGeneration() != generationBeforeRemove');
    expect(staleIdx).toBeGreaterThan(-1);
    const after = removeBody.slice(staleIdx, staleIdx + 6000);
    const captureIdx = after.indexOf('let purgeGenerationBeforeRestoreAdd = currentFileProviderPurgeGeneration()');
    const addIdx = after.indexOf('NSFileProviderManager.add(domain) { addError in');
    expect(captureIdx).toBeGreaterThan(-1);
    expect(addIdx).toBeGreaterThan(-1);
    expect(captureIdx).toBeLessThan(addIdx);
  });

  test('on a successful restore add, it re-validates via shouldUndoFileProviderAdd before declaring victory', () => {
    const addIdx = removeBody.indexOf('NSFileProviderManager.add(domain) { addError in');
    expect(addIdx).toBeGreaterThan(-1);
    const after = removeBody.slice(addIdx, addIdx + 1400);
    expect(after).toMatch(/if let addError \{[\s\S]*?return\s*\n\s*\}/);
    expect(after).toMatch(/let purgeGenerationAfterRestoreAdd = currentFileProviderPurgeGeneration\(\)/);
    expect(after).toMatch(/if shouldUndoFileProviderAdd\(\s*\n\s*purgeGenerationBeforeAdd: purgeGenerationBeforeRestoreAdd,\s*\n\s*purgeGenerationAfterAdd: purgeGenerationAfterRestoreAdd,/);
  });

  test('a failed add returns before the validate-and-undo check runs at all (no false undo attempt on a failure)', () => {
    const addIdx = removeBody.indexOf('NSFileProviderManager.add(domain) { addError in');
    const after = removeBody.slice(addIdx, addIdx + 1400);
    const errorIdx = after.indexOf('if let addError {');
    const returnIdx = after.indexOf('return', errorIdx);
    const validateIdx = after.indexOf('shouldUndoFileProviderAdd(');
    expect(errorIdx).toBeGreaterThan(-1);
    expect(returnIdx).toBeGreaterThan(errorIdx);
    expect(validateIdx).toBeGreaterThan(returnIdx);
  });

  test('undoing the restore removes the domain again, fire-and-forget, and traces a distinct event', () => {
    const addIdx = removeBody.indexOf('NSFileProviderManager.add(domain) { addError in');
    const after = removeBody.slice(addIdx, addIdx + 1800);
    expect(after).toMatch(/RuntimeTrace\.event\("storage\.purge\.file_provider_domain_stale_restore_undone", \[:\]\)/);
    expect(after).toMatch(/NSFileProviderManager\.remove\(domain, mode: \.removeAll\) \{ _, undoError in/);
    expect(after).toMatch(/storage\.purge\.file_provider_domain_stale_restore_undo_failed/);
  });
});

describe('round 11 (Codex thread PRRT_kwDOSLX6T86miVoN, P1): fetchContents gates its plaintext writes against the purge epoch', () => {
  const extensionSwift = readFileSync(FILE_PROVIDER_EXTENSION_SWIFT_PATH, 'utf8');
  const body = bracedBody(extensionSwift, 'func fetchContents(');

  test('captures the epoch synchronously, before Task.detached spawns (matching createItem/modifyItem/deleteItem)', () => {
    const captureIdx = body.indexOf('let epochAtStart = CacheManager.shared.currentPurgeEpoch()');
    const taskIdx = body.indexOf('Task.detached {');
    expect(captureIdx).toBeGreaterThan(-1);
    expect(taskIdx).toBeGreaterThan(-1);
    expect(captureIdx).toBeLessThan(taskIdx);
  });

  test('re-checks the epoch after decrypt and before the first (temp) write', () => {
    const decryptIdx = body.indexOf('CryptoBridge.decryptDownloadedFile(');
    const firstCheckIdx = body.indexOf('CacheManager.shared.purgeEpochUnchanged(since: epochAtStart)');
    const writeIdx = body.indexOf('plaintext.write(to: destination');
    expect(decryptIdx).toBeGreaterThan(-1);
    expect(firstCheckIdx).toBeGreaterThan(-1);
    expect(writeIdx).toBeGreaterThan(-1);
    expect(decryptIdx).toBeLessThan(firstCheckIdx);
    expect(firstCheckIdx).toBeLessThan(writeIdx);
  });

  test('a failed pre-write check aborts without writing and reports .noSuchItem', () => {
    const firstCheckIdx = body.indexOf('CacheManager.shared.purgeEpochUnchanged(since: epochAtStart)');
    const after = body.slice(firstCheckIdx, firstCheckIdx + 400);
    expect(after).toMatch(/NSFileProviderError\(\.noSuchItem\)/);
    // The write itself must be AFTER this guard's else-branch closes, i.e.
    // not inside the same guard block.
    const guardCloseIdx = after.indexOf('}');
    const writeOffset = after.indexOf('plaintext.write(to: destination');
    expect(writeOffset === -1 || writeOffset > guardCloseIdx).toBe(true);
  });

  test('re-checks the epoch again immediately after the temp write, and deletes the partial output on a mismatch', () => {
    const writeIdx = body.indexOf('plaintext.write(to: destination');
    expect(writeIdx).toBeGreaterThan(-1);
    const after = body.slice(writeIdx, writeIdx + 900);
    const secondCheckIdx = after.indexOf('CacheManager.shared.purgeEpochUnchanged(since: epochAtStart)');
    expect(secondCheckIdx).toBeGreaterThan(-1);
    const branch = after.slice(secondCheckIdx, secondCheckIdx + 400);
    expect(branch).toMatch(/removeItem\(at: destination\)/);
    expect(branch).toMatch(/NSFileProviderError\(\.noSuchItem\)/);
  });

  test('re-checks a THIRD time for the separate pinned write, and deletes BOTH copies on a mismatch', () => {
    const pinnedWriteIdx = body.indexOf('try plaintext.write(to: pinned, options: [.atomic])');
    expect(pinnedWriteIdx).toBeGreaterThan(-1);
    const after = body.slice(pinnedWriteIdx, pinnedWriteIdx + 900);
    const thirdCheckIdx = after.indexOf('CacheManager.shared.purgeEpochUnchanged(since: epochAtStart)');
    expect(thirdCheckIdx).toBeGreaterThan(-1);
    const branch = after.slice(thirdCheckIdx, thirdCheckIdx + 500);
    expect(branch).toMatch(/removeItem\(at: destination\)/);
    expect(branch).toMatch(/removeItem\(at: pinned\)/);
    expect(branch).toMatch(/NSFileProviderError\(\.noSuchItem\)/);
  });

  test('setMaterialized only runs after the pinned-write epoch check passes (closes round 10\'s open "not epoch-gated" note)', () => {
    const pinnedWriteIdx = body.indexOf('try plaintext.write(to: pinned, options: [.atomic])');
    const thirdCheckIdx = body.indexOf('CacheManager.shared.purgeEpochUnchanged(since: epochAtStart)', pinnedWriteIdx);
    const setMaterializedIdx = body.indexOf('CacheManager.shared.setMaterialized(id: cached.id, value: true)');
    expect(pinnedWriteIdx).toBeGreaterThan(-1);
    expect(thirdCheckIdx).toBeGreaterThan(pinnedWriteIdx);
    expect(setMaterializedIdx).toBeGreaterThan(thirdCheckIdx);
  });

  test('all three checks use the sentinel-safe CacheManager.purgeEpochUnchanged helper, never a bare currentPurgeEpoch() == comparison', () => {
    const rawCompareMatches = body.match(/currentPurgeEpoch\(\)\s*==/g) ?? [];
    expect(rawCompareMatches.length).toBe(0);
    const safeCompareMatches = body.match(/purgeEpochUnchanged\(since: epochAtStart\)/g) ?? [];
    expect(safeCompareMatches.length).toBe(3);
  });
});

describe('round 11: CacheManager.purgeEpochUnchanged is sentinel-safe (reuses currentEpochMatches, not a bare comparison)', () => {
  const cacheManagerSwift = readFileSync(CACHE_MANAGER_SWIFT_PATH, 'utf8');
  const body = bracedBody(cacheManagerSwift, 'func purgeEpochUnchanged(since capturedEpoch: Int) -> Bool {');

  test('is queue.sync-wrapped (this is a public entry point, unlike the private _currentPurgeEpoch)', () => {
    // Task 1593 f1 widened this: queue.sync now wraps a pending-marker
    // guard (see the "f1: CacheManager refuses..." describe block) ahead of
    // the same currentEpochMatches call this test originally checked alone.
    expect(body).toMatch(/queue\.sync\s*\{[\s\S]*?return currentEpochMatches\(capturedEpoch\)\s*\n\s*\}/);
  });

  test('delegates to currentEpochMatches rather than re-implementing its own comparison', () => {
    expect(body).not.toMatch(/_currentPurgeEpoch\(\)\s*==/);
    expect(body).toMatch(/currentEpochMatches\(/);
  });
});

describe('round 11 (Codex thread PRRT_kwDOSLX6T86miVoQ, P1): resetFileProviderDomain routes through the guarded registrar', () => {
  const moduleSwift = readFileSync(MODULE_SWIFT_PATH, 'utf8');
  const body = bracedBody(moduleSwift, 'AsyncFunction("resetFileProviderDomain") { () async throws -> [String: Any] in');

  test('no longer performs its own unconditional addFileProviderDomain / NSFileProviderManager.add', () => {
    expect(body).not.toMatch(/addFileProviderDomain\(domain\)/);
    expect(body).not.toMatch(/NSFileProviderManager\.add\(/);
    expect(body).not.toMatch(/removeFileProviderDomain\(domain\)/);
    expect(body).not.toMatch(/clearFileProviderCacheState\(/);
  });

  test('calls the guarded, serialized registrar with forceReset: true', () => {
    expect(body).toMatch(/try await registerMountedFileProviderDomain\(defaults: sharedDefaults\(\), forceReset: true\)/);
  });

  test('the #available(iOS 16.0, *) unsupported-platform branch is unchanged (still returns before ever reaching the registrar)', () => {
    const guardIdx = body.indexOf('guard #available(iOS 16.0, *) else {');
    const callIdx = body.indexOf('registerMountedFileProviderDomain(');
    expect(guardIdx).toBeGreaterThan(-1);
    expect(callIdx).toBeGreaterThan(guardIdx);
  });
});

describe('round 11: every addFileProviderDomain / NSFileProviderManager.add call site is accounted for (either the guarded registrar, or independently self-validating)', () => {
  const moduleSwift = readFileSync(MODULE_SWIFT_PATH, 'utf8');

  test('addFileProviderDomain(domain) is called from exactly ONE place outside its own wrapper definition: registerMountedFileProviderDomainLocked', () => {
    // The wrapper's own definition (`private func addFileProviderDomain`) and
    // its internal `NSFileProviderManager.add(domain) { error in` call don't
    // match this literal (no trailing `(domain)` call-site parens on the
    // `func` line) — this only matches actual CALL SITES.
    const callSites = [...moduleSwift.matchAll(/\baddFileProviderDomain\(domain\)/g)];
    expect(callSites.length).toBe(1);
  });

  test('NSFileProviderManager.add( is called from exactly TWO places: the wrapper\'s own body, and the stale-remove restore branch (which self-validates via shouldUndoFileProviderAdd)', () => {
    const callSites = [...moduleSwift.matchAll(/NSFileProviderManager\.add\(/g)];
    expect(callSites.length).toBe(2);
  });
});

describe('round 11 (Codex thread PRRT_kwDOSLX6T86miVoV, P2): the File Provider cache DB lives in its own protected directory', () => {
  const registrySwift = readFileSync(REGISTRY_SWIFT_PATH, 'utf8');
  const moduleSwift = readFileSync(MODULE_SWIFT_PATH, 'utf8');
  const constantsSwift = readFileSync(CONSTANTS_SWIFT_PATH, 'utf8');

  test('the Entry struct has a containerOnly flag, defaulting to false', () => {
    const structBody = bracedBody(registrySwift, 'public struct Entry {');
    expect(structBody).toMatch(/public let containerOnly: Bool/);
    const initBody = bracedBody(structBody, 'public init(');
    expect(initBody).toMatch(/containerOnly: Bool = false/);
  });

  test('registry() has a containerOnly directory entry for file-provider-db, followed by the sqlite file entry nested inside it', () => {
    const registryBody = bracedBody(registrySwift, 'public static func registry() -> [Entry] {');
    const dirIdx = registryBody.indexOf('group.appendingPathComponent("file-provider-db", isDirectory: true)');
    expect(dirIdx).toBeGreaterThan(-1);
    const dirEntryIdx = registryBody.indexOf('containerOnly: true');
    expect(dirEntryIdx).toBeGreaterThan(dirIdx);
    const fileEntryIdx = registryBody.indexOf('cacheDbDir.appendingPathComponent("file-provider-cache.sqlite"', dirEntryIdx);
    expect(fileEntryIdx).toBeGreaterThan(dirEntryIdx);
    const resettableIdx = registryBody.indexOf('resettableInPlace: true', fileEntryIdx);
    expect(resettableIdx).toBeGreaterThan(fileEntryIdx);
  });

  test('purgeAll() skips containerOnly entries before ever checking existence or calling removeItem', () => {
    const purgeBody = bracedBody(registrySwift, 'public static func purgeAll(pendingNonce: Data? = nil) -> (removed: Int, failed: Int) {');
    const forIdx = purgeBody.indexOf('for entry in registry() {');
    const skipIdx = purgeBody.indexOf('if entry.containerOnly {');
    const existsIdx = purgeBody.indexOf('FileManager.default.fileExists(atPath: entry.url.path)');
    expect(forIdx).toBeGreaterThan(-1);
    expect(skipIdx).toBeGreaterThan(forIdx);
    expect(existsIdx).toBeGreaterThan(skipIdx);
    const skipBranch = purgeBody.slice(skipIdx, existsIdx);
    expect(skipBranch).toMatch(/continue/);
  });

  test('migrateFileProviderCacheDatabaseIfNeeded is a no-op only when NONE of the 4 legacy suffixes exist (not just the main file)', () => {
    // Task 1593 round 11 follow-up — the original fast path checked ONLY
    // the main file's presence at the legacy path before bailing out. A
    // process killed (jetsam/crash) between moving the main file and moving
    // its `-journal` sibling would leave that orphaned journal at the OLD,
    // unprotected, un-registered path FOREVER on a re-run, because the main
    // file already existing at `to` looked like "fully migrated" — the
    // exact class of leak this whole function exists to close. The fast
    // path must check ALL 4 suffixes before deciding there is nothing to do.
    const body = bracedBody(registrySwift, 'public static func migrateFileProviderCacheDatabaseIfNeeded(from legacyUrl: URL, to newUrl: URL) -> URL {');
    expect(body).toMatch(/let suffixes = \["", "-journal", "-wal", "-shm"\]/);
    expect(body).toMatch(/legacyHasAnySibling = suffixes\.contains \{ fileManager\.fileExists\(atPath: legacyUrl\.path \+ \$0\) \}/);
    expect(body).toMatch(/guard legacyHasAnySibling else \{ return newUrl \}/);
    // The OLD single-suffix short-circuit must be gone — a lingering
    // `!fileManager.fileExists(atPath: newUrl.path)` bail-out would mean
    // the new all-suffix check was added but the old one-suffix gate never
    // actually removed, silently keeping the exact same bug.
    expect(body).not.toMatch(/guard !fileManager\.fileExists\(atPath: newUrl\.path\) else \{ return newUrl \}/);
  });

  test('migrateFileProviderCacheDatabaseIfNeeded moves the main file AND every sidecar suffix, protecting the result', () => {
    const body = bracedBody(registrySwift, 'public static func migrateFileProviderCacheDatabaseIfNeeded(from legacyUrl: URL, to newUrl: URL) -> URL {');
    expect(body).toMatch(/for suffix in suffixes \{/);
    expect(body).toMatch(/moveItem\(at: source, to: destination\)/);
    expect(body).toMatch(/protect\(newUrl\)/);
    expect(body).toMatch(/protectSQLiteSidecars\(newUrl\)/);
  });

  test('a suffix whose destination ALREADY exists (a partially-completed earlier migration) deletes the stale legacy duplicate instead of attempting to move it', () => {
    const body = bracedBody(registrySwift, 'public static func migrateFileProviderCacheDatabaseIfNeeded(from legacyUrl: URL, to newUrl: URL) -> URL {');
    const destGuardIdx = body.indexOf('guard !fileManager.fileExists(atPath: destination.path) else {');
    expect(destGuardIdx).toBeGreaterThan(-1);
    const branch = body.slice(destGuardIdx, destGuardIdx + 400);
    expect(branch).toMatch(/removeItem\(at: source\)/);
    // This branch must come BEFORE the moveItem attempt, not after — a
    // moveItem into an existing destination throws, which would route
    // through the failure path instead of this intentional, non-error
    // "already migrated, clean up the stale duplicate" path.
    const moveIdx = body.indexOf('moveItem(at: source, to: destination)');
    expect(moveIdx).toBeGreaterThan(destGuardIdx);
  });

  test('a move failure falls back to deleting the legacy sidecar rather than leaving it unprotected', () => {
    const body = bracedBody(registrySwift, 'public static func migrateFileProviderCacheDatabaseIfNeeded(from legacyUrl: URL, to newUrl: URL) -> URL {');
    const catchIdx = body.indexOf('} catch {');
    expect(catchIdx).toBeGreaterThan(-1);
    // Task 1593 round 12 widened this from a fixed 300-char window to an
    // anchor-bounded slice (the outer catch's own doc comment, added round
    // 12, pushed the real code well past 300 chars) — confirmed the
    // narrower, original 300-char window DOES still fail correctly against
    // a real mutation (removing the fallback removeItem entirely), so this
    // widening isn't hiding a regression, it's just no longer measured in
    // raw characters.
    const nextMigrateTraceIdx = body.indexOf('RuntimeTrace.event("storage.migrate.file_provider_cache_failed"', catchIdx);
    expect(nextMigrateTraceIdx).toBeGreaterThan(catchIdx);
    const catchBranch = body.slice(catchIdx, nextMigrateTraceIdx);
    expect(catchBranch).toMatch(/removeItem\(at: source\)/);
  });

  test('Constants.swift: AppGroupContainer.cacheDatabaseUrl routes through the migration function, via its own protected cacheDatabaseDirectory', () => {
    const dirBody = bracedBody(constantsSwift, 'static var cacheDatabaseDirectory: URL {');
    expect(dirBody).toMatch(/appendingPathComponent\("file-provider-db", isDirectory: true\)/);
    expect(dirBody).toMatch(/PlaintextStorageProtection\.protect\(dir\)/);

    const urlBody = bracedBody(constantsSwift, 'static var cacheDatabaseUrl: URL {');
    expect(urlBody).toMatch(/PlaintextStorageProtection\.migrateFileProviderCacheDatabaseIfNeeded\(from: legacy, to: migrated\)/);
    expect(urlBody).toMatch(/cacheDatabaseDirectory\.appendingPathComponent/);
  });

  test('BeebeebCryptoModule.swift: fileProviderCacheDatabaseUrl() routes through the migration function, via its own protected directory helper', () => {
    const dirBody = bracedBody(moduleSwift, 'private func fileProviderCacheDatabaseDirectory() -> URL? {');
    expect(dirBody).toMatch(/appendingPathComponent\("file-provider-db", isDirectory: true\)/);
    expect(dirBody).toMatch(/PlaintextStorageProtection\.protect\(dir\)/);

    const urlBody = bracedBody(moduleSwift, 'private func fileProviderCacheDatabaseUrl() -> URL? {');
    expect(urlBody).toMatch(/PlaintextStorageProtection\.migrateFileProviderCacheDatabaseIfNeeded\(from: legacy, to: migrated\)/);
    expect(urlBody).toMatch(/fileProviderCacheDatabaseDirectory\(\)/);
  });

  test('syncFileProviderCache and removeFileProviderEntries no longer build the db path inline — both route through fileProviderCacheDatabaseUrl()', () => {
    const syncBody = bracedBody(moduleSwift, 'AsyncFunction("syncFileProviderCache") { (entries: [[String: Any]], prune: Bool?, pruneParents: [Any]?) -> Int in');
    expect(syncBody).not.toMatch(/containerURL\(forSecurityApplicationGroupIdentifier: appGroupIdentifier\s*\)\s*else/);
    expect(syncBody).toMatch(/fileProviderCacheDatabaseUrl\(\)/);

    const removeBody = bracedBody(moduleSwift, 'AsyncFunction("removeFileProviderEntries") { (ids: [String]) -> Int in');
    expect(removeBody).not.toMatch(/containerURL\(forSecurityApplicationGroupIdentifier: appGroupIdentifier\s*\)\s*else/);
    expect(removeBody).toMatch(/fileProviderCacheDatabaseUrl\(\)/);
  });

  test('clearFileProviderCacheState resets the DB via the shared resolver instead of a third inline top-level path', () => {
    const body = bracedBody(moduleSwift, 'private func clearFileProviderCacheState(defaults: UserDefaults?) -> Int {');
    expect(body).not.toMatch(/"file-provider-cache\.sqlite"/);
    expect(body).toMatch(/fileProviderCacheDatabaseUrl\(\)/);
    expect(body).toMatch(/resetFileProviderCacheDatabase\(at: dbUrl\)/);
  });

  test('the TS mirror (PROTECTED_LEAF_NAMES) includes the new directory leaf', () => {
    // Read the source text directly rather than importing the module: this
    // file's own header notes it imports no app module (fs only), and
    // `./plaintext-storage` imports `react-native` unconditionally, which
    // needs the `mock.module` dance `plaintext-storage.test.ts` already does
    // — pulling that in here for one string would duplicate that whole
    // isolated-runner setup for no benefit over reading the array literal.
    const plaintextStorageTs = readFileSync(
      join(REPO_ROOT, 'src', 'lib', 'plaintext-storage.ts'), 'utf8'
    );
    const start = plaintextStorageTs.indexOf('export const PROTECTED_LEAF_NAMES = [');
    const end = plaintextStorageTs.indexOf('] as const;', start);
    expect(start).toBeGreaterThan(-1);
    expect(end).toBeGreaterThan(start);
    const arrayBody = plaintextStorageTs.slice(start, end);
    expect(arrayBody).toContain("'file-provider-db'");
  });
});

describe('round 12 (Codex thread PRRT_kwDOSLX6T86mi6px, P2): a failed legacy-cache cleanup is reported and retried by the next purge', () => {
  const registrySwift = readFileSync(REGISTRY_SWIFT_PATH, 'utf8');

  test('migrateFileProviderCacheDatabaseIfNeeded traces storage.purge.failed when the fallback delete ALSO fails, on top of the narrower migrate trace', () => {
    const body = bracedBody(
      registrySwift,
      'public static func migrateFileProviderCacheDatabaseIfNeeded(from legacyUrl: URL, to newUrl: URL) -> URL {'
    );
    const catchIdx = body.indexOf('} catch {');
    expect(catchIdx).toBeGreaterThan(-1);
    const catchBranch = body.slice(catchIdx, body.indexOf('\n    }', catchIdx) + 6);
    // The fallback delete must be wrapped in its OWN do/catch — a bare
    // `try?` (the round 4-11 shape) can never distinguish "removed" from
    // "still there", which is exactly what let this bug through review 8
    // times before Codex caught it.
    expect(catchBranch).toMatch(/do \{\s*try fileManager\.removeItem\(at: source\)\s*\} catch \{/);
    expect(catchBranch).toMatch(/RuntimeTrace\.event\("storage\.purge\.failed", \[\s*"path": source\.lastPathComponent,?\s*\]\)/);
    // The original, narrower trace must still fire too — this is additive,
    // not a replacement (other code/tests may still key off it).
    expect(catchBranch).toMatch(/RuntimeTrace\.event\("storage\.migrate\.file_provider_cache_failed"/);
  });

  test('the storage.purge.failed trace on a failed fallback delete sits INSIDE the fallback\'s own catch, not the outer moveItem catch unconditionally', () => {
    // Must fire only when the fallback delete itself throws — never
    // unconditionally alongside every moveItem failure (that would count a
    // successful fallback delete as a purge failure too, which is false: a
    // successful fallback delete means the legacy path is now clean).
    const body = bracedBody(
      registrySwift,
      'public static func migrateFileProviderCacheDatabaseIfNeeded(from legacyUrl: URL, to newUrl: URL) -> URL {'
    );
    const outerCatchIdx = body.indexOf('} catch {');
    const innerDoIdx = body.indexOf('do {', outerCatchIdx);
    const innerCatchIdx = body.indexOf('} catch {', innerDoIdx);
    const purgeFailedIdx = body.indexOf('RuntimeTrace.event("storage.purge.failed"', outerCatchIdx);
    expect(innerDoIdx).toBeGreaterThan(outerCatchIdx);
    expect(innerCatchIdx).toBeGreaterThan(innerDoIdx);
    expect(purgeFailedIdx).toBeGreaterThan(innerCatchIdx);
  });

  test('purgeAll() sweeps the legacy top-level cache path on every call, in addition to registry()', () => {
    const body = bracedBody(registrySwift, 'public static func purgeAll(pendingNonce: Data? = nil) -> (removed: Int, failed: Int) {');
    const sweepCallIdx = body.indexOf('sweepLegacyFileProviderCache()');
    expect(sweepCallIdx).toBeGreaterThan(-1);
    // Must actually fold the sweep's counts into the SAME (removed, failed)
    // this function returns — a call whose result is discarded would not
    // make the failure count against this purge's own accounting.
    const tail = body.slice(sweepCallIdx - 80);
    expect(tail).toMatch(/removed \+= legacy\.removed/);
    expect(tail).toMatch(/failed \+= legacy\.failed/);
    expect(tail).toMatch(/return \(removed, failed\)/);
  });

  test('sweepLegacyFileProviderCache checks the App Group root directly (not registry(), not an in-memory flag) for the main file and every sidecar suffix', () => {
    const body = bracedBody(
      registrySwift,
      'private static func sweepLegacyFileProviderCache() -> (removed: Int, failed: Int) {'
    );
    expect(body).toMatch(/appendingPathComponent\("file-provider-cache\.sqlite", isDirectory: false\)/);
    expect(body).toMatch(/for suffix in \["", "-journal", "-wal", "-shm"\] \{/);
    // Must not read from registry() — this legacy path is deliberately NOT
    // a registry() entry (see the doc comment: registry() only lists the
    // NEW location), so a correct implementation cannot call registry()
    // internally.
    expect(body).not.toMatch(/registry\(\)/);
  });

  test('sweepLegacyFileProviderCache counts a real removal failure toward `failed` and traces storage.purge.failed, an absent sibling toward `removed`', () => {
    const body = bracedBody(
      registrySwift,
      'private static func sweepLegacyFileProviderCache() -> (removed: Int, failed: Int) {'
    );
    const absentIdx = body.indexOf('guard fileManager.fileExists(atPath: sibling.path) else {');
    expect(absentIdx).toBeGreaterThan(-1);
    const absentBranch = body.slice(absentIdx, absentIdx + 150);
    expect(absentBranch).toMatch(/removed \+= 1/);

    const catchIdx = body.indexOf('} catch {', absentIdx);
    expect(catchIdx).toBeGreaterThan(absentIdx);
    const catchBranch = body.slice(catchIdx, catchIdx + 200);
    expect(catchBranch).toMatch(/RuntimeTrace\.event\("storage\.purge\.failed", \["path": sibling\.lastPathComponent\]\)/);
    expect(catchBranch).toMatch(/failed \+= 1/);
  });
});

describe('round 12 (Codex thread PRRT_kwDOSLX6T86mjO56, P1): a failed early epoch bump is counted, and pinned/temp are unconditionally resweft after the whole purge', () => {
  const moduleSwift = readFileSync(MODULE_SWIFT_PATH, 'utf8');
  const registrySwift = readFileSync(REGISTRY_SWIFT_PATH, 'utf8');

  test('the early bumpFileProviderCacheVersion() call is no longer discarded: a double failure is traced and counted', () => {
    const purgeBody = bracedBody(moduleSwift, 'AsyncFunction("purgePlaintextStorage") { () -> [String: Int] in');
    // The OLD, discarding shape must be gone.
    expect(purgeBody).not.toMatch(/_ = bumpFileProviderCacheVersion\(\)/);
    const firstCallIdx = purgeBody.indexOf('if !bumpFileProviderCacheVersion() {');
    expect(firstCallIdx).toBeGreaterThan(-1);
    const removeDomainIdx = purgeBody.indexOf('removeFileProviderDomainIfRegistered()', firstCallIdx);
    expect(removeDomainIdx).toBeGreaterThan(firstCallIdx);
    const retryBlock = purgeBody.slice(firstCallIdx, removeDomainIdx);
    // One retry (a second call), nested inside the first failure branch —
    // not a loop, not a single un-retried check.
    const secondCallIdx = retryBlock.indexOf('if !bumpFileProviderCacheVersion() {', 'if !bumpFileProviderCacheVersion() {'.length);
    expect(secondCallIdx).toBeGreaterThan(-1);
    expect(retryBlock).toMatch(/RuntimeTrace\.event\("storage\.purge\.failed", \["stage": "file_provider_cache_version_bump"\]\)/);
    expect(retryBlock).toMatch(/failed \+= 1/);
  });

  test('the domain-removal ordering (C1, round 7) still holds: consent -> epoch bump -> domain removal -> purgeAll(pendingNonce:)', () => {
    // Regression guard for the exact false-green this round's own comment
    // draft first produced: an earlier version of this round's doc comment
    // mentioned the literal text "PlaintextStorageProtection.purgeAll()"
    // ABOVE the real call site, which made the round-7 C1 ordering test
    // find that comment's occurrence instead of the true one and pass for
    // the wrong reason. Comments in this function must never contain that
    // exact literal ahead of the real call.
    //
    // Task 1593 f2 — the real call site's literal text changed from
    // `PlaintextStorageProtection.purgeAll()` to
    // `PlaintextStorageProtection.purgeAll(pendingNonce: pendingNonce)`
    // (marker-first threads the nonce through); updated here to match, in
    // place, per this task's "never silently" convention.
    const purgeBody = bracedBody(moduleSwift, 'AsyncFunction("purgePlaintextStorage") { () -> [String: Int] in');
    const consentIdx = purgeBody.indexOf('resetFileProviderShowInFilesConsent(defaults: sharedDefaults())');
    const bumpIdx = purgeBody.indexOf('if !bumpFileProviderCacheVersion() {');
    const removeIdx = purgeBody.indexOf('removeFileProviderDomainIfRegistered()');
    const purgeAllIdx = purgeBody.indexOf('PlaintextStorageProtection.purgeAll(pendingNonce: pendingNonce)');
    expect(consentIdx).toBeLessThan(bumpIdx);
    expect(bumpIdx).toBeLessThan(removeIdx);
    expect(removeIdx).toBeLessThan(purgeAllIdx);
    // The literal call text must occur EXACTLY once in this function body —
    // if a future comment reintroduces it above the real call, this count
    // goes to 2 and the ordering assertions above stop meaning what they say.
    const occurrences = purgeBody.split('PlaintextStorageProtection.purgeAll(pendingNonce: pendingNonce)').length - 1;
    expect(occurrences).toBe(1);
  });

  test('purgeAll() resweeps pinned/temp unconditionally, strictly after registry(), the legacy sweep, and folds its counts in', () => {
    // Task 1593 f2 — signature gained `pendingNonce: Data? = nil`.
    const purgeAllBody = bracedBody(registrySwift, 'public static func purgeAll(pendingNonce: Data? = nil) -> (removed: Int, failed: Int) {');
    const legacyIdx = purgeAllBody.indexOf('sweepLegacyFileProviderCache()');
    const resweepCallIdx = purgeAllBody.indexOf('resweepFileProviderContentDirectories()');
    const returnIdx = purgeAllBody.lastIndexOf('return (removed, failed)');
    expect(legacyIdx).toBeGreaterThan(-1);
    expect(resweepCallIdx).toBeGreaterThan(legacyIdx);
    expect(returnIdx).toBeGreaterThan(resweepCallIdx);
    const tail = purgeAllBody.slice(resweepCallIdx - 40);
    expect(tail).toMatch(/removed \+= resweep\.removed/);
    expect(tail).toMatch(/failed \+= resweep\.failed/);
  });

  test('resweepFileProviderContentDirectories targets exactly pinned and temp, checked directly against the App Group root', () => {
    const body = bracedBody(
      registrySwift,
      'private static func resweepFileProviderContentDirectories() -> (removed: Int, failed: Int) {'
    );
    expect(body).toMatch(/for name in \["pinned", "temp"\] \{/);
    expect(body).toMatch(/appGroupContainer/);
    expect(body).not.toMatch(/registry\(\)/);
  });

  test('resweepFileProviderContentDirectories counts an absent directory as clean and a real removal failure toward `failed`', () => {
    const body = bracedBody(
      registrySwift,
      'private static func resweepFileProviderContentDirectories() -> (removed: Int, failed: Int) {'
    );
    const absentIdx = body.indexOf('guard FileManager.default.fileExists(atPath: dir.path) else {');
    expect(absentIdx).toBeGreaterThan(-1);
    const absentBranch = body.slice(absentIdx, absentIdx + 150);
    expect(absentBranch).toMatch(/removed \+= 1/);

    const catchIdx = body.indexOf('} catch {', absentIdx);
    expect(catchIdx).toBeGreaterThan(absentIdx);
    const catchBranch = body.slice(catchIdx, catchIdx + 200);
    expect(catchBranch).toMatch(/RuntimeTrace\.event\("storage\.purge\.failed", \["path": dir\.lastPathComponent\]\)/);
    expect(catchBranch).toMatch(/failed \+= 1/);
  });
});

// Task 1593 f1 (follow-up to #144) — fail-closed purge-pending marker,
// original mark-only-after-a-failed-bump design.
//
// Task 1593 f2 (lead design decision: MARKER FIRST) — redesigned to mark
// UNCONDITIONALLY at the start of every purge, with a fresh random nonce
// and compare-then-delete clearing, per the brief. The describe blocks
// below are rewritten in place (never silently) to match: f1's
// "idempotent — does not re-create an existing marker" test is GONE on
// purpose (marker-first always overwrites with a fresh nonce), and every
// signature-dependent test (`markPurgePending() -> Bool` → `-> Data?`,
// `clearPurgePending()` → `clearPurgePending(nonce:)`) is updated to the
// new one. See PlaintextStorageProtection.swift's `markPurgePending()` doc
// comment for the full rationale.
describe('f2 (fail-closed purge-pending marker, marker-first): the marker primitive itself', () => {
  const registrySwift = readFileSync(REGISTRY_SWIFT_PATH, 'utf8');

  test('the marker lives at file-provider-db/purge-pending, in the SAME directory as the cache DB', () => {
    expect(registrySwift).toMatch(/private static let purgePendingMarkerName = "purge-pending"/);
    const dirBody = bracedBody(registrySwift, 'private static var fileProviderCacheDbDirectory: URL? {');
    expect(dirBody).toMatch(/appGroupContainer\?\.appendingPathComponent\("file-provider-db", isDirectory: true\)/);
  });

  test('markPurgePending creates + protects the directory, then creates + protects a PLAIN file containing a fresh nonce — no SQLite involved', () => {
    const body = bracedBody(registrySwift, 'public static func markPurgePending() -> Data? {');
    expect(body).toMatch(/createDirectory\(at: dir, withIntermediateDirectories: true\)/);
    expect(body).toMatch(/protect\(dir\)/);
    expect(body).toMatch(/let nonce = randomPurgePendingNonce\(\)/);
    expect(body).toMatch(/createFile\(atPath: url\.path, contents: nonce\)/);
    expect(body).toMatch(/protect\(url\)/);
    expect(body).toMatch(/return nonce/);
    // Deliberately no SQLite: this marker's own creation must not be able to
    // fail the same correlated way a DB write under contention can.
    expect(body).not.toMatch(/sqlite3_/);
    expect(body).not.toMatch(/OpaquePointer/);
  });

  test('markPurgePending is NOT idempotent any more: it always overwrites with a FRESH nonce, never guards on the marker already existing', () => {
    const body = bracedBody(registrySwift, 'public static func markPurgePending() -> Data? {');
    // f1's guard is gone — createFile runs unconditionally.
    expect(body).not.toMatch(/if !FileManager\.default\.fileExists\(atPath: url\.path\)/);
    const nonceIdx = body.indexOf('let nonce = randomPurgePendingNonce()');
    const createIdx = body.indexOf('createFile(atPath: url.path, contents: nonce)');
    expect(nonceIdx).toBeGreaterThan(-1);
    expect(createIdx).toBeGreaterThan(nonceIdx);
  });

  test('randomPurgePendingNonce generates 16 bytes via SecRandomCopyBytes, with an arc4random_buf fallback on failure — never a constant', () => {
    const body = bracedBody(registrySwift, 'private static func randomPurgePendingNonce() -> Data {');
    expect(body).toMatch(/count: 16/);
    expect(body).toMatch(/SecRandomCopyBytes\(kSecRandomDefault, buffer\.count, buffer\.baseAddress!\)/);
    expect(body).toMatch(/if status != errSecSuccess \{\s*\n\s*arc4random_buf\(&bytes, bytes\.count\)\s*\n\s*\}/);
  });

  test('a successful primary mark restores any stale chmod fallback, so THIS purge is not blocked by a past one', () => {
    const body = bracedBody(registrySwift, 'public static func markPurgePending() -> Data? {');
    const protectUrlIdx = body.lastIndexOf('protect(url)');
    expect(protectUrlIdx).toBeGreaterThan(-1);
    const after = body.slice(protectUrlIdx, protectUrlIdx + 700);
    expect(after).toMatch(/restoreFileProviderCacheDatabaseWritable\(\)/);
    expect(after).toMatch(/RuntimeTrace\.event\("storage\.purge\.pending_marked", \[:\]\)/);
    expect(after).toMatch(/return nonce/);
  });

  test('isPurgePending checks the marker FILE first, then the chmod fallback — either one is enough to read as pending', () => {
    const body = bracedBody(registrySwift, 'public static func isPurgePending() -> Bool {');
    expect(body).toMatch(/fileProviderCacheDbDirectory/);
    expect(body).toMatch(/purgePendingMarkerName/);
    const fileCheckIdx = body.indexOf('FileManager.default.fileExists(');
    const fallbackIdx = body.indexOf('return isPurgePendingViaFallback()');
    expect(fileCheckIdx).toBeGreaterThan(-1);
    expect(fallbackIdx).toBeGreaterThan(fileCheckIdx);
  });
});

// Task 1593 f2 (item 1, Codex P2 thread PRRT_kwDOSLX6T86mkAIo): "createFile
// can fail on a full volume and callers ignore false." Decision logic under
// test: on a createFile failure, fall back to chmod-ing the File Provider
// cache database read-only (a signal that needs zero free space to set,
// unlike creating anything new), and trace storage.purge.failed. See the
// doc comment on markPurgePendingFallback() for why chmod was chosen over
// renaming the DB directory or deleting the database outright.
describe('f2 (item 1): a createFile failure on markPurgePending falls back to a zero-free-space chmod signal', () => {
  const registrySwift = readFileSync(REGISTRY_SWIFT_PATH, 'utf8');

  test('markPurgePending falls back to markPurgePendingFallback() exactly on the createFile failure branch, not on success', () => {
    const body = bracedBody(registrySwift, 'public static func markPurgePending() -> Data? {');
    const guardIdx = body.indexOf('guard FileManager.default.createFile(atPath: url.path, contents: nonce) else {');
    expect(guardIdx).toBeGreaterThan(-1);
    const failureBranch = body.slice(guardIdx, body.indexOf('}', guardIdx));
    expect(failureBranch).toMatch(/RuntimeTrace\.event\("storage\.purge\.pending_marker_failed", \[:\]\)/);
    expect(failureBranch).toMatch(/return markPurgePendingFallback\(\)/);
    // The success path (after the guard) must NOT also call the fallback.
    const afterGuard = body.slice(body.indexOf('}', guardIdx));
    expect(afterGuard).not.toMatch(/markPurgePendingFallback/);
  });

  test('markPurgePendingFallback chmods the File Provider cache DB to 0o400 (owner-write bit removed) — a metadata-only op needing zero new disk space', () => {
    const body = bracedBody(registrySwift, 'private static func markPurgePendingFallback() -> Data? {');
    expect(body).toMatch(/setAttributes\(\[\.posixPermissions: 0o400\], ofItemAtPath: dbUrl\.path\)/);
    // Never anything that could itself need free space: no createFile, no
    // write(to:), no createDirectory in this fallback.
    expect(body).not.toMatch(/createFile\(/);
    expect(body).not.toMatch(/\.write\(to:/);
  });

  test('markPurgePendingFallback records storage.purge.failed on EVERY one of its own failure paths (no database to chmod; the chmod itself throws) — never silently swallowed', () => {
    const body = bracedBody(registrySwift, 'private static func markPurgePendingFallback() -> Data? {');
    const failedTraceCount = (body.match(/RuntimeTrace\.event\("storage\.purge\.failed", \["stage": "pending_marker_[a-z_]+"\]\)/g) ?? []).length;
    expect(failedTraceCount).toBe(2); // pending_marker_no_database, pending_marker_chmod_fallback
    // Each failure trace is immediately followed by `return nil` — never a
    // silently-discarded false the way Codex's original finding described.
    let idx = -1;
    for (let i = 0; i < failedTraceCount; i++) {
      idx = body.indexOf('RuntimeTrace.event("storage.purge.failed"', idx + 1);
      expect(idx).toBeGreaterThan(-1);
      const after = body.slice(idx, idx + 150);
      expect(after).toMatch(/return nil/);
    }
  });

  test('a successful fallback returns Data() — an EMPTY, distinguishable sentinel, never nil (nil means total failure) — and traces distinctly from the primary path', () => {
    const body = bracedBody(registrySwift, 'private static func markPurgePendingFallback() -> Data? {');
    const setAttrsIdx = body.indexOf('setAttributes([.posixPermissions: 0o400]');
    expect(setAttrsIdx).toBeGreaterThan(-1);
    const after = body.slice(setAttrsIdx, setAttrsIdx + 300);
    expect(after).toMatch(/RuntimeTrace\.event\("storage\.purge\.pending_marked_fallback", \[:\]\)/);
    expect(after).toMatch(/return Data\(\)/);
    // Distinct from the primary path's own success trace.
    expect(body).not.toMatch(/storage\.purge\.pending_marked"/);
  });

  test('isPurgePendingViaFallback reads "not pending" for a database that does not exist yet — never confuses "never created" with "chmod-locked"', () => {
    const body = bracedBody(registrySwift, 'private static func isPurgePendingViaFallback() -> Bool {');
    // Must gate on `fileExists`/`attributesOfItem` (both fail closed to
    // `false` for a missing file) before ever inspecting permission bits.
    expect(body).toMatch(/attributesOfItem\(atPath: dbUrl\.path\)/);
    expect(body).toMatch(/return false/);
    expect(body).toMatch(/perms\.intValue & 0o200 == 0/);
  });

  test('restoreFileProviderCacheDatabaseWritable chmods back to 0o600 only when the owner-write bit is actually missing, and traces a failure to do so', () => {
    const body = bracedBody(registrySwift, 'private static func restoreFileProviderCacheDatabaseWritable() -> Bool {');
    expect(body).toMatch(/perms\.intValue & 0o200 == 0/);
    expect(body).toMatch(/setAttributes\(\[\.posixPermissions: 0o600\], ofItemAtPath: dbUrl\.path\)/);
    const catchIdx = body.indexOf('} catch {');
    expect(catchIdx).toBeGreaterThan(-1);
    expect(body.slice(catchIdx, catchIdx + 200)).toMatch(/RuntimeTrace\.event\("storage\.purge\.pending_clear_failed", \["stage": "chmod_restore"\]\)/);
  });
});

// Task 1593 f2 (item 2, Codex P2 thread PRRT_kwDOSLX6T86mkAIp): "the
// open-failure fallback must leave the marker set." Under marker-first the
// marker is ALREADY set before resetSQLiteInPlace ever runs, so both of its
// own internal failure branches (the open failure below, and the
// table-enumeration failure further down) must make NO call that could
// touch the marker at all — re-marking here would actively be wrong (it
// would overwrite the nonce purgePlaintextStorage is holding for its own
// later compare-then-delete).
describe('f2 (item 2): resetSQLiteInPlace\'s failure branches leave the marker-first mark untouched', () => {
  const registrySwift = readFileSync(REGISTRY_SWIFT_PATH, 'utf8');
  const body = bracedBody(registrySwift, 'private static func resetSQLiteInPlace(_ url: URL, pendingNonce: Data?) -> Bool {');

  test('the open-failure fallback (unlink branch) makes no markPurgePending/clearPurgePending call of any kind', () => {
    const openGuardIdx = body.indexOf('guard sqlite3_open_v2(');
    const deferIdx = body.indexOf('defer { sqlite3_close(db) }');
    expect(openGuardIdx).toBeGreaterThan(-1);
    expect(deferIdx).toBeGreaterThan(openGuardIdx);
    const openFailureBranch = body.slice(openGuardIdx, deferIdx);
    expect(openFailureBranch).not.toMatch(/markPurgePending/);
    expect(openFailureBranch).not.toMatch(/clearPurgePending/);
    // Still returns the unlink loop's own `ok`, unrelated to the marker.
    expect(openFailureBranch).toMatch(/return ok/);
  });

  test('the table-enumeration (prepare) failure branch also makes no re-mark call', () => {
    const prepareFailIdx = body.indexOf("db, \"SELECT name FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%'\", -1, &stmt, nil");
    expect(prepareFailIdx).toBeGreaterThan(-1);
    const after = body.slice(prepareFailIdx, prepareFailIdx + 400);
    expect(after).not.toMatch(/markPurgePending/);
    expect(after).toMatch(/return false/);
  });

  test('resetSQLiteInPlace\'s own doc comment (which sits ABOVE its signature, outside bracedBody\'s extracted body) states the "no re-mark needed" rationale', () => {
    // Documentation-as-contract check: the function's doc comment must name
    // BOTH the open failure and the table-enumeration failure explicitly,
    // so a future edit that adds a NEW failure branch is more likely to
    // also update this reasoning rather than silently diverge from it.
    // Checked against the WHOLE file, not `body` — a `///` doc comment
    // precedes the signature `bracedBody` starts from, so it is not part
    // of the extracted function body at all.
    expect(registrySwift).toMatch(/this open failure, or the table-enumeration failure/);
  });
});

describe('f2: resetSQLiteInPlace only clears via compare-then-delete against ITS OWN pendingNonce, and only after a durably-committed bump', () => {
  const registrySwift = readFileSync(REGISTRY_SWIFT_PATH, 'utf8');
  const body = bracedBody(registrySwift, 'private static func resetSQLiteInPlace(_ url: URL, pendingNonce: Data?) -> Bool {');

  test('bumpCommitted is captured BEFORE VACUUM can touch `ok`, exactly as f1 established', () => {
    const bumpCommittedIdx = body.indexOf('let bumpCommitted = ok');
    const vacuumIdx = body.indexOf('vacuumRetryingOnceOnBusy(db)');
    expect(bumpCommittedIdx).toBeGreaterThan(-1);
    expect(vacuumIdx).toBeGreaterThan(bumpCommittedIdx);
  });

  test('clears ONLY when bumpCommitted AND a non-nil pendingNonce — a total mark-pending failure (nil) is never treated as "safe to clear"', () => {
    const bumpCommittedIdx = body.indexOf('let bumpCommitted = ok');
    const vacuumIdx = body.indexOf('vacuumRetryingOnceOnBusy(db)');
    const decisionBlock = body.slice(bumpCommittedIdx, vacuumIdx);
    expect(decisionBlock).toMatch(/if bumpCommitted, let pendingNonce \{\s*\n\s*clearPurgePending\(nonce: pendingNonce\)\s*\n\s*\}/);
    // No unconditional / else-branch re-mark — a failed bump just leaves
    // whatever marker-first already set, untouched. Checked as an actual
    // CALL (trailing `(`), not a bare name match — the doc comment right
    // above this decision legitimately CITES `markPurgePending()`'s own
    // doc comment by name without calling it, which a bare-name check
    // would misread as a real call (the exact "a doc comment mentioning it
    // is not evidence" trap this task's own round-8 M12 and f1's M3 hit).
    expect(decisionBlock).not.toMatch(/\} else \{/);
    const callSites = [...decisionBlock.matchAll(/[^`]markPurgePending\(\)/g)];
    expect(callSites.length).toBe(0);
  });

  test('clearPurgePending is called at most once in this function, passing the EXACT pendingNonce parameter (never a fresh read)', () => {
    const clearCalls = (body.match(/clearPurgePending\(nonce: [a-zA-Z]+\)/g) ?? []);
    expect(clearCalls.length).toBe(1);
    expect(clearCalls[0]).toBe('clearPurgePending(nonce: pendingNonce)');
  });
});

describe('f2: clearPurgePending(nonce:) is a real compare-then-delete, with a distinct unconditional path for the chmod fallback\'s empty sentinel', () => {
  const registrySwift = readFileSync(REGISTRY_SWIFT_PATH, 'utf8');
  const body = bracedBody(registrySwift, 'public static func clearPurgePending(nonce: Data) {');

  test('an empty nonce (the chmod fallback\'s sentinel) restores write permission unconditionally, before ever touching the marker file', () => {
    expect(body).toMatch(/if nonce\.isEmpty \{\s*\n\s*_ = restoreFileProviderCacheDatabaseWritable\(\)\s*\n\s*return\s*\n\s*\}/);
  });

  test('a non-empty nonce reads the on-disk marker and deletes ONLY on an exact byte-for-byte match', () => {
    const guardIdx = body.indexOf('guard let onDisk = try? Data(contentsOf: url), onDisk == nonce else {');
    expect(guardIdx).toBeGreaterThan(-1);
    const mismatchBranch = body.slice(guardIdx, body.indexOf('}', guardIdx));
    // A mismatch (or unreadable marker) is traced and left alone — never deleted.
    expect(mismatchBranch).toMatch(/RuntimeTrace\.event\("storage\.purge\.pending_clear_skipped", \[:\]\)/);
    expect(mismatchBranch).not.toMatch(/removeItem/);
    const afterGuard = body.slice(body.indexOf('}', guardIdx));
    expect(afterGuard).toMatch(/try FileManager\.default\.removeItem\(at: url\)/);
    expect(afterGuard).toMatch(/RuntimeTrace\.event\("storage\.purge\.pending_cleared", \[:\]\)/);
  });

  test('a failed removal (the match succeeded but the delete itself threw) is traced and NOT counted as cleared', () => {
    const catchIdx = body.indexOf('} catch {');
    expect(catchIdx).toBeGreaterThan(-1);
    const catchBranch = body.slice(catchIdx, catchIdx + 200);
    expect(catchBranch).toMatch(/RuntimeTrace\.event\("storage\.purge\.pending_clear_failed", \[:\]\)/);
    expect(catchBranch).not.toMatch(/removeItem/);
  });
});

describe('f2 (marker-first): purgePlaintextStorage marks pending as its VERY FIRST action — before consent reset, before any bump, before any DB is opened', () => {
  const moduleSwift = readFileSync(MODULE_SWIFT_PATH, 'utf8');

  test('markPurgePending() is the first statement in the function body, strictly before resetFileProviderShowInFilesConsent / bumpFileProviderCacheVersion / removeFileProviderDomainIfRegistered / purgeAll', () => {
    const purgeBody = bracedBody(moduleSwift, 'AsyncFunction("purgePlaintextStorage") { () -> [String: Int] in');
    const markIdx = purgeBody.indexOf('let pendingNonce = PlaintextStorageProtection.markPurgePending()');
    const consentIdx = purgeBody.indexOf('resetFileProviderShowInFilesConsent(defaults: sharedDefaults())');
    const bumpIdx = purgeBody.indexOf('if !bumpFileProviderCacheVersion() {');
    const removeDomainIdx = purgeBody.indexOf('if !removeFileProviderDomainIfRegistered() {');
    const purgeAllIdx = purgeBody.indexOf('PlaintextStorageProtection.purgeAll(pendingNonce: pendingNonce)');
    expect(markIdx).toBeGreaterThan(-1);
    // markPurgePending must be BEFORE every one of the other four steps.
    expect(consentIdx).toBeGreaterThan(markIdx);
    expect(bumpIdx).toBeGreaterThan(markIdx);
    expect(removeDomainIdx).toBeGreaterThan(markIdx);
    expect(purgeAllIdx).toBeGreaterThan(markIdx);
    // And markPurgePending must come before ANYTHING else at all — no
    // other statement of substance precedes it (only `var failed = 0` and
    // this design-decision's own doc comment). Checked as actual CALLS
    // (trailing `(`), since that doc comment legitimately names `purgeAll`
    // in prose ("at the very end of `purgeAll` below") without calling it.
    const preamble = purgeBody.slice(0, markIdx);
    expect(preamble).not.toMatch(/resetFileProviderShowInFilesConsent\(|bumpFileProviderCacheVersion\(|removeFileProviderDomainIfRegistered\(|purgeAll\(/);
  });

  test('a total mark-pending failure (nil) is a real, counted purge failure, traced distinctly', () => {
    const purgeBody = bracedBody(moduleSwift, 'AsyncFunction("purgePlaintextStorage") { () -> [String: Int] in');
    const markIdx = purgeBody.indexOf('let pendingNonce = PlaintextStorageProtection.markPurgePending()');
    const after = purgeBody.slice(markIdx, markIdx + 300);
    expect(after).toMatch(/if pendingNonce == nil \{\s*\n\s*RuntimeTrace\.event\("storage\.purge\.failed", \["stage": "pending_marker"\]\)\s*\n\s*failed \+= 1\s*\n\s*\}/);
  });

  test('the two-failed-early-bumps branch no longer calls markPurgePending() itself — marker-first already covers it', () => {
    const purgeBody = bracedBody(moduleSwift, 'AsyncFunction("purgePlaintextStorage") { () -> [String: Int] in');
    const failedTraceIdx = purgeBody.indexOf('RuntimeTrace.event("storage.purge.failed", ["stage": "file_provider_cache_version_bump"])');
    expect(failedTraceIdx).toBeGreaterThan(-1);
    const after = purgeBody.slice(failedTraceIdx, failedTraceIdx + 500);
    expect(after).toMatch(/failed \+= 1/);
    // No bare CALL to markPurgePending() in this branch — the comment here
    // deliberately avoids writing that literal substring at all (see the
    // real source comment), so a plain substring check is enough and does
    // not need the backtick-exclusion trick the previous test uses.
    expect(after).not.toMatch(/markPurgePending\(\)/);
  });

  test('purgeAll is called with pendingNonce: pendingNonce — the EXACT value markPurgePending() returned, never a fresh read', () => {
    const purgeBody = bracedBody(moduleSwift, 'AsyncFunction("purgePlaintextStorage") { () -> [String: Int] in');
    expect(purgeBody).toMatch(/PlaintextStorageProtection\.purgeAll\(pendingNonce: pendingNonce\)/);
  });
});

// Task 1593 f2 (item 3, reviewer follow-up): "registration clears the
// marker — keep that, but make it conditional: read the nonce before BEGIN
// IMMEDIATE, bump, and delete only if the nonce is unchanged; if a purge is
// running (marker newer than the read), leave it."
describe('f2 (item 3): bumpFileProviderCacheVersion(clearsPendingMarker:) captures the nonce BEFORE BEGIN IMMEDIATE and clears via compare-then-delete only on the caller\'s opt-in', () => {
  const moduleSwift = readFileSync(MODULE_SWIFT_PATH, 'utf8');
  const body = bracedBody(moduleSwift, 'private func bumpFileProviderCacheVersion(clearsPendingMarker: Bool = false) -> Bool {');

  test('clearsPendingMarker defaults to false — a bare call (the purge\'s own early-bump call site) never clears', () => {
    expect(body).toMatch(/private func bumpFileProviderCacheVersion\(clearsPendingMarker: Bool = false\) -> Bool \{/);
  });

  test('the nonce is captured via currentPurgePendingNonce() BEFORE the BEGIN IMMEDIATE exec call, gated on clearsPendingMarker', () => {
    const captureIdx = body.indexOf('let nonceBeforeBump = clearsPendingMarker');
    const beginIdx = body.indexOf('sqlite3_exec(db, "BEGIN IMMEDIATE", nil, nil, nil)');
    expect(captureIdx).toBeGreaterThan(-1);
    expect(beginIdx).toBeGreaterThan(captureIdx);
    const captureLine = body.slice(captureIdx, body.indexOf('\n', captureIdx + 200));
    expect(captureLine).toMatch(/PlaintextStorageProtection\.currentPurgePendingNonce\(\)/);
  });

  test('clears ONLY after COMMIT succeeds, ONLY when clearsPendingMarker is true, and ONLY against the value captured BEFORE BEGIN IMMEDIATE (never a fresh read at clear time)', () => {
    const commitGuardIdx = body.indexOf('guard sqlite3_exec(db, "COMMIT", nil, nil, nil) == SQLITE_OK else {');
    expect(commitGuardIdx).toBeGreaterThan(-1);
    const after = body.slice(commitGuardIdx);
    expect(after).toMatch(/if clearsPendingMarker, let nonceBeforeBump \{\s*\n\s*PlaintextStorageProtection\.clearPurgePending\(nonce: nonceBeforeBump\)\s*\n\s*\}/);
    const clearCount = (after.match(/PlaintextStorageProtection\.clearPurgePending\(/g) ?? []).length;
    expect(clearCount).toBe(1);
  });

  test('every early-return failure guard in this function precedes the clear — a failed bump never reaches it', () => {
    const clearIdx = body.indexOf('PlaintextStorageProtection.clearPurgePending(nonce: nonceBeforeBump)');
    const guardReturns = [...body.matchAll(/guard sqlite3_[a-z_]+\([^)]*\)[^{]*\{[^}]*return false[^}]*\}/g)];
    expect(guardReturns.length).toBeGreaterThan(0);
    for (const match of guardReturns) {
      expect(match.index).toBeLessThan(clearIdx);
    }
  });
});

describe('f2 (item 3): the purge\'s own early bump stays clearsPendingMarker: false; only registration opts in to clearing', () => {
  const moduleSwift = readFileSync(MODULE_SWIFT_PATH, 'utf8');

  test('purgePlaintextStorage\'s early-bump call sites pass NO clearsPendingMarker argument (using the false default)', () => {
    const purgeBody = bracedBody(moduleSwift, 'AsyncFunction("purgePlaintextStorage") { () -> [String: Int] in');
    expect(purgeBody).toMatch(/if !bumpFileProviderCacheVersion\(\) \{\s*\n\s*if !bumpFileProviderCacheVersion\(\) \{/);
    expect(purgeBody).not.toMatch(/bumpFileProviderCacheVersion\(clearsPendingMarker:/);
  });

  test('registerMountedFileProviderDomainLocked passes clearsPendingMarker: true explicitly', () => {
    const body = bracedBody(
      moduleSwift,
      'private func registerMountedFileProviderDomainLocked(\n  defaults: UserDefaults?,\n  forceReset: Bool = false\n) async throws -> [String: Any] {',
    );
    expect(body).toMatch(/bumpFileProviderCacheVersion\(clearsPendingMarker: true\)/);
  });
});

// Task 1593 f2 (item 4, reviewer follow-up): "if the registration's own
// bump fails (busy > 2 s) or cacheReady is false, retry once after a short
// delay (off the cooperative pool), then trace; do not leave the marker
// stuck silently."
describe('f2 (item 4): registration retries once, off the cooperative pool, on a failed bump OR cacheReady == false — then traces, never silent', () => {
  const moduleSwift = readFileSync(MODULE_SWIFT_PATH, 'utf8');

  test('retryFileProviderCacheReadyAndBumpOffCooperativePool re-attempts BOTH ensureFileProviderCacheDatabase and the bump, off a GCD queue with a short delay', () => {
    const body = bracedBody(
      moduleSwift,
      'private func retryFileProviderCacheReadyAndBumpOffCooperativePool() async -> (ready: Bool, bumped: Bool) {',
    );
    expect(body).toMatch(/DispatchQueue\.global\(qos: \.userInitiated\)\.asyncAfter\(deadline: \.now\(\) \+ 0\.25\)/);
    expect(body).toMatch(/let ready = ensureFileProviderCacheDatabase\(\)/);
    expect(body).toMatch(/let bumped = ready && bumpFileProviderCacheVersion\(clearsPendingMarker: true\)/);
  });

  test('registerMountedFileProviderDomainLocked retries exactly once, only when the first attempt failed OR cacheReady was false', () => {
    const body = bracedBody(
      moduleSwift,
      'private func registerMountedFileProviderDomainLocked(\n  defaults: UserDefaults?,\n  forceReset: Bool = false\n) async throws -> [String: Any] {',
    );
    const firstAttemptIdx = body.indexOf('var cacheVersionBumped = cacheReady && bumpFileProviderCacheVersion(clearsPendingMarker: true)');
    const retryIdx = body.indexOf('retryFileProviderCacheReadyAndBumpOffCooperativePool()');
    expect(firstAttemptIdx).toBeGreaterThan(-1);
    expect(retryIdx).toBeGreaterThan(firstAttemptIdx);
    const between = body.slice(firstAttemptIdx, retryIdx);
    expect(between).toMatch(/if !cacheReady \|\| !cacheVersionBumped \{/);
    // Exactly one retry call — not a loop.
    const retryCallCount = (body.match(/retryFileProviderCacheReadyAndBumpOffCooperativePool\(\)/g) ?? []).length;
    expect(retryCallCount).toBe(1);
  });

  test('a failure that survives the retry is traced with a stage naming WHICH thing failed — never silently discarded', () => {
    const body = bracedBody(
      moduleSwift,
      'private func registerMountedFileProviderDomainLocked(\n  defaults: UserDefaults?,\n  forceReset: Bool = false\n) async throws -> [String: Any] {',
    );
    const retryIdx = body.indexOf('retryFileProviderCacheReadyAndBumpOffCooperativePool()');
    const after = body.slice(retryIdx, retryIdx + 400);
    expect(after).toMatch(/if !cacheReady \|\| !cacheVersionBumped \{\s*\n\s*RuntimeTrace\.event\("storage\.purge\.failed", \[/);
    expect(after).toMatch(/"stage": cacheReady \? "registration_cache_version_bump" : "registration_cache_not_ready"/);
  });

  test('cacheReady is a `var`, so a SUCCESSFUL retry updates it — the function\'s returned cacheDatabaseReady reflects the retried outcome, not just the first attempt', () => {
    const body = bracedBody(
      moduleSwift,
      'private func registerMountedFileProviderDomainLocked(\n  defaults: UserDefaults?,\n  forceReset: Bool = false\n) async throws -> [String: Any] {',
    );
    expect(body).toMatch(/var cacheReady = ensureFileProviderCacheDatabase\(\)/);
    expect(body).toMatch(/\(cacheReady, cacheVersionBumped\) = await retryFileProviderCacheReadyAndBumpOffCooperativePool\(\)/);
    expect(body).toMatch(/cacheDatabaseReady: cacheReady,/);
  });
});

describe('f2: CacheManager still refuses every epoch-gated write and gate check while a purge is pending (isPurgePending\'s own signature and call sites are unchanged by the marker-first redesign)', () => {
  const cacheManagerSwift = readFileSync(CACHE_MANAGER_SWIFT_PATH, 'utf8');

  test('beginImmediate — the single choke point for replaceChildren / upsert(_:expectedEpoch:) / delete(id:expectedEpoch:) — refuses while pending, checked BEFORE issuing BEGIN IMMEDIATE', () => {
    const body = bracedBody(cacheManagerSwift, 'private func beginImmediate() -> Bool {');
    const pendingIdx = body.indexOf('guard !PlaintextStorageProtection.isPurgePending() else { return false }');
    const beginIdx = body.indexOf('sqlite3_exec(db, "BEGIN IMMEDIATE", nil, nil, nil)');
    expect(pendingIdx).toBeGreaterThan(-1);
    expect(beginIdx).toBeGreaterThan(pendingIdx);
  });

  test('purgeEpochUnchanged (fetchContents\' temp/pinned gate) refuses while pending, checked BEFORE the epoch comparison, epoch-match or not', () => {
    const body = bracedBody(cacheManagerSwift, 'func purgeEpochUnchanged(since capturedEpoch: Int) -> Bool {');
    const pendingIdx = body.indexOf('guard !PlaintextStorageProtection.isPurgePending() else { return false }');
    const matchIdx = body.indexOf('return currentEpochMatches(capturedEpoch)');
    expect(pendingIdx).toBeGreaterThan(-1);
    expect(matchIdx).toBeGreaterThan(pendingIdx);
  });

  test('every epoch-gated writer still routes through beginImmediate — the marker check has exactly one place to live', () => {
    const beginImmediateCallCount = (cacheManagerSwift.match(/guard beginImmediate\(\) else \{ return false \}/g) ?? []).length;
    // replaceChildren, upsert(_:expectedEpoch:), delete(id:expectedEpoch:).
    expect(beginImmediateCallCount).toBe(3);
  });
});

describe('f1 (item 2): the unused batch upsert(_ items:) is removed — confirmed zero callers first', () => {
  const cacheManagerSwift = readFileSync(CACHE_MANAGER_SWIFT_PATH, 'utf8');
  const extensionSwift = readFileSync(FILE_PROVIDER_EXTENSION_SWIFT_PATH, 'utf8');

  test('CacheManager no longer declares upsert(_ items: [CachedItem]) with its own unchecked BEGIN/COMMIT', () => {
    expect(cacheManagerSwift).not.toMatch(/func upsert\(_ items: \[CachedItem\]\)/);
  });

  test('the single-item, non-gated upsert(_ item: CachedItem) still exists — only the batch overload was removed', () => {
    expect(cacheManagerSwift).toMatch(/func upsert\(_ item: CachedItem\) \{/);
  });

  test('the epoch-gated upsert(_:expectedEpoch:) — the one every real caller actually uses — is untouched', () => {
    expect(cacheManagerSwift).toMatch(/func upsert\(_ item: CachedItem, expectedEpoch: Int\) -> Bool \{/);
    expect(extensionSwift).toMatch(/CacheManager\.shared\.upsert\(cached, expectedEpoch: epochAtStart\)/);
    expect(extensionSwift).toMatch(/CacheManager\.shared\.upsert\(updated, expectedEpoch: epochAtStart\)/);
  });
});

// Task 1593 f1 (item 3) — the brief asked to confirm (or fix) that
// `FileProviderRegistrationGate` serializes `registerMountedFileProviderDomain`
// end to end and that the undo's blocking removal runs off the cooperative
// pool. Both are round 10 (reviewer F-a) additions this round did NOT touch;
// the full structural proof already lives in that round's own describe block
// above ("round 10 (reviewer F-a): overlapping registrations no longer undo
// each other, and the undo removal moves off the cooperative pool") — this
// block re-confirms the two headline claims the brief names, rather than
// duplicating that whole suite, and points at the additional BEHAVIORAL
// proof this round adds beyond source-scanning (a real Swift-interpreter
// execution of the extracted gate, not just "the right tokens appear"):
// _qa-evidence/1593/f1-registration-gate-behavioral-proof.txt.
describe('f1 (item 3, confirms round 10 F-a still holds — no code change needed here)', () => {
  const moduleSwift = readFileSync(MODULE_SWIFT_PATH, 'utf8');

  test('registerMountedFileProviderDomain (every real call site\'s entry point) still acquires/releases fileProviderRegistrationGate around the locked impl, on both success and throw', () => {
    const body = bracedBody(
      moduleSwift,
      'private func registerMountedFileProviderDomain(\n  defaults: UserDefaults?,\n  forceReset: Bool = false\n) async throws -> [String: Any] {',
    );
    expect(body).toMatch(/await fileProviderRegistrationGate\.acquire\(\)/);
    const releaseCount = (body.match(/await fileProviderRegistrationGate\.release\(\)/g) ?? []).length;
    expect(releaseCount).toBe(2);
  });

  test('the gate is a real FIFO async lock (actor, waiters queue, no DispatchSemaphore) — not just actor-isolation alone', () => {
    expect(moduleSwift).toMatch(/private actor FileProviderRegistrationGate \{/);
    const body = bracedBody(moduleSwift, 'private actor FileProviderRegistrationGate {');
    expect(body).toMatch(/func acquire\(\) async \{/);
    expect(body).toMatch(/func release\(\) \{/);
    expect(body).not.toMatch(/DispatchSemaphore/);
  });

  test('the undo path calls the off-cooperative-pool removal wrapper, not the blocking semaphore-based function directly', () => {
    const body = bracedBody(
      moduleSwift,
      'private func registerMountedFileProviderDomainLocked(\n  defaults: UserDefaults?,\n  forceReset: Bool = false\n) async throws -> [String: Any] {',
    );
    expect(body).toMatch(/removeFileProviderDomainIfRegisteredOffCooperativePool\(\)/);
    expect(body).not.toMatch(/= removeFileProviderDomainIfRegistered\(\)/);
  });

  test('removeFileProviderDomainIfRegisteredOffCooperativePool moves the blocking wait onto a normal GCD queue, off the Swift cooperative pool', () => {
    const body = bracedBody(
      moduleSwift,
      'private func removeFileProviderDomainIfRegisteredOffCooperativePool() async -> Bool {',
    );
    expect(body).toMatch(/DispatchQueue\.global\(qos: \.userInitiated\)\.async \{/);
  });
});
