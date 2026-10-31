import Foundation

/// Task LD-0002 (TestFlight 252, `RUNNINGBOARD 0xdead10cc`): may this process
/// start a SQLite statement on the backup manifest or the thumbnail queue
/// right now?
///
/// iOS kills an app it suspends while the app holds a SQLite lock. On
/// 2026-10-30 thread 17 was inside `exsqlite3_step` under
/// `NativeBackupEngine.getPendingUploads(limit:)` when the background grace
/// task ran out: its expiration handler ended the task and never stopped the
/// drain or waited for SQLite to go quiet.
///
/// The gate is open while the app is foreground, or while a GENERAL
/// background assertion (the grace task, a `BGProcessingTask`) is live and no
/// expiry has closed the gate since it began. An expiry (`expire()`) closes it
/// until the app is foreground again or a new general assertion begins.
///
/// A background-URLSession completion write takes a `.completionWrite`
/// assertion. It admits that one write (`admitsStatement(completionWrite:)`)
/// and never reopens the gate for the drain or the thumbnail pump: before
/// (mobile#257 review, B2) one completion cleared the expiry for the whole
/// engine.
///
/// Every transition is one locked step.
public final class BackupExecutionGate {
  /// The process-wide gate (`NativeBackupEngine`, `ThumbnailQueueDB`). Tests
  /// build their own.
  public static let shared = BackupExecutionGate(foreground: true)

  public enum AssertionKind: String {
    case backgroundGrace = "background-grace"
    case backgroundProcessing = "background-processing"
    /// Admits its own completion write only (B2).
    case completionWrite = "completion-write"
  }

  public struct Assertion: Hashable {
    public let kind: AssertionKind
    fileprivate let token: UInt64
  }

  private let lock = NSLock()
  private var foreground: Bool
  private var general: Set<Assertion> = []
  private var completionWrites: Set<Assertion> = []
  private var expired = false
  private var nextToken: UInt64 = 0
  private var _closures: UInt64 = 0

  public init(foreground: Bool) {
    self.foreground = foreground
  }

  private var isOpenLocked: Bool {
    foreground || (!expired && !general.isEmpty)
  }

  /// The single question every SQLite path asks before it starts a statement.
  public var canStartSQLiteWork: Bool {
    lock.lock()
    defer { lock.unlock() }
    return isOpenLocked
  }

  /// `canStartSQLiteWork`, or the live completion write `completionWrite`.
  public func admitsStatement(completionWrite: Assertion? = nil) -> Bool {
    lock.lock()
    defer { lock.unlock() }
    if isOpenLocked { return true }
    guard let completionWrite else { return false }
    return completionWrites.contains(completionWrite)
  }

  /// How many times the gate went from open to closed, counted in the same
  /// locked step as the transition (an expiry, the last assertion ending, the
  /// app leaving the foreground with none). A read that started and ended
  /// with the gate open and this count unchanged was not interrupted
  /// (`readIfUninterrupted`), and a producer whose start predates a closure
  /// may have read the closed gate as "no row": the engine refuses its writes
  /// (`isOpen(since:)`, #262 review 1).
  public var closures: UInt64 {
    lock.lock()
    defer { lock.unlock() }
    return _closures
  }

  /// Open now, and not closed once since `closures` was read.
  public func isOpen(since closures: UInt64) -> Bool {
    lock.lock()
    defer { lock.unlock() }
    return isOpenLocked && _closures == closures
  }

  /// One locked transition; a close is counted in the same step.
  private func transition(_ change: () -> Void) {
    lock.lock()
    let wasOpen = isOpenLocked
    change()
    if wasOpen && !isOpenLocked { _closures &+= 1 }
    lock.unlock()
  }

  public func setForeground(_ value: Bool) {
    transition {
      foreground = value
      if value { expired = false }
    }
  }

  /// Background time ended (an expiry handler, or `didEnterBackground` with no
  /// assertion): the gate stays closed until foreground or a new general
  /// assertion. Returns true when the gate is now closed, and the caller must
  /// interrupt and wait. False while the app is foreground: nothing is about to
  /// be suspended (a `BGProcessingTask` can expire as the user opens the app),
  /// and an interrupt would only abort the foreground backup's statement.
  @discardableResult
  public func expire() -> Bool {
    lock.lock()
    defer { lock.unlock() }
    let wasOpen = isOpenLocked
    expired = true
    if wasOpen && !isOpenLocked { _closures &+= 1 }
    return !foreground
  }

  /// A general assertion opens the gate (and reopens it after an expiry); a
  /// completion-write assertion admits only its own write.
  public func beginAssertion(_ kind: AssertionKind) -> Assertion {
    lock.lock()
    defer { lock.unlock() }
    nextToken &+= 1
    let assertion = Assertion(kind: kind, token: nextToken)
    if kind == .completionWrite {
      completionWrites.insert(assertion)
    } else {
      general.insert(assertion)
      expired = false
    }
    return assertion
  }

  public func endAssertion(_ assertion: Assertion) {
    transition {
      general.remove(assertion)
      completionWrites.remove(assertion)
    }
  }

  /// P2a: runs `read` while the gate is open and returns its value only when
  /// no expiry closed the gate meanwhile. An interrupted step reads as 0 or "no
  /// rows" in the engine's helpers; nil here means "unknown, keep the last
  /// value", never "nothing pending".
  public func readIfUninterrupted<T>(_ read: () -> T) -> T? {
    lock.lock()
    let before = _closures
    let open = isOpenLocked
    lock.unlock()
    guard open else { return nil }
    let value = read()
    lock.lock()
    defer { lock.unlock() }
    return isOpenLocked && _closures == before ? value : nil
  }
}

/// LD-0002 (mobile#257 review, B4): the connection an expiry may interrupt
/// from any thread. Its owner publishes a connection after opening it and
/// withdraws it BEFORE closing it. `interrupt()` holds the same lock while it
/// calls into SQLite, so a close (which withdraws first) cannot free a
/// connection an interrupt is still using. Before, the owner closed first and
/// cleared the pointer after, and an interrupt in between used a freed handle.
public final class SQLiteInterruptTarget {
  private let lock = NSLock()
  private var connection: OpaquePointer?
  private let interruptConnection: (OpaquePointer) -> Void

  /// `interrupt` is the SQLite copy's own `*_interrupt` (the manifest is on
  /// expo's `exsqlite3_*`, the thumbnail queue on the Rust core's `sqlite3_*`).
  public init(interrupt: @escaping (OpaquePointer) -> Void) {
    self.interruptConnection = interrupt
  }

  public func publish(_ connection: OpaquePointer) {
    lock.lock()
    self.connection = connection
    lock.unlock()
  }

  /// Call BEFORE closing the published connection.
  public func withdraw() {
    lock.lock()
    connection = nil
    lock.unlock()
  }

  public var isPublished: Bool {
    lock.lock()
    defer { lock.unlock() }
    return connection != nil
  }

  /// Aborts the statement running on the published connection, if any. Safe
  /// from any thread; a no-op when nothing is published.
  public func interrupt() {
    lock.lock()
    defer { lock.unlock() }
    if let connection { interruptConnection(connection) }
  }
}

/// LD-0002: the sequence that makes a suspension safe. (a) close the gate,
/// (b) interrupt the in-flight statements, (c) wait, bounded, for the owning
/// serial queues to exit their current block. The caller ends its background
/// task only after this returns: ending the task is always the last step.
public enum BackupSQLiteQuiesce {
  /// Never block longer than this (a grace expiry runs on the main thread).
  public static let defaultTimeout: TimeInterval = 2.0

  public enum Outcome: String {
    /// The app is foreground: nothing was closed, interrupted or awaited.
    case foreground
    case quiet
    case timedOut
  }

  @discardableResult
  public static func run(
    gate: BackupExecutionGate,
    interrupt: () -> Void,
    waitForQuiet: (_ timeout: TimeInterval) -> Bool,
    timeout: TimeInterval = defaultTimeout
  ) -> Outcome {
    guard gate.expire() else { return .foreground }
    interrupt()
    return waitForQuiet(timeout) ? .quiet : .timedOut
  }

  /// A barrier on a serial queue: true once every block enqueued before it has
  /// exited. Never call it from `queue` itself (it would time out). The
  /// barrier is a `.userInitiated` work item with `.enforceQoS` and the wait is
  /// on the item, so the utility queue's current block is boosted while the
  /// expiry handler waits (#262 review 11: a semaphore passes no priority on,
  /// and a throttled background block took past the 2 s bound).
  public static func waitForSerialQueue(_ queue: DispatchQueue, timeout: TimeInterval) -> Bool {
    let barrier = DispatchWorkItem(qos: .userInitiated, flags: .enforceQoS) {}
    queue.async(execute: barrier)
    return barrier.wait(timeout: .now() + max(0, timeout)) == .success
  }
}

/// LD-0002 (#262 review 3): what a gated connection's progress handler asks.
/// An interrupt aborts only the statements running when it lands; SQLite
/// clears it once none is running, so a block that already holds the
/// connection would start its next statement normally after a quiesce. The
/// owner installs a progress handler on the connection right after opening
/// it (`*_progress_handler(db, progressOps, callback, progressContext)`); the
/// callback calls `shouldAbort(context:)`, and while the gate refuses every
/// statement on that connection stops within `progressOps` VM steps, however
/// it was started. A completion write admitted under its own assertion runs
/// inside `withCompletionWrite` and keeps going.
public final class SQLiteStatementGate {
  public static let progressOps: Int32 = 1_000

  public let gate: BackupExecutionGate
  private let lock = NSLock()
  private var _completionWrite: BackupExecutionGate.Assertion?

  public init(gate: BackupExecutionGate) {
    self.gate = gate
  }

  /// The completion write the connection's current block runs under.
  public var completionWrite: BackupExecutionGate.Assertion? {
    lock.lock()
    defer { lock.unlock() }
    return _completionWrite
  }

  public func withCompletionWrite<T>(_ assertion: BackupExecutionGate.Assertion, _ body: () -> T) -> T {
    lock.lock()
    _completionWrite = assertion
    lock.unlock()
    defer {
      lock.lock()
      _completionWrite = nil
      lock.unlock()
    }
    return body()
  }

  public var admits: Bool {
    gate.admitsStatement(completionWrite: completionWrite)
  }

  /// The C callback's context (the owner keeps this object alive as long as
  /// the connection).
  public var progressContext: UnsafeMutableRawPointer {
    Unmanaged.passUnretained(self).toOpaque()
  }

  /// For the C progress callback: non-zero aborts the running statement.
  public static func shouldAbort(context: UnsafeMutableRawPointer?) -> Int32 {
    guard let context else { return 0 }
    return Unmanaged<SQLiteStatementGate>.fromOpaque(context).takeUnretainedValue().admits ? 0 : 1
  }
}
