import Foundation
import ManifestSQLite

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
/// - Round 10: while the JS layer may hold the file (`peerMayHoldFile`,
///   set by `admitPeerOpen`), the handle never closes a connection that
///   opened the file and never checkpoints outside the purge hold; and JS is
///   admitted to open only when no sign-out reset is pending.
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
    /// `exsqlite3_open_v2` failed (no such directory, no permission, a path
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
    /// Round 10: a sign-out reset is still pending, but the JS layer may
    /// still hold the file open (its close was not confirmed). Applying the
    /// reset would checkpoint the WAL under that connection, and a failure
    /// would close a native connection under it (expo-sqlite is a separate
    /// SQLite copy: neither sees the other's locks). Nothing is opened; it is
    /// retried once JS confirms its handle closed (the next purge hold, or the
    /// JS open gate, `admitPeerOpen`).
    case pendingResetDeferred = "pending_reset_deferred"
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
  /// Task 2033: the engine connection's busy timeout (ms). Matches
  /// `BackupManifestStore.keepBusyTimeoutMs` and JS's `MANIFEST_BUSY_TIMEOUT_MS`.
  static let busyTimeoutMs: Int32 = 2_000

  let path: String
  private(set) var db: OpaquePointer?
  /// True from a failed `resetForSignOut` until `finishAfterFailedReset`.
  private(set) var awaitingPurgeFinish = false
  /// How many times a handle was opened (diagnostics and tests).
  private(set) var openCount = 0
  /// Whether the last successful open applied a pending sign-out reset.
  private(set) var lastOpenAppliedPendingReset = false
  /// Round 7 sweep: a connection this handle closed may still be open (its
  /// `exsqlite3_close` did not return OK, see `BackupManifestStore
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
  /// LD-0002 (B4): where an expiry interrupts this handle's connection from
  /// any thread. Published after every open, withdrawn BEFORE every close (the
  /// two `self.db = nil` below), so an interrupt never reaches a freed handle.
  let interruptTarget: SQLiteInterruptTarget?

  /// Round 9: every account deleted permanently in this process. Sticky for
  /// the life of the process (a deleted account cannot sign in again), so the
  /// sign-out that follows the deletion, and any reset after it, cannot keep
  /// anything of it. In memory only: the user ids are not written anywhere.
  private(set) var deletedAccountIds: Set<String> = []
  /// Round 9: a deletion whose account is not known; every kept mark goes at
  /// the next reset (`MarkDiscard.all`). Cleared once a reset ran with it.
  private(set) var discardAllPending = false

  /// Round 10 (review finding 5, "openIfClosed closes the native connection
  /// while the JS expo-sqlite copy may still be open"): the JS layer's
  /// expo-sqlite connection may be open on the file. expo-sqlite bundles its
  /// own SQLite: a native close or WAL checkpoint cannot see that connection,
  /// so a native close deletes `-wal`/`-shm` under it and drops the process's
  /// POSIX locks it relies on. Set when JS is admitted to open
  /// (`admitPeerOpen`); cleared only when JS confirms every handle of it is
  /// closed (`admitPeerOpen(priorPeerHandlesClosed: true)`, or
  /// `finishAfterFailedReset(allowUnlink: true)` under the purge hold). False
  /// at process start: JS opens only through `admitPeerOpen`
  /// (`BackupDatabase.openAndMigrate`).
  private(set) var peerMayHoldFile = false
  /// Round 10: connections `openIfClosed` opened and could not use while JS
  /// may hold the file. They are NOT closed then (the rule above), never used
  /// for reads or writes while parked, and closed once JS confirms its
  /// handles closed. At most one: a retry reuses it instead of opening
  /// another, and adopts it as the handle when the retry succeeds.
  private var parkedConnections: [OpaquePointer] = []
  /// Round 10 (review finding 4) state, moved here in round 11 (review
  /// finding 7, "account bleed"): whether a camera-roll insert into this
  /// manifest failed since the last full scan inserted. It describes the
  /// manifest's CURRENT contents, so the sign-out reset that empties them
  /// clears it (`resetForSignOut`). Before, the engine kept it across
  /// sign-out: account A's failed insert deferred account B's first rebuild
  /// (`checkFailed`, 2..30 s escalating backoff) until B's own full scan
  /// inserted. dbQueue-only, like every member.
  var scanInsertHealth = ScanInsertHealth()
  /// Diagnostics and tests: connections closed / parked by this handle.
  private(set) var closedConnectionCount = 0
  var parkedConnectionCount: Int { parkedConnections.count }

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
    interruptTarget: SQLiteInterruptTarget? = nil,
    prepareSchema: @escaping (OpaquePointer) -> Void
  ) {
    self.path = path
    self.interruptTarget = interruptTarget
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

  /// LD-0002: the connection, or nil while the execution gate refuses SQLite
  /// (background time ended, or a completion write's assertion expired). The
  /// engine's `db` is this, so every engine statement starts here and none can
  /// start after a quiesce until the gate reopens.
  func connection(
    admittedBy gate: BackupExecutionGate,
    completionWrite: BackupExecutionGate.Assertion? = nil
  ) -> OpaquePointer? {
    gate.admitsStatement(completionWrite: completionWrite) ? db : nil
  }

  /// Round 9: what the next reset may not keep. The accounts deleted in this
  /// process, plus "everything" when a deletion's account is unknown, or when
  /// a deletion's reset was left pending by an earlier process (whose
  /// deleted ids this process never had).
  ///
  /// Round 11 (review finding 1, privacy): an earlier process's pending
  /// deletion forces "everything" even after THIS process recorded deletions
  /// of its own. Before, `all` also required `deletedAccountIds` to be empty:
  /// process 1 deleted A and could not reset, process 2 deleted B, and its
  /// reset discarded only B's marks and cleared the flag, keeping A's user id,
  /// PhotoKit ids and file ids for up to 30 days. A flag this process set
  /// itself (its own deletion's reset failed) names only accounts in
  /// `deletedAccountIds`, so it does not widen the discard.
  var activeDiscard: BackupManifestStore.MarkDiscard {
    let inheritedDeletion = discardPending.get() && !discardPendingSetByThisProcess
    let all = discardAllPending || inheritedDeletion
    return BackupManifestStore.MarkDiscard(accountIds: deletedAccountIds, all: all)
  }

  /// Round 11: `discardPending` was false when this process set it, so every
  /// deletion it stands for is in `deletedAccountIds`. False while the flag
  /// was inherited from an earlier process (or is not set).
  private var discardPendingSetByThisProcess = false

  /// Round 11: records "the pending reset is a deletion's" without losing an
  /// inherited flag's meaning (an earlier process's deletion stays "every
  /// account").
  private func recordDiscardPending() {
    if !discardPending.get() { discardPendingSetByThisProcess = true }
    discardPending.set(true)
  }

  /// Round 9: a reset that ran with `activeDiscard` succeeded.
  private func discardApplied() {
    discardPending.set(false)
    discardPendingSetByThisProcess = false
    discardAllPending = false
  }

  /// Opens the manifest when no handle is open. Returns nil when a handle is
  /// open on return, and the reason otherwise; a failure never leaves a
  /// handle open (round 10: a parked connection is not a handle, see below).
  ///
  /// Round 10 (review finding 5): while JS may hold the file
  /// (`peerMayHoldFile`), this never closes a connection that opened the file
  /// and never checkpoints. A pending reset is not applied
  /// (`.pendingResetDeferred`, nothing opened); it runs once JS confirms its
  /// handles closed, which happens only under the purge hold
  /// (`finishAfterFailedReset(allowUnlink: true)`) or in the JS open gate
  /// (`admitPeerOpen`). A connection that opened but cannot be used is parked
  /// instead of closed (`closeOrPark`), and the next attempt retries on it.
  @discardableResult
  func openIfClosed() -> OpenFailure? {
    if db != nil { return nil }
    if awaitingPurgeFinish { return .purgeInFlight }
    if peerMayHoldFile, pendingReset.get() { return .pendingResetDeferred }
    let opened: OpaquePointer
    if peerMayHoldFile, let parked = parkedConnections.popLast() {
      // Retry on the connection parked by an earlier attempt instead of
      // opening another. No JS close can have happened since it was parked:
      // JS confirms its closes first (`peerConfirmedClosed`), which closes
      // every parked connection.
      opened = parked
    } else {
      try? FileManager.default.createDirectory(
        at: URL(fileURLWithPath: path).deletingLastPathComponent(),
        withIntermediateDirectories: true
      )
      var handle: OpaquePointer?
      guard exsqlite3_open_v2(path, &handle, Self.openFlags, nil) == SQLITE_OK, let fresh = handle else {
        // A failed open holds no file descriptor on the manifest: closing it
        // cannot touch a JS connection's WAL or locks.
        if let handle { close(handle) }
        return .openFailed
      }
      opened = fresh
    }
    // Task 2033: JS's connection and this one are now the SAME SQLite copy
    // (expo-sqlite's, `import ManifestSQLite`), so their locks exclude each
    // other: a write that meets the other side's write transaction gets
    // SQLITE_BUSY instead of interleaving as the two copies did. Wait for it
    // instead of failing (JS sets the same in `BackupDatabase.migrate`).
    exsqlite3_busy_timeout(opened, Self.busyTimeoutMs)
    // WAL for concurrent access with the JS layer. Its result is not the
    // check: another connection can briefly hold the lock a mode change
    // needs. The schema read below is.
    exsqlite3_exec(opened, "PRAGMA journal_mode = WAL", nil, nil, nil)
    prepareSchema(opened)
    guard BackupManifestStore.tableExistsChecked(opened, "backup_assets") == true else {
      closeOrPark(opened, .unreadable)
      return .unreadable
    }
    var appliedPendingReset = false
    if pendingReset.get() {
      // Only reached with `peerMayHoldFile` false (checked above): no JS
      // connection is open, so the checkpoint and the close are safe.
      // Round 12 (review item 4): a sign-out in THIS process whose recovery
      // was deferred (JS's close unconfirmed) still knows the outgoing
      // account; its pre-column rows are adopted first, as the recovery
      // would have, so the reset keeps their associations.
      if let adoptAccountId = recoveryAccountId, BackupManifestStore.adoptUnowned(opened, accountId: adoptAccountId) == nil {
        close(opened)
        return .pendingResetFailed
      }
      guard BackupManifestStore.resetInPlace(opened, nowMs: now(), discard: activeDiscard) else {
        close(opened)
        return .pendingResetFailed
      }
      pendingReset.set(false)
      discardApplied()
      recoveryAccountId = nil
      appliedPendingReset = true
    }
    db = opened
    interruptTarget?.publish(opened)
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
  ///
  /// Round 13 (review of mobile#182 at a19037f9, item 3, duplicate upload): a
  /// deletion discards the marks of the accounts JS NAMES in
  /// `deletedAccountIds`, and never the outgoing account on top of them. Only
  /// when JS names none: the account the engine is still BOUND to
  /// (`outgoingInferred` false) is the deleted one, as before; an outgoing
  /// account the engine only REMEMBERS from an earlier sign-out
  /// (`outgoingInferred`, `UnboundAccountMemory`) is not known to be the
  /// deleted one, so the reset fails closed and discards every mark
  /// (round 9's rule for a deletion with no known account). Before, the
  /// remembered account A of an earlier sign-out was added to the deleted
  /// set when a later user B deleted their account: A's kept marks went, and
  /// A's photos uploaded again at A's next sign-in.
  func resetForSignOut(
    outgoingAccountId: String?,
    outgoingInferred: Bool = false,
    mode: ManifestPurgeMode = .signOut,
    deletedAccountIds: Set<String> = []
  ) -> Bool {
    writeFence.advanceForSignOut()
    // Round 11 (review finding 7): the outgoing account's scan-insert health
    // goes with its rows, whatever the reset's outcome (a failed reset keeps
    // the rows only until the recovery or the next open empties them, and
    // no scan can insert before the next bind).
    scanInsertHealth = ScanInsertHealth()
    if mode == .accountDeleted {
      var deleted = deletedAccountIds.filter { !$0.isEmpty }
      if deleted.isEmpty, !outgoingInferred, let outgoingAccountId, !outgoingAccountId.isEmpty {
        deleted.insert(outgoingAccountId)
      }
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
      interruptTarget?.withdraw()
      self.db = nil
      close(db)
    }
    pendingReset.set(true)
    if !discard.isEmpty { recordDiscardPending() }
    awaitingPurgeFinish = true
    return false
  }

  /// Every close of a manifest connection goes through here (round 7).
  private func close(_ connection: OpaquePointer) {
    closedConnectionCount += 1
    if !BackupManifestStore.closeConnection(connection) {
      closeUnconfirmed = true
    }
  }

  /// Round 10: `openIfClosed`'s failure close. While JS may hold the file
  /// the connection is parked (kept open, unused) instead of closed.
  private func closeOrPark(_ connection: OpaquePointer, _ failure: OpenFailure) {
    if peerMayHoldFile {
      parkedConnections.append(connection)
    } else {
      close(connection)
    }
  }

  /// Round 10: JS confirmed every expo-sqlite connection of it is closed (it
  /// holds none until it is admitted again). Parked connections are closed
  /// now: no JS connection can lose its WAL or locks to it.
  func peerConfirmedClosed() {
    peerMayHoldFile = false
    let parked = parkedConnections
    parkedConnections = []
    for connection in parked { close(connection) }
  }

  /// Round 10 (review finding 7, "after ok:0 from finishBackupManifestPurge,
  /// JS reopens lazily and serves the previous account's rows"): the JS
  /// layer's gate before EVERY expo-sqlite open of the manifest
  /// (`BackupDatabase.openAndMigrate`). JS is admitted only when no sign-out
  /// reset is pending on return: a pending reset is applied here first (on
  /// the native connection, with no JS connection open), so JS never reads
  /// the outgoing account's rows.
  ///
  /// `priorPeerHandlesClosed`: JS holds no connection on the file now (it
  /// calls this only when it has no current handle; false while a connection
  /// whose close failed is still tracked). Only then may a pending reset run.
  /// Refused while a failed sign-out is between its two halves.
  struct PeerOpenGate: Equatable {
    let admitted: Bool
    /// Why not (or, when admitted, why the native handle is still closed).
    let failure: OpenFailure?
  }

  func admitPeerOpen(priorPeerHandlesClosed: Bool) -> PeerOpenGate {
    if awaitingPurgeFinish { return PeerOpenGate(admitted: false, failure: .purgeInFlight) }
    if priorPeerHandlesClosed {
      peerConfirmedClosed()
    } else {
      // A JS connection whose close failed may still be open.
      peerMayHoldFile = true
    }
    let failure = openIfClosed()
    if pendingReset.get() {
      return PeerOpenGate(admitted: false, failure: failure ?? .pendingResetFailed)
    }
    peerMayHoldFile = true
    return PeerOpenGate(admitted: true, failure: failure)
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
  ///
  /// Round 12 (review item 4): `allowUnlink` false means JS's `closeAsync()`
  /// failed, so its expo-sqlite connection may still be open. Then NOTHING is
  /// opened, reset (checkpointed) or closed here: before, the recovery opened
  /// a system-SQLite connection, reset in place (TRUNCATE checkpoint) and
  /// closed it, which in the app removes `-wal`/`-shm` and drops the
  /// process's POSIX locks under the live JS connection, and on success
  /// reopened the native handle next to it. Now the reset stays pending,
  /// `peerMayHoldFile` is set (the round 10 rule), and the reset runs once JS
  /// confirms its handles closed: JS retries the close on its next call and
  /// asks the open gate (`admitPeerOpen(priorPeerHandlesClosed: true)`), or
  /// the next process applies it at open. Until then `openIfClosed` answers
  /// `.pendingResetDeferred` and `start()` shows the manifest reason.
  func finishAfterFailedReset(allowUnlink: Bool) -> FinishResult {
    guard allowUnlink else {
      // Only the native handle could be open here, and the failed reset
      // already closed it (`resetForSignOut`); nothing else of ours is open.
      peerMayHoldFile = true
      awaitingPurgeFinish = false
      return FinishResult(ok: false, unlinked: false, reopened: false, reopenFailure: .pendingResetDeferred)
    }
    if let db {
      interruptTarget?.withdraw()
      self.db = nil
      close(db)
    }
    // Round 10: `allowUnlink` is JS's confirmed close, under the purge hold.
    peerConfirmedClosed()
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

/// Task 1667 round 13 (review of mobile#182 at a19037f9, item 3, duplicate
/// upload): the account a sign-out reset keeps the not-yet-marked uploads
/// for, when the engine is no longer bound to it. `clearToken()` unbinds the
/// engine before the sign-out purge runs (round 2), so the engine remembers
/// the account it last unbound. Before round 13 nothing but an account
/// deletion forgot it: a later account B that signed in (and never turned on
/// backup, so never bound the engine) and deleted their account made the
/// deletion's reset treat A as the outgoing account and discard A's kept
/// marks. Now the memory ends when ANY account binds, and when JS reports a
/// DIFFERENT signed-in user (`confirmMasterKeyHandle`).
///
/// Guarded by the engine's `accountIdLock`.
struct UnboundAccountMemory: Equatable {
  private(set) var lastUnbound: String?

  /// Who the reset's outgoing account is, and whether it is still bound or
  /// only remembered.
  struct Outgoing: Equatable {
    let accountId: String?
    /// True when the engine is not bound to it (remembered from a sign-out).
    let inferred: Bool
  }

  /// `currentAccountId` changed from `previous` to `next` (a real change).
  mutating func accountChanged(from previous: String?, to next: String?) {
    if let next, !next.isEmpty {
      lastUnbound = nil
    } else if let previous, !previous.isEmpty {
      lastUnbound = previous
    }
  }

  /// JS confirmed a signed-in user. Another account than the remembered one
  /// ends the memory: the remembered account is no longer the one a later
  /// sign-out or deletion on this device is about.
  mutating func signedIn(_ accountId: String) {
    guard !accountId.isEmpty, let lastUnbound, lastUnbound != accountId else { return }
    self.lastUnbound = nil
  }

  mutating func forget() {
    lastUnbound = nil
  }

  func outgoing(currentAccountId: String?) -> Outgoing {
    if let currentAccountId, !currentAccountId.isEmpty {
      return Outgoing(accountId: currentAccountId, inferred: false)
    }
    if let lastUnbound, !lastUnbound.isEmpty {
      return Outgoing(accountId: lastUnbound, inferred: true)
    }
    return Outgoing(accountId: nil, inferred: false)
  }
}
