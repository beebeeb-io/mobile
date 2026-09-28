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
    const bumpIdx = purgeBody.indexOf('bumpFileProviderPurgeEpoch(defaults: sharedDefaults())');
    const removeIdx = purgeBody.indexOf('removeFileProviderDomainIfRegistered()');
    expect(bumpIdx).toBeGreaterThan(-1);
    expect(removeIdx).toBeGreaterThan(-1);
    expect(bumpIdx).toBeLessThan(removeIdx);
  });

  test('bumpFileProviderPurgeEpoch and the extension\'s Constants.purgeEpochKey use the same literal key', () => {
    const cacheManagerConstants = readFileSync(
      join(REPO_ROOT, 'targets', 'file-provider', 'Constants.swift'), 'utf8',
    );
    const mainAppMatch = swift.match(/fileProviderPurgeEpochKey = "([^"]+)"/);
    const extensionMatch = cacheManagerConstants.match(/purgeEpochKey = "([^"]+)"/);
    expect(mainAppMatch).not.toBeNull();
    expect(extensionMatch).not.toBeNull();
    expect(mainAppMatch![1]).toBe(extensionMatch![1]);
  });
});

describe('C1 (round 7, P1): the File Provider extension refuses a write whose purge epoch changed during its fetch', () => {
  const cacheManagerSwift = readFileSync(CACHE_MANAGER_SWIFT_PATH, 'utf8');
  const syncEngineSwift = readFileSync(
    join(REPO_ROOT, 'targets', 'file-provider', 'SyncEngine.swift'), 'utf8',
  );

  test('CacheManager.replaceChildren checks the CURRENT epoch inside its own serial queue before writing', () => {
    const body = bracedBody(
      cacheManagerSwift,
      'func replaceChildren(parent: String?, with items: [CachedItem], expectedEpoch: Int) -> Bool {',
    );
    const queueSyncIdx = body.indexOf('queue.sync');
    const guardIdx = body.indexOf('guard currentPurgeEpoch() == expectedEpoch else { return false }');
    const beginIdx = body.indexOf('"BEGIN"');
    expect(queueSyncIdx).toBeGreaterThan(-1);
    expect(guardIdx).toBeGreaterThan(-1);
    expect(beginIdx).toBeGreaterThan(-1);
    // The epoch check must run INSIDE the serial queue, before the write —
    // checking it outside (e.g. in the caller only) would leave a gap
    // between the check and the actual write landing on the queue.
    expect(queueSyncIdx).toBeLessThan(guardIdx);
    expect(guardIdx).toBeLessThan(beginIdx);
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

  test('registerMountedFileProviderDomain bumps the generation counter right after successfully adding the domain', () => {
    const body = bracedBody(
      swift,
      'private func registerMountedFileProviderDomain(\n  defaults: UserDefaults?,\n  forceReset: Bool = false\n) async throws -> [String: Any] {',
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
    const after = body.slice(staleCheckIdx, staleCheckIdx + 1200);
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
