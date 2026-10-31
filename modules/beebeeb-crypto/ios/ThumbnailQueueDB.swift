import Foundation
import SQLite3

/// SQLite-backed persistent queue for thumbnail regeneration work.
/// Survives app restarts. Cleared on sign-out. Single writer (`ThumbnailWorkerPool`),
/// multiple readers safe — all access is serialized through a private queue.
///
/// Task 1962 round 4 (Bug 7) — the connection is opened LAZILY, inside
/// `serialQueue`, on first use; `init()` never touches the file. Sign-out
/// (manual or forced) resets it through `prepareForStoragePurge()`, which the
/// registry sweep is then told to preserve (`.sqlite`, `-wal`, `-shm`): the DB
/// owns those three files' lifecycle, so the purge never unlinks a file under
/// this class's live handle.
public final class ThumbnailQueueDB {
    public static let shared = ThumbnailQueueDB(directory: nil)

    private var db: OpaquePointer?
    private let serialQueue = DispatchQueue(label: "io.beebeeb.thumbnail.queue-db")
    /// Task LD-0002: every statement asks this gate first. While background
    /// time has ended nothing runs; the rows stay as they are.
    private let gate: BackupExecutionGate
    /// LD-0002 (B4): published after the open, withdrawn before every close.
    private let interruptTarget = SQLiteInterruptTarget { sqlite3_interrupt($0) }
    /// LD-0002 (B7): the gate's `closures` when `running` rows were last
    /// reset. `serialQueue` only.
    private var runningResetAtClosures: UInt64?
    /// `nil` = the app's Documents directory. The harness passes a temp
    /// directory; production never does.
    private let directoryOverride: URL?
    /// Test seam: the purge harness injects an unlink that always throws, so
    /// the failure-reporting path is exercised deterministically (permission
    /// tricks are not portable to a root CI container).
    var removeFile: (URL) throws -> Void = { try FileManager.default.removeItem(at: $0) }

    init(directory: URL?, gate: BackupExecutionGate = .shared) {
        // Task 1962 round 4 (7a) — never open here. Opening happens only in
        // `ensureOpen()`, called inside `serialQueue`, so a sign-out's
        // `prepareForStoragePurge()` can never race an open.
        self.directoryOverride = directory
        self.gate = gate
    }

    deinit {
        interruptTarget.withdraw()
        if let db { sqlite3_close_v2(db) }
    }

    // MARK: - Background quiesce (task LD-0002)

    /// Aborts the statement running on this connection. Safe from any thread.
    public func interruptInFlightStatement() {
        interruptTarget.interrupt()
    }

    /// Waits (bounded) for the current `serialQueue` block to exit. Never call
    /// it from `serialQueue`.
    public func waitForQuiet(timeout: TimeInterval) -> Bool {
        BackupSQLiteQuiesce.waitForSerialQueue(serialQueue, timeout: timeout)
    }

    /// Inside `serialQueue`: the gate is open and the connection usable. On
    /// the first use after an open or after an expiry closed the gate, rows a
    /// worker claimed (`running`) and could not finish go back to `pending`
    /// (B7): a closed gate refuses a worker's result write, and nothing else
    /// ever moved those rows again. A worker still running then may do its
    /// item twice; that is the price of never losing one.
    private func admitted() -> Bool {
        guard gate.canStartSQLiteWork, ensureOpen() else { return false }
        let closures = gate.closures
        if runningResetAtClosures != closures {
            guard bindAndStep("UPDATE queue_items SET state='pending' WHERE state='running';", []) == SQLITE_DONE else {
                return false
            }
            runningResetAtClosures = closures
        }
        return true
    }

    // MARK: - Schema

    private var dbURL: URL {
        if let directoryOverride {
            return directoryOverride.appendingPathComponent("thumbnail_queue.sqlite")
        }
        let dir = FileManager.default.urls(for: .documentDirectory, in: .userDomainMask)[0]
        return dir.appendingPathComponent("thumbnail_queue.sqlite")
    }

    /// The three files this database owns. The sign-out purge must receive
    /// them in `preserving` (task 1962 round 4, 7b/7g): unlinking any of them
    /// under a live connection leaves this process writing to a deleted inode.
    public var purgePaths: Set<String> {
        let path = dbURL.path
        return [path, path + "-wal", path + "-shm"]
    }

    public static func storagePurgePaths() -> Set<String> {
        shared.purgePaths
    }

    /// Opens the connection if it is not open yet. Must be called inside
    /// `serialQueue`. Returns `false` (and leaves `db == nil`) on any failure;
    /// every method then does nothing and returns its empty value.
    private func ensureOpen() -> Bool {
        if db != nil { return true }
        var handle: OpaquePointer?
        guard sqlite3_open(dbURL.path, &handle) == SQLITE_OK, let handle else {
            NSLog("[ThumbnailQueueDB] failed to open \(dbURL.path)")
            if let handle { sqlite3_close_v2(handle) }
            db = nil
            return false
        }
        db = handle
        runningResetAtClosures = nil
        // Task 1962 round 4 (7a/7c): secure_delete zeroes deleted cells so the
        // purge's DELETE leaves none of the outgoing account's ids in the file.
        let configured = exec("PRAGMA journal_mode = WAL;")
            && exec("PRAGMA secure_delete = ON;")
            && exec("""
                CREATE TABLE IF NOT EXISTS queue_items (
                    file_id          TEXT PRIMARY KEY,
                    quality_preset   TEXT NOT NULL,
                    state            TEXT NOT NULL,
                    attempts         INTEGER NOT NULL DEFAULT 0,
                    next_attempt_at  INTEGER,
                    last_error_code  TEXT,
                    last_error_msg   TEXT,
                    enqueued_at      INTEGER NOT NULL,
                    updated_at       INTEGER NOT NULL
                );
            """)
            && exec("CREATE INDEX IF NOT EXISTS idx_queue_state_next ON queue_items(state, next_attempt_at);")
        if !configured {
            db = nil
            sqlite3_close_v2(handle)
            return false
        }
        interruptTarget.publish(handle)
        // Task 1962 round 5 (P2.5) — these three files are created lazily by
        // this open (and recreated after a failed reset), long after the launch
        // hardening pass. Exclude them from iCloud backup now, not at the next
        // cold launch's `hardenAll()`.
        PlaintextStorageProtection.protect(dbURL)
        _ = PlaintextStorageProtection.protectSQLiteSidecars(dbURL)
        return true
    }

    @discardableResult
    private func exec(_ sql: String) -> Bool {
        guard let db else { return false }
        var err: UnsafeMutablePointer<Int8>?
        let rc = sqlite3_exec(db, sql, nil, nil, &err)
        if rc != SQLITE_OK {
            // Task 1962 round 4 (7a) — never force-unwrap `err`: SQLite may
            // report a failure without populating it.
            let message = err.map { String(cString: $0) } ?? "code \(rc)"
            NSLog("[ThumbnailQueueDB] exec failed: \(message)")
            if let err { sqlite3_free(err) }
            return false
        }
        if let err { sqlite3_free(err) }
        return true
    }

    // MARK: - Storage purge (task 1962 round 4, 7c-7e)

    /// Called from `purgePlaintextStorage` on EVERY sign-out path, before the
    /// registry sweep, after `ThumbnailWorkerPool.cancelAll()`.
    @discardableResult
    public static func prepareForStoragePurge() -> Int {
        shared.performPrepareForStoragePurge(forceResetFailure: false)
    }

    /// The whole reset is ONE `serialQueue` block: no other open/statement can
    /// interleave. `forceResetFailure` is the harness's injected reset failure
    /// (7d); production always passes `false`.
    @discardableResult
    func performPrepareForStoragePurge(forceResetFailure: Bool) -> Int {
        serialQueue.sync {
            // 7e — no connection: nothing can open it meanwhile (opening only
            // happens on `serialQueue`), so the files are simply unlinked.
            guard let handle = db else {
                return removeDatabaseFiles()
            }
            // 7c — DELETE + TRUNCATE checkpoint; success requires both to
            // return OK, the checkpoint to report busy = 0, and 0 rows left.
            // The connection stays open in that case.
            let deleted = !forceResetFailure && exec("DELETE FROM queue_items;")
            let busy = deleted ? checkpointTruncate(handle) : -1
            let remaining = (deleted && busy == 0) ? queueRowCount(handle) : -1
            // Task 1962 round 5 (P2.4) — DELETE + TRUNCATE leaves freed pages
            // from older (non-secure-delete) builds on the freelist. They can
            // still hold the outgoing account's bytes, so a reset that leaves
            // any of them behind is not a successful in-place reset.
            let free = (deleted && busy == 0 && remaining == 0) ? freelistCount(handle) : -1
            if deleted, busy == 0, remaining == 0, free == 0 { return 0 }
            // 7d — reset failed: close BEFORE unlinking, then unlink all
            // three. The next use reopens lazily (7a). LD-0002 (B4): the
            // interrupt target is withdrawn before the close.
            interruptTarget.withdraw()
            db = nil
            sqlite3_close_v2(handle)
            return removeDatabaseFiles()
        }
    }

    private func checkpointTruncate(_ handle: OpaquePointer) -> Int {
        var stmt: OpaquePointer?
        let sql = "PRAGMA wal_checkpoint(TRUNCATE);"
        guard sqlite3_prepare_v2(handle, sql, -1, &stmt, nil) == SQLITE_OK else { return -1 }
        defer { sqlite3_finalize(stmt) }
        guard sqlite3_step(stmt) == SQLITE_ROW else { return -1 }
        // Column 0 is `busy` (0 = the checkpoint completed).
        return Int(sqlite3_column_int(stmt, 0))
    }

    private func freelistCount(_ handle: OpaquePointer) -> Int {
        var stmt: OpaquePointer?
        guard sqlite3_prepare_v2(handle, "PRAGMA freelist_count;", -1, &stmt, nil) == SQLITE_OK else {
            return -1
        }
        defer { sqlite3_finalize(stmt) }
        guard sqlite3_step(stmt) == SQLITE_ROW else { return -1 }
        return Int(sqlite3_column_int64(stmt, 0))
    }

    private func queueRowCount(_ handle: OpaquePointer) -> Int {
        var stmt: OpaquePointer?
        guard sqlite3_prepare_v2(handle, "SELECT count(*) FROM queue_items;", -1, &stmt, nil) == SQLITE_OK else {
            return -1
        }
        defer { sqlite3_finalize(stmt) }
        guard sqlite3_step(stmt) == SQLITE_ROW else { return -1 }
        return Int(sqlite3_column_int64(stmt, 0))
    }

    /// Unlinks the three files this database owns. Returns the number that
    /// could NOT be removed: round 4 swallowed unlink errors with `try?` and
    /// reported the reset as a success, so `purgePlaintextStorage`'s `failed`
    /// count never saw them (task 1962 round 5, P2.3).
    private func removeDatabaseFiles() -> Int {
        let path = dbURL.path
        var failures = 0
        for suffix in ["", "-wal", "-shm"] {
            let url = URL(fileURLWithPath: path + suffix)
            guard FileManager.default.fileExists(atPath: url.path) else { continue }
            do {
                try removeFile(url)
            } catch {
                failures += 1
                RuntimeTrace.event("thumbnail.queue.unlink_failed", [
                    "file": url.lastPathComponent,
                ])
                NSLog("[ThumbnailQueueDB] failed to unlink \(url.path): \(error)")
            }
        }
        return failures
    }

    // MARK: - Types

    public enum ItemState: String {
        case pending, running, succeeded, failed_retry, failed_perm
    }

    public struct Item {
        public let fileId: String
        public let qualityPreset: String
        public let state: ItemState
        public let attempts: Int
        public let nextAttemptAt: Int64?
        public let lastErrorCode: String?
        public let lastErrorMsg: String?
    }

    // MARK: - Writes

    /// Insert OR ignore (existing entries preserved with original quality).
    /// LD-0002 (B5): one transaction, and the first step that does not finish
    /// (an expiry's interrupt) rolls the whole batch back. Before, the rest of
    /// the batch autocommitted after the interrupt had ended the transaction.
    public func enqueue(fileIds: [String], qualityPreset: String) {
        serialQueue.sync {
            guard admitted() else { return }
            let now = Int64(Date().timeIntervalSince1970 * 1000)
            guard exec("BEGIN IMMEDIATE;") else { return }
            for id in fileIds {
                let sql = """
                    INSERT OR IGNORE INTO queue_items
                        (file_id, quality_preset, state, attempts, next_attempt_at, enqueued_at, updated_at)
                    VALUES (?, ?, 'pending', 0, ?, ?, ?);
                """
                guard bindAndStep(sql, [id, qualityPreset, now, now, now]) == SQLITE_DONE else {
                    exec("ROLLBACK;")
                    return
                }
            }
            if !exec("COMMIT;") { exec("ROLLBACK;") }
        }
    }

    public func markRunning(fileId: String) {
        mutate("UPDATE queue_items SET state='running', updated_at=? WHERE file_id=?",
               [Int64(Date().timeIntervalSince1970 * 1000), fileId])
    }

    public func markSucceeded(fileId: String) {
        mutate("UPDATE queue_items SET state='succeeded', updated_at=? WHERE file_id=?",
               [Int64(Date().timeIntervalSince1970 * 1000), fileId])
    }

    /// Bump attempt counter, set backoff or mark perm-fail.
    public func recordFailure(fileId: String, category: ThumbnailErrorCategory, message: String) {
        serialQueue.sync {
            guard admitted() else { return }
            guard let item = fetchInternal(fileId: fileId) else { return }
            let nextAttempts = item.attempts + 1
            let now = Int64(Date().timeIntervalSince1970 * 1000)
            if nextAttempts >= 3 || !category.isRetriable {
                bindAndStep("""
                    UPDATE queue_items
                       SET state='failed_perm', attempts=?, last_error_code=?, last_error_msg=?, updated_at=?
                     WHERE file_id=?;
                """, [nextAttempts, category.rawValue, message, now, fileId])
                return
            }
            let backoffMs: Int64 = nextAttempts == 1 ? 2_000 : (nextAttempts == 2 ? 8_000 : 32_000)
            let nextAt = now + backoffMs
            bindAndStep("""
                UPDATE queue_items
                   SET state='failed_retry', attempts=?, next_attempt_at=?, last_error_code=?, last_error_msg=?, updated_at=?
                 WHERE file_id=?;
            """, [nextAttempts, nextAt, category.rawValue, message, now, fileId])
        }
    }

    /// Move a failed_perm file back into the queue at high priority.
    public func retry(fileId: String) {
        let now = Int64(Date().timeIntervalSince1970 * 1000)
        mutate("UPDATE queue_items SET state='pending', attempts=0, next_attempt_at=?, last_error_code=NULL, last_error_msg=NULL, updated_at=? WHERE file_id=?",
               [now, now, fileId])
    }

    public func clearAll() {
        mutate("DELETE FROM queue_items;", [])
    }

    // MARK: - Reads

    /// Pop next ready batch (state='pending' OR (state='failed_retry' AND next_attempt_at <= now)).
    /// LD-0002 (B5): the claim is one transaction. A read or a claim that does
    /// not finish (an expiry's interrupt) returns nothing and claims nothing;
    /// before, the items whose claim UPDATE was interrupted were handed out
    /// while still `pending`.
    public func popReady(limit: Int) -> [Item] {
        var out: [Item] = []
        serialQueue.sync {
            guard admitted() else { return }
            let now = Int64(Date().timeIntervalSince1970 * 1000)
            var stmt: OpaquePointer?
            let sql = """
                SELECT file_id, quality_preset, state, attempts, next_attempt_at, last_error_code, last_error_msg
                FROM queue_items
                WHERE state='pending' OR (state='failed_retry' AND next_attempt_at <= ?)
                ORDER BY enqueued_at ASC
                LIMIT ?;
            """
            guard sqlite3_prepare_v2(db, sql, -1, &stmt, nil) == SQLITE_OK else { return }
            defer { sqlite3_finalize(stmt) }
            sqlite3_bind_int64(stmt, 1, now)
            sqlite3_bind_int(stmt, 2, Int32(limit))
            var rc = sqlite3_step(stmt)
            while rc == SQLITE_ROW {
                out.append(itemFromRow(stmt!))
                rc = sqlite3_step(stmt)
            }
            guard rc == SQLITE_DONE, !out.isEmpty else {
                out = []
                return
            }
            // Atomically mark them running so concurrent pops don't double-claim
            guard exec("BEGIN IMMEDIATE;") else {
                out = []
                return
            }
            for item in out {
                let claimed = bindAndStep("UPDATE queue_items SET state='running', updated_at=? WHERE file_id=?",
                                          [Int64(Date().timeIntervalSince1970 * 1000), item.fileId])
                guard claimed == SQLITE_DONE else {
                    exec("ROLLBACK;")
                    out = []
                    return
                }
            }
            if !exec("COMMIT;") {
                exec("ROLLBACK;")
                out = []
            }
        }
        return out
    }

    public func stats() -> (pending: Int, running: Int, succeeded: Int, failedRetry: Int, failedPerm: Int) {
        var result: (Int, Int, Int, Int, Int) = (0, 0, 0, 0, 0)
        serialQueue.sync {
            guard admitted() else { return }
            var stmt: OpaquePointer?
            let sql = "SELECT state, COUNT(*) FROM queue_items GROUP BY state;"
            guard sqlite3_prepare_v2(db, sql, -1, &stmt, nil) == SQLITE_OK else { return }
            defer { sqlite3_finalize(stmt) }
            while sqlite3_step(stmt) == SQLITE_ROW {
                let state = String(cString: sqlite3_column_text(stmt, 0))
                let n = Int(sqlite3_column_int(stmt, 1))
                switch state {
                case "pending":      result.0 = n
                case "running":      result.1 = n
                case "succeeded":    result.2 = n
                case "failed_retry": result.3 = n
                case "failed_perm":  result.4 = n
                default: break
                }
            }
        }
        return result
    }

    public func failedPermFileIds() -> [String] {
        var ids: [String] = []
        serialQueue.sync {
            guard admitted() else { return }
            var stmt: OpaquePointer?
            let sql = "SELECT file_id FROM queue_items WHERE state='failed_perm' ORDER BY updated_at DESC LIMIT 200;"
            guard sqlite3_prepare_v2(db, sql, -1, &stmt, nil) == SQLITE_OK else { return }
            defer { sqlite3_finalize(stmt) }
            while sqlite3_step(stmt) == SQLITE_ROW {
                ids.append(String(cString: sqlite3_column_text(stmt, 0)))
            }
        }
        return ids
    }

    // MARK: - Helpers

    private func mutate(_ sql: String, _ args: [Any]) {
        serialQueue.sync {
            guard admitted() else { return }
            bindAndStep(sql, args)
        }
    }

    private func fetchInternal(fileId: String) -> Item? {
        var stmt: OpaquePointer?
        let sql = "SELECT file_id, quality_preset, state, attempts, next_attempt_at, last_error_code, last_error_msg FROM queue_items WHERE file_id=?;"
        guard sqlite3_prepare_v2(db, sql, -1, &stmt, nil) == SQLITE_OK else { return nil }
        defer { sqlite3_finalize(stmt) }
        sqlite3_bind_text(stmt, 1, fileId, -1, unsafeBitCast(-1, to: sqlite3_destructor_type.self))
        if sqlite3_step(stmt) == SQLITE_ROW {
            return itemFromRow(stmt!)
        }
        return nil
    }

    private func itemFromRow(_ stmt: OpaquePointer) -> Item {
        let fileId = String(cString: sqlite3_column_text(stmt, 0))
        let preset = String(cString: sqlite3_column_text(stmt, 1))
        let stateStr = String(cString: sqlite3_column_text(stmt, 2))
        let attempts = Int(sqlite3_column_int(stmt, 3))
        let nextAt: Int64? = sqlite3_column_type(stmt, 4) == SQLITE_NULL ? nil : sqlite3_column_int64(stmt, 4)
        let errCode = sqlite3_column_type(stmt, 5) == SQLITE_NULL ? nil : String(cString: sqlite3_column_text(stmt, 5))
        let errMsg  = sqlite3_column_type(stmt, 6) == SQLITE_NULL ? nil : String(cString: sqlite3_column_text(stmt, 6))
        return Item(
            fileId: fileId, qualityPreset: preset,
            state: ItemState(rawValue: stateStr) ?? .pending,
            attempts: attempts, nextAttemptAt: nextAt,
            lastErrorCode: errCode, lastErrorMsg: errMsg
        )
    }

    /// The step's result code (`SQLITE_DONE` = it finished).
    @discardableResult
    private func bindAndStep(_ sql: String, _ args: [Any]) -> Int32 {
        guard let db else { return SQLITE_MISUSE }
        var stmt: OpaquePointer?
        let prepared = sqlite3_prepare_v2(db, sql, -1, &stmt, nil)
        guard prepared == SQLITE_OK else { return prepared }
        defer { sqlite3_finalize(stmt) }
        let SQLITE_TRANSIENT = unsafeBitCast(-1, to: sqlite3_destructor_type.self)
        for (i, arg) in args.enumerated() {
            let idx = Int32(i + 1)
            if let s = arg as? String  { sqlite3_bind_text(stmt, idx, s, -1, SQLITE_TRANSIENT) }
            else if let n = arg as? Int64 { sqlite3_bind_int64(stmt, idx, n) }
            else if let n = arg as? Int   { sqlite3_bind_int64(stmt, idx, Int64(n)) }
            else { sqlite3_bind_null(stmt, idx) }
        }
        return sqlite3_step(stmt)
    }
}
