// @ts-nocheck
/**
 * Task 1667 — structural guards on the native wiring around the camera-roll
 * backup manifest. The SQL behaviour itself is tested for real (swiftc +
 * SQLite) in scripts/swift-tests/backup-manifest-store-test.swift; what the
 * compiler cannot check is that the engine and the module CALL it in the
 * right places and order:
 *
 *   1. sign-out: `purgePlaintextStorage` empties the manifest through the
 *      engine's handle (`prepareForStoragePurge`) BEFORE the registry purge,
 *      and passes the kept files to it; `prepareForStoragePurge` stops and
 *      unbinds the engine first (a bound engine would re-upload into the
 *      emptied manifest), clears the Backups folder id (1962 Bug 4), and closes
 *      its own handle when the reset fails.
 *   2. ownership: `bindAccount` claims the manifest BEFORE its same-account
 *      early return; every completed upload records its account.
 *   3. rebuild: no batch reads pending uploads before
 *      `ensureManifestReadyForUploads`; every completed upload is marked on the
 *      server; the scan rebuilds and catches up on marks.
 *   4. JS hands the canonical device id to native before enable/trigger.
 */
import { describe, expect, test } from 'bun:test';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

const IOS = join(import.meta.dir, '../../modules/beebeeb-crypto/ios');
const engine = readFileSync(join(IOS, 'NativeBackupEngine.swift'), 'utf8');
const moduleSwift = readFileSync(join(IOS, 'BeebeebCryptoModule.swift'), 'utf8');
const gateSwift = readFileSync(join(IOS, 'ManifestRebuildGate.swift'), 'utf8');
const handleSwift = readFileSync(join(IOS, 'BackupManifestHandle.swift'), 'utf8');
// Round 8: the async producers' manifest writes, behind the write fence.
const fenceSwift = readFileSync(join(IOS, 'ManifestWriteFence.swift'), 'utf8');
const READY_SIG = 'func ensureManifestReadyForUploads(\n    accountId: String, authToken: String, baseURL: String, ticket: ManifestWriteFence.Ticket\n  ) async -> Bool {';
const backupContext = readFileSync(join(import.meta.dir, 'backup-context.tsx'), 'utf8');

/** Strip `//` comments so prose that names a call never counts as the call. */
function code(s: string): string {
  return s.replace(/\/\/[^\n]*/g, '');
}

/** The `{ ... }` body that follows `signature` (brace matched). */
function body(src: string, signature: string): string {
  const at = src.indexOf(signature);
  if (at < 0) throw new Error(`signature not found: ${signature}`);
  const open = src.indexOf('{', at);
  let depth = 0;
  for (let i = open; i < src.length; i += 1) {
    if (src[i] === '{') depth += 1;
    else if (src[i] === '}') {
      depth -= 1;
      if (depth === 0) return code(src.slice(open + 1, i));
    }
  }
  throw new Error(`unbalanced: ${signature}`);
}

function order(src: string, ...needles: string[]): number[] {
  return needles.map((n) => src.indexOf(n));
}

describe('1. sign-out empties the manifest in place, before the registry purge', () => {
  const purge = body(moduleSwift, 'AsyncFunction("purgePlaintextStorage") { (mode: String?, deletedAccountIds: [String]?) -> [String: Int] in');

  test('prepareForStoragePurge runs before purgeAll, and purgeAll keeps what it returned', () => {
    const [prep, purgeAll] = order(
      purge,
      'let manifest = NativeBackupEngine.shared.prepareForStoragePurge(',
      'PlaintextStorageProtection.purgeAll(pendingNonce: pendingNonce, preserving: manifest.kept)',
    );
    expect(prep).toBeGreaterThan(-1);
    expect(purgeAll).toBeGreaterThan(prep);
  });

  test('round 2: the purge result tells JS when the in-place reset failed', () => {
    expect(purge).toMatch(/"backupManifestResetFailed": manifest\.resetFailed \? 1 : 0/);
  });

  const prep = body(engine, 'func prepareForStoragePurge(\n    mode: ManifestPurgeMode = .signOut,\n    deletedAccountIds: Set<String> = []\n  ) -> (kept: Set<String>, resetFailed: Bool) {');

  test('the engine is stopped and unbound BEFORE the manifest is emptied', () => {
    const [stop, unbind, reset] = order(prep, 'stop()', 'clearAccountAndPurgeStaged()', 'manifestHandle.resetForSignOut(\n        outgoingAccountId: outgoing.accountId, outgoingInferred: outgoing.inferred,\n        mode: mode, deletedAccountIds: deletedAccountIds\n      )');
    expect(stop).toBeGreaterThan(-1);
    expect(unbind).toBeGreaterThan(stop);
    expect(reset).toBeGreaterThan(unbind);
  });

  test('the Backups folder id does not outlive the account (1962 Bug 4)', () => {
    expect(prep).toMatch(/parentFolderId = nil/);
  });

  // lazy: a missing signature is a failing test, not an error that hides the whole section
  const resetForSignOut = () => body(handleSwift, 'func resetForSignOut(\n    outgoingAccountId: String?,\n    outgoingInferred: Bool = false,\n    mode: ManifestPurgeMode = .signOut,\n    deletedAccountIds: Set<String> = []\n  ) -> Bool {');

  test('round 2: the outgoing account (captured before unbind) adopts pre-column rows before the reset', () => {
    const [capture, unbind, reset] = order(
      prep,
      // Round 13 (review item 3): bound, or only remembered (inferred).
      'let outgoing = outgoingAccountForReset()',
      'clearAccountAndPurgeStaged()',
      'manifestHandle.resetForSignOut(\n        outgoingAccountId: outgoing.accountId, outgoingInferred: outgoing.inferred,\n        mode: mode, deletedAccountIds: deletedAccountIds\n      )',
    );
    expect(capture).toBeGreaterThan(-1);
    expect(unbind).toBeGreaterThan(capture);
    expect(reset).toBeGreaterThan(unbind);
    // round 6: the adopt + reset live in BackupManifestHandle.resetForSignOut, in that order.
    const [adopt, inPlace] = order(
      resetForSignOut(),
      'BackupManifestStore.adoptUnowned(db, accountId: adoptAccountId)',
      'BackupManifestStore.resetInPlace(db',
    );
    expect(adopt).toBeGreaterThan(-1);
    expect(inPlace).toBeGreaterThan(adopt);
  });

  test('a failed reset closes the engine handle and flags it, but NEVER drops the file from `kept` (the JS handle is still open on it)', () => {
    // Round 8: the reset's block also reads the fence generation it advanced.
    // Round 9: and the purge mode, and whether it discards every kept mark.
    // Round 13 (review item 3): the outgoing account and whether it is only remembered.
    expect(prep).toMatch(/dbQueue\.sync \{\s*let ok = manifestHandle\.resetForSignOut\(\s*outgoingAccountId: outgoing\.accountId, outgoingInferred: outgoing\.inferred,\s*mode: mode, deletedAccountIds: deletedAccountIds\s*\)\s*return \(ok, manifestHandle\.writeFence\.generation, manifestHandle\.activeDiscard\.all\)\s*\}/);
    // Round 7: the close goes through `close(_:)` (checked sqlite3_close).
    expect(resetForSignOut()).toMatch(/BackupManifestStore\.resetInPlace\(db[\s\S]*close\(db\)\s*self\.db = nil\s*\}\s*pendingReset\.set\(true\)\s*if !discard\.isEmpty \{ recordDiscardPending\(\) \}\s*awaitingPurgeFinish = true\s*return false/);
    expect(prep).not.toMatch(/return \[\]/);
    expect(prep).toMatch(/return \(kept, !resetOK\)/);
  });

  test('the kept paths are the database and its WAL sidecars', () => {
    expect(prep).toMatch(/let kept: Set<String> = \[dbPath, dbPath \+ "-wal", dbPath \+ "-shm"\]/);
  });

  test('round 6: finish closes the handle BEFORE recovering, and REOPENS it after a successful recovery, in one dbQueue step', () => {
    const fin = body(engine, 'func finishStoragePurgeAfterFailedReset(allowUnlink: Bool) -> BackupManifestHandle.FinishResult {');
    expect(fin).toMatch(/dbQueue\.sync \{\s*manifestHandle\.finishAfterFailedReset\(allowUnlink: allowUnlink\)\s*\}/);
    const handleFin = body(handleSwift, 'func finishAfterFailedReset(allowUnlink: Bool) -> FinishResult {');
    const [close, recover, okGuard, clear, reopen] = order(
      handleFin,
      'close(db)',
      'BackupManifestStore.recoverAfterFailedReset(',
      'guard recovered.ok else {',
      'pendingReset.set(false)',
      'let failure = openIfClosed()',
    );
    expect(close).toBeGreaterThan(-1);
    expect(recover).toBeGreaterThan(close);
    expect(okGuard).toBeGreaterThan(recover);
    expect(clear).toBeGreaterThan(okGuard);
    expect(reopen).toBeGreaterThan(clear);
    expect(handleFin).toMatch(/reopened: failure == nil/);
    const fn = body(moduleSwift, 'AsyncFunction("finishBackupManifestPurge") { (allowUnlink: Bool) -> [String: Int] in');
    expect(fn).toMatch(/finishStoragePurgeAfterFailedReset\(allowUnlink: allowUnlink\)/);
    expect(fn).toMatch(/"reopened": r\.reopened \? 1 : 0/);
  });

  test('a reset still pending is applied on EVERY open, after the schema, and an open that cannot apply it keeps no handle', () => {
    const open = body(handleSwift, 'func openIfClosed() -> OpenFailure? {');
    // Round 12 (review item 4): a deferred recovery's outgoing account adopts
    // its pre-column rows first; either failure closes and keeps no handle.
    const [schema, check, pendingGet, adopt, retry, close, assign] = order(
      open,
      'prepareSchema(opened)',
      'BackupManifestStore.tableExistsChecked(opened, "backup_assets") == true',
      'var appliedPendingReset = false\n    if pendingReset.get() {',
      'if let adoptAccountId = recoveryAccountId, BackupManifestStore.adoptUnowned(opened, accountId: adoptAccountId) == nil {\n        close(opened)\n        return .pendingResetFailed',
      'BackupManifestStore.resetInPlace(opened, nowMs: now(), discard: activeDiscard)',
      'discard: activeDiscard) else {\n        close(opened)\n        return .pendingResetFailed',
      'db = opened',
    );
    expect(schema).toBeGreaterThan(-1);
    expect(check).toBeGreaterThan(schema);
    expect(pendingGet).toBeGreaterThan(check);
    expect(adopt).toBeGreaterThan(pendingGet);
    expect(retry).toBeGreaterThan(adopt);
    expect(close).toBeGreaterThan(retry);
    expect(assign).toBeGreaterThan(close);
    expect(open).toMatch(/if awaitingPurgeFinish \{ return \.purgeInFlight \}/);
    // Round 10 (review finding 5): while JS may hold the file, a pending
    // reset is not applied (no open, no checkpoint, no close), BEFORE the open.
    const [deferred, sqlOpen] = order(
      open,
      'if peerMayHoldFile, pendingReset.get() { return .pendingResetDeferred }',
      'sqlite3_open_v2(path, &handle, Self.openFlags, nil)',
    );
    expect(deferred).toBeGreaterThan(-1);
    expect(sqlOpen).toBeGreaterThan(deferred);
    // A connection that opened the file is parked, not closed, while JS may
    // hold it; the only closes left are the failed open (no fd on the file)
    // and the pending-reset failures (adoption, round 12, or the reset; only
    // reached with no JS connection open).
    expect(open).toMatch(/closeOrPark\(opened, \.unreadable\)/);
    expect(open).toMatch(/if let handle \{ close\(handle\) \}\s*return \.openFailed/);
    expect(open).toMatch(/close\(opened\)\s*return \.pendingResetFailed/);
    expect((open.match(/\bclose\(/g) ?? []).length).toBe(3);
    expect((open.match(/close\(opened\)\s*return \.pendingResetFailed/g) ?? []).length).toBe(2);
    expect(open).toMatch(/if peerMayHoldFile, let parked = parkedConnections\.popLast\(\) \{\s*opened = parked/);
  });

  test('round 10: closeOrPark parks while JS may hold the file; parked connections close only on JS\'s confirmed close', () => {
    const park = body(handleSwift, 'private func closeOrPark(_ connection: OpaquePointer, _ failure: OpenFailure) {');
    expect(park).toMatch(/if peerMayHoldFile \{\s*parkedConnections\.append\(connection\)/);
    const confirmed = body(handleSwift, 'func peerConfirmedClosed() {');
    expect(confirmed).toMatch(/peerMayHoldFile = false/);
    expect(confirmed).toMatch(/for connection in parked \{ close\(connection\) \}/);
    // Only two callers confirm JS closed: the JS gate (prior handles closed) and the purge's finish with allowUnlink.
    expect((code(handleSwift).match(/peerConfirmedClosed\(\)/g) ?? []).length).toBe(3);
    // Round 12 (review item 4): only past the allowUnlink guard.
    expect(body(handleSwift, 'func finishAfterFailedReset(allowUnlink: Bool) -> FinishResult {')).toMatch(/guard allowUnlink else \{[\s\S]*?\}[\s\S]*peerConfirmedClosed\(\)/);
    const gate = body(handleSwift, 'func admitPeerOpen(priorPeerHandlesClosed: Bool) -> PeerOpenGate {');
    const [confirm, openCall, pending, admit] = order(
      gate,
      'if priorPeerHandlesClosed {\n      peerConfirmedClosed()',
      'let failure = openIfClosed()',
      'if pendingReset.get() {\n      return PeerOpenGate(admitted: false',
      'peerMayHoldFile = true\n    return PeerOpenGate(admitted: true',
    );
    expect(confirm).toBeGreaterThan(-1);
    expect(openCall).toBeGreaterThan(confirm);
    expect(pending).toBeGreaterThan(openCall);
    expect(admit).toBeGreaterThan(pending);
  });

  test('round 10: the module exposes the JS-open gate and JS opens the manifest only through it', () => {
    const fn = body(moduleSwift, 'AsyncFunction("admitBackupManifestJsOpen") { (priorHandlesClosed: Bool) -> [String: Any] in');
    expect(fn).toMatch(/NativeBackupEngine\.shared\.admitJsManifestOpen\(priorHandlesClosed: priorHandlesClosed\)/);
    expect(fn).toMatch(/"ok": gate\.admitted \? 1 : 0/);
    expect(body(engine, 'func admitJsManifestOpen(priorHandlesClosed: Bool) -> BackupManifestHandle.PeerOpenGate {'))
      .toMatch(/dbQueue\.sync \{\s*manifestHandle\.admitPeerOpen\(priorPeerHandlesClosed: priorHandlesClosed\)/);
    const db = readFileSync(join(import.meta.dir, '../services/BackupDatabase.ts'), 'utf8');
    const open = body(db, 'async function openAndMigrate(): Promise<SQLite.SQLiteDatabase> {');
    const [gate, sqlOpen] = order(open, 'await admitJsOpen();', 'SQLite.openDatabaseAsync(DB_NAME)');
    expect(gate).toBeGreaterThan(-1);
    expect(sqlOpen).toBeGreaterThan(gate);
    // The only open in the module.
    expect((code(db).match(/openDatabaseAsync\(/g) ?? []).length).toBe(1);
    const admit = body(db, 'async function admitJsOpen(): Promise<void> {');
    expect(admit).toMatch(/if \(!gate\) throw new BackupManifestNotReadyError\('no_gate'\)/);
    expect(admit).toMatch(/await gate\(unclosedHandles\.size === 0\)/);
    expect(admit).toMatch(/if \(verdict\.ok !== 1\) throw new BackupManifestNotReadyError/);
    // Registered at load by account-cleanup (App.tsx imports it at the top).
    const cleanup = readFileSync(join(import.meta.dir, 'account-cleanup.ts'), 'utf8');
    expect(code(cleanup)).toMatch(/\nregisterBackupManifestJsOpenGate\(NativeCrypto\.admitBackupManifestJsOpen\);/);
    const app = readFileSync(join(import.meta.dir, '../App.tsx'), 'utf8');
    expect(app).toMatch(/from '\.\/lib\/account-cleanup'/);
  });
});

describe('round 2: kept pending marks + sign-out flush', () => {
  test('the rebuild gate applies kept marks AFTER the server map, and on the ready fast paths', () => {
    const gate = body(gateSwift, 'static func run(alreadyReady: Bool, steps: Steps) async -> Outcome {');
    const apply = gate.indexOf('steps.applyMap(map)');
    expect(apply).toBeGreaterThan(-1);
    expect(gate.lastIndexOf('steps.applyKept()')).toBeGreaterThan(apply);
    // Rebuild path + fast path (already ready, or nothing to rebuild).
    expect((gate.match(/steps\.applyKept\(\)/g) ?? []).length).toBe(2);
    const ready = body(engine, READY_SIG);
    expect(ready).toMatch(/await ManifestRebuildGate\.run\(alreadyReady: manifestReadyForAccount == accountId, steps: steps\)/);
    expect(ready).toMatch(/applyKept: \{ \[weak self\] in self\?\.applyKeptPendingMarks\(accountId: accountId, ticket: ticket\) \}/);
  });

  test('the sign-out flush has no row cap and is bounded by time', () => {
    const flush = body(engine, 'func flushServerMarksForSignOut(');
    // Round 8: the load moved behind the fence (FencedManifestWrites.loadSignOutMarks).
    expect(flush).toMatch(/FencedManifestWrites\.loadSignOutMarks\(/);
    expect(body(fenceSwift, 'static func loadSignOutMarks(')).toMatch(/pendingServerMarks\(db, accountId: accountId, limit: Int\(Int32\.max\)\)/);
  });

  test('round 3: the WHOLE sign-out flush (row load included) runs under the hard deadline', () => {
    const sig = engine.slice(engine.indexOf('func flushServerMarksForSignOut('));
    expect(sig.slice(0, sig.indexOf('{'))).toMatch(/deadline: TimeInterval = SignOutMarkFlush\.defaultDeadline/);
    const flush = body(engine, 'func flushServerMarksForSignOut(');
    const run = flush.indexOf('SignOutMarkFlush.run(');
    expect(run).toBeGreaterThan(-1);
    // The row load and every mark happen inside run(...), not before it.
    expect(flush.indexOf('FencedManifestWrites.loadSignOutMarks(')).toBeGreaterThan(run);
    expect(flush.indexOf('markOnServer(')).toBeGreaterThan(run);
    expect(flush).toMatch(/deadline: deadline/);
    // Each request gets the budget that is left.
    expect(flush).toMatch(/requestTimeout: requestTimeout/);
    expect(flush).not.toMatch(/stopAt/);
  });

  test('round 3: markOnServer applies the request timeout it is handed', () => {
    const sig = engine.slice(engine.indexOf('func markOnServer('));
    expect(sig.slice(0, sig.indexOf('{'))).toMatch(/requestTimeout: TimeInterval\? = nil/);
    const mark = body(engine, 'func markOnServer(');
    const [apply, send] = order(mark, 'request.timeoutInterval = requestTimeout', 'metadataSession.data(for: request)');
    expect(apply).toBeGreaterThan(-1);
    expect(send).toBeGreaterThan(apply);
  });

  test('App signOut flushes marks BEFORE logout() revokes the session', () => {
    const app = code(readFileSync(join(import.meta.dir, '../App.tsx'), 'utf8'));
    const signOut = app.slice(app.indexOf('const runSignOut = useCallback(async () => {'));
    const [flush, logout] = order(signOut, 'BeebeebCrypto.flushBackupServerMarksForSignOut()', 'await logout();');
    expect(flush).toBeGreaterThan(-1);
    expect(logout).toBeGreaterThan(flush);
  });

  test('round 3: App signOut waits for the native flush through the JS-side bound', () => {
    const app = code(readFileSync(join(import.meta.dir, '../App.tsx'), 'utf8'));
    expect(app).toMatch(/import \{[^}]*\bflushMarksBeforeSignOut\b[^}]*\} from '\.\/lib\/sign-out-mark-flush'/);
    const signOut = app.slice(app.indexOf('const runSignOut = useCallback(async () => {'));
    const [bounded, native, logout] = order(
      signOut,
      'await flushMarksBeforeSignOut(',
      'BeebeebCrypto.flushBackupServerMarksForSignOut()',
      'await logout();',
    );
    expect(bounded).toBeGreaterThan(-1);
    expect(native).toBeGreaterThan(bounded);
    expect(logout).toBeGreaterThan(native);
    // Never awaited raw: a native promise that never settles would hold sign-out.
    expect(signOut.slice(0, logout)).not.toMatch(/await BeebeebCrypto\.flushBackupServerMarksForSignOut\(/);
  });

  test('round 4: AuthContext signOut is single-flight (a second tap joins the running sign-out)', () => {
    const app = code(readFileSync(join(import.meta.dir, '../App.tsx'), 'utf8'));
    expect(app).toMatch(/import \{ singleFlight \} from '\.\/lib\/single-flight'/);
    expect(app).toMatch(/const signOut = useMemo\(\(\) => singleFlight\(runSignOut\), \[runSignOut\]\);/);
    const provider = app.slice(app.indexOf('<AuthContext.Provider value={{'));
    const value = provider.slice(0, provider.indexOf('}}'));
    expect(value).toMatch(/\bsignOut\b/);
    expect(value).not.toMatch(/runSignOut/);
    // Nothing else calls the raw run (it would bypass the join): definition,
    // the singleFlight wrap, and its dependency list.
    expect((app.match(/\brunSignOut\b/g) ?? []).length).toBe(3);
  });

  test('BackupDatabase calls only the four tracked methods on its handle', () => {
    const src = code(readFileSync(join(import.meta.dir, '../services/BackupDatabase.ts'), 'utf8'));
    const tracked = src.slice(src.indexOf('async function onHandle'));
    const calls = new Set([...tracked.matchAll(/\bdb\.([a-zA-Z]+)\(/g)].map((m) => m[1]));
    for (const c of calls) expect(['execAsync', 'runAsync', 'getFirstAsync', 'getAllAsync', 'closeAsync']).toContain(c);
    // closeAsync only in the purge close path (round 7: `closeWithRetry`,
    // used by the purge close and the failed-open cleanup).
    expect((src.match(/\bdb\.closeAsync\(/g) ?? []).length).toBe(1);
    expect(code(src.slice(src.indexOf('async function closeWithRetry'), src.indexOf('export function unclosedHandleCount')))).toMatch(/db\.closeAsync\(\)/);
  });
});

describe('2. rows carry the account that owns them', () => {
  test('bindAccount claims the manifest BEFORE its same-account early return', () => {
    const bind = body(engine, 'func bindAccount(userId: String) {');
    const [claim, guardSame] = order(bind, 'claimManifest(forAccount: userId)', 'guard currentAccountId != userId else { return }');
    expect(claim).toBeGreaterThan(-1);
    expect(guardSame).toBeGreaterThan(claim);
  });

  test('every completed upload records its account', () => {
    const calls = (code(engine).match(/markUploadComplete\(assetId:[^)]*\)/g) ?? []).filter((c) => !c.includes(': String'));
    expect(calls.length).toBe(2);
    for (const c of calls) expect(c).toMatch(/accountId: batchAccountId/);
    const fn = body(engine, 'private func markUploadComplete(assetId: String, remoteFileId: String, accountId: String) -> Bool {');
    expect(fn).toMatch(/return BackupManifestStore\.markUploaded\([\s\S]*accountId: accountId/);
  });
});

describe('3. an empty manifest is rebuilt before any upload; uploads are marked on the server', () => {
  test('processBatch gates on ensureManifestReadyForUploads before it reads pending uploads', () => {
    const batch = body(engine, 'func processBatch(limit: Int = 12, ticket callerTicket: ManifestWriteFence.Ticket? = nil) async throws -> Int {');
    const [gate, pending] = order(
      batch,
      'guard await ensureManifestReadyForUploads(accountId: batchAccountId, authToken: authToken, baseURL: baseURL, ticket: ticket) else {',
      'getPendingUploads(limit: limit)',
    );
    expect(gate).toBeGreaterThan(-1);
    expect(pending).toBeGreaterThan(gate);
  });

  test('round 4: every step of the rebuild path fails closed; the account is ready only on .ready', () => {
    // The gate: each step's failure returns .deferred before the next step.
    const gate = body(gateSwift, 'static func run(alreadyReady: Bool, steps: Steps) async -> Outcome {');
    const seq = order(
      gate,
      'guard let needsRebuild = steps.needsRebuild() else { return .deferred(.checkFailed) }',
      'guard steps.hasDeviceId() else { return .deferred(.noDeviceId) }',
      'map = try await steps.fetchMap()',
      'return .deferred(.fetchFailed)',
      'guard steps.isStillCurrent() else { return .deferred(.accountChanged) }',
      'guard let promoted = steps.applyMap(map) else { return .deferred(.applyMapFailed) }',
      'guard let kept = steps.applyKept() else { return .deferred(.applyKeptFailed) }',
    );
    expect(seq[0]).toBeGreaterThan(-1);
    for (let i = 1; i < seq.length; i += 1) expect(seq[i]).toBeGreaterThan(seq[i - 1]);

    // The engine: ready (and `return true`) only in the .ready branch.
    const ready = body(engine, READY_SIG);
    const [readyCase, deferredCase] = order(ready, 'case let .ready(', 'case let .deferred(reason):');
    expect(readyCase).toBeGreaterThan(-1);
    expect(deferredCase).toBeGreaterThan(readyCase);
    const marks = [...ready.matchAll(/manifestReadyForAccount = accountId/g)].map((m) => m.index ?? -1);
    expect(marks.length).toBe(1);
    expect(marks[0]).toBeGreaterThan(readyCase);
    expect(marks[0]).toBeLessThan(deferredCase);
    expect((ready.match(/return true/g) ?? []).length).toBe(1);
    expect(ready.indexOf('return true')).toBeLessThan(deferredCase);
    expect(ready.slice(deferredCase)).toMatch(/return false\s*\}\s*$/);
    // A deferral pauses uploads behind the gate's bounded backoff.
    expect(ready.slice(deferredCase)).toMatch(/ManifestRebuildGate\.backoff\(for: reason, consecutiveFailures: failures\)/);
    // Round 15 (review item 2): the deferral never shortens a 429's Retry-After.
    expect(ready.slice(deferredCase)).toMatch(/backoffUntil = ManifestRebuildGate\.backoffDeadline\(existing: backoffUntil, now: Date\(\), wait: wait\)/);

    // The steps report failure as nil, never as 0 / "nothing there".
    // Round 8: the step bodies moved behind the fence (FencedManifestWrites).
    expect(ready).toMatch(/needsRebuild: \{ \[weak self\] in[\s\S]*?FencedManifestWrites\.needsRebuild\(/);
    expect(ready).toMatch(/applyMap: \{ \[weak self\] map in[\s\S]*?FencedManifestWrites\.applyServerMap\(/);
    const needs = body(fenceSwift, 'static func needsRebuild(');
    expect(needs).toMatch(/guard BackupManifestStore\.claim\(db, accountId: accountId, nowMs: nowMs\) != nil else \{ return nil \}/);
    expect(needs).toMatch(/guard let needs = BackupManifestStore\.needsServerRebuild\(db, accountId: accountId\) else \{ return nil \}/);
    expect(body(fenceSwift, 'static func applyServerMap(')).toMatch(/guard let db else \{ return nil \}\s*return BackupManifestStore\.applyServerMap\(/);
    const stepsSrc = ready.slice(0, ready.indexOf('let outcome = await ManifestRebuildGate.run('));
    expect(stepsSrc.length).toBeGreaterThan(0);
    expect(stepsSrc).not.toMatch(/\?\? 0/);
    expect(ready).toMatch(/guard let self, let deviceId = self\.backupDeviceId, !deviceId\.isEmpty else \{\s*throw/);
    const kept = body(engine, 'func applyKeptPendingMarks(accountId: String, ticket: ManifestWriteFence.Ticket) -> Int? {');
    expect(kept).toMatch(/FencedManifestWrites\.applyKept\(/);
    expect(kept).not.toMatch(/\?\? 0/);
    expect(body(fenceSwift, 'static func applyKept(')).toMatch(/guard let db else \{ return nil \}\s*return BackupManifestStore\.applyPendingMarks\(/);
  });

  test('both upload completions are followed by a server mark', () => {
    const src = code(engine);
    const completions = [...src.matchAll(/markUploadComplete\(assetId: asset\.localAssetId/g)].map((m) => m.index ?? -1);
    expect(completions.length).toBe(2);
    for (const at of completions) {
      const next = src.indexOf('await markOnServer(', at);
      const nextCompletion = src.indexOf('markUploadComplete(assetId:', at + 1);
      expect(next).toBeGreaterThan(at);
      if (nextCompletion > -1) expect(next).toBeLessThan(nextCompletion);
    }
  });

  test('the scan rebuilds and catches up on server marks', () => {
    const scan = body(engine, 'func scanPhotoLibraryForPendingUploads(reason: String, ticket callerTicket: ManifestWriteFence.Ticket? = nil) async -> Bool {');
    const [rebuild, flush] = order(scan, 'await ensureManifestReadyForUploads(', 'await flushServerMarks(');
    expect(rebuild).toBeGreaterThan(-1);
    expect(flush).toBeGreaterThan(rebuild);
  });

  test('the map calls send the device id the server keys photo_backup_state by', () => {
    const fetch = body(engine, 'private func fetchServerIdentifierMap(');
    const mark = body(engine, 'func markOnServer(');
    expect(mark).toMatch(/setValue\(deviceId, forHTTPHeaderField: "X-Beebeeb-Device-Id"\)/);
    expect(mark).toMatch(/\/api\/v1\/files\/photo-backup\/mark/);
    // Round 10: the identifiers GET (and /check, /files/index) go through PhotoBackupServerClient.
    expect(fetch).toMatch(/photoBackupServerClient\(authToken: authToken, baseURL: baseURL, accountId: accountId, deviceId: deviceId\)/);
    expect(fetch).toMatch(/try await client\.identifierMap\(\)/);
    const client = readFileSync(join(IOS, 'PhotoBackupServerClient.swift'), 'utf8');
    expect(body(client, 'private func request(_ path: String, method: String) throws -> URLRequest {'))
      .toMatch(/setValue\(deviceId, forHTTPHeaderField: "X-Beebeeb-Device-Id"\)/);
    expect(client).toMatch(/"\/api\/v1\/files\/photo-backup\/identifiers"/);
    expect(client).toMatch(/"\/api\/v1\/files\/photo-backup\/check"/);
  });
});

describe('4. JS hands the canonical device id to native first', () => {
  test('mirrorBackupSessionForNative syncs the device id before anything else', () => {
    const fn = body(backupContext, 'async function mirrorBackupSessionForNative(): Promise<void> {');
    const [sync, register] = order(fn, 'await syncBackupDeviceIdToNative();', 'registerDevice()');
    expect(sync).toBeGreaterThan(-1);
    expect(register).toBeGreaterThan(sync);
  });

  test('both native enable paths go through mirrorBackupSessionForNative first', () => {
    const src = code(backupContext);
    for (const call of ['await enablePhotoBackup(token, userId);', 'await triggerImmediateBackup(token, userId);']) {
      const at = src.indexOf(call);
      expect(at).toBeGreaterThan(-1);
      const mirror = src.lastIndexOf('await mirrorBackupSessionForNative();', at);
      expect(mirror).toBeGreaterThan(-1);
      expect(at - mirror).toBeLessThan(200);
    }
  });
});

describe('5. round 5: route 404s and the kept-marks expiry', () => {
  test('an identifiers 404 is a failed fetch: no 404 special case, the shipped classifier decides', () => {
    const fetch = body(engine, 'private func fetchServerIdentifierMap(');
    expect(fetch).not.toMatch(/404/);
    expect(fetch).not.toMatch(/return \[:\]/);
    // Round 10: through PhotoBackupServerClient, whose answer is the shipped classifier's.
    expect(fetch).toMatch(/return try await client\.identifierMap\(\)/);
    const client = readFileSync(join(IOS, 'PhotoBackupServerClient.swift'), 'utf8');
    const map = body(client, 'func identifierMap() async throws -> [String: String] {');
    expect(map).not.toMatch(/404/);
    expect(map).toMatch(/return try PhotoBackupServerResponses\.identifierMap\(statusCode: status, data: data\)\s*$/);
    // The "server without the route" compatibility path is gone, prose included.
    expect(engine).not.toMatch(/server without the route/);
  });

  test('a mark is recorded only when the shipped classifier says so (2xx, or 404 with the API NotFound body)', () => {
    const mark = body(engine, 'func markOnServer(');
    expect(mark).not.toMatch(/statusCode == 404/);
    expect(mark).toMatch(/PhotoBackupServerResponses\.markOutcome\(/);
    expect(mark).toMatch(/contentType: http\?\.value\(forHTTPHeaderField: "Content-Type"\)/);
    // Round 8: the record runs behind the fence (FencedManifestWrites.recordServerMarked).
    const [guard, record] = order(mark, 'guard outcome.recordsServerMark else {', 'FencedManifestWrites.recordServerMarked(');
    expect(guard).toBeGreaterThan(-1);
    expect(record).toBeGreaterThan(guard);
    expect((mark.match(/recordServerMarked\(/g) ?? []).length).toBe(1);
  });

  test('every sign-in expires kept marks, whatever the signed-in account holds', () => {
    const confirm = body(moduleSwift, 'AsyncFunction("confirmMasterKeyHandle") { [self] (handleId: Int, ownerId: String?) throws -> Bool in');
    expect(confirm).toMatch(/NativeBackupEngine\.shared\.expireKeptPendingMarks\(trigger: "sign_in"\)/);
    const bind = body(engine, 'func bindAccount(userId: String) {');
    const [expire, early] = order(bind, 'expireKeptPendingMarks(trigger: "bind")', 'guard currentAccountId != userId else { return }');
    expect(expire).toBeGreaterThan(-1);
    expect(early).toBeGreaterThan(expire);
  });

  test('the expiry is its own step: no account count or promote result gates it', () => {
    const fn = body(engine, 'func expireKeptPendingMarks(trigger: String) -> Int? {');
    expect(fn).toMatch(/BackupManifestStore\.expirePendingMarks\(db, nowMs: self\.nowMs\(\)\)/);
    expect(fn).not.toMatch(/accountId|applyPendingMarks|pendingMarkCount/);
  });
});

describe('6. round 6: the native manifest handle is reopened, and nothing runs without it', () => {
  // Round 11: start()'s body is startLocked(), run inside lifecycle.userStart.
  const start = () => body(engine, '  private func startLocked(prepared: PreparedStartKey?) -> BackupEngineLifecycle.StartStep {');
  const ensureForStart = () => body(engine, 'private func ensureManifestOpenForStart(accountId: String) -> Bool {');

  test('start() checks the manifest after the account guard and BEFORE both the running branch and isRunning = true', () => {
    const [accountGuard, ensure, runningBranch, setRunning] = order(
      start(),
      'guard let accountId = currentAccountId, !accountId.isEmpty else {',
      // Round 13 (review item 4): the refusal also keeps a read key for the retry.
      'guard ensureManifestOpenForStart(accountId: accountId) else {',
      'if isRunning {',
      'isRunning = true',
    );
    expect(accountGuard).toBeGreaterThan(-1);
    expect(ensure).toBeGreaterThan(accountGuard);
    expect(runningBranch).toBeGreaterThan(ensure);
    expect(setRunning).toBeGreaterThan(runningBranch);
  });

  test('a failed open stops a running engine, publishes the reason and schedules a retry; it never proceeds', () => {
    const [open, stop, record, retry, surface, refuse] = order(
      ensureForStart(),
      'dbQueue.sync { openManifestIfClosed(trigger: "start") }',
      'lifecycle.internalStop { stopLocked() }',
      'switch recordManifestOpen(failure) {',
      'scheduleManifestOpenRetry(accountId: accountId, after: retryAfter)',
      'updateBackupStatusSurfaces(reason: reason)',
      'return false',
    );
    expect(open).toBeGreaterThan(-1);
    expect(stop).toBeGreaterThan(open);
    expect(record).toBeGreaterThan(stop);
    expect(retry).toBeGreaterThan(record);
    expect(surface).toBeGreaterThan(retry);
    expect(refuse).toBeGreaterThan(surface);
    expect(ensureForStart()).toMatch(/case \.proceed:\s*cancelManifestOpenRetry\(\)\s*return true/);
  });

  test('the retry re-runs start() for the same account only; start() proceeding cancels it, a background open does not', () => {
    const retry = body(engine, 'private func scheduleManifestOpenRetry(accountId: String, after delay: TimeInterval) {');
    // Round 11 (review finding 3): the retry runs start()'s body inside
    // lifecycle.runRetry (one transition with the intent + token check).
    expect(retry).toMatch(/let token = lifecycle\.scheduleRetry\(\)/);
    // Round 12 (review item 8): with the key prepared outside the lock.
    expect(retry).toMatch(/self\.lifecycle\.runRetry\(token, prepare: \{ self\.prepareStartMasterKey\(\) \}\) \{ prepared in\s*guard self\.currentAccountId == accountId else \{ return \.done \}/);
    expect(retry).toMatch(/return self\.startLocked\(prepared: prepared\)/);
    expect(retry).not.toMatch(/self\.start\(\)/);
    expect(retry).toMatch(/_manifestOpenRetry\?\.cancel\(\)/);
    expect(ensureForStart()).toMatch(/case \.proceed:\s*cancelManifestOpenRetry\(\)\s*return true/);
    // the background task records its open but must not cancel the start() still owed to JS
    const record = body(engine, 'private func recordManifestOpen(_ failure: BackupManifestHandle.OpenFailure?) -> ManifestAvailability.Decision {');
    expect(record).not.toMatch(/cancel/);
  });

  test('the background task opens the manifest itself, and refuses without one BEFORE it touches staged assets or isRunning', () => {
    const bg = body(engine, 'private func handleBackgroundTask(_ task: BGProcessingTask) {');
    const [open, refuse, purge, setRunning] = order(
      bg,
      'self.dbQueue.sync { self.openManifestIfClosed(trigger: "background_task") }',
      'self.completeBackgroundTaskOnce(task, success: false)\n        return\n      }\n      self.dbQueue.sync { self.purgeMismatchedStagedAssets',
      'self.dbQueue.sync { self.purgeMismatchedStagedAssets(currentAccountId: accountId) }',
      'self.isRunning = true',
    );
    expect(open).toBeGreaterThan(-1);
    expect(refuse).toBeGreaterThan(open);
    expect(purge).toBeGreaterThan(refuse);
    expect(setRunning).toBeGreaterThan(purge);
    expect(bg).toMatch(/if case \.refuse\(let reason, _\) = self\.recordManifestOpen\(manifestFailure\)/);
  });

  test('stop() and sign-out clear the reason and cancel a pending retry (no restart after disablePhotoBackup)', () => {
    const stop = body(engine, '  private func stopLocked() {');
    const [clear, guardRunning] = order(stop, 'clearManifestAvailability()', 'guard isRunning else { return }');
    expect(clear).toBeGreaterThan(-1);
    expect(guardRunning).toBeGreaterThan(clear);
    const prep = body(engine, 'func prepareForStoragePurge(\n    mode: ManifestPurgeMode = .signOut,\n    deletedAccountIds: Set<String> = []\n  ) -> (kept: Set<String>, resetFailed: Bool) {');
    expect(prep).toMatch(/clearManifestAvailability\(\)/);
  });

  test('the reason is visible: progress dict, status state, manual trigger error, JS context and Settings', () => {
    expect(engine).toMatch(/"manifestUnavailableReason": manifestUnavailableStopReason \?\? NSNull\(\)/);
    const state = body(engine, 'private func backupState(pending: Int) -> (state: String, reason: String) {');
    // Round 13 (review item 6): the rules moved to BackupSurfaceState.decide.
    expect(state).toMatch(/manifestUnavailableReason: manifestUnavailableStopReason,/);
    const decide = body(readFileSync(join(IOS, 'BackupSurfaceState.swift'), 'utf8'), 'static func decide(_ i: Inputs) -> State {');
    expect(decide.indexOf('i.manifestUnavailableReason')).toBeGreaterThan(-1);
    expect(decide.indexOf('i.manifestUnavailableReason')).toBeLessThan(decide.indexOf('if i.isPaused'));
    const manual = body(engine, 'func triggerManualBackup(limit: Int = 50) async throws -> [String: Any] {');
    expect(manual).toMatch(/if manifestUnavailableStopReason != nil \{ throw BackupError\.databaseUnavailable \}/);
    expect(backupContext).toMatch(/setManifestUnavailableReason\(p\.manifestUnavailableReason \?\? null\)/);
    const settings = readFileSync(join(import.meta.dir, '../screens/SettingsScreen.tsx'), 'utf8');
    expect(settings).toMatch(/if \(manifestUnavailableReason\) return manifestUnavailableReason;/);
  });

  test('only BackupManifestHandle opens, closes or assigns the native handle (the engine has no other path to a nil db)', () => {
    const c = code(engine);
    expect(c).toMatch(/private var db: OpaquePointer\? \{ manifestHandle\.db \}/);
    expect(c.match(/sqlite3_open_v2\(/g) ?? []).toHaveLength(0);
    expect(c.match(/sqlite3_close(?:_v2)?\(/g) ?? []).toHaveLength(0);
    // (`db` is get-only, so the compiler refuses an assignment too; `let db = db` shadows are not assignments)
    expect(c.match(/(?<!(?:let|var)\s)(?<![\w.])(?:self\.)?db\s*=[^=]/g) ?? []).toHaveLength(0);
    const h = code(handleSwift);
    // the two places the handle can become nil: a failed sign-out reset (reopened by finish) and finish's own close
    expect(h.match(/self\.db = nil/g) ?? []).toHaveLength(2);
    expect(h.match(/(?<![\w.])db = opened/g) ?? []).toHaveLength(1);
  });
});

describe('7. round 7 sweep: nothing destructive runs on an unconfirmed precondition', () => {
  const storeSwift = readFileSync(join(IOS, 'BackupManifestStore.swift'), 'utf8');

  test('an upload the manifest did not record keeps its staged chunks and directory (both completion sites)', () => {
    const src = code(engine);
    const starts = [...src.matchAll(/let recorded: Bool = dbQueue\.sync \{/g)].map((m) => m.index);
    expect(starts.length).toBe(2);
    for (const at of starts) {
      const site = src.slice(at, src.indexOf('removeStagedDirectory(stagedDir: stagedDir, fileId: fileId)', at));
      // Round 8: the fence check comes first in the same block.
      expect(site.indexOf('guard admitsWrite(ticket, "markUploadComplete") else { return false }')).toBeGreaterThan(-1);
      expect(site.indexOf('guard admitsWrite(ticket, "markUploadComplete")')).toBeLessThan(site.indexOf('guard markUploadComplete('));
      const after = site.slice(site.indexOf('guard markUploadComplete('));
      const idx = order(
        after,
        'guard markUploadComplete(',
        'return false',
        'deleteStagedChunks(assetId: asset.localAssetId)',
        'guard recorded else {',
        'throw BackupError.databaseUnavailable',
      );
      expect(idx[0]).toBeGreaterThan(-1);
      for (let i = 1; i < idx.length; i += 1) expect(idx[i]).toBeGreaterThan(idx[i - 1]);
    }
    // No completion path deletes staged data on an unchecked record.
    expect(src).not.toMatch(/\n\s*markUploadComplete\(assetId:[^\n]*\n\s*deleteStagedChunks/);
  });

  test('a failed scan insert is recorded, and the rebuild does not run on a manifest it could not fill', () => {
    // Round 8: the insert is FencedManifestWrites.scanInsert; the engine
    // records its outcome in the same dbQueue block (recordScanInsert).
    const ins = body(fenceSwift, 'static func scanInsert(');
    // Round 12 (review item 10): the counting form; a failed insert is nil.
    expect(ins).toMatch(/let entered = BackupManifestStore\.insertScannedAssetsCounting\(db, assets, nowMs: nowMs\)\s*let inserted = entered != nil/);
    expect(ins).toMatch(/return \.written\(inserted: inserted, entered: entered \?\? 0\)/);
    // Round 10 (review finding 4): sticky; only a full scan's success clears it (ScanInsertHealth).
    const rec = body(engine, 'private func recordScanInsert(\n    _ written: FencedManifestWrites.ScanWrite, assets: Int, source: ScanInsertHealth.Source\n  ) {');
    expect(rec).toMatch(/case \.written\(let inserted, let entered\):\s*manifestHandle\.scanInsertHealth\.record\(inserted: inserted, source: source\)/);
    expect(body(engine, READY_SIG)).toMatch(/scanInsertFailed: self\.manifestHandle\.scanInsertHealth\.failed/);
    expect(code(engine)).not.toMatch(/lastScanInsertFailed/);
    const scan = body(engine, 'func scanPhotoLibraryForPendingUploads(reason: String, ticket callerTicket: ManifestWriteFence.Ticket? = nil) async -> Bool {');
    expect(scan).toMatch(/self\.recordScanInsert\(written, assets: scanned\.count, source: \.fullScan\)/);
    expect(body(engine, 'func photoLibraryDidChange(_ changeInstance: PHChange) {'))
      .toMatch(/self\.recordScanInsert\(written, assets: inserted\.count, source: \.incremental\)/);
    expect(code(engine).match(/recordScanInsert\(written/g)?.length).toBe(2);
    expect(body(fenceSwift, 'static func needsRebuild(')).toMatch(/if needs && scanInsertFailed \{ return nil \}\s*return needs/);
  });

  test('the reset reads backup_verification\'s existence (an error fails the reset) and checks secure_delete', () => {
    const reset = body(storeSwift, 'static func resetInPlace(');
    expect(reset).toMatch(/guard sqlite3_exec\(db, "PRAGMA secure_delete = ON", nil, nil, nil\) == SQLITE_OK else \{ return false \}/);
    expect(reset).toMatch(/guard let hasVerification = tableExistsChecked\(db, "backup_verification"\) else \{ return false \}/);
    expect(reset).not.toMatch(/tableExists\(db, "backup_verification"\)/);
  });

  test('the recovery never replaces a file it could not open, fully read or close', () => {
    const rec = body(storeSwift, 'static func recoverAfterFailedReset(');
    expect(rec).toMatch(/guard let db = openConnection\(path\) else \{ return \(false, false\) \}/);
    const [snap, closed, guardAll, replace] = order(
      rec,
      'pendingMarksSnapshot(db, nowMs: nowMs, discard: discard)',
      'let closed = closeConnection(db)',
      'guard allowUnlink, closed, let carried else { return (false, false) }',
      'return replaceFile(path: path, carrying: carried)',
    );
    expect(snap).toBeGreaterThan(-1);
    expect(closed).toBeGreaterThan(snap);
    expect(guardAll).toBeGreaterThan(closed);
    expect(replace).toBeGreaterThan(guardAll);
    expect((rec.match(/replaceFile\(/g) ?? []).length).toBe(1);
  });

  test('the handle closes only through the checked close, and an unconfirmed close forbids the unlink', () => {
    const src = code(handleSwift);
    const cls = src.slice(src.indexOf('final class BackupManifestHandle'), src.indexOf('struct ManifestAvailability'));
    expect(cls).not.toMatch(/sqlite3_close_v2\(/);
    expect(body(handleSwift, 'private func close(_ connection: OpaquePointer) {')).toMatch(/if !BackupManifestStore\.closeConnection\(connection\) \{\s*closeUnconfirmed = true\s*\}/);
    const fin = body(handleSwift, 'func finishAfterFailedReset(allowUnlink: Bool) -> FinishResult {');
    expect(fin).toMatch(/allowUnlink: allowUnlink && !closeUnconfirmed, adoptAccountId: recoveryAccountId/);
    const reset = body(handleSwift, 'func resetForSignOut(\n    outgoingAccountId: String?,\n    outgoingInferred: Bool = false,\n    mode: ManifestPurgeMode = .signOut,\n    deletedAccountIds: Set<String> = []\n  ) -> Bool {');
    expect(reset).toMatch(/adopted = BackupManifestStore\.adoptUnowned\(db, accountId: adoptAccountId\) != nil/);
    expect(reset).toMatch(/if adopted, BackupManifestStore\.resetInPlace\(db, nowMs: now\(\), discard: discard\) \{/);
  });

  test('a mark list that could not be read is traced, never read as "all marked"', () => {
    const flush = body(engine, 'func flushServerMarks(\n    accountId: String, authToken: String, baseURL: String, ticket: ManifestWriteFence.Ticket, limit: Int = 300\n  ) async {');
    expect(flush).toMatch(/guard let rows = loaded else \{\s*RuntimeTrace\.event\("backup\.native\.server_mark\.load_failed"/);
    const signOut = body(engine, 'func flushServerMarksForSignOut(');
    // Round 8: the load runs behind the fence; both failures are still traced.
    expect(signOut).toMatch(/if loaded\.adoptFailed \{\s*RuntimeTrace\.event/);
    expect(signOut).toMatch(/guard let rows = loaded\.rows else \{\s*RuntimeTrace\.event/);
    const load = body(fenceSwift, 'static func loadSignOutMarks(');
    expect(load).toMatch(/let adoptFailed = BackupManifestStore\.adoptUnowned\(db, accountId: accountId\) == nil/);
    expect(load).toMatch(/BackupManifestStore\.pendingServerMarks\(db, accountId: accountId, limit: Int\(Int32\.max\)\)/);
  });
});

describe('round 10 (review of mobile#182 at 060bfeb0): the server check is the dedupe guarantee', () => {
  const batch = body(engine, 'func processBatch(limit: Int = 12, ticket callerTicket: ManifestWriteFence.Ticket? = nil) async throws -> Int {');

  test('processBatch asks the server about the selected rows BEFORE any upload starts, and uploads nothing when it cannot', () => {
    const [select, check, deferred, group, upload] = order(
      batch,
      'let selected = dbQueue.sync { getPendingUploads(limit: limit) }',
      'guard let pending = await rowsCheckedAgainstServer(\n      selected, accountId: batchAccountId, authToken: authToken, baseURL: baseURL, ticket: ticket\n    ) else {\n      return 0\n    }',
      'return 0',
      'await withTaskGroup(of: Bool.self)',
      'self.uploadSingleAsset(',
    );
    expect(select).toBeGreaterThan(-1);
    expect(check).toBeGreaterThan(select);
    expect(group).toBeGreaterThan(check);
    expect(upload).toBeGreaterThan(group);
    // The task group uploads only what the check returned.
    expect(batch.slice(group)).toMatch(/let asset = pending\[index\]/);
    expect(batch.slice(group)).not.toMatch(/selected\[/);
    expect(deferred).toBeGreaterThan(-1);
    // uploadSingleAsset has exactly one caller: this batch.
    expect((code(engine).match(/\.uploadSingleAsset\(/g) ?? []).length).toBe(1);
  });

  test('every fresh row is checked (round 12: covered or not); only the server\'s hits are left out; a deferral backs off', () => {
    const fn = body(engine, 'private func rowsCheckedAgainstServer(');
    expect(fn).toMatch(/let fresh = PendingUploadServerCheck\.batchCandidates\(\s*pending\.map \{ \(id: \$0\.localAssetId, staged: \$0\.stagedFileId != nil\) \}\s*\)/);
    // Round 12 (review item 1): no coverage on the per-batch path.
    expect(fn).not.toMatch(/coverage|Coverage|uncovered/);
    expect(fn).toMatch(/PendingUploadServerCheck\.run\(candidates: fresh, steps: steps\)/);
    expect(fn).toMatch(/return pending\.filter \{ !skip\.contains\(\$0\.localAssetId\) \}/);
    expect(fn).toMatch(/case let \.deferred\(reason\):[\s\S]*if let wait \{ backoffUntil = Date\(\)\.addingTimeInterval\(wait\) \}[\s\S]*return nil/);
    const steps = body(engine, 'private func serverCheckSteps(');
    expect(steps).toMatch(/FencedManifestWrites\.promoteCheckedHits\(/);
    expect(steps).toMatch(/let hits = try await client\.check\(ids\)/);
  });

  test('stop() drops the fetch result the PhotoKit change observer diffs against (review finding 3)', () => {
    // Round 11: the stop's transition does it (lifecycle.userStop / internalStop).
    expect(engine).toMatch(/  func stop\(\) \{\n    lifecycle\.userStop \{ stopLocked\(\) \}\n  \}/);
  });

  test('a batch of server-promoted rows is progress for the drain loop', () => {
    expect(engine).toMatch(/let progressed = uploaded \+ self\.takeLastBatchServerPromoted\(\)\n\s*if progressed == 0, !self\.dbQueue\.sync/);
  });
});

describe('round 11 (review of mobile#182 at de23774e)', () => {
  const IOS_DIR = IOS;
  // A missing file reads as '' so each test fails on its own assertion (the
  // red run at de23774 has no BackupEngineLifecycle.swift).
  const { existsSync } = require('node:fs');
  const lifecycleSwift = existsSync(join(IOS_DIR, 'BackupEngineLifecycle.swift'))
    ? readFileSync(join(IOS_DIR, 'BackupEngineLifecycle.swift'), 'utf8')
    : '';
  const checkSwift = readFileSync(join(IOS_DIR, 'PendingUploadServerCheck.swift'), 'utf8');
  const clientSwift = readFileSync(join(IOS_DIR, 'PhotoBackupServerClient.swift'), 'utf8');
  const responsesSwift = readFileSync(join(IOS_DIR, 'PhotoBackupServerResponses.swift'), 'utf8');
  const batch = body(engine, 'func processBatch(limit: Int = 12, ticket callerTicket: ManifestWriteFence.Ticket? = nil) async throws -> Int {');

  test('finding 2: no native code asks for GET /api/v1/files/index (task 1959); no liveness read is left', () => {
    const { readdirSync } = require('node:fs');
    const offenders: string[] = [];
    for (const f of readdirSync(IOS_DIR).filter((n: string) => n.endsWith('.swift'))) {
      const src = code(readFileSync(join(IOS_DIR, f), 'utf8'));
      if (/\/api\/v1\/files\/index/.test(src) || /"\/files\/index/.test(src)) offenders.push(f);
    }
    expect(offenders).toEqual([]);
    expect(code(engine)).not.toMatch(/liveFileIds|LiveFileIndexCache|IdentifierMapCache|liveOnly/);
    expect(code(clientSwift)).not.toMatch(/func fileIndex/);
  });

  test('finding 2: /check promotes only `backed_up` entries with their file id; a server without it fails closed', () => {
    const parse = body(responsesSwift, 'static func checkBackedUp(statusCode: Int, data: Data, requested: [String]) throws -> [String: String] {');
    expect(parse).toMatch(/guard let backedUpValue = object\["backed_up"\] else \{ throw ServerLacksBackedUp\(\) \}/);
    expect(parse).toMatch(/guard Set\(backedUp\.keys\) == hits else \{ throw bad \}/);
    expect(body(clientSwift, 'func check(_ ids: [String]) async throws -> [String: String] {'))
      .toMatch(/PhotoBackupServerResponses\.checkBackedUp\(statusCode: status, data: data, requested: ids\)/);
    // The per-batch run promotes exactly the hits /check returned.
    const run = body(checkSwift, 'static func run(candidates: [String], steps: Steps) async -> Outcome {');
    expect(run).toMatch(/hits\.merge\(try await steps\.check\(chunk\)\)/);
    expect(run).toMatch(/guard let promoted = steps\.promote\(hits\) else \{ return \.deferred\(\.applyFailed\) \}/);
    expect(checkSwift).toMatch(/error is PhotoBackupServerResponses\.ServerLacksBackedUp \? \.serverLacksBackedUp : \.checkFailed/);
    expect(body(checkSwift, 'static func backoff(for reason: DeferReason, consecutiveFailures: Int) -> TimeInterval? {'))
      .toMatch(/case \.noDeviceId, \.checkFailed, \.serverLacksBackedUp:\s*return ManifestRebuildGate\.fetchFailureBackoff/);
    // Logged once per process.
    const note = body(engine, 'private func noteServerBackedUpSupport(_ supported: Bool) {');
    expect(note).toMatch(/if !supported, PendingUploadServerCheck\.serverLacksBackedUpNotice\.shouldFire\(\) \{/);
    expect(checkSwift).toMatch(/static let serverLacksBackedUpMessage = "server lacks backed_up \(task 2036\)"/);
  });

  test('finding 2: the rebuild uses the identifiers map only, and defers once the server was seen without backed_up', () => {
    const ready = body(engine, READY_SIG);
    // Round 12 (review item 2): through rebuildFetch, which probes once per period.
    const [via, lacks, fetch] = order(ready, 'return try await PendingUploadServerCheck.rebuildFetch(', 'backedUpSupported: { self.serverBackedUpSupported },', 'try await self.fetchServerIdentifierMap(');
    expect(via).toBeGreaterThan(-1);
    expect(lacks).toBeGreaterThan(via);
    expect(fetch).toBeGreaterThan(lacks);
  });

  test('finding 9: the bulk pass runs before the drain selects a batch, and is requested by drain starts, the BG task and inserts', () => {
    const [ready, bulk, select, check] = order(
      batch,
      'guard await ensureManifestReadyForUploads(',
      'await bulkServerCheckIfRequested(accountId: batchAccountId, authToken: authToken, baseURL: baseURL, ticket: ticket)',
      'let selected = dbQueue.sync { getPendingUploads(limit: limit) }',
      'guard let pending = await rowsCheckedAgainstServer(',
    );
    expect(ready).toBeGreaterThan(-1);
    expect(bulk).toBeGreaterThan(ready);
    expect(select).toBeGreaterThan(bulk);
    expect(check).toBeGreaterThan(select);
    const fn = body(engine, 'private func bulkServerCheckIfRequested(');
    expect(fn).toMatch(/BackupManifestStore\.freshPendingIds\(db\)/);
    expect(fn).toMatch(/PendingUploadServerCheck\.bulk\(candidates: candidates, steps: steps\)/);
    expect(fn).toMatch(/recordBulkServerCheck\(outcome, accountId: accountId, generation: ticket\.generation\)/);
    expect(body(engine, 'private func recordBulkServerCheck(')).toMatch(/_serverCheckCoverage\.record\(outcome\.needsBackup, accountId: accountId, generation: generation, now: Date\(\)\)/);
    expect(body(engine, 'private func startDrainLoop(reason: String) {')).toMatch(/requestBulkServerCheck\(\)/);
    expect(body(engine, 'private func handleBackgroundTask(_ task: BGProcessingTask) {')).toMatch(/self\.requestBulkServerCheck\(\)/);
    expect(body(engine, 'private func recordScanInsert(\n    _ written: FencedManifestWrites.ScanWrite, assets: Int, source: ScanInsertHealth.Source\n  ) {'))
      .toMatch(/\} else if entered > 0 \{\s*requestBulkServerCheck\(\)/);
    expect(checkSwift).toMatch(/static let maxIdentifiersPerCheck = 500/);
  });

  test('finding 9: the coverage is cleared at every stop and sign-out', () => {
    expect(body(engine, '  private func stopLocked() {')).toMatch(/_serverCheckCoverage\.clear\(\)/);
    expect(body(engine, 'func prepareForStoragePurge(')).toMatch(/_serverCheckCoverage\.clear\(\)/);
  });

  test('finding 3: start/stop/retry/observer/monitor go through ONE lifecycle lock', () => {
    // Round 12 (review item 8): the key is prepared outside the lock.
    expect(engine).toMatch(/  func start\(\) \{\n    lifecycle\.userStart\(prepare: \{ prepareStartMasterKey\(\) \}\) \{ startLocked\(prepared: \$0\) \}\n  \}/);
    expect(engine).toMatch(/  func stop\(\) \{\n    lifecycle\.userStop \{ stopLocked\(\) \}\n  \}/);
    // startLocked( appears 3 times: its definition, start() and the retry.
    expect((code(engine).match(/startLocked\(/g) ?? []).length).toBe(3);
    expect(body(engine, 'private func registerPhotoObserver() {')).toMatch(/lifecycle\.registerObserverOnce \{ PHPhotoLibrary\.shared\(\)\.register\(self\) \}/);
    expect(body(engine, 'private func startNetworkMonitor() {')).toMatch(/lifecycle\.startMonitorIfNeeded \{/);
    expect(body(engine, 'private func stopNetworkMonitor() {')).toMatch(/lifecycle\.stopMonitor \{/);
    expect((code(engine).match(/PHPhotoLibrary\.shared\(\)\.register\(self\)/g) ?? []).length).toBe(1);
    expect(code(engine)).not.toMatch(/networkMonitor = /);
    // The background task's running flips are transitions too (round 12: with ownership).
    const bg = body(engine, 'private func handleBackgroundTask(_ task: BGProcessingTask) {');
    expect(bg).toMatch(/let batchStart: Bool = self\.lifecycle\.beginBackgroundRun\(isRunning: \{ self\.isRunning \}\) \{/);
    expect(bg).toMatch(/let idled: Bool = !batchStart && self\.lifecycle\.endBackgroundRun\(/);
    // The lifecycle's retry checks the intent and the token in the lock.
    // Round 13 (review item 12): the one retry entry point production uses.
    expect(body(lifecycleSwift, 'func runRetry<P>(_ token: UInt64, prepare: () -> P, _ body: (P) -> StartStep) -> Bool {'))
      .toMatch(/locked \{\s*guard read\(\{ _wantsRunning && token == _retryToken \}\) else \{ return nil \}\s*return body\(prepared\)/);
  });

  test('finding 5: the fetch result is stored only through acceptFetchResult, and cleared after the sign-out reset', () => {
    const fetch = body(engine, 'private func fetchAssetsForBackup(');
    expect(fetch).toMatch(/storeFetchResult\(result, ticket: ticket, stopGeneration: stopGeneration\)/);
    expect(fetch).toMatch(/storeFetchResult\(nil, ticket: ticket, stopGeneration: stopGeneration\)/);
    const store = body(engine, 'private func storeFetchResult(');
    expect(store).toMatch(/lifecycle\.acceptFetchResult\(\s*result, stopGeneration: stopGeneration, cancelled: Task\.isCancelled,/);
    expect(store).toMatch(/self\.manifestHandle\.writeFence\.isCurrent\(ticket\)/);
    const scan = body(engine, 'func scanPhotoLibraryForPendingUploads(reason: String, ticket callerTicket: ManifestWriteFence.Ticket? = nil) async -> Bool {');
    const [gen, doFetch] = order(scan, 'let fetchGeneration = lifecycle.stopGeneration', 'fetchAssetsForBackup(');
    expect(gen).toBeGreaterThan(-1);
    expect(doFetch).toBeGreaterThan(gen);
    expect(body(engine, 'func photoLibraryDidChange(_ changeInstance: PHChange) {'))
      .toMatch(/guard lifecycle\.replaceFetchResult\(expected: old, with: details\.fetchResultAfterChanges\) else \{ return \}/);
    const prep = body(engine, 'func prepareForStoragePurge(');
    const [reset, clear] = order(prep, 'manifestHandle.resetForSignOut(', 'lifecycle.clearFetchResult()');
    expect(reset).toBeGreaterThan(-1);
    expect(clear).toBeGreaterThan(reset);
    expect(code(engine)).not.toMatch(/currentFetchResult = /);
  });

  test('finding 7: the scan-insert health lives on the handle and the sign-out reset clears it', () => {
    const reset = body(handleSwift, 'func resetForSignOut(\n    outgoingAccountId: String?,\n    outgoingInferred: Bool = false,\n    mode: ManifestPurgeMode = .signOut,\n    deletedAccountIds: Set<String> = []\n  ) -> Bool {');
    const [fence, health] = order(reset, 'writeFence.advanceForSignOut()', 'scanInsertHealth = ScanInsertHealth()');
    expect(fence).toBeGreaterThan(-1);
    expect(health).toBeGreaterThan(fence);
    expect(code(engine)).not.toMatch(/private var scanInsertHealth/);
  });

  test('finding 1: an inherited deletion flag forces "discard every mark"', () => {
    expect(body(handleSwift, 'var activeDiscard: BackupManifestStore.MarkDiscard {'))
      .toMatch(/let inheritedDeletion = discardPending\.get\(\) && !discardPendingSetByThisProcess\s*let all = discardAllPending \|\| inheritedDeletion/);
  });
});

describe('round 12 (review of mobile#182 at e9a93077)', () => {
  const IOS_DIR = IOS;
  const { existsSync } = require('node:fs');
  const read = (f: string) => (existsSync(join(IOS_DIR, f)) ? readFileSync(join(IOS_DIR, f), 'utf8') : '');
  const lifecycleSwift = read('BackupEngineLifecycle.swift');
  const storeSwift = read('BackupManifestStore.swift');
  const deviceIdSwift = read('BackupDeviceId.swift');
  const checkSwift = read('PendingUploadServerCheck.swift');
  // A missing signature reads as '' so each test fails on its own assertion
  // (the red run at e9a9307 has none of the round-12 signatures).
  const lazyBody = (src: string, sig: string): string => {
    try {
      return body(src, sig);
    } catch {
      return '';
    }
  };
  const batch = lazyBody(engine, 'func processBatch(limit: Int = 12, ticket callerTicket: ManifestWriteFence.Ticket? = nil) async throws -> Int {');
  const startLocked = lazyBody(engine, 'private func startLocked(prepared: PreparedStartKey?) -> BackupEngineLifecycle.StartStep {');
  const stopLocked = lazyBody(engine, '  private func stopLocked() {');

  test('item 1: the per-batch guard asks about every fresh row; the coverage only feeds the bulk pass', () => {
    expect(lazyBody(checkSwift, 'static func batchCandidates(_ rows: [(id: String, staged: Bool)]) -> [String] {'))
      .toMatch(/deduplicated\(rows\.filter \{ !\$0\.staged \}\.map\(\\\.id\)\)/);
    expect(code(engine)).not.toMatch(/uncoveredByBulkServerCheck/);
    const uses = (code(engine).match(/\.uncovered\(/g) ?? []).length;
    expect(uses).toBe(1);
    expect(lazyBody(engine, 'private func bulkServerCheckIfRequested(')).toMatch(/coverage\.uncovered\(all,/);
  });

  test('item 2: the "lacks backed_up" state is reset at sign-out and probed by the rebuild', () => {
    const prep = lazyBody(engine, 'func prepareForStoragePurge(');
    expect(prep).toMatch(/_backedUpSupport\.reset\(\)/);
    const ready = lazyBody(engine, READY_SIG);
    expect(ready).toMatch(/takeProbeSlot: \{ self\.takeBackedUpProbeSlot\(\) \}/);
    expect(ready).toMatch(/_ = try await probeSteps\.check\(\[PendingUploadServerCheck\.capabilityProbeIdentifier\]\)/);
    // The probe goes through the check step that records the answer.
    expect(lazyBody(engine, 'private func serverCheckSteps(')).toMatch(/self\?\.noteServerBackedUpSupport\(true\)/);
    expect(code(engine)).not.toMatch(/_serverLacksBackedUp/);
  });

  test('item 3: the background task owns only its own run; the user start claims it; stop removes everything', () => {
    expect((startLocked.match(/lifecycle\.claimUserRun\(\)/g) ?? []).length).toBe(2);
    const [claimRunning, wake] = order(startLocked, 'lifecycle.claimUserRun()', 'wakeDrainLoop(reason: "start")');
    expect(claimRunning).toBeGreaterThan(-1);
    expect(wake).toBeGreaterThan(claimRunning);
    const [unreg, monitor, guardRunning] = order(
      stopLocked,
      'lifecycle.unregisterObserver { PHPhotoLibrary.shared().unregisterChangeObserver(self) }',
      'stopNetworkMonitor()',
      'guard isRunning else { return }',
    );
    expect(unreg).toBeGreaterThan(-1);
    expect(monitor).toBeGreaterThan(unreg);
    expect(guardRunning).toBeGreaterThan(monitor);
    expect(lazyBody(lifecycleSwift, 'func endBackgroundRun(stillCurrent: () -> Bool, idle: () -> Void) -> Bool {'))
      .toMatch(/guard read\(\{ _runOwner == \.background \}\), stillCurrent\(\) else \{ return false \}/);
  });

  test('item 8: no keychain or Face ID read inside the lifecycle lock; the retry prepares outside too', () => {
    expect(startLocked).not.toMatch(/loadMasterKey/);
    expect(lazyBody(engine, 'private func prepareStartMasterKey() -> PreparedStartKey? {')).toMatch(/BeebeebCryptoBridge\.loadMasterKeyUncached\(\)/);
    expect(code(engine)).not.toMatch(/BeebeebCryptoBridge\.loadMasterKey\(\)/);
    expect(lazyBody(engine, 'private func scheduleManifestOpenRetry(accountId: String, after delay: TimeInterval) {'))
      .toMatch(/self\.lifecycle\.runRetry\(token, prepare: \{ self\.prepareStartMasterKey\(\) \}\)/);
    const userStart = lazyBody(lifecycleSwift, 'func userStart<P>(prepare: () -> P, _ body: (P) -> StartStep) -> Bool {');
    const [prep, lock] = order(userStart, 'let prepared = prepare()', 'locked {');
    expect(prep).toBeGreaterThan(-1);
    expect(lock).toBeGreaterThan(prep);
  });

  test('item 9: processBatch takes the batch slot BEFORE the rebuild gate', () => {
    const [begin, ready] = order(batch, 'if !beginBatchProcessing() {', 'guard await ensureManifestReadyForUploads(');
    expect(begin).toBeGreaterThan(-1);
    expect(ready).toBeGreaterThan(begin);
  });

  test('item 6: the pause reason reaches the progress dict, cleared at stop and sign-out', () => {
    expect(lazyBody(engine, 'func currentProgress() -> [String: Any] {')).toMatch(/"serverCheckPausedReason": serverCheckPausedReason \?\? NSNull\(\)/);
    expect(lazyBody(engine, 'private func rowsCheckedAgainstServer(')).toMatch(/recordServerCheckPause\(reason\)/);
    // Round 15 (review item 6): one call per gate pass, ready or deferred;
    // on ready unconditionally (not only when rebuilt).
    const readySrc = lazyBody(engine, READY_SIG);
    expect((readySrc.match(/recordGatePause\(outcome\)/g) ?? []).length).toBe(2);
    expect(readySrc).toMatch(/manifestRebuildFailures = 0\n(?:\s*\/\/[^\n]*\n)*\s*recordGatePause\(outcome\)\n/);
    expect(lazyBody(engine, 'private func bulkServerCheckIfRequested(')).toMatch(/recordServerCheckPause\(stopped\)/);
    expect(stopLocked).toMatch(/clearServerCheckPause\(\)/);
    expect(lazyBody(engine, 'func prepareForStoragePurge(')).toMatch(/_serverCheckPause\.clear\(\)/);
    const ts = readFileSync(join(import.meta.dir, '../../modules/beebeeb-crypto/src/BeebeebCrypto.ts'), 'utf8');
    expect(ts).toMatch(/serverCheckPausedReason\?: string \| null/);
    expect(backupContext).toMatch(/setServerCheckPausedReason\(nativeServerCheckPausedReason\(p\)\)/);
    expect(backupContext).toMatch(/opt\(a\.serverCheckPausedReason\) === opt\(b\.serverCheckPausedReason\)/);
    const settings = readFileSync(join(import.meta.dir, '../screens/SettingsScreen.tsx'), 'utf8');
    expect(settings).toMatch(/if \(serverCheckPausedReason\) return serverCheckPausedReason;/);
  });

  test('item 7: native reads the canonical id without JS and never mints one; JS hands it over at every launch', () => {
    const getter = lazyBody(engine, 'var backupDeviceId: String? {');
    expect(getter).toMatch(/BackupDeviceId\.resolve\(/);
    expect(getter).toMatch(/secureStore: \{ BackupDeviceId\.readSecureStore\(\$0\) \}/);
    expect(code(deviceIdSwift)).not.toMatch(/UUID\(\)|randomUUID|SecItemAdd|SecItemUpdate/);
    const identity = readFileSync(join(import.meta.dir, 'device-identity.ts'), 'utf8');
    expect(identity).toMatch(/export const DEVICE_ID_KEY = 'bb_sync_device_id';/);
    expect(identity).toMatch(/const LEGACY_BACKUP_DEVICE_ID_KEY = 'beebeeb_device_id';/);
    expect(deviceIdSwift).toMatch(/static let canonicalSecureStoreKey = "bb_sync_device_id"/);
    expect(deviceIdSwift).toMatch(/static let legacySecureStoreKey = "beebeeb_device_id"/);
    expect(backupContext).toMatch(/useEffect\(\(\) => \{\s*void syncBackupDeviceIdToNative\(\);\s*\}, \[\]\);/);
  });

  test('item 5: a replaced manifest carries the JS schema version (equal constants)', () => {
    const backupDb = readFileSync(join(import.meta.dir, '../services/BackupDatabase.ts'), 'utf8');
    const js = backupDb.match(/const LEGACY_STATUS_ENUM_MIGRATION_VERSION = (\d+);/);
    const swift = storeSwift.match(/static let jsSchemaVersion: Int32 = (\d+)/);
    expect(js?.[1]).toBeDefined();
    expect(swift?.[1]).toBe(js?.[1]);
    expect(backupDb).toMatch(/if \(schemaVersion < LEGACY_STATUS_ENUM_MIGRATION_VERSION\) \{/);
    expect(lazyBody(storeSwift, 'private static func replaceFile(path: String, carrying: [PendingMark]) -> (ok: Bool, unlinked: Bool) {'))
      .toMatch(/PRAGMA user_version = \\\(jsSchemaVersion\)/);
  });

  test('item 4: a recovery without JS\'s confirmed close touches no connection', () => {
    const finish = lazyBody(handleSwift, 'func finishAfterFailedReset(allowUnlink: Bool) -> FinishResult {');
    const [guardAt, recover] = order(finish, 'guard allowUnlink else {', 'BackupManifestStore.recoverAfterFailedReset(');
    expect(guardAt).toBeGreaterThan(-1);
    expect(recover).toBeGreaterThan(guardAt);
    expect(finish.slice(guardAt, recover)).toMatch(/peerMayHoldFile = true/);
  });
});

describe('round 13 (review of mobile#182 at a19037f9)', () => {
  const { existsSync } = require('node:fs');
  const read = (f: string) => (existsSync(join(IOS, f)) ? readFileSync(join(IOS, f), 'utf8') : '');
  const lifecycleSwift = read('BackupEngineLifecycle.swift');
  const deviceIdSwift = read('BackupDeviceId.swift');
  const fenceSrc = read('ManifestWriteFence.swift');
  const surfaceSwift = read('BackupSurfaceState.swift');
  // A missing signature reads as '' so each test fails on its own assertion
  // (the red run at a19037f has none of the round-13 signatures).
  const lazyBody = (src: string, sig: string): string => {
    try {
      return body(src, sig);
    } catch {
      return '';
    }
  };
  const readTs = (rel: string) => {
    const p = join(import.meta.dir, rel);
    return existsSync(p) ? readFileSync(p, 'utf8') : '';
  };
  const startLocked = lazyBody(engine, 'private func startLocked(prepared: PreparedStartKey?) -> BackupEngineLifecycle.StartStep {');
  const prepare = lazyBody(engine, 'private func prepareStartMasterKey() -> PreparedStartKey? {');
  const bg = lazyBody(engine, 'private func handleBackgroundTask(_ task: BGProcessingTask) {');
  const scan = lazyBody(engine, 'func scanPhotoLibraryForPendingUploads(reason: String, ticket callerTicket: ManifestWriteFence.Ticket? = nil) async -> Bool {');

  test('item 1: native replaces a different id only when JS says it is durable; JS hands over only a durable id', () => {
    const fn = lazyBody(moduleSwift, 'AsyncFunction("setBackupDeviceId") { (deviceId: String, persisted: Bool?) -> Bool in');
    expect(fn).toMatch(/NativeBackupEngine\.shared\.acceptBackupDeviceId\(deviceId, persisted: persisted \?\? false\)/);
    const accept = lazyBody(engine, 'func acceptBackupDeviceId(_ deviceId: String, persisted: Bool) -> Bool {');
    expect(accept).toMatch(/BackupDeviceId\.decideSet\(existing: existing, incoming: deviceId, persisted: persisted\)/);
    expect(accept).toMatch(/RuntimeTrace\.event\("backup\.native\.device_id\.set_refused"/);
    expect(accept).toMatch(/NSLog\(/);
    // No other path writes the id: the getter has no setter.
    expect(code(engine)).not.toMatch(/backupDeviceId = /);
    expect(lazyBody(deviceIdSwift, 'static func decideSet(existing: String?, incoming: String, persisted: Bool) -> SetDecision {'))
      .toMatch(/guard persisted else \{ return \.refused\(reason: "different_id_not_persisted"\) \}/);
    const handoff = readTs('backup-device-id-handoff.ts');
    expect(handoff).toMatch(/resolution = await deps\.resolveDeviceId\(\);/);
    expect(handoff).toMatch(/if \(!resolution\.id \|\| !resolution\.persisted\) return false;/);
    expect(handoff).toMatch(/deps\.setBackupDeviceId\(resolution\.id, \{ persisted: true \}\)/);
    const ts = readFileSync(join(import.meta.dir, '../../modules/beebeeb-crypto/src/BeebeebCrypto.ts'), 'utf8');
    expect(ts).toMatch(/BeebeebCryptoModule\.setBackupDeviceId\(deviceId, options\.persisted\)/);
    expect(backupContext).toMatch(/import \{ syncBackupDeviceIdToNative \} from '\.\/backup-device-id-handoff';/);
    expect(backupContext).toMatch(/useEffect\(\(\) => \{\s*void syncBackupDeviceIdToNative\(\);\s*\}, \[\]\);/);
    // The keychain read never turns an error into "no id" (no mint over it).
    const identity = readTs('device-identity.ts');
    expect(identity).toMatch(/if \(!existing\.ok\) throw new DeviceIdUnavailableError\(\);/);
    expect(identity).toMatch(/if \(!legacyBackupId\.ok\) throw new DeviceIdUnavailableError\(\);/);
  });

  test('item 2: sign-out never clears the device migration record; only marked legacy items move', () => {
    const service = readTs('../services/BackupService.ts');
    expect(service).toMatch(/export const LEGACY_MIGRATION_DONE_KEY = 'beebeeb_backup_legacy_migration';/);
    const migrate = lazyBody(service, 'async function migrateLegacyRootBackups(');
    expect(migrate).toMatch(/const done = await readLegacyMigration\(cache\);/);
    expect(migrate).toMatch(/const kind = legacyRootItemKind\(f, legacyPhotosFolderId\);/);
    expect(migrate).not.toMatch(/decryptName/);
    expect(migrate).toMatch(/await storeSet\(LEGACY_MIGRATION_DONE_KEY, JSON\.stringify\(legacyMigration\)\);/);
    const kind = lazyBody(service, 'function legacyRootItemKind(');
    expect(kind).toMatch(/f\.name_encrypted === LEGACY_ROOT_NAMES\.photosFolder/);
    expect(kind).not.toMatch(/decrypt/);
    for (const f of ['account-cleanup.ts', 'backup-folder-cache.ts', 'signed-out-purge.ts']) {
      expect(readTs(f)).not.toMatch(/beebeeb_backup_legacy_migration|LEGACY_MIGRATION_DONE_KEY/);
    }
  });

  test('item 3: any bind or a different signed-in user ends the memory of the last unbound account; deletions name accounts', () => {
    expect(engine).toMatch(/_unboundAccount\.accountChanged\(from: previous, to: normalizedNew\)/);
    expect(code(engine)).not.toMatch(/_lastUnboundAccountId/);
    const prep = lazyBody(engine, 'func prepareForStoragePurge(');
    const [capture, stop] = order(prep, 'let outgoing = outgoingAccountForReset()', 'stop()');
    expect(capture).toBeGreaterThan(-1);
    expect(stop).toBeGreaterThan(capture);
    const confirm = lazyBody(moduleSwift, 'AsyncFunction("confirmMasterKeyHandle") { [self] (handleId: Int, ownerId: String?) throws -> Bool in');
    expect(confirm).toMatch(/NativeBackupEngine\.shared\.noteSignedInAccount\(normalizedOwnerId\)/);
    const reset = lazyBody(handleSwift, 'func resetForSignOut(\n    outgoingAccountId: String?,\n    outgoingInferred: Bool = false,\n    mode: ManifestPurgeMode = .signOut,\n    deletedAccountIds: Set<String> = []\n  ) -> Bool {');
    expect(reset).toMatch(/if deleted\.isEmpty, !outgoingInferred, let outgoingAccountId, !outgoingAccountId\.isEmpty \{\s*deleted\.insert\(outgoingAccountId\)/);
  });

  test('item 4: the manifest is asked before the key is read; a read key is kept for the retry', () => {
    const [manifest, load] = order(prepare, 'manifestReady: { self.dbQueue.sync { self.openManifestIfClosed(trigger: "start_prepare") } == nil }', 'BeebeebCryptoBridge.loadMasterKeyUncached()');
    expect(manifest).toBeGreaterThan(-1);
    expect(load).toBeGreaterThan(manifest);
    expect(prepare).toMatch(/return lifecycle\.prepareStartKey\(/);
    const order4 = lazyBody(lifecycleSwift, 'func prepareStartKey<R>(');
    const [mGuard, cached, stash, ld] = order(order4, 'guard manifestReady() else { return manifestUnavailable() }', 'cached()', 'takeStashedStartKey(accountId: accountId)', 'return load()');
    expect(mGuard).toBeGreaterThan(-1);
    expect(cached).toBeGreaterThan(mGuard);
    expect(stash).toBeGreaterThan(cached);
    expect(ld).toBeGreaterThan(stash);
    expect(startLocked).toMatch(/guard ensureManifestOpenForStart\(accountId: accountId\) else \{[\s\S]*?lifecycle\.stashStartKey\(handle, accountId: accountId\)/);
    expect(startLocked).toMatch(/case \.notNeeded, \.manifestUnavailable:\s*(?:\/\/[^\n]*\s*)*return \.prepareAgain/);
    expect(lazyBody(lifecycleSwift, 'func userStop(_ body: () -> Void) {')).toMatch(/_stashedStartKey = nil/);
  });

  test('item 5: the expiration pauses only a run the task owns; the user taking the run over unpauses it', () => {
    expect(bg).toMatch(/if !self\.lifecycle\.expireBackgroundRun\(\{ self\.pause\(\) \}\) \{/);
    expect(bg).not.toMatch(/self\?\.pause\(\)/);
    expect(lazyBody(lifecycleSwift, 'func expireBackgroundRun(_ pause: () -> Void) -> Bool {'))
      .toMatch(/guard read\(\{ _runOwner == \.background \}\) else \{ return false \}/);
    expect(startLocked).toMatch(/if lifecycle\.claimUserRun\(\) \{\s*isPaused = false\s*\}/);
  });

  test('item 6: every surface update decides the state with the server-check pause', () => {
    const state = lazyBody(engine, 'private func backupState(pending: Int) -> (state: String, reason: String) {');
    expect(state).toMatch(/BackupSurfaceState\.decide\(/);
    expect(state).toMatch(/serverCheckPause: serverCheckPauseSurface,/);
    expect(lazyBody(engine, 'private func heartbeatStatus(for payload: BackupStatusPayload) -> String {')).toMatch(/BackupSurfaceState\.heartbeatStatus\(/);
    const decide = lazyBody(surfaceSwift, 'static func decide(_ i: Inputs) -> State {');
    const [paused, preparing] = order(decide, 'if let paused = i.serverCheckPause', 'reason: "Preparing backup"');
    expect(paused).toBeGreaterThan(-1);
    expect(preparing).toBeGreaterThan(paused);
  });

  test('item 7: no map before the process knows the server has backed_up', () => {
    expect(lazyBody(engine, READY_SIG)).toMatch(/backedUpSupported: \{ self\.serverBackedUpSupported \},/);
    expect(lazyBody(read('PendingUploadServerCheck.swift'), 'static func rebuildFetch(')).toMatch(/if backedUpSupported\(\) != true \{/);
  });

  test('item 9: the batch server check promotes stale in-flight rows', () => {
    expect(lazyBody(fenceSrc, 'static func promoteCheckedHits(')).toMatch(/includeStaleInFlight: true/);
  });

  test('item 10: the scan runs the rebuild gate only inside the batch slot', () => {
    const [begin, ready, finish, flush] = order(
      scan,
      'if beginBatchProcessing() {',
      'ready = await ensureManifestReadyForUploads(',
      'finishBatchProcessing()',
      'await flushServerMarks(',
    );
    expect(begin).toBeGreaterThan(-1);
    expect(ready).toBeGreaterThan(begin);
    expect(finish).toBeGreaterThan(ready);
    expect(flush).toBeGreaterThan(finish);
    // Exactly the two callers of the gate, both behind the slot.
    expect((code(engine).match(/await ensureManifestReadyForUploads\(/g) ?? []).length).toBe(2);
  });

  test('item 12: the lock-only start and retry overloads are gone; the lifecycle test drives the production ones', () => {
    expect(lifecycleSwift).not.toMatch(/func userStart\(_ body: \(\) -> Void\)/);
    expect(lifecycleSwift).not.toMatch(/func runRetry\(_ token: UInt64, _ body: \(\) -> Void\)/);
    const t = readFileSync(join(import.meta.dir, '../../scripts/swift-tests/backup-engine-lifecycle-test.swift'), 'utf8');
    expect(t).not.toMatch(/lifecycle\.userStart \{/);
    expect(t).not.toMatch(/runRetry\((?:token|old|newer)\) \{/);
    expect(t).toMatch(/lifecycle\.runRetry\(token, prepare: \{ self\.prepare\(\) \}\)/);
  });
});

describe('round 14 (review of mobile#182 at 18312919)', () => {
  const { existsSync } = require('node:fs');
  const read = (f: string) => (existsSync(join(IOS, f)) ? readFileSync(join(IOS, f), 'utf8') : '');
  const lazyBody = (src: string, sig: string): string => {
    try {
      return body(src, sig);
    } catch {
      return '';
    }
  };
  const purge = lazyBody(
    engine,
    'func prepareForStoragePurge(\n    mode: ManifestPurgeMode = .signOut,\n    deletedAccountIds: Set<String> = []\n  ) -> (kept: Set<String>, resetFailed: Bool) {',
  );
  const flush = lazyBody(
    engine,
    'func flushServerMarksForSignOut(deadline: TimeInterval = SignOutMarkFlush.defaultDeadline, attemptsPerRow: Int = 2) async -> (candidates: Int, marked: Int) {',
  );
  const ready = lazyBody(engine, READY_SIG);

  // Round 15 (review of mobile#182 at dd97f2ac, P1 item 1): the keep moved
  // INTO the staged purge (BackupManifestStore.purgeAllStaged, driven on real
  // SQLite by kept-in-flight-upload-test), so every caller of
  // clearAccountAndPurgeStaged keeps first: teardownAllBackup (the provider
  // unmount, which runs before the signed-out purge), disablePhotoBackup, the
  // read-only stop, and prepareForStoragePurge.
  test('item 1 (round 15): every staged purge keeps the in-flight uploads first; the sign-out purge runs it before the reset', () => {
    const clear = code(lazyBody(engine, 'func clearAccountAndPurgeStaged() {'));
    expect(clear).toMatch(/dbQueue\.sync \{ purgeAllStagedAssets\(\) \}/);
    const purgeAll = code(lazyBody(engine, 'private func purgeAllStagedAssets() -> Int {'));
    expect(purgeAll).toMatch(/BackupManifestStore\.purgeAllStaged\(/);
    // The engine no longer clears staged rows itself here (the store does, after its keep).
    expect(purgeAll).not.toMatch(/clearStagedStateForRestage\(/);
    const storeSwift = readFileSync(join(IOS, 'BackupManifestStore.swift'), 'utf8');
    const purgeStore = code(lazyBody(storeSwift, 'static func purgeAllStaged('));
    const [keep, select, clearRow] = order(
      purgeStore,
      'let kept = keepInFlightUploads(db, nowMs: nowMs)',
      'WHERE staged_file_id IS NOT NULL',
      'clearStagedForRestage(db, assetId: row.assetId',
    );
    expect(keep).toBeGreaterThan(-1);
    expect(select).toBeGreaterThan(keep);
    expect(clearRow).toBeGreaterThan(select);
    const [staged, reset] = order(code(purge), 'clearAccountAndPurgeStaged()', 'manifestHandle.resetForSignOut(');
    expect(staged).toBeGreaterThan(-1);
    expect(reset).toBeGreaterThan(staged);
    // No second, unfenced keep is left in prepareForStoragePurge (review item 7).
    expect(code(purge)).not.toMatch(/keepInFlightUploads\(/);
    // Both native entry points of the provider unmount and the toggle-off reach it.
    const module = readFileSync(join(IOS, 'BeebeebCryptoModule.swift'), 'utf8');
    expect(code(lazyBody(module, 'AsyncFunction("teardownAllBackup") { () in'))).toMatch(/engine\.clearAccountAndPurgeStaged\(\)/);
    expect((module.match(/engine\.clearAccountAndPurgeStaged\(\)/g) ?? []).length).toBe(2);
  });

  test('item 1: the sign-out flush loads the in-flight rows and settles them with GET /files/{id} + the mark', () => {
    const f = code(flush);
    expect(f).toMatch(/FencedManifestWrites\.loadSignOutInFlight\(/);
    expect(f).toMatch(/case let \.inFlight\(assetId, fileId\):\s*\n\s*return await SignOutMarkFlush\.settleInFlight\(/);
    // Round 15 (items 2 and 3): complete only on the API's answer, never trashed.
    expect(f).toMatch(/try await self\.inspectExistingUpload\(\s*fileId: fileId, authToken: authToken, baseURL: baseURL, requestTimeout: requestTimeout\s*\) == \.complete\b/);
    expect(f).toMatch(/FencedManifestWrites\.recordInFlightComplete\(/);
    // The in-flight row is marked like an uploaded row (same markOnServer call).
    expect((f.match(/await self\.markOnServer\(/g) ?? []).length).toBe(2);
  });

  test('item 1: the rebuild gate resolves the kept in-flight uploads before the kept marks, on every pass', () => {
    const r = code(ready);
    expect(r).toMatch(/resolveKept: \{ \[weak self\] in/);
    expect(r).toMatch(/await KeptUploadResolution\.run\(/);
    expect(r).toMatch(/FencedManifestWrites\.loadKeptInFlight\(/);
    expect(r).toMatch(/FencedManifestWrites\.resolveKeptInFlight\(/);
    // Round 15 (items 2 and 3): complete only on the API's answer, never trashed.
    expect(r).toMatch(/try await self\.inspectExistingUpload\(\s*fileId: row\.fileId, authToken: authToken, baseURL: baseURL\s*\) == \.complete\b/);
    const run = code(lazyBody(gateSwift, 'static func run(alreadyReady: Bool, steps: Steps) async -> Outcome {'));
    // Both branches: resolve, then apply the kept marks. Round 15 (item 6):
    // the deferral reason comes from the result (server vs local failure).
    expect((run.match(/if let reason = deferReason\(await steps\.resolveKept\(\)\) \{ return \.deferred\(reason\) \}\s*\n(?:\s*\/\/[^\n]*\n)*\s*guard let kept = steps\.applyKept\(\)/g) ?? []).length).toBe(2);
  });

  test('item 3: the bridge maps every surface state explicitly (paused is a pause)', () => {
    expect(code(engine)).not.toMatch(/func mapBridgeState\(/);
    expect(code(engine)).toMatch(/"state": BackupSurfaceState\.bridgeRunState\(internalState\),/);
  });

  test('item 2: a cold-start account deletion names the stored key owner', () => {
    const app = readFileSync(join(import.meta.dir, '../App.tsx'), 'utf8');
    const refresh = app.slice(app.indexOf('const refreshAuth = useCallback(async () => {'));
    // Round 15 (item 4): the owner read is inside getMeNamingKeyOwner
    // (src/lib/cold-start-owner.ts, cold-start-owner.1667-r15.test.ts), which
    // refreshAuth and the cold launch's retryGetMe both call.
    expect(refresh).toMatch(/const me = await getMeNamingKeyOwner\(\{\s*owner: coldStartOwnerRef,\s*signedInUserId: currentUserIdRef\.current,\s*readKeyOwner,\s*getMe,\s*\}\);/);
    const handler = app.slice(app.indexOf('registerAccountDeletedHandler(('), app.indexOf('registerAccountDeletedHandler((') + 900);
    expect(handler).toMatch(/noteAccountDeleted\(accountIdForDeletedElsewhere\(currentUserIdRef\.current, coldStartOwnerRef\.current\)\);\s*\n\s*setUser\(null\)/);
  });

  test('item 4: the docs state the real close rule; enablePhotoBackup has its JSDoc back', () => {
    const md = readFileSync(join(import.meta.dir, '../../CLAUDE.md'), 'utf8');
    expect(md).not.toContain('**Never close the JS handle on it.**');
    expect(md).toContain("**Never close the JS handle while the engine's connection is open on the file.**");
    expect(md).toMatch(/the failed-reset path/);
    expect(md).toMatch(/`admitJsOpen` closes leftover JS/);
    const ts = readFileSync(join(import.meta.dir, '../../modules/beebeeb-crypto/src/BeebeebCrypto.ts'), 'utf8');
    expect(ts).toMatch(/currently signed-in user's id, never a cached\/stale one\.\n \*\/\nexport async function enablePhotoBackup\(/);
    expect(ts).not.toMatch(/never a cached\/stale one\.\n \*\/\n\/\*\*/);
  });
});
