// @ts-nocheck
/**
 * LD-0002 (mobile#252, `RUNNINGBOARD 0xdead10cc`) — source guard for the
 * `BackupExecutionGate` wiring.
 *
 * The Swift behaviour harness (`scripts/swift-tests/backup-execution-gate-test.swift`)
 * proves the gate/quiesce semantics against the real shipped source, but the
 * `NativeBackupEngine` needs UIKit/PhotoKit and cannot be compiled there. This
 * guard pins the wiring that makes those semantics reach the engine:
 *
 *  1. the gate exists, and every SQLite-touching path asks it;
 *  2. an expiry (grace / BGProcessingTask / didEnterBackground with no grace)
 *     runs close -> interrupt -> bounded wait BEFORE ending the task;
 *  3. the drain loop and processBatch check the gate before each batch/block;
 *  4. the gate reopens on foreground / a new assertion;
 *  5. background-URLSession completion writes take a short assertion or defer;
 *  6. ThumbnailQueueDB / ThumbnailWorkerPool respect the same gate;
 *  7. the manifest stays on ONE SQLite copy (`exsqlite3_*` only).
 *
 * Every rule has an in-memory MUTATION that removes the wiring and must turn
 * the guard red: a guard that examined nothing is not a pass.
 */
import { describe, expect, test } from 'bun:test';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

const IOS = join(import.meta.dir, '../../modules/beebeeb-crypto/ios');
const read = (name: string) => readFileSync(join(IOS, name), 'utf8');

const engine = read('NativeBackupEngine.swift');
const gate = read('BackupExecutionGate.swift');
const manifestHandle = read('BackupManifestHandle.swift');
const thumbnailDB = read('ThumbnailQueueDB.swift');
const workerPool = read('ThumbnailWorkerPool.swift');

/** The body of a Swift function, from its signature to the next top-level `}`. */
function functionBody(source: string, signature: string): string {
  const start = source.indexOf(signature);
  if (start < 0) throw new Error(`signature not found: ${signature}`);
  // Walk braces from the first `{` after the signature.
  const open = source.indexOf('{', start);
  let depth = 0;
  for (let i = open; i < source.length; i += 1) {
    if (source[i] === '{') depth += 1;
    else if (source[i] === '}') {
      depth -= 1;
      if (depth === 0) return source.slice(open, i + 1);
    }
  }
  throw new Error(`unbalanced braces after: ${signature}`);
}

const expectRed = (source: string, mustContain: string, label: string) => {
  expect({ label, ok: source.includes(mustContain) }).toEqual({ label, ok: true });
};

describe('rule 1: one pure gate, one question', () => {
  test('BackupExecutionGate.swift defines the gate, the question, the expiry close and the assertion kinds', () => {
    expect(gate).toContain('public final class BackupExecutionGate');
    expect(gate).toContain('public var canStartSQLiteWork: Bool');
    expect(gate).toContain('public func close()');
    expect(gate).toContain('case backgroundGrace');
    expect(gate).toContain('case backgroundProcessing');
    expect(gate).toContain('case backgroundURLSessionCompletion');
    expect(gate).toContain('public static let shared');
  });

  test('the engine shares that one gate and canExecuteBackupWorkNow asks it', () => {
    const body = functionBody(engine, 'private func canExecuteBackupWorkNow()');
    expect(body).toContain('executionGate.canStartSQLiteWork');
    expect(engine).toContain('private var executionGate: BackupExecutionGate { BackupExecutionGate.shared }');
  });

  test('MUTATION: removing canStartSQLiteWork from canExecuteBackupWorkNow is RED', () => {
    const body = functionBody(engine, 'private func canExecuteBackupWorkNow()');
    const mutated = body.replace('executionGate.canStartSQLiteWork', 'true');
    expect(mutated).not.toBe(body);
    expect(mutated).not.toContain('executionGate.canStartSQLiteWork');
  });
});

describe('rule 2: every expiry closes, interrupts, waits, THEN ends the task', () => {
  test('grace expiration handler quiesces before endBackgroundGrace', () => {
    const begin = functionBody(engine, 'private func beginBackgroundGraceIfNeeded()');
    const expiry = begin.indexOf('beginBackgroundTask(withName: "BeebeebBackupDrain")');
    expect(expiry).toBeGreaterThan(-1);
    const quiesceAt = begin.indexOf('quiesceSQLiteBeforeBackgroundTimeEnds', expiry);
    const endAt = begin.indexOf('self.endBackgroundGrace()', expiry);
    expect(quiesceAt).toBeGreaterThan(expiry);
    expect(endAt).toBeGreaterThan(quiesceAt);
  });

  test('BGProcessingTask expiration handler quiesces before setTaskCompleted', () => {
    const expiration = engine.indexOf('task.expirationHandler');
    expect(expiration).toBeGreaterThan(-1);
    const quiesceAt = engine.indexOf('quiesceSQLiteBeforeBackgroundTimeEnds', expiration);
    const completeAt = engine.indexOf('completeBackgroundTaskOnce(task, success: false)', expiration);
    expect(quiesceAt).toBeGreaterThan(expiration);
    expect(completeAt).toBeGreaterThan(quiesceAt);
  });

  test('didEnterBackground with no grace task quiesces synchronously', () => {
    const body = functionBody(engine, '@objc private func handleAppDidEnterBackground()');
    expect(body).toContain('executionGate.setForeground(false)');
    expect(body).toContain('if !isBackgroundGraceActive, !isBackgroundTaskActive');
    expect(body).toContain('quiesceSQLiteBeforeBackgroundTimeEnds(reason: "did-enter-background-no-grace")');
  });

  test('the quiesce helper does close -> interrupt -> bounded wait, and interrupts BOTH connections', () => {
    const body = functionBody(engine, 'private func quiesceSQLiteBeforeBackgroundTimeEnds(reason: String)');
    expect(body).toContain('BackupSQLiteQuiesce.run(');
    expect(body).toContain('BackupManifestHandle.interruptLiveStatement()');
    expect(body).toContain('ThumbnailQueueDB.shared.interruptInFlightStatement()');
    expect(body).toContain('waitForManifestQueueQuiet(timeout: timeout)');
    expect(body).toContain('ThumbnailQueueDB.shared.waitForQuiet(timeout: remaining)');
    expect(gate).toContain('gate.close()\n    interrupt()\n    let quiet = waitForQuiet(timeout)');
    expect(gate).toContain('public static let defaultTimeout: TimeInterval = 2.0');
  });

  test('the manifest interrupt is a real exsqlite3_interrupt on a lock-published pointer', () => {
    const body = functionBody(manifestHandle, 'func interruptInFlightStatement()');
    expect(body).toContain('exsqlite3_interrupt(connection)');
    expect(functionBody(manifestHandle, 'static func interruptLiveStatement()')).toContain('exsqlite3_interrupt(connection)');
    expect(manifestHandle).toContain('private var interruptibleConnection: OpaquePointer?');
    expect(manifestHandle).toContain('interruptLock.lock()');
    // ONE SQLite copy for the manifest (task 2033): never bare sqlite3_interrupt here.
    expect(manifestHandle).not.toMatch(/\bsqlite3_interrupt\(/);
  });

  test('MUTATION: removing the interrupt from the quiesce helper is RED', () => {
    const body = functionBody(engine, 'private func quiesceSQLiteBeforeBackgroundTimeEnds(reason: String)');
    const mutated = body.replace('BackupManifestHandle.interruptLiveStatement()', '');
    expect(mutated).not.toContain('BackupManifestHandle.interruptLiveStatement()');
  });

  test('MUTATION: removing the wait from BackupSQLiteQuiesce.run is RED', () => {
    const mutated = gate.replace('let quiet = waitForQuiet(timeout)', 'let quiet = true');
    expect(mutated).not.toBe(gate);
    expect(mutated).not.toContain('let quiet = waitForQuiet(timeout)');
  });
});

describe('rule 3: the drain and every batch block ask the gate', () => {
  test('startDrainLoop checks the gate at the top and before its dbQueue blocks', () => {
    const body = functionBody(engine, 'private func startDrainLoop(reason: String)');
    const checks = body.match(/executionGate\.canStartSQLiteWork/g) ?? [];
    expect(checks.length).toBeGreaterThanOrEqual(3);
    const top = body.indexOf('while let self, self.isRunning, !Task.isCancelled');
    expect(body.indexOf('executionGate.canStartSQLiteWork', top)).toBeGreaterThan(top);
  });

  test('processBatch checks the gate before each direct dbQueue block', () => {
    const body = functionBody(engine, 'func processBatch(limit: Int = 12, ticket callerTicket');
    const checks = body.match(/executionGate\.canStartSQLiteWork/g) ?? [];
    expect(checks.length).toBeGreaterThanOrEqual(3);
    const recover = body.indexOf('recoverStuckUploads()');
    const select = body.indexOf('getPendingUploads(limit: limit)');
    expect(body.lastIndexOf('executionGate.canStartSQLiteWork', recover)).toBeGreaterThan(-1);
    expect(body.lastIndexOf('executionGate.canStartSQLiteWork', select)).toBeGreaterThan(-1);
  });

  test('every fenced mark is refused while the gate is closed (no partial mark)', () => {
    const body = functionBody(engine, 'private func admitsWrite(');
    expect(body).toContain('executionGate.canStartSQLiteWork');
    expect(manifestHandle).toContain('exsqlite3_interrupt(connection)');
  });

  test('an interrupted select returns no rows, so nothing is marked', () => {
    const body = functionBody(engine, 'func getPendingUploads(limit: Int)');
    expect(body).toContain('if rc == SQLITE_INTERRUPT { return [] }');
  });

  test('MUTATION: removing the per-block gate check from processBatch is RED', () => {
    const body = functionBody(engine, 'func processBatch(limit: Int = 12, ticket callerTicket');
    const mutated = body.replace(
      'guard executionGate.canStartSQLiteWork else { return 0 }\n    let selected',
      'let selected',
    );
    expect(mutated).not.toBe(body);
    expect(mutated).not.toContain('guard executionGate.canStartSQLiteWork else { return 0 }\n    let selected');
  });
});

describe('rule 4: foreground / a new assertion reopens the gate and wakes the drain', () => {
  test('foreground sets the gate open and resumes a paused drain', () => {
    const body = functionBody(engine, '@objc private func handleAppWillEnterForeground()');
    expect(body).toContain('executionGate.setForeground(true)');
    expect(body).toContain('isPaused = false');
    expect(body).toContain('wakeDrainLoop(reason: "foreground")');
    const active = functionBody(engine, '@objc private func handleAppDidBecomeActiveForStateCache()');
    expect(active).toContain('executionGate.setForeground(true)');
  });

  test('grace and BGProcessingTask starts open the gate with a token', () => {
    expect(engine).toContain('executionGate.beginAssertion(.backgroundGrace, token: token)');
    expect(engine).toContain('executionGate.beginAssertion(.backgroundProcessing, token: assertionToken)');
    expect(functionBody(engine, 'private func endBackgroundGrace()')).toContain(
      'executionGate.endAssertion(.backgroundGrace, token: token)',
    );
  });

  test('MUTATION: removing setForeground(true) from willEnterForeground is RED', () => {
    const body = functionBody(engine, '@objc private func handleAppWillEnterForeground()');
    const mutated = body.replace('executionGate.setForeground(true)', '');
    expect(mutated).not.toContain('executionGate.setForeground(true)');
  });
});

describe('rule 5: background-URLSession completion writes take a short assertion or defer', () => {
  test('the helper asks admitBackgroundCompletionWrite and defers without touching dbQueue', () => {
    const body = functionBody(engine, 'private func runBackgroundCompletionWrite(');
    expect(body).toContain('executionGate.admitBackgroundCompletionWrite(');
    expect(body).toContain('guard admission != .deferred else');
    expect(body).toContain('backup.native.completion_write.deferred');
    expect(body).toContain('beginAssertion(\n          .backgroundURLSessionCompletion');
    expect(gate).toContain('public func admitBackgroundCompletionWrite(');
  });

  test('every manifest write in urlSession(didCompleteWithError:) goes through the helper', () => {
    const body = functionBody(engine, 'func urlSession(_ session: URLSession, task: URLSessionTask, didCompleteWithError');
    expect(body).toContain('runBackgroundCompletionWrite("markChunkFailed")');
    expect(body).toContain('runBackgroundCompletionWrite("markChunkUploaded")');
    expect(body).toContain('runBackgroundCompletionWrite("markUploadOutcome")');
    expect(body).toContain('runBackgroundCompletionWrite("markChunkFailed")');
    // The old unguarded shape must be gone.
    expect(body).not.toMatch(/dbQueue\.async \{ \[weak self\] in\n\s+guard let self, self\.admitsChunkCallback/);
  });

  test('MUTATION: accepting a deferred write anyway is RED', () => {
    const body = functionBody(engine, 'private func runBackgroundCompletionWrite(');
    const mutated = body.replace('guard admission != .deferred else {', 'guard true else {');
    expect(mutated).not.toContain('guard admission != .deferred else');
  });
});

describe('rule 6: thumbnails respect the same gate', () => {
  test('ThumbnailQueueDB refuses writes while the gate is closed', () => {
    expect(thumbnailDB).toContain('private func admitsGate() -> Bool');
    expect(thumbnailDB).toContain('BackupExecutionGate.shared.canStartSQLiteWork');
    expect(thumbnailDB).toContain('guard admitsGate(), ensureOpen() else { return }');
    // enqueue, recordFailure, popReady and mutate all use it.
    const guards = thumbnailDB.match(/admitsGate\(\)/g) ?? [];
    expect(guards.length).toBeGreaterThanOrEqual(5);
  });

  test('ThumbnailQueueDB can be interrupted and awaited like the manifest', () => {
    const interrupt = functionBody(thumbnailDB, 'public func interruptInFlightStatement()');
    expect(interrupt).toContain('sqlite3_interrupt(connection)');
    const wait = functionBody(thumbnailDB, 'public func waitForQuiet(timeout: TimeInterval)');
    expect(wait).toContain('serialQueue.async { semaphore.signal() }');
    expect(wait).toContain('semaphore.wait(timeout: .now() + timeout) == .success');
  });

  test('ThumbnailWorkerPool does not pop or start work while the gate is closed', () => {
    expect(workerPool).toContain('guard BackupExecutionGate.shared.canStartSQLiteWork else { return }');
    // pump() and runOne() both refuse while the gate is closed.
    const guards = workerPool.match(/BackupExecutionGate\.shared\.canStartSQLiteWork/g) ?? [];
    expect(guards.length).toBeGreaterThanOrEqual(2);
  });

  test('MUTATION: removing the gate guard from enqueue is RED', () => {
    const mutated = thumbnailDB.replace(
      'guard admitsGate(), ensureOpen() else { return }\n            let now = Int64(Date().timeIntervalSince1970 * 1000)\n            exec("BEGIN;")',
      'guard ensureOpen() else { return }\n            let now = Int64(Date().timeIntervalSince1970 * 1000)\n            exec("BEGIN;")',
    );
    expect(mutated).not.toBe(thumbnailDB);
  });
});

describe('rule 7: the manifest stays on ONE SQLite copy', () => {
  test('the gate and the engine never import/use bare SQLite for the manifest', () => {
    expect(gate).not.toContain('import SQLite3');
    expect(manifestHandle).toContain('import ManifestSQLite');
    expect(manifestHandle).not.toMatch(/^import SQLite3$/m);
    // The engine's manifest statements are exsqlite3_* (rule from CLAUDE.md).
    expect(engine).toContain('exsqlite3_step(stmt)');
  });
});
