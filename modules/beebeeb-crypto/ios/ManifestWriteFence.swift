import Foundation
import SQLite3

/// Task 1667 round 8 (Codex P1 "Fence late photo scans before resetting the
/// manifest", mobile#182 at 556ef334).
///
/// The sign-out reset empties the camera-roll manifest in one `dbQueue`
/// critical section. Async work that started before it did not know: a scan
/// spawned by `registerPhotoObserver` / `photoLibraryDidChange` whose
/// PhotoKit fetch finished after the reset enqueued its insert afterwards and
/// put the outgoing account's camera-roll rows back into the emptied file.
/// The same was true of the rebuild steps (the server map is fetched over the
/// network, then written), the upload pipeline's row updates, the server-mark
/// records and the chunk-upload callbacks.
///
/// The fence is a generation number owned by `BackupManifestHandle`:
/// - `advanceForSignOut()` runs FIRST in `resetForSignOut`, inside the same
///   `dbQueue` block as the reset. It bumps the generation and seals the
///   fence: no ticket is issued again until an explicit sign-in (`bind`).
/// - Every async producer takes a `Ticket` when it STARTS (before its
///   PhotoKit fetch, network call or batch), for the account it works for.
/// - Every write checks its ticket with `admits` inside the SAME critical
///   section as the write. A write that passes ran before the reset (and the
///   reset removes it); a write after the reset carries an old generation and
///   is dropped and traced.
///
/// So the guarantee does not depend on cancelling or waiting for producers:
/// once the reset's block returns, no producer from before it can write.
///
/// Not thread-safe by design: every member runs on the owner's serial queue
/// (`NativeBackupEngine.dbQueue`), like the rest of `BackupManifestHandle`.
final class ManifestWriteFence {
  struct Ticket: Equatable {
    let generation: UInt64
    let accountId: String
  }

  enum State: Equatable {
    /// A fresh process: nothing was reset in it yet. The first producer for
    /// an account binds it (the background task can run before any JS
    /// sign-in call reaches native).
    case unbound
    case bound(String)
    /// After a sign-out reset: no ticket until `bind` (a JS-confirmed
    /// sign-in, `NativeBackupEngine.bindAccount`).
    case sealed
  }

  private(set) var generation: UInt64 = 0
  private(set) var state: State = .unbound
  /// Writes dropped since launch (diagnostics and tests).
  private(set) var droppedWrites = 0
  private(set) var droppedWriters: [String] = []

  /// Called for every dropped write: (writer, ticket generation, current generation).
  private let onDrop: (String, UInt64?, UInt64) -> Void

  init(onDrop: @escaping (String, UInt64?, UInt64) -> Void = { _, _, _ in }) {
    self.onDrop = onDrop
  }

  /// The sign-out reset. Every ticket issued so far is dead, and none is
  /// issued until the next `bind`.
  func advanceForSignOut() {
    generation &+= 1
    state = .sealed
  }

  /// An explicit sign-in for `accountId`. A different account (or the first
  /// bind after a reset) is a new generation; a re-bind of the same account
  /// changes nothing.
  func bind(accountId: String) {
    guard !accountId.isEmpty else { return }
    if case .bound(let current) = state, current == accountId { return }
    generation &+= 1
    state = .bound(accountId)
  }

  /// The ticket a producer takes when it starts work for `accountId`. nil
  /// when the producer may not write at all: no account, the fence is sealed
  /// by a sign-out, or it is bound to another account.
  func issue(for accountId: String?) -> Ticket? {
    guard let accountId, !accountId.isEmpty else { return nil }
    switch state {
    case .sealed:
      return nil
    case .unbound:
      state = .bound(accountId)
    case .bound(let current):
      guard current == accountId else { return nil }
    }
    return Ticket(generation: generation, accountId: accountId)
  }

  /// Round 11 (review finding 5): `admits` without counting or reporting a
  /// drop, for state that is not a manifest write (the scan's PhotoKit fetch
  /// result). Same queue rule.
  func isCurrent(_ ticket: Ticket?) -> Bool {
    guard let ticket, ticket.generation == generation, case .bound(let current) = state else { return false }
    return current == ticket.accountId
  }

  /// True when a write under `ticket` may run now. MUST be called in the
  /// same critical section as the write it guards. A refused write is
  /// counted and reported to `onDrop`.
  func admits(_ ticket: Ticket?, writer: String) -> Bool {
    if let ticket, ticket.generation == generation, case .bound(let current) = state, current == ticket.accountId {
      return true
    }
    droppedWrites += 1
    droppedWriters.append(writer)
    onDrop(writer, ticket?.generation, generation)
    return false
  }
}

/// Task 1667 round 8: the manifest writes of the engine's async producers
/// that do not need the engine itself, each behind the fence. Every function
/// here MUST run on the manifest's serial queue (`dbQueue`), inside the same
/// block that read `db`: the fence check and the write are one critical
/// section. `NativeBackupEngine` calls them, and
/// `scripts/swift-tests/manifest-write-fence-test.swift` drives the same
/// functions against a real SQLite file with a reset between a producer's
/// start and its write.
enum FencedManifestWrites {
  enum ScanWrite: Equatable {
    /// The ticket is from before a reset (or another account): nothing written.
    case fenced
    /// No handle is open: nothing written.
    case noHandle
    /// Written; `inserted` is the insert's own result.
    case written(inserted: Bool)
  }

  /// What a scan learned about album selection.
  struct Selection: Equatable {
    let allowedAssetIds: Set<String>
    let hasAlbumSelection: Bool
  }

  /// The scan's write (and the photo-library observer's, without a
  /// selection): insert the assets the producer fetched from PhotoKit, then
  /// apply the album selection.
  static func scanInsert(
    _ db: OpaquePointer?,
    fence: ManifestWriteFence,
    ticket: ManifestWriteFence.Ticket?,
    writer: String,
    assets: [BackupManifestStore.ScannedAsset],
    selection: Selection?,
    nowMs: Int64
  ) -> ScanWrite {
    guard fence.admits(ticket, writer: writer) else { return .fenced }
    guard let db else { return .noHandle }
    let inserted = BackupManifestStore.insertScannedAssets(db, assets, nowMs: nowMs)
    if let selection {
      _ = BackupManifestStore.updateSelectionScope(
        db, allowedAssetIds: selection.allowedAssetIds, hasAlbumSelection: selection.hasAlbumSelection
      )
    }
    return .written(inserted: inserted)
  }

  /// Rebuild step 1: claim the manifest for the account (a write), then "does
  /// it hold nothing this account uploaded?". nil = fenced or failed.
  static func needsRebuild(
    _ db: OpaquePointer?,
    fence: ManifestWriteFence,
    ticket: ManifestWriteFence.Ticket?,
    accountId: String,
    scanInsertFailed: Bool,
    nowMs: Int64
  ) -> Bool? {
    guard fence.admits(ticket, writer: "rebuild.claim") else { return nil }
    guard let db else { return nil }
    guard BackupManifestStore.claim(db, accountId: accountId, nowMs: nowMs) != nil else { return nil }
    guard let needs = BackupManifestStore.needsServerRebuild(db, accountId: accountId) else { return nil }
    // Round 7 sweep: never rebuild onto a manifest the last scan could not fill.
    if needs && scanInsertFailed { return nil }
    return needs
  }

  /// Rebuild step 2: the server's per-device map, fetched over the network
  /// after the producer started. nil = fenced or failed.
  static func applyServerMap(
    _ db: OpaquePointer?,
    fence: ManifestWriteFence,
    ticket: ManifestWriteFence.Ticket?,
    accountId: String,
    map: [String: String],
    uploadedAtIso: String,
    nowMs: Int64
  ) -> Int? {
    guard fence.admits(ticket, writer: "rebuild.apply_map") else { return nil }
    guard let db else { return nil }
    return BackupManifestStore.applyServerMap(
      db, accountId: accountId, localToFileId: map, uploadedAtIso: uploadedAtIso, nowMs: nowMs
    )
  }

  /// Round 10: the batch's server check (`PendingUploadServerCheck`). The
  /// hits `/photo-backup/check` reported in `backed_up` (round 11: out of the
  /// Trash server-side, with their file ids), fetched over the network after
  /// the batch or the bulk pass started, become `uploaded`. nil = fenced or
  /// failed.
  static func promoteCheckedHits(
    _ db: OpaquePointer?,
    fence: ManifestWriteFence,
    ticket: ManifestWriteFence.Ticket?,
    accountId: String,
    hits: [String: String],
    uploadedAtIso: String,
    nowMs: Int64
  ) -> Set<String>? {
    guard fence.admits(ticket, writer: "batch.promote_checked") else { return nil }
    guard let db else { return nil }
    return BackupManifestStore.promoteServerBackedUp(
      db, accountId: accountId, localToFileId: hits, uploadedAtIso: uploadedAtIso, nowMs: nowMs
    )
  }

  /// Rebuild step 3 (and every batch): promote the account's kept sign-out
  /// marks. nil = fenced or failed.
  static func applyKept(
    _ db: OpaquePointer?,
    fence: ManifestWriteFence,
    ticket: ManifestWriteFence.Ticket?,
    accountId: String,
    nowMs: Int64
  ) -> Int? {
    guard fence.admits(ticket, writer: "rebuild.apply_kept") else { return nil }
    guard let db else { return nil }
    return BackupManifestStore.applyPendingMarks(db, accountId: accountId, nowMs: nowMs)
  }

  /// A successful `POST /photo-backup/mark`: record `server_marked_at`.
  /// False = fenced or no handle.
  static func recordServerMarked(
    _ db: OpaquePointer?,
    fence: ManifestWriteFence,
    ticket: ManifestWriteFence.Ticket?,
    assetId: String,
    fileId: String,
    nowMs: Int64
  ) -> Bool {
    guard fence.admits(ticket, writer: "server_mark.record") else { return false }
    guard let db else { return false }
    BackupManifestStore.recordServerMarked(db, assetId: assetId, fileId: fileId, nowMs: nowMs)
    return true
  }

  /// The sign-out mark flush's row load: adopt pre-column rows, then read
  /// the unmarked uploads. nil = fenced, no handle or a failed read.
  static func loadSignOutMarks(
    _ db: OpaquePointer?,
    fence: ManifestWriteFence,
    ticket: ManifestWriteFence.Ticket?,
    accountId: String
  ) -> (rows: [(assetId: String, fileId: String)]?, adoptFailed: Bool) {
    guard fence.admits(ticket, writer: "server_mark.sign_out_load") else { return (nil, false) }
    guard let db else { return (nil, false) }
    let adoptFailed = BackupManifestStore.adoptUnowned(db, accountId: accountId) == nil
    return (BackupManifestStore.pendingServerMarks(db, accountId: accountId, limit: Int(Int32.max)), adoptFailed)
  }
}
