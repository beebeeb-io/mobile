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

  func upsert(_ items: [CachedItem]) {
    queue.sync {
      execute("BEGIN")
      for item in items { _upsert(item) }
      execute("COMMIT")
    }
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
    queue.sync {
      executeBindable("DELETE FROM file_cache WHERE id = ?") { stmt in
        sqlite3_bind_text(stmt, 1, (id as NSString).utf8String, -1, nil)
      }
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

  private func execute(_ sql: String) {
    guard let db else { return }
    sqlite3_exec(db, sql, nil, nil, nil)
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
