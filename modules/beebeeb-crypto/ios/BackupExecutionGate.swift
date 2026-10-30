import Foundation

/// Task LD-0002 (mobile#252, `RUNNINGBOARD 0xdead10cc`) — the ONE question
/// every SQLite-touching path of the backup engine asks before it runs:
/// may this process hold a SQLite lock right now?
///
/// iOS kills an app that is suspended while it holds a file or SQLite lock
/// (`0xdead10cc`). On 2026-10-30 (build 252) thread 17 was mid
/// `exsqlite3_step` in `NativeBackupEngine.getPendingUploads(limit:)` when the
/// background grace task ended and the app was suspended. The expiration
/// handler ended the task but never stopped the drain or waited for SQLite to
/// go quiet.
///
/// The gate is open while:
/// - the app is foreground (`.active` or `.inactive`), OR
/// - a live background assertion exists: the grace task, a `BGProcessingTask`,
///   or a short assertion around a background-URLSession completion write.
///
/// An expiry CLOSES the gate synchronously (rule 2a) even if another
/// assertion happens to be live, and only a new assertion or foreground
/// reopens it (rule 4). All state transitions are one locked step.
public final class BackupExecutionGate {
  /// The process-wide gate. `NativeBackupEngine`, `ThumbnailQueueDB` and
  /// `ThumbnailWorkerPool` all ask this one. Harness tests build their own.
  public static let shared = BackupExecutionGate(foreground: true)

  public enum AssertionKind: String, CaseIterable {
    case backgroundGrace = "background-grace"
    case backgroundProcessing = "background-processing"
    case backgroundURLSessionCompletion = "background-url-session-completion"
  }

  public struct Assertion: Hashable {
    public let kind: AssertionKind
    public let token: String

    public init(kind: AssertionKind, token: String) {
      self.kind = kind
      self.token = token
    }
  }

  /// What a background-URLSession completion write may do (rule 5).
  public enum BackgroundWriteAdmission: Equatable {
    /// The gate is already open (foreground or another assertion): write now.
    case runNow
    /// No assertion was live; the caller obtained a short one and the gate is
    /// now open for the write.
    case runUnderAssertion
    /// No assertion could be obtained: do NOT touch SQLite; the rows stay
    /// pending and retry on the next foreground.
    case deferred
  }

  private let lock = NSLock()
  private var foreground: Bool
  private var assertions: Set<Assertion> = []
  /// Set by `close()` (an expiry, or `didEnterBackground` with no grace
  /// task). Cleared only by `setForeground(true)` or `beginAssertion`.
  private var forceClosed = false

  public init(foreground: Bool) {
    self.foreground = foreground
  }

  /// The single question: may a SQLite statement be started now?
  public var canStartSQLiteWork: Bool {
    lock.lock()
    defer { lock.unlock() }
    return !forceClosed && (foreground || !assertions.isEmpty)
  }

  public var hasLiveAssertion: Bool {
    lock.lock()
    defer { lock.unlock() }
    return !assertions.isEmpty
  }

  /// `true` when the gate is open because the app is foreground (independent
  /// of any assertion).
  public var isForeground: Bool {
    lock.lock()
    defer { lock.unlock() }
    return foreground
  }

  /// Rule 4: foreground reopens the gate. Background closes it only when no
  /// assertion is live.
  public func setForeground(_ value: Bool) {
    lock.lock()
    foreground = value
    if value { forceClosed = false }
    lock.unlock()
  }

  /// Rule 2(a)/rule 4: an expiry closes the gate synchronously, whatever
  /// assertions remain. A new assertion or foreground reopens it.
  public func close() {
    lock.lock()
    forceClosed = true
    lock.unlock()
  }

  /// Rule 4: a new background assertion starts the gate again.
  @discardableResult
  public func beginAssertion(_ kind: AssertionKind, token: String) -> Assertion {
    let assertion = Assertion(kind: kind, token: token)
    lock.lock()
    assertions.insert(assertion)
    forceClosed = false
    lock.unlock()
    return assertion
  }

  public func endAssertion(_ assertion: Assertion) {
    lock.lock()
    assertions.remove(assertion)
    lock.unlock()
  }

  public func endAssertion(_ kind: AssertionKind, token: String) {
    endAssertion(Assertion(kind: kind, token: token))
  }

  /// Rule 5: a background-URLSession completion that writes the manifest. Runs
  /// now when the gate is already open; otherwise asks for a short assertion
  /// and only proceeds when it really got one.
  public func admitBackgroundCompletionWrite(beginShortAssertion: () -> Bool) -> BackgroundWriteAdmission {
    if canStartSQLiteWork { return .runNow }
    guard beginShortAssertion() else { return .deferred }
    return .runUnderAssertion
  }
}

/// Rule 2(b)/(c): on background-time expiry, abort any in-flight statement and
/// wait (bounded) for the owning serial queues to go quiet BEFORE the
/// background task ends. This is the sequencing; the engine supplies the
/// connection interrupt and queue barriers.
public enum BackupSQLiteQuiesce {
  /// Rule 2: never block longer than this (the handler runs on the main
  /// thread during a grace-task expiry).
  public static let defaultTimeout: TimeInterval = 2.0

  /// Returns `true` when every queue reported quiet before `timeout`.
  ///
  /// Order is the contract: (a) close the gate, (b) interrupt, (c) wait.
  @discardableResult
  public static func run(
    gate: BackupExecutionGate,
    interrupt: () -> Void,
    waitForQuiet: (_ timeout: TimeInterval) -> Bool,
    timeout: TimeInterval = defaultTimeout,
    trace: (String) -> Void = { _ in }
  ) -> Bool {
    gate.close()
    interrupt()
    let quiet = waitForQuiet(timeout)
    trace(quiet ? "backup.quiesce.quiet" : "backup.quiesce.timeout")
    return quiet
  }
}
