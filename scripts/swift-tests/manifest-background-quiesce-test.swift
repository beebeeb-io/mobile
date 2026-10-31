import Darwin
import Foundation
import ManifestSQLite

// Task LD-0002 (TestFlight 252, `RUNNINGBOARD 0xdead10cc`) — the background
// quiesce against a REAL manifest handle on expo's SQLite copy. Compiled with
// the shipped sources (BackupExecutionGate.swift, BackupManifestHandle.swift,
// BackupManifestStore.swift, ManifestRebuildGate.swift, ManifestWriteFence.swift)
// by scripts/swift-ci/run-swift-tests.sh.
//
// `NativeBackupEngine` itself needs UIKit/PhotoKit and is not compiled here;
// its `db` IS `manifestHandle.connection(admittedBy:completionWrite:)` and its
// expiry handlers run `BackupSQLiteQuiesce.run` with the handle's interrupt
// target and a `dbQueue` barrier (source guard:
// src/lib/backup-execution-gate-wiring.test.ts). Here a serial queue plays
// `dbQueue` and runs real statements on the real connection.
//
//   m1  expiry while a statement is in flight: the handler returns within
//       2 s with nothing in flight, the statement aborted (SQLITE_INTERRUPT)
//       (the 252 crash: thread 17 inside exsqlite3_step at suspension)
//   m2  after the quiesce no block gets a connection; foreground reopens
//   m3  B2: a completion write gets the connection, nothing else does
//   m4  B4: the handle withdraws its interrupt target before it closes, so a
//       close waits for an interrupt in flight and never frees it
//   m5  B5: a chunk replace interrupted on chunk 2 changes nothing (old rows
//       intact, no partial set); an uninterrupted one replaces them all

var failures: [String] = []
var total = 0
let failuresLock = NSLock()

func expect(_ condition: Bool, _ label: String) {
  failuresLock.lock()
  total += 1
  if !condition { failures.append(label) }
  failuresLock.unlock()
}

let fm = FileManager.default
let root = fm.temporaryDirectory.appendingPathComponent("bb-ld0002-quiesce-\(UUID().uuidString)", isDirectory: true)
try! fm.createDirectory(at: root, withIntermediateDirectories: true)
defer { try? fm.removeItem(at: root) }

// The engine's two tables (NativeBackupEngine.ensureTables), as the other
// manifest drivers declare them.
let schema = """
CREATE TABLE IF NOT EXISTS backup_assets (
  local_asset_id TEXT PRIMARY KEY,
  remote_file_id TEXT,
  remote_path TEXT,
  content_hash TEXT NOT NULL DEFAULT '',
  file_size INTEGER NOT NULL DEFAULT 0,
  created_at TEXT NOT NULL,
  uploaded_at TEXT,
  asset_type TEXT NOT NULL,
  status TEXT NOT NULL,
  queued_at INTEGER,
  last_attempt_at INTEGER,
  retry_count INTEGER DEFAULT 0,
  error_message TEXT,
  staged_file_id TEXT,
  staged_name_encrypted TEXT,
  staged_mime_type TEXT,
  staged_is_media INTEGER DEFAULT 0,
  staged_original_size INTEGER DEFAULT 0,
  staged_chunk_count INTEGER DEFAULT 0,
  staged_dir TEXT,
  staged_at INTEGER,
  upload_session_id TEXT,
  selected_for_backup INTEGER DEFAULT 1,
  staged_account_id TEXT
);
CREATE TABLE IF NOT EXISTS backup_upload_chunks (
  local_asset_id TEXT NOT NULL,
  server_file_id TEXT NOT NULL,
  chunk_index INTEGER NOT NULL,
  path TEXT NOT NULL,
  status TEXT NOT NULL,
  task_id INTEGER,
  last_error TEXT,
  uploaded_at INTEGER,
  PRIMARY KEY(local_asset_id, chunk_index)
);
"""

func prepareSchema(_ db: OpaquePointer) {
  exsqlite3_exec(db, schema, nil, nil, nil)
  BackupManifestStore.migrate(db)
}

final class PendingFlag {
  var pending = false
  var flag: BackupManifestHandle.ResetPendingFlag {
    BackupManifestHandle.ResetPendingFlag(get: { self.pending }, set: { self.pending = $0 })
  }
}

func makeHandle(_ name: String, target: SQLiteInterruptTarget) -> (BackupManifestHandle, PendingFlag) {
  let flag = PendingFlag()
  let handle = BackupManifestHandle(
    path: root.appendingPathComponent(name).path,
    pendingReset: flag.flag,
    interruptTarget: target,
    prepareSchema: prepareSchema
  )
  precondition(handle.openIfClosed() == nil, "open \(name)")
  return (handle, flag)
}

func scalar(_ db: OpaquePointer, _ sql: String) -> Int {
  var stmt: OpaquePointer?
  guard exsqlite3_prepare_v2(db, sql, -1, &stmt, nil) == SQLITE_OK else { return -1 }
  defer { exsqlite3_finalize(stmt) }
  guard exsqlite3_step(stmt) == SQLITE_ROW else { return -1 }
  return Int(exsqlite3_column_int64(stmt, 0))
}

func strings(_ db: OpaquePointer, _ sql: String) -> [String] {
  var stmt: OpaquePointer?
  guard exsqlite3_prepare_v2(db, sql, -1, &stmt, nil) == SQLITE_OK else { return [] }
  defer { exsqlite3_finalize(stmt) }
  var out: [String] = []
  while exsqlite3_step(stmt) == SQLITE_ROW {
    if let t = exsqlite3_column_text(stmt, 0) { out.append(String(cString: t)) }
  }
  return out
}

/// A statement that runs for minutes unless interrupted.
let endlessRead = "WITH RECURSIVE c(x) AS (SELECT 1 UNION ALL SELECT x + 1 FROM c WHERE x < 4000000000) SELECT count(*) FROM c"

final class Box<T> {
  private let lock = NSLock()
  private var value: T
  init(_ value: T) { self.value = value }
  var get: T { lock.lock(); defer { lock.unlock() }; return value }
  func set(_ v: T) { lock.lock(); value = v; lock.unlock() }
}

// MARK: - m1 + m2: expiry mid-statement, then nothing starts

do {
  let target = SQLiteInterruptTarget { exsqlite3_interrupt($0) }
  let (handle, _) = makeHandle("m1.db", target: target)
  expect(target.isPublished, "m1: the open published the connection for the interrupt")
  let gate = BackupExecutionGate(foreground: false)
  _ = gate.beginAssertion(.backgroundGrace)
  let dbQueue = DispatchQueue(label: "m1.dbQueue")
  let inFlight = Box(false)
  let rc = Box<Int32>(-1)
  let started = DispatchSemaphore(value: 0)
  dbQueue.async {
    guard let db = handle.connection(admittedBy: gate) else { started.signal(); return }
    var stmt: OpaquePointer?
    guard exsqlite3_prepare_v2(db, endlessRead, -1, &stmt, nil) == SQLITE_OK else { started.signal(); return }
    inFlight.set(true)
    started.signal()
    rc.set(exsqlite3_step(stmt))
    exsqlite3_finalize(stmt)
    inFlight.set(false)
  }
  started.wait()
  Thread.sleep(forTimeInterval: 0.2)
  expect(inFlight.get, "m1 setup: the statement is in flight when background time ends")

  let begun = Date()
  let outcome = BackupSQLiteQuiesce.run(
    gate: gate,
    interrupt: { target.interrupt() },
    waitForQuiet: { BackupSQLiteQuiesce.waitForSerialQueue(dbQueue, timeout: $0) }
  )
  let elapsed = Date().timeIntervalSince(begun)
  expect(outcome == .quiet, "m1: the queue went quiet before the handler would end the task (\(outcome.rawValue))")
  expect(elapsed < BackupSQLiteQuiesce.defaultTimeout, "m1: within the 2 s bound (elapsed \(elapsed))")
  expect(!inFlight.get, "m1: no SQLite statement in flight when the quiesce returns")
  expect(rc.get == SQLITE_INTERRUPT, "m1: the in-flight statement was interrupted (rc \(rc.get))")
  if inFlight.get, let db = handle.db {
    // Red path only (the quiesce did not stop it): stop it here so the rest
    // of the run does not wait minutes behind it.
    exsqlite3_interrupt(db)
    _ = BackupSQLiteQuiesce.waitForSerialQueue(dbQueue, timeout: 5)
  }

  var after: OpaquePointer? = OpaquePointer(bitPattern: 1)
  var ran = false
  dbQueue.sync {
    after = handle.connection(admittedBy: gate)
    if let db = after { ran = scalar(db, "SELECT 1") == 1 }
  }
  expect(after == nil && !ran, "m2: after the quiesce a block gets no connection and runs nothing")
  gate.setForeground(true)
  dbQueue.sync { after = handle.connection(admittedBy: gate) }
  expect(after != nil && after == handle.db, "m2: foreground reopens: the same connection again")
  dbQueue.sync { ran = after.map { scalar($0, "SELECT 1") == 1 } ?? false }
  expect(ran, "m2: and statements run again")
}

// MARK: - m3 B2: the completion write alone

do {
  let target = SQLiteInterruptTarget { exsqlite3_interrupt($0) }
  let (handle, _) = makeHandle("m3.db", target: target)
  let gate = BackupExecutionGate(foreground: false)
  let grace = gate.beginAssertion(.backgroundGrace)
  _ = gate.expire()
  gate.endAssertion(grace)
  let write = gate.beginAssertion(.completionWrite)
  expect(handle.connection(admittedBy: gate) == nil, "m3 (B2): the drain gets no connection during a completion write")
  expect(handle.connection(admittedBy: gate, completionWrite: write) == handle.db, "m3 (B2): the completion write gets it")
  gate.endAssertion(write)
  expect(handle.connection(admittedBy: gate, completionWrite: write) == nil, "m3 (B2): not after its assertion ended")
}

// MARK: - m4 B4: close waits for the interrupt in flight

do {
  let entered = DispatchSemaphore(value: 0)
  let release = DispatchSemaphore(value: 0)
  let interruptedConnection = Box<OpaquePointer?>(nil)
  let blocking = Box(false)
  // The real target class; its SQLite call is replaced by a recorder that
  // can hold the lock (an interrupt "in progress").
  let target = SQLiteInterruptTarget { connection in
    interruptedConnection.set(connection)
    if blocking.get {
      entered.signal()
      _ = release.wait(timeout: .now() + 5)
    }
  }
  let (handle, _) = makeHandle("m4.db", target: target)
  let opened = handle.db
  target.interrupt()
  expect(interruptedConnection.get == opened && opened != nil, "m4: the published connection is the open handle")

  blocking.set(true)
  Thread { target.interrupt() }.start()
  expect(entered.wait(timeout: .now() + 2) == .success, "m4 setup: an expiry interrupt is in flight")
  let closesBefore = handle.closedConnectionCount
  let finished = DispatchSemaphore(value: 0)
  let result = Box<BackupManifestHandle.FinishResult?>(nil)
  // The owner closes the connection (the second half of a sign-out).
  Thread {
    result.set(handle.finishAfterFailedReset(allowUnlink: true))
    finished.signal()
  }.start()
  Thread.sleep(forTimeInterval: 0.3)
  expect(handle.closedConnectionCount == closesBefore,
         "m4 (B4): the connection is not closed while an interrupt is using it")
  blocking.set(false)
  release.signal()
  expect(finished.wait(timeout: .now() + 5) == .success, "m4: the close goes on once the interrupt returned")
  expect(handle.closedConnectionCount == closesBefore + 1, "m4: ...and the old connection was closed")
  expect(result.get?.reopened == true && target.isPublished, "m4: the reopened connection is published again")
  interruptedConnection.set(nil)
  target.interrupt()
  expect(interruptedConnection.get == handle.db && handle.db != nil, "m4: an interrupt now reaches the NEW connection")
}

// MARK: - m5 B5: an interrupted chunk replace changes nothing

/// What an expiry does to the replace: `exsqlite3_interrupt` lands while the
/// INSERT of chunk 2 is running (the trigger calls it, then loops, so the
/// statement is still executing when SQLite checks the flag). SQLite then
/// aborts the statement with SQLITE_INTERRUPT and rolls the WHOLE transaction
/// back, as it does for the real expiry interrupt.
let interruptFunction: @convention(c) (OpaquePointer?, Int32, UnsafeMutablePointer<OpaquePointer?>?) -> Void = { ctx, _, _ in
  exsqlite3_interrupt(exsqlite3_context_db_handle(ctx))
  exsqlite3_result_null(ctx)
}

do {
  let target = SQLiteInterruptTarget { exsqlite3_interrupt($0) }
  let (handle, _) = makeHandle("m5.db", target: target)
  let db = handle.db!
  let oldPaths = ["/staged/old-0", "/staged/old-1", "/staged/old-2"]
  expect(BackupManifestStore.replaceStagedChunks(db, assetId: "asset-1", fileId: "old-file", chunkPaths: oldPaths),
         "m5 setup: the first staging records its chunks")
  let chunksSQL = "SELECT path FROM backup_upload_chunks WHERE local_asset_id = 'asset-1' ORDER BY chunk_index"
  expect(strings(db, chunksSQL) == oldPaths, "m5 setup: three old chunks")

  expect(exsqlite3_create_function_v2(db, "bb_interrupt", 0, SQLITE_UTF8, nil, interruptFunction, nil, nil, nil) == SQLITE_OK,
         "m5 setup: interrupt function")
  expect(exsqlite3_exec(db, """
    CREATE TEMP TABLE bb_rows(x);
    WITH RECURSIVE r(x) AS (SELECT 1 UNION ALL SELECT x + 1 FROM r WHERE x < 50) INSERT INTO bb_rows SELECT x FROM r;
    CREATE TEMP TRIGGER bb_interrupt_chunk_2 BEFORE INSERT ON backup_upload_chunks
    WHEN NEW.chunk_index = 2 AND NEW.server_file_id = 'new-file'
    BEGIN SELECT bb_interrupt(); SELECT count(*) FROM bb_rows a, bb_rows b; END;
    """, nil, nil, nil) == SQLITE_OK, "m5 setup: trigger")

  let newPaths = (0..<5).map { "/staged/new-\($0)" }
  let replaced = BackupManifestStore.replaceStagedChunks(db, assetId: "asset-1", fileId: "new-file", chunkPaths: newPaths)
  expect(!replaced, "m5 (B5): the interrupted replace reports failure")
  expect(exsqlite3_get_autocommit(db) != 0, "m5 (B5): no transaction left open")
  let after = strings(db, chunksSQL)
  expect(after == oldPaths, "m5 (B5): the old chunks are intact, no partial or gapped set (got \(after))")
  expect(scalar(db, "SELECT COUNT(*) FROM backup_upload_chunks WHERE server_file_id = 'new-file'") == 0,
         "m5 (B5): no new chunk row survived the interrupt")

  exsqlite3_exec(db, "DROP TRIGGER bb_interrupt_chunk_2", nil, nil, nil)
  expect(BackupManifestStore.replaceStagedChunks(db, assetId: "asset-1", fileId: "new-file", chunkPaths: newPaths),
         "m5: the retried replace succeeds")
  expect(strings(db, chunksSQL) == newPaths, "m5: and replaces the set completely")
}

if failures.isEmpty {
  print("manifest-background-quiesce: \(total) assertions, 0 failed")
  exit(0)
} else {
  for f in failures { print("FAIL: \(f)") }
  print("manifest-background-quiesce: \(failures.count) of \(total) assertions FAILED")
  exit(1)
}
