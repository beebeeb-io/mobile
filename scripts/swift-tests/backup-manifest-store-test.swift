import Darwin
import Foundation
import SQLite3

// Task 1667 — standalone swiftc test for the account-scoped camera-roll backup
// manifest. Compiled with the REAL shipped sources
// (modules/beebeeb-crypto/ios/BackupManifestStore.swift,
// PlaintextStorageProtection.swift, RuntimeTrace.swift) by
// scripts/swift-ci/run-swift-tests.sh.
//
// What it proves, against a real SQLite file with two open connections
// (A = the native engine's handle, B = the JS layer's expo-sqlite handle):
//   1. The sign-out reset empties the manifest THROUGH the open handles and the
//      purge keeps the file: after it, a fresh connection sees what A and B
//      write (same inode), and lsof shows no fd on a path that is gone or a
//      different inode. The old shape (unlink under the handles) is run too, so
//      the detector is shown to go red on exactly the sim's finding.
//   2. Rows carry their owning account: legacy rows are adopted, another
//      account's rows are re-queued, staged rows are left alone.
//   3. An empty manifest is rebuilt from the server's per-device map; only
//      not-uploaded, not-staged rows are promoted; nothing is deleted.
//
// It never calls PlaintextStorageProtection.purgeAll() or registry(): those
// resolve this Mac's real ~/Documents. Only `removeItem(at:preserving:)` runs,
// against a temp directory.

var failures: [String] = []
var total = 0

func expect(_ condition: Bool, _ label: String) {
  total += 1
  if !condition { failures.append(label) }
}

let fm = FileManager.default
let root = fm.temporaryDirectory.appendingPathComponent("bb-1667-\(UUID().uuidString)", isDirectory: true)
let sqliteDir = root.appendingPathComponent("SQLite", isDirectory: true)
try! fm.createDirectory(at: sqliteDir, withIntermediateDirectories: true)
defer { try? fm.removeItem(at: root) }
let dbPath = sqliteDir.appendingPathComponent("beebeeb-backup.db").path

// The engine's schema (NativeBackupEngine.ensureTables) — every column the
// store's statements touch.
let schema = """
CREATE TABLE IF NOT EXISTS backup_assets (
  local_asset_id TEXT PRIMARY KEY,
  remote_file_id TEXT,
  remote_path TEXT,
  content_hash TEXT NOT NULL DEFAULT '',
  file_size INTEGER NOT NULL DEFAULT 0,
  created_at TEXT NOT NULL,
  uploaded_at TEXT,
  asset_type TEXT NOT NULL,
  status TEXT NOT NULL,
  queued_at INTEGER,
  last_attempt_at INTEGER,
  retry_count INTEGER DEFAULT 0,
  error_message TEXT,
  staged_file_id TEXT,
  staged_name_encrypted TEXT,
  staged_mime_type TEXT,
  staged_is_media INTEGER DEFAULT 0,
  staged_original_size INTEGER DEFAULT 0,
  staged_chunk_count INTEGER DEFAULT 0,
  staged_dir TEXT,
  staged_at INTEGER,
  upload_session_id TEXT,
  selected_for_backup INTEGER DEFAULT 1,
  staged_account_id TEXT
);
CREATE TABLE IF NOT EXISTS backup_upload_chunks (
  local_asset_id TEXT NOT NULL,
  server_file_id TEXT NOT NULL,
  chunk_index INTEGER NOT NULL,
  path TEXT NOT NULL,
  status TEXT NOT NULL,
  task_id INTEGER,
  last_error TEXT,
  uploaded_at INTEGER,
  PRIMARY KEY(local_asset_id, chunk_index)
);
"""

func open(_ path: String) -> OpaquePointer {
  var db: OpaquePointer?
  let flags = SQLITE_OPEN_READWRITE | SQLITE_OPEN_CREATE | SQLITE_OPEN_FULLMUTEX
  precondition(sqlite3_open_v2(path, &db, flags, nil) == SQLITE_OK, "open \(path)")
  sqlite3_exec(db, "PRAGMA journal_mode = WAL", nil, nil, nil)
  return db!
}

func exec(_ db: OpaquePointer, _ sql: String) {
  var err: UnsafeMutablePointer<CChar>?
  if sqlite3_exec(db, sql, nil, nil, &err) != SQLITE_OK {
    let msg = err.map { String(cString: $0) } ?? "?"
    sqlite3_free(err)
    fatalError("SQL failed: \(msg)\n\(sql)")
  }
}

func scalar(_ db: OpaquePointer, _ sql: String) -> Int {
  var stmt: OpaquePointer?
  guard sqlite3_prepare_v2(db, sql, -1, &stmt, nil) == SQLITE_OK else { return -1 }
  defer { sqlite3_finalize(stmt) }
  guard sqlite3_step(stmt) == SQLITE_ROW else { return -1 }
  return Int(sqlite3_column_int64(stmt, 0))
}

func text(_ db: OpaquePointer, _ sql: String) -> String? {
  var stmt: OpaquePointer?
  guard sqlite3_prepare_v2(db, sql, -1, &stmt, nil) == SQLITE_OK else { return nil }
  defer { sqlite3_finalize(stmt) }
  guard sqlite3_step(stmt) == SQLITE_ROW, let c = sqlite3_column_text(stmt, 0) else { return nil }
  return String(cString: c)
}

func insert(_ db: OpaquePointer, _ id: String, status: String, remote: String? = nil,
            owner: String? = nil, staged: String? = nil) {
  let r = remote.map { "'\($0)'" } ?? "NULL"
  let o = owner.map { "'\($0)'" } ?? "NULL"
  let s = staged.map { "'\($0)'" } ?? "NULL"
  exec(db, """
  INSERT INTO backup_assets (local_asset_id, remote_file_id, created_at, asset_type, status,
                             uploaded_account_id, staged_file_id, uploaded_at)
  VALUES ('\(id)', \(r), '2026-10-18T00:00:00Z', 'photo', '\(status)', \(o), \(s),
          \(status == "uploaded" ? "'2026-10-18T00:00:00Z'" : "NULL"))
  """)
}

/// (inode, path) of every fd this process holds whose path mentions `needle`,
/// from `lsof -p <pid> -Fin` — the same check the simulator rung runs on the app.
func lsofEntries(containing needle: String) -> [(inode: UInt64, path: String)] {
  let p = Process()
  p.executableURL = URL(fileURLWithPath: "/usr/sbin/lsof")
  p.arguments = ["-n", "-P", "-p", String(getpid()), "-Fin"]
  let pipe = Pipe()
  p.standardOutput = pipe
  p.standardError = FileHandle.nullDevice
  try? p.run()
  let data = pipe.fileHandleForReading.readDataToEndOfFile()
  p.waitUntilExit()
  var out: [(UInt64, String)] = []
  var inode: UInt64?
  for line in String(decoding: data, as: UTF8.self).split(separator: "\n") {
    if line.hasPrefix("f") { inode = nil }
    if line.hasPrefix("i") { inode = UInt64(line.dropFirst()) }
    if line.hasPrefix("n"), line.contains(needle), let i = inode { out.append((i, String(line.dropFirst()))) }
  }
  return out
}

/// fds whose path is gone from disk or now names a different inode: a
/// connection writing to a deleted file.
func orphanedFds(containing needle: String) -> (checked: Int, orphaned: [String]) {
  let entries = lsofEntries(containing: needle)
  var orphaned: [String] = []
  for e in entries {
    var st = stat()
    if stat(e.path, &st) != 0 || UInt64(st.st_ino) != e.inode {
      orphaned.append("\(e.path) (fd inode \(e.inode))")
    }
  }
  return (entries.count, orphaned)
}

// MARK: - 1. Sign-out reset keeps the file every handle uses

do {
  let a = open(dbPath)
  exec(a, schema)
  BackupManifestStore.migrate(a)
  BackupManifestStore.migrate(a) // idempotent
  let b = open(dbPath)
  exec(b, "CREATE TABLE IF NOT EXISTS backup_verification (id INTEGER PRIMARY KEY, remote_file_id TEXT NOT NULL, success INTEGER NOT NULL)")
  insert(a, "p1", status: "uploaded", remote: "f1", owner: "acct-A")
  insert(a, "p2", status: "uploaded", remote: "f2", owner: "acct-A")
  insert(a, "p3", status: "pending_upload")
  exec(b, "INSERT INTO backup_verification (remote_file_id, success) VALUES ('f1', 1)")
  exec(a, "INSERT INTO backup_upload_chunks VALUES ('p3','f9',0,'/x','pending',NULL,NULL,NULL)")
  expect(scalar(b, "SELECT COUNT(*) FROM backup_assets") == 3, "JS handle sees the engine's 3 rows before sign-out")

  // A file of another expo-sqlite database in the same directory: still purged.
  let other = sqliteDir.appendingPathComponent("other.db")
  fm.createFile(atPath: other.path, contents: Data("x".utf8))

  expect(BackupManifestStore.resetInPlace(a), "resetInPlace commits")
  expect(scalar(a, "SELECT COUNT(*) FROM backup_assets") == 0, "manifest empty through the engine handle")
  expect(scalar(b, "SELECT COUNT(*) FROM backup_assets") == 0, "manifest empty through the JS handle")
  expect(scalar(b, "SELECT COUNT(*) FROM backup_verification") == 0, "JS-created backup_verification emptied too")
  expect(scalar(a, "SELECT COUNT(*) FROM backup_upload_chunks") == 0, "chunk rows emptied")

  try PlaintextStorageProtection.removeItem(
    at: sqliteDir, preserving: [dbPath, dbPath + "-wal", dbPath + "-shm"]
  )
  expect(fm.fileExists(atPath: dbPath), "the purge keeps the reset database file")
  expect(!fm.fileExists(atPath: other.path), "the purge still removes every other file in SQLite/")

  // Same process, after sign-out: both handles keep working on the SAME file.
  // Non-fatal on purpose: under the old purge these writes hit a deleted
  // inode and fail or vanish; the assertions below must report that.
  sqlite3_exec(a, "INSERT INTO backup_assets (local_asset_id, created_at, asset_type, status) VALUES ('after-a','x','photo','pending_upload')", nil, nil, nil)
  sqlite3_exec(b, "INSERT INTO backup_verification (remote_file_id, success) VALUES ('f-after', 1)", nil, nil, nil)
  try? fm.createDirectory(at: sqliteDir, withIntermediateDirectories: true)
  let fresh = open(dbPath)
  expect(scalar(fresh, "SELECT COUNT(*) FROM backup_assets WHERE local_asset_id = 'after-a'") == 1,
         "a fresh connection (next cold launch) sees the engine's post-sign-out write")
  expect(scalar(fresh, "SELECT COUNT(*) FROM backup_verification") == 1,
         "a fresh connection sees the JS layer's post-sign-out write")
  let check = orphanedFds(containing: "beebeeb-backup.db")
  expect(check.checked > 0, "lsof found this process's fds on beebeeb-backup.db (the check is not blind)")
  expect(check.orphaned.isEmpty, "no fd points at a deleted backup database: \(check.orphaned)")
  sqlite3_close_v2(fresh)
  sqlite3_close_v2(b)
  sqlite3_close_v2(a)
} catch {
  expect(false, "section 1 threw: \(error)")
}

// MARK: - 1b. Control: the pre-1667 shape (unlink under open handles) is detected

do {
  let dir = root.appendingPathComponent("control/SQLite", isDirectory: true)
  try! fm.createDirectory(at: dir, withIntermediateDirectories: true)
  let path = dir.appendingPathComponent("beebeeb-backup.db").path
  let a = open(path)
  exec(a, schema)
  BackupManifestStore.migrate(a)
  insert(a, "p1", status: "uploaded", remote: "f1", owner: "acct-A")
  try PlaintextStorageProtection.removeItem(at: dir, preserving: [])
  expect(!fm.fileExists(atPath: path), "control: without preserving, the directory goes (old behaviour)")
  // On macOS this write fails (SQLITE_IOERR: the -shm/-wal went with the
  // directory); on the simulator lsof showed the app still writing its open
  // fds. Either way nothing reaches the file the next launch opens.
  sqlite3_exec(a, "INSERT INTO backup_assets (local_asset_id, created_at, asset_type, status) VALUES ('orphan-write','x','photo','pending_upload')", nil, nil, nil)
  try! fm.createDirectory(at: dir, withIntermediateDirectories: true)
  let fresh = open(path)
  exec(fresh, schema)
  expect(scalar(fresh, "SELECT COUNT(*) FROM backup_assets") == 0,
         "control: the next launch starts from an EMPTY manifest (the duplicate-upload trigger)")
  let check = orphanedFds(containing: "control/SQLite/beebeeb-backup.db")
  expect(!check.orphaned.isEmpty, "control: the lsof check flags the engine's fd on the deleted inode")
  sqlite3_close_v2(fresh)
  sqlite3_close_v2(a)
} catch {
  expect(false, "section 1b threw: \(error)")
}

// MARK: - 1c. resetInPlace fails closed on a database it cannot empty

do {
  let path = root.appendingPathComponent("empty.db").path
  let db = open(path)
  expect(!BackupManifestStore.resetInPlace(db), "no backup_assets table -> false (caller closes + unlinks)")
  sqlite3_close_v2(db)
}

// MARK: - 2. Account ownership

func newManifest(_ name: String) -> OpaquePointer {
  let db = open(root.appendingPathComponent(name).path)
  exec(db, schema)
  BackupManifestStore.migrate(db)
  return db
}

do {
  let db = newManifest("claim.db")
  insert(db, "legacy-up", status: "uploaded", remote: "f-legacy")              // pre-column row
  insert(db, "legacy-pending", status: "pending_upload")                       // nothing remote
  insert(db, "b-up", status: "uploaded", remote: "f-b", owner: "acct-B")       // another account
  insert(db, "b-del", status: "remote_deleted", remote: "f-bd", owner: "acct-B")
  insert(db, "a-up", status: "uploaded", remote: "f-a", owner: "acct-A")
  insert(db, "b-staged", status: "uploading", remote: "f-bs", owner: "acct-B", staged: "f-bs")

  let r = BackupManifestStore.claim(db, accountId: "acct-A", nowMs: 1_000)
  expect(r.adopted == 1, "one legacy row adopted (got \(r.adopted))")
  expect(r.requeued == 2, "two rows of acct-B re-queued (got \(r.requeued))")
  expect(text(db, "SELECT uploaded_account_id FROM backup_assets WHERE local_asset_id='legacy-up'") == "acct-A",
         "legacy uploaded row now owned by the binding account")
  expect(text(db, "SELECT status FROM backup_assets WHERE local_asset_id='b-up'") == "pending_upload",
         "acct-B's uploaded row is NOT 'already backed up' for acct-A")
  expect(text(db, "SELECT remote_file_id FROM backup_assets WHERE local_asset_id='b-up'") == nil,
         "acct-B's file id is dropped from acct-A's manifest")
  expect(text(db, "SELECT status FROM backup_assets WHERE local_asset_id='b-del'") == "pending_upload",
         "acct-B's remote_deleted row is re-queued for acct-A")
  expect(text(db, "SELECT status FROM backup_assets WHERE local_asset_id='b-staged'") == "uploading",
         "a staged row is left to purgeMismatchedStagedAssets")
  expect(text(db, "SELECT status FROM backup_assets WHERE local_asset_id='a-up'") == "uploaded",
         "acct-A's own row untouched")
  expect(BackupManifestStore.uploadedCount(db, accountId: "acct-A") == 2, "acct-A owns 2 uploaded rows")
  expect(!BackupManifestStore.needsServerRebuild(db, accountId: "acct-A"), "acct-A's manifest needs no rebuild")
  expect(BackupManifestStore.needsServerRebuild(db, accountId: "acct-B"), "acct-B (nothing of its own) needs a rebuild")

  let again = BackupManifestStore.claim(db, accountId: "acct-A", nowMs: 2_000)
  expect(again.adopted == 0 && again.requeued == 0, "claim is idempotent")
  sqlite3_close_v2(db)
}

// MARK: - 2b. Upload completion + server marks

do {
  let db = newManifest("marks.db")
  insert(db, "p1", status: "uploading", staged: "f1")
  BackupManifestStore.markUploaded(db, assetId: "p1", remoteFileId: "f1", accountId: "acct-A", uploadedAtIso: "2026-10-18T01:00:00Z")
  expect(text(db, "SELECT status FROM backup_assets WHERE local_asset_id='p1'") == "uploaded", "markUploaded -> uploaded")
  expect(text(db, "SELECT uploaded_account_id FROM backup_assets WHERE local_asset_id='p1'") == "acct-A", "markUploaded records the owner")
  expect(text(db, "SELECT staged_file_id FROM backup_assets WHERE local_asset_id='p1'") == nil, "markUploaded clears staged state")
  let pending = BackupManifestStore.pendingServerMarks(db, accountId: "acct-A", limit: 10)
  expect(pending.count == 1 && pending.first?.fileId == "f1", "the upload is pending a server mark")
  expect(BackupManifestStore.pendingServerMarks(db, accountId: "acct-B", limit: 10).isEmpty, "never another account's rows")
  BackupManifestStore.recordServerMarked(db, assetId: "p1", fileId: "f-other", nowMs: 5)
  expect(BackupManifestStore.pendingServerMarks(db, accountId: "acct-A", limit: 10).count == 1,
         "a mark for a different file id does not count")
  BackupManifestStore.recordServerMarked(db, assetId: "p1", fileId: "f1", nowMs: 5)
  expect(BackupManifestStore.pendingServerMarks(db, accountId: "acct-A", limit: 10).isEmpty, "marked rows leave the queue")
  // Re-upload (new file id) re-opens the mark.
  BackupManifestStore.markUploaded(db, assetId: "p1", remoteFileId: "f1b", accountId: "acct-A", uploadedAtIso: "2026-10-18T02:00:00Z")
  expect(BackupManifestStore.pendingServerMarks(db, accountId: "acct-A", limit: 10).first?.fileId == "f1b",
         "a re-upload needs a new mark")
  sqlite3_close_v2(db)
}

// MARK: - 3. Rebuild from the server map

do {
  let body = Data(#"{"identifiers":{"f-2":"p2","f-1":"p1","f-9":"p1","f-x":"gone","f-s":"staged","f-u":"up"}}"#.utf8)
  let map = BackupManifestStore.parseIdentifierMap(body)
  expect(map?["p1"] == "f-1", "duplicate local id resolves to the smallest file id")
  expect(map?["p2"] == "f-2", "file_id -> local_identifier is inverted")
  expect(BackupManifestStore.parseIdentifierMap(Data("[]".utf8)) == nil, "wrong shape -> nil")
  expect(BackupManifestStore.parseIdentifierMap(Data(#"{"identifiers":{}}"#.utf8))?.isEmpty == true, "empty map parses")

  let db = newManifest("rebuild.db")
  insert(db, "p1", status: "pending_upload")
  insert(db, "p2", status: "failed")
  insert(db, "p3", status: "pending_upload")                                 // not on the server
  insert(db, "staged", status: "staged_upload", staged: "f-new")             // mid-upload
  insert(db, "up", status: "uploaded", remote: "f-mine", owner: "acct-A")    // already uploaded
  insert(db, "missing", status: "local_missing")
  let promoted = BackupManifestStore.applyServerMap(
    db, accountId: "acct-A", localToFileId: map ?? [:], uploadedAtIso: "2026-10-18T03:00:00Z", nowMs: 7
  )
  expect(promoted == 2, "two rows promoted (got \(promoted))")
  expect(text(db, "SELECT status || ':' || remote_file_id || ':' || uploaded_account_id FROM backup_assets WHERE local_asset_id='p1'")
         == "uploaded:f-1:acct-A", "p1 rebuilt as uploaded, file f-1, owner acct-A")
  expect(scalar(db, "SELECT server_marked_at FROM backup_assets WHERE local_asset_id='p1'") == 7, "rebuilt rows count as marked")
  expect(text(db, "SELECT status FROM backup_assets WHERE local_asset_id='p3'") == "pending_upload", "p3 still uploads")
  expect(text(db, "SELECT status FROM backup_assets WHERE local_asset_id='staged'") == "staged_upload", "a staged row is not touched")
  expect(text(db, "SELECT remote_file_id FROM backup_assets WHERE local_asset_id='up'") == "f-mine", "an uploaded row keeps its file")
  expect(scalar(db, "SELECT COUNT(*) FROM backup_assets") == 6, "nothing deleted")
  expect(!BackupManifestStore.needsServerRebuild(db, accountId: "acct-A"), "after the rebuild the manifest is ready")
  sqlite3_close_v2(db)
}

// MARK: - Helpers for round 2

func fileBytesContain(_ path: String, _ needle: String) -> Bool {
  guard let data = fm.contents(atPath: path) else { return false }
  return data.range(of: Data(needle.utf8)) != nil
}

func walBytes(_ path: String) -> Int64 {
  ((try? fm.attributesOfItem(atPath: path + "-wal"))?[.size] as? NSNumber)?.int64Value ?? 0
}

func inode(_ path: String) -> UInt64 {
  var st = stat()
  return stat(path, &st) == 0 ? UInt64(st.st_ino) : 0
}

let day: Int64 = 24 * 60 * 60 * 1000
let now: Int64 = 1_800_000_000_000

// MARK: - 4. Round 2 (Codex P1): unmarked uploads survive the sign-out reset

do {
  let path = root.appendingPathComponent("pending.db").path
  let db = open(path)
  exec(db, schema)
  BackupManifestStore.migrate(db)
  insert(db, "a-unmarked", status: "uploaded", remote: "f-a1", owner: "acct-A")
  insert(db, "a-marked", status: "uploaded", remote: "f-a2", owner: "acct-A")
  exec(db, "UPDATE backup_assets SET server_marked_at = 5 WHERE local_asset_id = 'a-marked'")
  insert(db, "a-pending", status: "pending_upload")
  insert(db, "legacy", status: "uploaded", remote: "f-legacy")                 // pre-column, unmarked
  insert(db, "b-left", status: "uploaded", remote: "f-b1", owner: "acct-B")    // left by an older failed reset
  exec(db, "UPDATE backup_assets SET remote_path = 'SECRET-PATH-MARKER' WHERE local_asset_id = 'a-unmarked'")
  exec(db, "INSERT INTO backup_pending_marks VALUES ('acct-A', 'expired', 'f-old', \(now - 31 * day))")

  expect(BackupManifestStore.adoptUnowned(db, accountId: "acct-A") == 1, "sign-out adopts the one pre-column row for the outgoing account")
  expect(BackupManifestStore.resetInPlace(db, nowMs: now), "resetInPlace commits and truncates")
  expect(scalar(db, "SELECT COUNT(*) FROM backup_assets") == 0, "manifest empty after the reset")
  expect(BackupManifestStore.pendingMarkCount(db, accountId: "acct-A") == 2,
         "acct-A keeps exactly its 2 unmarked uploads (got \(BackupManifestStore.pendingMarkCount(db, accountId: "acct-A")))")
  expect(scalar(db, "SELECT COUNT(*) FROM backup_pending_marks WHERE local_asset_id = 'a-marked'") == 0,
         "a marked upload is not kept (the server map already has it)")
  expect(scalar(db, "SELECT COUNT(*) FROM backup_pending_marks WHERE local_asset_id = 'expired'") == 0,
         "a kept row older than 30 days is dropped")
  expect(BackupManifestStore.pendingMarkCount(db, accountId: "acct-B") == 1, "acct-B's unmarked row is kept under acct-B, not acct-A")
  expect(text(db, "SELECT group_concat(name) FROM pragma_table_info('backup_pending_marks')")
         == "account_id,local_asset_id,remote_file_id,created_at_ms",
         "the kept table holds identifiers only: account, local id, file id, time")
  expect(walBytes(path) == 0, "WAL truncated to 0 bytes after the reset")
  expect(!fileBytesContain(path, "SECRET-PATH-MARKER") && !fileBytesContain(path + "-wal", "SECRET-PATH-MARKER"),
         "a dropped column value is in neither the database nor the WAL bytes (secure_delete + truncate)")

  // acct-A signs in again: the scan inserts every photo, the server map has
  // only the marked one.
  for id in ["a-unmarked", "a-marked", "a-pending", "legacy", "b-left"] { insert(db, id, status: "pending_upload") }
  BackupManifestStore.claim(db, accountId: "acct-A", nowMs: now)
  let rebuilt = BackupManifestStore.applyServerMap(db, accountId: "acct-A", localToFileId: ["a-marked": "f-a2"],
                                                   uploadedAtIso: "2026-10-18T03:00:00Z", nowMs: now)
  expect(rebuilt == 1, "server map promotes the marked upload")
  let applied = BackupManifestStore.applyPendingMarks(db, accountId: "acct-A", nowMs: now)
  expect(applied == 2, "the 2 kept uploads of acct-A are promoted (got \(applied))")
  expect(text(db, "SELECT status || ':' || remote_file_id || ':' || uploaded_account_id FROM backup_assets WHERE local_asset_id='a-unmarked'")
         == "uploaded:f-a1:acct-A", "a-unmarked is uploaded again with its own file id, owner acct-A")
  expect(text(db, "SELECT status || ':' || remote_file_id FROM backup_assets WHERE local_asset_id='legacy'") == "uploaded:f-legacy",
         "the pre-column upload is kept too")
  expect(scalar(db, "SELECT server_marked_at IS NULL FROM backup_assets WHERE local_asset_id='a-unmarked'") == 1,
         "a promoted kept row is still unmarked: the catch-up sends it to the server")
  expect(Set(BackupManifestStore.pendingServerMarks(db, accountId: "acct-A", limit: 10).map { $0.fileId }) == ["f-a1", "f-legacy"],
         "the mark catch-up now has both kept uploads")
  expect(text(db, "SELECT status FROM backup_assets WHERE local_asset_id='b-left'") == "pending_upload",
         "acct-B's kept association is NOT applied for acct-A")
  expect(text(db, "SELECT status FROM backup_assets WHERE local_asset_id='a-pending'") == "pending_upload",
         "a photo never uploaded still uploads")
  expect(BackupManifestStore.pendingMarkCount(db, accountId: "acct-A") == 0, "applied kept rows are consumed")
  expect(BackupManifestStore.pendingMarkCount(db, accountId: "acct-B") == 1, "acct-B's kept row is untouched by acct-A's sign-in")

  // A kept row whose photo has no manifest row yet waits for the next call.
  exec(db, "INSERT INTO backup_pending_marks VALUES ('acct-A', 'not-scanned-yet', 'f-ns', \(now))")
  expect(BackupManifestStore.applyPendingMarks(db, accountId: "acct-A", nowMs: now) == 0, "nothing to promote before the scan")
  expect(BackupManifestStore.pendingMarkCount(db, accountId: "acct-A") == 1, "the unmatched kept row stays")
  insert(db, "not-scanned-yet", status: "pending_upload")
  expect(BackupManifestStore.applyPendingMarks(db, accountId: "acct-A", nowMs: now) == 1, "promoted once the scan inserted it")
  expect(BackupManifestStore.pendingMarkCount(db, accountId: "acct-A") == 0, "and consumed")
  sqlite3_close_v2(db)
}

// MARK: - 5. Round 2 (Codex P1): a busy WAL checkpoint is a failed reset

do {
  let path = root.appendingPathComponent("busy.db").path
  let a = open(path)
  exec(a, schema)
  BackupManifestStore.migrate(a)
  insert(a, "p1", status: "uploaded", remote: "f1", owner: "acct-A")
  exec(a, "UPDATE backup_assets SET remote_path = 'BUSY-WAL-MARKER', server_marked_at = 1")
  // A reader (same SQLite library, so its lock is visible) holding a
  // snapshot from before the reset: what an in-flight read looks like.
  let reader = open(path)
  exec(reader, "BEGIN")
  expect(scalar(reader, "SELECT COUNT(*) FROM backup_assets") == 1, "reader holds a snapshot with the row")
  let busy = BackupManifestStore.resetInPlace(a, nowMs: now, checkpointAttempts: 2, busyTimeoutMs: 50, retryDelayUs: 1_000)
  expect(!busy, "a reset whose checkpoint cannot truncate the WAL reports FAILURE")
  let r = BackupManifestStore.truncateWal(a, attempts: 1, retryDelayUs: 0)
  expect(!r.ok && r.walBytes > 0, "the checkpoint result shows the WAL still holds frames (rc \(r.rc), wal \(r.walBytes) bytes)")
  exec(reader, "COMMIT")
  sqlite3_close_v2(reader)
  expect(BackupManifestStore.resetInPlace(a, nowMs: now, checkpointAttempts: 2, busyTimeoutMs: 50, retryDelayUs: 1_000),
         "with the reader gone the retried reset succeeds")
  expect(walBytes(path) == 0, "and the WAL is 0 bytes")
  expect(!fileBytesContain(path, "BUSY-WAL-MARKER") && !fileBytesContain(path + "-wal", "BUSY-WAL-MARKER"),
         "the outgoing row's bytes are gone from database and WAL")
  sqlite3_close_v2(a)
}

// MARK: - 6. Round 2 (Codex P1): recovery after a failed reset

do {
  // (a) Nothing else open: the retried reset succeeds in place, no unlink.
  let path = root.appendingPathComponent("recover-a.db").path
  let a = open(path)
  exec(a, schema)
  BackupManifestStore.migrate(a)
  insert(a, "p1", status: "uploaded", remote: "f1", owner: "acct-A")
  sqlite3_close_v2(a)
  let before = inode(path)
  let r = BackupManifestStore.recoverAfterFailedReset(path: path, nowMs: now, allowUnlink: true)
  expect(r.ok && !r.unlinked, "recovery resets in place when it can (ok \(r.ok), unlinked \(r.unlinked))")
  expect(inode(path) == before, "same file (inode) after an in-place recovery")
  let check = open(path)
  expect(scalar(check, "SELECT COUNT(*) FROM backup_assets") == 0, "recovered manifest is empty")
  expect(BackupManifestStore.pendingMarkCount(check, accountId: "acct-A") == 1, "and kept acct-A's unmarked upload")
  sqlite3_close_v2(check)
}

do {
  // (b) The reset keeps failing (a writer holds the lock): without
  // allowUnlink nothing is removed; with it the file is replaced and the
  // kept associations are carried into the new file.
  let path = root.appendingPathComponent("recover-b.db").path
  let a = open(path)
  exec(a, schema)
  BackupManifestStore.migrate(a)
  insert(a, "p1", status: "uploaded", remote: "f1", owner: "acct-A")
  exec(a, "INSERT INTO backup_pending_marks VALUES ('acct-B', 'pb', 'f-b', \(now))")
  sqlite3_close_v2(a)
  let locker = open(path)
  exec(locker, "BEGIN IMMEDIATE")
  let before = inode(path)
  let refused = BackupManifestStore.recoverAfterFailedReset(path: path, nowMs: now, allowUnlink: false)
  expect(!refused.ok && !refused.unlinked, "allowUnlink false (a JS handle may be open): no unlink")
  expect(inode(path) == before, "file untouched when unlinking is not allowed")
  let replaced = BackupManifestStore.recoverAfterFailedReset(path: path, nowMs: now, allowUnlink: true)
  expect(replaced.ok && replaced.unlinked, "allowUnlink true: the file is replaced")
  expect(inode(path) != before && inode(path) != 0, "a new file (inode) at the path")
  let fresh = open(path)
  expect(BackupManifestStore.pendingMarkCount(fresh, accountId: "acct-A") == 1, "acct-A's unmarked upload carried into the new file")
  expect(BackupManifestStore.pendingMarkCount(fresh, accountId: "acct-B") == 1, "acct-B's kept row carried under acct-B")
  expect(scalar(fresh, "SELECT COUNT(*) FROM sqlite_master WHERE name = 'backup_assets'") == 0,
         "the new file holds no manifest rows at all (the engine recreates its tables on open)")
  sqlite3_close_v2(fresh)
  exec(locker, "ROLLBACK")
  sqlite3_close_v2(locker)
}

// MARK: - Report

if failures.isEmpty {
  print("BackupManifestStoreTests: \(total) assertions, 0 failed")
  exit(0)
} else {
  for f in failures { print("FAIL: \(f)") }
  print("BackupManifestStoreTests: \(failures.count) of \(total) assertions FAILED")
  exit(1)
}
