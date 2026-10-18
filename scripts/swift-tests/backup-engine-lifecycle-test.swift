import Darwin
import Foundation

// Task 1667 round 11 (review of mobile#182 at de23774e, findings 3 and 5) —
// standalone swiftc test for `BackupEngineLifecycle`, compiled with the REAL
// shipped sources (BackupEngineLifecycle.swift, ManifestWriteFence.swift) by
// scripts/swift-ci/run-swift-tests.sh, driven from real threads.
//
// `Engine` below is `NativeBackupEngine`'s start / stop / retry / observer /
// monitor / fetch-result wiring, reduced to what the lifecycle decides: the
// engine itself needs PhotoKit/UIKit/Network and cannot be compiled here;
// src/lib/native-backup-manifest-wiring.test.ts pins that the engine calls
// the lifecycle exactly like this (`start()` -> `userStart { startLocked() }`,
// `stop()` -> `userStop { stopLocked() }`, the retry -> `runRetry`, the
// observer -> `registerObserverOnce`, the monitor -> `startMonitorIfNeeded`,
// the scan -> `acceptFetchResult`).
//
// What it proves:
//   (a) finding 3, retry vs stop: a manifest-open retry that is already
//       executing start() when the user turns backup off ends NOT running,
//       with no observer and no monitor left; a retry that fires after the
//       stop does nothing.
//   (a6) finding 3, start vs stop: a stop that arrives while start() is in
//       its body ends NOT running (they never interleave).
//   (b) finding 3, double start: two concurrent starts register the photo
//       observer once and start one monitor; stop cancels it (none leaks).
//   (c) finding 5: a scan's fetch result is not stored after a stop, a
//       sign-out fence seal, or a cancel; the change observer's replace is
//       refused after a stop; the sign-out order (stop, a scan that starts
//       before the reset, the reset, the clear) leaves no result.

var failures: [String] = []
var total = 0
let failuresLock = NSLock()

func expect(_ condition: Bool, _ label: String) {
  failuresLock.lock()
  total += 1
  if !condition { failures.append(label) }
  failuresLock.unlock()
}

final class Counter {
  private let lock = NSLock()
  private var value = 0
  func add(_ n: Int = 1) { lock.lock(); value += n; lock.unlock() }
  var get: Int { lock.lock(); defer { lock.unlock() }; return value }
}

/// A network monitor stand-in: alive until cancelled.
final class FakeMonitor {
  static let alive = Counter()
  private let lock = NSLock()
  private var cancelled = false
  init() { FakeMonitor.alive.add() }
  func cancel() {
    lock.lock(); defer { lock.unlock() }
    guard !cancelled else { return }
    cancelled = true
    FakeMonitor.alive.add(-1)
  }
}

final class FakeFetchResult {}

/// `NativeBackupEngine`'s lifecycle wiring (see the header).
final class Engine {
  let lifecycle = BackupEngineLifecycle()
  private let stateLock = NSLock()
  private var _isRunning = false
  var isRunning: Bool {
    get { stateLock.lock(); defer { stateLock.unlock() }; return _isRunning }
    set { stateLock.lock(); _isRunning = newValue; stateLock.unlock() }
  }
  var manifestOpens = true
  let observerRegisterCalls = Counter()
  let observerUnregisterCalls = Counter()
  /// Called inside start()'s body between its `isRunning` check and its
  /// write (where the engine loads the master key and opens the manifest).
  var slowStep: () -> Void = {}

  func start() { lifecycle.userStart { startLocked() } }
  func stop() { lifecycle.userStop { stopLocked() } }

  func startLocked() {
    guard manifestOpens else {
      if isRunning { lifecycle.internalStop { stopLocked() } }
      return
    }
    if isRunning {
      registerPhotoObserver()
      startNetworkMonitor()
      return
    }
    slowStep()
    isRunning = true
    registerPhotoObserver()
    startNetworkMonitor()
  }

  func stopLocked() {
    guard isRunning else { return }
    isRunning = false
    lifecycle.unregisterObserver { observerUnregisterCalls.add() }
    lifecycle.stopMonitor { ($0 as? FakeMonitor)?.cancel() }
  }

  func registerPhotoObserver() {
    lifecycle.registerObserverOnce { observerRegisterCalls.add() }
  }

  func startNetworkMonitor() {
    lifecycle.startMonitorIfNeeded { FakeMonitor() }
  }

  /// `scheduleManifestOpenRetry`: the work item runs `runRetry(token)`.
  func scheduleRetry(after delay: TimeInterval, done: DispatchSemaphore) {
    let token = lifecycle.scheduleRetry()
    DispatchQueue.global().asyncAfter(deadline: .now() + delay) {
      self.lifecycle.runRetry(token) { self.startLocked() }
      done.signal()
    }
  }
}

func wait(_ sem: DispatchSemaphore, _ label: String, seconds: Double = 10) {
  expect(sem.wait(timeout: .now() + seconds) == .success, "\(label): finished within the watchdog")
}

// MARK: - (a) finding 3: a retry executing start() races the user's stop

do {
  let engine = Engine()
  engine.manifestOpens = false
  engine.start() // the manifest cannot open: start() refuses, the retry is owed
  expect(!engine.isRunning && engine.lifecycle.wantsRunning, "a0: refused start keeps the user's intent")
  engine.manifestOpens = true

  let inSlowStep = DispatchSemaphore(value: 0)
  let release = DispatchSemaphore(value: 0)
  engine.slowStep = {
    inSlowStep.signal()
    _ = release.wait(timeout: .now() + 5)
  }
  let retryDone = DispatchSemaphore(value: 0)
  engine.scheduleRetry(after: 0, done: retryDone)
  // The retry is now inside start(), past its checks (`isRunning == false`).
  expect(inSlowStep.wait(timeout: .now() + 5) == .success, "a1: the retry is executing start()")
  engine.slowStep = {}

  // The user turns camera backup off on another queue.
  let stopDone = DispatchSemaphore(value: 0)
  DispatchQueue.global().async {
    engine.stop()
    stopDone.signal()
  }
  usleep(150_000) // give the stop every chance to run first
  release.signal()
  wait(retryDone, "a2: retry")
  wait(stopDone, "a2: stop")
  expect(!engine.isRunning, "a3: backup is NOT running after the user's stop")
  expect(!engine.lifecycle.observerRegistered, "a3: no photo observer left registered")
  expect(FakeMonitor.alive.get == 0, "a3: no network monitor left running (alive \(FakeMonitor.alive.get))")
  expect(!engine.lifecycle.wantsRunning, "a3: the user's intent is cleared")

  // A retry that fires AFTER the stop does nothing.
  let late = DispatchSemaphore(value: 0)
  engine.lifecycle.userStart {} // the user started...
  let token = engine.lifecycle.scheduleRetry()
  engine.stop() // ...and stopped again before the retry fired
  DispatchQueue.global().async {
    let ran = engine.lifecycle.runRetry(token) { engine.startLocked() }
    expect(!ran, "a4: the retry after a stop does not run")
    late.signal()
  }
  wait(late, "a4: late retry")
  expect(!engine.isRunning, "a4: still not running")

  // A newer retry voids an older one.
  engine.lifecycle.userStart {}
  let old = engine.lifecycle.scheduleRetry()
  let newer = engine.lifecycle.scheduleRetry()
  expect(!engine.lifecycle.runRetry(old) {}, "a5: an older retry is void")
  expect(engine.lifecycle.runRetry(newer) {}, "a5: the latest retry runs while the user wants backup")
  engine.stop()
}

// MARK: - (a6) finding 3: the user's start and stop never interleave

do {
  FakeMonitor.alive.add(-FakeMonitor.alive.get)
  let engine = Engine()
  let inSlowStep = DispatchSemaphore(value: 0)
  let release = DispatchSemaphore(value: 0)
  engine.slowStep = {
    inSlowStep.signal()
    _ = release.wait(timeout: .now() + 5)
  }
  // enablePhotoBackup -> start(), still loading the key ...
  let startDone = DispatchSemaphore(value: 0)
  DispatchQueue.global().async {
    engine.start()
    startDone.signal()
  }
  expect(inSlowStep.wait(timeout: .now() + 5) == .success, "a6: start() is inside its body")
  engine.slowStep = {}
  // ... when the user turns camera backup off (another queue).
  let stopDone = DispatchSemaphore(value: 0)
  DispatchQueue.global().async {
    engine.stop()
    stopDone.signal()
  }
  usleep(150_000)
  release.signal()
  wait(startDone, "a6: start")
  wait(stopDone, "a6: stop")
  expect(!engine.isRunning, "a6: the stop that came second wins: not running")
  expect(!engine.lifecycle.observerRegistered && FakeMonitor.alive.get == 0,
         "a6: no observer, no monitor left (alive \(FakeMonitor.alive.get))")
}

// MARK: - (b) finding 3: two concurrent starts

do {
  FakeMonitor.alive.add(-FakeMonitor.alive.get)
  let engine = Engine()
  let arrived = DispatchSemaphore(value: 0)
  // Each start waits up to 200 ms inside start() for the other one to get
  // there too. Serialized starts never meet; unserialized ones both pass the
  // `isRunning == false` check first.
  engine.slowStep = {
    arrived.signal()
    usleep(200_000)
  }
  let group = DispatchGroup()
  for _ in 0..<2 {
    group.enter()
    DispatchQueue.global().async {
      engine.start()
      group.leave()
    }
  }
  expect(group.wait(timeout: .now() + 10) == .success, "b0: both starts finished")
  expect(engine.isRunning, "b1: running")
  expect(engine.observerRegisterCalls.get == 1, "b2: the photo observer is registered ONCE (got \(engine.observerRegisterCalls.get))")
  expect(engine.lifecycle.monitorStarts == 1, "b3: ONE network monitor started (got \(engine.lifecycle.monitorStarts))")
  expect(FakeMonitor.alive.get == 1, "b3: one monitor alive (got \(FakeMonitor.alive.get))")
  // A start on an already running engine finishes setup without duplicates.
  engine.start()
  expect(engine.observerRegisterCalls.get == 1 && engine.lifecycle.monitorStarts == 1, "b4: a third start adds nothing")
  engine.stop()
  expect(FakeMonitor.alive.get == 0, "b5: stop cancels the monitor; none leaks (alive \(FakeMonitor.alive.get))")
  expect(engine.observerUnregisterCalls.get == 1 && !engine.lifecycle.observerRegistered, "b5: the observer is unregistered once")
  // Starting again registers again (one each).
  engine.slowStep = {}
  engine.start()
  expect(engine.observerRegisterCalls.get == 2 && engine.lifecycle.monitorStarts == 2 && FakeMonitor.alive.get == 1,
         "b6: a start after the stop registers one observer and one monitor again")
  engine.stop()
}

// MARK: - (c) finding 5: the fetch result after a stop, a fence seal or a cancel

do {
  let engine = Engine()
  let fence = ManifestWriteFence()
  fence.bind(accountId: "acct-A")
  engine.start()

  // A scan starts: ticket and generation first, then the (slow) fetch.
  let ticket = fence.issue(for: "acct-A")
  let gen = engine.lifecycle.stopGeneration
  // Sign-out lands while the fetch runs: stop() first, then the reset.
  engine.stop()
  fence.advanceForSignOut()
  let late = FakeFetchResult()
  let stored = engine.lifecycle.acceptFetchResult(late, stopGeneration: gen, cancelled: false,
                                                  stillAdmitted: { fence.isCurrent(ticket) })
  expect(!stored, "c1: a fetch that finished after stop() is not stored")
  expect(engine.lifecycle.fetchResult == nil, "c1: no result after the sign-out")

  // A plain stop (no sign-out): the generation alone refuses it.
  let fence2 = ManifestWriteFence()
  fence2.bind(accountId: "acct-A")
  engine.start()
  let t2 = fence2.issue(for: "acct-A")
  let gen2 = engine.lifecycle.stopGeneration
  engine.stop()
  expect(!engine.lifecycle.acceptFetchResult(FakeFetchResult(), stopGeneration: gen2, cancelled: false,
                                             stillAdmitted: { fence2.isCurrent(t2) }),
         "c2: refused after a stop with the fence still bound")

  // The fence alone: sealed by a reset with no stop in between.
  engine.start()
  let t3 = fence2.issue(for: "acct-A")
  let gen3 = engine.lifecycle.stopGeneration
  fence2.advanceForSignOut()
  expect(!engine.lifecycle.acceptFetchResult(FakeFetchResult(), stopGeneration: gen3, cancelled: false,
                                             stillAdmitted: { fence2.isCurrent(t3) }),
         "c3: refused once the sign-out reset sealed the fence")
  expect(fence2.droppedWrites == 0, "c3: the check is not counted as a dropped write")

  // A cancelled scan.
  let fence4 = ManifestWriteFence()
  fence4.bind(accountId: "acct-A")
  let t4 = fence4.issue(for: "acct-A")
  expect(!engine.lifecycle.acceptFetchResult(FakeFetchResult(), stopGeneration: engine.lifecycle.stopGeneration,
                                             cancelled: true, stillAdmitted: { fence4.isCurrent(t4) }),
         "c4: a cancelled scan stores nothing")

  // Control: a scan with nothing in between stores its result.
  let fresh = FakeFetchResult()
  expect(engine.lifecycle.acceptFetchResult(fresh, stopGeneration: engine.lifecycle.stopGeneration, cancelled: false,
                                            stillAdmitted: { fence4.isCurrent(t4) }),
         "c5: control: stored")
  expect(engine.lifecycle.fetchResult === fresh, "c5: the stored result is the scan's")

  // The change observer replaces it only while it is still the stored one.
  let next = FakeFetchResult()
  expect(engine.lifecycle.replaceFetchResult(expected: fresh, with: next), "c6: the observer replaces the current result")
  engine.stop()
  expect(!engine.lifecycle.replaceFetchResult(expected: next, with: FakeFetchResult()), "c7: after a stop the observer's replace is refused")
  expect(engine.lifecycle.fetchResult == nil, "c7: nothing stored")

  // The sign-out order in prepareForStoragePurge: stop(), a scan that started
  // after the stop but before the reset stores its result, the reset seals
  // the fence, then `clearFetchResult()`.
  let fence5 = ManifestWriteFence()
  fence5.bind(accountId: "acct-A")
  engine.stop()
  let t5 = fence5.issue(for: "acct-A")
  let gen5 = engine.lifecycle.stopGeneration
  expect(engine.lifecycle.acceptFetchResult(FakeFetchResult(), stopGeneration: gen5, cancelled: false,
                                            stillAdmitted: { fence5.isCurrent(t5) }),
         "c8: a scan after stop() but before the reset stores (the fence is still bound)")
  fence5.advanceForSignOut()
  engine.lifecycle.clearFetchResult()
  expect(engine.lifecycle.fetchResult == nil, "c8: the clear after the reset drops it")
  expect(!engine.lifecycle.acceptFetchResult(FakeFetchResult(), stopGeneration: gen5, cancelled: false,
                                             stillAdmitted: { fence5.isCurrent(t5) }),
         "c8: and that scan cannot store again")
}

// MARK: - (c9) concurrent: stop() vs a fetch finishing, many times

do {
  let engine = Engine()
  var leaked = 0
  for _ in 0..<300 {
    let fence = ManifestWriteFence()
    fence.bind(accountId: "acct-A")
    engine.start()
    let t = fence.issue(for: "acct-A")
    let gen = engine.lifecycle.stopGeneration
    let group = DispatchGroup()
    group.enter()
    DispatchQueue.global().async {
      engine.lifecycle.acceptFetchResult(FakeFetchResult(), stopGeneration: gen, cancelled: false,
                                         stillAdmitted: { fence.isCurrent(t) })
      group.leave()
    }
    group.enter()
    DispatchQueue.global().async {
      engine.stop()
      group.leave()
    }
    _ = group.wait(timeout: .now() + 5)
    if engine.lifecycle.fetchResult != nil { leaked += 1 }
  }
  expect(leaked == 0, "c9: in 300 races a fetch result never survives the stop (survived \(leaked))")
}

print("backup-engine-lifecycle-test: \(failures.isEmpty ? "PASS" : "FAIL")")
for f in failures { print("  FAILED: \(f)") }
print("backup-engine-lifecycle-test: \(total) assertions, \(failures.count) failed")
exit(failures.isEmpty ? 0 : 1)
