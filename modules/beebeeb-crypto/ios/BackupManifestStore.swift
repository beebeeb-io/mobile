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

  /// Task 1667 round 2 (Codex P1 "Preserve uploads that have not reached the
  /// server map"): uploads of an account that the server's per-device map
  /// (`photo_backup_state`) does not know yet, kept across the sign-out reset
  /// so that account's next sign-in on this device skips them instead of
  /// uploading them again. One row = (account user id, PhotoKit local
  /// identifier, server file id, when it was kept). No file name, no content,
  /// no key, no hash: the same identifiers `POST /photo-backup/mark` sends the
  /// server for that account. Read and consumed only for the account it names
  /// (`applyPendingMarks`); expires after `pendingMarksRetentionMs`. Lives in
  /// the manifest file itself, so it has that file's protection class and
  /// backup exclusion and needs no new registered path.
  static let pendingMarksTableSQL = """
  CREATE TABLE IF NOT EXISTS backup_pending_marks (
    account_id TEXT NOT NULL,
    local_asset_id TEXT NOT NULL,
    remote_file_id TEXT NOT NULL,
    created_at_ms INTEGER NOT NULL,
    PRIMARY KEY (account_id, local_asset_id)
  )
  """

  /// 30 days. An account that does not sign in again on this device within
  /// that window uploads those photos once more; nothing older is kept.
  static let pendingMarksRetentionMs: Int64 = 30 * 24 * 60 * 60 * 1000

  /// Idempotent: an ALTER on a column that exists fails harmlessly.
  static func migrate(_ db: OpaquePointer) {
    for migration in columnMigrations {
      sqlite3_exec(db, migration, nil, nil, nil)
    }
    sqlite3_exec(db, pendingMarksTableSQL, nil, nil, nil)
  }

  static func currentMs() -> Int64 {
    Int64(Date().timeIntervalSince1970 * 1000)
  }

  // MARK: - Sign-out reset

  /// Empties the manifest THROUGH this handle; the file is never unlinked, so
  /// every other open handle (the JS layer's expo-sqlite connection) keeps
  /// pointing at the same, now-empty, file. In the same transaction, every
  /// upload the server's map does not have yet moves to
  /// `backup_pending_marks` under its own account (round 2, Codex P1).
  /// `secure_delete` overwrites the freed pages and a TRUNCATE checkpoint
  /// empties the WAL, so the rows survive in neither.
  ///
  /// Returns false when the DELETEs did not commit OR the WAL could not be
  /// truncated (round 2, Codex P1 "Treat a busy WAL checkpoint as a failed
  /// reset": a reader holding an old snapshot keeps the outgoing account's
  /// rows in WAL frames, and the checkpoint reports busy without failing the
  /// statement). The caller must then not keep the file as it is.
  @discardableResult
  static func resetInPlace(
    _ db: OpaquePointer,
    nowMs: Int64 = currentMs(),
    checkpointAttempts: Int = 3,
    busyTimeoutMs: Int32 = 2_000,
    retryDelayUs: UInt32 = 100_000
  ) -> Bool {
    sqlite3_busy_timeout(db, busyTimeoutMs)
    sqlite3_exec(db, "PRAGMA secure_delete = ON", nil, nil, nil)
    guard tableExists(db, "backup_assets") else { return false }
    sqlite3_exec(db, pendingMarksTableSQL, nil, nil, nil)
    guard sqlite3_exec(db, "BEGIN IMMEDIATE", nil, nil, nil) == SQLITE_OK else { return false }
    let keepSQL = """
    INSERT OR REPLACE INTO backup_pending_marks (account_id, local_asset_id, remote_file_id, created_at_ms)
    SELECT uploaded_account_id, local_asset_id, remote_file_id, ?
      FROM backup_assets
     WHERE status = 'uploaded'
       AND uploaded_account_id IS NOT NULL
       AND uploaded_account_id != ''
       AND remote_file_id IS NOT NULL
       AND server_marked_at IS NULL
    """
    var ok = run(db, keepSQL) { stmt in sqlite3_bind_int64(stmt, 1, nowMs) } >= 0
    if ok {
      ok = run(db, "DELETE FROM backup_pending_marks WHERE created_at_ms < ?") { stmt in
        sqlite3_bind_int64(stmt, 1, nowMs - pendingMarksRetentionMs)
      } >= 0
    }
    if ok { ok = sqlite3_exec(db, "DELETE FROM backup_assets", nil, nil, nil) == SQLITE_OK }
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
    return truncateWal(db, attempts: checkpointAttempts, retryDelayUs: retryDelayUs).ok
  }

  /// Result of the last `truncateWal` attempt: the checkpoint's return code,
  /// its frame counts (`-1` when the database is not in WAL mode) and the
  /// `-wal` file's size on disk afterwards (0 when it does not exist).
  struct CheckpointResult {
    let ok: Bool
    let attempts: Int
    let rc: Int32
    let logFrames: Int32
    let checkpointedFrames: Int32
    let walBytes: Int64
  }

  /// `wal_checkpoint(TRUNCATE)` until it returns SQLITE_OK (which for
  /// TRUNCATE means the log was reset to zero bytes); retried `attempts`
  /// times. A busy checkpoint (another connection still reading an old
  /// snapshot) is a failure, never "probably fine". The `-wal` size is
  /// recorded for diagnostics only.
  static func truncateWal(_ db: OpaquePointer, attempts: Int, retryDelayUs: UInt32) -> CheckpointResult {
    var last = CheckpointResult(ok: false, attempts: 0, rc: SQLITE_ERROR, logFrames: -1, checkpointedFrames: -1, walBytes: -1)
    for attempt in 1...max(1, attempts) {
      var logFrames: Int32 = -1
      var checkpointed: Int32 = -1
      let rc = sqlite3_wal_checkpoint_v2(db, nil, SQLITE_CHECKPOINT_TRUNCATE, &logFrames, &checkpointed)
      let walBytes = walFileSize(db)
      let ok = rc == SQLITE_OK
      last = CheckpointResult(ok: ok, attempts: attempt, rc: rc, logFrames: logFrames, checkpointedFrames: checkpointed, walBytes: walBytes)
      if ok { return last }
      if attempt < attempts { usleep(retryDelayUs) }
    }
    return last
  }

  /// Size of this connection's `-wal` file; 0 when there is none.
  static func walFileSize(_ db: OpaquePointer) -> Int64 {
    guard let main = sqlite3_db_filename(db, "main") else { return 0 }
    let walPath = String(cString: main) + "-wal"
    guard let attrs = try? FileManager.default.attributesOfItem(atPath: walPath) else { return 0 }
    return (attrs[.size] as? NSNumber)?.int64Value ?? 0
  }

  /// Round 2 (Codex P1 "Reopen the JS database after a reset failure"):
  /// called after a failed `resetInPlace` once EVERY connection to `path`
  /// has been closed (the engine's and the JS layer's). Opens its own
  /// connection and resets again; with nothing else open that succeeds
  /// unless the file itself is broken. Only then, and only with
  /// `allowUnlink` (the JS handle is confirmed closed), the file is replaced:
  /// the kept pending marks are read first and written into the new file,
  /// so not even this path loses an upload's association.
  static func recoverAfterFailedReset(
    path: String,
    nowMs: Int64 = currentMs(),
    allowUnlink: Bool
  ) -> (ok: Bool, unlinked: Bool) {
    if let db = openConnection(path) {
      if tableExists(db, "backup_assets") { migrate(db) }
      let reset = resetInPlace(db, nowMs: nowMs)
      let carried = reset ? [] : pendingMarksSnapshot(db, nowMs: nowMs)
      sqlite3_close_v2(db)
      if reset { return (true, false) }
      guard allowUnlink else { return (false, false) }
      return replaceFile(path: path, carrying: carried)
    }
    guard allowUnlink else { return (false, false) }
    return replaceFile(path: path, carrying: [])
  }

  private static func replaceFile(path: String, carrying: [PendingMark]) -> (ok: Bool, unlinked: Bool) {
    for suffix in ["", "-wal", "-shm", "-journal"] {
      if unlink(path + suffix) != 0 && errno != ENOENT { return (false, false) }
    }
    guard let fresh = openConnection(path) else { return (false, true) }
    defer { sqlite3_close_v2(fresh) }
    sqlite3_exec(fresh, pendingMarksTableSQL, nil, nil, nil)
    return (insertPendingMarks(fresh, carrying), true)
  }

  private static func openConnection(_ path: String) -> OpaquePointer? {
    var db: OpaquePointer?
    let flags = SQLITE_OPEN_READWRITE | SQLITE_OPEN_CREATE | SQLITE_OPEN_FULLMUTEX
    guard sqlite3_open_v2(path, &db, flags, nil) == SQLITE_OK, let db else {
      if let db { sqlite3_close_v2(db) }
      return nil
    }
    sqlite3_exec(db, "PRAGMA journal_mode = WAL", nil, nil, nil)
    return db
  }

  // MARK: - Pending marks (kept across sign-out)

  struct PendingMark: Equatable {
    let accountId: String
    let assetId: String
    let fileId: String
    let createdAtMs: Int64
  }

  /// Every association a reset would keep: what is already in
  /// `backup_pending_marks` plus the unmarked uploads still in the manifest.
  static func pendingMarksSnapshot(_ db: OpaquePointer, nowMs: Int64) -> [PendingMark] {
    var out: [PendingMark] = []
    if tableExists(db, "backup_pending_marks") {
      out += select(db, """
      SELECT account_id, local_asset_id, remote_file_id, created_at_ms
        FROM backup_pending_marks WHERE created_at_ms >= ?
      """, bindMs: nowMs - pendingMarksRetentionMs)
    }
    if tableExists(db, "backup_assets") {
      out += select(db, """
      SELECT uploaded_account_id, local_asset_id, remote_file_id, ?
        FROM backup_assets
       WHERE status = 'uploaded' AND uploaded_account_id IS NOT NULL AND uploaded_account_id != ''
         AND remote_file_id IS NOT NULL AND server_marked_at IS NULL
      """, bindMs: nowMs)
    }
    return out
  }

  private static func select(_ db: OpaquePointer, _ sql: String, bindMs: Int64) -> [PendingMark] {
    var stmt: OpaquePointer?
    guard sqlite3_prepare_v2(db, sql, -1, &stmt, nil) == SQLITE_OK else { return [] }
    defer { sqlite3_finalize(stmt) }
    sqlite3_bind_int64(stmt, 1, bindMs)
    var rows: [PendingMark] = []
    while sqlite3_step(stmt) == SQLITE_ROW {
      guard let a = sqlite3_column_text(stmt, 0), let l = sqlite3_column_text(stmt, 1),
            let f = sqlite3_column_text(stmt, 2) else { continue }
      rows.append(PendingMark(
        accountId: String(cString: a), assetId: String(cString: l),
        fileId: String(cString: f), createdAtMs: sqlite3_column_int64(stmt, 3)
      ))
    }
    return rows
  }

  @discardableResult
  static func insertPendingMarks(_ db: OpaquePointer, _ marks: [PendingMark]) -> Bool {
    guard !marks.isEmpty else { return true }
    sqlite3_exec(db, pendingMarksTableSQL, nil, nil, nil)
    guard sqlite3_exec(db, "BEGIN IMMEDIATE", nil, nil, nil) == SQLITE_OK else { return false }
    var ok = true
    for m in marks where ok {
      ok = run(db, """
      INSERT OR REPLACE INTO backup_pending_marks (account_id, local_asset_id, remote_file_id, created_at_ms)
      VALUES (?, ?, ?, ?)
      """) { stmt in
        bindText(stmt, 1, m.accountId)
        bindText(stmt, 2, m.assetId)
        bindText(stmt, 3, m.fileId)
        sqlite3_bind_int64(stmt, 4, m.createdAtMs)
      } >= 0
    }
    if ok, sqlite3_exec(db, "COMMIT", nil, nil, nil) == SQLITE_OK { return true }
    sqlite3_exec(db, "ROLLBACK", nil, nil, nil)
    return false
  }

  /// Pending marks of `accountId` only, for diagnostics and tests.
  static func pendingMarkCount(_ db: OpaquePointer, accountId: String) -> Int {
    pendingMarkCountChecked(db, accountId: accountId) ?? 0
  }

  /// Round 4: as `pendingMarkCount`, but nil when the count could not be
  /// read. A missing table (a manifest from before round 2) is 0, a read
  /// error is NOT: it would read as "nothing kept" and let the scan upload
  /// those photos again.
  static func pendingMarkCountChecked(_ db: OpaquePointer, accountId: String) -> Int? {
    guard let exists = tableExistsChecked(db, "backup_pending_marks") else { return nil }
    guard exists else { return 0 }
    var stmt: OpaquePointer?
    guard sqlite3_prepare_v2(db, "SELECT COUNT(*) FROM backup_pending_marks WHERE account_id = ?", -1, &stmt, nil) == SQLITE_OK else { return nil }
    defer { sqlite3_finalize(stmt) }
    bindText(stmt, 1, accountId)
    guard sqlite3_step(stmt) == SQLITE_ROW else { return nil }
    return Int(sqlite3_column_int64(stmt, 0))
  }

  /// Next sign-in of `accountId`: every kept association whose photo is in
  /// the manifest and not uploaded or mid-upload becomes `uploaded` again
  /// (owner `accountId`, `server_marked_at = NULL`, so the mark catch-up
  /// sends it to the server), and its kept row is consumed. Kept rows whose
  /// photo has no manifest row yet stay for the next call. Expired rows of
  /// any account are dropped. Another account's rows are never read.
  ///
  /// Round 4 (Codex P1 "Fail closed when applying the server identifier
  /// map"): nil when it could not run or commit (e.g. another connection
  /// holds the writer lock). 0 means "nothing to apply" and nothing else: the
  /// caller must not start uploads on nil, or every kept photo uploads again.
  @discardableResult
  static func applyPendingMarks(_ db: OpaquePointer, accountId: String, nowMs: Int64) -> Int? {
    guard !accountId.isEmpty else { return 0 }
    guard let count = pendingMarkCountChecked(db, accountId: accountId) else { return nil }
    guard count > 0 else { return 0 }
    guard sqlite3_exec(db, "BEGIN IMMEDIATE", nil, nil, nil) == SQLITE_OK else { return nil }
    let expired = run(db, "DELETE FROM backup_pending_marks WHERE created_at_ms < ?") { stmt in
      sqlite3_bind_int64(stmt, 1, nowMs - pendingMarksRetentionMs)
    }
    let promoteSQL = """
    UPDATE backup_assets
       SET status = 'uploaded',
           remote_file_id = (SELECT p.remote_file_id FROM backup_pending_marks p
                              WHERE p.account_id = ?1 AND p.local_asset_id = backup_assets.local_asset_id),
           uploaded_at = COALESCE(uploaded_at, ?2),
           uploaded_account_id = ?1,
           server_marked_at = NULL,
           error_message = NULL,
           retry_count = 0
     WHERE staged_file_id IS NULL
       AND status IN (\(rebuildableStatuses))
       AND local_asset_id IN (SELECT local_asset_id FROM backup_pending_marks WHERE account_id = ?1)
    """
    let iso = ISO8601DateFormatter().string(from: Date(timeIntervalSince1970: Double(nowMs) / 1000))
    let promoted = run(db, promoteSQL) { stmt in
      bindText(stmt, 1, accountId)
      bindText(stmt, 2, iso)
    }
    // Consume every kept row the manifest now carries for this account (just
    // promoted, or already uploaded with that same file).
    let consumed = run(db, """
    DELETE FROM backup_pending_marks
     WHERE account_id = ?1
       AND EXISTS (SELECT 1 FROM backup_assets a
                    WHERE a.local_asset_id = backup_pending_marks.local_asset_id
                      AND a.status = 'uploaded'
                      AND a.uploaded_account_id = ?1
                      AND a.remote_file_id = backup_pending_marks.remote_file_id)
    """) { stmt in bindText(stmt, 1, accountId) }
    guard expired >= 0, promoted >= 0, consumed >= 0, sqlite3_exec(db, "COMMIT", nil, nil, nil) == SQLITE_OK else {
      sqlite3_exec(db, "ROLLBACK", nil, nil, nil)
      return nil
    }
    return promoted
  }

  /// Adopt-only half of `claim`, for the sign-out reset: rows written before
  /// `uploaded_account_id` existed belong to the account signing out, so
  /// their association is kept under it. Never re-queues anything.
  @discardableResult
  static func adoptUnowned(_ db: OpaquePointer, accountId: String) -> Int {
    guard !accountId.isEmpty else { return 0 }
    return max(0, run(db, """
    UPDATE backup_assets
       SET uploaded_account_id = ?
     WHERE uploaded_account_id IS NULL
       AND staged_file_id IS NULL
       AND remote_file_id IS NOT NULL
       AND status IN (\(remoteBoundStatuses))
    """) { stmt in bindText(stmt, 1, accountId) })
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
  ///
  /// Round 4: both updates commit together or not at all, and nil reports
  /// that they did not (e.g. another connection holds the writer lock). A
  /// failed claim leaves another account's rows reading as "uploaded"; the
  /// rebuild gate does not start uploads on nil.
  @discardableResult
  static func claim(_ db: OpaquePointer, accountId: String, nowMs: Int64) -> (adopted: Int, requeued: Int)? {
    guard !accountId.isEmpty else { return (0, 0) }
    guard sqlite3_exec(db, "BEGIN IMMEDIATE", nil, nil, nil) == SQLITE_OK else { return nil }
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
    guard adopted >= 0, requeued >= 0, sqlite3_exec(db, "COMMIT", nil, nil, nil) == SQLITE_OK else {
      sqlite3_exec(db, "ROLLBACK", nil, nil, nil)
      return nil
    }
    return (adopted, requeued)
  }

  /// Rows this account has uploaded according to the manifest; nil when the
  /// count could not be read (round 4: an error is not "none").
  static func uploadedCount(_ db: OpaquePointer, accountId: String) -> Int? {
    let sql = "SELECT COUNT(*) FROM backup_assets WHERE status = 'uploaded' AND uploaded_account_id = ?"
    var stmt: OpaquePointer?
    guard sqlite3_prepare_v2(db, sql, -1, &stmt, nil) == SQLITE_OK else { return nil }
    defer { sqlite3_finalize(stmt) }
    bindText(stmt, 1, accountId)
    guard sqlite3_step(stmt) == SQLITE_ROW else { return nil }
    return Int(sqlite3_column_int64(stmt, 0))
  }

  /// A manifest holding nothing this account uploaded must be rebuilt from
  /// the server before its first upload: otherwise every photo the account
  /// already backed up from this device (sign-out then sign-in, reinstall)
  /// is uploaded again. nil when the manifest could not be read.
  static func needsServerRebuild(_ db: OpaquePointer, accountId: String) -> Bool? {
    uploadedCount(db, accountId: accountId).map { $0 == 0 }
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
  ///
  /// Round 4 (Codex P1 "Fail closed when applying the server identifier
  /// map"): nil unless EVERY update ran and the transaction committed. The
  /// old shape returned 0 when `BEGIN` or a step failed (another connection
  /// holding the writer lock), the same value as "the server has none of
  /// these", and the engine then queued every photo again. `BEGIN IMMEDIATE`
  /// takes the writer lock up front, so a busy database fails before any
  /// update instead of partway through.
  @discardableResult
  static func applyServerMap(
    _ db: OpaquePointer,
    accountId: String,
    localToFileId: [String: String],
    uploadedAtIso: String,
    nowMs: Int64
  ) -> Int? {
    guard !accountId.isEmpty else { return nil }
    guard !localToFileId.isEmpty else { return 0 }
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
    guard sqlite3_prepare_v2(db, sql, -1, &stmt, nil) == SQLITE_OK else { return nil }
    defer { sqlite3_finalize(stmt) }
    guard sqlite3_exec(db, "BEGIN IMMEDIATE", nil, nil, nil) == SQLITE_OK else { return nil }
    var promoted = 0
    for (local, fileId) in localToFileId {
      bindText(stmt, 1, fileId)
      bindText(stmt, 2, uploadedAtIso)
      bindText(stmt, 3, accountId)
      sqlite3_bind_int64(stmt, 4, nowMs)
      bindText(stmt, 5, local)
      let rc = sqlite3_step(stmt)
      sqlite3_reset(stmt)
      sqlite3_clear_bindings(stmt)
      guard rc == SQLITE_DONE else {
        sqlite3_exec(db, "ROLLBACK", nil, nil, nil)
        return nil
      }
      promoted += Int(sqlite3_changes(db))
    }
    guard sqlite3_exec(db, "COMMIT", nil, nil, nil) == SQLITE_OK else {
      sqlite3_exec(db, "ROLLBACK", nil, nil, nil)
      return nil
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
    tableExistsChecked(db, name) ?? false
  }

  /// nil when sqlite_master could not be read (round 4: an error is not "no").
  static func tableExistsChecked(_ db: OpaquePointer, _ name: String) -> Bool? {
    let sql = "SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = ?"
    var stmt: OpaquePointer?
    guard sqlite3_prepare_v2(db, sql, -1, &stmt, nil) == SQLITE_OK else { return nil }
    defer { sqlite3_finalize(stmt) }
    bindText(stmt, 1, name)
    switch sqlite3_step(stmt) {
    case SQLITE_ROW: return true
    case SQLITE_DONE: return false
    default: return nil
    }
  }
}
