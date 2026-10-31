// @ts-nocheck
/**
 * Task LD-0002 (TestFlight 252, `RUNNINGBOARD 0xdead10cc`) — structural guards
 * on the engine wiring of the backup execution gate.
 *
 * The behaviour is tested for real by swiftc + SQLite:
 * `scripts/swift-tests/backup-execution-gate-test.swift` (the gate, the
 * quiesce order, B2/B3/B4 semantics), `manifest-background-quiesce-test.swift`
 * (a real manifest handle: interrupt, nothing after the quiesce, B4 close
 * order, B5 chunk replace) and `thumbnail-queue-quiesce-test.swift` (B5, B7).
 * `NativeBackupEngine.swift` needs UIKit/PhotoKit and cannot be compiled
 * there, so what only the engine can get wrong is pinned here:
 *
 *   1. every engine statement starts from `db`, which asks the gate;
 *   2. B1: both expiry handlers quiesce FIRST and end their task LAST, and
 *      the status surfaces in between read no SQLite (cached counts);
 *   3. every other end of a background task quiesces before it ends;
 *   4. `didEnterBackground` with no grace task quiesces before returning;
 *   5. B6: foreground keeps a user's Pause;
 *   6. B2/B3: completion writes run under their own assertion, re-ask the
 *      gate when they run, and their expiry interrupts and waits;
 *   7. the drain and the batch stop when the gate closes;
 *   8. B4: the manifest handle and the thumbnail queue withdraw the interrupt
 *      target before they close; every thumbnail statement asks the gate.
 *
 * Each check is a function run on the real source (must pass) AND on an
 * in-memory mutation of it that undoes the fix (must fail): a guard that cannot
 * go red is not a guard.
 */
import { describe, expect, test } from 'bun:test';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

const IOS = join(import.meta.dir, '../../modules/beebeeb-crypto/ios');
const engine = readFileSync(join(IOS, 'NativeBackupEngine.swift'), 'utf8');
const handle = readFileSync(join(IOS, 'BackupManifestHandle.swift'), 'utf8');
const thumbnailDB = readFileSync(join(IOS, 'ThumbnailQueueDB.swift'), 'utf8');

/** Strip `//` comments so prose that names a call never counts as the call. */
function code(s: string): string {
  return s.replace(/\/\/[^\n]*/g, '');
}

/** The `{ ... }` body that follows the first `marker` (brace matched), comments stripped. */
function body(src: string, marker: string): string {
  const at = src.indexOf(marker);
  if (at < 0) throw new Error(`marker not found: ${marker}`);
  // The marker's own last `{` opens the body (`... { [weak self] in`); else the next one.
  const inMarker = marker.lastIndexOf('{');
  const open = inMarker >= 0 ? at + inMarker : src.indexOf('{', at + marker.length);
  let depth = 0;
  for (let i = open; i < src.length; i += 1) {
    if (src[i] === '{') depth += 1;
    else if (src[i] === '}') {
      depth -= 1;
      if (depth === 0) return code(src.slice(open + 1, i));
    }
  }
  throw new Error(`unbalanced after: ${marker}`);
}

/** The statements of a body, one per non-empty line. */
function lines(b: string): string[] {
  return b
    .split('\n')
    .map((l) => l.trim())
    .filter((l) => l.length > 0);
}

/** `needles` appear in this order in `hay` (each after the previous). */
function inOrder(hay: string, needles: string[]): boolean {
  let at = -1;
  for (const n of needles) {
    const next = hay.indexOf(n, at + 1);
    if (next < 0) return false;
    at = next;
  }
  return true;
}

/** Run `check` on the real source and on `mutate(source)`: green, then red. */
function guarded(name: string, source: string, check: (s: string) => boolean, mutate: (s: string) => string) {
  test(name, () => {
    expect(check(source)).toBe(true);
    const mutated = mutate(source);
    expect(mutated).not.toBe(source);
    let mutatedPasses: boolean;
    try {
      mutatedPasses = check(mutated);
    } catch {
      mutatedPasses = false;
    }
    expect({ name, mutatedPasses }).toEqual({ name, mutatedPasses: false });
  });
}

const GRACE = 'beginBackgroundTask(withName: "BeebeebBackupDrain") { [weak self] in';
const BG_EXPIRY = 'task.expirationHandler = { [weak self] in';

describe('1. one choke point: every engine statement starts from the gated `db`', () => {
  guarded(
    'the engine db is the handle connection admitted by the gate',
    engine,
    (s) =>
      /private var db: OpaquePointer\? \{ manifestHandle\.connection\(admittedBy: executionGate, completionWrite: completionWriteAssertion\) \}/.test(
        s,
      ) && /private var executionGate: BackupExecutionGate \{ BackupExecutionGate\.shared \}/.test(s),
    (s) =>
      s.replace(
        'private var db: OpaquePointer? { manifestHandle.connection(admittedBy: executionGate, completionWrite: completionWriteAssertion) }',
        'private var db: OpaquePointer? { manifestHandle.db }',
      ),
  );
  guarded(
    'the handle admits its connection only through the gate',
    handle,
    (s) => /gate\.admitsStatement\(completionWrite: completionWrite\) \? db : nil/.test(code(body(s, 'func connection('))),
    (s) => s.replace('gate.admitsStatement(completionWrite: completionWrite) ? db : nil', 'db'),
  );
  test('the engine opens no SQLite connection of its own (every statement needs `db`)', () => {
    const c = code(engine);
    expect(c.match(/exsqlite3_open(?:_v2)?\(/g) ?? []).toHaveLength(0);
    expect(c.match(/manifestHandle\.db\b/g) ?? []).toHaveLength(0);
  });
});

describe('2. B1: expiry handlers quiesce first, end the task last, read no SQLite between', () => {
  guarded(
    'grace expiry: quiesce -> surfaces -> reminder -> end the task (last statement)',
    engine,
    (s) => {
      const b = body(s, GRACE);
      const l = lines(b);
      return (
        inOrder(b, [
          'self.quiesceSQLiteBeforeBackgroundTimeEnds(reason: "grace-expiry")',
          'self.updateBackupStatusSurfaces(reason: "Open Beebeeb to continue")',
          'self.scheduleOpenAppReminderIfNeeded()',
          'self.endBackgroundGrace(quiesced: true)',
        ]) && l[l.length - 1] === 'self.endBackgroundGrace(quiesced: true)'
      );
    },
    // round 1's order: end the task, then read the status surfaces
    (s) =>
      s.replace(
        'self.quiesceSQLiteBeforeBackgroundTimeEnds(reason: "grace-expiry")\n        self.updateBackupStatusSurfaces(reason: "Open Beebeeb to continue")\n        self.scheduleOpenAppReminderIfNeeded()\n        self.endBackgroundGrace(quiesced: true)',
        'self.quiesceSQLiteBeforeBackgroundTimeEnds(reason: "grace-expiry")\n        self.endBackgroundGrace(quiesced: true)\n        self.updateBackupStatusSurfaces(reason: "Open Beebeeb to continue")\n        self.scheduleOpenAppReminderIfNeeded()',
      ),
  );
  guarded(
    'BGProcessingTask expiry: quiesce first, complete the task last',
    engine,
    (s) => {
      const l = lines(body(s, BG_EXPIRY)).filter(
        (x) => x !== '[weak self] in' && !x.startsWith('NSLog') && x !== 'guard let self else { return }',
      );
      return (
        l[0] === 'self.quiesceSQLiteBeforeBackgroundTimeEnds(reason: "background-processing-expiry")' &&
        l[l.length - 1] === 'self.completeBackgroundTaskOnce(task, success: false, quiesced: true)'
      );
    },
    (s) => s.replace('      self.quiesceSQLiteBeforeBackgroundTimeEnds(reason: "background-processing-expiry")\n', ''),
  );
  guarded(
    'the status payload reads through readIfUninterrupted and falls back to the last good counts',
    engine,
    (s) => {
      const counts = body(s, 'private func statusCounts() -> BackupStatusCounts {');
      const payload = body(s, 'private func makeBackupStatusPayload(reason explicitReason: String? = nil) -> BackupStatusPayload {');
      return (
        counts.includes('executionGate.readIfUninterrupted') &&
        counts.includes('return lastStatusCounts') &&
        payload.includes('let counts = statusCounts()') &&
        !/refreshProgress\(\)|pendingUploadCount\(\)|backupWorkBreakdown\(\)|latestUploadedAt\(\)/.test(payload)
      );
    },
    (s) => s.replace('let counts = statusCounts()', 'refreshProgress()\n    let counts = statusCounts()'),
  );
  guarded(
    'refreshProgress assigns its counters only from an uninterrupted read',
    engine,
    (s) => {
      const b = body(s, 'private func refreshProgress() {');
      return b.includes('executionGate.readIfUninterrupted') && b.includes('guard let reads else { return }');
    },
    (s) => s.replace('guard let reads else { return }', 'guard let reads = reads ?? ProgressReads(total: 0, completed: 0, failed: 0, inProgress: 0, bytesTotal: 0, bytesUploaded: 0, uploadedChunkBytes: 0) as ProgressReads? else { return }'),
  );
});

describe('3. every other end of background time quiesces before the task ends', () => {
  guarded(
    'endBackgroundGrace: assertion ends, quiesce when the gate closed, THEN endBackgroundTask',
    engine,
    (s) =>
      inOrder(body(s, 'private func endBackgroundGrace(quiesced: Bool = false) {'), [
        'self.executionGate.endAssertion(assertion)',
        'if !quiesced, !self.executionGate.canStartSQLiteWork {',
        'self.quiesceSQLiteBeforeBackgroundTimeEnds(reason: "grace-end")',
        'UIApplication.shared.endBackgroundTask(task)',
      ]),
    (s) => s.replace('        self.quiesceSQLiteBeforeBackgroundTimeEnds(reason: "grace-end")\n', ''),
  );
  guarded(
    'completeBackgroundTaskOnce: assertion ends, quiesce when the gate closed, THEN setTaskCompleted',
    engine,
    (s) =>
      inOrder(body(s, 'private func completeBackgroundTaskOnce(_ task: BGProcessingTask, success: Bool, quiesced: Bool = false) {'), [
        'executionGate.endAssertion(assertion)',
        'if !quiesced, !executionGate.canStartSQLiteWork {',
        'quiesceSQLiteBeforeBackgroundTimeEnds(reason: "background-processing-end")',
        'task.setTaskCompleted(success: success)',
      ]),
    (s) => s.replace('        quiesceSQLiteBeforeBackgroundTimeEnds(reason: "background-processing-end")\n', ''),
  );
  guarded(
    'the quiesce interrupts BOTH stores and waits on dbQueue and the thumbnail queue',
    engine,
    (s) => {
      const b = body(s, 'private func quiesceSQLiteBeforeBackgroundTimeEnds(reason: String) -> BackupSQLiteQuiesce.Outcome {');
      return (
        b.includes('BackupSQLiteQuiesce.run(') &&
        b.includes('NativeBackupEngine.manifestInterrupt.interrupt()') &&
        b.includes('ThumbnailQueueDB.shared.interruptInFlightStatement()') &&
        b.includes('BackupSQLiteQuiesce.waitForSerialQueue(self.dbQueue, timeout: timeout)') &&
        b.includes('ThumbnailQueueDB.shared.waitForQuiet(')
      );
    },
    (s) => s.replace('        NativeBackupEngine.manifestInterrupt.interrupt()\n        ThumbnailQueueDB.shared.interruptInFlightStatement()\n', ''),
  );
  guarded(
    'the manifest handle publishes to the engine interrupt target',
    engine,
    (s) => /interruptTarget: NativeBackupEngine\.manifestInterrupt,/.test(s) && /SQLiteInterruptTarget \{ exsqlite3_interrupt\(\$0\) \}/.test(s),
    (s) => s.replace('    interruptTarget: NativeBackupEngine.manifestInterrupt,\n', ''),
  );
  guarded(
    'grace and BGProcessingTask starts open the gate before their work',
    engine,
    (s) =>
      inOrder(body(s, 'let begin: () -> Void = { [weak self] in'), [
        'self.executionGate.beginAssertion(.backgroundGrace)',
        'UIApplication.shared.beginBackgroundTask(withName: "BeebeebBackupDrain")',
        'self.wakeDrainLoop(reason: "background-grace")',
      ]) && inOrder(body(s, 'private func handleBackgroundTask(_ task: BGProcessingTask) {'), ['executionGate.beginAssertion(.backgroundProcessing)', 'let bgTask = Task {']),
    (s) => s.replace('backgroundTaskAssertion = executionGate.beginAssertion(.backgroundProcessing)', 'backgroundTaskAssertion = nil'),
  );
});

describe('4. didEnterBackground with no grace task quiesces before it returns', () => {
  guarded(
    'the foreground gate closes after the reads, then quiesces when nothing holds it open (last statements)',
    engine,
    (s) => {
      const b = body(s, '@objc private func handleAppDidEnterBackground() {');
      const l = lines(b);
      return (
        inOrder(b, [
          'beginBackgroundGraceIfNeeded()',
          'updateBackupStatusSurfaces(reason: "Open Beebeeb to continue")',
          'logDiagnosticSnapshot(reason: "app_background")',
          'executionGate.setForeground(false)',
          'if !executionGate.canStartSQLiteWork {',
          'quiesceSQLiteBeforeBackgroundTimeEnds(reason: "did-enter-background-no-grace")',
        ]) && l[l.length - 1] === '}'
      );
    },
    (s) => s.replace('      quiesceSQLiteBeforeBackgroundTimeEnds(reason: "did-enter-background-no-grace")\n', ''),
  );
});

describe('5. B6: foreground keeps a user Pause', () => {
  guarded(
    'willEnterForeground reopens the gate first and wakes only an unpaused drain',
    engine,
    (s) => {
      const b = body(s, '@objc private func handleAppWillEnterForeground() {');
      return (
        inOrder(b, ['executionGate.setForeground(true)', 'endBackgroundGrace()', 'if isRunning, !isPaused, pendingUploadCount() > 0 {']) &&
        !/isPaused\s*=\s*false/.test(b)
      );
    },
    // round 1 (#257): `if isRunning { isPaused = false; wake }`
    (s) => s.replace('if isRunning, !isPaused, pendingUploadCount() > 0 {', 'if isRunning {\n      isPaused = false'),
  );
  guarded(
    'didBecomeActive reopens the gate too',
    engine,
    (s) => body(s, '@objc private func handleAppDidBecomeActiveForStateCache() {').includes('executionGate.setForeground(true)'),
    (s) => s.replace('    updateCachedApplicationState(.active)\n    executionGate.setForeground(true)\n', '    updateCachedApplicationState(.active)\n'),
  );
});

describe('6. B2/B3: completion writes', () => {
  const SIG = 'private func runBackgroundCompletionWrite(_ writer: String, _ body: @escaping () -> Void) {';
  guarded(
    'B2: the closed-gate path takes a completion-write assertion, never a general one, and scopes it to the block',
    engine,
    (s) => {
      const b = body(s, SIG);
      return (
        b.includes('self.executionGate.beginAssertion(.completionWrite)') &&
        !/beginAssertion\(\.background(?:Grace|Processing)\)/.test(b) &&
        inOrder(b, ['self.dbQueue.async {', 'self.completionWriteAssertion = assertion', 'body()', 'self.completionWriteAssertion = nil', 'self.executionGate.endAssertion(assertion)'])
      );
    },
    (s) => s.replace('self.executionGate.beginAssertion(.completionWrite)', 'self.executionGate.beginAssertion(.backgroundGrace)'),
  );
  guarded(
    'B2: its expiry withdraws the assertion, interrupts and waits BEFORE ending the task',
    engine,
    (s) =>
      inOrder(body(s, 'beginBackgroundTask(withName: "BeebeebCompletionWrite") { [weak self] in'), [
        'self?.executionGate.endAssertion(assertion)',
        'NativeBackupEngine.manifestInterrupt.interrupt()',
        'BackupSQLiteQuiesce.waitForSerialQueue(self.dbQueue, timeout: BackupSQLiteQuiesce.defaultTimeout)',
        'UIApplication.shared.endBackgroundTask(task)',
      ]),
    (s) => s.replace('          _ = BackupSQLiteQuiesce.waitForSerialQueue(self.dbQueue, timeout: BackupSQLiteQuiesce.defaultTimeout)\n', ''),
  );
  guarded(
    'no assertion: the write is deferred (no dbQueue block)',
    engine,
    (s) => inOrder(body(s, SIG), ['guard task != .invalid else {', 'self.executionGate.endAssertion(assertion)', 'backup.native.completion_write.deferred', 'return']),
    (s) => s.replace('backup.native.completion_write.deferred', 'backup.native.completion_write.ran_anyway'),
  );
  guarded(
    'B3: the open-gate path enqueues the body itself, whose statements re-ask the gate through `db`',
    engine,
    (s) => {
      const b = body(s, SIG);
      return b.includes('if executionGate.canStartSQLiteWork {\n      dbQueue.async(execute: body)') && !/let db = (?:self\.)?db/.test(b);
    },
    // a check-then-act that captures the connection before the block runs
    (s) => s.replace('      dbQueue.async(execute: body)\n', '      let db = self.db\n      dbQueue.async { _ = db; body() }\n'),
  );
  guarded(
    'every manifest write in didCompleteWithError goes through the helper',
    engine,
    (s) => {
      const b = body(s, 'func urlSession(_ session: URLSession, task: URLSessionTask, didCompleteWithError error: Error?) {');
      return (b.match(/runBackgroundCompletionWrite\("/g) ?? []).length === 6 && !b.includes('dbQueue.async');
    },
    (s) => s.replace('runBackgroundCompletionWrite("markUploadOutcome") { [weak self] in', 'dbQueue.async { [weak self] in'),
  );
});

describe('7. the drain and the batch stop when the gate closes', () => {
  guarded(
    'the drain loop asks the gate first in every iteration',
    engine,
    (s) => {
      const b = body(s, 'private func startDrainLoop(reason: String) {');
      return inOrder(b, ['while let self, self.isRunning, !Task.isCancelled {', 'guard self.executionGate.canStartSQLiteWork else {', 'break', 'if self.isPaused {']);
    },
    (s) => s.replace('        guard self.executionGate.canStartSQLiteWork else {\n          self.perfLog("drain.stop", ["reason": "background-time-ended"])\n          break\n        }\n', ''),
  );
  guarded(
    'processBatch asks the gate at its start and before the selection',
    engine,
    (s) => {
      const b = body(s, 'func processBatch(limit: Int = 12, ticket callerTicket: ManifestWriteFence.Ticket? = nil) async throws -> Int {');
      return (b.match(/guard executionGate\.canStartSQLiteWork else \{ return 0 \}/g) ?? []).length === 2 && inOrder(b, ['guard executionGate.canStartSQLiteWork else { return 0 }\n    let selected = dbQueue.sync { getPendingUploads(limit: limit) }']);
    },
    (s) => s.replace('    guard executionGate.canStartSQLiteWork else { return 0 }\n    let selected', '    let selected'),
  );
  guarded(
    'an interrupted selection (the 252 crash site) returns no rows',
    engine,
    (s) => body(s, 'func getPendingUploads(limit: Int) -> [BackupAssetRow] {').includes('if rc == SQLITE_INTERRUPT { return [] }'),
    (s) => s.replace('    if rc == SQLITE_INTERRUPT { return [] }\n', ''),
  );
  guarded(
    'B5: the engine replaces staged chunks through the one-transaction store function',
    engine,
    (s) => {
      const b = body(s, 'private func replaceStagedChunks(assetId: String, fileId: String, chunkPaths: [String]) {');
      return b.includes('BackupManifestStore.replaceStagedChunks(db,') && !/exsqlite3_/.test(b);
    },
    (s) => s.replace('if !BackupManifestStore.replaceStagedChunks(db, assetId: assetId, fileId: fileId, chunkPaths: chunkPaths) {', 'exsqlite3_exec(db, "DELETE FROM backup_upload_chunks", nil, nil, nil)\n    if !BackupManifestStore.replaceStagedChunks(db, assetId: assetId, fileId: fileId, chunkPaths: chunkPaths) {'),
  );
  guarded(
    'a manifest open retry does not run SQLite after background time ended',
    engine,
    (s) => inOrder(body(s, 'private func scheduleManifestOpenRetry(accountId: String, after delay: TimeInterval) {'), ['guard self.executionGate.canStartSQLiteWork else {', 'self.lifecycle.runRetry(']),
    (s) => s.replace('      guard self.executionGate.canStartSQLiteWork else {\n        RuntimeTrace.event("backup.native.manifest.open_retry_deferred")', '      guard true else {\n        RuntimeTrace.event("backup.native.manifest.open_retry_deferred")'),
  );
});

describe('8. B4 close order, and the thumbnail queue behind the gate', () => {
  guarded(
    'manifest handle: withdraw -> self.db = nil -> close, at both closes; publish right after the open',
    handle,
    (s) => {
      const c = code(s);
      const closes = c.match(/interruptTarget\?\.withdraw\(\)\n\s+self\.db = nil\n\s+close\(db\)/g) ?? [];
      return closes.length === 2 && (c.match(/self\.db = nil/g) ?? []).length === 2 && /db = opened\n\s+interruptTarget\?\.publish\(opened\)/.test(c);
    },
    // round 1 (#257): close, then clear
    (s) => s.replace('      interruptTarget?.withdraw()\n      self.db = nil\n      close(db)\n    }\n    pendingReset.set(true)', '      close(db)\n      interruptTarget?.withdraw()\n      self.db = nil\n    }\n    pendingReset.set(true)'),
  );
  guarded(
    'thumbnail queue: withdraw before every close of an open connection',
    thumbnailDB,
    (s) => {
      const c = code(s);
      return /interruptTarget\.withdraw\(\)\n\s+db = nil\n\s+sqlite3_close_v2\(handle\)\n\s+return removeDatabaseFiles\(\)/.test(c) && /interruptTarget\.withdraw\(\)\n\s+if let db \{ sqlite3_close_v2\(db\) \}/.test(c);
    },
    (s) => s.replace('            interruptTarget.withdraw()\n            db = nil\n            sqlite3_close_v2(handle)\n            return removeDatabaseFiles()', '            sqlite3_close_v2(handle)\n            interruptTarget.withdraw()\n            db = nil\n            return removeDatabaseFiles()'),
  );
  guarded(
    'thumbnail queue: every serialQueue block except the sign-out purge asks the gate before opening',
    thumbnailDB,
    (s) => {
      const c = code(s);
      const blocks = c.split('serialQueue.sync {').slice(1).map((rest) => rest.trimStart().split('\n')[0]);
      const purge = blocks.filter((l) => l.startsWith('// 7e') || l.startsWith('guard let handle = db'));
      const gated = blocks.filter((l) => l === 'guard admitted() else { return }');
      const admitted = body(s, 'private func admitted() -> Bool {');
      return blocks.length === 7 && purge.length === 1 && gated.length === 6 && admitted.indexOf('gate.canStartSQLiteWork') < admitted.indexOf('ensureOpen()');
    },
    (s) => s.replace('    public func popReady(limit: Int) -> [Item] {\n        var out: [Item] = []\n        serialQueue.sync {\n            guard admitted() else { return }', '    public func popReady(limit: Int) -> [Item] {\n        var out: [Item] = []\n        serialQueue.sync {\n            guard ensureOpen() else { return }'),
  );
});
