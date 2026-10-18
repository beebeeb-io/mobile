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
  const purge = body(moduleSwift, 'AsyncFunction("purgePlaintextStorage") { () -> [String: Int] in');

  test('prepareForStoragePurge runs before purgeAll, and purgeAll keeps what it returned', () => {
    const [prep, purgeAll] = order(
      purge,
      'let manifest = NativeBackupEngine.shared.prepareForStoragePurge()',
      'PlaintextStorageProtection.purgeAll(pendingNonce: pendingNonce, preserving: manifest.kept)',
    );
    expect(prep).toBeGreaterThan(-1);
    expect(purgeAll).toBeGreaterThan(prep);
  });

  test('round 2: the purge result tells JS when the in-place reset failed', () => {
    expect(purge).toMatch(/"backupManifestResetFailed": manifest\.resetFailed \? 1 : 0/);
  });

  const prep = body(engine, 'func prepareForStoragePurge() -> (kept: Set<String>, resetFailed: Bool) {');

  test('the engine is stopped and unbound BEFORE the manifest is emptied', () => {
    const [stop, unbind, reset] = order(prep, 'stop()', 'clearAccountAndPurgeStaged()', 'manifestHandle.resetForSignOut(outgoingAccountId: outgoingAccountId)');
    expect(stop).toBeGreaterThan(-1);
    expect(unbind).toBeGreaterThan(stop);
    expect(reset).toBeGreaterThan(unbind);
  });

  test('the Backups folder id does not outlive the account (1962 Bug 4)', () => {
    expect(prep).toMatch(/parentFolderId = nil/);
  });

  // lazy: a missing signature is a failing test, not an error that hides the whole section
  const resetForSignOut = () => body(handleSwift, 'func resetForSignOut(outgoingAccountId: String?) -> Bool {');

  test('round 2: the outgoing account (captured before unbind) adopts pre-column rows before the reset', () => {
    const [capture, unbind, reset] = order(
      prep,
      'let outgoingAccountId = currentAccountId ?? lastUnboundAccountId',
      'clearAccountAndPurgeStaged()',
      'manifestHandle.resetForSignOut(outgoingAccountId: outgoingAccountId)',
    );
    expect(capture).toBeGreaterThan(-1);
    expect(unbind).toBeGreaterThan(capture);
    expect(reset).toBeGreaterThan(unbind);
    // round 6: the adopt + reset live in BackupManifestHandle.resetForSignOut, in that order.
    const [adopt, inPlace] = order(
      resetForSignOut(),
      'BackupManifestStore.adoptUnowned(db, accountId: outgoingAccountId)',
      'BackupManifestStore.resetInPlace(db',
    );
    expect(adopt).toBeGreaterThan(-1);
    expect(inPlace).toBeGreaterThan(adopt);
  });

  test('a failed reset closes the engine handle and flags it, but NEVER drops the file from `kept` (the JS handle is still open on it)', () => {
    expect(prep).toMatch(/dbQueue\.sync \{\s*manifestHandle\.resetForSignOut\(outgoingAccountId: outgoingAccountId\)\s*\}/);
    // Round 7: the close goes through `close(_:)` (checked sqlite3_close).
    expect(resetForSignOut()).toMatch(/BackupManifestStore\.resetInPlace\(db[\s\S]*close\(db\)\s*self\.db = nil\s*\}\s*pendingReset\.set\(true\)\s*awaitingPurgeFinish = true\s*return false/);
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
    const [schema, check, pendingGet, retry, close, fail, assign] = order(
      open,
      'prepareSchema(opened)',
      'BackupManifestStore.tableExistsChecked(opened, "backup_assets") == true',
      'if pendingReset.get() {',
      'BackupManifestStore.resetInPlace(opened, nowMs: now())',
      'close(opened)\n        return .pendingResetFailed',
      'return .pendingResetFailed',
      'db = opened',
    );
    expect(schema).toBeGreaterThan(-1);
    expect(check).toBeGreaterThan(schema);
    expect(pendingGet).toBeGreaterThan(check);
    expect(retry).toBeGreaterThan(pendingGet);
    expect(close).toBeGreaterThan(retry);
    expect(fail).toBeGreaterThan(close);
    expect(assign).toBeGreaterThan(fail);
    expect(open).toMatch(/if awaitingPurgeFinish \{ return \.purgeInFlight \}/);
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
    const ready = body(engine, 'func ensureManifestReadyForUploads(accountId: String, authToken: String, baseURL: String) async -> Bool {');
    expect(ready).toMatch(/await ManifestRebuildGate\.run\(alreadyReady: manifestReadyForAccount == accountId, steps: steps\)/);
    expect(ready).toMatch(/applyKept: \{ \[weak self\] in self\?\.applyKeptPendingMarks\(accountId: accountId\) \}/);
  });

  test('the sign-out flush has no row cap and is bounded by time', () => {
    const flush = body(engine, 'func flushServerMarksForSignOut(');
    expect(flush).toMatch(/pendingServerMarks\(db, accountId: accountId, limit: Int\(Int32\.max\)\)/);
  });

  test('round 3: the WHOLE sign-out flush (row load included) runs under the hard deadline', () => {
    const sig = engine.slice(engine.indexOf('func flushServerMarksForSignOut('));
    expect(sig.slice(0, sig.indexOf('{'))).toMatch(/deadline: TimeInterval = SignOutMarkFlush\.defaultDeadline/);
    const flush = body(engine, 'func flushServerMarksForSignOut(');
    const run = flush.indexOf('SignOutMarkFlush.run(');
    expect(run).toBeGreaterThan(-1);
    // The row load and every mark happen inside run(...), not before it.
    expect(flush.indexOf('pendingServerMarks(')).toBeGreaterThan(run);
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
    const batch = body(engine, 'func processBatch(limit: Int = 12) async throws -> Int {');
    const [gate, pending] = order(
      batch,
      'guard await ensureManifestReadyForUploads(accountId: batchAccountId, authToken: authToken, baseURL: baseURL) else {',
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
    const ready = body(engine, 'func ensureManifestReadyForUploads(accountId: String, authToken: String, baseURL: String) async -> Bool {');
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
    expect(ready.slice(deferredCase)).toMatch(/backoffUntil = Date\(\)\.addingTimeInterval\(wait\)/);

    // The steps report failure as nil, never as 0 / "nothing there".
    expect(ready).toMatch(/guard BackupManifestStore\.claim\(db, accountId: accountId, nowMs: self\.nowMs\(\)\) != nil else \{ return nil \}/);
    expect(ready).toMatch(/guard let needs = BackupManifestStore\.needsServerRebuild\(db, accountId: accountId\) else \{ return nil \}/);
    expect(ready).toMatch(/applyMap: \{ \[weak self\] map in[\s\S]*?guard let db = self\.db else \{ return nil \}[\s\S]*?return BackupManifestStore\.applyServerMap\(/);
    const stepsSrc = ready.slice(0, ready.indexOf('let outcome = await ManifestRebuildGate.run('));
    expect(stepsSrc.length).toBeGreaterThan(0);
    expect(stepsSrc).not.toMatch(/\?\? 0/);
    expect(ready).toMatch(/guard let self, let deviceId = self\.backupDeviceId, !deviceId\.isEmpty else \{\s*throw/);
    const kept = body(engine, 'func applyKeptPendingMarks(accountId: String) -> Int? {');
    expect(kept).toMatch(/guard let db = self\.db else \{ return nil \}/);
    expect(kept).not.toMatch(/\?\? 0/);
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
    const scan = body(engine, 'func scanPhotoLibraryForPendingUploads(reason: String) async -> Bool {');
    const [rebuild, flush] = order(scan, 'await ensureManifestReadyForUploads(', 'await flushServerMarks(');
    expect(rebuild).toBeGreaterThan(-1);
    expect(flush).toBeGreaterThan(rebuild);
  });

  test('the map calls send the device id the server keys photo_backup_state by', () => {
    const fetch = body(engine, 'private func fetchServerIdentifierMap(');
    const mark = body(engine, 'func markOnServer(');
    for (const b of [fetch, mark]) expect(b).toMatch(/setValue\(deviceId, forHTTPHeaderField: "X-Beebeeb-Device-Id"\)/);
    expect(fetch).toMatch(/\/api\/v1\/files\/photo-backup\/identifiers/);
    expect(mark).toMatch(/\/api\/v1\/files\/photo-backup\/mark/);
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
    expect(fetch).toMatch(/return try PhotoBackupServerResponses\.identifierMap\(statusCode: statusCode, data: data\)\s*$/);
    // The "server without the route" compatibility path is gone, prose included.
    expect(engine).not.toMatch(/server without the route/);
  });

  test('a mark is recorded only when the shipped classifier says so (2xx, or 404 with the API NotFound body)', () => {
    const mark = body(engine, 'func markOnServer(');
    expect(mark).not.toMatch(/statusCode == 404/);
    expect(mark).toMatch(/PhotoBackupServerResponses\.markOutcome\(/);
    expect(mark).toMatch(/contentType: http\?\.value\(forHTTPHeaderField: "Content-Type"\)/);
    const [guard, record] = order(mark, 'guard outcome.recordsServerMark else {', 'BackupManifestStore.recordServerMarked(');
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
  const start = () => body(engine, '  func start() {');
  const ensureForStart = () => body(engine, 'private func ensureManifestOpenForStart(accountId: String) -> Bool {');

  test('start() checks the manifest after the account guard and BEFORE both the running branch and isRunning = true', () => {
    const [accountGuard, ensure, runningBranch, setRunning] = order(
      start(),
      'guard let accountId = currentAccountId, !accountId.isEmpty else {',
      'guard ensureManifestOpenForStart(accountId: accountId) else { return }',
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
      'stop()',
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
    expect(retry).toMatch(/guard let self, self\.currentAccountId == accountId else \{ return \}/);
    expect(retry).toMatch(/self\.start\(\)/);
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
    const stop = body(engine, '  func stop() {');
    const [clear, guardRunning] = order(stop, 'clearManifestAvailability()', 'guard isRunning else { return }');
    expect(clear).toBeGreaterThan(-1);
    expect(guardRunning).toBeGreaterThan(clear);
    const prep = body(engine, 'func prepareForStoragePurge() -> (kept: Set<String>, resetFailed: Bool) {');
    expect(prep).toMatch(/clearManifestAvailability\(\)/);
  });

  test('the reason is visible: progress dict, status state, manual trigger error, JS context and Settings', () => {
    expect(engine).toMatch(/"manifestUnavailableReason": manifestUnavailableStopReason \?\? NSNull\(\)/);
    const state = body(engine, 'private func backupState(pending: Int) -> (state: String, reason: String) {');
    expect(state.indexOf('manifestUnavailableStopReason')).toBeGreaterThan(-1);
    expect(state.indexOf('manifestUnavailableStopReason')).toBeLessThan(state.indexOf('if isPaused'));
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
      const idx = order(
        site,
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
    const ins = body(engine, 'private func insertNewAssets(_ assets: [PHAsset]) {');
    expect(ins).toMatch(/let inserted = BackupManifestStore\.insertScannedAssets\(db, scanned, nowMs: nowMs\(\)\)\s*lastScanInsertFailed = !inserted/);
    const ready = body(engine, 'func ensureManifestReadyForUploads(accountId: String, authToken: String, baseURL: String) async -> Bool {');
    expect(ready).toMatch(/if needs && self\.lastScanInsertFailed \{ return nil \}\s*return needs/);
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
      'pendingMarksSnapshot(db, nowMs: nowMs)',
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
    const reset = body(handleSwift, 'func resetForSignOut(outgoingAccountId: String?) -> Bool {');
    expect(reset).toMatch(/adopted = BackupManifestStore\.adoptUnowned\(db, accountId: outgoingAccountId\) != nil/);
    expect(reset).toMatch(/if adopted, BackupManifestStore\.resetInPlace\(db, nowMs: now\(\)\) \{/);
  });

  test('a mark list that could not be read is traced, never read as "all marked"', () => {
    const flush = body(engine, 'func flushServerMarks(accountId: String, authToken: String, baseURL: String, limit: Int = 300) async {');
    expect(flush).toMatch(/guard let rows = loaded else \{\s*RuntimeTrace\.event\("backup\.native\.server_mark\.load_failed"/);
    const signOut = body(engine, 'func flushServerMarksForSignOut(');
    expect(signOut).toMatch(/if BackupManifestStore\.adoptUnowned\(db, accountId: accountId\) == nil \{\s*RuntimeTrace\.event/);
    expect(signOut).toMatch(/guard let rows = BackupManifestStore\.pendingServerMarks\(db, accountId: accountId, limit: Int\(Int32\.max\)\) else \{\s*RuntimeTrace\.event/);
  });
});
