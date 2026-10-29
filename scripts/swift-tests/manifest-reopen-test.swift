import Darwin
import Foundation
import ManifestSQLite

// Task 1667 round 6 (Codex P2 "Reopen the native manifest after successful
// recovery", mobile#182 at de6c1498) — standalone swiftc test for the native
// manifest handle's lifecycle. Compiled with the REAL shipped sources
// (modules/beebeeb-crypto/ios/BackupManifestHandle.swift +
// BackupManifestStore.swift + ManifestRebuildGate.swift) by
// scripts/swift-ci/run-swift-tests.sh, against real SQLite files.
//
// NativeBackupEngine runs each step below in its own `dbQueue.sync` block:
//   launch            -> openIfClosed()                (init's enqueued open)
//   sign-out          -> resetForSignOut(outgoing)     (prepareForStoragePurge)
//   sign-out, failed  -> finishAfterFailedReset(...)   (finishStoragePurgeAfterFailedReset)
//   start() / BG task -> openIfClosed() + ManifestAvailability.record(...)
//   scan              -> BackupManifestStore.insertScannedAssets(db, ...)
// A second connection plays the JS layer's expo-sqlite handle.
//
// (a) reset fails -> recovery succeeds -> same-process sign-in: start() has a
//     handle and the scan queues the expected rows, on the file on disk.
// (b) a manifest that cannot be (re)opened: start() refuses with a visible
//     reason and a bounded retry, and holds no handle.
// (c) the normal successful reset path is unchanged: one handle, never
//     closed or reopened.

var failures: [String] = []
var total = 0

func expect(_ condition: Bool, _ label: String) {
  total += 1
  if !condition { failures.append(label) }
}

let fm = FileManager.default
let root = fm.temporaryDirectory.appendingPathComponent("bb-1667-reopen-\(UUID().uuidString)", isDirectory: true)
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

/// What the engine hands the handle as `prepareSchema` (ensureTables).
func prepareSchema(_ db: OpaquePointer) {
  exsqlite3_exec(db, schema, nil, nil, nil)
  BackupManifestStore.migrate(db)
}

/// In-memory stand-in for the UserDefaults flag.
final class PendingFlag {
  var pending = false
  var flag: BackupManifestHandle.ResetPendingFlag {
    BackupManifestHandle.ResetPendingFlag(get: { self.pending }, set: { self.pending = $0 })
  }
}

func connect(_ path: String) -> OpaquePointer {
  var db: OpaquePointer?
  let flags = SQLITE_OPEN_READWRITE | SQLITE_OPEN_CREATE | SQLITE_OPEN_FULLMUTEX
  precondition(exsqlite3_open_v2(path, &db, flags, nil) == SQLITE_OK, "open \(path)")
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

func strings(_ db: OpaquePointer, _ sql: String) -> [String] {
  var stmt: OpaquePointer?
  guard exsqlite3_prepare_v2(db, sql, -1, &stmt, nil) == SQLITE_OK else { return [] }
  defer { exsqlite3_finalize(stmt) }
  var out: [String] = []
  while exsqlite3_step(stmt) == SQLITE_ROW {
    if let t = exsqlite3_column_text(stmt, 0) { out.append(String(cString: t)) }
  }
  return out
}

/// What a NEW connection sees in the file at `path` right now: proves the
/// handle under test wrote the on-disk file, not a deleted inode.
func onDisk(_ path: String, _ sql: String) -> Int {
  let db = connect(path)
  defer { exsqlite3_close_v2(db) }
  return scalar(db, sql)
}

func onDiskStrings(_ path: String, _ sql: String) -> [String] {
  let db = connect(path)
  defer { exsqlite3_close_v2(db) }
  return strings(db, sql)
}

func inode(_ path: String) -> UInt64 {
  var st = stat()
  return stat(path, &st) == 0 ? UInt64(st.st_ino) : 0
}

let now: Int64 = 1_800_000_000_000
let accountA = "acct-A"
let scanB = [
  BackupManifestStore.ScannedAsset(localAssetId: "b1", createdAt: "2026-10-18T09:00:00Z", assetType: "photo"),
  BackupManifestStore.ScannedAsset(localAssetId: "b2", createdAt: "2026-10-18T09:01:00Z", assetType: "photo"),
  BackupManifestStore.ScannedAsset(localAssetId: "b3", createdAt: "2026-10-18T09:02:00Z", assetType: "video"),
]
let pendingSQL = "SELECT COUNT(*) FROM backup_assets WHERE status = 'pending_upload'"
let allRowsSQL = "SELECT COUNT(*) FROM backup_assets"
let keptSQL = "SELECT COUNT(*) FROM backup_pending_marks WHERE account_id = 'acct-A'"
let queuedIdsSQL = "SELECT local_asset_id FROM backup_assets WHERE status = 'pending_upload' ORDER BY local_asset_id"

/// Account A's manifest: one upload the server has (marked), one it does not
/// have yet (unmarked: kept as a pending mark by the reset), one pending.
func seedAccountA(_ db: OpaquePointer) {
  exec(db, """
  INSERT INTO backup_assets (local_asset_id, remote_file_id, created_at, asset_type, status, uploaded_account_id, server_marked_at)
  VALUES ('a1', 'f-a1', '2026-10-01T00:00:00Z', 'photo', 'uploaded', '\(accountA)', \(now));
  INSERT INTO backup_assets (local_asset_id, remote_file_id, created_at, asset_type, status, uploaded_account_id)
  VALUES ('a2', 'f-a2', '2026-10-01T00:00:00Z', 'photo', 'uploaded', '\(accountA)');
  INSERT INTO backup_assets (local_asset_id, created_at, asset_type, status)
  VALUES ('a3', '2026-10-01T00:00:00Z', 'photo', 'pending_upload');
  """)
}

func manifestPath(_ name: String) -> String {
  root.appendingPathComponent(name, isDirectory: true)
    .appendingPathComponent("SQLite", isDirectory: true)
    .appendingPathComponent("beebeeb-backup.db").path
}

/// The same-process sign-in after a sign-out: `start()`'s manifest check,
/// then the camera-roll scan through the engine's handle.
func signInAndScan(_ handle: BackupManifestHandle, _ availability: inout ManifestAvailability) -> (decision: ManifestAvailability.Decision, scanned: Bool) {
  let decision = availability.record(handle.openIfClosed())
  guard decision == .proceed, let db = handle.db else { return (decision, false) }
  return (decision, BackupManifestStore.insertScannedAssets(db, scanB, nowMs: now))
}

// MARK: - (a) reset fails -> recovery succeeds -> same-process sign-in

do {
  let path = manifestPath("a-reset")
  let flag = PendingFlag()
  let handle = BackupManifestHandle(path: path, pendingReset: flag.flag, now: { now }, prepareSchema: prepareSchema)
  expect(handle.openIfClosed() == nil, "a0: the launch open succeeds")
  seedAccountA(handle.db!)

  // The JS layer's connection, holding the writer lock through the reset.
  let js = connect(path)
  exec(js, "BEGIN IMMEDIATE")
  let started = Date()
  let resetOK = handle.resetForSignOut(outgoingAccountId: accountA)
  expect(!resetOK, "a1: the sign-out reset fails while JS holds the writer lock")
  expect(Date().timeIntervalSince(started) < 10, "a1: the failed reset is bounded")
  expect(handle.db == nil, "a2: the engine closed its handle")
  expect(flag.pending, "a3: the reset is recorded as pending")
  expect(handle.awaitingPurgeFinish, "a3: the purge is waiting for its second half")
  expect(handle.openIfClosed() == .purgeInFlight, "a4: no reopen while JS still has the file open (recovery may replace it)")
  expect(handle.db == nil, "a4: still no handle")

  // JS closes its handle (account-cleanup.ts), then calls finish.
  exec(js, "ROLLBACK")
  exsqlite3_close_v2(js)
  let finished = handle.finishAfterFailedReset(allowUnlink: true)
  expect(finished.ok, "a5: the recovery empties the manifest")
  expect(!finished.unlinked, "a5: the reset succeeded in place (no replace)")
  expect(finished.reopened, "a6: finish reports the handle reopened")
  expect(finished.reopenFailure == nil, "a6: no reopen failure")
  expect(handle.db != nil, "a6: the engine has a handle again after the recovery")
  expect(!flag.pending, "a6: the pending flag is cleared")
  expect(!handle.awaitingPurgeFinish, "a6: the purge is over")
  expect(handle.openCount == 2, "a6: exactly one reopen (got \(handle.openCount))")
  expect(onDisk(path, allRowsSQL) == 0, "a7: none of account A's rows survive")
  expect(onDisk(path, keptSQL) == 1, "a7: A's unmarked upload is kept as a pending mark")

  // Account B signs in, in the same process.
  var availability = ManifestAvailability()
  let signIn = signInAndScan(handle, &availability)
  expect(signIn.decision == .proceed, "a8: start() proceeds (got \(signIn.decision))")
  expect(availability.stopReason == nil, "a8: no stop reason")
  expect(signIn.scanned, "a9: the scan's insert committed through the engine's handle")
  expect(handle.openCount == 2, "a9: start() reused the reopened handle (no extra open)")
  expect(onDisk(path, pendingSQL) == 3, "a10: the scan queued 3 rows in the file on disk (got \(onDisk(path, pendingSQL)))")
  expect(onDiskStrings(path, queuedIdsSQL) == ["b1", "b2", "b3"], "a10: exactly B's photos are queued")
  if let db = handle.db {
    expect(scalar(db, pendingSQL) == 3, "a10: the engine's handle sees the same 3 rows")
  } else {
    expect(false, "a10: the engine's handle sees the same 3 rows (no handle)")
  }
  // JS reopens lazily and sees the same rows.
  let jsAgain = connect(path)
  expect(scalar(jsAgain, pendingSQL) == 3, "a11: the JS connection reopened on the same file sees them")
  exsqlite3_close_v2(jsAgain)
}

// (a, replaced file) the reset cannot run even with every connection closed:
// the recovery replaces the file, and the handle is reopened on the NEW file.
do {
  let path = manifestPath("a-replace")
  let flag = PendingFlag()
  let handle = BackupManifestHandle(path: path, pendingReset: flag.flag, now: { now }, prepareSchema: prepareSchema)
  expect(handle.openIfClosed() == nil, "ar0: launch open")
  seedAccountA(handle.db!)
  let js = connect(path)
  exec(js, "BEGIN IMMEDIATE")
  expect(!handle.resetForSignOut(outgoingAccountId: accountA), "ar1: reset fails under the JS lock")
  // A manifest the store cannot reset (no backup_assets): the recovery must replace it.
  exec(js, "ROLLBACK")
  exec(js, "DROP TABLE backup_assets")
  exsqlite3_close_v2(js)
  let before = inode(path)
  let finished = handle.finishAfterFailedReset(allowUnlink: true)
  expect(finished.ok && finished.unlinked, "ar2: the file was replaced (ok \(finished.ok), unlinked \(finished.unlinked))")
  expect(inode(path) != before, "ar2: a new inode is on disk")
  expect(finished.reopened && handle.db != nil, "ar3: the handle is reopened on the new file")
  var availability = ManifestAvailability()
  let signIn = signInAndScan(handle, &availability)
  expect(signIn.decision == .proceed && signIn.scanned, "ar4: sign-in proceeds and the scan commits")
  expect(onDisk(path, pendingSQL) == 3, "ar4: 3 rows queued in the NEW file on disk (got \(onDisk(path, pendingSQL)))")
}

// MARK: - (b) a manifest that cannot be (re)opened

do {
  // b1: the SQLite directory is a regular file -> exsqlite3_open_v2 fails.
  let dir = root.appendingPathComponent("b-open", isDirectory: true)
  try! fm.createDirectory(at: dir, withIntermediateDirectories: true)
  let blocker = dir.appendingPathComponent("SQLite").path
  fm.createFile(atPath: blocker, contents: Data("not a directory".utf8))
  let path = manifestPath("b-open")
  let handle = BackupManifestHandle(path: path, pendingReset: PendingFlag().flag, now: { now }, prepareSchema: prepareSchema)
  var availability = ManifestAvailability()
  let first = signInAndScan(handle, &availability)
  expect(first.decision == .refuse(reason: ManifestAvailability.unavailableMessage, retryAfter: 2),
         "b1: start() refuses with the reason and a 2 s retry (got \(first.decision))")
  expect(availability.failure == .openFailed, "b1: the failure is named (got \(String(describing: availability.failure)))")
  expect(handle.db == nil, "b1: no handle")
  expect(!first.scanned, "b1: nothing was scanned into a missing handle")
  expect(availability.stopReason == ManifestAvailability.unavailableMessage, "b1: the visible stop reason is set")
  var delays: [TimeInterval] = []
  for _ in 0..<6 {
    if case .refuse(_, let after) = availability.record(handle.openIfClosed()) { delays.append(after) }
  }
  expect(delays == [4, 8, 16, 30, 30, 30], "b2: retries back off 4, 8, 16, then 30 s (got \(delays))")
  expect(availability.consecutiveFailures == 7, "b2: every attempt counted")
  // The obstacle goes away: the next retry opens and the reason clears.
  try! fm.removeItem(atPath: blocker)
  let recovered = signInAndScan(handle, &availability)
  expect(recovered.decision == .proceed, "b3: the retry after the fix proceeds")
  expect(availability.stopReason == nil && availability.consecutiveFailures == 0, "b3: reason and counter cleared")
  expect(recovered.scanned && onDisk(path, pendingSQL) == 3, "b3: the scan then queues its rows")
}

do {
  // b4: the file is not a database.
  let path = manifestPath("b-garbage")
  try! fm.createDirectory(atPath: (path as NSString).deletingLastPathComponent, withIntermediateDirectories: true)
  let garbage = Data(repeating: 0x5A, count: 8192)
  fm.createFile(atPath: path, contents: garbage)
  let handle = BackupManifestHandle(path: path, pendingReset: PendingFlag().flag, now: { now }, prepareSchema: prepareSchema)
  var availability = ManifestAvailability()
  let attempt = signInAndScan(handle, &availability)
  expect(attempt.decision != .proceed, "b4: start() refuses an unreadable file (got \(attempt.decision))")
  expect(availability.failure == .unreadable, "b4: named unreadable (got \(String(describing: availability.failure)))")
  expect(handle.db == nil, "b4: no handle kept on it")
  expect(fm.contents(atPath: path) == garbage, "b4: the file is left as it was")
}

do {
  // b5: a sign-out reset is still pending and cannot be applied at the reopen.
  let path = manifestPath("b-pending")
  let flag = PendingFlag()
  let seedHandle = BackupManifestHandle(path: path, pendingReset: flag.flag, now: { now }, prepareSchema: prepareSchema)
  expect(seedHandle.openIfClosed() == nil, "b5: seed open")
  seedAccountA(seedHandle.db!)
  let js = connect(path)
  exec(js, "BEGIN IMMEDIATE")
  expect(!seedHandle.resetForSignOut(outgoingAccountId: accountA), "b5: sign-out reset fails")
  // JS could not close its handle: the recovery may not unlink, and the lock is still held.
  let finished = seedHandle.finishAfterFailedReset(allowUnlink: false)
  expect(!finished.ok && !finished.reopened, "b5: recovery fails while JS holds the file (ok \(finished.ok))")
  expect(flag.pending, "b5: the reset stays pending")
  var availability = ManifestAvailability()
  let attempt = signInAndScan(seedHandle, &availability)
  expect(attempt.decision != .proceed, "b6: start() refuses while the pending reset cannot be applied")
  // Task 1667 round 12 (review item 4): JS's close was not confirmed, so the
  // reset is not even tried (nothing opened or checkpointed under JS): the
  // open defers (was pending_reset_failed, after a reset attempt under JS).
  expect(availability.failure == .pendingResetDeferred, "b6: named pending_reset_deferred (got \(String(describing: availability.failure)))")
  expect(seedHandle.db == nil, "b6: no handle open on A's rows")
  expect(flag.pending, "b6: the reset is still pending")
  exec(js, "ROLLBACK")
  expect(onDisk(path, allRowsSQL) == 3, "b6: A's rows were not read into a running engine, and not half-deleted")
  // Round 12: still deferred while JS has not confirmed its close.
  let stillDeferred = signInAndScan(seedHandle, &availability)
  expect(stillDeferred.decision != .proceed && availability.failure == .pendingResetDeferred,
         "b6: still deferred until JS confirms its close (got \(String(describing: availability.failure)))")
  // JS closes its connection and confirms it at its next open (the gate).
  exsqlite3_close_v2(js)
  let gate = seedHandle.admitPeerOpen(priorPeerHandlesClosed: true)
  expect(gate.admitted, "b6: JS admitted once its close is confirmed (got \(gate))")
  // The JS lock goes away: the retry applies the reset, then proceeds.
  let retry = signInAndScan(seedHandle, &availability)
  expect(retry.decision == .proceed, "b7: the retry applies the reset and proceeds")
  // Round 12: the gate's open applied it (on the native connection, with no JS
  // connection open), before JS was admitted.
  expect(seedHandle.lastOpenAppliedPendingReset, "b7: the open applied the pending reset")
  expect(!flag.pending, "b7: flag cleared")
  expect(onDisk(path, keptSQL) == 1, "b7: A's unmarked upload kept as a pending mark")
  expect(onDiskStrings(path, queuedIdsSQL) == ["b1", "b2", "b3"], "b7: only B's scan is queued, none of A's rows")
}

do {
  // b8: every failure kind refuses; none of them lets start() run.
  for kind in [BackupManifestHandle.OpenFailure.openFailed, .unreadable, .pendingResetFailed, .purgeInFlight] {
    var availability = ManifestAvailability()
    expect(availability.record(kind) != .proceed, "b8: \(kind.rawValue) refuses")
    expect(availability.stopReason != nil, "b8: \(kind.rawValue) sets a visible reason")
  }
}

// MARK: - (c) the normal successful reset path is unchanged

do {
  let path = manifestPath("c-ok")
  let flag = PendingFlag()
  let handle = BackupManifestHandle(path: path, pendingReset: flag.flag, now: { now }, prepareSchema: prepareSchema)
  expect(handle.openIfClosed() == nil, "c0: launch open")
  let launchDb = handle.db
  seedAccountA(handle.db!)
  // JS keeps its handle open through the purge (no lock held), as on device.
  let js = connect(path)
  expect(scalar(js, allRowsSQL) == 3, "c0: JS sees A's 3 rows")
  expect(handle.resetForSignOut(outgoingAccountId: accountA), "c1: the reset succeeds")
  expect(handle.db != nil && handle.db == launchDb, "c2: the SAME handle stays open (not closed, not reopened)")
  expect(handle.openCount == 1, "c2: one open in total (got \(handle.openCount))")
  expect(!flag.pending && !handle.awaitingPurgeFinish, "c2: nothing pending")
  expect(scalar(js, allRowsSQL) == 0, "c3: JS sees the emptied manifest through its open handle")
  expect(onDisk(path, keptSQL) == 1, "c3: A's unmarked upload kept")
  var availability = ManifestAvailability()
  let signIn = signInAndScan(handle, &availability)
  expect(signIn.decision == .proceed && signIn.scanned, "c4: sign-in proceeds and the scan commits")
  expect(handle.db == launchDb && handle.openCount == 1, "c4: start() did not reopen")
  expect(scalar(js, pendingSQL) == 3 && onDisk(path, pendingSQL) == 3, "c4: JS and the file see B's 3 queued rows")
  exsqlite3_close_v2(js)
}

// MARK: - Report

if failures.isEmpty {
  print("ManifestReopenTests: \(total) assertions, 0 failed")
  exit(0)
} else {
  for f in failures { print("FAIL: \(f)") }
  print("ManifestReopenTests: \(failures.count) of \(total) assertions FAILED")
  exit(1)
}
