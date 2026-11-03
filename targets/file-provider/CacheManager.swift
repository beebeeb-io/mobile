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
  private var schemaReady = false

  #if DEBUG
  private(set) var aliasSiblingQueryCountForTesting = 0
  #endif

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
    schemaReady = runMigrations()
  }

  deinit {
    if let db { sqlite3_close(db) }
  }

  // MARK: - Migrations

  @discardableResult
  private func runMigrations() -> Bool {
    let displayNameColumn = (table: "file_cache", column: "display_name", definition: "TEXT")
    let displayNameSourceNameColumn = (table: "file_cache", column: "display_name_source_name", definition: "TEXT")
    let displayNameSourceParentColumn = (table: "file_cache", column: "display_name_source_parent", definition: "TEXT")
    let statements = [
      """
      CREATE TABLE IF NOT EXISTS file_cache (
        id TEXT PRIMARY KEY,
        parent_id TEXT,
        name_encrypted TEXT,
        name_decrypted TEXT,
        display_name TEXT,
        display_name_source_name TEXT,
        display_name_source_parent TEXT,
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
    var ready = true
    for sql in statements {
      if !execute(sql) { ready = false }
    }
    if !ensureColumn(table: displayNameColumn.table, column: displayNameColumn.column, definition: displayNameColumn.definition) { ready = false }
    if !ensureColumn(table: displayNameSourceNameColumn.table, column: displayNameSourceNameColumn.column, definition: displayNameSourceNameColumn.definition) { ready = false }
    if !ensureColumn(table: displayNameSourceParentColumn.table, column: displayNameSourceParentColumn.column, definition: displayNameSourceParentColumn.definition) { ready = false }
    return ready
  }

  private func ensureSchemaReady() -> Bool {
    if schemaReady { return true }
    schemaReady = runMigrations()
    return schemaReady
  }

  // MARK: - Public API

  func upsert(_ item: CachedItem) {
    queue.sync {
      guard ensureSchemaReady() else { return }
      _upsert(item)
    }
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
  func replaceChildren(
    parent: String?,
    with items: [CachedItem],
    expectedEpoch: Int,
    pruningNamespacePrefix: String? = nil
  ) -> Bool {
    queue.sync {
      guard ensureSchemaReady() else { return false }
      guard beginImmediate() else { return false }
      guard currentEpochMatches(expectedEpoch) else {
        execute("ROLLBACK")
        return false
      }
      _deleteChildren(parent: parent, keepingIds: Set(items.map(\.id)))
      for item in items { _upsert(item) }
      if let pruningNamespacePrefix, let parent {
        _pruneNamespace(pruningNamespacePrefix, reachableFrom: parent)
      }
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
      guard ensureSchemaReady() else { return false }
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
  ///
  /// Task 1593 f4 (Codex thread PRRT_kwDOSLX6T86mknXP, item 1a) — under the
  /// f2 marker-first design the pending marker now stays set for the WHOLE
  /// purge (see `purgeAll(pendingNonce:)`'s doc comment: it only clears
  /// after the legacy sweep AND the pinned/temp resweep, not right after
  /// the reset's own epoch bump commits). A caller like `SyncEngine` that
  /// captures its epoch via THIS method — not `purgeEpochUnchanged(since:)`
  /// — has no other way to know a purge is still in flight; without this
  /// guard it could capture a live, freshly-bumped epoch while the purge's
  /// own tail (VACUUM, the legacy sweep, the pinned/temp resweep) is still
  /// running, then have its later gated write land after the tail finishes
  /// but with an epoch value the purge never actually finished vouching
  /// for. Returning the sentinel here instead means `currentEpochMatches(_:)`
  /// — already sentinel-safe on the LIVE side — now also rejects any
  /// comparison against a captured epoch that came from a pending purge,
  /// since the sentinel can never equal a real `PRAGMA user_version` value.
  /// Task 1593 f6 (Codex thread PRRT_kwDOSLX6T86mmDT1, P1) — the single
  /// `isPurgePending()` guard above only closed the window BEFORE the
  /// `PRAGMA user_version` read: `isPurgePending()` is a plain
  /// `FileManager.fileExists` check against a file another PROCESS (the main
  /// app, running `markPurgePending()`) writes — it is not serialized by
  /// THIS actor's `queue`, so nothing stops that other process from creating
  /// the marker in the gap between this guard passing and `_currentPurgeEpoch()`
  /// actually returning. `_currentPurgeEpoch()` itself briefly blocks behind
  /// the purge's own SQLite work (same busy-timeout contention documented on
  /// `sqlite3_busy_timeout` in `init` above), so that gap is not
  /// instantaneous — it is exactly as long as the purge's reset transaction
  /// takes. A read that lands in that window returns the purge's freshly
  /// bumped FINAL epoch while the marker-covered sweeps (VACUUM, the legacy
  /// sweep, the pinned/temp resweep) are still running, and a caller that
  /// captured that value would later pass `currentEpochMatches` once the
  /// marker is cleared — the exact bypass f4/item-1a's single check was
  /// meant to close. Checking the marker AGAIN, after the read, closes it:
  /// a marker created anywhere during the read is now caught here instead of
  /// being missed entirely.
  func currentPurgeEpoch() -> Int {
    queue.sync {
      guard !PlaintextStorageProtection.isPurgePending() else { return Self.epochQueryFailed }
      let epoch = _currentPurgeEpoch()
      guard !PlaintextStorageProtection.isPurgePending() else { return Self.epochQueryFailed }
      return epoch
    }
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
  /// Task 1593 f6 (Codex thread PRRT_kwDOSLX6T86mmDT1, P1) — same
  /// before/after marker pattern as `currentPurgeEpoch()` above: the initial
  /// `isPurgePending()` guard only closes the window BEFORE
  /// `currentEpochMatches` runs its `PRAGMA user_version` read, not the read
  /// itself, and that read is not serialized against the other PROCESS that
  /// writes the marker. A marker created while `currentEpochMatches` is
  /// still executing must still refuse this call — re-checking after the
  /// read, before returning its result, closes that gap the same way.
  func purgeEpochUnchanged(since capturedEpoch: Int) -> Bool {
    queue.sync {
      guard !PlaintextStorageProtection.isPurgePending() else { return false }
      let matches = currentEpochMatches(capturedEpoch)
      guard !PlaintextStorageProtection.isPurgePending() else { return false }
      return matches
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
  ///
  /// Task 1593 f6 (Codex thread PRRT_kwDOSLX6T86mmDT1, P1) — the guard above
  /// only closes the window BEFORE `BEGIN IMMEDIATE` is issued. `BEGIN
  /// IMMEDIATE` itself blocks behind the purge's own writers under the
  /// `sqlite3_busy_timeout` set in `init` (same contention documented
  /// there), and `isPurgePending()` checks a marker file another PROCESS
  /// writes — not anything serialized by this call. A marker created while
  /// this call is blocked acquiring the lock is invisible to the guard
  /// above; without a second check, this call would return `true` believing
  /// no purge is in progress, and the caller's own `currentEpochMatches`
  /// re-check right after (see `replaceChildren`/`upsert(_:expectedEpoch:)`/
  /// `delete(id:expectedEpoch:)`) reads an epoch that is real but not yet
  /// vouched for — the purge's tail sweeps could still be running. Rechecking
  /// immediately after the lock is acquired, before any caller can act on a
  /// `true` result, closes that gap: a marker that appears mid-wait is now
  /// caught here and the half-open transaction is rolled back rather than
  /// handed to the caller as a usable write.
  private func beginImmediate() -> Bool {
    guard let db else { return false }
    guard !PlaintextStorageProtection.isPurgePending() else { return false }
    guard sqlite3_exec(db, "BEGIN IMMEDIATE", nil, nil, nil) == SQLITE_OK else { return false }
    guard !PlaintextStorageProtection.isPurgePending() else {
      execute("ROLLBACK")
      return false
    }
    return true
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
    queue.sync {
      guard ensureSchemaReady() else {
        return FileProviderDisplayNames.assign(_legacyChildren(parent: _legacyItem(id: id)?.parentId))
          .first { $0.id == id }
      }
      guard var row = _item(id: id) else { return nil }
      if FileProviderDisplayNames.hasValidAlias(row) { return row }

      // The ordinary item(for:) path stops above after its single-row lookup. Only a new or
      // invalid app-written row needs the sibling projection, and that projection excludes all
      // thumbnail blobs. Retry once if the app moved or renamed this row between the two reads.
      for _ in 0..<2 {
        let resolved = _resolvedDisplayNameRows(parent: row.parentId)
        if let alias = resolved.first(where: { $0.id == id }),
           let merged = mergingDisplayName(from: alias, into: row) {
          return merged
        }
        guard let current = _item(id: id) else { return nil }
        if FileProviderDisplayNames.hasValidAlias(current) { return current }
        row = current
      }
      return row
    }
  }

  func children(parent: String?) -> [CachedItem] {
    queue.sync {
      guard ensureSchemaReady() else {
        return FileProviderDisplayNames.assign(_legacyChildren(parent: parent))
      }
      let resolved = _resolvedDisplayNameRows(parent: parent)
      let rows = _children(parent: parent)
      let aliasesById = Dictionary(uniqueKeysWithValues: resolved.map { ($0.id, $0) })
      var allRowsMatched = rows.count == resolved.count
      let merged = rows.map { row -> CachedItem in
        guard let alias = aliasesById[row.id],
              let item = mergingDisplayName(from: alias, into: row) else {
          allRowsMatched = false
          return row
        }
        return item
      }
      // A cross-process app write may land between the light projection and the full result read.
      // Resolve that uncommon snapshot in memory; its next cache read will persist the alias.
      return allRowsMatched ? merged : FileProviderDisplayNames.assign(merged)
    }
  }

  #if DEBUG
  func resetAliasSiblingQueryCountForTesting() {
    queue.sync { aliasSiblingQueryCountForTesting = 0 }
  }
  #endif

  func setPinned(id: String, pinned: Bool) {
    queue.sync {
      executeBindable("UPDATE file_cache SET is_pinned = ? WHERE id = ?") { stmt in
        sqlite3_bind_int(stmt, 1, pinned ? 1 : 0)
        bindText(stmt, 2, id)
      }
    }
  }

  func setMaterialized(id: String, value: Bool) {
    queue.sync {
      executeBindable("UPDATE file_cache SET is_materialized = ? WHERE id = ?") { stmt in
        sqlite3_bind_int(stmt, 1, value ? 1 : 0)
        bindText(stmt, 2, id)
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
        bindText(stmt, 1, key)
        bindText(stmt, 2, value)
      }
    }
  }

  func syncState(key: String) -> String? {
    queue.sync {
      var stmt: OpaquePointer?
      defer { sqlite3_finalize(stmt) }
      guard prepare("SELECT value FROM sync_state WHERE key = ?", &stmt) else { return nil }
      bindText(stmt, 1, key)
      guard sqlite3_step(stmt) == SQLITE_ROW,
            let cstr = sqlite3_column_text(stmt, 0) else { return nil }
      return String(cString: cstr)
    }
  }

  // MARK: - Materialized folders (task 1722 round 4, review round 2 minor 6)

  /// `sync_state` keys that list the folders the system has materialized: folders Files has
  /// listed, whose children are on disk and are refreshed ONLY through the working set (Apple,
  /// NSFileProviderReplicatedExtension.h, materializedItemsDidChange: "traversals of materialized
  /// directories do not [trigger an enumeration] ... there is no alternative cache invalidation
  /// mechanism"). Folder ids only, no names. In `sync_state`, so the sign-out purge's reset
  /// (`DELETE FROM sync_state`) clears them with the rest of the account's cache.
  static let materializedContainerKeyPrefix = "materialized.container."

  func materializedContainerIds() -> [String] {
    queue.sync { _materializedContainerIds() }
  }

  /// Records a folder the system has just listed. Refused while a sign-out purge is pending.
  /// Returns whether it was written.
  @discardableResult
  func noteContainerMaterialized(_ containerId: String) -> Bool {
    queue.sync {
      guard beginImmediate() else { return false }
      executeBindable("INSERT INTO sync_state(key, value) VALUES(?, '1') ON CONFLICT(key) DO NOTHING") { stmt in
        bindNullable(stmt, 1, Self.materializedContainerKeyPrefix + containerId)
      }
      return commitOrRollback()
    }
  }

  /// Replaces the stored folders with `ids`, the system's own materialized set. Epoch-gated like
  /// `replaceChildren` (a purge that ran after `expectedEpoch` was read refuses the write): nil
  /// when refused, otherwise whether the stored set changed.
  func replaceMaterializedContainers(_ ids: Set<String>, expectedEpoch: Int) -> Bool? {
    queue.sync {
      guard beginImmediate() else { return nil }
      guard currentEpochMatches(expectedEpoch) else {
        execute("ROLLBACK")
        return nil
      }
      guard Set(_materializedContainerIds()) != ids else {
        execute("ROLLBACK")
        return false
      }
      executeBindable("DELETE FROM sync_state WHERE substr(key, 1, ?) = ?") { stmt in
        sqlite3_bind_int(stmt, 1, Int32(Self.materializedContainerKeyPrefix.utf8.count))
        bindNullable(stmt, 2, Self.materializedContainerKeyPrefix)
      }
      for id in ids.sorted() {
        executeBindable("INSERT INTO sync_state(key, value) VALUES(?, '1') ON CONFLICT(key) DO NOTHING") { stmt in
          bindNullable(stmt, 1, Self.materializedContainerKeyPrefix + id)
        }
      }
      return commitOrRollback() ? true : nil
    }
  }

  private func _materializedContainerIds() -> [String] {
    var stmt: OpaquePointer?
    defer { sqlite3_finalize(stmt) }
    let prefix = Self.materializedContainerKeyPrefix
    guard prepare("SELECT key FROM sync_state WHERE substr(key, 1, ?) = ? ORDER BY key", &stmt) else { return [] }
    sqlite3_bind_int(stmt, 1, Int32(prefix.utf8.count))
    bindNullable(stmt, 2, prefix)
    var ids: [String] = []
    while sqlite3_step(stmt) == SQLITE_ROW {
      guard let cstr = sqlite3_column_text(stmt, 0) else { continue }
      ids.append(String(String(cString: cstr).dropFirst(prefix.count)))
    }
    return ids
  }

  // MARK: - Internal

  private func _upsert(_ item: CachedItem) {
    let sql = """
    INSERT INTO file_cache(
      id, parent_id, name_encrypted, name_decrypted, display_name,
      display_name_source_name, display_name_source_parent, mime_type, size_bytes,
      is_folder, is_pinned, has_thumbnail, thumbnail_data, thumbnail_nonce,
      created_at, updated_at, sync_anchor, is_materialized
    ) VALUES(?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    ON CONFLICT(id) DO UPDATE SET
      parent_id = excluded.parent_id,
      name_encrypted = excluded.name_encrypted,
      name_decrypted = COALESCE(excluded.name_decrypted, file_cache.name_decrypted),
      display_name = excluded.display_name,
      display_name_source_name = excluded.display_name_source_name,
      display_name_source_parent = excluded.display_name_source_parent,
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
      bindText(stmt, 1, item.id)
      bindNullable(stmt, 2, item.parentId)
      bindNullable(stmt, 3, item.nameEncrypted)
      bindNullable(stmt, 4, item.nameDecrypted)
      bindNullable(stmt, 5, item.displayName)
      bindNullable(stmt, 6, item.displayNameSourceName)
      bindNullable(stmt, 7, item.displayNameSourceParent)
      bindNullable(stmt, 8, item.mimeType)
      sqlite3_bind_int64(stmt, 9, Int64(item.sizeBytes))
      sqlite3_bind_int(stmt, 10, item.isFolder ? 1 : 0)
      sqlite3_bind_int(stmt, 11, item.isPinned ? 1 : 0)
      sqlite3_bind_int(stmt, 12, item.hasThumbnail ? 1 : 0)
      bindBlob(stmt, 13, item.thumbnailData)
      bindBlob(stmt, 14, item.thumbnailNonce)
      bindNullable(stmt, 15, item.createdAt)
      bindNullable(stmt, 16, item.updatedAt)
      sqlite3_bind_int64(stmt, 17, item.syncAnchor)
      sqlite3_bind_int(stmt, 18, item.isMaterialized ? 1 : 0)
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
        bindText(stmt, index, parent)
        index += 1
      }
      for id in ids.sorted() {
        bindText(stmt, index, id)
        index += 1
      }
    }
  }

  /// Remove namespaced descendants that can no longer be reached from their
  /// synthetic root. A root refresh is the only reliable time to learn that a
  /// trashed folder was restored or purged; without this, names cached below
  /// that folder survive indefinitely even though the folder itself is gone.
  private func _pruneNamespace(_ prefix: String, reachableFrom root: String) {
    executeBindable(
      """
      WITH RECURSIVE reachable(id) AS (
        SELECT id FROM file_cache WHERE parent_id = ?
        UNION
        SELECT child.id
          FROM file_cache AS child
          JOIN reachable AS parent ON child.parent_id = parent.id
      )
      DELETE FROM file_cache
       WHERE substr(id, 1, ?) = ?
         AND id NOT IN (SELECT id FROM reachable)
      """
    ) { stmt in
      bindText(stmt, 1, root)
      sqlite3_bind_int(stmt, 2, Int32(prefix.count))
      bindText(stmt, 3, prefix)
    }
  }

  private func _delete(id: String) {
    executeBindable("DELETE FROM file_cache WHERE id = ?") { stmt in
      bindText(stmt, 1, id)
    }
  }

  private func _item(id: String) -> CachedItem? {
    item(id: id, selectSql: rowSelectSql)
  }

  private func _legacyItem(id: String) -> CachedItem? {
    item(id: id, selectSql: legacyRowSelectSql)
  }

  private func item(id: String, selectSql: String) -> CachedItem? {
    var stmt: OpaquePointer?
    defer { sqlite3_finalize(stmt) }
    guard prepare(selectSql + " WHERE id = ?", &stmt) else { return nil }
    bindText(stmt, 1, id)
    guard sqlite3_step(stmt) == SQLITE_ROW else { return nil }
    return readRow(stmt)
  }

  private func _children(parent: String?) -> [CachedItem] {
    children(parent: parent, selectSql: rowSelectSql)
  }

  private func _legacyChildren(parent: String?) -> [CachedItem] {
    children(parent: parent, selectSql: legacyRowSelectSql)
  }

  private func children(parent: String?, selectSql: String) -> [CachedItem] {
    var stmt: OpaquePointer?
    defer { sqlite3_finalize(stmt) }
    let where_: String
    if parent == nil {
      where_ = " WHERE parent_id IS NULL"
    } else {
      where_ = " WHERE parent_id = ?"
    }
    guard prepare(selectSql + where_ + " ORDER BY is_folder DESC, name_decrypted ASC", &stmt) else {
      return []
    }
    if let parent { bindText(stmt, 1, parent) }
    var rows: [CachedItem] = []
    while sqlite3_step(stmt) == SQLITE_ROW {
      if let row = readRow(stmt) { rows.append(row) }
    }
    return rows
  }

  private func _aliasChildren(parent: String?) -> [CachedItem] {
    #if DEBUG
    aliasSiblingQueryCountForTesting += 1
    #endif
    var stmt: OpaquePointer?
    defer { sqlite3_finalize(stmt) }
    let where_: String
    if parent == nil {
      where_ = " WHERE parent_id IS NULL"
    } else {
      where_ = " WHERE parent_id = ?"
    }
    guard prepare(aliasRowSelectSql + where_, &stmt) else { return [] }
    if let parent { bindText(stmt, 1, parent) }
    var rows: [CachedItem] = []
    while sqlite3_step(stmt) == SQLITE_ROW {
      if let row = readAliasRow(stmt) { rows.append(row) }
    }
    return rows
  }

  /// Repairs aliases while rows are served, not only after a network refresh. Alias assignment
  /// reads only its small text projection; the full rows (and any thumbnail blobs) are loaded at
  /// most once afterward when an enumerator actually needs to vend all children.
  private func _resolvedDisplayNameRows(parent: String?) -> [CachedItem] {
    let initial = _aliasChildren(parent: parent)
    let initialResolved = FileProviderDisplayNames.assign(initial)
    guard displayNamesChanged(from: initial, to: initialResolved) else { return initialResolved }

    // Serialize repairs with the app process. If a purge is active or the lock cannot be acquired,
    // still vend the resolved in-memory rows; a later enumeration will retry persistence.
    guard beginImmediate() else { return initialResolved }
    let current = _aliasChildren(parent: parent)
    let resolved = FileProviderDisplayNames.assign(current)
    let currentById = Dictionary(uniqueKeysWithValues: current.map { ($0.id, $0) })
    for item in resolved {
      guard let prior = currentById[item.id],
            displayNameChanged(from: prior, to: item) else { continue }
      _updateDisplayName(item)
    }
    guard commitOrRollback() else { return resolved }
    return resolved
  }

  private func displayNamesChanged(from old: [CachedItem], to new: [CachedItem]) -> Bool {
    guard old.count == new.count else { return true }
    let oldById = Dictionary(uniqueKeysWithValues: old.map { ($0.id, $0) })
    return new.contains { item in
      guard let prior = oldById[item.id] else { return true }
      return displayNameChanged(from: prior, to: item)
    }
  }

  private func displayNameChanged(from old: CachedItem, to new: CachedItem) -> Bool {
    old.displayName != new.displayName
      || old.displayNameSourceName != new.displayNameSourceName
      || old.displayNameSourceParent != new.displayNameSourceParent
  }

  private func _updateDisplayName(_ item: CachedItem) {
    executeBindable(
      "UPDATE file_cache SET display_name = ?, display_name_source_name = ?, display_name_source_parent = ? WHERE id = ?"
    ) { stmt in
      bindNullable(stmt, 1, item.displayName)
      bindNullable(stmt, 2, item.displayNameSourceName)
      bindNullable(stmt, 3, item.displayNameSourceParent)
      bindText(stmt, 4, item.id)
    }
  }

  private func mergingDisplayName(from alias: CachedItem, into item: CachedItem) -> CachedItem? {
    guard alias.id == item.id,
          FileProviderDisplayNames.alias(alias, belongsTo: item) else { return nil }
    var merged = item
    merged.displayName = alias.displayName
    merged.displayNameSourceName = alias.displayNameSourceName
    merged.displayNameSourceParent = alias.displayNameSourceParent
    return merged
  }

  // MARK: - Row helpers

  private let rowSelectSql = """
  SELECT id, parent_id, name_encrypted, name_decrypted, display_name,
         display_name_source_name, display_name_source_parent, mime_type, size_bytes,
         is_folder, is_pinned, has_thumbnail, thumbnail_data, thumbnail_nonce,
         created_at, updated_at, sync_anchor, is_materialized
  FROM file_cache
  """

  /// Existing caches can be read while another process temporarily blocks the alias-column
  /// migration. The three NULLs keep readRow's column indexes identical; the next open retries
  /// the migration before any write is allowed.
  private let legacyRowSelectSql = """
  SELECT id, parent_id, name_encrypted, name_decrypted, NULL,
         NULL, NULL, mime_type, size_bytes,
         is_folder, is_pinned, has_thumbnail, thumbnail_data, thumbnail_nonce,
         created_at, updated_at, sync_anchor, is_materialized
  FROM file_cache
  """

  private let aliasRowSelectSql = """
  SELECT id, parent_id, name_decrypted, name_encrypted, display_name,
         display_name_source_name, display_name_source_parent, created_at
  FROM file_cache
  """

  private func readRow(_ stmt: OpaquePointer?) -> CachedItem? {
    guard let stmt, let idCstr = sqlite3_column_text(stmt, 0) else { return nil }
    return CachedItem(
      id: String(cString: idCstr),
      parentId: textColumn(stmt, 1),
      nameEncrypted: textColumn(stmt, 2),
      nameDecrypted: textColumn(stmt, 3),
      mimeType: textColumn(stmt, 7),
      sizeBytes: Int(sqlite3_column_int64(stmt, 8)),
      isFolder: sqlite3_column_int(stmt, 9) != 0,
      isPinned: sqlite3_column_int(stmt, 10) != 0,
      hasThumbnail: sqlite3_column_int(stmt, 11) != 0,
      thumbnailData: blobColumn(stmt, 12),
      thumbnailNonce: blobColumn(stmt, 13),
      createdAt: textColumn(stmt, 14),
      updatedAt: textColumn(stmt, 15),
      syncAnchor: sqlite3_column_int64(stmt, 16),
      isMaterialized: sqlite3_column_int(stmt, 17) != 0,
      displayName: textColumn(stmt, 4),
      displayNameSourceName: textColumn(stmt, 5),
      displayNameSourceParent: textColumn(stmt, 6)
    )
  }

  private func readAliasRow(_ stmt: OpaquePointer?) -> CachedItem? {
    guard let stmt, let idCstr = sqlite3_column_text(stmt, 0) else { return nil }
    return CachedItem(
      id: String(cString: idCstr),
      parentId: textColumn(stmt, 1),
      nameEncrypted: textColumn(stmt, 3),
      nameDecrypted: textColumn(stmt, 2),
      mimeType: nil,
      sizeBytes: 0,
      isFolder: false,
      isPinned: false,
      hasThumbnail: false,
      thumbnailData: nil,
      thumbnailNonce: nil,
      createdAt: textColumn(stmt, 7),
      updatedAt: nil,
      syncAnchor: 0,
      isMaterialized: false,
      displayName: textColumn(stmt, 4),
      displayNameSourceName: textColumn(stmt, 5),
      displayNameSourceParent: textColumn(stmt, 6)
    )
  }

  private func ensureColumn(table: String, column: String, definition: String) -> Bool {
    if hasColumn(table: table, column: column) { return true }
    _ = execute("ALTER TABLE \(table) ADD COLUMN \(column) \(definition)")
    // Re-check even after ALTER failed: another process may have won the same migration.
    return hasColumn(table: table, column: column)
  }

  private func hasColumn(table: String, column: String) -> Bool {
    var stmt: OpaquePointer?
    defer { sqlite3_finalize(stmt) }
    guard prepare("PRAGMA table_info(\(table))", &stmt) else { return false }
    while sqlite3_step(stmt) == SQLITE_ROW {
      if textColumn(stmt, 1) == column { return true }
    }
    return false
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

  /// Binds text with SQLITE_TRANSIENT so SQLite copies the bytes; a nil
  /// destructor (SQLITE_STATIC) would keep a pointer into a temporary
  /// bridged NSString that can be freed before sqlite3_step (task 2038).
  private func bindText(_ stmt: OpaquePointer?, _ index: Int32, _ value: String) {
    let transient = unsafeBitCast(-1, to: sqlite3_destructor_type.self)
    sqlite3_bind_text(stmt, index, value, -1, transient)
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
  /// Stable File Provider-only alias used when the server permits duplicate sibling names.
  /// Never encrypted or sent to the server.
  var displayName: String? = nil
  /// The visible base name and parent from which `displayName` was derived. Root is encoded as
  /// an empty parent string so nil remains an unambiguous legacy/invalid provenance marker.
  var displayNameSourceName: String? = nil
  var displayNameSourceParent: String? = nil
}

/// File Provider requires sibling filenames to be unique even though the server permits
/// duplicates. An alias is reusable only while both its real base name and parent match the
/// provenance stored with it; app-side renames and moves therefore cannot carry an old alias
/// into a new listing. New aliases are assigned by stable created-at/id order.
enum FileProviderDisplayNames {
  static func hasValidAlias(_ item: CachedItem) -> Bool {
    guard let displayName = item.displayName, !displayName.isEmpty else { return false }
    return item.displayNameSourceName == visibleBaseName(item)
      && item.displayNameSourceParent == (item.parentId ?? "")
  }

  static func alias(_ alias: CachedItem, belongsTo item: CachedItem) -> Bool {
    hasValidAlias(alias)
      && alias.displayNameSourceName == visibleBaseName(item)
      && alias.displayNameSourceParent == (item.parentId ?? "")
  }

  static func assign(_ rows: [CachedItem]) -> [CachedItem] {
    var result = rows
    let order = result.indices.sorted { left, right in
      let lhs = (result[left].createdAt ?? "", result[left].id)
      let rhs = (result[right].createdAt ?? "", result[right].id)
      return lhs < rhs
    }
    var used = Set<String>()
    var assigned = Set<Int>()

    for index in order {
      guard hasValidAlias(result[index]), let displayName = result[index].displayName else { continue }
      let key = normalized(displayName)
      guard used.insert(key).inserted else { continue }
      assigned.insert(index)
    }

    for index in order where !assigned.contains(index) {
      let base = visibleBaseName(result[index])
      var candidate = base
      var suffix = 2
      while used.contains(normalized(candidate)) {
        candidate = suffixed(base, suffix: suffix)
        suffix += 1
      }
      result[index].displayName = candidate
      result[index].displayNameSourceName = base
      result[index].displayNameSourceParent = result[index].parentId ?? ""
      used.insert(normalized(candidate))
    }
    return result
  }

  static func unresolvedNameLabel(id: String) -> String {
    "Encrypted item · \(id.prefix(8))"
  }

  private static func visibleBaseName(_ item: CachedItem) -> String {
    if let name = item.nameDecrypted, !name.isEmpty { return name }
    if let raw = item.nameEncrypted, !raw.isEmpty, raw.utf8.first != 123 { return raw }
    return unresolvedNameLabel(id: item.id)
  }

  private static func normalized(_ name: String) -> String {
    name.precomposedStringWithCanonicalMapping.folding(
      options: [.caseInsensitive, .diacriticInsensitive, .widthInsensitive],
      locale: Locale(identifier: "en_US_POSIX")
    )
  }

  private static func suffixed(_ base: String, suffix: Int) -> String {
    let path = base as NSString
    let ext = path.pathExtension
    guard !ext.isEmpty else { return "\(base) (\(suffix))" }
    return "\(path.deletingPathExtension) (\(suffix)).\(ext)"
  }
}
