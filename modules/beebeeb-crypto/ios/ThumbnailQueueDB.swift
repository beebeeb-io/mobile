import Foundation
import SQLite3

/// SQLite-backed persistent queue for thumbnail regeneration work.
/// Survives app restarts. Cleared on sign-out. Single writer (`ThumbnailWorkerPool`),
/// multiple readers safe — all access is serialized through a private queue.
public final class ThumbnailQueueDB {
    public static let shared = ThumbnailQueueDB()

    private var db: OpaquePointer?
    private let serialQueue = DispatchQueue(label: "io.beebeeb.thumbnail.queue-db")

    private init() {
        openOrCreate()
    }

    deinit {
        if let db { sqlite3_close(db) }
    }

    // MARK: - Schema

    private var dbURL: URL {
        let dir = FileManager.default.urls(for: .documentDirectory, in: .userDomainMask)[0]
        return dir.appendingPathComponent("thumbnail_queue.sqlite")
    }

    private func openOrCreate() {
        guard sqlite3_open(dbURL.path, &db) == SQLITE_OK else {
            NSLog("[ThumbnailQueueDB] failed to open \(dbURL.path)")
            return
        }
        exec("PRAGMA journal_mode = WAL;")
        exec("""
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
        exec("CREATE INDEX IF NOT EXISTS idx_queue_state_next ON queue_items(state, next_attempt_at);")
    }

    private func exec(_ sql: String) {
        var err: UnsafeMutablePointer<Int8>?
        if sqlite3_exec(db, sql, nil, nil, &err) != SQLITE_OK {
            NSLog("[ThumbnailQueueDB] exec failed: \(String(cString: err!))")
            sqlite3_free(err)
        }
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
    public func enqueue(fileIds: [String], qualityPreset: String) {
        serialQueue.sync {
            let now = Int64(Date().timeIntervalSince1970 * 1000)
            exec("BEGIN;")
            for id in fileIds {
                let sql = """
                    INSERT OR IGNORE INTO queue_items
                        (file_id, quality_preset, state, attempts, next_attempt_at, enqueued_at, updated_at)
                    VALUES (?, ?, 'pending', 0, ?, ?, ?);
                """
                bindAndStep(sql, [id, qualityPreset, now, now, now])
            }
            exec("COMMIT;")
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
    public func popReady(limit: Int) -> [Item] {
        var out: [Item] = []
        serialQueue.sync {
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
            while sqlite3_step(stmt) == SQLITE_ROW {
                out.append(itemFromRow(stmt!))
            }
            // Atomically mark them running so concurrent pops don't double-claim
            for item in out {
                bindAndStep("UPDATE queue_items SET state='running', updated_at=? WHERE file_id=?",
                            [Int64(Date().timeIntervalSince1970 * 1000), item.fileId])
            }
        }
        return out
    }

    public func stats() -> (pending: Int, running: Int, succeeded: Int, failedRetry: Int, failedPerm: Int) {
        var result: (Int, Int, Int, Int, Int) = (0, 0, 0, 0, 0)
        serialQueue.sync {
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
        serialQueue.sync { bindAndStep(sql, args) }
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

    private func bindAndStep(_ sql: String, _ args: [Any]) {
        var stmt: OpaquePointer?
        guard sqlite3_prepare_v2(db, sql, -1, &stmt, nil) == SQLITE_OK else { return }
        defer { sqlite3_finalize(stmt) }
        let SQLITE_TRANSIENT = unsafeBitCast(-1, to: sqlite3_destructor_type.self)
        for (i, arg) in args.enumerated() {
            let idx = Int32(i + 1)
            if let s = arg as? String  { sqlite3_bind_text(stmt, idx, s, -1, SQLITE_TRANSIENT) }
            else if let n = arg as? Int64 { sqlite3_bind_int64(stmt, idx, n) }
            else if let n = arg as? Int   { sqlite3_bind_int64(stmt, idx, Int64(n)) }
            else { sqlite3_bind_null(stmt, idx) }
        }
        _ = sqlite3_step(stmt)
    }
}
