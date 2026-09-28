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
  const body = functionBody(swift, 'private static func resetSQLiteInPlace(_ url: URL) -> Bool {');

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
  const body = functionBody(swift, 'private static func resetSQLiteInPlace(_ url: URL) -> Bool {');

  test('sets a busy timeout before touching the database', () => {
    expect(body).toMatch(/sqlite3_busy_timeout\(db,\s*\d+\)/);
  });

  test('a failed sqlite_master prepare returns false, not true', () => {
    const prepareIdx = body.indexOf('sqlite3_prepare_v2');
    expect(prepareIdx).toBeGreaterThan(-1);
    // The guard's else-branch, up to the next top-level statement.
    const elseSlice = body.slice(prepareIdx, prepareIdx + 400);
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
    const preciseBody = bracedBody(swift, 'private static func resetSQLiteInPlace(_ url: URL) -> Bool {');
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

  test('order is: consent reset -> domain removal -> PlaintextStorageProtection.purgeAll()', () => {
    const consentIdx = purgeBody.indexOf('resetFileProviderShowInFilesConsent(defaults: sharedDefaults())');
    const removeIdx = purgeBody.indexOf('removeFileProviderDomainIfRegistered()');
    const purgeAllIdx = purgeBody.indexOf('PlaintextStorageProtection.purgeAll()');
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
  const body = bracedBody(swift, 'private func bumpFileProviderCacheVersion() -> Bool {');

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

  test('is called (result discarded) as the early purge-epoch bump in purgePlaintextStorage', () => {
    const purgeBody = bracedBody(swift, 'AsyncFunction("purgePlaintextStorage") { () -> [String: Int] in');
    expect(purgeBody).toMatch(/_ = bumpFileProviderCacheVersion\(\)/);
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
    const body = bracedBody(swift, 'private static func resetSQLiteInPlace(_ url: URL) -> Bool {');
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
    const resetBody = bracedBody(swift, 'private static func resetSQLiteInPlace(_ url: URL) -> Bool {');
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
    const deleteCallIdx = body.indexOf('try await ApiClient.shared.deleteFile(fileId: identifier.rawValue)');
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
