import Foundation

/// Task 1667 round 3 (Codex P1 "Enforce the eight-second sign-out deadline").
///
/// `App.signOut` awaits the sign-out mark flush BEFORE `logout()` revokes the
/// session, so every second the flush runs is a second the user stays signed
/// in with the key and the plaintext caches still on the device. Round 2
/// checked its deadline only before starting a request; one request to a
/// stalled endpoint then waited for `metadataSession`'s 30 s request / 60 s
/// resource timeout.
///
/// `run` bounds the WHOLE flush, the row load included, with a hard deadline
/// (`withHardDeadline`): when it passes, the flush returns at once and its
/// task is cancelled, which cancels the in-flight `URLSession` task. Each
/// request is also handed a timeout no longer than the budget left. Whatever
/// is still unmarked is kept by the sign-out reset
/// (`BackupManifestStore.resetInPlace` -> `backup_pending_marks`).
///
/// Kept free of the engine (no PhotoKit/UIKit/Expo) so
/// `scripts/swift-tests/sign-out-mark-flush-test.swift` compiles it with
/// swiftc and drives it with a stalled URLProtocol.
enum SignOutMarkFlush {
  /// The sign-out flush deadline. The JS side waits at most this plus
  /// `SIGN_OUT_MARK_FLUSH_JS_MARGIN_MS` (src/lib/sign-out-mark-flush.ts).
  static let defaultDeadline: TimeInterval = 8

  /// Never hand a request a zero or negative timeout.
  static let minimumRequestTimeout: TimeInterval = 0.05

  struct Outcome {
    let candidates: Int
    let marked: Int
    /// The hard deadline cut the flush short.
    let timedOut: Bool
  }

  /// Sends `mark` for each row from `loadRows`, in order, up to
  /// `attemptsPerRow` attempts each, and stops at the first row that fails
  /// every attempt (the server is not taking marks now) or when `shouldStop`
  /// says so (the account changed). `mark` receives the request timeout to
  /// use: the budget left, never more. Returns by `deadline` whatever the
  /// transport does.
  static func run<Row>(
    deadline: TimeInterval = defaultDeadline,
    attemptsPerRow: Int = 2,
    retryDelay: TimeInterval = 0.2,
    loadRows: @escaping () -> [Row],
    shouldStop: @escaping () -> Bool = { false },
    mark: @escaping (Row, TimeInterval) async -> Bool
  ) async -> Outcome {
    let stopAt = Date().addingTimeInterval(deadline)
    let progress = FlushProgress()
    let finished: Bool? = await withHardDeadline(deadline) {
      let rows = loadRows()
      progress.setCandidates(rows.count)
      rowLoop: for row in rows {
        for attempt in 1...max(1, attemptsPerRow) {
          let remaining = stopAt.timeIntervalSinceNow
          if Task.isCancelled || remaining <= 0 { return false }
          if await mark(row, requestTimeout(remaining: remaining)) {
            progress.markOne()
            continue rowLoop
          }
          if shouldStop() { return true }
          if attempt < attemptsPerRow {
            let pause = min(retryDelay, stopAt.timeIntervalSinceNow)
            if pause > 0 { try? await Task.sleep(nanoseconds: UInt64(pause * 1_000_000_000)) }
          }
        }
        // This row failed every attempt: the server is not taking marks now.
        return true
      }
      return true
    }
    let snapshot = progress.snapshot()
    return Outcome(candidates: snapshot.candidates, marked: snapshot.marked, timedOut: finished != true)
  }

  /// The timeout for one request: the budget left, at least
  /// `minimumRequestTimeout`.
  static func requestTimeout(remaining: TimeInterval) -> TimeInterval {
    max(minimumRequestTimeout, remaining)
  }

  /// Runs `operation` in its own task and returns its result, or nil once
  /// `seconds` have passed, whichever comes first. On the deadline the
  /// operation's task is cancelled (an `URLSession` async call cancels its
  /// data task) and NOT awaited: an operation that ignores cancellation
  /// cannot hold the caller past the deadline. Cancelling the caller
  /// counts as the deadline.
  static func withHardDeadline<T>(_ seconds: TimeInterval, _ operation: @escaping () async -> T) async -> T? {
    let race = DeadlineRace<T>()
    return await withTaskCancellationHandler {
      await withCheckedContinuation { (continuation: CheckedContinuation<T?, Never>) in
        guard race.install(continuation) else { return }
        let work = Task { race.finish(await operation()) }
        let timer = Task {
          try? await Task.sleep(nanoseconds: UInt64(max(0, seconds) * 1_000_000_000))
          race.expire()
        }
        race.attach(work: work, timer: timer)
      }
    } onCancel: {
      race.expire()
    }
  }
}

/// Counts shared between the flush task and the caller, which reads them
/// even when the flush was cut off mid-row.
private final class FlushProgress {
  private let lock = NSLock()
  private var candidates = 0
  private var marked = 0

  func setCandidates(_ n: Int) { lock.lock(); candidates = n; lock.unlock() }
  func markOne() { lock.lock(); marked += 1; lock.unlock() }
  func snapshot() -> (candidates: Int, marked: Int) {
    lock.lock()
    defer { lock.unlock() }
    return (candidates, marked)
  }
}

/// One-shot race between the operation and the timer: the first to settle
/// resumes the continuation; the loser is cancelled.
private final class DeadlineRace<T> {
  private let lock = NSLock()
  private var continuation: CheckedContinuation<T?, Never>?
  private var work: Task<Void, Never>?
  private var timer: Task<Void, Never>?
  private var settled = false

  /// False when the race already settled (caller cancelled first); the
  /// continuation is then resumed here with nil.
  func install(_ c: CheckedContinuation<T?, Never>) -> Bool {
    lock.lock()
    if settled {
      lock.unlock()
      c.resume(returning: nil)
      return false
    }
    continuation = c
    lock.unlock()
    return true
  }

  func attach(work: Task<Void, Never>, timer: Task<Void, Never>) {
    lock.lock()
    if settled {
      lock.unlock()
      work.cancel()
      timer.cancel()
      return
    }
    self.work = work
    self.timer = timer
    lock.unlock()
  }

  func finish(_ value: T) {
    lock.lock()
    guard !settled else { lock.unlock(); return }
    settled = true
    let c = continuation, t = timer
    continuation = nil; work = nil; timer = nil
    lock.unlock()
    t?.cancel()
    c?.resume(returning: value)
  }

  func expire() {
    lock.lock()
    guard !settled else { lock.unlock(); return }
    settled = true
    let c = continuation, w = work
    continuation = nil; work = nil; timer = nil
    lock.unlock()
    w?.cancel()
    c?.resume(returning: nil)
  }
}
