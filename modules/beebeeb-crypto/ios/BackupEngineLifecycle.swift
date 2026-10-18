import Foundation

/// Task 1667 round 11 (review of mobile#182 at de23774e, findings 3 and 5).
///
/// The camera-roll engine's start/stop state, behind ONE lock.
///
/// Finding 3: `scheduleManifestOpenRetry` ran `start()` from
/// `DispatchQueue.global`, while `start()` / `stop()` / `disablePhotoBackup`
/// ran on the Expo queue. `start()`'s checks and writes (`isRunning`, the
/// photo-library observer, the network monitor, the drain loop) were not
/// atomic, and `DispatchWorkItem.cancel()` cannot stop a retry that is
/// already running. A retry that passed its checks while the user turned
/// backup off then set `isRunning = true` again: backup ran after it was
/// disabled. Two concurrent starts both saw `isRunning == false`, registered
/// the photo observer twice and replaced one `NWPathMonitor` with another,
/// leaving the first one running.
///
/// Finding 5: a scan whose PhotoKit fetch was still running across `stop()`
/// (sign-out) assigned its result to `currentFetchResult` AFTER `stop()`
/// cleared it, so a `PHChange` after the next sign-in was diffed against the
/// previous account's library state.
///
/// Rules (the engine routes every one of these through this type):
/// - `userStart` / `userStop` / `internalStop` / `runRetry` hold the lock for
///   the whole start or stop body, so they never interleave. The lock is
///   recursive (`resume()` and the manual trigger call `start()`, and
///   `start()` stops a running engine when the manifest cannot open).
/// - `wantsRunning` is the user's intent: `userStart` sets it, `userStop`
///   clears it (disable, teardown, sign-out, a confirmed account mismatch).
///   A retry runs only while it is set AND the retry is still the latest one
///   scheduled: a retry already executing waits for the lock, then sees
///   `stop()`'s result and does nothing.
/// - The photo observer is registered at most once, and a network monitor is
///   started only when none is running (never replaced while it runs, so no
///   monitor is ever left running unreferenced); `stopMonitor` cancels it.
/// - A fetch result is accepted only when no stop happened since its scan
///   began, the scan was not cancelled, and the caller's fence check (the
///   scan's manifest write ticket) still passes, all under the lock every
///   stop takes. The PhotoKit change observer replaces it only while it is
///   still the result it diffed against.
///
///
/// Round 12 (review of mobile#182 at e9a93077):
/// - Item 3: who runs the engine is explicit (`RunOwner`). A background task
///   that set `isRunning` owns the run until the user starts backup on the
///   same account; from then on the task's exit no longer idles it
///   (`endBackgroundRun`). Before, the task idled on exit whenever it had set
///   `isRunning` and the account generation was unchanged, so the backup the
///   user had just started stopped in the foreground.
/// - Item 8: `userStart(prepare:_:)` / `runRetry(_:prepare:_:)` run `prepare`
///   (the master-key load, which can show a keychain or Face ID prompt)
///   OUTSIDE the transition lock, then the body inside it, which re-validates
///   what `prepare` saw. Before, the lock was held across that prompt, and
///   every scan's `acceptFetchResult` (a cooperative-pool thread each) and a
///   sign-out's `stop()` waited on it.
///
/// Pure (no PhotoKit, no Network), so
/// `scripts/swift-tests/backup-engine-lifecycle-test.swift` drives it from
/// real threads.
final class BackupEngineLifecycle {
  /// Serializes every transition (start, stop, retry, observer, monitor,
  /// accepting a fetch result). Recursive: see the rules above.
  private let transition = NSRecursiveLock()
  /// Guards the stored values. Readers (diagnostics, the change observer)
  /// take only this one, so a read never waits for a transition that is
  /// running (a start can wait on the keychain). Never held across a call
  /// out of this type.
  private let state = NSLock()
  private var _wantsRunning = false
  private var _retryToken: UInt64 = 0
  private var _observerRegistered = false
  private var _monitor: AnyObject?
  private var _stopGeneration: UInt64 = 0
  private var _fetchResult: AnyObject?
  private var _observerRegistrations = 0
  private var _monitorStarts = 0
  private var _monitorCancels = 0
  private var _runOwner: RunOwner = .none
  /// Round 12: user stops so far (a start whose key load spans one yields).
  private var _userStops: UInt64 = 0

  /// Round 12 (review item 3): who set the engine running.
  enum RunOwner: Equatable {
    case none
    /// A `BGProcessingTask` set `isRunning` itself; its exit idles the engine.
    case background
    /// The user's start (or its retry) set up the run: observer, monitor and
    /// drain loop. Only a stop ends it.
    case user
  }

  init() {}

  /// Runs `body` as one transition.
  @discardableResult
  func locked<T>(_ body: () throws -> T) rethrows -> T {
    transition.lock()
    defer { transition.unlock() }
    return try body()
  }

  private func read<T>(_ body: () -> T) -> T {
    state.lock()
    defer { state.unlock() }
    return body()
  }

  private func write(_ body: () -> Void) {
    state.lock()
    body()
    state.unlock()
  }

  // MARK: start / stop / retry

  /// The user (JS) asked for backup to run: `enablePhotoBackup`, resume, the
  /// manual trigger. `body` is the engine's start, run as one transition.
  func userStart(_ body: () -> Void) {
    locked {
      write { _wantsRunning = true }
      body()
    }
  }

  /// What a start body asks of its caller.
  enum StartStep: Equatable {
    case done
    /// What `prepare` saw changed before the body ran (another account, the
    /// key cache, the engine stopped meanwhile): prepare again, then run the
    /// body again.
    case prepareAgain
  }

  /// How many times a start prepares (outside the lock) and runs (inside it)
  /// before giving up on a state that keeps changing under it.
  static let maxStartAttempts = 2

  /// Round 12 (review item 8): the user's start with a slow `prepare` (the
  /// master-key load) that runs OUTSIDE the transition lock. `body` then runs
  /// as one transition with what `prepare` returned, and re-validates it
  /// there. A user stop that lands while `prepare` runs wins: the start then
  /// does nothing (with the lock held across the load, as before, the stop
  /// waited and came second; the order of the user's two actions is kept).
  /// Returns whether a body ran and said `.done`.
  @discardableResult
  func userStart<P>(prepare: () -> P, _ body: (P) -> StartStep) -> Bool {
    for _ in 0..<Self.maxStartAttempts {
      let stopsBefore = read { _userStops }
      let prepared = prepare()
      let step: StartStep? = locked {
        guard read({ _userStops == stopsBefore }) else { return nil }
        write { _wantsRunning = true }
        return body(prepared)
      }
      guard let step else { return false }
      if step == .done { return true }
    }
    return false
  }

  /// The user (or sign-out, teardown, a confirmed account mismatch) stopped
  /// backup. Clears the intent and voids every scheduled retry and every
  /// running scan's fetch result, then runs the engine's stop.
  func userStop(_ body: () -> Void) {
    locked {
      write {
        _wantsRunning = false
        _retryToken &+= 1
        _stopGeneration &+= 1
        _fetchResult = nil
        _runOwner = .none
        _userStops &+= 1
      }
      body()
    }
  }

  /// A stop that keeps the user's intent (`start()` stops a running engine
  /// whose manifest cannot open, then schedules a retry).
  func internalStop(_ body: () -> Void) {
    locked {
      write {
        _stopGeneration &+= 1
        _fetchResult = nil
        _runOwner = .none
      }
      body()
    }
  }

  // MARK: run ownership (round 12, review item 3)

  /// The user's start set up the run (both of `startLocked`'s running
  /// branches). MUST be called inside a transition.
  func claimUserRun() {
    locked { write { _runOwner = .user } }
  }

  /// The background task's start, as one transition: when the engine is not
  /// running, `setRunning` runs and the task owns the run. Returns whether it
  /// was running already (then the task owns nothing and never idles it).
  func beginBackgroundRun(isRunning: () -> Bool, setRunning: () -> Void) -> Bool {
    locked {
      if isRunning() { return true }
      setRunning()
      write { _runOwner = .background }
      return false
    }
  }

  /// The background task's exit, as one transition: `idle` runs only while
  /// the task still owns the run (no user start, stop or other start since)
  /// and `stillCurrent` (the task's account generation) holds. Returns
  /// whether it idled.
  ///
  /// Ownership, not `wantsRunning` alone: a user start that was REFUSED (no
  /// key, an unconfirmed key owner, no token) leaves `wantsRunning` set
  /// without setting anything up. Keeping `isRunning` then would leave a
  /// running flag with no observer, monitor or drain loop, and the next
  /// `start()` would take its "already running" branch, which skips the
  /// master-key and owner checks. Only a start that set the run up claims it
  /// (`claimUserRun`), and after that the task's exit never idles it.
  @discardableResult
  func endBackgroundRun(stillCurrent: () -> Bool, idle: () -> Void) -> Bool {
    locked {
      guard read({ _runOwner == .background }), stillCurrent() else { return false }
      idle()
      write { _runOwner = .none }
      return true
    }
  }

  var runOwner: RunOwner { read { _runOwner } }

  var wantsRunning: Bool { read { _wantsRunning } }

  /// A new retry of `start()`; any earlier one is void.
  func scheduleRetry() -> UInt64 {
    locked {
      read {
        _retryToken &+= 1
        return _retryToken
      }
    }
  }

  func cancelRetries() {
    locked { write { _retryToken &+= 1 } }
  }

  /// Runs `body` (the engine's start) for the retry `token` only while the
  /// user still wants backup running and no stop, cancel or newer retry came
  /// after it. Checked and run as one transition, so a stop either finished
  /// before (the retry does nothing) or waits until the start is done.
  @discardableResult
  func runRetry(_ token: UInt64, _ body: () -> Void) -> Bool {
    locked {
      guard read({ _wantsRunning && token == _retryToken }) else { return false }
      body()
      return true
    }
  }

  /// Round 12 (review item 8): the retry with its `prepare` outside the lock
  /// (see `userStart(prepare:_:)`). The intent and token are checked in the
  /// lock before each body. Returns whether a body ran.
  @discardableResult
  func runRetry<P>(_ token: UInt64, prepare: () -> P, _ body: (P) -> StartStep) -> Bool {
    var ran = false
    for _ in 0..<Self.maxStartAttempts {
      guard read({ _wantsRunning && token == _retryToken }) else { return ran }
      let prepared = prepare()
      let step: StartStep? = locked {
        guard read({ _wantsRunning && token == _retryToken }) else { return nil }
        return body(prepared)
      }
      guard let step else { return ran }
      ran = true
      if step == .done { return true }
    }
    return ran
  }

  // MARK: observer / monitor

  /// Registers the photo-library observer unless it already is. Returns
  /// whether `register` ran.
  @discardableResult
  func registerObserverOnce(_ register: () -> Void) -> Bool {
    locked {
      guard !read({ _observerRegistered }) else { return false }
      register()
      write {
        _observerRegistered = true
        _observerRegistrations += 1
      }
      return true
    }
  }

  @discardableResult
  func unregisterObserver(_ unregister: () -> Void) -> Bool {
    locked {
      guard read({ _observerRegistered }) else { return false }
      unregister()
      write { _observerRegistered = false }
      return true
    }
  }

  var observerRegistered: Bool { read { _observerRegistered } }

  /// Starts a network monitor unless one is running. Returns whether `make`
  /// ran. A running monitor is never replaced; `stopMonitor` cancels it.
  @discardableResult
  func startMonitorIfNeeded(_ make: () -> AnyObject) -> Bool {
    locked {
      guard read({ _monitor == nil }) else { return false }
      let monitor = make()
      write {
        _monitor = monitor
        _monitorStarts += 1
      }
      return true
    }
  }

  func stopMonitor(_ cancel: (AnyObject) -> Void) {
    locked {
      guard let old = read({ _monitor }) else { return }
      write { _monitor = nil }
      cancel(old)
      write { _monitorCancels += 1 }
    }
  }

  var monitor: AnyObject? { read { _monitor } }

  // MARK: PhotoKit fetch result

  /// The generation a scan captures BEFORE its PhotoKit fetch.
  var stopGeneration: UInt64 { read { _stopGeneration } }

  /// Stores a full scan's fetch result. Refused (nothing stored) when a stop
  /// or sign-out came after `stopGeneration` was captured, the scan was
  /// cancelled, or `stillAdmitted` (the scan's fence ticket) fails. Runs as
  /// one transition: no stop can land between the checks and the store.
  /// `result` nil stores nil (a selected-album scan has no single result).
  @discardableResult
  func acceptFetchResult(
    _ result: AnyObject?, stopGeneration: UInt64, cancelled: Bool, stillAdmitted: () -> Bool
  ) -> Bool {
    locked {
      // Every change of `_stopGeneration` is a transition too, so it cannot
      // move between this check and the store below.
      guard !cancelled, read({ stopGeneration == _stopGeneration }), stillAdmitted() else { return false }
      write { _fetchResult = result }
      return true
    }
  }

  /// The change observer: `next` replaces `expected` only while it is still
  /// the stored result (a stop in between cleared it). Atomic on the value
  /// lock, so it never waits for a transition.
  @discardableResult
  func replaceFetchResult(expected: AnyObject, with next: AnyObject?) -> Bool {
    var replaced = false
    write {
      if let current = _fetchResult, current === expected {
        _fetchResult = next
        replaced = true
      }
    }
    return replaced
  }

  /// Forget the stored result (sign-out after its reset, a scope change).
  /// Also voids every scan still running.
  func clearFetchResult() {
    locked {
      write {
        _stopGeneration &+= 1
        _fetchResult = nil
      }
    }
  }

  var fetchResult: AnyObject? { read { _fetchResult } }

  // MARK: diagnostics and tests

  var observerRegistrations: Int { read { _observerRegistrations } }
  var monitorStarts: Int { read { _monitorStarts } }
  var monitorCancels: Int { read { _monitorCancels } }
}
