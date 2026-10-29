import Darwin
import Foundation
import ManifestSQLite

// Task 1667 round 7 (mobile#182 at dc531405) — standalone swiftc test for
// the fail-closed rules of the sign-out / recovery / rebuild / upload-record
// paths. Compiled with the REAL shipped sources (BackupManifestStore.swift,
// BackupManifestHandle.swift, ManifestRebuildGate.swift,
// PhotoBackupServerResponses.swift) by scripts/swift-ci/run-swift-tests.sh,
// against real SQLite files. Written so it ALSO compiles against the
// dc531405 sources (results are read through types both shapes convert to),
// which is how the red run on dc531405 was taken.
//
//   1. Codex P2 "Reject malformed identifier-map entries": one malformed
//      entry makes the whole map nil; the rebuild gate defers.
//   2. Codex P2 "Abort replacement when the pending-mark snapshot fails":
//      a snapshot that cannot be prepared or stepped (damaged table) is a
//      failure, and the recovery keeps the file.
//   3. Sweep: a closed connection that may still be open (a statement or a
//      BLOB keeps it a zombie) never has its file replaced beneath it.
//   4. Sweep: the outgoing account's pre-column rows keep their associations
//      when the adoption fails or only the recovery can run it.
//   5. Sweep: a scan insert that did not commit every row reports failure.
//   6. Sweep: markUploaded reports whether it recorded the upload.
//   7. Sweep: pendingServerMarks reports a read failure as nil.
//   8. Sweep: the file is replaced only after the new one is built.

var failures: [String] = []
var total = 0

func expect(_ condition: Bool, _ label: String) {
  total += 1
  if !condition { failures.append(label) }
}

let fm = FileManager.default
let root = fm.temporaryDirectory.appendingPathComponent("bb-1667-r7-\(UUID().uuidString)", isDirectory: true)
try! fm.createDirectory(at: root, withIntermediateDirectories: true)
defer { try? fm.removeItem(at: root) }

// The engine's backup_assets columns (NativeBackupEngine.ensureTables).
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

func prepareSchema(_ db: OpaquePointer) {
  exsqlite3_exec(db, schema, nil, nil, nil)
  BackupManifestStore.migrate(db)
}

final class PendingFlag {
  var pending = false
  var flag: BackupManifestHandle.ResetPendingFlag {
    BackupManifestHandle.ResetPendingFlag(get: { self.pending }, set: { self.pending = $0 })
  }
}

func connect(_ path: String, wal: Bool = true) -> OpaquePointer {
  var db: OpaquePointer?
  let flags = SQLITE_OPEN_READWRITE | SQLITE_OPEN_CREATE | SQLITE_OPEN_FULLMUTEX
  precondition(exsqlite3_open_v2(path, &db, flags, nil) == SQLITE_OK, "open \(path)")
  if wal { exsqlite3_exec(db, "PRAGMA journal_mode = WAL", nil, nil, nil) }
  return db!
}

func exec(_ db: OpaquePointer, _ sql: String) {
  var err: UnsafeMutablePointer<CChar>?
  if exsqlite3_exec(db, sql, nil, nil, &err) != SQLITE_OK {
    let msg = err.map { String(cString: $0) } ?? "?"
    exsqlite3_free(err)
    fatalError("SQL failed: \(msg)\n\(sql)")
  }
}

func scalar(_ db: OpaquePointer, _ sql: String) -> Int {
  var stmt: OpaquePointer?
  guard exsqlite3_prepare_v2(db, sql, -1, &stmt, nil) == SQLITE_OK else { return -1 }
  defer { exsqlite3_finalize(stmt) }
  guard exsqlite3_step(stmt) == SQLITE_ROW else { return -1 }
  return Int(exsqlite3_column_int64(stmt, 0))
}

func onDisk(_ path: String, _ sql: String) -> Int {
  let db = connect(path)
  defer { exsqlite3_close(db) }
  return scalar(db, sql)
}

func inode(_ path: String) -> UInt64 {
  var st = stat()
  return stat(path, &st) == 0 ? UInt64(st.st_ino) : 0
}

/// (inode, path) of every fd this process holds whose path mentions
/// `needle` (`lsof -p <pid> -Fin`, as backup-manifest-store-test.swift).
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
  var ino: UInt64?
  for line in String(decoding: data, as: UTF8.self).split(separator: "\n") {
    if line.hasPrefix("f") { ino = nil }
    if line.hasPrefix("i") { ino = UInt64(line.dropFirst()) }
    if line.hasPrefix("n"), line.contains(needle), let i = ino { out.append((i, String(line.dropFirst()))) }
  }
  return out
}

/// fds on a path that is gone or now names another inode.
func orphanedFds(containing needle: String) -> [String] {
  lsofEntries(containing: needle).compactMap { e in
    var st = stat()
    if stat(e.path, &st) != 0 || UInt64(st.st_ino) != e.inode { return "\(e.path) (fd inode \(e.inode))" }
    return nil
  }
}

let now: Int64 = 1_800_000_000_000
let accountA = "acct-A"
let keptForA = "SELECT COUNT(*) FROM backup_pending_marks WHERE account_id = 'acct-A'"

func manifestPath(_ name: String) -> String {
  let dir = root.appendingPathComponent(name, isDirectory: true).appendingPathComponent("SQLite", isDirectory: true)
  try! fm.createDirectory(at: dir, withIntermediateDirectories: true)
  return dir.appendingPathComponent("beebeeb-backup.db").path
}

/// A manifest file with `rows` unmarked uploads of A plus one kept mark of B.
func seededFile(_ path: String, rows: Int, wal: Bool = true) {
  let db = connect(path, wal: wal)
  exec(db, schema)
  BackupManifestStore.migrate(db)
  exec(db, BackupManifestStore.pendingMarksTableSQL)
  exec(db, "INSERT INTO backup_pending_marks (account_id, local_asset_id, remote_file_id, created_at_ms) VALUES ('acct-B', 'pb', 'f-b', \(now))")
  for i in 0..<rows {
    exec(db, """
    INSERT INTO backup_assets (local_asset_id, remote_file_id, created_at, asset_type, status, uploaded_account_id)
    VALUES ('a\(i)', 'f-a\(i)', '2026-10-01T00:00:00Z', 'photo', 'uploaded', '\(accountA)')
    """)
  }
  precondition(exsqlite3_close(db) == SQLITE_OK)
}

/// Overwrites page `page` (1-based) of the file with 0xFF bytes.
func corruptPage(_ path: String, _ page: Int, pageSize: Int = 4096) {
  let h = FileHandle(forUpdatingAtPath: path)!
  h.seek(toFileOffset: UInt64((page - 1) * pageSize))
  h.write(Data(repeating: 0xFF, count: pageSize))
  h.closeFile()
}

// MARK: - 1. Codex P2: malformed identifier-map entries fail the whole map

do {
  let malformed: [(String, String)] = [
    ("number value", #"{"identifiers":{"f-1":"p1","f-2":7}}"#),
    ("empty value", #"{"identifiers":{"f-1":"p1","f-2":""}}"#),
    ("null value", #"{"identifiers":{"f-1":"p1","f-2":null}}"#),
    ("array value", #"{"identifiers":{"f-1":"p1","f-2":["p2"]}}"#),
    ("object value", #"{"identifiers":{"f-1":"p1","f-2":{"id":"p2"}}}"#),
    ("empty file id", #"{"identifiers":{"":"p2","f-1":"p1"}}"#),
    ("every entry malformed", #"{"identifiers":{"f-1":1,"f-2":false}}"#),
  ]
  for (name, body) in malformed {
    expect(BackupManifestStore.parseIdentifierMap(Data(body.utf8)) == nil, "1a: \(name) -> nil map")
    var threw = false
    do { _ = try PhotoBackupServerResponses.identifierMap(statusCode: 200, data: Data(body.utf8)) } catch { threw = true }
    expect(threw, "1b: 2xx with \(name) is a failed fetch")
  }
  // Controls: the check is not blind.
  expect(BackupManifestStore.parseIdentifierMap(Data(#"{"identifiers":{"f-1":"p1","f-2":"p2"}}"#.utf8))?.count == 2, "1c: a well-formed map parses")
  expect(BackupManifestStore.parseIdentifierMap(Data(#"{"identifiers":{}}"#.utf8))?.isEmpty == true, "1c: the legitimate empty map parses")

  // Through the real gate, on real SQLite: an emptied manifest, the server
  // answers 2xx with one malformed entry. The gate must defer, not promote
  // the rest and declare the account ready (p2 would upload again).
  let path = manifestPath("id-gate")
  let db = connect(path)
  prepareSchema(db)
  exec(db, """
  INSERT INTO backup_assets (local_asset_id, created_at, asset_type, status) VALUES
    ('p1', '2026-10-01T00:00:00Z', 'photo', 'pending_upload'),
    ('p2', '2026-10-01T00:00:00Z', 'photo', 'pending_upload');
  """)
  let body = Data(#"{"identifiers":{"f-1":"p1","f-2":42}}"#.utf8)
  let steps = ManifestRebuildGate.Steps(
    needsRebuild: { BackupManifestStore.needsServerRebuild(db, accountId: accountA) },
    hasDeviceId: { true },
    fetchMap: { try PhotoBackupServerResponses.identifierMap(statusCode: 200, data: body) },
    isStillCurrent: { true },
    applyMap: { map in
      BackupManifestStore.applyServerMap(db, accountId: accountA, localToFileId: map, uploadedAtIso: "2026-10-18T00:00:00Z", nowMs: now)
    },
    applyKept: { BackupManifestStore.applyPendingMarks(db, accountId: accountA, nowMs: now) }
  )
  final class Box: @unchecked Sendable { var value: ManifestRebuildGate.Outcome? }
  let box = Box()
  let sem = DispatchSemaphore(value: 0)
  Task.detached {
    box.value = await ManifestRebuildGate.run(alreadyReady: false, steps: steps)
    sem.signal()
  }
  _ = sem.wait(timeout: .now() + 20)
  let outcome = box.value
  expect(outcome == .deferred(.fetchFailed), "1d: the gate defers on a malformed 2xx map (got \(String(describing: outcome)))")
  expect(scalar(db, "SELECT COUNT(*) FROM backup_assets WHERE status = 'uploaded'") == 0,
         "1d: no row promoted from a partial map")
  exsqlite3_close(db)
}

// MARK: - 2. Codex P2: a failed pending-mark snapshot keeps the file

do {
  // 2a: the step fails (backup_assets' root page is damaged). Both the
  // retried reset and the snapshot hit it.
  let path = manifestPath("snap-step")
  seededFile(path, rows: 3, wal: false)
  let probe = connect(path, wal: false)
  let rootPage = scalar(probe, "SELECT rootpage FROM sqlite_master WHERE name = 'backup_assets'")
  exsqlite3_close(probe)
  expect(rootPage > 1, "2a0: found backup_assets' root page (\(rootPage))")
  corruptPage(path, rootPage)
  let before = inode(path)

  let direct = connect(path)
  let snapshot: [BackupManifestStore.PendingMark]? = BackupManifestStore.pendingMarksSnapshot(direct, nowMs: now)
  expect(snapshot == nil, "2a1: a snapshot whose step fails is nil (got \(snapshot.map { "\($0.count) rows" } ?? "nil"))")
  exsqlite3_close(direct)

  let r = BackupManifestStore.recoverAfterFailedReset(path: path, nowMs: now, allowUnlink: true)
  expect(!r.unlinked, "2a2: the file is NOT replaced after a failed snapshot")
  expect(!r.ok, "2a2: the recovery reports failure")
  expect(inode(path) == before, "2a3: same inode on disk")
}

do {
  // 2b: the snapshot cannot be prepared (backup_pending_marks lacks columns),
  // which also makes the reset's keep step fail.
  let path = manifestPath("snap-prepare")
  let db = connect(path)
  exec(db, schema)
  BackupManifestStore.migrate(db)
  exec(db, "DROP TABLE IF EXISTS backup_pending_marks")
  exec(db, "CREATE TABLE backup_pending_marks (account_id TEXT, local_asset_id TEXT)")
  exec(db, """
  INSERT INTO backup_assets (local_asset_id, remote_file_id, created_at, asset_type, status, uploaded_account_id)
  VALUES ('a1', 'f-a1', '2026-10-01T00:00:00Z', 'photo', 'uploaded', '\(accountA)')
  """)
  let snapshot: [BackupManifestStore.PendingMark]? = BackupManifestStore.pendingMarksSnapshot(db, nowMs: now)
  expect(snapshot == nil, "2b1: a snapshot whose query cannot be prepared is nil (got \(snapshot.map { "\($0.count) rows" } ?? "nil"))")
  exsqlite3_close(db)
  let before = inode(path)
  let r = BackupManifestStore.recoverAfterFailedReset(path: path, nowMs: now, allowUnlink: true)
  expect(!r.unlinked && inode(path) == before, "2b2: the file is kept (unlinked \(r.unlinked))")
  expect(onDisk(path, "SELECT COUNT(*) FROM backup_assets WHERE local_asset_id = 'a1'") == 1,
         "2b3: A's unmarked upload is still in the kept file")
}

do {
  // 2c control: the reset fails only because a writer holds the lock; the
  // snapshot is complete, so the replacement goes ahead and carries it all.
  let path = manifestPath("snap-ok")
  seededFile(path, rows: 3)
  let locker = connect(path)
  exec(locker, "BEGIN IMMEDIATE")
  let before = inode(path)
  let r = BackupManifestStore.recoverAfterFailedReset(path: path, nowMs: now, allowUnlink: true)
  exec(locker, "ROLLBACK")
  exsqlite3_close(locker)
  expect(r.ok && r.unlinked && inode(path) != before, "2c1: a complete snapshot still allows the replacement (ok \(r.ok), unlinked \(r.unlinked))")
  expect(onDisk(path, keptForA) == 3, "2c2: all 3 of A's associations carried")
  expect(onDisk(path, "SELECT COUNT(*) FROM backup_pending_marks WHERE account_id = 'acct-B'") == 1, "2c2: B's kept row carried")
}

// MARK: - 3. A connection that may still be open: never replace beneath it

func seedA(_ db: OpaquePointer) {
  exec(db, """
  INSERT INTO backup_assets (local_asset_id, remote_file_id, created_at, asset_type, status, uploaded_account_id)
  VALUES ('a1', 'f-a1', '2026-10-01T00:00:00Z', 'photo', 'uploaded', '\(accountA)');
  INSERT INTO backup_assets (local_asset_id, created_at, asset_type, status)
  VALUES ('a2', '2026-10-01T00:00:00Z', 'photo', 'pending_upload');
  """)
}

do {
  // 3a: a statement was left un-finalized on the engine's handle, so the
  // close cannot complete (exsqlite3_close_v2 makes it a zombie that keeps its
  // fd). The recovery must not replace the file beneath that fd.
  let name = "zombie-stmt"
  let path = manifestPath(name)
  let flag = PendingFlag()
  let handle = BackupManifestHandle(path: path, pendingReset: flag.flag, now: { now }, prepareSchema: prepareSchema)
  expect(handle.openIfClosed() == nil, "3a0: open")
  seedA(handle.db!)
  var leaked: OpaquePointer?
  _ = exsqlite3_prepare_v2(handle.db!, "SELECT local_asset_id FROM backup_assets", -1, &leaked, nil)
  _ = exsqlite3_step(leaked) // holds a read snapshot while it lives
  let js = connect(path)
  exec(js, "BEGIN IMMEDIATE")
  expect(!handle.resetForSignOut(outgoingAccountId: accountA), "3a1: reset fails under the JS lock")
  exec(js, "ROLLBACK")
  exsqlite3_close(js)
  let before = inode(path)
  let finished = handle.finishAfterFailedReset(allowUnlink: true)
  let orphans = orphanedFds(containing: name)
  expect(orphans.isEmpty, "3a2: no fd of this process on a deleted manifest (got \(orphans))")
  expect(!finished.unlinked && inode(path) == before, "3a3: the file is not replaced beneath the zombie connection (unlinked \(finished.unlinked))")
  exsqlite3_finalize(leaked) // releases the zombie
}

do {
  // 3b: a BLOB handle keeps the closed connection open (exsqlite3_close
  // cannot close it). The recovery must not replace the file, whatever JS
  // reports, while that fd may still be live.
  let name = "zombie-blob"
  let path = manifestPath(name)
  let flag = PendingFlag()
  let handle = BackupManifestHandle(path: path, pendingReset: flag.flag, now: { now }, prepareSchema: prepareSchema)
  expect(handle.openIfClosed() == nil, "3b0: open")
  seedA(handle.db!)
  let rowid = Int64(scalar(handle.db!, "SELECT rowid FROM backup_assets WHERE local_asset_id = 'a1'"))
  var blob: OpaquePointer?
  expect(exsqlite3_blob_open(handle.db!, "main", "backup_assets", "remote_file_id", rowid, 0, &blob) == SQLITE_OK,
         "3b0: a BLOB handle is open on the engine's connection")
  let js = connect(path)
  exec(js, "BEGIN IMMEDIATE")
  expect(!handle.resetForSignOut(outgoingAccountId: accountA), "3b1: reset fails under the JS lock")
  exec(js, "ROLLBACK")
  exsqlite3_close(js)
  let before = inode(path)
  let finished = handle.finishAfterFailedReset(allowUnlink: true)
  let orphans = orphanedFds(containing: name)
  expect(orphans.isEmpty, "3b2: no fd of this process on a deleted manifest (got \(orphans))")
  expect(!finished.unlinked && inode(path) == before, "3b3: the file is not replaced beneath the still-open connection (unlinked \(finished.unlinked))")
  exsqlite3_blob_close(blob)
}

// MARK: - 4. Pre-column rows keep their associations

func seedLegacy(_ db: OpaquePointer) {
  exec(db, """
  INSERT INTO backup_assets (local_asset_id, remote_file_id, created_at, asset_type, status)
  VALUES ('legacy', 'f-legacy', '2026-09-01T00:00:00Z', 'photo', 'uploaded');
  """)
}
let legacyKept = "SELECT COUNT(*) FROM backup_pending_marks WHERE account_id = 'acct-A' AND local_asset_id = 'legacy'"
let legacyRow = "SELECT COUNT(*) FROM backup_assets WHERE local_asset_id = 'legacy'"

do {
  // 4a: the adoption cannot run (a trigger aborts it); the reset alone
  // would delete the row and keep nothing.
  let path = manifestPath("adopt-fails")
  let flag = PendingFlag()
  let handle = BackupManifestHandle(path: path, pendingReset: flag.flag, now: { now }, prepareSchema: prepareSchema)
  expect(handle.openIfClosed() == nil, "4a0: open")
  seedLegacy(handle.db!)
  exec(handle.db!, """
  CREATE TRIGGER block_adopt BEFORE UPDATE OF uploaded_account_id ON backup_assets
  BEGIN SELECT RAISE(ABORT, 'adopt blocked'); END;
  """)
  let reset = handle.resetForSignOut(outgoingAccountId: accountA)
  expect(!reset, "4a1: a sign-out whose adoption failed does not report the reset done")
  let kept = onDisk(path, legacyKept) + max(0, onDisk(path, legacyRow))
  expect(kept >= 1, "4a2: the legacy upload's association survives (row or kept mark; got \(kept))")
  let finished = handle.finishAfterFailedReset(allowUnlink: true)
  expect(!finished.unlinked, "4a3: the recovery does not replace the file while the adoption keeps failing")
  let after = onDisk(path, legacyKept) + max(0, onDisk(path, legacyRow))
  expect(after >= 1, "4a3: the association still survives (got \(after))")
}

do {
  // 4b: the adoption and the reset both fail under the JS lock; the recovery
  // (no lock any more) must adopt for the same account before resetting.
  let path = manifestPath("adopt-in-recovery")
  let flag = PendingFlag()
  let handle = BackupManifestHandle(path: path, pendingReset: flag.flag, now: { now }, prepareSchema: prepareSchema)
  expect(handle.openIfClosed() == nil, "4b0: open")
  seedLegacy(handle.db!)
  let js = connect(path)
  exec(js, "BEGIN IMMEDIATE")
  expect(!handle.resetForSignOut(outgoingAccountId: accountA), "4b1: reset fails under the JS lock")
  exec(js, "ROLLBACK")
  exsqlite3_close(js)
  let finished = handle.finishAfterFailedReset(allowUnlink: true)
  expect(finished.ok, "4b2: the recovery empties the manifest")
  expect(onDisk(path, legacyRow) == 0, "4b2: the legacy row is gone from the manifest")
  expect(onDisk(path, legacyKept) == 1, "4b3: its association is kept for the account that signed out (got \(onDisk(path, legacyKept)))")
}

do {
  // 4c: the adoption's own result: nil (not 0) when it cannot run.
  let path = manifestPath("adopt-result")
  let db = connect(path)
  prepareSchema(db)
  seedLegacy(db)
  let other = connect(path)
  exec(other, "BEGIN IMMEDIATE")
  exsqlite3_busy_timeout(db, 0)
  let adopted: Int? = BackupManifestStore.adoptUnowned(db, accountId: accountA)
  expect(adopted == nil, "4c1: an adoption that could not run is nil (got \(String(describing: adopted)))")
  exec(other, "ROLLBACK")
  exsqlite3_close(other)
  let control: Int? = BackupManifestStore.adoptUnowned(db, accountId: accountA)
  expect(control == 1, "4c2: control: it adopts the row once the lock is gone (got \(String(describing: control)))")
  exsqlite3_close(db)
}

// MARK: - 5. A scan insert reports every row or failure

let scan = [
  BackupManifestStore.ScannedAsset(localAssetId: "s1", createdAt: "2026-10-18T09:00:00Z", assetType: "photo"),
  BackupManifestStore.ScannedAsset(localAssetId: "bad", createdAt: "2026-10-18T09:01:00Z", assetType: "photo"),
  BackupManifestStore.ScannedAsset(localAssetId: "s2", createdAt: "2026-10-18T09:02:00Z", assetType: "video"),
]

do {
  // 5a: another connection holds the writer lock.
  let path = manifestPath("scan-lock")
  let db = connect(path)
  prepareSchema(db)
  let other = connect(path)
  exec(other, "BEGIN IMMEDIATE")
  exsqlite3_busy_timeout(db, 0)
  let ok = BackupManifestStore.insertScannedAssets(db, scan, nowMs: now)
  exec(other, "ROLLBACK")
  exsqlite3_close(other)
  let rows = scalar(db, "SELECT COUNT(*) FROM backup_assets")
  expect(!ok, "5a1: an insert that wrote nothing reports failure (ok \(ok), rows \(rows))")
  expect(rows == 0, "5a1: nothing inserted")
  exsqlite3_close(db)
}

do {
  // 5b: one row fails mid-batch (a trigger aborts it): no partial batch
  // reported as complete.
  let path = manifestPath("scan-row")
  let db = connect(path)
  prepareSchema(db)
  exec(db, """
  CREATE TRIGGER block_bad BEFORE INSERT ON backup_assets WHEN NEW.local_asset_id = 'bad'
  BEGIN SELECT RAISE(ABORT, 'bad row'); END;
  """)
  let ok = BackupManifestStore.insertScannedAssets(db, scan, nowMs: now)
  let rows = scalar(db, "SELECT COUNT(*) FROM backup_assets")
  expect(!ok, "5b1: a batch with a failed row reports failure (ok \(ok), rows \(rows))")
  expect(rows == 0, "5b2: the batch is rolled back, not half-committed (rows \(rows))")
  exec(db, "DROP TRIGGER block_bad")
  expect(BackupManifestStore.insertScannedAssets(db, scan, nowMs: now), "5b3: control: the same batch commits")
  expect(scalar(db, "SELECT COUNT(*) FROM backup_assets") == 3, "5b3: control: 3 rows")
  exsqlite3_close(db)
}

// MARK: - 6. markUploaded reports whether it recorded the upload

do {
  let path = manifestPath("mark-uploaded")
  let db = connect(path)
  prepareSchema(db)
  exec(db, """
  INSERT INTO backup_assets (local_asset_id, created_at, asset_type, status, staged_file_id)
  VALUES ('u1', '2026-10-18T00:00:00Z', 'photo', 'uploading', 'f-u1');
  """)
  let missing: Any = BackupManifestStore.markUploaded(db, assetId: "gone", remoteFileId: "f-x", accountId: accountA, uploadedAtIso: "2026-10-18T01:00:00Z")
  expect((missing as? Bool) == false, "6a: no such row -> false (got \(missing))")
  let other = connect(path)
  exec(other, "BEGIN IMMEDIATE")
  exsqlite3_busy_timeout(db, 0)
  let locked: Any = BackupManifestStore.markUploaded(db, assetId: "u1", remoteFileId: "f-u1", accountId: accountA, uploadedAtIso: "2026-10-18T01:00:00Z")
  exec(other, "ROLLBACK")
  exsqlite3_close(other)
  expect((locked as? Bool) == false, "6b: a write that failed -> false (got \(locked))")
  let recorded: Any = BackupManifestStore.markUploaded(db, assetId: "u1", remoteFileId: "f-u1", accountId: accountA, uploadedAtIso: "2026-10-18T01:00:00Z")
  expect((recorded as? Bool) == true, "6c: control: the recorded upload -> true (got \(recorded))")
  exsqlite3_close(db)
}

// MARK: - 7. pendingServerMarks reports a read failure

do {
  let path = manifestPath("pending-marks-read")
  let db = connect(path)
  // A manifest without server_marked_at: the query cannot be prepared.
  exec(db, "CREATE TABLE backup_assets (local_asset_id TEXT PRIMARY KEY, remote_file_id TEXT, status TEXT, uploaded_account_id TEXT, uploaded_at TEXT)")
  exec(db, "INSERT INTO backup_assets VALUES ('a1', 'f-a1', 'uploaded', 'acct-A', '2026-10-18T00:00:00Z')")
  let rows: [(assetId: String, fileId: String)]? = BackupManifestStore.pendingServerMarks(db, accountId: accountA, limit: 10)
  expect(rows == nil, "7a: a read that cannot run is nil, not an empty list (got \(rows.map { "\($0.count) rows" } ?? "nil"))")
  exsqlite3_close(db)
}

// MARK: - 8. The new file is built before the old one is touched

do {
  let path = manifestPath("replace-build-first")
  seededFile(path, rows: 2)
  // The staging path cannot become a database (a directory sits there).
  try! fm.createDirectory(atPath: path + ".replacing", withIntermediateDirectories: true)
  let locker = connect(path)
  exec(locker, "BEGIN IMMEDIATE")
  let before = inode(path)
  let r = BackupManifestStore.recoverAfterFailedReset(path: path, nowMs: now, allowUnlink: true)
  exec(locker, "ROLLBACK")
  exsqlite3_close(locker)
  expect(!r.ok && !r.unlinked, "8a: a new file that cannot be built means no replacement (ok \(r.ok), unlinked \(r.unlinked))")
  expect(inode(path) == before, "8b: the old file is untouched")
  expect(onDisk(path, "SELECT COUNT(*) FROM backup_assets") == 2, "8c: its rows are all still there to retry from")
}

// MARK: - Report

if failures.isEmpty {
  print("ManifestFailClosedTests: \(total) assertions, 0 failed")
  exit(0)
} else {
  for f in failures { print("FAIL: \(f)") }
  print("ManifestFailClosedTests: \(failures.count) of \(total) assertions FAILED")
  exit(1)
}
