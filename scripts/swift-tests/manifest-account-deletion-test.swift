import Darwin
import Foundation
import SQLite3

// Task 1667 round 9 (Codex P1 "Delete retained marks during permanent account
// deletion", mobile#182 at dacc089d) — standalone swiftc test for the purge
// MODE of the native manifest reset. Compiled with the REAL shipped sources
// (BackupManifestHandle.swift + BackupManifestStore.swift +
// ManifestRebuildGate.swift + ManifestWriteFence.swift) by
// scripts/swift-ci/run-swift-tests.sh, against real SQLite files.
//
// The bug: DeleteAccountScreen purges before it signs out. That purge ran the
// ordinary sign-out reset, which copies every unmarked upload into
// `backup_pending_marks` (kept 30 days), and the sign-out that followed kept
// them again. The deleted account's user id, PhotoKit local identifiers and
// remote file ids stayed on the device.
//
// NativeBackupEngine runs each step below in its own `dbQueue.sync` block:
//   purge (JS mode)   -> resetForSignOut(outgoing, mode:, deletedAccountIds:)
//   failed reset      -> finishAfterFailedReset(allowUnlink:)
//   next launch       -> openIfClosed()  (a new handle = a new process)
// A second connection plays the JS layer's expo-sqlite handle.
//
// (a) account deletion -> 0 rows of that account in backup_pending_marks and
//     in every other table of the manifest, and none of its identifiers in
//     the file's bytes; still 0 after the follow-up sign-out, after a failed
//     reset's recovery (in place and replaced), and after a pending reset
//     applied by the next process.
// (b) an ordinary sign-out still keeps the marks (regression), and another
//     account's marks survive a deletion.

var failures: [String] = []
var total = 0

func expect(_ condition: Bool, _ label: String) {
  total += 1
  if !condition { failures.append(label) }
}

let fm = FileManager.default
let root = fm.temporaryDirectory.appendingPathComponent("bb-1667-acct-del-\(UUID().uuidString)", isDirectory: true)
try! fm.createDirectory(at: root, withIntermediateDirectories: true)
defer { try? fm.removeItem(at: root) }

// The engine's backup_assets columns (NativeBackupEngine.ensureTables), plus
// the JS layer's backup_verification (BackupDatabase.ts), which the reset
// also empties.
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
CREATE TABLE IF NOT EXISTS backup_verification (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  verified_at TEXT NOT NULL DEFAULT (datetime('now')),
  remote_file_id TEXT NOT NULL,
  success INTEGER NOT NULL,
  error_message TEXT,
  file_size INTEGER
);
"""

func prepareSchema(_ db: OpaquePointer) {
  sqlite3_exec(db, schema, nil, nil, nil)
  BackupManifestStore.migrate(db)
}

/// In-memory stand-in for a UserDefaults flag; shared by two handles to play
/// "the same device, a new process".
final class Flag {
  var value = false
  var flag: BackupManifestHandle.ResetPendingFlag {
    BackupManifestHandle.ResetPendingFlag(get: { self.value }, set: { self.value = $0 })
  }
}

func connect(_ path: String) -> OpaquePointer {
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

/// What a NEW connection sees in the file at `path` right now.
func onDisk(_ path: String, _ sql: String) -> Int {
  let db = connect(path)
  defer { sqlite3_close_v2(db) }
  return scalar(db, sql)
}

func manifestPath(_ name: String) -> String {
  root.appendingPathComponent(name, isDirectory: true)
    .appendingPathComponent("SQLite", isDirectory: true)
    .appendingPathComponent("beebeeb-backup.db").path
}

let now: Int64 = 1_800_000_000_000
let day: Int64 = 24 * 60 * 60 * 1000
let accountA = "acct-A-deleted"
let accountB = "acct-B-other"

/// Account A's manifest on this device, plus a second account's kept marks:
/// - a1 uploaded + marked; a2, a3, a4 uploaded, NOT marked (the reset keeps
///   these for an ordinary sign-out); a5 queued with a staged chunk; a6 an
///   upload from before `uploaded_account_id` existed (adopted by A at an
///   ordinary sign-out);
/// - two verification rows (JS);
/// - two marks A kept at an earlier sign-out, two marks B kept.
func seedDevice(_ db: OpaquePointer) {
  exec(db, """
  INSERT INTO backup_assets (local_asset_id, remote_file_id, created_at, asset_type, status, uploaded_account_id, server_marked_at)
  VALUES ('ida-a1', 'fid-a1', '2026-10-01T00:00:00Z', 'photo', 'uploaded', '\(accountA)', \(now));
  INSERT INTO backup_assets (local_asset_id, remote_file_id, created_at, asset_type, status, uploaded_account_id)
  VALUES ('ida-a2', 'fid-a2', '2026-10-01T00:00:00Z', 'photo', 'uploaded', '\(accountA)'),
         ('ida-a3', 'fid-a3', '2026-10-01T00:00:00Z', 'photo', 'uploaded', '\(accountA)'),
         ('ida-a4', 'fid-a4', '2026-10-01T00:00:00Z', 'video', 'uploaded', '\(accountA)');
  INSERT INTO backup_assets (local_asset_id, created_at, asset_type, status, staged_file_id, staged_account_id)
  VALUES ('ida-a5', '2026-10-01T00:00:00Z', 'photo', 'staged', 'fid-a5', '\(accountA)');
  INSERT INTO backup_assets (local_asset_id, remote_file_id, created_at, asset_type, status)
  VALUES ('ida-a6', 'fid-a6', '2026-10-01T00:00:00Z', 'photo', 'uploaded');
  INSERT INTO backup_upload_chunks (local_asset_id, server_file_id, chunk_index, path, status)
  VALUES ('ida-a5', 'fid-a5', 0, '/staging/ida-a5/0', 'pending');
  INSERT INTO backup_verification (remote_file_id, success) VALUES ('fid-a1', 1), ('fid-a2', 1);
  INSERT INTO backup_pending_marks (account_id, local_asset_id, remote_file_id, created_at_ms)
  VALUES ('\(accountA)', 'ida-old1', 'fid-old1', \(now - day)),
         ('\(accountA)', 'ida-old2', 'fid-old2', \(now - 2 * day)),
         ('\(accountB)', 'idb-k1', 'fid-bk1', \(now - day)),
         ('\(accountB)', 'idb-k2', 'fid-bk2', \(now - 3 * day));
  """)
}

let marksA = "SELECT COUNT(*) FROM backup_pending_marks WHERE account_id = '\(accountA)'"
let marksB = "SELECT COUNT(*) FROM backup_pending_marks WHERE account_id = '\(accountB)'"
let marksAll = "SELECT COUNT(*) FROM backup_pending_marks"
/// Every other table of the manifest, and any row naming A anywhere.
let otherTablesSQL = [
  "SELECT COUNT(*) FROM backup_assets",
  "SELECT COUNT(*) FROM backup_upload_chunks",
  "SELECT COUNT(*) FROM backup_verification",
  "SELECT COUNT(*) FROM backup_assets WHERE uploaded_account_id = '\(accountA)' OR staged_account_id = '\(accountA)'",
]

/// Rows of A in backup_pending_marks plus every row in every other table.
func retainedOfA(_ path: String) -> (marks: Int, other: [Int]) {
  (onDisk(path, marksA), otherTablesSQL.map { onDisk(path, $0) })
}

/// The manifest's bytes (file + -wal) contain none of A's identifiers:
/// `secure_delete` zeroes freed pages and the TRUNCATE checkpoint empties
/// the WAL, so a deleted row survives in neither.
func bytesNameA(_ path: String) -> [String] {
  var data = fm.contents(atPath: path) ?? Data()
  data.append(fm.contents(atPath: path + "-wal") ?? Data())
  return [accountA, "ida-old1", "fid-old2", "ida-a2", "fid-a3", "ida-a6"].filter {
    data.range(of: Data($0.utf8)) != nil
  }
}

func newHandle(_ path: String, _ pending: Flag, _ discard: Flag) -> BackupManifestHandle {
  BackupManifestHandle(
    path: path, pendingReset: pending.flag, discardPending: discard.flag, now: { now }, prepareSchema: prepareSchema
  )
}

// MARK: - (a1) account deletion through the open handle, then the follow-up sign-out

do {
  let path = manifestPath("a1")
  let pending = Flag(), discard = Flag()
  let handle = newHandle(path, pending, discard)
  expect(handle.openIfClosed() == nil, "a1.0: launch open")
  seedDevice(handle.db!)
  let js = connect(path) // the JS handle stays open through the purge, as on device
  expect(onDisk(path, marksA) == 2 && onDisk(path, marksB) == 2, "a1.0: seeded 2 kept marks of A and 2 of B")

  let ok = handle.resetForSignOut(outgoingAccountId: accountA, mode: .accountDeleted, deletedAccountIds: [accountA])
  expect(ok, "a1.1: the deletion's reset succeeds")
  let r = retainedOfA(path)
  expect(r.marks == 0, "a1.2: 0 pending marks of the deleted account (got \(r.marks))")
  expect(r.other == [0, 0, 0, 0], "a1.3: 0 rows in backup_assets / chunks / verification / naming A (got \(r.other))")
  expect(onDisk(path, marksB) == 2, "a1.4: the other account's 2 marks are untouched (got \(onDisk(path, marksB)))")
  let leaked = bytesNameA(path)
  expect(leaked.isEmpty, "a1.5: none of A's identifiers in the file's bytes (found \(leaked))")
  expect(!pending.value && !discard.value, "a1.6: nothing pending after a successful deletion reset")
  expect(handle.deletedAccountIds == [accountA], "a1.6: the deletion is remembered for this process")

  // Between the deletion and its sign-out something writes A's upload again
  // (the JS layer, or a bind before signOut() revokes the session).
  exec(js, """
  INSERT INTO backup_assets (local_asset_id, remote_file_id, created_at, asset_type, status, uploaded_account_id)
  VALUES ('ida-a7', 'fid-a7', '2026-10-01T00:00:00Z', 'photo', 'uploaded', '\(accountA)');
  INSERT INTO backup_assets (local_asset_id, remote_file_id, created_at, asset_type, status)
  VALUES ('ida-a8', 'fid-a8', '2026-10-01T00:00:00Z', 'photo', 'uploaded');
  """)
  // The follow-up signOut() purge, as an ORDINARY sign-out (worst case: the
  // JS sticky mode lost): it must not resurrect anything of A.
  expect(handle.resetForSignOut(outgoingAccountId: accountA, mode: .signOut), "a1.7: the follow-up sign-out reset succeeds")
  let r2 = retainedOfA(path)
  expect(r2.marks == 0, "a1.8: still 0 marks of A after the follow-up sign-out (got \(r2.marks))")
  expect(r2.other == [0, 0, 0, 0], "a1.8: still 0 rows in every other table (got \(r2.other))")
  expect(onDisk(path, marksB) == 2, "a1.9: B's 2 marks still kept")
  expect(onDisk(path, "SELECT COUNT(*) FROM backup_pending_marks WHERE local_asset_id IN ('ida-a7', 'ida-a8')") == 0,
         "a1.9: A's late row and its pre-column row were not kept")

  // (b, other account) B signs in on this device afterwards, uploads one
  // photo the server map does not know yet, and signs out: B's marks are
  // kept as before.
  exec(handle.db!, """
  INSERT INTO backup_assets (local_asset_id, remote_file_id, created_at, asset_type, status, uploaded_account_id)
  VALUES ('idb-b9', 'fid-b9', '2026-10-02T00:00:00Z', 'photo', 'uploaded', '\(accountB)');
  """)
  expect(handle.resetForSignOut(outgoingAccountId: accountB, mode: .signOut), "b.1: B's sign-out reset succeeds")
  expect(onDisk(path, marksB) == 3, "b.2: B keeps its 2 marks plus the new one (got \(onDisk(path, marksB)))")
  expect(onDisk(path, marksA) == 0, "b.2: and A still has none")
  sqlite3_close_v2(js)
}

// MARK: - (a2) the deletion's reset fails; the recovery (in place) keeps nothing of A

do {
  let path = manifestPath("a2")
  let pending = Flag(), discard = Flag()
  let handle = newHandle(path, pending, discard)
  expect(handle.openIfClosed() == nil, "a2.0: launch open")
  seedDevice(handle.db!)
  let js = connect(path)
  exec(js, "BEGIN IMMEDIATE")
  expect(!handle.resetForSignOut(outgoingAccountId: accountA, mode: .accountDeleted, deletedAccountIds: [accountA]),
         "a2.1: the deletion's reset fails under the JS lock")
  expect(pending.value && discard.value, "a2.2: the pending reset is recorded as a deletion's")
  exec(js, "ROLLBACK")
  sqlite3_close_v2(js)
  let finished = handle.finishAfterFailedReset(allowUnlink: true)
  expect(finished.ok && !finished.unlinked, "a2.3: the recovery reset the file in place (ok \(finished.ok), unlinked \(finished.unlinked))")
  let r = retainedOfA(path)
  expect(r.marks == 0, "a2.4: 0 marks of A after the recovery (got \(r.marks))")
  expect(r.other == [0, 0, 0, 0], "a2.4: 0 rows in every other table (got \(r.other))")
  expect(onDisk(path, marksB) == 2, "a2.5: B's 2 marks kept")
  expect(!pending.value && !discard.value, "a2.6: nothing pending after the recovery")
  expect(bytesNameA(path).isEmpty, "a2.7: none of A's identifiers in the bytes (found \(bytesNameA(path)))")
}

// MARK: - (a3) the recovery must REPLACE the file: the carried marks exclude A

do {
  let path = manifestPath("a3")
  let pending = Flag(), discard = Flag()
  let handle = newHandle(path, pending, discard)
  expect(handle.openIfClosed() == nil, "a3.0: launch open")
  seedDevice(handle.db!)
  let js = connect(path)
  exec(js, "BEGIN IMMEDIATE")
  expect(!handle.resetForSignOut(outgoingAccountId: accountA, mode: .accountDeleted, deletedAccountIds: [accountA]),
         "a3.1: the deletion's reset fails")
  // A manifest the store cannot reset (no backup_assets): the recovery replaces it.
  exec(js, "ROLLBACK")
  exec(js, "DROP TABLE backup_assets")
  sqlite3_close_v2(js)
  let finished = handle.finishAfterFailedReset(allowUnlink: true)
  expect(finished.ok && finished.unlinked, "a3.2: the file was replaced (ok \(finished.ok), unlinked \(finished.unlinked))")
  expect(onDisk(path, marksA) == 0, "a3.3: the replacement carried 0 marks of A (got \(onDisk(path, marksA)))")
  expect(onDisk(path, marksB) == 2, "a3.4: and B's 2 marks (got \(onDisk(path, marksB)))")
  expect(bytesNameA(path).isEmpty, "a3.5: none of A's identifiers in the new file (found \(bytesNameA(path)))")
}

// MARK: - (a4) the deletion's reset is still pending when the process ends

do {
  let path = manifestPath("a4")
  let pending = Flag(), discard = Flag()
  do {
    let handle = newHandle(path, pending, discard)
    expect(handle.openIfClosed() == nil, "a4.0: launch open")
    seedDevice(handle.db!)
    let js = connect(path)
    exec(js, "BEGIN IMMEDIATE")
    expect(!handle.resetForSignOut(outgoingAccountId: accountA, mode: .accountDeleted, deletedAccountIds: [accountA]),
           "a4.1: the deletion's reset fails")
    exec(js, "ROLLBACK")
    sqlite3_close_v2(js)
    // The process ends before JS calls finishBackupManifestPurge.
  }
  expect(pending.value && discard.value, "a4.2: both flags survive the process")
  // Next launch: a new handle (no in-memory deletion ids) applies the pending reset.
  let next = newHandle(path, pending, discard)
  expect(next.openIfClosed() == nil, "a4.3: the next launch opens and applies the pending reset")
  expect(next.lastOpenAppliedPendingReset, "a4.3: the pending reset was applied")
  expect(onDisk(path, marksA) == 0, "a4.4: 0 marks of A after the next launch (got \(onDisk(path, marksA)))")
  expect(otherTablesSQL.map { onDisk(path, $0) } == [0, 0, 0, 0], "a4.4: 0 rows in every other table")
  // The new process does not know which account was deleted: every kept mark
  // goes (fail closed; B uploads its unmarked photos once more).
  expect(onDisk(path, marksAll) == 0, "a4.5: every kept mark goes when the deleted account is unknown (got \(onDisk(path, marksAll)))")
  expect(!pending.value && !discard.value, "a4.6: nothing pending afterwards")
}

// MARK: - (a5) a deletion with no known account keeps no mark at all

do {
  let path = manifestPath("a5")
  let handle = newHandle(path, Flag(), Flag())
  expect(handle.openIfClosed() == nil, "a5.0: launch open")
  seedDevice(handle.db!)
  expect(handle.resetForSignOut(outgoingAccountId: nil, mode: .accountDeleted), "a5.1: the reset succeeds")
  expect(onDisk(path, marksAll) == 0, "a5.2: 0 kept marks of any account (got \(onDisk(path, marksAll)))")
  expect(!handle.discardAllPending, "a5.3: 'discard all' is not sticky past its reset")
  // A later ordinary sign-out of another account keeps its marks again.
  exec(handle.db!, """
  INSERT INTO backup_assets (local_asset_id, remote_file_id, created_at, asset_type, status, uploaded_account_id)
  VALUES ('idb-b9', 'fid-b9', '2026-10-02T00:00:00Z', 'photo', 'uploaded', '\(accountB)');
  """)
  expect(handle.resetForSignOut(outgoingAccountId: accountB, mode: .signOut), "a5.4: B's sign-out succeeds")
  expect(onDisk(path, marksB) == 1, "a5.5: B's new mark is kept (got \(onDisk(path, marksB)))")
}

// MARK: - (b) regression: an ordinary sign-out still keeps the marks

do {
  let path = manifestPath("b")
  let pending = Flag(), discard = Flag()
  let handle = newHandle(path, pending, discard)
  expect(handle.openIfClosed() == nil, "b0: launch open")
  seedDevice(handle.db!)
  expect(handle.resetForSignOut(outgoingAccountId: accountA, mode: .signOut), "b1: the sign-out reset succeeds")
  // 2 earlier + a2, a3, a4 (unmarked) + a6 (pre-column, adopted by A).
  expect(onDisk(path, marksA) == 6, "b2: A keeps 6 marks for its next sign-in (got \(onDisk(path, marksA)))")
  expect(onDisk(path, marksB) == 2, "b3: B keeps its 2")
  expect(onDisk(path, "SELECT COUNT(*) FROM backup_assets") == 0, "b4: the manifest itself is emptied")
  expect(handle.deletedAccountIds.isEmpty && !discard.value, "b5: a sign-out records no deletion")
  // The default (no mode) is the ordinary sign-out.
  let path2 = manifestPath("b-default")
  let h2 = newHandle(path2, Flag(), Flag())
  expect(h2.openIfClosed() == nil, "b6: launch open")
  seedDevice(h2.db!)
  expect(h2.resetForSignOut(outgoingAccountId: accountA), "b6: the default reset succeeds")
  expect(onDisk(path2, marksA) == 6, "b7: the default mode keeps A's 6 marks (got \(onDisk(path2, marksA)))")
}

// MARK: - (c) the JS value -> mode

do {
  expect(ManifestPurgeMode.parse(nil) == .signOut, "c1: no mode (an older JS bundle) is a sign-out")
  expect(ManifestPurgeMode.parse("sign-out") == .signOut, "c2: 'sign-out'")
  expect(ManifestPurgeMode.parse("account-deleted") == .accountDeleted, "c3: 'account-deleted'")
  expect(ManifestPurgeMode.parse("bogus") == .accountDeleted, "c4: an unknown value fails closed as a deletion")
}

// MARK: - Report

if failures.isEmpty {
  print("ManifestAccountDeletionTests: \(total) assertions, 0 failed")
  exit(0)
} else {
  for f in failures { print("FAIL: \(f)") }
  print("ManifestAccountDeletionTests: \(failures.count) of \(total) assertions FAILED")
  exit(1)
}
