import Foundation
import SQLite3

/// Task 1667 round 6 (Codex P2 "Reopen the native manifest after successful
/// recovery", mobile#182 at de6c1498).
///
/// The camera-roll backup engine's ONE native connection to
/// `Documents/SQLite/beebeeb-backup.db`, and every transition it goes
/// through: the open (at launch, and every reopen after that), the sign-out
/// reset through it, and the close / recover / reopen when that reset failed.
///
/// Before round 6 the only open was the one `init()` enqueued. A sign-out
/// whose in-place reset failed closed the handle; the recovery then emptied
/// (or replaced) the file and cleared the pending flag, but nothing reopened
/// the handle. A sign-in in the same process then ran `start()` with no
/// database: scans, manifest checks and uploads all no-oped on `db == nil`
/// until the app was restarted, and nothing said so.
///
/// Rules:
/// - `finishAfterFailedReset` reopens the handle in the same call as a
///   successful recovery (`NativeBackupEngine` runs that call in one
///   `dbQueue.sync` block, inside the JS purge hold, so nothing else touches
///   the handle between the recovery and the reopen).
/// - `openIfClosed` is safe to call from every entry point: a no-op when a
///   handle is open; otherwise it opens, checks the file really is a
///   readable manifest, and applies a still-pending sign-out reset. A file
///   it cannot open, cannot read, or cannot empty leaves NO handle open and
///   is reported as an `OpenFailure`, never a silent nil handle.
/// - While a sign-out with a failed reset is between its two halves
///   (`resetForSignOut` returned false, `finishAfterFailedReset` not yet
///   called), `openIfClosed` refuses: the JS handle is still open on the
///   file and the recovery may replace it.
///
/// Not thread-safe by design: every member MUST run on the owner's private
/// serial queue (`NativeBackupEngine.dbQueue`). `swift-db-queue-audit.ts`
/// treats `manifestHandle` exactly like the engine's `db` property.
final class BackupManifestHandle {
  enum OpenFailure: String, Equatable {
    /// `sqlite3_open_v2` failed (no such directory, no permission, a path
    /// that cannot be a database file).
    case openFailed = "open_failed"
    /// The file opened but is not a readable database, or the manifest
    /// schema could not be created in it.
    case unreadable = "unreadable"
    /// A sign-out reset is still pending and could not be applied. The
    /// handle is closed again so nothing in this process reads the outgoing
    /// account's rows.
    case pendingResetFailed = "pending_reset_failed"
    /// A sign-out whose reset failed has not finished yet (JS has not closed
    /// its handle and called `finishBackupManifestPurge`).
    case purgeInFlight = "purge_in_flight"
  }

  struct FinishResult: Equatable {
    /// The manifest is empty (reset, or replaced when `unlinked`).
    let ok: Bool
    let unlinked: Bool
    /// A handle is open on the resulting file.
    let reopened: Bool
    /// Why it is not, when `ok` but not `reopened`.
    let reopenFailure: OpenFailure?
  }

  /// "A sign-out could not empty the manifest", kept across launches.
  struct ResetPendingFlag {
    let get: () -> Bool
    let set: (Bool) -> Void

    static func userDefaults(_ key: String) -> ResetPendingFlag {
      ResetPendingFlag(
        get: { UserDefaults.standard.bool(forKey: key) },
        set: { pending in
          if pending {
            UserDefaults.standard.set(true, forKey: key)
          } else {
            UserDefaults.standard.removeObject(forKey: key)
          }
        }
      )
    }
  }

  static let openFlags: Int32 = SQLITE_OPEN_READWRITE | SQLITE_OPEN_CREATE | SQLITE_OPEN_FULLMUTEX

  let path: String
  private(set) var db: OpaquePointer?
  /// True from a failed `resetForSignOut` until `finishAfterFailedReset`.
  private(set) var awaitingPurgeFinish = false
  /// How many times a handle was opened (diagnostics and tests).
  private(set) var openCount = 0
  /// Whether the last successful open applied a pending sign-out reset.
  private(set) var lastOpenAppliedPendingReset = false

  private let pendingReset: ResetPendingFlag
  private let prepareSchema: (OpaquePointer) -> Void
  private let now: () -> Int64

  init(
    path: String,
    pendingReset: ResetPendingFlag,
    now: @escaping () -> Int64 = BackupManifestStore.currentMs,
    prepareSchema: @escaping (OpaquePointer) -> Void
  ) {
    self.path = path
    self.pendingReset = pendingReset
    self.now = now
    self.prepareSchema = prepareSchema
  }

  var isOpen: Bool { db != nil }

  /// Opens the manifest when no handle is open. Returns nil when a handle is
  /// open on return, and the reason otherwise; a failure never leaves a
  /// handle open.
  @discardableResult
  func openIfClosed() -> OpenFailure? {
    if db != nil { return nil }
    if awaitingPurgeFinish { return .purgeInFlight }
    try? FileManager.default.createDirectory(
      at: URL(fileURLWithPath: path).deletingLastPathComponent(),
      withIntermediateDirectories: true
    )
    var handle: OpaquePointer?
    guard sqlite3_open_v2(path, &handle, Self.openFlags, nil) == SQLITE_OK, let opened = handle else {
      if let handle { sqlite3_close_v2(handle) }
      return .openFailed
    }
    // WAL for concurrent access with the JS layer. Its result is not the
    // check: another connection can briefly hold the lock a mode change
    // needs. The schema read below is.
    sqlite3_exec(opened, "PRAGMA journal_mode = WAL", nil, nil, nil)
    prepareSchema(opened)
    guard BackupManifestStore.tableExistsChecked(opened, "backup_assets") == true else {
      sqlite3_close_v2(opened)
      return .unreadable
    }
    var appliedPendingReset = false
    if pendingReset.get() {
      guard BackupManifestStore.resetInPlace(opened, nowMs: now()) else {
        sqlite3_close_v2(opened)
        return .pendingResetFailed
      }
      pendingReset.set(false)
      appliedPendingReset = true
    }
    db = opened
    openCount += 1
    lastOpenAppliedPendingReset = appliedPendingReset
    return nil
  }

  /// The sign-out reset, through the open handle: the outgoing account
  /// adopts pre-column rows, then the manifest is emptied in place. On
  /// failure the handle is closed, the pending flag set, and opens are
  /// refused until `finishAfterFailedReset`; the file itself is kept (the
  /// JS handle is still open on it). Returns whether the reset succeeded.
  func resetForSignOut(outgoingAccountId: String?) -> Bool {
    if let db {
      if let outgoingAccountId {
        BackupManifestStore.adoptUnowned(db, accountId: outgoingAccountId)
      }
      if BackupManifestStore.resetInPlace(db, nowMs: now()) {
        pendingReset.set(false)
        return true
      }
      sqlite3_close_v2(db)
      self.db = nil
    }
    pendingReset.set(true)
    awaitingPurgeFinish = true
    return false
  }

  /// Second half of a sign-out whose reset failed; called once the JS
  /// handle is closed (`allowUnlink` = that close succeeded). With no
  /// connection open, the reset is retried on a connection of its own, or
  /// the file replaced (`BackupManifestStore.recoverAfterFailedReset`). On
  /// success the handle is reopened on the resulting file before this
  /// returns. On failure the reset stays pending and the next
  /// `openIfClosed` applies it (or refuses).
  func finishAfterFailedReset(allowUnlink: Bool) -> FinishResult {
    if let db {
      sqlite3_close_v2(db)
      self.db = nil
    }
    let recovered = BackupManifestStore.recoverAfterFailedReset(path: path, nowMs: now(), allowUnlink: allowUnlink)
    awaitingPurgeFinish = false
    guard recovered.ok else {
      return FinishResult(ok: false, unlinked: recovered.unlinked, reopened: false, reopenFailure: nil)
    }
    pendingReset.set(false)
    let failure = openIfClosed()
    return FinishResult(ok: true, unlinked: recovered.unlinked, reopened: failure == nil, reopenFailure: failure)
  }
}

/// Task 1667 round 6: what an entry point that needs the manifest
/// (`start()`, the background task) does with an open attempt. A failure is
/// never a silent no-op: it is a visible stop reason and a bounded retry
/// (2, 4, 8, 16, then every 30 s, the rebuild gate's database backoff) until
/// an open succeeds.
struct ManifestAvailability: Equatable {
  enum Decision: Equatable {
    case proceed
    case refuse(reason: String, retryAfter: TimeInterval)
  }

  static let unavailableMessage =
    "Backup paused: Beebeeb could not open this iPhone's backup list. Retrying automatically."

  private(set) var failure: BackupManifestHandle.OpenFailure?
  private(set) var consecutiveFailures = 0

  /// The user-facing reason while the manifest is unavailable; nil otherwise.
  var stopReason: String? { failure == nil ? nil : Self.unavailableMessage }

  mutating func record(_ failure: BackupManifestHandle.OpenFailure?) -> Decision {
    guard let failure else {
      clear()
      return .proceed
    }
    self.failure = failure
    consecutiveFailures += 1
    return .refuse(
      reason: Self.unavailableMessage,
      retryAfter: ManifestRebuildGate.databaseFailureBackoff(consecutiveFailures: consecutiveFailures)
    )
  }

  mutating func clear() {
    failure = nil
    consecutiveFailures = 0
  }
}
