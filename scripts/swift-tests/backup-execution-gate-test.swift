import Foundation

// Task LD-0002 (TestFlight 252, `RUNNINGBOARD 0xdead10cc`) — standalone swiftc
// test for `BackupExecutionGate`, `SQLiteInterruptTarget` and
// `BackupSQLiteQuiesce`, compiled with the REAL shipped source
// (modules/beebeeb-crypto/ios/BackupExecutionGate.swift) by
// scripts/swift-ci/run-swift-tests.sh. The SQLite side (a real manifest
// handle, a real interrupt) is `manifest-background-quiesce-test.swift`; the
// thumbnail queue is `thumbnail-queue-quiesce-test.swift`.
//
// Cases map to the mobile#257 review (round 2):
//   g1  the gate: foreground, general assertions, expiry, reopen (rules 1, 4)
//   g2  an expiry in the FOREGROUND closes nothing (a BGProcessingTask can
//       expire as the user opens the app)
//   g3  B2: a completion-write assertion admits its own write only and never
//       reopens the gate for the drain or the thumbnail pump
//   g4  B3: a block enqueued while the gate was open asks again when it runs
//   g5  the quiesce order (close -> interrupt -> wait), and nothing in the
//       foreground
//   g6  the bounded wait returns within its timeout when a block never ends
//   g7  P2a: a read an expiry closed the gate on is "unknown", not 0
//   g8  B4: withdrawing the interrupt target waits for an interrupt in flight
//   g9  #262 review 1: every open -> closed transition is counted, so a
//       producer from before a closure stays stale after a reopen

var failures: [String] = []
var total = 0
let failuresLock = NSLock()

func expect(_ condition: Bool, _ label: String) {
  failuresLock.lock()
  total += 1
  if !condition { failures.append(label) }
  failuresLock.unlock()
}

// MARK: - g1 the gate

do {
  let gate = BackupExecutionGate(foreground: true)
  expect(gate.canStartSQLiteWork, "g1: foreground is open")
  gate.setForeground(false)
  expect(!gate.canStartSQLiteWork, "g1: background with no assertion is closed")
  let grace = gate.beginAssertion(.backgroundGrace)
  expect(gate.canStartSQLiteWork, "g1: a grace assertion opens the background gate")
  let before = gate.closures
  expect(gate.expire(), "g1: an expiry in the background reports the gate closed")
  expect(gate.closures == before + 1, "g1: the expiry is counted")
  expect(!gate.canStartSQLiteWork, "g1: the expiry closes the gate although the grace assertion is still live")
  gate.endAssertion(grace)
  expect(!gate.canStartSQLiteWork, "g1: ending the expired assertion does not reopen")
  let bg = gate.beginAssertion(.backgroundProcessing)
  expect(gate.canStartSQLiteWork, "g1: a NEW general assertion (BGProcessingTask) reopens after an expiry")
  gate.endAssertion(bg)
  expect(!gate.canStartSQLiteWork, "g1: ending the last general assertion closes again")
  _ = gate.expire()
  gate.setForeground(true)
  expect(gate.canStartSQLiteWork, "g1: foreground reopens after an expiry")
}

// MARK: - g2 an expiry in the foreground

do {
  let gate = BackupExecutionGate(foreground: true)
  let bg = gate.beginAssertion(.backgroundProcessing)
  let before = gate.closures
  expect(!gate.expire(), "g2: an expiry while foreground reports nothing to quiesce")
  expect(gate.canStartSQLiteWork, "g2: the foreground backup keeps running")
  expect(gate.closures == before, "g2: no closure counted (no read can have been interrupted)")
  gate.endAssertion(bg)
  gate.setForeground(false)
  expect(!gate.canStartSQLiteWork, "g2: backgrounding later still closes (the expiry stayed recorded)")
}

// MARK: - g3 B2: a completion write admits only itself

do {
  let gate = BackupExecutionGate(foreground: false)
  let grace = gate.beginAssertion(.backgroundGrace)
  _ = gate.expire()
  gate.endAssertion(grace)
  let completion = gate.beginAssertion(.completionWrite)
  expect(!gate.canStartSQLiteWork, "g3 (B2): a completion assertion does NOT reopen the gate for the drain")
  expect(!gate.admitsStatement(), "g3 (B2): a statement outside the completion write is refused")
  expect(gate.admitsStatement(completionWrite: completion), "g3 (B2): the completion's own write is admitted")
  let other = gate.beginAssertion(.completionWrite)
  gate.endAssertion(other)
  expect(!gate.admitsStatement(completionWrite: other), "g3 (B2): an ended completion assertion admits nothing")
  gate.endAssertion(completion)
  expect(!gate.admitsStatement(completionWrite: completion), "g3 (B2): the write's assertion ended (its expiry): refused")
  expect(!gate.canStartSQLiteWork, "g3 (B2): the gate is still closed after the completion write")

  // With no expiry at all (a background URLSession relaunch): same rule.
  let relaunch = BackupExecutionGate(foreground: false)
  let write = relaunch.beginAssertion(.completionWrite)
  expect(!relaunch.canStartSQLiteWork, "g3 (B2): on a background relaunch the completion assertion does not open the drain")
  expect(relaunch.admitsStatement(completionWrite: write), "g3 (B2): ...and admits its write")
  let open = BackupExecutionGate(foreground: true)
  expect(open.admitsStatement(completionWrite: nil), "g3: an open gate admits any statement")
}

// MARK: - g4 B3: the block asks again when it runs

do {
  let gate = BackupExecutionGate(foreground: false)
  let grace = gate.beginAssertion(.backgroundGrace)
  let queue = DispatchQueue(label: "g4.dbQueue")
  let hold = DispatchSemaphore(value: 0)
  let done = DispatchSemaphore(value: 0)
  // A block already running on the queue (the drain's statement).
  queue.async { hold.wait() }
  // The engine's `runBackgroundCompletionWrite` with the gate open: check,
  // then enqueue. The write itself starts from `db`, which asks the gate.
  var admittedAtRun: Bool?
  if gate.canStartSQLiteWork {
    queue.async {
      admittedAtRun = gate.admitsStatement()
      done.signal()
    }
  }
  // The expiry lands between the check and the block.
  _ = gate.expire()
  gate.endAssertion(grace)
  hold.signal()
  _ = done.wait(timeout: .now() + 2)
  expect(admittedAtRun == false, "g4 (B3): a write enqueued before the expiry starts no statement after it")
}

// MARK: - g5 the quiesce order

do {
  let gate = BackupExecutionGate(foreground: false)
  _ = gate.beginAssertion(.backgroundGrace)
  var steps: [String] = []
  let outcome = BackupSQLiteQuiesce.run(
    gate: gate,
    interrupt: { steps.append(gate.canStartSQLiteWork ? "interrupt-open" : "interrupt-closed") },
    waitForQuiet: { timeout in
      steps.append("wait-\(timeout)")
      return true
    }
  )
  expect(outcome == .quiet, "g5: quiet")
  expect(steps == ["interrupt-closed", "wait-2.0"], "g5: the gate closes BEFORE the interrupt, then the 2 s wait (got \(steps))")
  expect(!gate.canStartSQLiteWork, "g5: the gate is closed when the quiesce returns")

  let timedOut = BackupSQLiteQuiesce.run(gate: gate, interrupt: {}, waitForQuiet: { _ in false })
  expect(timedOut == .timedOut, "g5: a wait that did not finish is reported")

  let fg = BackupExecutionGate(foreground: true)
  var touched = false
  let none = BackupSQLiteQuiesce.run(gate: fg, interrupt: { touched = true }, waitForQuiet: { _ in touched = true; return true })
  expect(none == .foreground && !touched, "g5: in the foreground nothing is interrupted or awaited")
  expect(fg.canStartSQLiteWork, "g5: ...and the foreground gate stays open")
}

// MARK: - g6 the bounded wait

do {
  let queue = DispatchQueue(label: "g6.dbQueue")
  let release = DispatchSemaphore(value: 0)
  queue.async { _ = release.wait(timeout: .now() + 10) }
  let started = Date()
  let quiet = BackupSQLiteQuiesce.waitForSerialQueue(queue, timeout: 0.5)
  let elapsed = Date().timeIntervalSince(started)
  expect(!quiet, "g6: a block that does not end is not quiet")
  expect(elapsed >= 0.45 && elapsed < 1.0, "g6: the wait is bounded by its timeout (elapsed \(elapsed))")
  release.signal()
  expect(BackupSQLiteQuiesce.waitForSerialQueue(queue, timeout: 2), "g6: quiet once the block ended")
}

// MARK: - g7 P2a: an interrupted read is unknown

do {
  let gate = BackupExecutionGate(foreground: false)
  let grace = gate.beginAssertion(.backgroundGrace)
  expect(gate.readIfUninterrupted { 7 } == 7, "g7: an uninterrupted read keeps its value")
  let interrupted: Int? = gate.readIfUninterrupted { () -> Int in
    _ = gate.expire()
    return 0 // what countWhere answers for an interrupted step
  }
  expect(interrupted == nil, "g7 (P2a): a read an expiry interrupted is unknown, not 0")
  var ran = false
  let closed: Int? = gate.readIfUninterrupted { () -> Int in ran = true; return 1 }
  expect(closed == nil && !ran, "g7: no read runs while the gate is closed")
  gate.endAssertion(grace)
  gate.setForeground(true)
  let fgExpiry: Int? = gate.readIfUninterrupted { () -> Int in
    _ = gate.expire() // foreground: nothing is interrupted
    return 3
  }
  expect(fgExpiry == 3, "g7: a foreground expiry interrupts nothing, the read stands")
}

// MARK: - g8 B4: withdraw waits for an interrupt in flight

do {
  let fake = OpaquePointer(bitPattern: 0xBEEF)!
  var interrupted: [OpaquePointer] = []
  let entered = DispatchSemaphore(value: 0)
  let release = DispatchSemaphore(value: 0)
  var block = false
  let target = SQLiteInterruptTarget { connection in
    interrupted.append(connection)
    if block {
      entered.signal()
      _ = release.wait(timeout: .now() + 5)
    }
  }
  target.interrupt()
  expect(interrupted.isEmpty, "g8: nothing published, nothing interrupted")
  target.publish(fake)
  expect(target.isPublished, "g8: published")
  target.interrupt()
  expect(interrupted == [fake], "g8: the published connection is interrupted")

  block = true
  let interrupter = Thread { target.interrupt() }
  interrupter.start()
  expect(entered.wait(timeout: .now() + 2) == .success, "g8 setup: an interrupt is in flight")
  let withdrawn = DispatchSemaphore(value: 0)
  let closer = Thread {
    target.withdraw() // the owner, about to close the connection
    withdrawn.signal()
  }
  closer.start()
  expect(withdrawn.wait(timeout: .now() + 0.3) == .timedOut,
         "g8 (B4): withdraw (so the close) waits while an interrupt is using the connection")
  release.signal()
  expect(withdrawn.wait(timeout: .now() + 2) == .success, "g8 (B4): withdraw returns once the interrupt finished")
  block = false
  let count = interrupted.count
  target.interrupt()
  expect(!target.isPublished && interrupted.count == count, "g8: after withdraw an interrupt is a no-op")
}

// MARK: - g9 #262 review 1: every open -> closed transition is counted

do {
  let gate = BackupExecutionGate(foreground: false)
  let grace = gate.beginAssertion(.backgroundGrace)
  let start = gate.closures
  expect(gate.isOpen(since: start), "g9: open since the read")
  gate.endAssertion(grace)
  expect(gate.closures == start + 1, "g9: the last assertion ending closes the gate and counts it")
  expect(!gate.isOpen(since: start), "g9: not open since the read")
  let reopened = gate.beginAssertion(.backgroundProcessing)
  expect(gate.canStartSQLiteWork && !gate.isOpen(since: start),
         "g9: reopened, but a producer from before the closure is still stale")
  expect(gate.isOpen(since: gate.closures), "g9: a fresh producer is admitted")
  gate.endAssertion(reopened)
  let fg = BackupExecutionGate(foreground: true)
  let before = fg.closures
  let bg = fg.beginAssertion(.backgroundGrace)
  fg.setForeground(false)
  expect(fg.closures == before, "g9: backgrounding with a grace assertion keeps the gate open (no closure)")
  fg.endAssertion(bg)
  expect(fg.closures == before + 1, "g9: ...its end closes it (one closure)")
  _ = fg.expire()
  expect(fg.closures == before + 1, "g9: an expiry of an already closed gate counts nothing more")
  fg.setForeground(true)
  fg.setForeground(false)
  expect(fg.closures == before + 2, "g9: leaving the foreground with no assertion closes it (counted)")
}

let failed = failures.count
if failed == 0 {
  print("backup-execution-gate: \(total) assertions, 0 failed")
} else {
  for failure in failures { print("FAIL: \(failure)") }
  print("backup-execution-gate: \(total - failed) pass, \(failed) fail")
  exit(1)
}
