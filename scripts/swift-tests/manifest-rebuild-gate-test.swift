import Darwin
import Foundation
import SQLite3

// Task 1667 round 4 (Codex P1 "Fail closed when applying the server
// identifier map") — standalone swiftc test for the rebuild gate. Compiled
// with the REAL shipped sources (modules/beebeeb-crypto/ios/
// ManifestRebuildGate.swift + BackupManifestStore.swift) by
// scripts/swift-ci/run-swift-tests.sh.
//
// The steps are wired exactly as NativeBackupEngine.ensureManifestReadyForUploads
// wires them (claim + needsServerRebuild, applyServerMap, applyPendingMarks),
// against a real SQLite file. A SECOND connection holds the writer lock (what
// the JS layer's expo-sqlite handle, or any other writer, does) at each step
// of the rebuild path in turn. While it holds it the gate must DEFER: no
// account marked ready, no row promoted, every photo still pending — so
// processBatch returns before it reads a single pending upload. Once the lock
// is released the same gate applies the map and the kept marks.
//
// A control runs the pre-round-4 shape (a failed apply read as 0): it declares
// the account ready with every photo still pending, which is what queued every
// photo for a second upload.

var failures: [String] = []
var total = 0

func expect(_ condition: Bool, _ label: String) {
  total += 1
  if !condition { failures.append(label) }
}

final class Box<T> {
  private let lock = NSLock()
  private var value: T?
  func set(_ v: T) { lock.lock(); value = v; lock.unlock() }
  func get() -> T? { lock.lock(); defer { lock.unlock() }; return value }
}

/// Runs `op` and waits at most `watchdog` seconds (a hang is a RED).
func runBounded<T>(watchdog: TimeInterval = 10, _ op: @escaping () async -> T) -> T? {
  let sem = DispatchSemaphore(value: 0)
  let box = Box<T>()
  Task {
    box.set(await op())
    sem.signal()
  }
  _ = sem.wait(timeout: .now() + watchdog)
  return box.get()
}

let fm = FileManager.default
let root = fm.temporaryDirectory.appendingPathComponent("bb-1667-gate-\(UUID().uuidString)", isDirectory: true)
try! fm.createDirectory(at: root, withIntermediateDirectories: true)
defer { try? fm.removeItem(at: root) }

// The columns the store's statements touch (NativeBackupEngine.ensureTables).
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

let now: Int64 = 1_800_000_000_000
let account = "acct-A"
let photos = ["p1", "p2", "p3", "p4", "p5"]
/// The server already has p1..p3 from this device; p4 was uploaded but not
/// yet marked at the last sign-out (kept mark); p5 was never uploaded.
let serverMap = ["p1": "f-1", "p2": "f-2", "p3": "f-3"]

/// A manifest right after sign-out + sign-in: emptied, then the scan inserted
/// every photo as pending; one kept mark.
func freshManifest(_ name: String) -> (db: OpaquePointer, path: String) {
  let path = root.appendingPathComponent(name).path
  let db = open(path)
  exec(db, schema)
  BackupManifestStore.migrate(db)
  for id in photos {
    exec(db, """
    INSERT INTO backup_assets (local_asset_id, created_at, asset_type, status)
    VALUES ('\(id)', '2026-10-18T00:00:00Z', 'photo', 'pending_upload')
    """)
  }
  exec(db, "INSERT INTO backup_pending_marks VALUES ('\(account)', 'p4', 'f-4', \(now))")
  return (db, path)
}

func pending(_ db: OpaquePointer) -> Int {
  scalar(db, "SELECT COUNT(*) FROM backup_assets WHERE status = 'pending_upload'")
}

final class Calls {
  var fetch = 0
  var applyMap = 0
  var applyKept = 0
}

/// The engine's wiring (NativeBackupEngine.ensureManifestReadyForUploads),
/// with hooks to take the writer lock at a chosen point.
func steps(
  _ db: OpaquePointer,
  calls: Calls,
  current: @escaping () -> Bool = { true },
  deviceId: String? = "dev-1",
  fetch: @escaping () async throws -> [String: String] = { serverMap },
  beforeApplyMap: @escaping () -> Void = {},
  beforeApplyKept: @escaping () -> Void = {},
  legacyApply: Bool = false
) -> ManifestRebuildGate.Steps {
  ManifestRebuildGate.Steps(
    needsRebuild: {
      guard BackupManifestStore.claim(db, accountId: account, nowMs: now) != nil else { return nil }
      return BackupManifestStore.needsServerRebuild(db, accountId: account)
    },
    hasDeviceId: { !(deviceId ?? "").isEmpty },
    fetchMap: {
      calls.fetch += 1
      return try await fetch()
    },
    isStillCurrent: current,
    applyMap: { map in
      calls.applyMap += 1
      beforeApplyMap()
      let r = BackupManifestStore.applyServerMap(
        db, accountId: account, localToFileId: map, uploadedAtIso: "2026-10-18T03:00:00Z", nowMs: now
      )
      // Control: the pre-round-4 engine read a failed apply as 0.
      return legacyApply ? (r ?? 0) : r
    },
    applyKept: {
      calls.applyKept += 1
      beforeApplyKept()
      let r = BackupManifestStore.applyPendingMarks(db, accountId: account, nowMs: now)
      return legacyApply ? (r ?? 0) : r
    }
  )
}

func isReady(_ o: ManifestRebuildGate.Outcome?) -> Bool {
  if case .ready = o { return true }
  return false
}

// MARK: - 1. Writer lock held from the start: the claim cannot commit

do {
  let (db, path) = freshManifest("lock-start.db")
  let locker = open(path)
  exec(locker, "BEGIN IMMEDIATE")
  let calls = Calls()
  let outcome = runBounded { await ManifestRebuildGate.run(alreadyReady: false, steps: steps(db, calls: calls)) }
  expect(outcome == .deferred(.checkFailed), "lock at start: deferred(checkFailed) (got \(String(describing: outcome)))")
  expect(calls.fetch == 0 && calls.applyMap == 0, "lock at start: no fetch, no apply")
  expect(pending(db) == 5, "lock at start: all 5 photos still pending, none promoted")
  exec(locker, "ROLLBACK")
  sqlite3_close_v2(locker)
  sqlite3_close_v2(db)
}

// MARK: - 2. Writer lock taken while the map is fetched (the Codex case)

do {
  let (db, path) = freshManifest("lock-fetch.db")
  let locker = open(path)
  var locked = false
  let calls = Calls()
  let outcome = runBounded {
    await ManifestRebuildGate.run(alreadyReady: false, steps: steps(db, calls: calls, fetch: {
      exec(locker, "BEGIN IMMEDIATE")
      locked = true
      return serverMap
    }))
  }
  expect(locked, "the lock was taken during the fetch")
  expect(outcome == .deferred(.applyMapFailed), "lock during fetch: deferred(applyMapFailed) (got \(String(describing: outcome)))")
  expect(calls.applyKept == 0, "lock during fetch: kept marks not attempted after a failed map")
  expect(pending(db) == 5, "lock during fetch: 0 promoted, all 5 still pending (nothing marked ready)")
  expect(BackupManifestStore.pendingMarkCount(db, accountId: account) == 1, "the kept mark is untouched")

  // Released: the very same gate now applies the map and the kept mark.
  exec(locker, "ROLLBACK")
  let after = runBounded { await ManifestRebuildGate.run(alreadyReady: false, steps: steps(db, calls: Calls())) }
  expect(after == .ready(rebuilt: true, promoted: 3, keptApplied: 1),
         "after release: ready, 3 promoted from the server map, 1 kept mark applied (got \(String(describing: after)))")
  expect(pending(db) == 1, "after release: only p5 (never uploaded) is left to upload (got \(pending(db)))")
  expect(scalar(db, "SELECT COUNT(*) FROM backup_assets WHERE status = 'uploaded' AND uploaded_account_id = '\(account)'") == 4,
         "after release: p1..p4 uploaded for acct-A")
  sqlite3_close_v2(locker)
  sqlite3_close_v2(db)
}

// MARK: - 3. Writer lock taken after the map applied, before the kept marks

do {
  let (db, path) = freshManifest("lock-kept.db")
  let locker = open(path)
  let calls = Calls()
  let outcome = runBounded {
    await ManifestRebuildGate.run(alreadyReady: false, steps: steps(db, calls: calls, beforeApplyKept: {
      exec(locker, "BEGIN IMMEDIATE")
    }))
  }
  expect(outcome == .deferred(.applyKeptFailed), "lock before kept marks: deferred(applyKeptFailed) (got \(String(describing: outcome)))")
  expect(scalar(db, "SELECT COUNT(*) FROM backup_assets WHERE local_asset_id = 'p4' AND status = 'pending_upload'") == 1
         && pending(db) == 2, "p4 (kept) and p5 still pending: the batch must not run (got \(pending(db)) pending)")
  exec(locker, "ROLLBACK")
  // Next batch: the map is in (needs no rebuild), the kept mark now applies.
  let after = runBounded { await ManifestRebuildGate.run(alreadyReady: false, steps: steps(db, calls: Calls())) }
  expect(after == .ready(rebuilt: false, promoted: 0, keptApplied: 1),
         "after release: ready without a second fetch, kept mark applied (got \(String(describing: after)))")
  expect(pending(db) == 1, "after release: only p5 left")
  sqlite3_close_v2(locker)
  sqlite3_close_v2(db)
}

// MARK: - 4. Already ready this process: kept marks under a lock still defer

do {
  let (db, path) = freshManifest("lock-ready.db")
  let locker = open(path)
  exec(locker, "BEGIN IMMEDIATE")
  let calls = Calls()
  let outcome = runBounded { await ManifestRebuildGate.run(alreadyReady: true, steps: steps(db, calls: calls)) }
  expect(outcome == .deferred(.applyKeptFailed), "ready fast path + lock: deferred(applyKeptFailed) (got \(String(describing: outcome)))")
  expect(calls.fetch == 0, "ready fast path never fetches")
  exec(locker, "ROLLBACK")
  exec(db, "DELETE FROM backup_pending_marks")
  exec(locker, "BEGIN IMMEDIATE")
  let nothingKept = runBounded { await ManifestRebuildGate.run(alreadyReady: true, steps: steps(db, calls: Calls())) }
  expect(nothingKept == .ready(rebuilt: false, promoted: 0, keptApplied: 0),
         "ready fast path with nothing kept needs no write: ready even under a lock (got \(String(describing: nothingKept)))")
  exec(locker, "ROLLBACK")
  sqlite3_close_v2(locker)
  sqlite3_close_v2(db)
}

// MARK: - 5. Other failures on the path defer too; an empty map is a valid answer

struct Offline: Error {}

do {
  let (db, _) = freshManifest("fetch-fail.db")
  let calls = Calls()
  let o = runBounded {
    await ManifestRebuildGate.run(alreadyReady: false, steps: steps(db, calls: calls, fetch: { throw Offline() }))
  }
  expect(o == .deferred(.fetchFailed), "fetch throws: deferred(fetchFailed) (got \(String(describing: o)))")
  expect(calls.applyMap == 0 && pending(db) == 5, "fetch throws: nothing applied")

  let switched = runBounded {
    await ManifestRebuildGate.run(alreadyReady: false, steps: steps(db, calls: Calls(), current: { false }))
  }
  expect(switched == .deferred(.accountChanged), "account changed during fetch: deferred (got \(String(describing: switched)))")

  let noDevice = runBounded {
    await ManifestRebuildGate.run(alreadyReady: false, steps: steps(db, calls: Calls(), deviceId: nil))
  }
  expect(noDevice == .deferred(.noDeviceId), "no device id: deferred (got \(String(describing: noDevice)))")
  expect(pending(db) == 5, "none of these promoted anything")

  let empty = runBounded {
    await ManifestRebuildGate.run(alreadyReady: false, steps: steps(db, calls: Calls(), fetch: { [:] }))
  }
  expect(empty == .ready(rebuilt: true, promoted: 0, keptApplied: 1),
         "an empty server map that APPLIED is ready (got \(String(describing: empty)))")
  sqlite3_close_v2(db)
}

// MARK: - 6. Control: the pre-round-4 shape is caught by this harness

do {
  let (db, path) = freshManifest("control.db")
  let locker = open(path)
  let o = runBounded {
    await ManifestRebuildGate.run(alreadyReady: false, steps: steps(db, calls: Calls(), fetch: {
      exec(locker, "BEGIN IMMEDIATE")
      return serverMap
    }, legacyApply: true))
  }
  // What the old engine did: "ready" with nothing promoted -> every photo
  // queued for a second upload.
  expect(isReady(o) && pending(db) == 5,
         "control (failure read as 0): ready with all 5 photos still pending — the duplicate-upload shape (got \(String(describing: o)), \(pending(db)) pending)")
  exec(locker, "ROLLBACK")
  sqlite3_close_v2(locker)
  sqlite3_close_v2(db)
}

// MARK: - 7. Bounded backoff

do {
  let waits = (1...8).map { ManifestRebuildGate.databaseFailureBackoff(consecutiveFailures: $0) }
  expect(waits == [2, 4, 8, 16, 30, 30, 30, 30], "database backoff 2,4,8,16 then 30 s (got \(waits))")
  expect(ManifestRebuildGate.databaseFailureBackoff(consecutiveFailures: 0) == 2, "never zero")
  expect(ManifestRebuildGate.databaseFailureBackoff(consecutiveFailures: Int.max) == 30, "never above 30 s")
  expect(ManifestRebuildGate.backoff(for: .fetchFailed, consecutiveFailures: 1) == 30, "fetch failure keeps its 30 s")
  expect(ManifestRebuildGate.backoff(for: .applyMapFailed, consecutiveFailures: 1) == 2, "a failed apply retries after 2 s")
  // Task 1667 round 12 (review item 7): was nil (a 5 s spin with no upload
  // until JS ran); now the fetch backoff, ended early when JS hands the id over.
  expect(ManifestRebuildGate.backoff(for: .noDeviceId, consecutiveFailures: 3) == 30, "no device id: 30 s backoff, not a 5 s spin")
  expect(ManifestRebuildGate.backoff(for: .accountChanged, consecutiveFailures: 3) == nil, "account changed: no backoff")
}

// MARK: - Report

if failures.isEmpty {
  print("ManifestRebuildGateTests: \(total) assertions, 0 failed")
  exit(0)
} else {
  for f in failures { print("FAIL: \(f)") }
  print("ManifestRebuildGateTests: \(failures.count) of \(total) assertions FAILED")
  exit(1)
}
