import Foundation

// LD-0002 (mobile#252, `RUNNINGBOARD 0xdead10cc`) — standalone swiftc harness
// for `BackupExecutionGate` / `BackupSQLiteQuiesce`, compiled with the REAL
// shipped source by scripts/swift-ci/run-swift-tests.sh.
//
// `NativeBackupEngine` itself needs UIKit/PhotoKit/Network and cannot be
// compiled here, so `HarnessManifest` + `EngineModel` below transcribe the
// engine's behaviour that the gate governs — exactly the shape
// `backup-engine-lifecycle-test.swift` uses for the lifecycle:
//   * a serial "dbQueue" whose blocks step SQLite (here: a deliberately slow
//     row walk that honours `SQLITE_INTERRUPT`);
//   * a drain loop that asks `gate.canStartSQLiteWork` before each batch and
//     again before each per-row mark (rule 3);
//   * an expiry path that calls `BackupSQLiteQuiesce.run` (rule 2) and only
//     then ends the background task.
//
// RED on origin/main: without the gate/quiesce the expiry handler returns
// while the statement is in flight and the drain keeps marking rows. The
// mutations of rule 2(b)/(c)/rule 3 are exercised in the lane's PR body.

var failures: [String] = []
var total = 0
let failuresLock = NSLock()

func expect(_ condition: Bool, _ label: String) {
  failuresLock.lock()
  total += 1
  if !condition { failures.append(label) }
  failuresLock.unlock()
}

/// Serial-manifest stand-in. All mutation/selection happens on `queue`, which
/// stands for `NativeBackupEngine.dbQueue`. The slow walk stands for
/// `exsqlite3_step` over `getPendingUploads(limit:)`.
final class HarnessManifest {
  let queue = DispatchQueue(label: "harness.manifest")
  private let lock = NSLock()
  private var rows: [String: String]
  private var interruptRequested = false
  private(set) var inFlight = 0
  private(set) var statementsStarted = 0
  /// Per-row delay: 4 rows = 400 ms, long enough to be caught mid-statement.
  var secondsPerRow = 0.1
  /// A statement that ignores `SQLITE_INTERRUPT` (rule 2's timeout bound).
  var honoursInterrupt = true

  init(rows: [String: String]) {
    self.rows = rows
  }

  func requestInterrupt() {
    lock.lock()
    interruptRequested = true
    lock.unlock()
  }

  /// The engine's `dbQueue.async { sem.signal() }` barrier, bounded.
  func waitForQuiet(timeout: TimeInterval) -> Bool {
    let sem = DispatchSemaphore(value: 0)
    queue.async { sem.signal() }
    return sem.wait(timeout: .now() + timeout) == .success
  }

  /// Stands for `getPendingUploads(limit:)`: steps rows one by one. When the
  /// connection is interrupted the statement returns no rows — the engine
  /// treats that as a rolled-back transaction, so nothing is marked.
  func selectPending(limit: Int) -> [String] {
    lock.lock()
    statementsStarted += 1
    inFlight += 1
    interruptRequested = false
    lock.unlock()
    defer {
      lock.lock()
      inFlight -= 1
      lock.unlock()
    }

    var out: [String] = []
    for row in rows.keys.sorted().prefix(limit) {
      Thread.sleep(forTimeInterval: secondsPerRow)
      lock.lock()
      let interrupted = interruptRequested && honoursInterrupt
      lock.unlock()
      if interrupted { return [] }
      out.append(row)
    }
    return out
  }

  /// A fenced per-row mark (`markUploaded` in the real engine).
  func markUploaded(_ ids: [String]) {
    lock.lock()
    for id in ids where rows[id] != nil { rows[id] = "uploaded" }
    lock.unlock()
  }

  var pending: [String] { lock.lock(); defer { lock.unlock() }; return rows.filter { $0.value == "pending" }.map(\.key) }
  var uploaded: [String] { lock.lock(); defer { lock.unlock() }; return rows.filter { $0.value == "uploaded" }.map(\.key) }
  var inFlightCount: Int { lock.lock(); defer { lock.unlock() }; return inFlight }
}

/// The engine's control flow, reduced to what the gate decides.
final class EngineModel {
  let gate: BackupExecutionGate
  let manifest: HarnessManifest
  private let lock = NSLock()
  private var running = false
  private var drainThreadRunning = false
  private var _drainStopped = false
  var limit = 4
  /// Test seam: runs once, right after a non-empty selection returns and
  /// BEFORE the per-row `dbQueue` blocks (expiry between the statement and
  /// the marks — rule 3's per-block check).
  var afterSelection: (() -> Void)?

  init(gate: BackupExecutionGate, manifest: HarnessManifest) {
    self.gate = gate
    self.manifest = manifest
  }

  var drainStopped: Bool { lock.lock(); defer { lock.unlock() }; return _drainStopped }
  var isRunning: Bool { lock.lock(); defer { lock.unlock() }; return running }

  private func setRunning(_ value: Bool) {
    lock.lock(); running = value; lock.unlock()
  }

  private func setDrainStopped(_ value: Bool) {
    lock.lock(); _drainStopped = value; lock.unlock()
  }

  /// `startDrainLoop`: gate before each batch (rule 3), gate (and cancel)
  /// before each per-row `dbQueue` block.
  func startDrain() {
    lock.lock()
    if drainThreadRunning { lock.unlock(); return }
    drainThreadRunning = true
    running = true
    _drainStopped = false
    lock.unlock()

    let queue = DispatchQueue(label: "harness.drain")
    queue.async { [weak self] in
      guard let self else { return }
      defer {
        self.lock.lock(); self.drainThreadRunning = false; self.lock.unlock()
      }
      while self.isRunning {
        guard self.gate.canStartSQLiteWork else {
          self.setDrainStopped(true)
          return
        }
        let selected = self.manifest.queue.sync { self.manifest.selectPending(limit: self.limit) }
        if !selected.isEmpty, let hook = self.afterSelection {
          self.afterSelection = nil
          hook()
        }
        if selected.isEmpty {
          if !self.gate.canStartSQLiteWork {
            self.setDrainStopped(true)
            return
          }
          Thread.sleep(forTimeInterval: 0.01)
          continue
        }
        for id in selected {
          guard self.gate.canStartSQLiteWork else {
            self.setDrainStopped(true)
            return
          }
          Thread.sleep(forTimeInterval: 0.002)
          self.manifest.queue.sync { self.manifest.markUploaded([id]) }
        }
      }
    }
  }

  /// Rule 2: close the gate, interrupt, wait (bounded). Returns the quiesce
  /// result; `drainStopped` settles asynchronously, so callers poll it.
  @discardableResult
  func endBackgroundTime(graceStarted: Bool) -> Bool {
    if !graceStarted {
      gate.setForeground(false)
    }
    if graceStarted {
      gate.close()
    }
    return BackupSQLiteQuiesce.run(
      gate: gate,
      interrupt: { self.manifest.requestInterrupt() },
      waitForQuiet: { self.manifest.waitForQuiet(timeout: $0) }
    )
  }

  /// Rule 4: foreground reopens the gate and wakes the drain.
  func enterForeground() {
    gate.setForeground(true)
    startDrain()
  }
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

func waitUntil(_ timeout: TimeInterval, _ condition: () -> Bool) -> Bool {
  let deadline = Date().addingTimeInterval(timeout)
  while Date() < deadline {
    if condition() { return true }
    Thread.sleep(forTimeInterval: 0.01)
  }
  return condition()
}

// 1. Expiry while a batch is mid-statement: after the handler returns no
//    statement is in flight, the drain is stopped, and the rows are still
//    pending with no partial mark.
do {
  let manifest = HarnessManifest(rows: ["a": "pending", "b": "pending", "c": "pending", "d": "pending"])
  // Longer than the 2 s quiesce bound: only the INTERRUPT can make this
  // statement stop in time (rule 2b — the wait alone would time out).
  manifest.secondsPerRow = 1.0
  let gate = BackupExecutionGate(foreground: true)
  let engine = EngineModel(gate: gate, manifest: manifest)
  engine.startDrain()
  expect(waitUntil(2.0) { manifest.inFlightCount > 0 }, "1 setup: a statement is in flight")

  let quiet = engine.endBackgroundTime(graceStarted: true)
  expect(quiet, "1: the manifest queue reported quiet before the handler returned")
  expect(manifest.inFlightCount == 0, "1: no SQLite statement is in flight after the handler")
  expect(!gate.canStartSQLiteWork, "1: the gate is closed after expiry")
  expect(waitUntil(1.0) { engine.drainStopped }, "1: the drain loop is stopped")
  expect(manifest.uploaded.isEmpty, "1: no row was marked uploaded")
  expect(Set(manifest.pending) == ["a", "b", "c", "d"], "1: every row is still pending")
  expect(manifest.statementsStarted == 1, "1: the interrupted statement was not retried by the dying drain")
}

// 1b. Expiry BETWEEN a completed selection and its per-row marks: rule 3's
//     per-block gate check means the batch writes nothing (no partial mark),
//     even though the statement itself was not interrupted.
do {
  let manifest = HarnessManifest(rows: ["a": "pending", "b": "pending", "c": "pending", "d": "pending"])
  let gate = BackupExecutionGate(foreground: true)
  let engine = EngineModel(gate: gate, manifest: manifest)
  engine.afterSelection = {
    _ = BackupSQLiteQuiesce.run(
      gate: gate,
      interrupt: { manifest.requestInterrupt() },
      waitForQuiet: { manifest.waitForQuiet(timeout: $0) }
    )
  }
  engine.startDrain()
  expect(waitUntil(2.0) { engine.drainStopped }, "1b: the drain stopped at the batch boundary")
  expect(!gate.canStartSQLiteWork, "1b: the gate is closed")
  expect(manifest.uploaded.isEmpty, "1b: no partial mark after expiry between selection and marks")
  expect(Set(manifest.pending) == ["a", "b", "c", "d"], "1b: every row is still pending")
}

// 2. The expiry handler returns within 2 s even when the statement would run
//    much longer and ignores the interrupt (the bounded wait is real).
do {
  let manifest = HarnessManifest(rows: ["a": "pending", "b": "pending"])
  manifest.honoursInterrupt = false
  manifest.secondsPerRow = 2.0 // 2 rows, ~4 s in total
  let gate = BackupExecutionGate(foreground: true)
  let engine = EngineModel(gate: gate, manifest: manifest)
  engine.startDrain()
  expect(waitUntil(2.0) { manifest.inFlightCount > 0 }, "2 setup: the unresponsive statement is in flight")

  let started = Date()
  let quiet = engine.endBackgroundTime(graceStarted: true)
  let elapsed = Date().timeIntervalSince(started)
  expect(!quiet, "2: an unresponsive statement reports NOT quiet")
  expect(elapsed >= 1.9, "2: the handler actually waited for the queue (elapsed \(elapsed))")
  expect(elapsed <= 2.4, "2: the handler returned within 2 s (elapsed \(elapsed))")
  expect(!gate.canStartSQLiteWork, "2: the gate is closed after the bounded wait")
}

// 3. didEnterBackground with no grace task: gate closed + interrupt + quiesced
//    before the return.
do {
  let manifest = HarnessManifest(rows: ["a": "pending", "b": "pending", "c": "pending"])
  let gate = BackupExecutionGate(foreground: true)
  let engine = EngineModel(gate: gate, manifest: manifest)
  engine.startDrain()
  expect(waitUntil(2.0) { manifest.inFlightCount > 0 }, "3 setup: a statement is in flight")

  let quiet = engine.endBackgroundTime(graceStarted: false)
  gate.setForeground(false) // what handleAppDidEnterBackground does first
  expect(quiet, "3: didEnterBackground quiesced the manifest")
  expect(manifest.inFlightCount == 0, "3: no statement in flight after didEnterBackground")
  expect(!gate.canStartSQLiteWork, "3: the gate is closed with no grace task")
  expect(waitUntil(1.0) { engine.drainStopped }, "3: the drain is stopped")
  expect(manifest.uploaded.isEmpty, "3: nothing was marked uploaded")
}

// 4. Foreground after expiry: the gate reopens and the drain resumes the same
//    rows (nothing was lost).
do {
  let manifest = HarnessManifest(rows: ["a": "pending", "b": "pending"])
  let gate = BackupExecutionGate(foreground: true)
  let engine = EngineModel(gate: gate, manifest: manifest)
  engine.limit = 2
  engine.startDrain()
  expect(waitUntil(2.0) { manifest.inFlightCount > 0 }, "4 setup: a statement is in flight")

  _ = engine.endBackgroundTime(graceStarted: true)
  expect(waitUntil(1.0) { engine.drainStopped }, "4 setup: the drain stopped on expiry")
  expect(gate.canStartSQLiteWork == false, "4 setup: the gate is closed")

  engine.enterForeground()
  expect(gate.canStartSQLiteWork, "4: foreground reopens the gate")
  expect(waitUntil(2.0) { manifest.uploaded.count == 2 }, "4: the drain resumed the same rows")
  expect(manifest.pending.isEmpty, "4: the same rows completed after foreground")
}

// 5. A completion write with no obtainable assertion is deferred, not run.
do {
  let gate = BackupExecutionGate(foreground: false)
  var wrote = false
  let deferred = gate.admitBackgroundCompletionWrite(beginShortAssertion: { false })
  if deferred != .deferred { wrote = true }
  expect(deferred == .deferred, "5: no assertion -> the write is deferred")
  expect(!wrote, "5: a deferred completion write does not touch SQLite")
  expect(!gate.canStartSQLiteWork, "5: the gate stays closed when the assertion is unavailable")

  var assertion: BackupExecutionGate.Assertion?
  let admitted = gate.admitBackgroundCompletionWrite(beginShortAssertion: {
    assertion = gate.beginAssertion(.backgroundURLSessionCompletion, token: "completion-1")
    return true
  })
  expect(admitted == .runUnderAssertion, "5: an obtainable assertion admits the write")
  expect(gate.canStartSQLiteWork, "5: the short assertion opens the gate for the write")
  if let assertion {
    gate.endAssertion(assertion)
  }
  expect(!gate.canStartSQLiteWork, "5: ending the short assertion closes the gate again")

  let open = BackupExecutionGate(foreground: true)
  expect(open.admitBackgroundCompletionWrite(beginShortAssertion: { false }) == .runNow,
         "5: a foreground completion write runs without a new assertion")
}

// 6. The gate itself: expiry closes it even with a live assertion; only a new
//    assertion or foreground reopens it (rules 2a and 4).
do {
  let gate = BackupExecutionGate(foreground: false)
  let grace = gate.beginAssertion(.backgroundGrace, token: "grace")
  expect(gate.canStartSQLiteWork, "6: a live background assertion opens the gate")
  gate.close()
  expect(!gate.canStartSQLiteWork, "6: close() wins over a live assertion")
  gate.endAssertion(grace)
  expect(!gate.canStartSQLiteWork, "6: ending the assertioned assertion does not reopen a closed gate")
  _ = gate.beginAssertion(.backgroundProcessing, token: "bg")
  expect(gate.canStartSQLiteWork, "6: a new background assertion reopens the gate")

  let fg = BackupExecutionGate(foreground: true)
  fg.close()
  expect(!fg.canStartSQLiteWork, "6: close() shuts a foreground gate")
  fg.setForeground(true)
  expect(fg.canStartSQLiteWork, "6: foreground reopens the gate")
}

let failed = failures.count
if failed == 0 {
  print("backup-execution-gate: \(total) assertions, 0 failed")
} else {
  for failure in failures { print("FAIL: \(failure)") }
  print("backup-execution-gate: \(total - failed) pass, \(failed) fail")
  exit(1)
}
