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

  /// Task 1667 round 9 (Codex P1 "Delete retained marks during permanent
  /// account deletion", mobile#182 at dacc089d): the accounts a reset must
  /// keep NOTHING of. A permanently deleted account is never coming back, so
  /// its kept marks are no longer an optimisation for its next sign-in: they
  /// are its user id, PhotoKit local identifiers and remote file ids left on
  /// the device after the flow that promised to remove them. Every reset
  /// that runs with a discard (the deletion's own, the sign-out that follows
  /// it, its recovery, a pending reset at the next open) deletes the kept
  /// marks of these accounts and keeps none of their unmarked uploads.
  ///
  /// `all` is used when the deleted account is not known (a deletion reset
  /// that was still pending when the process ended, or a deletion with no
  /// account id at all): every kept mark goes. That costs other accounts on
  /// this device a re-upload of their unmarked photos; keeping a deleted
  /// account's identifiers would cost its privacy, so this fails closed.
  struct MarkDiscard: Equatable {
    var accountIds: Set<String>
    var all: Bool

    static let none = MarkDiscard(accountIds: [], all: false)
    static let everything = MarkDiscard(accountIds: [], all: true)

    var isEmpty: Bool { !all && accountIds.isEmpty }

    func discards(_ accountId: String) -> Bool { all || accountIds.contains(accountId) }

    /// Sorted, so the bound statement is deterministic.
    var sortedIds: [String] { accountIds.sorted() }
  }

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
  ///
  /// Round 9: `discard` names the accounts (or all of them) whose kept marks
  /// are deleted in the same transaction and whose unmarked uploads are not
  /// kept (`MarkDiscard`). `.none` is the ordinary sign-out.
  @discardableResult
  static func resetInPlace(
    _ db: OpaquePointer,
    nowMs: Int64 = currentMs(),
    discard: MarkDiscard = .none,
    checkpointAttempts: Int = 3,
    busyTimeoutMs: Int32 = 2_000,
    retryDelayUs: UInt32 = 100_000
  ) -> Bool {
    // Round 13 (review of mobile#182 at a19037f9, item 8): the reset runs on
    // the engine's LONG-LIVED connection. Its busy timeout and `secure_delete`
    // are restored on every return. Before, they stayed set for the rest of
    // the process: every later engine write that met JS's write lock waited
    // up to the timeout on the serial dbQueue (and every caller waiting on
    // that queue with it), and every later DELETE overwrote pages. A
    // connection whose settings cannot be read is not reset (fail closed).
    guard let previous = connectionSettings(db) else { return false }
    defer { restoreConnectionSettings(db, previous) }
    sqlite3_busy_timeout(db, busyTimeoutMs)
    // Round 7 sweep: an unconfirmed `secure_delete` would leave the outgoing
    // account's rows in the freed pages while reporting the reset done.
    guard sqlite3_exec(db, "PRAGMA secure_delete = ON", nil, nil, nil) == SQLITE_OK else { return false }
    guard tableExists(db, "backup_assets") else { return false }
    // Round 7 sweep: whether `backup_verification` exists must be READ, not
    // assumed. `tableExists` turns a read error into "no such table", and the
    // reset then skipped that DELETE and reported success with its rows kept.
    guard let hasVerification = tableExistsChecked(db, "backup_verification") else { return false }
    sqlite3_exec(db, pendingMarksTableSQL, nil, nil, nil)
    guard sqlite3_exec(db, "BEGIN IMMEDIATE", nil, nil, nil) == SQLITE_OK else { return false }
    // Round 9: a deleted account's kept marks go first, and none of its
    // unmarked uploads is kept below.
    var ok = deleteDiscardedMarks(db, discard)
    if ok, !discard.all {
      let ids = discard.sortedIds
      let excluded = ids.isEmpty
        ? ""
        : "\n       AND uploaded_account_id NOT IN (" + Array(repeating: "?", count: ids.count).joined(separator: ", ") + ")"
      let keepSQL = """
      INSERT OR REPLACE INTO backup_pending_marks (account_id, local_asset_id, remote_file_id, created_at_ms)
      SELECT uploaded_account_id, local_asset_id, remote_file_id, ?
        FROM backup_assets
       WHERE status = 'uploaded'
         AND uploaded_account_id IS NOT NULL
         AND uploaded_account_id != ''
         AND remote_file_id IS NOT NULL
         AND server_marked_at IS NULL
      """ + excluded
      ok = run(db, keepSQL) { stmt in
        sqlite3_bind_int64(stmt, 1, nowMs)
        for (i, id) in ids.enumerated() { bindText(stmt, Int32(i + 2), id) }
      } >= 0
    }
    if ok {
      ok = run(db, "DELETE FROM backup_pending_marks WHERE created_at_ms < ?") { stmt in
        sqlite3_bind_int64(stmt, 1, nowMs - pendingMarksRetentionMs)
      } >= 0
    }
    if ok { ok = sqlite3_exec(db, "DELETE FROM backup_assets", nil, nil, nil) == SQLITE_OK }
    if ok { ok = sqlite3_exec(db, "DELETE FROM backup_upload_chunks", nil, nil, nil) == SQLITE_OK }
    // Created by the JS layer (BackupDatabase.ts); absent until it opened once.
    if ok, hasVerification {
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

  /// Round 13 (item 8): a connection's busy timeout (ms) and `secure_delete`
  /// mode (0 off, 1 on, 2 fast), read with their PRAGMAs. nil when either
  /// cannot be read.
  struct ConnectionSettings: Equatable {
    let busyTimeoutMs: Int32
    let secureDelete: Int32
  }

  static func connectionSettings(_ db: OpaquePointer) -> ConnectionSettings? {
    guard let busy = pragmaInt(db, "PRAGMA busy_timeout"),
          let secure = pragmaInt(db, "PRAGMA secure_delete") else { return nil }
    return ConnectionSettings(busyTimeoutMs: busy, secureDelete: secure)
  }

  static func restoreConnectionSettings(_ db: OpaquePointer, _ settings: ConnectionSettings) {
    sqlite3_busy_timeout(db, settings.busyTimeoutMs)
    // The PRAGMA takes OFF / ON / FAST (an integer 2 reads as ON).
    let mode: String
    switch settings.secureDelete {
    case 0: mode = "OFF"
    case 2: mode = "FAST"
    default: mode = "ON"
    }
    sqlite3_exec(db, "PRAGMA secure_delete = \(mode)", nil, nil, nil)
  }

  private static func pragmaInt(_ db: OpaquePointer, _ sql: String) -> Int32? {
    var stmt: OpaquePointer?
    guard sqlite3_prepare_v2(db, sql, -1, &stmt, nil) == SQLITE_OK else { return nil }
    defer { sqlite3_finalize(stmt) }
    guard sqlite3_step(stmt) == SQLITE_ROW else { return nil }
    return sqlite3_column_int(stmt, 0)
  }

  /// Round 9: deletes the kept marks `discard` names (inside the caller's
  /// transaction). True when nothing is named or the DELETE ran.
  static func deleteDiscardedMarks(_ db: OpaquePointer, _ discard: MarkDiscard) -> Bool {
    if discard.all {
      return sqlite3_exec(db, "DELETE FROM backup_pending_marks", nil, nil, nil) == SQLITE_OK
    }
    let ids = discard.sortedIds
    guard !ids.isEmpty else { return true }
    let sql = "DELETE FROM backup_pending_marks WHERE account_id IN ("
      + Array(repeating: "?", count: ids.count).joined(separator: ", ") + ")"
    return run(db, sql) { stmt in
      for (i, id) in ids.enumerated() { bindText(stmt, Int32(i + 1), id) }
    } >= 0
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
  ///
  /// Round 7 (Codex P2 "Abort replacement when the pending-mark snapshot
  /// fails", mobile#182 at dc531405): the file is replaced ONLY after every
  /// association in it was read. A snapshot that could not be prepared or
  /// stepped, a file that could not be opened, or an `adoptAccountId` whose
  /// pre-column rows could not be adopted, leaves the file exactly as it is
  /// and returns `(false, false)`: the reset stays pending and the next open
  /// retries it. Before, a failed snapshot read as "nothing kept" and the
  /// replacement dropped every unmarked upload's association, so those
  /// photos uploaded again at the next sign-in.
  ///
  /// `adoptAccountId` (round 7 sweep): the account signing out. Its rows from
  /// before `uploaded_account_id` existed are adopted first, as
  /// `NativeBackupEngine.prepareForStoragePurge` does before its own reset,
  /// so the reset here keeps their associations instead of dropping them.
  ///
  /// Round 9: `discard` is the reset's (`MarkDiscard`). The reset here runs
  /// with it, and a replacement carries none of a discarded account's marks.
  static func recoverAfterFailedReset(
    path: String,
    nowMs: Int64 = currentMs(),
    allowUnlink: Bool,
    adoptAccountId: String? = nil,
    discard: MarkDiscard = .none
  ) -> (ok: Bool, unlinked: Bool) {
    // Nothing can be read from a file that cannot be opened: never replace it.
    guard let db = openConnection(path) else { return (false, false) }
    guard let hasAssets = tableExistsChecked(db, "backup_assets") else {
      _ = closeConnection(db)
      return (false, false)
    }
    if hasAssets {
      migrate(db)
      if let adoptAccountId, adoptUnowned(db, accountId: adoptAccountId) == nil {
        _ = closeConnection(db)
        return (false, false)
      }
    }
    let reset = resetInPlace(db, nowMs: nowMs, discard: discard)
    let carried: [PendingMark]? = reset ? [] : pendingMarksSnapshot(db, nowMs: nowMs, discard: discard)
    let closed = closeConnection(db)
    if reset { return (true, false) }
    // Round 7: the replacement needs (1) permission (JS closed its handle),
    // (2) every association read, (3) this connection really closed.
    guard allowUnlink, closed, let carried else { return (false, false) }
    return replaceFile(path: path, carrying: carried)
  }

  /// Round 7 sweep: the new file is BUILT first, next to the old one, with
  /// the carried associations committed in it; only then are the old
  /// sidecars removed and the new file renamed over the old (one atomic
  /// step). Before, the old file was unlinked first and the carried marks
  /// written afterwards: a write that failed then lost them with nothing
  /// left to retry from.
  private static func replaceFile(path: String, carrying: [PendingMark]) -> (ok: Bool, unlinked: Bool) {
    let staging = path + ".replacing"
    func removeStaging() {
      for suffix in ["", "-journal", "-wal", "-shm"] { unlink(staging + suffix) }
    }
    removeStaging()
    var fresh: OpaquePointer?
    let flags = SQLITE_OPEN_READWRITE | SQLITE_OPEN_CREATE | SQLITE_OPEN_FULLMUTEX
    guard sqlite3_open_v2(staging, &fresh, flags, nil) == SQLITE_OK, let fresh else {
      if let fresh { sqlite3_close_v2(fresh) }
      removeStaging()
      return (false, false)
    }
    // Rollback journal (no -wal/-shm) so the closed staging file is complete
    // on its own; the engine switches the replaced file to WAL on open.
    // Round 12 (review item 5): the new file carries the JS layer's schema
    // version. Built with `user_version` 0, JS `openAndMigrate` took it for a
    // legacy file and ran the one-time status migration again, turning live
    // 'uploading' rows (the engine's, written before JS's first open) into
    // 'uploaded' with no file id: never retried, never checked, missing from
    // the backup. A new file holds no legacy rows, so the migration is moot.
    let built = sqlite3_exec(fresh, "PRAGMA journal_mode = DELETE", nil, nil, nil) == SQLITE_OK
      && sqlite3_exec(fresh, "PRAGMA user_version = \(jsSchemaVersion)", nil, nil, nil) == SQLITE_OK
      && sqlite3_exec(fresh, pendingMarksTableSQL, nil, nil, nil) == SQLITE_OK
      && insertPendingMarks(fresh, carrying)
    let closed = closeConnection(fresh)
    guard built, closed else {
      removeStaging()
      return (false, false)
    }
    // The old sidecars go BEFORE the rename: an old -wal next to the new
    // file would be replayed into it.
    for suffix in ["-wal", "-shm", "-journal"] {
      if unlink(path + suffix) != 0 && errno != ENOENT {
        removeStaging()
        return (false, false)
      }
    }
    guard rename(staging, path) == 0 else {
      removeStaging()
      return (false, false)
    }
    return (true, true)
  }

  /// Round 12 (review item 5): `PRAGMA user_version` of a manifest whose
  /// rows need no JS legacy status migration. Must equal
  /// `LEGACY_STATUS_ENUM_MIGRATION_VERSION` in src/services/BackupDatabase.ts
  /// (pinned by native-backup-manifest-wiring.test.ts).
  static let jsSchemaVersion: Int32 = 1

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

  /// Round 7 sweep: closes `db` and reports whether the connection is
  /// really closed. `sqlite3_close_v2` always "succeeds": with a statement,
  /// BLOB or backup still open it only marks the connection a zombie, and
  /// its file descriptor stays open until that is released. A file then
  /// unlinked "with every connection closed" is unlinked under that fd.
  /// `sqlite3_close` refuses (SQLITE_BUSY) in exactly those cases: then the
  /// connection is handed to `sqlite3_close_v2` to close once released, and
  /// this returns false. Nothing here finalizes a statement it does not own
  /// (a BLOB's internal statement would be freed under its handle).
  @discardableResult
  static func closeConnection(_ db: OpaquePointer) -> Bool {
    if sqlite3_close(db) == SQLITE_OK { return true }
    sqlite3_close_v2(db)
    return false
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
  ///
  /// Round 7 (Codex P2 "Abort replacement when the pending-mark snapshot
  /// fails"): nil unless EVERY association was read. A table whose
  /// existence cannot be read, a query that cannot be prepared, a step that
  /// ends in anything but SQLITE_DONE, or a row with a NULL column is a
  /// failure, never a shorter list: the caller replaces the file only on a
  /// complete snapshot.
  ///
  /// Round 9: the marks `discard` names are left out (never carried into a
  /// replacement file).
  static func pendingMarksSnapshot(_ db: OpaquePointer, nowMs: Int64, discard: MarkDiscard = .none) -> [PendingMark]? {
    var out: [PendingMark] = []
    guard let hasKept = tableExistsChecked(db, "backup_pending_marks") else { return nil }
    if hasKept {
      guard let kept = select(db, """
      SELECT account_id, local_asset_id, remote_file_id, created_at_ms
        FROM backup_pending_marks WHERE created_at_ms >= ?
      """, bindMs: nowMs - pendingMarksRetentionMs) else { return nil }
      out += kept
    }
    guard let hasAssets = tableExistsChecked(db, "backup_assets") else { return nil }
    if hasAssets {
      guard let unmarked = select(db, """
      SELECT uploaded_account_id, local_asset_id, remote_file_id, ?
        FROM backup_assets
       WHERE status = 'uploaded' AND uploaded_account_id IS NOT NULL AND uploaded_account_id != ''
         AND remote_file_id IS NOT NULL AND server_marked_at IS NULL
      """, bindMs: nowMs) else { return nil }
      out += unmarked
    }
    return out.filter { !discard.discards($0.accountId) }
  }

  /// nil on any failure (prepare, a step that is not ROW/DONE, a NULL column).
  private static func select(_ db: OpaquePointer, _ sql: String, bindMs: Int64) -> [PendingMark]? {
    var stmt: OpaquePointer?
    guard sqlite3_prepare_v2(db, sql, -1, &stmt, nil) == SQLITE_OK else { return nil }
    defer { sqlite3_finalize(stmt) }
    sqlite3_bind_int64(stmt, 1, bindMs)
    var rows: [PendingMark] = []
    while true {
      let rc = sqlite3_step(stmt)
      if rc == SQLITE_DONE { return rows }
      guard rc == SQLITE_ROW else { return nil }
      guard let a = sqlite3_column_text(stmt, 0), let l = sqlite3_column_text(stmt, 1),
            let f = sqlite3_column_text(stmt, 2) else { return nil }
      rows.append(PendingMark(
        accountId: String(cString: a), assetId: String(cString: l),
        fileId: String(cString: f), createdAtMs: sqlite3_column_int64(stmt, 3)
      ))
    }
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

  /// Round 5 (Codex P2 "Expire pending marks even when the current account
  /// has none"): drops the kept marks of EVERY account older than
  /// `pendingMarksRetentionMs`. Its own statement, gated on nothing: before
  /// round 5 the only batch-time expiry sat inside `applyPendingMarks`, after
  /// its "does THIS account have kept marks?" early return, so an account
  /// that never came back kept its rows for as long as only other accounts
  /// used the device. Triggers: every sign-in and bind
  /// (`NativeBackupEngine.expireKeptPendingMarks`), every kept-marks step
  /// before a batch (`applyPendingMarks`, first thing), and the sign-out
  /// reset (`resetInPlace`). Returns the rows deleted; 0 when the table does
  /// not exist yet; nil when it could not run (writer lock, unreadable table).
  @discardableResult
  static func expirePendingMarks(_ db: OpaquePointer, nowMs: Int64) -> Int? {
    guard let exists = tableExistsChecked(db, "backup_pending_marks") else { return nil }
    guard exists else { return 0 }
    let deleted = run(db, "DELETE FROM backup_pending_marks WHERE created_at_ms < ?") { stmt in
      sqlite3_bind_int64(stmt, 1, nowMs - pendingMarksRetentionMs)
    }
    return deleted >= 0 ? deleted : nil
  }

  /// Next sign-in of `accountId`: every kept association whose photo is in
  /// the manifest and not uploaded or mid-upload becomes `uploaded` again
  /// (owner `accountId`, `server_marked_at = NULL`, so the mark catch-up
  /// sends it to the server), and its kept row is consumed. Kept rows whose
  /// photo has no manifest row yet stay for the next call. Another account's
  /// rows are never read. Expired rows of any account are dropped first, as
  /// their own step, whatever this account holds (round 5).
  ///
  /// Round 4 (Codex P1 "Fail closed when applying the server identifier
  /// map"): nil when it could not run or commit (e.g. another connection
  /// holds the writer lock). 0 means "nothing to apply" and nothing else: the
  /// caller must not start uploads on nil, or every kept photo uploads again.
  @discardableResult
  static func applyPendingMarks(_ db: OpaquePointer, accountId: String, nowMs: Int64) -> Int? {
    // Round 5: the expiry is NOT behind the account checks below, and its
    // result gates nothing: a row it could not delete is still never promoted
    // (the promote only reads rows inside the retention window), and the next
    // trigger deletes it.
    expirePendingMarks(db, nowMs: nowMs)
    guard !accountId.isEmpty else { return 0 }
    guard let count = pendingMarkCountChecked(db, accountId: accountId) else { return nil }
    guard count > 0 else { return 0 }
    guard sqlite3_exec(db, "BEGIN IMMEDIATE", nil, nil, nil) == SQLITE_OK else { return nil }
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
       AND local_asset_id IN (SELECT local_asset_id FROM backup_pending_marks
                               WHERE account_id = ?1 AND created_at_ms >= ?3)
    """
    let iso = ISO8601DateFormatter().string(from: Date(timeIntervalSince1970: Double(nowMs) / 1000))
    let promoted = run(db, promoteSQL) { stmt in
      bindText(stmt, 1, accountId)
      bindText(stmt, 2, iso)
      sqlite3_bind_int64(stmt, 3, nowMs - pendingMarksRetentionMs)
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
    guard promoted >= 0, consumed >= 0, sqlite3_exec(db, "COMMIT", nil, nil, nil) == SQLITE_OK else {
      sqlite3_exec(db, "ROLLBACK", nil, nil, nil)
      return nil
    }
    return promoted
  }

  /// Adopt-only half of `claim`, for the sign-out reset: rows written before
  /// `uploaded_account_id` existed belong to the account signing out, so
  /// their association is kept under it. Never re-queues anything.
  ///
  /// Round 7 sweep: nil when the UPDATE did not run (writer lock, broken
  /// table). It used to clamp the error to 0, "nothing to adopt"; the reset
  /// after it then deleted those rows without keeping their associations
  /// (the keep step only reads owned rows), so the photos uploaded again.
  @discardableResult
  static func adoptUnowned(_ db: OpaquePointer, accountId: String) -> Int? {
    guard !accountId.isEmpty else { return 0 }
    let adopted = run(db, """
    UPDATE backup_assets
       SET uploaded_account_id = ?
     WHERE uploaded_account_id IS NULL
       AND staged_file_id IS NULL
       AND remote_file_id IS NOT NULL
       AND status IN (\(remoteBoundStatuses))
    """) { stmt in bindText(stmt, 1, accountId) }
    return adopted >= 0 ? adopted : nil
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

  // MARK: - Camera-roll scan

  /// One camera-roll asset a scan found (`NativeBackupEngine.insertNewAssets`).
  struct ScannedAsset: Equatable {
    let localAssetId: String
    let createdAt: String
    /// "photo" or "video".
    let assetType: String
  }

  /// Queues every scanned asset the manifest does not track yet, and puts a
  /// row whose photo had gone missing back in the queue. Moved here
  /// unchanged from `NativeBackupEngine.insertNewAssets` (round 6) so the
  /// reopen test drives the shipped statement. Returns false when the
  /// statement could not be prepared or the batch did not commit.
  @discardableResult
  static func insertScannedAssets(_ db: OpaquePointer, _ assets: [ScannedAsset], nowMs: Int64) -> Bool {
    insertScannedAssetsCounting(db, assets, nowMs: nowMs) != nil
  }

  /// Round 12 (review item 10): `insertScannedAssets`, returning how many
  /// rows ENTERED the pending queue: inserted, or revived from
  /// `local_missing`. An upsert of a row that was already there (the common
  /// case: every full scan re-upserts the whole library) counts 0. nil when
  /// the insert failed (rolled back). The engine requests a bulk server check
  /// only for a count above 0; before, every full scan owed one.
  ///
  /// Round 13 (review of mobile#182 at a19037f9, item 11): no SELECT per row.
  /// Round 12 read every row's status before its upsert, inside the
  /// `BEGIN IMMEDIATE` on the serial dbQueue: a 50k-asset library ran 50k
  /// extra statements on every full scan while holding the writer lock. Now
  /// one statement per row in the common case:
  /// 1. the upsert, whose UPDATE half skips `local_missing` rows. A row it
  ///    INSERTED is told apart from one it updated by
  ///    `sqlite3_last_insert_rowid` (reset to 0 before each step; an upsert
  ///    that updates leaves it untouched; `backup_assets` is a rowid table);
  /// 2. only when the upsert changed nothing (`sqlite3_changes` 0: the row is
  ///    `local_missing`), the revive UPDATE, counted by `sqlite3_changes`.
  static func insertScannedAssetsCounting(_ db: OpaquePointer, _ assets: [ScannedAsset], nowMs: Int64) -> Int? {
    let upsertSQL = """
    INSERT INTO backup_assets
      (local_asset_id, content_hash, file_size, created_at, asset_type, status, queued_at)
    VALUES (?, '', 0, ?, ?, 'pending_upload', ?)
    ON CONFLICT(local_asset_id) DO UPDATE SET
      created_at = excluded.created_at,
      asset_type = excluded.asset_type,
      selected_for_backup = 1
    WHERE backup_assets.status != 'local_missing'
    """
    let reviveSQL = """
    UPDATE backup_assets
       SET created_at = ?,
           asset_type = ?,
           selected_for_backup = 1,
           status = 'pending_upload',
           retry_count = 0,
           error_message = NULL
     WHERE local_asset_id = ?
       AND status = 'local_missing'
    """
    var upsert: OpaquePointer?
    guard sqlite3_prepare_v2(db, upsertSQL, -1, &upsert, nil) == SQLITE_OK else { return nil }
    defer { sqlite3_finalize(upsert) }
    var revive: OpaquePointer?
    guard sqlite3_prepare_v2(db, reviveSQL, -1, &revive, nil) == SQLITE_OK else { return nil }
    defer { sqlite3_finalize(revive) }

    // Round 7 sweep: every step is checked. Before, a failed BEGIN or a
    // failed row (writer lock, I/O) was ignored and COMMIT reported the
    // batch inserted; the rebuild gate could then apply the server map to a
    // manifest missing those rows, and they uploaded again once a later
    // scan inserted them.
    guard sqlite3_exec(db, "BEGIN IMMEDIATE", nil, nil, nil) == SQLITE_OK else { return nil }
    var entered = 0
    for asset in assets {
      bindText(upsert, 1, asset.localAssetId)
      bindText(upsert, 2, asset.createdAt)
      bindText(upsert, 3, asset.assetType)
      sqlite3_bind_int64(upsert, 4, nowMs)
      sqlite3_set_last_insert_rowid(db, 0)
      let rc = sqlite3_step(upsert)
      sqlite3_reset(upsert)
      guard rc == SQLITE_DONE else {
        sqlite3_exec(db, "ROLLBACK", nil, nil, nil)
        return nil
      }
      if sqlite3_last_insert_rowid(db) != 0 {
        entered += 1
        continue
      }
      guard sqlite3_changes(db) == 0 else { continue }
      // The upsert left the row alone: it is `local_missing`. Revive it.
      bindText(revive, 1, asset.createdAt)
      bindText(revive, 2, asset.assetType)
      bindText(revive, 3, asset.localAssetId)
      let reviveRc = sqlite3_step(revive)
      sqlite3_reset(revive)
      guard reviveRc == SQLITE_DONE else {
        sqlite3_exec(db, "ROLLBACK", nil, nil, nil)
        return nil
      }
      entered += Int(sqlite3_changes(db))
    }
    guard sqlite3_exec(db, "COMMIT", nil, nil, nil) == SQLITE_OK else {
      sqlite3_exec(db, "ROLLBACK", nil, nil, nil)
      return nil
    }
    return entered
  }

  /// The scan's album selection: with no album selection every row is
  /// selected; otherwise only `allowedAssetIds`. Moved here unchanged from
  /// `NativeBackupEngine.updateAssetSelectionScope` (round 8) so the scan's
  /// fenced write (`FencedManifestWrites.scanInsert`) is one function the
  /// fence test drives. False when a step failed (rolled back).
  @discardableResult
  static func updateSelectionScope(_ db: OpaquePointer, allowedAssetIds: Set<String>, hasAlbumSelection: Bool) -> Bool {
    guard hasAlbumSelection else {
      return sqlite3_exec(db, "UPDATE backup_assets SET selected_for_backup = 1 WHERE COALESCE(selected_for_backup, 1) != 1", nil, nil, nil) == SQLITE_OK
    }

    let sqlInChunk = 400
    let transient = unsafeBitCast(-1, to: sqlite3_destructor_type.self)
    guard sqlite3_exec(db, "BEGIN", nil, nil, nil) == SQLITE_OK else { return false }
    var didCommit = false
    defer {
      if !didCommit {
        sqlite3_exec(db, "ROLLBACK", nil, nil, nil)
      }
    }

    guard sqlite3_exec(db, "UPDATE backup_assets SET selected_for_backup = 0", nil, nil, nil) == SQLITE_OK else { return false }

    let assetIds = Array(allowedAssetIds)
    for start in stride(from: 0, to: assetIds.count, by: sqlInChunk) {
      let end = min(start + sqlInChunk, assetIds.count)
      let batch = assetIds[start..<end]
      let placeholders = Array(repeating: "?", count: batch.count).joined(separator: ",")
      let sql = "UPDATE backup_assets SET selected_for_backup = 1 WHERE local_asset_id IN (\(placeholders))"
      var stmt: OpaquePointer?
      guard sqlite3_prepare_v2(db, sql, -1, &stmt, nil) == SQLITE_OK else { return false }
      var didBindBatch = true
      for (index, assetId) in batch.enumerated() {
        if sqlite3_bind_text(stmt, Int32(index + 1), (assetId as NSString).utf8String, -1, transient) != SQLITE_OK {
          didBindBatch = false
          break
        }
      }
      guard didBindBatch else {
        sqlite3_finalize(stmt)
        return false
      }
      let stepResult = sqlite3_step(stmt)
      sqlite3_finalize(stmt)
      guard stepResult == SQLITE_DONE else { return false }
    }

    guard sqlite3_exec(db, "COMMIT", nil, nil, nil) == SQLITE_OK else { return false }
    didCommit = true
    return true
  }

  // MARK: - Upload completion

  /// Completed upload: the row now points at `remoteFileId`, owned by
  /// `accountId`, not yet recorded in the server's map.
  ///
  /// Round 7 sweep: true only when exactly that row was updated. The result
  /// used to be discarded; the engine then deleted the staged chunks of an
  /// upload the manifest never recorded, and the row was uploaded again.
  @discardableResult
  static func markUploaded(
    _ db: OpaquePointer,
    assetId: String,
    remoteFileId: String,
    accountId: String,
    uploadedAtIso: String
  ) -> Bool {
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
    let changed = run(db, sql) { stmt in
      bindText(stmt, 1, remoteFileId)
      bindText(stmt, 2, uploadedAtIso)
      bindText(stmt, 3, accountId)
      bindText(stmt, 4, assetId)
    }
    return changed == 1
  }

  // MARK: - Server map (photo_backup_state)

  /// Uploaded rows of `accountId` the server's map does not have yet.
  ///
  /// Round 7 sweep: nil when the rows could not be read (prepare, a step
  /// that is not ROW/DONE, a NULL column). It returned the rows read so far
  /// (often none), which the callers could not tell from "all marked".
  static func pendingServerMarks(_ db: OpaquePointer, accountId: String, limit: Int) -> [(assetId: String, fileId: String)]? {
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
    guard sqlite3_prepare_v2(db, sql, -1, &stmt, nil) == SQLITE_OK else { return nil }
    defer { sqlite3_finalize(stmt) }
    bindText(stmt, 1, accountId)
    sqlite3_bind_int(stmt, 2, Int32(max(0, limit)))
    var rows: [(assetId: String, fileId: String)] = []
    while true {
      let rc = sqlite3_step(stmt)
      if rc == SQLITE_DONE { return rows }
      guard rc == SQLITE_ROW,
            let a = sqlite3_column_text(stmt, 0), let f = sqlite3_column_text(stmt, 1) else { return nil }
      rows.append((String(cString: a), String(cString: f)))
    }
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
  ///
  /// Round 7 (Codex P2 "Reject malformed identifier-map entries", mobile#182
  /// at dc531405): ONE malformed entry (a value that is not a string, an
  /// empty value, an empty file id) makes the whole map nil, and the fetch
  /// fails closed. It used to skip the entry and return the rest: the rebuild
  /// gate took that as the server's complete answer, declared the account
  /// ready and uploaded the omitted photos again (all of them when every
  /// entry was malformed, exactly like a legitimate empty map).
  static func parseIdentifierMap(_ data: Data) -> [String: String]? {
    guard let object = try? JSONSerialization.jsonObject(with: data) as? [String: Any],
          let identifiers = object["identifiers"] as? [String: Any] else { return nil }
    var byLocal: [String: String] = [:]
    // Deterministic when two files claim one photo: the smallest file id wins.
    for fileId in identifiers.keys.sorted() {
      guard !fileId.isEmpty, let local = identifiers[fileId] as? String, !local.isEmpty else { return nil }
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
    promoteServerBackedUp(
      db, accountId: accountId, localToFileId: localToFileId, uploadedAtIso: uploadedAtIso, nowMs: nowMs
    )?.count
  }

  /// Task 1667 round 10: `applyServerMap`, returning WHICH rows it promoted
  /// (the batch's server check skips exactly those, and every other live
  /// hit). Same statement, same all-or-nothing transaction; nil on any
  /// failure.
  ///
  /// Round 13 (review of mobile#182 at a19037f9, item 9): with
  /// `includeStaleInFlight`, also a 'staging' / 'uploading' row with no staged
  /// file. Only the batch's server check passes it, and it runs inside the
  /// engine's batch slot: no other batch is staging or uploading in this
  /// process then, so such a row is left over from a crash or a cancelled
  /// batch (not actively uploading). Before, the check skipped those hits
  /// without promoting them, and the drain loop asked the server again every
  /// 5 s until `recoverStuckUploads` reset the row after 5 minutes.
  static let staleInFlightStatuses = "'staging', 'uploading'"

  static func promoteServerBackedUp(
    _ db: OpaquePointer,
    accountId: String,
    localToFileId: [String: String],
    uploadedAtIso: String,
    nowMs: Int64,
    includeStaleInFlight: Bool = false
  ) -> Set<String>? {
    guard !accountId.isEmpty else { return nil }
    guard !localToFileId.isEmpty else { return [] }
    let statuses = includeStaleInFlight ? "\(rebuildableStatuses), \(staleInFlightStatuses)" : rebuildableStatuses
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
       AND status IN (\(statuses))
    """
    var stmt: OpaquePointer?
    guard sqlite3_prepare_v2(db, sql, -1, &stmt, nil) == SQLITE_OK else { return nil }
    defer { sqlite3_finalize(stmt) }
    guard sqlite3_exec(db, "BEGIN IMMEDIATE", nil, nil, nil) == SQLITE_OK else { return nil }
    var promoted = Set<String>()
    for (local, fileId) in localToFileId.sorted(by: { $0.key < $1.key }) {
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
      if sqlite3_changes(db) > 0 { promoted.insert(local) }
    }
    guard sqlite3_exec(db, "COMMIT", nil, nil, nil) == SQLITE_OK else {
      sqlite3_exec(db, "ROLLBACK", nil, nil, nil)
      return nil
    }
    return promoted
  }

  /// Task 1667 round 11 (review finding 9): every row a NEW upload would
  /// start from (queued, no staged file, in the backup scope, under the retry
  /// cap), newest first like the drain's selection. The bulk server check
  /// asks about all of them before the drain selects a batch. nil on any
  /// read error (never a partial list).
  static func freshPendingIds(_ db: OpaquePointer) -> [String]? {
    let sql = """
    SELECT local_asset_id FROM backup_assets
     WHERE status IN ('pending_upload', 'pending_reupload')
       AND staged_file_id IS NULL
       AND COALESCE(selected_for_backup, 1) = 1
       AND COALESCE(retry_count, 0) < 10
     ORDER BY created_at DESC
    """
    var stmt: OpaquePointer?
    guard sqlite3_prepare_v2(db, sql, -1, &stmt, nil) == SQLITE_OK else { return nil }
    defer { sqlite3_finalize(stmt) }
    var ids: [String] = []
    while true {
      let rc = sqlite3_step(stmt)
      if rc == SQLITE_DONE { return ids }
      guard rc == SQLITE_ROW, let text = sqlite3_column_text(stmt, 0) else { return nil }
      ids.append(String(cString: text))
    }
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
