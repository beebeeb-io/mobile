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

  // Optional since round 4 (nil = could not commit); typed so the file also
  // compiles against the pre-round-4 store for the red run.
  let r: (adopted: Int, requeued: Int)? = BackupManifestStore.claim(db, accountId: "acct-A", nowMs: 1_000)
  expect(r?.adopted == 1, "one legacy row adopted (got \(String(describing: r?.adopted)))")
  expect(r?.requeued == 2, "two rows of acct-B re-queued (got \(String(describing: r?.requeued)))")
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
  expect(BackupManifestStore.needsServerRebuild(db, accountId: "acct-A") == false, "acct-A's manifest needs no rebuild")
  expect(BackupManifestStore.needsServerRebuild(db, accountId: "acct-B") == true, "acct-B (nothing of its own) needs a rebuild")

  let again: (adopted: Int, requeued: Int)? = BackupManifestStore.claim(db, accountId: "acct-A", nowMs: 2_000)
  expect(again?.adopted == 0 && again?.requeued == 0, "claim is idempotent")
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
  let pending = (BackupManifestStore.pendingServerMarks(db, accountId: "acct-A", limit: 10) ?? [])
  expect(pending.count == 1 && pending.first?.fileId == "f1", "the upload is pending a server mark")
  expect((BackupManifestStore.pendingServerMarks(db, accountId: "acct-B", limit: 10) ?? []).isEmpty, "never another account's rows")
  BackupManifestStore.recordServerMarked(db, assetId: "p1", fileId: "f-other", nowMs: 5)
  expect((BackupManifestStore.pendingServerMarks(db, accountId: "acct-A", limit: 10) ?? []).count == 1,
         "a mark for a different file id does not count")
  BackupManifestStore.recordServerMarked(db, assetId: "p1", fileId: "f1", nowMs: 5)
  expect((BackupManifestStore.pendingServerMarks(db, accountId: "acct-A", limit: 10) ?? []).isEmpty, "marked rows leave the queue")
  // Re-upload (new file id) re-opens the mark.
  BackupManifestStore.markUploaded(db, assetId: "p1", remoteFileId: "f1b", accountId: "acct-A", uploadedAtIso: "2026-10-18T02:00:00Z")
  expect((BackupManifestStore.pendingServerMarks(db, accountId: "acct-A", limit: 10) ?? []).first?.fileId == "f1b",
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
  expect(promoted == 2, "two rows promoted (got \(String(describing: promoted)))")
  expect(text(db, "SELECT status || ':' || remote_file_id || ':' || uploaded_account_id FROM backup_assets WHERE local_asset_id='p1'")
         == "uploaded:f-1:acct-A", "p1 rebuilt as uploaded, file f-1, owner acct-A")
  expect(scalar(db, "SELECT server_marked_at FROM backup_assets WHERE local_asset_id='p1'") == 7, "rebuilt rows count as marked")
  expect(text(db, "SELECT status FROM backup_assets WHERE local_asset_id='p3'") == "pending_upload", "p3 still uploads")
  expect(text(db, "SELECT status FROM backup_assets WHERE local_asset_id='staged'") == "staged_upload", "a staged row is not touched")
  expect(text(db, "SELECT remote_file_id FROM backup_assets WHERE local_asset_id='up'") == "f-mine", "an uploaded row keeps its file")
  expect(scalar(db, "SELECT COUNT(*) FROM backup_assets") == 6, "nothing deleted")
  expect(BackupManifestStore.needsServerRebuild(db, accountId: "acct-A") == false, "after the rebuild the manifest is ready")
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
  exec(db, "INSERT INTO backup_pending_marks (account_id, local_asset_id, remote_file_id, created_at_ms) VALUES ('acct-A', 'expired', 'f-old', \(now - 31 * day))")

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
         // Round 14: plus the resolution flag (0/1), still no name, content, key or hash.
         == "account_id,local_asset_id,remote_file_id,created_at_ms,needs_resolution",
         "the kept table holds identifiers only: account, local id, file id, time (and the round-14 flag)")
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
  expect(applied == 2, "the 2 kept uploads of acct-A are promoted (got \(String(describing: applied)))")
  expect(text(db, "SELECT status || ':' || remote_file_id || ':' || uploaded_account_id FROM backup_assets WHERE local_asset_id='a-unmarked'")
         == "uploaded:f-a1:acct-A", "a-unmarked is uploaded again with its own file id, owner acct-A")
  expect(text(db, "SELECT status || ':' || remote_file_id FROM backup_assets WHERE local_asset_id='legacy'") == "uploaded:f-legacy",
         "the pre-column upload is kept too")
  expect(scalar(db, "SELECT server_marked_at IS NULL FROM backup_assets WHERE local_asset_id='a-unmarked'") == 1,
         "a promoted kept row is still unmarked: the catch-up sends it to the server")
  expect(Set((BackupManifestStore.pendingServerMarks(db, accountId: "acct-A", limit: 10) ?? []).map { $0.fileId }) == ["f-a1", "f-legacy"],
         "the mark catch-up now has both kept uploads")
  expect(text(db, "SELECT status FROM backup_assets WHERE local_asset_id='b-left'") == "pending_upload",
         "acct-B's kept association is NOT applied for acct-A")
  expect(text(db, "SELECT status FROM backup_assets WHERE local_asset_id='a-pending'") == "pending_upload",
         "a photo never uploaded still uploads")
  expect(BackupManifestStore.pendingMarkCount(db, accountId: "acct-A") == 0, "applied kept rows are consumed")
  expect(BackupManifestStore.pendingMarkCount(db, accountId: "acct-B") == 1, "acct-B's kept row is untouched by acct-A's sign-in")

  // A kept row whose photo has no manifest row yet waits for the next call.
  exec(db, "INSERT INTO backup_pending_marks (account_id, local_asset_id, remote_file_id, created_at_ms) VALUES ('acct-A', 'not-scanned-yet', 'f-ns', \(now))")
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
  exec(a, "INSERT INTO backup_pending_marks (account_id, local_asset_id, remote_file_id, created_at_ms) VALUES ('acct-B', 'pb', 'f-b', \(now))")
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

// MARK: - 7. Round 4 (Codex P1 "Fail closed when applying the server identifier map")
//
// Another connection (the JS layer's expo-sqlite handle, or a second engine
// statement) holds the writer lock. Every step of the rebuild path must then
// report FAILURE (nil), never a count of 0: 0 reads as "nothing on the server
// / nothing kept", the engine declares the account ready, and the scan queues
// every photo the server already has. Typed as optionals so this section also
// compiles against the pre-round-4 store (Int / Bool / tuple promote to
// Optional), which is how the red run was taken.

func lockedManifest(_ name: String) -> (db: OpaquePointer, locker: OpaquePointer) {
  let path = root.appendingPathComponent(name).path
  let db = open(path)
  exec(db, schema)
  BackupManifestStore.migrate(db)
  return (db, open(path))
}

do {
  let (db, locker) = lockedManifest("locked-map.db")
  for id in ["p1", "p2", "p3"] { insert(db, id, status: "pending_upload") }
  insert(db, "legacy", status: "uploaded", remote: "f-legacy")
  exec(db, "INSERT INTO backup_pending_marks (account_id, local_asset_id, remote_file_id, created_at_ms) VALUES ('acct-A', 'p3', 'f-3', \(now))")
  let map = ["p1": "f-1", "p2": "f-2"]

  exec(locker, "BEGIN IMMEDIATE")
  exec(locker, "UPDATE backup_assets SET retry_count = retry_count WHERE 0")

  let claimed: (adopted: Int, requeued: Int)? = BackupManifestStore.claim(db, accountId: "acct-A", nowMs: now)
  expect(claimed == nil, "claim under another writer's lock reports failure, not (0, 0) (got \(String(describing: claimed)))")
  let applied: Int? = BackupManifestStore.applyServerMap(
    db, accountId: "acct-A", localToFileId: map, uploadedAtIso: "2026-10-18T03:00:00Z", nowMs: now
  )
  expect(applied == nil, "applyServerMap under another writer's lock reports failure, not 0 (got \(String(describing: applied)))")
  let kept: Int? = BackupManifestStore.applyPendingMarks(db, accountId: "acct-A", nowMs: now)
  expect(kept == nil, "applyPendingMarks under another writer's lock reports failure, not 0 (got \(String(describing: kept)))")
  expect(scalar(db, "SELECT COUNT(*) FROM backup_assets WHERE status = 'pending_upload'") == 3,
         "nothing promoted while locked: all 3 photos still pending")
  expect(BackupManifestStore.pendingMarkCount(db, accountId: "acct-A") == 1, "the kept mark is not consumed while locked")
  expect(text(db, "SELECT uploaded_account_id FROM backup_assets WHERE local_asset_id = 'legacy'") == nil,
         "no partial claim: the legacy row is not adopted while the requeue could not run")

  exec(locker, "ROLLBACK")

  let claimedAfter: (adopted: Int, requeued: Int)? = BackupManifestStore.claim(db, accountId: "acct-A", nowMs: now)
  expect(claimedAfter?.adopted == 1, "after release: claim commits (adopted 1, got \(String(describing: claimedAfter)))")
  let appliedAfter: Int? = BackupManifestStore.applyServerMap(
    db, accountId: "acct-A", localToFileId: map, uploadedAtIso: "2026-10-18T03:00:00Z", nowMs: now
  )
  expect(appliedAfter == 2, "after release: the map applies (2 promoted, got \(String(describing: appliedAfter)))")
  let keptAfter: Int? = BackupManifestStore.applyPendingMarks(db, accountId: "acct-A", nowMs: now)
  expect(keptAfter == 1, "after release: the kept mark applies (got \(String(describing: keptAfter)))")
  expect(scalar(db, "SELECT COUNT(*) FROM backup_assets WHERE status = 'pending_upload'") == 0,
         "after release nothing is left to upload: every photo was on the server or kept")
  let empty: Int? = BackupManifestStore.applyServerMap(
    db, accountId: "acct-A", localToFileId: [:], uploadedAtIso: "2026-10-18T03:00:00Z", nowMs: now
  )
  expect(empty == 0, "an empty server map is a SUCCESS with 0 promoted, not a failure")
  let noneKept: Int? = BackupManifestStore.applyPendingMarks(db, accountId: "acct-A", nowMs: now)
  expect(noneKept == 0, "nothing kept is a success with 0, not a failure")
  sqlite3_close_v2(locker)
  sqlite3_close_v2(db)
}

do {
  // A read that cannot run (no manifest table on this handle) is not
  // "nothing uploaded": needsServerRebuild reports failure.
  let db = open(root.appendingPathComponent("no-table.db").path)
  let needs: Bool? = BackupManifestStore.needsServerRebuild(db, accountId: "acct-A")
  expect(needs == nil, "needsServerRebuild on an unreadable manifest is nil, not true (got \(String(describing: needs)))")
  let count: Int? = BackupManifestStore.uploadedCount(db, accountId: "acct-A")
  expect(count == nil, "uploadedCount on an unreadable manifest is nil, not 0 (got \(String(describing: count)))")
  sqlite3_close_v2(db)
}

do {
  // A statement that fails partway (here a trigger aborts the update of p2)
  // rolls the whole map back and reports failure: no half-applied map.
  let path = root.appendingPathComponent("abort-map.db").path
  let db = open(path)
  exec(db, schema)
  BackupManifestStore.migrate(db)
  for id in ["p1", "p2", "p3"] { insert(db, id, status: "pending_upload") }
  exec(db, """
  CREATE TRIGGER refuse_p2 BEFORE UPDATE ON backup_assets
  WHEN NEW.local_asset_id = 'p2' BEGIN SELECT RAISE(ABORT, 'refused'); END
  """)
  let applied: Int? = BackupManifestStore.applyServerMap(
    db, accountId: "acct-A", localToFileId: ["p1": "f-1", "p2": "f-2", "p3": "f-3"],
    uploadedAtIso: "2026-10-18T03:00:00Z", nowMs: now
  )
  expect(applied == nil, "a failing update makes applyServerMap report failure (got \(String(describing: applied)))")
  expect(scalar(db, "SELECT COUNT(*) FROM backup_assets WHERE status = 'pending_upload'") == 3,
         "and nothing of the map is kept: all 3 still pending (rolled back)")
  expect(sqlite3_get_autocommit(db) != 0, "no transaction left open on the engine's handle")
  sqlite3_close_v2(db)
}

do {
  // Kept marks that cannot be read are not "nothing kept".
  let db = open(root.appendingPathComponent("bad-marks.db").path)
  exec(db, schema)
  exec(db, "CREATE TABLE backup_pending_marks (unexpected TEXT)")
  let kept: Int? = BackupManifestStore.applyPendingMarks(db, accountId: "acct-A", nowMs: now)
  expect(kept == nil, "unreadable kept marks: applyPendingMarks reports failure, not 0 (got \(String(describing: kept)))")
  sqlite3_close_v2(db)
}

// MARK: - 8. Round 5 (Codex P2 "Expire pending marks even when the current account has none")
//
// acct-A leaves kept marks and never signs in on this device again; only
// acct-B and acct-C do, each with 0 kept marks of its own. acct-A's rows
// (its user id + PhotoKit/file ids) must still go after 30 days.
// Compiled with -D RED_HEAD for the red run against the 491475a9 store, which
// has no `expirePendingMarks`; those calls are left out of that build only.

/// acct-A signs out at `at` with these unmarked uploads: the real reset keeps
/// them as pending marks dated `at`.
func signOutLeavingMarks(_ db: OpaquePointer, _ ids: [String], at: Int64) {
  for id in ids { insert(db, id, status: "uploaded", remote: "f-\(id)", owner: "acct-A") }
  expect(BackupManifestStore.resetInPlace(db, nowMs: at), "acct-A's sign-out reset commits")
}

func countA(_ db: OpaquePointer, _ prefix: String) -> Int {
  scalar(db, "SELECT COUNT(*) FROM backup_pending_marks WHERE account_id = 'acct-A' AND local_asset_id LIKE '\(prefix)%'")
}

/// acct-A's history on this device: an old session (33 days ago) and a recent
/// one (5 days ago), each signing out with unmarked uploads. 33, not more: the
/// recent sign-out's own reset already expires anything older than 35 days.
func deviceUsedByA(_ name: String) -> OpaquePointer {
  let db = newManifest(name)
  signOutLeavingMarks(db, ["old-1", "old-2"], at: now - 33 * day)
  signOutLeavingMarks(db, ["fresh-1", "fresh-2", "fresh-3"], at: now - 5 * day)
  expect(countA(db, "old-") == 2 && countA(db, "fresh-") == 3, "fixture: acct-A left 2 old + 3 fresh kept marks")
  return db
}

do {
  // acct-B signs in with 0 kept marks; its batch runs the kept-marks step.
  let db = deviceUsedByA("expiry-b-batch.db")
  insert(db, "b-photo", status: "pending_upload")
  _ = BackupManifestStore.claim(db, accountId: "acct-B", nowMs: now)
  let promoted: Int? = BackupManifestStore.applyPendingMarks(db, accountId: "acct-B", nowMs: now)
  expect(promoted == 0, "acct-B has nothing kept: 0 promoted (got \(String(describing: promoted)))")
  expect(countA(db, "old-") == 0, "acct-B's batch expires acct-A's marks older than 30 days (left \(countA(db, "old-")))")
  expect(countA(db, "fresh-") == 3, "acct-A's marks younger than 30 days are kept (left \(countA(db, "fresh-")))")
  // acct-C, then acct-B again: still nothing of acct-A's under 30 days is lost.
  expect(BackupManifestStore.applyPendingMarks(db, accountId: "acct-C", nowMs: now + day) == 0, "acct-C: 0 promoted")
  expect(countA(db, "fresh-") == 3, "a day later the fresh marks are still kept")
  // 26 days later (fresh marks now 31 days old) only other accounts used the device.
  expect(BackupManifestStore.applyPendingMarks(db, accountId: "acct-C", nowMs: now + 26 * day) == 0, "acct-C 26 days on: 0 promoted")
  expect(scalar(db, "SELECT COUNT(*) FROM backup_pending_marks") == 0,
         "after 30 days nothing of acct-A remains, though acct-A never signed in again")
  sqlite3_close_v2(db)
}

do {
  // The expiry runs before the account check too: an empty account id
  // (nothing bound yet) still expires.
  let db = deviceUsedByA("expiry-empty-account.db")
  _ = BackupManifestStore.applyPendingMarks(db, accountId: "", nowMs: now)
  expect(countA(db, "old-") == 0 && countA(db, "fresh-") == 3, "applyPendingMarks with no account still expires the old rows")
  sqlite3_close_v2(db)
}

do {
  // An expired kept row that the expiry could NOT delete is still never
  // promoted: acct-A comes back after 33 days, a trigger refuses the expiry's
  // DELETE of old rows (standing in for any failure of that step). It lets
  // the consume step delete a row whose photo is uploaded, so a promote of
  // the old rows would commit and show up as 5, not fail as a whole.
  let db = deviceUsedByA("expiry-blocked.db")
  exec(db, """
  CREATE TRIGGER refuse_expiry BEFORE DELETE ON backup_pending_marks
  WHEN OLD.created_at_ms < \(now - BackupManifestStore.pendingMarksRetentionMs)
   AND NOT EXISTS (SELECT 1 FROM backup_assets a
                    WHERE a.local_asset_id = OLD.local_asset_id AND a.status = 'uploaded')
  BEGIN SELECT RAISE(ABORT, 'refused'); END
  """)
  for id in ["old-1", "old-2", "fresh-1", "fresh-2", "fresh-3"] { insert(db, id, status: "pending_upload") }
  _ = BackupManifestStore.claim(db, accountId: "acct-A", nowMs: now)
  let promoted: Int? = BackupManifestStore.applyPendingMarks(db, accountId: "acct-A", nowMs: now)
  expect(countA(db, "old-") == 2, "fixture: the expiry was refused, both old rows are still there")
  expect(promoted == 3, "only the 3 marks inside 30 days are promoted (got \(String(describing: promoted)))")
  expect(scalar(db, "SELECT COUNT(*) FROM backup_assets WHERE local_asset_id LIKE 'old-%' AND status = 'pending_upload'") == 2,
         "the 2 expired photos upload again instead of reviving a 33-day-old association")
  sqlite3_close_v2(db)
}

#if !RED_HEAD
do {
  // Sign-in of acct-B (no batch yet): the standalone expiry step.
  let db = deviceUsedByA("expiry-b-sign-in.db")
  let expired: Int? = BackupManifestStore.expirePendingMarks(db, nowMs: now)
  expect(expired == 2, "acct-B's sign-in expires acct-A's 2 old marks (got \(String(describing: expired)))")
  expect(countA(db, "old-") == 0, "old marks gone after the sign-in step")
  expect(countA(db, "fresh-") == 3, "fresh marks kept after the sign-in step")
  expect(BackupManifestStore.expirePendingMarks(db, nowMs: now) == 0, "idempotent: a second run expires nothing")

  // Boundary: exactly 30 days is kept, one millisecond more is not.
  exec(db, "DELETE FROM backup_pending_marks")
  exec(db, "INSERT INTO backup_pending_marks (account_id, local_asset_id, remote_file_id, created_at_ms) VALUES ('acct-A', 'edge-keep', 'f-k', \(now - BackupManifestStore.pendingMarksRetentionMs))")
  exec(db, "INSERT INTO backup_pending_marks (account_id, local_asset_id, remote_file_id, created_at_ms) VALUES ('acct-A', 'edge-drop', 'f-d', \(now - BackupManifestStore.pendingMarksRetentionMs - 1))")
  expect(BackupManifestStore.expirePendingMarks(db, nowMs: now) == 1, "only the row past 30 days expires")
  expect(countA(db, "edge-keep") == 1 && countA(db, "edge-drop") == 0, "30 days exactly is kept, 30 days + 1 ms is not")

  // Another connection holds the writer lock: a failure, not "0 expired".
  let locker = open(root.appendingPathComponent("expiry-b-sign-in.db").path)
  exec(locker, "BEGIN IMMEDIATE")
  expect(BackupManifestStore.expirePendingMarks(db, nowMs: now + 400 * day) == nil, "under a writer lock the expiry reports failure (nil)")
  exec(locker, "ROLLBACK")
  sqlite3_close_v2(locker)
  expect(BackupManifestStore.expirePendingMarks(db, nowMs: now + 400 * day) == 1, "after the lock is released the next trigger expires it")
  sqlite3_close_v2(db)
}

do {
  // A manifest from before round 2 has no kept-marks table: nothing to expire.
  let db = open(root.appendingPathComponent("expiry-no-table.db").path)
  exec(db, schema)
  expect(BackupManifestStore.expirePendingMarks(db, nowMs: now) == 0, "no backup_pending_marks table: 0, not a failure")
  sqlite3_close_v2(db)
}
#endif

// MARK: - 9. Round 12 (review item 5): a replaced file carries the JS schema version

/// src/services/BackupDatabase.ts `openAndMigrate`'s one-time legacy status
/// migration, verbatim: it runs when `user_version` < 1 (the JS constant
/// `LEGACY_STATUS_ENUM_MIGRATION_VERSION`; native-backup-manifest-wiring.test.ts
/// pins that it equals `BackupManifestStore.jsSchemaVersion`).
func jsOpenAndMigrate(_ db: OpaquePointer) {
  let legacyStatusEnumMigrationVersion = 1
  if scalar(db, "PRAGMA user_version") < legacyStatusEnumMigrationVersion {
    exec(db, """
    UPDATE backup_assets SET status = 'pending_upload' WHERE status = 'pending';
    UPDATE backup_assets SET status = 'uploaded' WHERE status = 'uploading';
    PRAGMA user_version = \(legacyStatusEnumMigrationVersion);
    """)
  }
}

do {
  // The sign-out reset and the in-place recovery both fail (a writer holds the
  // lock), and JS confirmed its close: the file is replaced.
  let path = root.appendingPathComponent("replaced-version.db").path
  let a = open(path)
  exec(a, schema)
  BackupManifestStore.migrate(a)
  insert(a, "p1", status: "uploaded", remote: "f1", owner: "acct-A")
  sqlite3_close_v2(a)
  let locker = open(path)
  exec(locker, "BEGIN IMMEDIATE")
  let replaced = BackupManifestStore.recoverAfterFailedReset(path: path, nowMs: now, allowUnlink: true)
  exec(locker, "ROLLBACK")
  sqlite3_close_v2(locker)
  expect(replaced.ok && replaced.unlinked, "r12-5.0: the file was replaced")
  // The next account's engine opens it first (its schema) and starts an upload.
  let engine = open(path)
  expect(scalar(engine, "PRAGMA user_version") == Int(BackupManifestStore.jsSchemaVersion),
         "r12-5.1: the replaced file carries user_version \(BackupManifestStore.jsSchemaVersion) (got \(scalar(engine, "PRAGMA user_version")))")
  exec(engine, schema)
  BackupManifestStore.migrate(engine)
  insert(engine, "b-live", status: "uploading", owner: "acct-B")
  // JS's first lazy open runs openAndMigrate.
  let js = open(path)
  jsOpenAndMigrate(js)
  expect(text(js, "SELECT status FROM backup_assets WHERE local_asset_id = 'b-live'") == "uploading",
         "r12-5.2: the engine's live 'uploading' row is untouched by JS's open (got \(text(js, "SELECT status FROM backup_assets WHERE local_asset_id = 'b-live'") ?? "nil"))")
  expect(BackupManifestStore.pendingMarkCount(js, accountId: "acct-A") == 1, "r12-5.3: the carried mark is still there")
  sqlite3_close_v2(js)
  sqlite3_close_v2(engine)

  // Control: a file at user_version 0 (the round 11 replacement) is migrated.
  let control = root.appendingPathComponent("replaced-version-control.db").path
  let c = open(control)
  exec(c, schema)
  BackupManifestStore.migrate(c)
  insert(c, "b-live", status: "uploading", owner: "acct-B")
  jsOpenAndMigrate(c)
  expect(text(c, "SELECT status FROM backup_assets WHERE local_asset_id = 'b-live'") == "uploaded",
         "r12-5.4: control: at user_version 0 JS flips 'uploading' to 'uploaded' (the bug the version prevents)")
  sqlite3_close_v2(c)
}

// MARK: - 10. Round 12 (review item 10): rows that ENTERED the queue

do {
  let db = open(root.appendingPathComponent("insert-count.db").path)
  exec(db, schema)
  BackupManifestStore.migrate(db)
  func scanned(_ ids: [String]) -> [BackupManifestStore.ScannedAsset] {
    ids.map { BackupManifestStore.ScannedAsset(localAssetId: $0, createdAt: "2026-10-18T10:00:00Z", assetType: "photo") }
  }
  expect(BackupManifestStore.insertScannedAssetsCounting(db, scanned(["c1", "c2", "c3"]), nowMs: now) == 3, "r12-10.1: three new rows entered")
  expect(BackupManifestStore.insertScannedAssetsCounting(db, scanned(["c1", "c2", "c3"]), nowMs: now) == 0, "r12-10.2: the same full scan again: 0 (upserted unchanged)")
  exec(db, "UPDATE backup_assets SET status = 'uploaded' WHERE local_asset_id = 'c1'")
  exec(db, "UPDATE backup_assets SET status = 'local_missing' WHERE local_asset_id = 'c2'")
  expect(BackupManifestStore.insertScannedAssetsCounting(db, scanned(["c1", "c2", "c3", "c4"]), nowMs: now) == 2,
         "r12-10.3: one new row and one back from local_missing entered; uploaded and pending rows did not")
  expect(text(db, "SELECT status FROM backup_assets WHERE local_asset_id = 'c2'") == "pending_upload", "r12-10.3: c2 is queued again")
  expect(BackupManifestStore.insertScannedAssets(db, scanned(["c5"]), nowMs: now), "r12-10.4: the Bool form still reports success")
  let locker = open(root.appendingPathComponent("insert-count.db").path)
  exec(locker, "BEGIN IMMEDIATE")
  sqlite3_busy_timeout(db, 0)
  expect(BackupManifestStore.insertScannedAssetsCounting(db, scanned(["c9"]), nowMs: now) == nil, "r12-10.5: a failed insert is nil, never 0")
  exec(locker, "ROLLBACK")
  sqlite3_close_v2(locker)
  sqlite3_close_v2(db)
}

// MARK: - 11. Round 13 (review item 8): the reset restores the connection's settings

do {
  let path = root.appendingPathComponent("reset-settings.db").path
  let db = open(path)
  exec(db, schema)
  BackupManifestStore.migrate(db)
  insert(db, "s-1", status: "uploaded", remote: "f-s1", owner: "acct-A")
  // The engine's long-lived connection: no busy timeout, secure_delete off.
  sqlite3_busy_timeout(db, 0)
  exec(db, "PRAGMA secure_delete = 0")
  let before = BackupManifestStore.connectionSettings(db)
  expect(before == BackupManifestStore.ConnectionSettings(busyTimeoutMs: 0, secureDelete: 0), "r13-8.0: read the settings (got \(String(describing: before)))")
  expect(BackupManifestStore.resetInPlace(db, nowMs: now), "r13-8.1: the reset succeeds")
  let after = BackupManifestStore.connectionSettings(db)
  expect(after == before, "r13-8.2: busy timeout and secure_delete are restored after the reset (got \(String(describing: after)))")
  // A failing reset restores them too (another connection holds the writer lock).
  insert(db, "s-2", status: "uploaded", remote: "f-s2", owner: "acct-A")
  let locker = open(path)
  exec(locker, "BEGIN IMMEDIATE")
  expect(!BackupManifestStore.resetInPlace(db, nowMs: now, busyTimeoutMs: 50), "r13-8.3: the reset fails under another writer")
  exec(locker, "ROLLBACK")
  sqlite3_close_v2(locker)
  expect(BackupManifestStore.connectionSettings(db) == before, "r13-8.4: and the settings are restored on that path too")
  // Other values round-trip (secure_delete FAST, a 750 ms timeout).
  insert(db, "scrub-me-r13", status: "pending_upload")
  sqlite3_busy_timeout(db, 750)
  exec(db, "PRAGMA secure_delete = FAST")
  let fast = BackupManifestStore.connectionSettings(db)
  expect(BackupManifestStore.resetInPlace(db, nowMs: now) && BackupManifestStore.connectionSettings(db) == fast,
         "r13-8.5: FAST and 750 ms are restored as they were (got \(String(describing: BackupManifestStore.connectionSettings(db))))")
  // The reset itself still overwrote the freed pages (secure_delete was on during it).
  let data = fm.contents(atPath: path) ?? Data()
  expect(data.range(of: Data("scrub-me-r13".utf8)) == nil, "r13-8.6: the reset still scrubbed a deleted row's bytes")
  sqlite3_close_v2(db)
}

// MARK: - 12. Round 13 (review item 11): no SELECT per scanned row

/// Statements stepped on a connection (SQLITE_TRACE_STMT), and how many were
/// SELECTs. Global: the C callback cannot capture.
var tracedStatements = 0
var tracedSelects = 0

do {
  let db = open(root.appendingPathComponent("insert-cost.db").path)
  exec(db, schema)
  BackupManifestStore.migrate(db)
  let ids = (0..<1000).map { "k\($0)" }
  let assets = ids.map { BackupManifestStore.ScannedAsset(localAssetId: $0, createdAt: "2026-10-18T10:00:00Z", assetType: "photo") }
  expect(BackupManifestStore.insertScannedAssetsCounting(db, assets, nowMs: now) == 1000, "r13-11.1: 1000 new rows entered")
  exec(db, "UPDATE backup_assets SET status = 'uploaded' WHERE local_asset_id IN ('k1', 'k2')")
  exec(db, "UPDATE backup_assets SET status = 'failed', retry_count = 4, error_message = 'net' WHERE local_asset_id = 'k3'")
  exec(db, "UPDATE backup_assets SET status = 'local_missing', retry_count = 9, error_message = 'gone' WHERE local_asset_id = 'k4'")
  exec(db, "UPDATE backup_assets SET selected_for_backup = 0 WHERE local_asset_id = 'k5'")
  sqlite3_trace_v2(db, UInt32(SQLITE_TRACE_STMT), { _, _, _, x in
    tracedStatements += 1
    if let x, String(cString: x.assumingMemoryBound(to: CChar.self)).uppercased().hasPrefix("SELECT") { tracedSelects += 1 }
    return 0
  }, nil)
  // The full scan again (the common case: the whole library re-upserted).
  let entered = BackupManifestStore.insertScannedAssetsCounting(db, assets, nowMs: now)
  sqlite3_trace_v2(db, 0, nil, nil)
  expect(entered == 1, "r13-11.2: only the local_missing row entered (got \(String(describing: entered)))")
  expect(tracedSelects == 0, "r13-11.3: no SELECT per row (got \(tracedSelects))")
  // BEGIN + COMMIT + one upsert per row + one revive for k4.
  expect(tracedStatements == 1000 + 3, "r13-11.4: one statement per row, plus the one revive (got \(tracedStatements))")
  expect(text(db, "SELECT status || '/' || retry_count || '/' || COALESCE(error_message, '') FROM backup_assets WHERE local_asset_id = 'k4'") == "pending_upload/0/",
         "r13-11.5: the revived row is queued with a clean retry count")
  expect(text(db, "SELECT status || '/' || retry_count || '/' || COALESCE(error_message, '') FROM backup_assets WHERE local_asset_id = 'k3'") == "failed/4/net",
         "r13-11.6: a failed row keeps its status, retry count and error")
  expect(text(db, "SELECT status FROM backup_assets WHERE local_asset_id = 'k1'") == "uploaded", "r13-11.7: an uploaded row stays uploaded")
  expect(scalar(db, "SELECT selected_for_backup FROM backup_assets WHERE local_asset_id = 'k5'") == 1, "r13-11.8: a scanned row is selected again")
  // A duplicate id in one scan counts once.
  let dup = [BackupManifestStore.ScannedAsset(localAssetId: "new-1", createdAt: "2026-10-18T10:00:00Z", assetType: "photo"),
             BackupManifestStore.ScannedAsset(localAssetId: "new-1", createdAt: "2026-10-18T10:00:00Z", assetType: "photo")]
  expect(BackupManifestStore.insertScannedAssetsCounting(db, dup, nowMs: now) == 1, "r13-11.9: a duplicate in one scan counts once")
  sqlite3_close_v2(db)
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
