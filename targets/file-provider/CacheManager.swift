import Foundation
import SQLite3

/// SQLite-backed metadata cache for the File Provider extension.
///
/// Stored in the App Group container so the main app can read/write the same
/// rows. Holds metadata only — file content is materialized on demand from the
/// API and either evicted (default) or pinned to disk.
///
/// Concurrency: a single serial queue serializes all access. Each call opens a
/// short-lived prepared statement; we don't hold connections open across
/// async boundaries.
final class CacheManager {
  static let shared = CacheManager()

  private let queue = DispatchQueue(label: "io.beebeeb.fileprovider.cache")
  private var db: OpaquePointer?

  private init() {
    let path = AppGroupContainer.cacheDatabaseUrl.path
    var handle: OpaquePointer?
    let status = sqlite3_open_v2(
      path,
      &handle,
      SQLITE_OPEN_READWRITE | SQLITE_OPEN_CREATE | SQLITE_OPEN_FULLMUTEX,
      nil
    )
    guard status == SQLITE_OK, let handle else {
      sqlite3_close(handle)
      // A corrupt cache is recoverable by re-creating the file. We log and rely
      // on the next launch to retry; an extension instance with no cache simply
      // returns no items, which the system handles gracefully.
      NSLog("[Beebeeb] failed to open cache database at \(path): \(status)")
      return
    }
    self.db = handle
    // Task 1593 round 7 (C2) — `SQLITE_OPEN_CREATE` above means an
    // extension launched before the main app has ever run (or after
    // `clearFileProviderCacheState` unlinked the file) creates this
    // database itself. `PlaintextStorageProtection.swift` is compiled
    // directly into this target too (see its header comment), so this
    // extension can call the same `protect()` the main app uses instead of
    // leaving the file backup-eligible / unprotected until the next time
    // the main app's `hardenAll()` happens to run.
    PlaintextStorageProtection.protect(URL(fileURLWithPath: path))
    // Task 1593 round 10 (Codex thread PRRT_kwDOSLX6T86mhUiZ) — the main
    // file's own `protect()` above does not cover its SQLite sidecars
    // (`-journal`, `-wal`/`-shm`); see `protectSQLiteSidecars`'s doc comment.
    PlaintextStorageProtection.protectSQLiteSidecars(URL(fileURLWithPath: path))
    // Task 1593 round 8 (R2) — the main app's own writers to this exact
    // file (`bumpFileProviderCacheVersion`, `resetFileProviderCacheDatabase`,
    // `PlaintextStorageProtection.resetSQLiteInPlace`) all take a real
    // `BEGIN IMMEDIATE` write lock on it; this connection's own
    // `BEGIN IMMEDIATE` calls (`replaceChildren`/`upsert(_:expectedEpoch:)`/
    // `delete(id:expectedEpoch:)`) can therefore transiently contend with
    // them. A short busy timeout turns that contention into a brief wait
    // instead of an immediate SQLITE_BUSY failure.
    sqlite3_busy_timeout(handle, 2000)
    // Task 1593 round 6 (new-3) — this connection is the extension's own
    // writer for `delete(id:)` / `_deleteChildren` (below); without
    // secure_delete a DELETE's freed b-tree page keeps the decrypted
    // `name_decrypted` bytes readable on disk until something VACUUMs the
    // file, which this long-lived extension connection never does (same
    // finding as the main app's identical fix in
    // BeebeebCryptoModule.swift's `syncFileProviderCache`). Set this pragma
    // ahead of the migrations that follow, so it is already in effect
    // before this connection issues any statement.
    execute("PRAGMA secure_delete = ON")
    runMigrations()
  }

  deinit {
    if let db { sqlite3_close(db) }
  }

  // MARK: - Migrations

  private func runMigrations() {
    let statements = [
      """
      CREATE TABLE IF NOT EXISTS file_cache (
        id TEXT PRIMARY KEY,
        parent_id TEXT,
        name_encrypted TEXT,
        name_decrypted TEXT,
        mime_type TEXT,
        size_bytes INTEGER NOT NULL DEFAULT 0,
        is_folder INTEGER NOT NULL DEFAULT 0,
        is_pinned INTEGER NOT NULL DEFAULT 0,
        has_thumbnail INTEGER NOT NULL DEFAULT 0,
        thumbnail_data BLOB,
        thumbnail_nonce BLOB,
        created_at TEXT,
        updated_at TEXT,
        sync_anchor INTEGER NOT NULL DEFAULT 0,
        is_materialized INTEGER NOT NULL DEFAULT 0
      );
      """,
      "CREATE INDEX IF NOT EXISTS idx_file_cache_parent ON file_cache(parent_id);",
      "CREATE INDEX IF NOT EXISTS idx_file_cache_anchor ON file_cache(sync_anchor);",
      """
      CREATE TABLE IF NOT EXISTS sync_state (
        key TEXT PRIMARY KEY,
        value TEXT
      );
      """,
      """
      CREATE TABLE IF NOT EXISTS upload_queue (
        id TEXT PRIMARY KEY,
        parent_id TEXT,
        local_path TEXT,
        file_id TEXT,
        status TEXT NOT NULL DEFAULT 'pending',
        created_at TEXT NOT NULL
      );
      """,
    ]
    for sql in statements {
      execute(sql)
    }
  }

  // MARK: - Public API

  func upsert(_ item: CachedItem) {
    queue.sync { _upsert(item) }
  }

  /// Task 1593 round 7 (C1) — `expectedEpoch` is the purge-epoch value the
  /// caller (`SyncEngine.refreshContainer`) read BEFORE starting the API
  /// fetch these `items` came from.
  ///
  /// Task 1593 round 8 (R2, security re-review) — the epoch itself used to
  /// be a separate App Group `UserDefaults` counter, which is not a real
  /// synchronisation primitive: `UserDefaults(suiteName:)` is backed by
  /// `cfprefsd` with no guaranteed-immediate cross-process visibility, so
  /// this method's re-check could still observe a STALE value even after
  /// the main app's bump had already "landed" on its side. The epoch now
  /// lives in THIS SAME database's own `PRAGMA user_version`, and this
  /// method opens its write with `BEGIN IMMEDIATE` — a real OS-level write
  /// lock on the file (this db is never WAL-mode, so that's the lock the
  /// default rollback journal always uses) — before reading it. That lock
  /// directly contends with the main app's own `BEGIN IMMEDIATE` writers
  /// (`bumpFileProviderCacheVersion`, `resetFileProviderCacheDatabase`,
  /// `PlaintextStorageProtection.resetSQLiteInPlace`): whichever side gets
  /// there first finishes its whole transaction before the other's BEGIN
  /// IMMEDIATE can even proceed, so there is no window left where "the
  /// epoch check passed" and "the epoch changed" can straddle this write.
  /// Aborts (ROLLBACK, returns `false`) on a mismatch instead of writing —
  /// a sign-out purge that bumped the version anywhere before this BEGIN
  /// IMMEDIATE acquired the lock makes this call a no-op instead of
  /// reinserting decrypted names the purge is in the middle of sweeping.
  /// Returns whether the write actually happened, so the caller can decide
  /// whether to also update its `sync_state` anchor.
  @discardableResult
  func replaceChildren(parent: String?, with items: [CachedItem], expectedEpoch: Int) -> Bool {
    queue.sync {
      guard beginImmediate() else { return false }
      guard currentEpochMatches(expectedEpoch) else {
        execute("ROLLBACK")
        return false
      }
      _deleteChildren(parent: parent, keepingIds: Set(items.map(\.id)))
      for item in items { _upsert(item) }
      return commitOrRollback()
    }
  }

  /// Task 1593 round 8 (R3) — same purge-epoch gate as `replaceChildren`,
  /// for the OTHER writers on this cache: `FileProviderExtension.createItem`
  /// / `modifyItem` run an unbounded-duration network call (upload/patch)
  /// BEFORE ever touching this cache — the exact same "a sign-out purge can
  /// land while I'm in flight" window `replaceChildren` closes for reads,
  /// but for these operations' own cache write instead. The caller captures
  /// `expectedEpoch` right before starting that network call.
  @discardableResult
  func upsert(_ item: CachedItem, expectedEpoch: Int) -> Bool {
    queue.sync {
      guard beginImmediate() else { return false }
      guard currentEpochMatches(expectedEpoch) else {
        execute("ROLLBACK")
        return false
      }
      _upsert(item)
      return commitOrRollback()
    }
  }

  /// Public, queue-synchronized read for callers OUTSIDE this class (e.g.
  /// `SyncEngine.refreshContainer`, which must capture this BEFORE starting
  /// its network fetch — see `replaceChildren`'s doc comment for the full
  /// epoch rationale). Internal call sites already inside `queue.sync` use
  /// `_currentPurgeEpoch()` directly — this method would deadlock if called
  /// from inside another `queue.sync` block on this same serial queue.
  func currentPurgeEpoch() -> Int {
    queue.sync { _currentPurgeEpoch() }
  }

  /// Task 1593 round 11 (Codex thread PRRT_kwDOSLX6T86miVoN, P1) — safe
  /// "has the epoch moved since I captured it" check for callers OUTSIDE
  /// this class that gate a multi-step operation (`FileProviderExtension
  /// .fetchContents`'s download→decrypt→write span) rather than a single
  /// transactional write. Reuses `currentEpochMatches` — the same
  /// `epochQueryFailed`-sentinel-safe comparison the three epoch-gated
  /// writers below already use — instead of a bare `currentPurgeEpoch() ==
  /// capturedEpoch` at the call site, so a failed read on EITHER side (the
  /// caller's own earlier capture, or this live re-check) can never
  /// accidentally read as "unchanged" just because both happened to produce
  /// the same failure sentinel.
  /// Task 1593 f1 (fail-closed purge-pending marker) — checked FIRST, before
  /// the epoch comparison: a pending marker means a purge could not prove
  /// its own epoch advance landed, so an unchanged-looking epoch is no
  /// longer trustworthy evidence either. See
  /// `PlaintextStorageProtection.markPurgePending()`'s doc comment.
  func purgeEpochUnchanged(since capturedEpoch: Int) -> Bool {
    queue.sync {
      guard !PlaintextStorageProtection.isPurgePending() else { return false }
      return currentEpochMatches(capturedEpoch)
    }
  }

  /// Task 1593 round 10 (reviewer F-b) — a failed `PRAGMA user_version`
  /// query used to return `0`, a perfectly ordinary epoch value a purge's
  /// very first bump could legitimately produce. A query failure here (a
  /// bad handle, a locked file the busy timeout still couldn't clear) is
  /// silent data loss dressed up as a real reading: `_currentPurgeEpoch()
  /// == expectedEpoch` could accidentally be TRUE against a caller whose own
  /// earlier capture also happened to read `0`, letting a gated write land
  /// with no actual epoch check having occurred. `epochQueryFailed` is a
  /// sentinel no real `PRAGMA user_version` read (an unsigned 32-bit
  /// column) can ever produce, and `currentEpochMatches(_:)` below refuses
  /// unconditionally whenever either side of the comparison is this
  /// sentinel — so a failed capture (the caller's `currentPurgeEpoch()`
  /// having itself failed) is treated exactly like a failed live read: both
  /// mean "do not write", never "write, because both sides happen to be
  /// the same placeholder".
  private static let epochQueryFailed = Int.min

  private func _currentPurgeEpoch() -> Int {
    var stmt: OpaquePointer?
    defer { sqlite3_finalize(stmt) }
    guard prepare("PRAGMA user_version", &stmt), sqlite3_step(stmt) == SQLITE_ROW else {
      return Self.epochQueryFailed
    }
    return Int(sqlite3_column_int(stmt, 0))
  }

  /// Task 1593 round 10 (reviewer F-b) — the single comparison every
  /// epoch-gated writer (`replaceChildren`/`upsert(_:expectedEpoch:)`/
  /// `delete(id:expectedEpoch:)`) uses instead of a bare `==`. See
  /// `epochQueryFailed`'s doc comment: `epoch != Self.epochQueryFailed` is
  /// checked FIRST and independently of the equality, so the sentinel can
  /// never "match" `expectedEpoch` even in the degenerate case where the
  /// caller's own capture also failed and produced the same sentinel value.
  private func currentEpochMatches(_ expectedEpoch: Int) -> Bool {
    let epoch = _currentPurgeEpoch()
    return epoch != Self.epochQueryFailed && epoch == expectedEpoch
  }

  /// Task 1593 f1 (fail-closed purge-pending marker) — the shared entry
  /// point for every epoch-gated writer (`replaceChildren`,
  /// `upsert(_:expectedEpoch:)`, `delete(id:expectedEpoch:)`): refusing here
  /// closes all three at once. See
  /// `PlaintextStorageProtection.markPurgePending()`'s doc comment.
  private func beginImmediate() -> Bool {
    guard let db else { return false }
    guard !PlaintextStorageProtection.isPurgePending() else { return false }
    return sqlite3_exec(db, "BEGIN IMMEDIATE", nil, nil, nil) == SQLITE_OK
  }

  /// Task 1593 round 10 (reviewer F-b) — `execute("COMMIT")`'s result used
  /// to be discarded at every one of this class's three epoch-gated
  /// writers: a COMMIT that fails (e.g. `SQLITE_BUSY` racing the main app's
  /// own `BEGIN IMMEDIATE` writers to this same file) used to be reported
  /// to the caller as a successful write while the transaction it opened
  /// was, per SQLite's own semantics, left OPEN — this long-lived
  /// extension connection would then carry that write lock forward
  /// indefinitely, since nothing ever issued the matching `ROLLBACK` (or a
  /// retried `COMMIT`) to close it, silently wedging every subsequent write
  /// through this connection. `ROLLBACK`ing a failed COMMIT abandons the
  /// transaction outright rather than retrying it — this connection has no
  /// currently-established retry policy for a mid-COMMIT failure, and
  /// leaving the lock held is strictly worse than discarding this one
  /// write.
  private func commitOrRollback() -> Bool {
    if execute("COMMIT") {
      return true
    }
    execute("ROLLBACK")
    return false
  }

  func item(id: String) -> CachedItem? {
    queue.sync { _item(id: id) }
  }

  func children(parent: String?) -> [CachedItem] {
    queue.sync { _children(parent: parent) }
  }

  func setPinned(id: String, pinned: Bool) {
    queue.sync {
      executeBindable("UPDATE file_cache SET is_pinned = ? WHERE id = ?") { stmt in
        sqlite3_bind_int(stmt, 1, pinned ? 1 : 0)
        sqlite3_bind_text(stmt, 2, (id as NSString).utf8String, -1, nil)
      }
    }
  }

  func setMaterialized(id: String, value: Bool) {
    queue.sync {
      executeBindable("UPDATE file_cache SET is_materialized = ? WHERE id = ?") { stmt in
        sqlite3_bind_int(stmt, 1, value ? 1 : 0)
        sqlite3_bind_text(stmt, 2, (id as NSString).utf8String, -1, nil)
      }
    }
  }

  func delete(id: String) {
    queue.sync { _delete(id: id) }
  }

  /// Task 1593 round 8 (R3) — see `upsert(_:expectedEpoch:)`'s doc comment.
  /// `FileProviderExtension.deleteItem` captures `expectedEpoch` right
  /// before its `ApiClient.shared.deleteFile` network call.
  @discardableResult
  func delete(id: String, expectedEpoch: Int) -> Bool {
    queue.sync {
      guard beginImmediate() else { return false }
      guard currentEpochMatches(expectedEpoch) else {
        execute("ROLLBACK")
        return false
      }
      _delete(id: id)
      return commitOrRollback()
    }
  }

  func setSyncState(key: String, value: String) {
    queue.sync {
      executeBindable(
        "INSERT INTO sync_state(key, value) VALUES(?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value"
      ) { stmt in
        sqlite3_bind_text(stmt, 1, (key as NSString).utf8String, -1, nil)
        sqlite3_bind_text(stmt, 2, (value as NSString).utf8String, -1, nil)
      }
    }
  }

  func syncState(key: String) -> String? {
    queue.sync {
      var stmt: OpaquePointer?
      defer { sqlite3_finalize(stmt) }
      guard prepare("SELECT value FROM sync_state WHERE key = ?", &stmt) else { return nil }
      sqlite3_bind_text(stmt, 1, (key as NSString).utf8String, -1, nil)
      guard sqlite3_step(stmt) == SQLITE_ROW,
            let cstr = sqlite3_column_text(stmt, 0) else { return nil }
      return String(cString: cstr)
    }
  }

  // MARK: - Internal

  private func _upsert(_ item: CachedItem) {
    let sql = """
    INSERT INTO file_cache(
      id, parent_id, name_encrypted, name_decrypted, mime_type, size_bytes,
      is_folder, is_pinned, has_thumbnail, thumbnail_data, thumbnail_nonce,
      created_at, updated_at, sync_anchor, is_materialized
    ) VALUES(?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    ON CONFLICT(id) DO UPDATE SET
      parent_id = excluded.parent_id,
      name_encrypted = excluded.name_encrypted,
      name_decrypted = COALESCE(excluded.name_decrypted, file_cache.name_decrypted),
      mime_type = excluded.mime_type,
      size_bytes = excluded.size_bytes,
      is_folder = excluded.is_folder,
      has_thumbnail = excluded.has_thumbnail,
      thumbnail_data = COALESCE(excluded.thumbnail_data, file_cache.thumbnail_data),
      thumbnail_nonce = COALESCE(excluded.thumbnail_nonce, file_cache.thumbnail_nonce),
      created_at = excluded.created_at,
      updated_at = excluded.updated_at,
      sync_anchor = excluded.sync_anchor;
    """
    executeBindable(sql) { stmt in
      sqlite3_bind_text(stmt, 1, (item.id as NSString).utf8String, -1, nil)
      bindNullable(stmt, 2, item.parentId)
      bindNullable(stmt, 3, item.nameEncrypted)
      bindNullable(stmt, 4, item.nameDecrypted)
      bindNullable(stmt, 5, item.mimeType)
      sqlite3_bind_int64(stmt, 6, Int64(item.sizeBytes))
      sqlite3_bind_int(stmt, 7, item.isFolder ? 1 : 0)
      sqlite3_bind_int(stmt, 8, item.isPinned ? 1 : 0)
      sqlite3_bind_int(stmt, 9, item.hasThumbnail ? 1 : 0)
      bindBlob(stmt, 10, item.thumbnailData)
      bindBlob(stmt, 11, item.thumbnailNonce)
      bindNullable(stmt, 12, item.createdAt)
      bindNullable(stmt, 13, item.updatedAt)
      sqlite3_bind_int64(stmt, 14, item.syncAnchor)
      sqlite3_bind_int(stmt, 15, item.isMaterialized ? 1 : 0)
    }
  }

  private func _deleteChildren(parent: String?, keepingIds ids: Set<String>) {
    var sql: String
    if parent == nil {
      sql = "DELETE FROM file_cache WHERE parent_id IS NULL"
    } else {
      sql = "DELETE FROM file_cache WHERE parent_id = ?"
    }

    if !ids.isEmpty {
      let placeholders = Array(repeating: "?", count: ids.count).joined(separator: ",")
      sql += " AND id NOT IN (\(placeholders))"
    }

    executeBindable(sql) { stmt in
      var index: Int32 = 1
      if let parent {
        sqlite3_bind_text(stmt, index, (parent as NSString).utf8String, -1, nil)
        index += 1
      }
      for id in ids.sorted() {
        sqlite3_bind_text(stmt, index, (id as NSString).utf8String, -1, nil)
        index += 1
      }
    }
  }

  private func _delete(id: String) {
    executeBindable("DELETE FROM file_cache WHERE id = ?") { stmt in
      sqlite3_bind_text(stmt, 1, (id as NSString).utf8String, -1, nil)
    }
  }

  private func _item(id: String) -> CachedItem? {
    var stmt: OpaquePointer?
    defer { sqlite3_finalize(stmt) }
    guard prepare(rowSelectSql + " WHERE id = ?", &stmt) else { return nil }
    sqlite3_bind_text(stmt, 1, (id as NSString).utf8String, -1, nil)
    guard sqlite3_step(stmt) == SQLITE_ROW else { return nil }
    return readRow(stmt)
  }

  private func _children(parent: String?) -> [CachedItem] {
    var stmt: OpaquePointer?
    defer { sqlite3_finalize(stmt) }
    let where_: String
    if parent == nil {
      where_ = " WHERE parent_id IS NULL"
    } else {
      where_ = " WHERE parent_id = ?"
    }
    guard prepare(rowSelectSql + where_ + " ORDER BY is_folder DESC, name_decrypted ASC", &stmt) else {
      return []
    }
    if let parent { sqlite3_bind_text(stmt, 1, (parent as NSString).utf8String, -1, nil) }
    var rows: [CachedItem] = []
    while sqlite3_step(stmt) == SQLITE_ROW {
      if let row = readRow(stmt) { rows.append(row) }
    }
    return rows
  }

  // MARK: - Row helpers

  private let rowSelectSql = """
  SELECT id, parent_id, name_encrypted, name_decrypted, mime_type, size_bytes,
         is_folder, is_pinned, has_thumbnail, thumbnail_data, thumbnail_nonce,
         created_at, updated_at, sync_anchor, is_materialized
  FROM file_cache
  """

  private func readRow(_ stmt: OpaquePointer?) -> CachedItem? {
    guard let stmt, let idCstr = sqlite3_column_text(stmt, 0) else { return nil }
    return CachedItem(
      id: String(cString: idCstr),
      parentId: textColumn(stmt, 1),
      nameEncrypted: textColumn(stmt, 2),
      nameDecrypted: textColumn(stmt, 3),
      mimeType: textColumn(stmt, 4),
      sizeBytes: Int(sqlite3_column_int64(stmt, 5)),
      isFolder: sqlite3_column_int(stmt, 6) != 0,
      isPinned: sqlite3_column_int(stmt, 7) != 0,
      hasThumbnail: sqlite3_column_int(stmt, 8) != 0,
      thumbnailData: blobColumn(stmt, 9),
      thumbnailNonce: blobColumn(stmt, 10),
      createdAt: textColumn(stmt, 11),
      updatedAt: textColumn(stmt, 12),
      syncAnchor: sqlite3_column_int64(stmt, 13),
      isMaterialized: sqlite3_column_int(stmt, 14) != 0
    )
  }

  private func textColumn(_ stmt: OpaquePointer?, _ index: Int32) -> String? {
    guard let cstr = sqlite3_column_text(stmt, index) else { return nil }
    return String(cString: cstr)
  }

  private func blobColumn(_ stmt: OpaquePointer?, _ index: Int32) -> Data? {
    let bytes = sqlite3_column_blob(stmt, index)
    let length = sqlite3_column_bytes(stmt, index)
    guard let bytes, length > 0 else { return nil }
    return Data(bytes: bytes, count: Int(length))
  }

  // MARK: - SQLite plumbing

  private func prepare(_ sql: String, _ stmt: UnsafeMutablePointer<OpaquePointer?>) -> Bool {
    guard let db else { return false }
    return sqlite3_prepare_v2(db, sql, -1, stmt, nil) == SQLITE_OK
  }

  /// Task 1593 round 10 (reviewer F-b) — now returns whether the statement
  /// actually succeeded (`@discardableResult` so every pre-existing
  /// fire-and-forget call site — `init`'s pragmas, migrations, the plain
  /// batch `upsert`'s `BEGIN`/`COMMIT` — keeps compiling unchanged); only
  /// `commitOrRollback()` above checks it.
  @discardableResult
  private func execute(_ sql: String) -> Bool {
    guard let db else { return false }
    return sqlite3_exec(db, sql, nil, nil, nil) == SQLITE_OK
  }

  private func executeBindable(_ sql: String, bind: (OpaquePointer?) -> Void) {
    var stmt: OpaquePointer?
    defer { sqlite3_finalize(stmt) }
    guard prepare(sql, &stmt) else { return }
    bind(stmt)
    sqlite3_step(stmt)
  }

  private func bindNullable(_ stmt: OpaquePointer?, _ index: Int32, _ value: String?) {
    if let value {
      // SQLITE_TRANSIENT signals SQLite to copy the bytes — required because
      // the Swift String memory may be reused before sqlite3_step runs.
      let transient = unsafeBitCast(-1, to: sqlite3_destructor_type.self)
      sqlite3_bind_text(stmt, index, value, -1, transient)
    } else {
      sqlite3_bind_null(stmt, index)
    }
  }

  private func bindBlob(_ stmt: OpaquePointer?, _ index: Int32, _ value: Data?) {
    if let value, !value.isEmpty {
      let transient = unsafeBitCast(-1, to: sqlite3_destructor_type.self)
      _ = value.withUnsafeBytes { buf in
        sqlite3_bind_blob(stmt, index, buf.baseAddress, Int32(value.count), transient)
      }
    } else {
      sqlite3_bind_null(stmt, index)
    }
  }
}

/// In-memory mirror of a row in the `file_cache` table.
struct CachedItem {
  let id: String
  let parentId: String?
  let nameEncrypted: String?
  /// Plaintext filename. Cached after first decrypt to avoid rederiving the
  /// file key on every directory listing. Must be cleared on sign-out.
  var nameDecrypted: String?
  let mimeType: String?
  let sizeBytes: Int
  let isFolder: Bool
  var isPinned: Bool
  let hasThumbnail: Bool
  let thumbnailData: Data?
  let thumbnailNonce: Data?
  let createdAt: String?
  let updatedAt: String?
  let syncAnchor: Int64
  var isMaterialized: Bool
}
