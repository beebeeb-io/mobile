import Darwin
import Foundation
import ManifestSQLite

// Task 1667 round 10 (review of mobile#182 at 060bfeb0, findings 5 and 7) —
// standalone swiftc test for the native manifest handle's rules toward the
// JS layer's expo-sqlite connection. Compiled with the REAL shipped sources
// (BackupManifestHandle.swift, BackupManifestStore.swift,
// ManifestRebuildGate.swift, ManifestWriteFence.swift) by
// scripts/swift-ci/run-swift-tests.sh, against real SQLite files, with a
// second connection standing in for JS.
//
// expo-sqlite bundles its own SQLite: in the app, a native close or WAL
// checkpoint cannot see the JS connection (POSIX locks never conflict inside
// one process, and each SQLite copy only counts its own connections), so a
// native close deletes `-wal`/`-shm` under JS and drops the locks JS relies
// on. In this test both connections share one SQLite copy, so that damage
// itself cannot happen here; what is asserted is the rule that prevents it:
// which connections the handle opens, closes or parks (its own counters),
// and whether it resets, checkpoints or replaces anything while JS holds the
// file (the rows and the WAL file seen from the JS connection). The lsof fd
// counts are a secondary signal only: inside ONE SQLite copy a closed
// connection's fd is kept open while another connection holds locks, so lsof
// cannot tell a close from a park here (seen in the red run at 060bfeb0).
//
//   (a) finding 5, pending reset: a sign-out whose reset and recovery failed
//       while JS's close was unconfirmed. `start()` (openIfClosed) must not
//       open, reset (checkpoint) or close anything while JS may hold the
//       file. The JS gate refuses until JS confirms its handle closed; then
//       the reset runs first and JS is admitted on an emptied file.
//   (b) finding 5, unusable file: a connection the handle cannot use while
//       JS holds the file is parked, not closed; a retry reuses it (no new
//       connection) and adopts it once the file is usable; JS's confirmed
//       close closes a parked one.
//   (c) finding 7: after `finishBackupManifestPurge` answered ok:0, JS (a
//       new account's session) is never admitted while the outgoing
//       account's rows are in the file.
//   (d) control: with no JS connection the handle behaves as before
//       (a pending reset is applied at open, a failure closes).
//   (e) round 12 item 4: `finishAfterFailedReset(allowUnlink: false)` (JS's
//       close failed) opens, resets, checkpoints and closes nothing while the
//       JS connection may be open; the reset runs once JS confirms its close
//       (the gate), adopting the outgoing account's pre-column rows first.

var failures: [String] = []
var total = 0

func expect(_ condition: Bool, _ label: String) {
  total += 1
  if !condition { failures.append(label) }
}

let fm = FileManager.default
let root = fm.temporaryDirectory.appendingPathComponent("bb-1667-jspeer-\(UUID().uuidString)", isDirectory: true)
try! fm.createDirectory(at: root, withIntermediateDirectories: true)
defer { try? fm.removeItem(at: root) }

let schema = """
CREATE TABLE IF NOT EXISTS backup_assets (
  local_asset_id TEXT PRIMARY KEY, remote_file_id TEXT, remote_path TEXT,
  content_hash TEXT NOT NULL DEFAULT '', file_size INTEGER NOT NULL DEFAULT 0,
  created_at TEXT NOT NULL, uploaded_at TEXT, asset_type TEXT NOT NULL, status TEXT NOT NULL,
  queued_at INTEGER, last_attempt_at INTEGER, retry_count INTEGER DEFAULT 0, error_message TEXT,
  staged_file_id TEXT, staged_name_encrypted TEXT, staged_mime_type TEXT, staged_is_media INTEGER DEFAULT 0,
  staged_original_size INTEGER DEFAULT 0, staged_chunk_count INTEGER DEFAULT 0, staged_dir TEXT,
  staged_at INTEGER, upload_session_id TEXT, selected_for_backup INTEGER DEFAULT 1, staged_account_id TEXT
);
CREATE TABLE IF NOT EXISTS backup_upload_chunks (
  local_asset_id TEXT NOT NULL, server_file_id TEXT NOT NULL, chunk_index INTEGER NOT NULL,
  path TEXT NOT NULL, status TEXT NOT NULL, task_id INTEGER, last_error TEXT, uploaded_at INTEGER,
  PRIMARY KEY(local_asset_id, chunk_index)
);
"""

/// The engine's ensureTables; `schemaBroken` makes it a no-op (a file the
/// handle cannot use).
var schemaBroken = false
func prepareSchema(_ db: OpaquePointer) {
  guard !schemaBroken else { return }
  exsqlite3_exec(db, schema, nil, nil, nil)
  BackupManifestStore.migrate(db)
}

final class PendingFlag {
  var pending = false
  var flag: BackupManifestHandle.ResetPendingFlag {
    BackupManifestHandle.ResetPendingFlag(get: { self.pending }, set: { self.pending = $0 })
  }
}

func connect(_ path: String) -> OpaquePointer {
  var db: OpaquePointer?
  precondition(exsqlite3_open_v2(path, &db, SQLITE_OPEN_READWRITE | SQLITE_OPEN_CREATE | SQLITE_OPEN_FULLMUTEX, nil) == SQLITE_OK)
  exsqlite3_exec(db, "PRAGMA journal_mode = WAL", nil, nil, nil)
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

func fileSize(_ path: String) -> Int64 {
  ((try? fm.attributesOfItem(atPath: path))?[.size] as? NSNumber)?.int64Value ?? -1
}

func inode(_ path: String) -> UInt64 {
  var st = stat()
  return stat(path, &st) == 0 ? UInt64(st.st_ino) : 0
}

/// fds this process holds on exactly `path` (the database file, not its sidecars).
func fdsOn(_ path: String) -> Int {
  let p = Process()
  p.executableURL = URL(fileURLWithPath: "/usr/sbin/lsof")
  p.arguments = ["-n", "-P", "-p", String(getpid()), "-Fn"]
  let pipe = Pipe()
  p.standardOutput = pipe
  p.standardError = FileHandle.nullDevice
  try? p.run()
  let data = pipe.fileHandleForReading.readDataToEndOfFile()
  p.waitUntilExit()
  let name = "/" + URL(fileURLWithPath: path).deletingLastPathComponent().lastPathComponent + "/beebeeb-backup.db"
  return String(decoding: data, as: UTF8.self).split(separator: "\n").filter { $0.hasPrefix("n") && $0.hasSuffix(name) }.count
}

let now: Int64 = 1_800_000_000_000
let accountA = "acct-A"
let rowsSQL = "SELECT COUNT(*) FROM backup_assets"

func manifestPath(_ name: String) -> String {
  let dir = root.appendingPathComponent(name, isDirectory: true)
  try! fm.createDirectory(at: dir, withIntermediateDirectories: true)
  return dir.appendingPathComponent("beebeeb-backup.db").path
}

func seedA(_ db: OpaquePointer) {
  exec(db, """
  INSERT INTO backup_assets (local_asset_id, remote_file_id, created_at, asset_type, status, uploaded_account_id, server_marked_at)
  VALUES ('a1', 'f-a1', '2026-10-01T00:00:00Z', 'photo', 'uploaded', '\(accountA)', \(now));
  INSERT INTO backup_assets (local_asset_id, remote_file_id, created_at, asset_type, status, uploaded_account_id, server_marked_at)
  VALUES ('a2', 'f-a2', '2026-10-01T00:00:00Z', 'photo', 'uploaded', '\(accountA)', \(now));
  """)
}

/// A sign-out of A whose reset AND recovery fail while JS holds the writer
/// lock, and whose JS close is not confirmed (`allowUnlink: false`). Returns
/// the JS connection, still open and idle afterwards (a handle whose
/// `closeAsync()` rejected).
func failedSignOutWithUnconfirmedJsClose(_ handle: BackupManifestHandle, _ path: String) -> OpaquePointer {
  expect(handle.admitPeerOpen(priorPeerHandlesClosed: true).admitted, "setup: JS admitted at launch")
  let js = connect(path)
  seedA(js)
  exec(js, "BEGIN IMMEDIATE")
  expect(!handle.resetForSignOut(outgoingAccountId: accountA), "setup: the sign-out reset fails under the JS lock")
  let finished = handle.finishAfterFailedReset(allowUnlink: false)
  expect(!finished.ok, "setup: the recovery fails too (JS still holds the lock, no unlink allowed)")
  exec(js, "ROLLBACK")
  return js
}

// MARK: - (a) a pending reset is never applied while JS may hold the file

do {
  let path = manifestPath("a-pending")
  let flag = PendingFlag()
  let handle = BackupManifestHandle(path: path, pendingReset: flag.flag, now: { now }, prepareSchema: prepareSchema)
  expect(handle.openIfClosed() == nil, "a0: launch open")
  let js = failedSignOutWithUnconfirmedJsClose(handle, path)
  expect(flag.pending, "a1: the reset is pending")
  expect(handle.db == nil, "a1: no native handle")
  let fdsBefore = fdsOn(path)
  let walBefore = fileSize(path + "-wal")
  let walInode = inode(path + "-wal")
  let closesBefore = handle.closedConnectionCount
  // start() / the background task, while JS's connection may still be open.
  let failure = handle.openIfClosed()
  expect(failure == .pendingResetDeferred, "a2: openIfClosed defers (got \(String(describing: failure)))")
  expect(handle.db == nil, "a2: no handle")
  expect(fdsOn(path) == fdsBefore, "a3: no connection opened on the file (fds \(fdsOn(path)) vs \(fdsBefore))")
  expect(handle.closedConnectionCount == closesBefore, "a3: no connection closed")
  expect(fileSize(path + "-wal") == walBefore && inode(path + "-wal") == walInode, "a4: the WAL was not checkpointed or replaced under JS")
  expect(scalar(js, rowsSQL) == 2, "a4: the reset did not run under the JS connection")
  // Retries back off and stay deferred.
  for _ in 0..<3 { _ = handle.openIfClosed() }
  expect(fdsOn(path) == fdsBefore && handle.closedConnectionCount == closesBefore, "a5: retries open and close nothing")
  // JS asks to open while its old connection may still be open: refused, deferred.
  let gate1 = handle.admitPeerOpen(priorPeerHandlesClosed: false)
  expect(!gate1.admitted && gate1.failure == .pendingResetDeferred, "a6: JS is not admitted while its old connection may be open (got \(gate1))")
  expect(scalar(js, rowsSQL) == 2 && fdsOn(path) == fdsBefore, "a6: still nothing touched")
  // JS closes it (BackupDatabase.admitJsOpen) and asks again.
  expect(exsqlite3_close(js) == SQLITE_OK, "a7: JS closes its old connection")
  let gate2 = handle.admitPeerOpen(priorPeerHandlesClosed: true)
  expect(gate2.admitted && gate2.failure == nil, "a8: now admitted (got \(gate2))")
  expect(!flag.pending, "a8: the reset ran first")
  expect(handle.db != nil, "a8: the native handle is open")
  let jsNew = connect(path)
  expect(scalar(jsNew, rowsSQL) == 0, "a9: JS opens on an emptied file")
  exsqlite3_close(jsNew)
}

// MARK: - (b) a connection the handle cannot use is parked while JS holds the file

do {
  let path = manifestPath("b-park")
  let handle = BackupManifestHandle(path: path, pendingReset: PendingFlag().flag, now: { now }, prepareSchema: prepareSchema)
  // JS is admitted while the native open fails (no handle), then opens.
  schemaBroken = true
  let gate = handle.admitPeerOpen(priorPeerHandlesClosed: true)
  expect(gate.admitted && gate.failure == .unreadable, "b0: JS admitted; the native open failed (got \(gate))")
  expect(handle.parkedConnectionCount == 0, "b0: with no JS connection yet, the failed connection was closed")
  let js = connect(path)
  exec(js, "CREATE TABLE IF NOT EXISTS js_side (x INTEGER)")
  let fdsWithJs = fdsOn(path)
  let closes = handle.closedConnectionCount
  // start() while JS holds the file: the open fails again.
  expect(handle.openIfClosed() == .unreadable, "b1: still unreadable")
  expect(handle.closedConnectionCount == closes, "b1: the failed connection is NOT closed while JS holds the file")
  expect(handle.parkedConnectionCount == 1, "b1: it is parked")
  expect(fdsOn(path) == fdsWithJs + 1, "b1: its fd stays open (\(fdsOn(path)) vs JS \(fdsWithJs))")
  for _ in 0..<3 { _ = handle.openIfClosed() }
  expect(handle.parkedConnectionCount == 1 && fdsOn(path) == fdsWithJs + 1, "b2: retries reuse it: no new connection")
  expect(handle.closedConnectionCount == closes, "b2: and close nothing")
  // The file becomes usable: the retry adopts the parked connection.
  schemaBroken = false
  let opensBefore = handle.openCount
  expect(handle.openIfClosed() == nil, "b3: the retry succeeds")
  expect(handle.db != nil && handle.parkedConnectionCount == 0, "b3: the parked connection is the handle now")
  expect(handle.openCount == opensBefore + 1 && fdsOn(path) == fdsWithJs + 1, "b3: no extra connection")
  if let db = handle.db {
    exec(db, "INSERT INTO backup_assets (local_asset_id, created_at, asset_type, status) VALUES ('b1', 'x', 'photo', 'pending_upload')")
  }
  expect(scalar(js, rowsSQL) == 1, "b4: JS sees what the adopted handle wrote")

  // A parked connection is closed once JS confirms its handles closed.
  let path2 = manifestPath("b-park-close")
  let h2 = BackupManifestHandle(path: path2, pendingReset: PendingFlag().flag, now: { now }, prepareSchema: prepareSchema)
  schemaBroken = true
  _ = h2.admitPeerOpen(priorPeerHandlesClosed: true)
  let js2 = connect(path2)
  exec(js2, "CREATE TABLE IF NOT EXISTS js_side (x INTEGER)")
  expect(h2.openIfClosed() == .unreadable && h2.parkedConnectionCount == 1, "b5: parked")
  let c2 = h2.closedConnectionCount
  exsqlite3_close(js2)
  schemaBroken = false
  let g2 = h2.admitPeerOpen(priorPeerHandlesClosed: true)
  expect(h2.closedConnectionCount == c2 + 1 && h2.parkedConnectionCount == 0, "b6: JS's confirmed close closes the parked connection")
  expect(g2.admitted && h2.db != nil, "b6: and a fresh open follows")
  schemaBroken = false
}

// MARK: - (c) after finish -> ok:0, JS is never admitted on the outgoing account's rows

do {
  let path = manifestPath("c-okzero")
  let flag = PendingFlag()
  let handle = BackupManifestHandle(path: path, pendingReset: flag.flag, now: { now }, prepareSchema: prepareSchema)
  expect(handle.openIfClosed() == nil, "c0: launch open")
  expect(handle.admitPeerOpen(priorPeerHandlesClosed: true).admitted, "c0: JS admitted")
  let js = connect(path)
  seedA(js)
  exec(js, "BEGIN IMMEDIATE")
  expect(!handle.resetForSignOut(outgoingAccountId: accountA), "c1: the reset fails")
  exec(js, "ROLLBACK")
  // JS's close is not confirmed (allowUnlink false) and another connection
  // holds the writer lock: the recovery fails and finishBackupManifestPurge
  // answers ok:0. The file still holds A's rows.
  let locker = connect(path)
  exec(locker, "BEGIN IMMEDIATE")
  let finished = handle.finishAfterFailedReset(allowUnlink: false)
  expect(!finished.ok && flag.pending, "c2: recovery failed, the reset stays pending (ok \(finished.ok))")
  // Later JS manages to close its old connection (BackupDatabase.admitJsOpen).
  expect(exsqlite3_close(js) == SQLITE_OK, "c2: JS's old connection closed")
  // B's session: JS asks before every open. While the reset cannot run, refused.
  var admittedWithRows: [Int] = []
  for attempt in 0..<3 {
    let gate = handle.admitPeerOpen(priorPeerHandlesClosed: true)
    expect(!gate.admitted, "c3.\(attempt): JS not admitted while A's rows are in the file (got \(gate))")
    if gate.admitted { admittedWithRows.append(scalar(locker, rowsSQL)) }
  }
  expect(handle.db == nil, "c3: no native handle on A's rows either")
  exec(locker, "ROLLBACK")
  exsqlite3_close(locker)
  let gate = handle.admitPeerOpen(priorPeerHandlesClosed: true)
  expect(gate.admitted, "c4: admitted once the reset could run (got \(gate))")
  let jsB = connect(path)
  admittedWithRows.append(scalar(jsB, rowsSQL))
  expect(admittedWithRows == [0], "c4: B never saw A's rows (rows at each admission: \(admittedWithRows))")
  expect(scalar(jsB, "SELECT COUNT(*) FROM backup_pending_marks") >= 0, "c4: the manifest is readable")
  exsqlite3_close(jsB)
}

// MARK: - (d) control: no JS connection, behaviour as before

do {
  let path = manifestPath("d-control")
  let flag = PendingFlag()
  let seed = connect(path)
  prepareSchema(seed)
  seedA(seed)
  exsqlite3_close(seed)
  flag.pending = true
  let handle = BackupManifestHandle(path: path, pendingReset: flag.flag, now: { now }, prepareSchema: prepareSchema)
  // A fresh process: JS has not been admitted, so the pending reset is applied at open.
  expect(!handle.peerMayHoldFile, "d0: nothing says JS holds the file at launch")
  expect(handle.openIfClosed() == nil && !flag.pending, "d1: the launch open applies the pending reset")
  expect(scalar(handle.db!, rowsSQL) == 0, "d1: A's rows are gone")
  // A failed open with no JS connection closes (nothing parked).
  let path2 = manifestPath("d-control-fail")
  let h2 = BackupManifestHandle(path: path2, pendingReset: PendingFlag().flag, now: { now }, prepareSchema: prepareSchema)
  schemaBroken = true
  expect(h2.openIfClosed() == .unreadable, "d2: unreadable")
  expect(h2.parkedConnectionCount == 0 && h2.closedConnectionCount == 1, "d2: closed, not parked")
  expect(fdsOn(path2) == 0, "d2: no fd left on the file")
  schemaBroken = false
}

// MARK: - (e) round 12 item 4: finish(allowUnlink: false) touches nothing while JS may hold the file

do {
  let path = manifestPath("e-unconfirmed")
  let flag = PendingFlag()
  let handle = BackupManifestHandle(path: path, pendingReset: flag.flag, now: { now }, prepareSchema: prepareSchema)
  // The native launch open failed (no handle); JS was admitted and opened.
  schemaBroken = true
  let admitted = handle.admitPeerOpen(priorPeerHandlesClosed: true)
  expect(admitted.admitted && handle.db == nil, "e0: JS admitted, no native handle (got \(admitted))")
  schemaBroken = false
  let js = connect(path)
  prepareSchema(js)
  seedA(js)
  // A's upload from before `uploaded_account_id` existed, not marked yet.
  exec(js, """
  INSERT INTO backup_assets (local_asset_id, remote_file_id, created_at, asset_type, status)
  VALUES ('a-old', 'f-a-old', '2026-09-01T00:00:00Z', 'photo', 'uploaded');
  """)
  // Sign-out of A: the reset cannot run (no native handle); it is pending.
  expect(!handle.resetForSignOut(outgoingAccountId: accountA), "e1: the sign-out reset is pending")
  // JS's closeAsync() rejected: its connection may still be open (it is,
  // and idle: no lock, so a native reset WOULD succeed under it).
  let fdsBefore = fdsOn(path)
  let walBefore = fileSize(path + "-wal")
  let walInode = inode(path + "-wal")
  let closesBefore = handle.closedConnectionCount
  let opensBefore = handle.openCount
  let finished = handle.finishAfterFailedReset(allowUnlink: false)
  expect(!finished.ok && !finished.unlinked && !finished.reopened, "e2: nothing recovered, unlinked or reopened (got \(finished))")
  expect(finished.reopenFailure == .pendingResetDeferred, "e2: deferred until JS confirms its close (got \(String(describing: finished.reopenFailure)))")
  expect(fdsOn(path) == fdsBefore, "e3: no connection opened on the file (fds \(fdsOn(path)) vs \(fdsBefore))")
  expect(handle.closedConnectionCount == closesBefore && handle.openCount == opensBefore, "e3: none closed, none opened by the handle")
  expect(fileSize(path + "-wal") == walBefore && inode(path + "-wal") == walInode, "e4: the WAL was not checkpointed or replaced under JS")
  expect(scalar(js, rowsSQL) == 3, "e4: the reset did not run under the JS connection (rows \(scalar(js, rowsSQL)))")
  expect(handle.db == nil && flag.pending && handle.peerMayHoldFile, "e5: no native handle; reset pending; JS may hold the file")
  // start() / the background task meanwhile: deferred, nothing opened.
  expect(handle.openIfClosed() == .pendingResetDeferred && fdsOn(path) == fdsBefore, "e6: openIfClosed defers and opens nothing")
  // JS retries its close at its next call and asks the gate: confirmed now.
  expect(exsqlite3_close(js) == SQLITE_OK, "e7: JS's connection closed")
  let gate = handle.admitPeerOpen(priorPeerHandlesClosed: true)
  expect(gate.admitted && handle.db != nil && !flag.pending, "e8: the reset runs once JS confirmed, then JS is admitted (got \(gate))")
  expect(scalar(handle.db!, rowsSQL) == 0, "e8: A's rows are gone")
  expect(scalar(handle.db!, "SELECT COUNT(*) FROM backup_pending_marks WHERE account_id = '\(accountA)' AND local_asset_id = 'a-old' AND remote_file_id = 'f-a-old'") == 1,
         "e9: A's pre-column unmarked upload is kept as A's pending mark (adopted at the deferred reset)")
}

print("manifest-js-peer-test: \(failures.isEmpty ? "PASS" : "FAIL")")
for f in failures { print("  FAILED: \(f)") }
print("manifest-js-peer-test: \(total) assertions, \(failures.count) failed")
exit(failures.isEmpty ? 0 : 1)
