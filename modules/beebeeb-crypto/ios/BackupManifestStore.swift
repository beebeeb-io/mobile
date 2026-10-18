import Foundation
import SQLite3

/// Task 1667 — account-scoped state of the camera-roll backup manifest
/// (`backup_assets` in `Documents/SQLite/beebeeb-backup.db`).
///
/// Every function takes the open handle as a parameter and does no queueing
/// of its own: `NativeBackupEngine` calls each one inside `dbQueue.sync`, the
/// same rule as every other `db` access there
/// (`native-backup-engine-db-queue.test.ts`). Kept free of PhotoKit/UIKit so
/// `scripts/swift-tests/backup-manifest-store-test.swift` compiles it with
/// `swiftc` against a real SQLite file.
///
/// What it fixes (sim evidence `_qa-evidence/1962/sim-dup/00-summary.txt`):
///   1. Sign-out unlinked the database while the engine and the JS layer
///      still held it open. Same process: every write went to the deleted
///      inode. Next cold launch: an empty manifest, so every photo was queued
///      and uploaded a second time. `resetInPlace` empties it through the open
///      handle instead, so the file stays the one every handle uses.
///   2. Rows carried no owner. `uploaded_account_id` records which account a
///      row's remote file belongs to; `claim` adopts pre-column rows and
///      re-queues another account's rows before the current account trusts
///      them as "already backed up".
///   3. An empty manifest had nothing to rebuild from. `server_marked_at`
///      tracks whether the server's per-device map
///      (`POST /api/v1/files/photo-backup/mark`) knows the row;
///      `applyServerMap` rebuilds from `GET /api/v1/files/photo-backup/identifiers`.
enum BackupManifestStore {
  /// Statuses whose `remote_file_id` points at a file the owning account has
  /// (or had) on the server.
  static let remoteBoundStatuses = "'uploaded', 'remote_deleted', 'orphaned', 'pending_delete'"

  /// Statuses a server-map match may promote to `uploaded`: not yet uploaded
  /// by this manifest, and not mid-upload (`staged_file_id IS NULL`).
  static let rebuildableStatuses = "'pending_upload', 'pending_reupload', 'failed'"

  static let columnMigrations = [
    "ALTER TABLE backup_assets ADD COLUMN uploaded_account_id TEXT",
    "ALTER TABLE backup_assets ADD COLUMN server_marked_at INTEGER",
  ]

  /// Idempotent: an ALTER on a column that exists fails harmlessly.
  static func migrate(_ db: OpaquePointer) {
    for migration in columnMigrations {
      sqlite3_exec(db, migration, nil, nil, nil)
    }
  }

  // MARK: - Sign-out reset

  /// Empties the manifest THROUGH this handle; the file is never unlinked, so
  /// every other open handle (the JS layer's expo-sqlite connection) keeps
  /// pointing at the same, now-empty, file. `secure_delete` overwrites the
  /// freed pages and the TRUNCATE checkpoint empties the WAL, so the rows do
  /// not survive in either. Returns false when the DELETEs did not commit;
  /// the caller must then not keep the file.
  @discardableResult
  static func resetInPlace(_ db: OpaquePointer) -> Bool {
    sqlite3_busy_timeout(db, 2_000)
    sqlite3_exec(db, "PRAGMA secure_delete = ON", nil, nil, nil)
    guard sqlite3_exec(db, "BEGIN IMMEDIATE", nil, nil, nil) == SQLITE_OK else { return false }
    var ok = sqlite3_exec(db, "DELETE FROM backup_assets", nil, nil, nil) == SQLITE_OK
    if ok { ok = sqlite3_exec(db, "DELETE FROM backup_upload_chunks", nil, nil, nil) == SQLITE_OK }
    // Created by the JS layer (BackupDatabase.ts); absent until it opened once.
    if ok, tableExists(db, "backup_verification") {
      ok = sqlite3_exec(db, "DELETE FROM backup_verification", nil, nil, nil) == SQLITE_OK
    }
    if ok {
      ok = sqlite3_exec(db, "COMMIT", nil, nil, nil) == SQLITE_OK
    }
    if !ok {
      sqlite3_exec(db, "ROLLBACK", nil, nil, nil)
      return false
    }
    sqlite3_exec(db, "PRAGMA wal_checkpoint(TRUNCATE)", nil, nil, nil)
    return true
  }

  // MARK: - Account ownership

  /// Makes the manifest safe for `accountId` before anything reads
  /// "already uploaded" from it:
  ///   - rows from before `uploaded_account_id` existed (NULL) are adopted by
  ///     this account. Before task 1667 every sign-out unlinked the database,
  ///     so a pre-column file only ever holds rows of the account signed in
  ///     since the last sign-out, the one binding now.
  ///   - rows owned by ANOTHER account are re-queued: this account has never
  ///     uploaded those photos, whatever the manifest says.
  /// Rows mid-upload (`staged_file_id` set) are left to
  /// `purgeMismatchedStagedAssets`, which owns staged state.
  @discardableResult
  static func claim(_ db: OpaquePointer, accountId: String, nowMs: Int64) -> (adopted: Int, requeued: Int) {
    guard !accountId.isEmpty else { return (0, 0) }
    let adoptSQL = """
    UPDATE backup_assets
       SET uploaded_account_id = ?
     WHERE uploaded_account_id IS NULL
       AND staged_file_id IS NULL
       AND remote_file_id IS NOT NULL
       AND status IN (\(remoteBoundStatuses))
    """
    let adopted = run(db, adoptSQL) { stmt in bindText(stmt, 1, accountId) }

    let requeueSQL = """
    UPDATE backup_assets
       SET status = 'pending_upload',
           remote_file_id = NULL,
           remote_path = NULL,
           uploaded_at = NULL,
           uploaded_account_id = NULL,
           server_marked_at = NULL,
           error_message = NULL,
           retry_count = 0,
           queued_at = ?
     WHERE uploaded_account_id IS NOT NULL
       AND uploaded_account_id != ?
       AND staged_file_id IS NULL
    """
    let requeued = run(db, requeueSQL) { stmt in
      sqlite3_bind_int64(stmt, 1, nowMs)
      bindText(stmt, 2, accountId)
    }
    return (max(adopted, 0), max(requeued, 0))
  }

  /// Rows this account has uploaded according to the manifest.
  static func uploadedCount(_ db: OpaquePointer, accountId: String) -> Int {
    let sql = "SELECT COUNT(*) FROM backup_assets WHERE status = 'uploaded' AND uploaded_account_id = ?"
    var stmt: OpaquePointer?
    guard sqlite3_prepare_v2(db, sql, -1, &stmt, nil) == SQLITE_OK else { return 0 }
    defer { sqlite3_finalize(stmt) }
    bindText(stmt, 1, accountId)
    guard sqlite3_step(stmt) == SQLITE_ROW else { return 0 }
    return Int(sqlite3_column_int64(stmt, 0))
  }

  /// A manifest holding nothing this account uploaded must be rebuilt from
  /// the server before its first upload: otherwise every photo the account
  /// already backed up from this device (sign-out then sign-in, reinstall)
  /// is uploaded again.
  static func needsServerRebuild(_ db: OpaquePointer, accountId: String) -> Bool {
    uploadedCount(db, accountId: accountId) == 0
  }

  // MARK: - Upload completion

  /// Completed upload: the row now points at `remoteFileId`, owned by
  /// `accountId`, not yet recorded in the server's map.
  static func markUploaded(
    _ db: OpaquePointer,
    assetId: String,
    remoteFileId: String,
    accountId: String,
    uploadedAtIso: String
  ) {
    let sql = """
    UPDATE backup_assets
    SET status = 'uploaded',
        remote_file_id = ?,
        uploaded_at = ?,
        uploaded_account_id = ?,
        server_marked_at = NULL,
        error_message = NULL,
        retry_count = 0,
        upload_session_id = NULL,
        staged_file_id = NULL,
        staged_name_encrypted = NULL,
        staged_mime_type = NULL,
        staged_is_media = 0,
        staged_original_size = 0,
        staged_chunk_count = 0,
        staged_dir = NULL,
        staged_at = NULL
    WHERE local_asset_id = ?
    """
    _ = run(db, sql) { stmt in
      bindText(stmt, 1, remoteFileId)
      bindText(stmt, 2, uploadedAtIso)
      bindText(stmt, 3, accountId)
      bindText(stmt, 4, assetId)
    }
  }

  // MARK: - Server map (photo_backup_state)

  /// Uploaded rows of `accountId` the server's map does not have yet.
  static func pendingServerMarks(_ db: OpaquePointer, accountId: String, limit: Int) -> [(assetId: String, fileId: String)] {
    let sql = """
    SELECT local_asset_id, remote_file_id
      FROM backup_assets
     WHERE status = 'uploaded'
       AND uploaded_account_id = ?
       AND remote_file_id IS NOT NULL
       AND server_marked_at IS NULL
     ORDER BY uploaded_at DESC
     LIMIT ?
    """
    var stmt: OpaquePointer?
    guard sqlite3_prepare_v2(db, sql, -1, &stmt, nil) == SQLITE_OK else { return [] }
    defer { sqlite3_finalize(stmt) }
    bindText(stmt, 1, accountId)
    sqlite3_bind_int(stmt, 2, Int32(max(0, limit)))
    var rows: [(assetId: String, fileId: String)] = []
    while sqlite3_step(stmt) == SQLITE_ROW {
      guard let a = sqlite3_column_text(stmt, 0), let f = sqlite3_column_text(stmt, 1) else { continue }
      rows.append((String(cString: a), String(cString: f)))
    }
    return rows
  }

  /// Records a successful mark. Matches on the file id too, so a row
  /// re-uploaded (new file id) in the meantime stays unmarked.
  static func recordServerMarked(_ db: OpaquePointer, assetId: String, fileId: String, nowMs: Int64) {
    let sql = """
    UPDATE backup_assets SET server_marked_at = ?
     WHERE local_asset_id = ? AND remote_file_id = ? AND status = 'uploaded'
    """
    _ = run(db, sql) { stmt in
      sqlite3_bind_int64(stmt, 1, nowMs)
      bindText(stmt, 2, assetId)
      bindText(stmt, 3, fileId)
    }
  }

  /// Parses `GET /api/v1/files/photo-backup/identifiers`
  /// (`{"identifiers": {"<file_id>": "<local_identifier>"}}`) into
  /// local identifier -> file id. nil when the body is not that shape.
  static func parseIdentifierMap(_ data: Data) -> [String: String]? {
    guard let object = try? JSONSerialization.jsonObject(with: data) as? [String: Any],
          let identifiers = object["identifiers"] as? [String: Any] else { return nil }
    var byLocal: [String: String] = [:]
    // Deterministic when two files claim one photo: the smallest file id wins.
    for fileId in identifiers.keys.sorted() {
      guard let local = identifiers[fileId] as? String, !local.isEmpty else { continue }
      if byLocal[local] == nil { byLocal[local] = fileId }
    }
    return byLocal
  }

  /// Rebuild: every photo the server already maps to a file of this account
  /// from this device becomes `uploaded` (and already marked). Only rows
  /// that are not uploaded and not mid-upload change; nothing is deleted.
  /// Returns the number of rows promoted.
  @discardableResult
  static func applyServerMap(
    _ db: OpaquePointer,
    accountId: String,
    localToFileId: [String: String],
    uploadedAtIso: String,
    nowMs: Int64
  ) -> Int {
    guard !accountId.isEmpty, !localToFileId.isEmpty else { return 0 }
    let sql = """
    UPDATE backup_assets
       SET status = 'uploaded',
           remote_file_id = ?,
           uploaded_at = COALESCE(uploaded_at, ?),
           uploaded_account_id = ?,
           server_marked_at = ?,
           error_message = NULL,
           retry_count = 0
     WHERE local_asset_id = ?
       AND staged_file_id IS NULL
       AND status IN (\(rebuildableStatuses))
    """
    var stmt: OpaquePointer?
    guard sqlite3_prepare_v2(db, sql, -1, &stmt, nil) == SQLITE_OK else { return 0 }
    defer { sqlite3_finalize(stmt) }
    guard sqlite3_exec(db, "BEGIN", nil, nil, nil) == SQLITE_OK else { return 0 }
    var promoted = 0
    for (local, fileId) in localToFileId {
      bindText(stmt, 1, fileId)
      bindText(stmt, 2, uploadedAtIso)
      bindText(stmt, 3, accountId)
      sqlite3_bind_int64(stmt, 4, nowMs)
      bindText(stmt, 5, local)
      if sqlite3_step(stmt) == SQLITE_DONE {
        promoted += Int(sqlite3_changes(db))
      }
      sqlite3_reset(stmt)
      sqlite3_clear_bindings(stmt)
    }
    guard sqlite3_exec(db, "COMMIT", nil, nil, nil) == SQLITE_OK else {
      sqlite3_exec(db, "ROLLBACK", nil, nil, nil)
      return 0
    }
    return promoted
  }

  // MARK: - Helpers

  private static let transient = unsafeBitCast(-1, to: sqlite3_destructor_type.self)

  static func bindText(_ stmt: OpaquePointer?, _ index: Int32, _ value: String) {
    sqlite3_bind_text(stmt, index, (value as NSString).utf8String, -1, transient)
  }

  /// Prepares, binds, steps once. Returns rows changed, or -1 on error.
  private static func run(_ db: OpaquePointer, _ sql: String, bind: (OpaquePointer?) -> Void) -> Int {
    var stmt: OpaquePointer?
    guard sqlite3_prepare_v2(db, sql, -1, &stmt, nil) == SQLITE_OK else { return -1 }
    defer { sqlite3_finalize(stmt) }
    bind(stmt)
    guard sqlite3_step(stmt) == SQLITE_DONE else { return -1 }
    return Int(sqlite3_changes(db))
  }

  static func tableExists(_ db: OpaquePointer, _ name: String) -> Bool {
    let sql = "SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = ?"
    var stmt: OpaquePointer?
    guard sqlite3_prepare_v2(db, sql, -1, &stmt, nil) == SQLITE_OK else { return false }
    defer { sqlite3_finalize(stmt) }
    bindText(stmt, 1, name)
    return sqlite3_step(stmt) == SQLITE_ROW
  }
}
