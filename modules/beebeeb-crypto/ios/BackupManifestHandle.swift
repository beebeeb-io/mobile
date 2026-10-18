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
/// Task 1667 round 9 (Codex P1 "Delete retained marks during permanent
/// account deletion", mobile#182 at dacc089d): what a storage purge is for.
/// JS passes it from every purge entry point (`account-cleanup.ts`
/// `purgeAllPlaintextCaches`) through the native `purgePlaintextStorage`
/// into `resetForSignOut`.
/// - `signOut`: the account still exists and may sign in again on this
///   device. Its unmarked uploads are kept as pending marks (30 days), so
///   that sign-in does not upload them a second time.
/// - `accountDeleted`: the account was deleted permanently. Nothing of it is
///   kept: its pending marks are deleted, none of its uploads is kept, and
///   every later reset in this process (the sign-out that follows the
///   deletion, its recovery, a pending reset) does the same.
enum ManifestPurgeMode: String, Equatable {
  case signOut = "sign-out"
  case accountDeleted = "account-deleted"

  /// The JS value. nil (an older JS bundle that passes nothing) is a
  /// sign-out; any other unknown value fails closed as a deletion.
  static func parse(_ raw: String?) -> ManifestPurgeMode {
    guard let raw else { return .signOut }
    return ManifestPurgeMode(rawValue: raw) ?? .accountDeleted
  }
}

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
  /// Round 7 sweep: a connection this handle closed may still be open (its
  /// `sqlite3_close` did not return OK, see `BackupManifestStore
  /// .closeConnection`). Sticky for the life of the process: from then on
  /// the recovery never replaces the file, whatever JS reports, because an
  /// fd of this process may still point at it.
  private(set) var closeUnconfirmed = false
  /// Round 7 sweep: the account a failed sign-out reset was for, handed to
  /// the recovery so its pre-column rows are adopted (and their
  /// associations kept) there too.
  private var recoveryAccountId: String?
  /// Round 8 (Codex P1 "Fence late photo scans before resetting the
  /// manifest"): the write fence of every async producer. Advanced and
  /// sealed at the start of `resetForSignOut`, in the same block as the
  /// reset, so no ticket issued before it can write afterwards
  /// (`ManifestWriteFence`). The other two resets need no advance of their
  /// own: `finishAfterFailedReset` is the second half of that same sign-out
  /// (the fence is still sealed, no ticket can have been issued since), and
  /// a pending reset applied by `openIfClosed` belongs to a sign-out whose
  /// own `resetForSignOut` already advanced it (same process) or to a
  /// previous process (whose producers are gone).
  let writeFence: ManifestWriteFence

  /// Round 9: every account deleted permanently in this process. Sticky for
  /// the life of the process (a deleted account cannot sign in again), so the
  /// sign-out that follows the deletion, and any reset after it, cannot keep
  /// anything of it. In memory only: the user ids are not written anywhere.
  private(set) var deletedAccountIds: Set<String> = []
  /// Round 9: a deletion whose account is not known; every kept mark goes at
  /// the next reset (`MarkDiscard.all`). Cleared once a reset ran with it.
  private(set) var discardAllPending = false

  private let pendingReset: ResetPendingFlag
  /// Round 9: "the pending reset is a deletion's", kept across launches (a
  /// boolean, no account id). A new process does not know which account was
  /// deleted, so it applies that pending reset with `MarkDiscard.all`.
  private let discardPending: ResetPendingFlag
  private let prepareSchema: (OpaquePointer) -> Void
  private let now: () -> Int64

  init(
    path: String,
    pendingReset: ResetPendingFlag,
    discardPending: ResetPendingFlag? = nil,
    now: @escaping () -> Int64 = BackupManifestStore.currentMs,
    onFencedWrite: @escaping (String, UInt64?, UInt64) -> Void = { _, _, _ in },
    prepareSchema: @escaping (OpaquePointer) -> Void
  ) {
    self.path = path
    self.writeFence = ManifestWriteFence(onDrop: onFencedWrite)
    self.pendingReset = pendingReset
    if let discardPending {
      self.discardPending = discardPending
    } else {
      final class Box { var value = false }
      let box = Box()
      self.discardPending = ResetPendingFlag(get: { box.value }, set: { box.value = $0 })
    }
    self.now = now
    self.prepareSchema = prepareSchema
  }

  var isOpen: Bool { db != nil }

  /// Round 9: what the next reset may not keep. The accounts deleted in this
  /// process, plus "everything" when a deletion's account is unknown, or when
  /// a deletion's reset was left pending by an earlier process (whose
  /// deleted ids this process never had).
  var activeDiscard: BackupManifestStore.MarkDiscard {
    let all = discardAllPending || (discardPending.get() && deletedAccountIds.isEmpty)
    return BackupManifestStore.MarkDiscard(accountIds: deletedAccountIds, all: all)
  }

  /// Round 9: a reset that ran with `activeDiscard` succeeded.
  private func discardApplied() {
    discardPending.set(false)
    discardAllPending = false
  }

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
      if let handle { close(handle) }
      return .openFailed
    }
    // WAL for concurrent access with the JS layer. Its result is not the
    // check: another connection can briefly hold the lock a mode change
    // needs. The schema read below is.
    sqlite3_exec(opened, "PRAGMA journal_mode = WAL", nil, nil, nil)
    prepareSchema(opened)
    guard BackupManifestStore.tableExistsChecked(opened, "backup_assets") == true else {
      close(opened)
      return .unreadable
    }
    var appliedPendingReset = false
    if pendingReset.get() {
      guard BackupManifestStore.resetInPlace(opened, nowMs: now(), discard: activeDiscard) else {
        close(opened)
        return .pendingResetFailed
      }
      pendingReset.set(false)
      discardApplied()
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
  ///
  /// Round 7 sweep: the adoption is checked. When it cannot run, the reset
  /// does not run either (it would delete those rows without keeping their
  /// associations): the sign-out takes the failed-reset path, and the
  /// recovery adopts them for the same account first.
  ///
  /// Round 8: the fence is advanced and sealed FIRST, before anything is
  /// read or deleted, in the caller's `dbQueue` block. A producer that took
  /// its ticket before this line can no longer write (its scan, rebuild step
  /// or upload finishing later is dropped), and no ticket is issued until
  /// the next sign-in binds the fence. This holds whether the reset below
  /// succeeds or not.
  ///
  /// Round 9 (Codex P1 "Delete retained marks during permanent account
  /// deletion"): `mode` `.accountDeleted` adds the outgoing account and
  /// `deletedAccountIds` (what JS knows) to `deletedAccountIds` BEFORE the
  /// reset; with neither known, every kept mark goes. The reset then deletes
  /// their kept marks and keeps none of their uploads, and so does every
  /// later reset in this process, whatever its mode. A deleted account's
  /// pre-column rows are not adopted (nothing of it is kept). When the reset
  /// fails, `discardPending` is recorded with the pending reset, so the
  /// recovery, or an open in a later process, does the same.
  func resetForSignOut(
    outgoingAccountId: String?,
    mode: ManifestPurgeMode = .signOut,
    deletedAccountIds: Set<String> = []
  ) -> Bool {
    writeFence.advanceForSignOut()
    if mode == .accountDeleted {
      var deleted = deletedAccountIds.filter { !$0.isEmpty }
      if let outgoingAccountId, !outgoingAccountId.isEmpty { deleted.insert(outgoingAccountId) }
      if deleted.isEmpty {
        discardAllPending = true
      } else {
        self.deletedAccountIds.formUnion(deleted)
      }
    }
    let discard = activeDiscard
    let adoptAccountId = outgoingAccountId.flatMap { discard.discards($0) ? nil : $0 }
    recoveryAccountId = adoptAccountId
    if let db {
      let adopted: Bool
      if let adoptAccountId {
        adopted = BackupManifestStore.adoptUnowned(db, accountId: adoptAccountId) != nil
      } else {
        adopted = true
      }
      if adopted, BackupManifestStore.resetInPlace(db, nowMs: now(), discard: discard) {
        pendingReset.set(false)
        discardApplied()
        recoveryAccountId = nil
        return true
      }
      close(db)
      self.db = nil
    }
    pendingReset.set(true)
    if !discard.isEmpty { discardPending.set(true) }
    awaitingPurgeFinish = true
    return false
  }

  /// Every close of a manifest connection goes through here (round 7).
  private func close(_ connection: OpaquePointer) {
    if !BackupManifestStore.closeConnection(connection) {
      closeUnconfirmed = true
    }
  }

  /// Second half of a sign-out whose reset failed; called once the JS
  /// handle is closed (`allowUnlink` = that close succeeded). With no
  /// connection open, the reset is retried on a connection of its own, or
  /// the file replaced (`BackupManifestStore.recoverAfterFailedReset`). On
  /// success the handle is reopened on the resulting file before this
  /// returns. On failure the reset stays pending and the next
  /// `openIfClosed` applies it (or refuses).
  ///
  /// Round 7 sweep: the file is never replaced while a connection this
  /// handle closed may still be open (`closeUnconfirmed`), even when JS
  /// confirmed its own close.
  func finishAfterFailedReset(allowUnlink: Bool) -> FinishResult {
    if let db {
      close(db)
      self.db = nil
    }
    let recovered = BackupManifestStore.recoverAfterFailedReset(
      path: path, nowMs: now(), allowUnlink: allowUnlink && !closeUnconfirmed, adoptAccountId: recoveryAccountId,
      discard: activeDiscard
    )
    awaitingPurgeFinish = false
    if recovered.ok { recoveryAccountId = nil }
    guard recovered.ok else {
      return FinishResult(ok: false, unlinked: recovered.unlinked, reopened: false, reopenFailure: nil)
    }
    pendingReset.set(false)
    discardApplied()
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
