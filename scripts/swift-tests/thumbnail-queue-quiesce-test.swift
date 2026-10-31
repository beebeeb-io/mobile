import Foundation
import SQLite3

// Task LD-0002 (TestFlight 252, `RUNNINGBOARD 0xdead10cc`) — the thumbnail
// queue under the backup execution gate, on the REAL `ThumbnailQueueDB`
// (compiled with BackupExecutionGate.swift and linked against the same vanilla
// SQLite object the app gets through the Rust core, see
// scripts/swift-ci/run-swift-tests.sh).
//
//   t1  B7: rows claimed `running` by a process that died are `pending` again
//       after the next open (uses only main's API: RED on main)
//   t2  B7: rows claimed before an expiry, whose results the closed gate
//       refused, are `pending` again when the gate reopens
//   t3  a closed gate runs no statement (enqueue, pop, result writes, stats)
//   t4  B5: an enqueue interrupted mid-batch leaves NONE of the batch, not
//       the rows after the interrupt
//   t5  B5: a pop whose claim is interrupted hands out nothing and leaves
//       nothing `running`; the quiesce wait returns once it is interrupted
//   t6  #262 review 9: a closure and reopen (an app switch) does not hand
//       rows a worker is still running to a second worker
//   t7  #262 review 3: the progress handler stops a running statement once
//       the gate closes, with no interrupt

var failures: [String] = []
var total = 0

func expect(_ condition: Bool, _ label: String) {
  total += 1
  if !condition { failures.append(label) }
}

let fm = FileManager.default
let root = fm.temporaryDirectory.appendingPathComponent("bb-ld0002-thumbq-\(UUID().uuidString)", isDirectory: true)
try! fm.createDirectory(at: root, withIntermediateDirectories: true)
defer { try? fm.removeItem(at: root) }

func dir(_ name: String) -> URL {
  let url = root.appendingPathComponent(name, isDirectory: true)
  try! fm.createDirectory(at: url, withIntermediateDirectories: true)
  return url
}

/// A second connection to the queue file (the test's own; never the queue's).
func withConnection(_ directory: URL, _ body: (OpaquePointer) -> Void) {
  var db: OpaquePointer?
  precondition(sqlite3_open(directory.appendingPathComponent("thumbnail_queue.sqlite").path, &db) == SQLITE_OK)
  body(db!)
  sqlite3_close_v2(db)
}

func exec(_ db: OpaquePointer, _ sql: String) {
  var err: UnsafeMutablePointer<CChar>?
  if sqlite3_exec(db, sql, nil, nil, &err) != SQLITE_OK {
    let msg = err.map { String(cString: $0) } ?? "?"
    sqlite3_free(err)
    fatalError("SQL failed: \(msg)\n\(sql)")
  }
}

func ids(_ items: [ThumbnailQueueDB.Item]) -> [String] { items.map(\.fileId).sorted() }

/// A trigger body that runs for many seconds unless interrupted (SQLite does
/// not allow a WITH clause inside a trigger, so a 3-way cross join).
func installSlowTable(_ db: OpaquePointer) {
  exec(db, "CREATE TABLE IF NOT EXISTS slow_rows(x INTEGER);")
  exec(db, "DELETE FROM slow_rows;")
  exec(db, "WITH RECURSIVE c(x) AS (SELECT 1 UNION ALL SELECT x + 1 FROM c WHERE x < 2000) INSERT INTO slow_rows SELECT x FROM c;")
}
let slowBody = "SELECT count(*) FROM slow_rows a, slow_rows b, slow_rows c;"

// MARK: - t1 B7: relaunch after a death mid-run

do {
  let d = dir("t1")
  let first = ThumbnailQueueDB(directory: d)
  first.enqueue(fileIds: ["a", "b"], qualityPreset: "medium")
  expect(ids(first.popReady(limit: 5)) == ["a", "b"], "t1 setup: both claimed")
  expect(first.stats().running == 2, "t1 setup: both running")
  // The process died here: nothing ever finished a or b.
  let relaunched = ThumbnailQueueDB(directory: d)
  expect(ids(relaunched.popReady(limit: 5)) == ["a", "b"],
         "t1 (B7): rows left running by a dead process are claimable again after the next open")
}

// MARK: - t2 + t3: expiry refuses the results, reopen requeues the claims

do {
  let d = dir("t2")
  let gate = BackupExecutionGate(foreground: false)
  let grace = gate.beginAssertion(.backgroundGrace)
  let queue = ThumbnailQueueDB(directory: d, gate: gate)
  queue.enqueue(fileIds: ["c"], qualityPreset: "medium")
  expect(ids(queue.popReady(limit: 5)) == ["c"], "t2 setup: c claimed in the grace window")

  expect(gate.expire(), "t2 setup: background time ends")
  gate.endAssertion(grace)
  queue.markSucceeded(fileId: "c")
  queue.enqueue(fileIds: ["d"], qualityPreset: "medium")
  expect(queue.popReady(limit: 5).isEmpty, "t3: no claim while the gate is closed")
  let closedStats = queue.stats()
  expect(closedStats.pending == 0 && closedStats.running == 0 && closedStats.succeeded == 0,
         "t3: no read while the gate is closed")
  withConnection(d) { db in
    var stmt: OpaquePointer?
    sqlite3_prepare_v2(db, "SELECT state FROM queue_items WHERE file_id = 'c'", -1, &stmt, nil)
    let state = sqlite3_step(stmt) == SQLITE_ROW ? String(cString: sqlite3_column_text(stmt, 0)) : "?"
    sqlite3_finalize(stmt)
    expect(state == "running", "t3: the refused result write left c `running` (got \(state))")
    var count: OpaquePointer?
    sqlite3_prepare_v2(db, "SELECT COUNT(*) FROM queue_items WHERE file_id = 'd'", -1, &count, nil)
    _ = sqlite3_step(count)
    expect(sqlite3_column_int(count, 0) == 0, "t3: the enqueue ran no statement while closed")
    sqlite3_finalize(count)
  }

  gate.setForeground(true)
  expect(ids(queue.popReady(limit: 5)) == ["c"], "t2 (B7): reopening the gate requeues c, whose result was refused")
  queue.markSucceeded(fileId: "c")
  expect(queue.stats().succeeded == 1, "t2: the retried worker's result is recorded")
}

// MARK: - t4 B5: an interrupted enqueue keeps none of its batch

do {
  let d = dir("t4")
  let queue = ThumbnailQueueDB(directory: d, gate: BackupExecutionGate(foreground: true))
  _ = queue.stats() // opens and creates the schema
  withConnection(d) { db in
    installSlowTable(db)
    exec(db, "CREATE TRIGGER slow_insert BEFORE INSERT ON queue_items WHEN NEW.file_id = 'slow' BEGIN \(slowBody) END;")
  }
  let done = DispatchSemaphore(value: 0)
  Thread {
    queue.enqueue(fileIds: ["x1", "x2", "slow", "x3", "x4"], qualityPreset: "medium")
    done.signal()
  }.start()
  Thread.sleep(forTimeInterval: 0.3)
  let interruptedAt = Date()
  queue.interruptInFlightStatement()
  expect(done.wait(timeout: .now() + 2) == .success, "t4: the interrupted enqueue returns")
  expect(Date().timeIntervalSince(interruptedAt) < 2, "t4: promptly")
  withConnection(d) { db in exec(db, "DROP TRIGGER slow_insert;") }
  let stats = queue.stats()
  expect(stats.pending == 0,
         "t4 (B5): none of the interrupted batch is queued (got \(stats.pending) pending; main kept the rows after the interrupt)")
  queue.enqueue(fileIds: ["x1", "x2", "slow", "x3", "x4"], qualityPreset: "medium")
  expect(queue.stats().pending == 5, "t4: the retried enqueue queues the whole batch")
}

// MARK: - t5 B5: an interrupted claim hands out nothing

do {
  let d = dir("t5")
  let queue = ThumbnailQueueDB(directory: d, gate: BackupExecutionGate(foreground: true))
  queue.enqueue(fileIds: ["y1", "slow2", "y3"], qualityPreset: "medium")
  withConnection(d) { db in
    installSlowTable(db)
    exec(db, "CREATE TRIGGER slow_claim BEFORE UPDATE OF state ON queue_items WHEN NEW.file_id = 'slow2' AND NEW.state = 'running' BEGIN \(slowBody) END;")
  }
  let done = DispatchSemaphore(value: 0)
  var popped: [ThumbnailQueueDB.Item] = []
  Thread {
    popped = queue.popReady(limit: 5)
    done.signal()
  }.start()
  Thread.sleep(forTimeInterval: 0.3)
  queue.interruptInFlightStatement()
  expect(queue.waitForQuiet(timeout: 2), "t5: the queue goes quiet within the 2 s bound once interrupted")
  expect(done.wait(timeout: .now() + 2) == .success, "t5: the pop returned")
  withConnection(d) { db in exec(db, "DROP TRIGGER slow_claim;") }
  expect(popped.isEmpty, "t5 (B5): an interrupted claim hands out no item (got \(ids(popped)))")
  let stats = queue.stats()
  expect(stats.running == 0 && stats.pending == 3, "t5 (B5): no row is left `running` (running \(stats.running), pending \(stats.pending))")
  expect(ids(queue.popReady(limit: 5)) == ["slow2", "y1", "y3"], "t5: the next pop claims all three")
}

// MARK: - t6 #262 review 9: an app switch does not hand out rows still being worked on

do {
  let d = dir("t6")
  let gate = BackupExecutionGate(foreground: true)
  let queue = ThumbnailQueueDB(directory: d, gate: gate)
  queue.enqueue(fileIds: ["w1", "w2"], qualityPreset: "medium")
  expect(ids(queue.popReady(limit: 5)) == ["w1", "w2"], "t6 setup: two workers claimed w1, w2")
  // The user switches apps and back, no grace task: the gate closes (counted)
  // and reopens while both workers are still running.
  gate.setForeground(false)
  _ = gate.expire()
  gate.setForeground(true)
  expect(queue.popReady(limit: 5).isEmpty, "t6 (#9): rows still being worked on are not handed to a second worker")
  queue.markSucceeded(fileId: "w1")
  queue.markSucceeded(fileId: "w2")
  let stats = queue.stats()
  expect(stats.succeeded == 2 && stats.running == 0, "t6: both workers' results land")
}

// MARK: - t7 #262 review 3: the progress handler stops a statement with no interrupt

do {
  let d = dir("t7")
  let gate = BackupExecutionGate(foreground: false)
  let grace = gate.beginAssertion(.backgroundGrace)
  let queue = ThumbnailQueueDB(directory: d, gate: gate)
  _ = queue.stats()
  withConnection(d) { db in
    installSlowTable(db)
    exec(db, "CREATE TRIGGER slow_insert BEFORE INSERT ON queue_items WHEN NEW.file_id = 'slow' BEGIN \(slowBody) END;")
  }
  let done = DispatchSemaphore(value: 0)
  Thread {
    queue.enqueue(fileIds: ["z1", "slow", "z2"], qualityPreset: "medium")
    done.signal()
  }.start()
  Thread.sleep(forTimeInterval: 0.3)
  let closedAt = Date()
  _ = gate.expire() // no interruptInFlightStatement()
  gate.endAssertion(grace)
  let stopped = done.wait(timeout: .now() + 2) == .success
  expect(stopped, "t7 (#3): the closed gate alone stopped the slow statement")
  expect(Date().timeIntervalSince(closedAt) < 1, "t7 (#3): within the bound")
  if !stopped {
    // Red path only: stop it here so the cleanup below can take the lock.
    queue.interruptInFlightStatement()
    _ = done.wait(timeout: .now() + 5)
  }
  gate.setForeground(true)
  withConnection(d) { db in exec(db, "DROP TRIGGER slow_insert;") }
  expect(queue.stats().pending == 0, "t7: and the batch rolled back")
}

if failures.isEmpty {
  print("thumbnail-queue-quiesce: \(total) assertions, 0 failed")
  exit(0)
} else {
  for f in failures { print("FAIL: \(f)") }
  print("thumbnail-queue-quiesce: \(failures.count) of \(total) assertions FAILED")
  exit(1)
}
