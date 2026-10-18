import Darwin
import Foundation
import SQLite3

// Task 1667 round 14 (review of mobile#182 at 18312919, the P1: "server-
// completed but unrecorded uploads must survive sign-out"). Standalone swiftc
// test, compiled with the REAL shipped sources (BackupManifestStore.swift,
// ManifestRebuildGate.swift, SignOutMarkFlush.swift, ManifestWriteFence.swift)
// by scripts/swift-ci/run-swift-tests.sh, against a real SQLite file.
//
// The gap: a row in 'staged_upload' / 'uploading' with remote_file_id and
// upload_session_id may already be complete on the server (the complete
// response was lost, or the sign-out's stop() cancelled the batch after it
// sent complete). The sign-out flush read only 'uploaded' rows, the staged
// purge cleared the row's ids, the reset deleted it, and at the next sign-in
// /identifiers and /check both said "needs backup": the photo uploaded twice.
//
// The engine cannot compile standalone. Its calls are modelled here exactly
// as NativeBackupEngine makes them (each model names the engine function):
//   flushServerMarksForSignOut -> SignOutMarkFlush.run + settleInFlight
//   prepareForStoragePurge     -> keepInFlightUploads, purgeAllStagedAssets
//                                 (clearStagedStateForRestage's UPDATE), the
//                                 fence advance, resetInPlace
//   ensureManifestReadyForUploads -> ManifestRebuildGate.run with resolveKept
//                                 = KeptUploadResolution.run
//   inspectExistingUpload      -> FakeServer.inspect (GET /files/{id}:
//                                 is_uploading false = complete, 404 = gone)
//   processBatch               -> uploads every pending row (FakeServer.upload)
// The wiring of those calls is pinned by native-backup-manifest-wiring.test.ts.
//
// (a) complete on the server, response lost, sign-out ONLINE: marked on the server.
// (b) the same OFFLINE: kept, then resolved at sign-in: no second upload.
// (c) NOT complete on the server: uploaded again, exactly once.
// (d) another account never sees (or asks about) A's kept entries.
// plus: discard / expiry / failed-reset carry / upgrade / budget.

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

func runBounded<T>(watchdog: TimeInterval = 15, _ op: @escaping () async -> T) -> T? {
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
let root = fm.temporaryDirectory.appendingPathComponent("bb-1667-r14-\(UUID().uuidString)", isDirectory: true)
try! fm.createDirectory(at: root, withIntermediateDirectories: true)
defer { try? fm.removeItem(at: root) }

// NativeBackupEngine.ensureTables (the columns these statements touch).
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

let now: Int64 = 1_800_000_000_000
let day: Int64 = 24 * 60 * 60 * 1000
let A = "acct-A"
let B = "acct-B"
let photos = ["x1", "u1", "p2"]

struct Unreachable: Error {}

/// The server, per account: files (complete or still uploading), the
/// per-device photo-backup map (marks), and counters.
final class FakeServer {
  /// fileId -> (owner, complete)
  var files: [String: (owner: String, complete: Bool)] = [:]
  /// account -> local id -> file id (photo_backup_state)
  var marks: [String: [String: String]] = [:]
  var filesOnline = true
  var marksOnline = true
  var mapOnline = true
  var inspects: [String] = []
  /// account -> local id -> how many times it was uploaded
  var uploads: [String: [String: Int]] = [:]
  private var nextFile = 100

  /// GET /api/v1/files/{id}: true = `is_uploading` false; 404 (another
  /// account's or no file) = not complete.
  func inspect(account: String, fileId: String) throws -> Bool {
    inspects.append(fileId)
    guard filesOnline else { throw Unreachable() }
    guard let f = files[fileId], f.owner == account else { return false }
    return f.complete
  }

  func mark(account: String, assetId: String, fileId: String) -> Bool {
    guard marksOnline else { return false }
    marks[account, default: [:]][assetId] = fileId
    return true
  }

  func identifiers(account: String) throws -> [String: String] {
    guard mapOnline else { throw Unreachable() }
    return marks[account] ?? [:]
  }

  func upload(account: String, assetId: String) -> String {
    nextFile += 1
    let fileId = "f-new-\(nextFile)"
    files[fileId] = (account, true)
    uploads[account, default: [:]][assetId, default: 0] += 1
    return fileId
  }

  func uploadCount(_ account: String, _ assetId: String) -> Int { uploads[account]?[assetId] ?? 0 }
}

/// One device: the manifest file and the engine's write fence.
final class Device {
  let db: OpaquePointer
  let fence = ManifestWriteFence()
  let queue = DispatchQueue(label: "dbQueue")
  init(_ name: String) {
    db = open(root.appendingPathComponent(name).path)
    exec(db, schema)
    BackupManifestStore.migrate(db)
  }
}

/// A's manifest before the sign-out:
/// - x1: its upload/complete reached the server, the response was lost:
///   markFailed made it 'staged_upload' and kept remote_file_id + the session
///   (the review's failure scenario (a)); staged by A;
/// - u1: uploaded, recorded, not yet marked on the server;
/// - p2: never uploaded.
func seedA(_ d: Device, server: FakeServer, x1Complete: Bool = true) {
  exec(d.db, """
  INSERT INTO backup_assets (local_asset_id, remote_file_id, created_at, asset_type, status, retry_count,
                             staged_file_id, staged_dir, upload_session_id, staged_account_id)
  VALUES ('x1', 'f-x1', '2026-10-18T00:00:00Z', 'photo', 'staged_upload', 1, 'sf-x1', '/staging/sf-x1', 's-x1', '\(A)');
  INSERT INTO backup_assets (local_asset_id, remote_file_id, created_at, uploaded_at, asset_type, status, uploaded_account_id)
  VALUES ('u1', 'f-u1', '2026-10-18T00:00:00Z', '2026-10-18T01:00:00Z', 'photo', 'uploaded', '\(A)');
  INSERT INTO backup_assets (local_asset_id, created_at, asset_type, status)
  VALUES ('p2', '2026-10-18T00:00:00Z', 'photo', 'pending_upload');
  """)
  server.files["f-x1"] = (A, x1Complete)
  server.files["f-u1"] = (A, true)
}

/// NativeBackupEngine.markOnServer (POST /photo-backup/mark, then the fenced
/// `server_marked_at` record).
func markOnServer(_ d: Device, _ server: FakeServer, ticket: ManifestWriteFence.Ticket, account: String,
                  assetId: String, fileId: String) -> Bool {
  guard server.mark(account: account, assetId: assetId, fileId: fileId) else { return false }
  d.queue.sync {
    _ = FencedManifestWrites.recordServerMarked(d.db, fence: d.fence, ticket: ticket, assetId: assetId, fileId: fileId, nowMs: now)
  }
  return true
}

/// NativeBackupEngine.flushServerMarksForSignOut, as wired in round 14.
func signOutFlush(_ d: Device, _ server: FakeServer, account: String, deadline: TimeInterval = 3,
                  slowInspect: TimeInterval = 0) -> SignOutMarkFlush.Outcome? {
  guard let ticket = d.queue.sync(execute: { d.fence.issue(for: account) }) else { return nil }
  return runBounded {
    await SignOutMarkFlush.run(
      deadline: deadline,
      attemptsPerRow: 1,
      loadRows: { () -> [SignOutMarkFlush.Row] in
        d.queue.sync {
          let loaded = FencedManifestWrites.loadSignOutMarks(d.db, fence: d.fence, ticket: ticket, accountId: account)
          let inFlight = FencedManifestWrites.loadSignOutInFlight(d.db, fence: d.fence, ticket: ticket, accountId: account)
          return (loaded.rows ?? []).map { SignOutMarkFlush.Row.unmarked(assetId: $0.assetId, fileId: $0.fileId) }
            + (inFlight ?? []).map { SignOutMarkFlush.Row.inFlight(assetId: $0.assetId, fileId: $0.fileId) }
        }
      },
      mark: { row, _ in
        switch row {
        case let .unmarked(assetId, fileId):
          return markOnServer(d, server, ticket: ticket, account: account, assetId: assetId, fileId: fileId)
        case let .inFlight(assetId, fileId):
          return await SignOutMarkFlush.settleInFlight(
            isComplete: {
              if slowInspect > 0 { try await Task.sleep(nanoseconds: UInt64(slowInspect * 1_000_000_000)) }
              return try server.inspect(account: account, fileId: fileId)
            },
            recordUploaded: {
              d.queue.sync {
                FencedManifestWrites.recordInFlightComplete(
                  d.db, fence: d.fence, ticket: ticket, accountId: account,
                  assetId: assetId, fileId: fileId, uploadedAtIso: "2026-10-18T05:00:00Z"
                )
              }
            },
            mark: { markOnServer(d, server, ticket: ticket, account: account, assetId: assetId, fileId: fileId) }
          )
        }
      }
    )
  }
}

/// NativeBackupEngine.prepareForStoragePurge, in its order: keep the
/// in-flight uploads, the staged purge (clearStagedStateForRestage's UPDATE
/// on every staged row), the fence advance + reset (resetForSignOut).
@discardableResult
func signOutPurge(_ d: Device, discard: BackupManifestStore.MarkDiscard = .none, keepInFlight: Bool = true) -> Bool {
  d.queue.sync {
    if keepInFlight { _ = BackupManifestStore.keepInFlightUploads(d.db, nowMs: now) }
    exec(d.db, """
    UPDATE backup_assets
       SET status = 'pending_reupload', remote_file_id = NULL, upload_session_id = NULL,
           staged_file_id = NULL, staged_dir = NULL, staged_at = NULL
     WHERE staged_file_id IS NOT NULL
    """)
    d.fence.advanceForSignOut()
    return BackupManifestStore.resetInPlace(d.db, nowMs: now, discard: discard)
  }
}

/// A sign-in: bind, the scan inserts every photo as pending.
func signIn(_ d: Device, account: String) -> ManifestWriteFence.Ticket {
  d.queue.sync { d.fence.bind(accountId: account) }
  let ticket = d.queue.sync { d.fence.issue(for: account) }!
  let assets = photos.map { BackupManifestStore.ScannedAsset(localAssetId: $0, createdAt: "2026-10-18T00:00:00Z", assetType: "photo") }
  let w = d.queue.sync {
    FencedManifestWrites.scanInsert(d.db, fence: d.fence, ticket: ticket, writer: "scan", assets: assets, selection: nil, nowMs: now)
  }
  if case .written(inserted: true, _) = w {} else { preconditionFailure("scan insert \(w)") }
  return ticket
}

/// NativeBackupEngine.ensureManifestReadyForUploads, as wired in round 14.
func gate(_ d: Device, _ server: FakeServer, account: String, ticket: ManifestWriteFence.Ticket,
          alreadyReady: Bool = false, resolve: Bool = true) -> ManifestRebuildGate.Outcome? {
  var steps = ManifestRebuildGate.Steps(
    needsRebuild: {
      d.queue.sync {
        FencedManifestWrites.needsRebuild(d.db, fence: d.fence, ticket: ticket, accountId: account, scanInsertFailed: false, nowMs: now)
      }
    },
    hasDeviceId: { true },
    fetchMap: { try server.identifiers(account: account) },
    isStillCurrent: { true },
    applyMap: { map in
      d.queue.sync {
        FencedManifestWrites.applyServerMap(d.db, fence: d.fence, ticket: ticket, accountId: account, map: map,
                                            uploadedAtIso: "2026-10-18T06:00:00Z", nowMs: now)
      }
    },
    applyKept: { d.queue.sync { FencedManifestWrites.applyKept(d.db, fence: d.fence, ticket: ticket, accountId: account, nowMs: now) } }
  )
  if resolve {
    steps.resolveKept = {
      await KeptUploadResolution.run(
        load: { d.queue.sync { FencedManifestWrites.loadKeptInFlight(d.db, fence: d.fence, ticket: ticket, accountId: account, nowMs: now) } },
        ask: { row in try server.inspect(account: account, fileId: row.fileId) },
        record: { row, complete in
          d.queue.sync {
            FencedManifestWrites.resolveKeptInFlight(d.db, fence: d.fence, ticket: ticket, accountId: account, row: row, complete: complete)
          }
        }
      )
    }
  }
  return runBounded { await ManifestRebuildGate.run(alreadyReady: alreadyReady, steps: steps) }
}

/// NativeBackupEngine.processBatch after a ready gate: every pending row is
/// uploaded (a new server file) and recorded. Returns the uploaded ids.
func batch(_ d: Device, _ server: FakeServer, account: String) -> [String] {
  let pending: [String] = d.queue.sync {
    var out: [String] = []
    var stmt: OpaquePointer?
    sqlite3_prepare_v2(d.db, "SELECT local_asset_id FROM backup_assets WHERE status IN ('pending_upload', 'pending_reupload') ORDER BY local_asset_id", -1, &stmt, nil)
    while sqlite3_step(stmt) == SQLITE_ROW { out.append(String(cString: sqlite3_column_text(stmt, 0))) }
    sqlite3_finalize(stmt)
    return out
  }
  for id in pending {
    let fileId = server.upload(account: account, assetId: id)
    d.queue.sync {
      _ = BackupManifestStore.markUploaded(d.db, assetId: id, remoteFileId: fileId, accountId: account, uploadedAtIso: "2026-10-18T07:00:00Z")
    }
  }
  return pending
}

/// NativeBackupEngine.flushServerMarks (the scan's catch-up).
func catchUp(_ d: Device, _ server: FakeServer, account: String, ticket: ManifestWriteFence.Ticket) {
  let rows = d.queue.sync { BackupManifestStore.pendingServerMarks(d.db, accountId: account, limit: 300) } ?? []
  for r in rows { _ = markOnServer(d, server, ticket: ticket, account: account, assetId: r.assetId, fileId: r.fileId) }
}

func kept(_ d: Device, _ account: String, resolution: Int) -> Int {
  scalar(d.db, "SELECT COUNT(*) FROM backup_pending_marks WHERE account_id = '\(account)' AND needs_resolution = \(resolution)")
}

func status(_ d: Device, _ id: String) -> String {
  text(d.db, "SELECT status || ':' || COALESCE(remote_file_id, '') || ':' || COALESCE(uploaded_account_id, '') FROM backup_assets WHERE local_asset_id = '\(id)'") ?? "none"
}

// MARK: - (a) complete on the server, response lost, sign-out ONLINE

do {
  let d = Device("a.db")
  let server = FakeServer()
  _ = d.queue.sync { d.fence.bind(accountId: A) }
  seedA(d, server: server)
  let outcome = signOutFlush(d, server, account: A)
  expect(outcome?.candidates == 2 && outcome?.marked == 2,
         "a.1 the flush settles u1 and the in-flight x1 (got \(String(describing: outcome)))")
  expect(server.marks[A]?["x1"] == "f-x1", "a.2 x1 is marked on the server with its file f-x1 (got \(String(describing: server.marks[A])))")
  expect(server.inspects == ["f-x1"], "a.3 one GET /files/f-x1 (got \(server.inspects))")
  expect(status(d, "x1") == "uploaded:f-x1:\(A)", "a.4 x1 recorded as uploaded by A (got \(status(d, "x1")))")
  expect(signOutPurge(d), "a.5 the sign-out reset succeeds")
  expect(kept(d, A, resolution: 1) == 0 && kept(d, A, resolution: 0) == 0,
         "a.6 nothing left to resolve or mark: the server has both (got \(kept(d, A, resolution: 1))/\(kept(d, A, resolution: 0)))")
  // A signs in again on this device.
  let t = signIn(d, account: A)
  let g = gate(d, server, account: A, ticket: t)
  expect(g == .ready(rebuilt: true, promoted: 2, keptApplied: 0), "a.7 the rebuild promotes x1 and u1 from the server map (got \(String(describing: g)))")
  let up = batch(d, server, account: A)
  expect(up == ["p2"], "a.8 only p2 uploads (got \(up))")
  expect(server.uploadCount(A, "x1") == 0, "a.9 x1 is NOT uploaded a second time")
}

// MARK: - (b) the same OFFLINE: kept, resolved at the next sign-in

do {
  let d = Device("b.db")
  let server = FakeServer()
  _ = d.queue.sync { d.fence.bind(accountId: A) }
  seedA(d, server: server)
  server.filesOnline = false
  server.marksOnline = false
  let outcome = signOutFlush(d, server, account: A)
  expect(outcome?.marked == 0, "b.1 offline: the flush marks nothing (got \(String(describing: outcome)))")
  expect(signOutPurge(d), "b.2 the sign-out reset succeeds")
  expect(kept(d, A, resolution: 1) == 1, "b.3 x1 is kept for resolution (got \(kept(d, A, resolution: 1)))")
  expect(text(d.db, "SELECT remote_file_id FROM backup_pending_marks WHERE local_asset_id = 'x1'") == "f-x1",
         "b.4 kept with its server file id (taken before the staged purge cleared it)")
  expect(kept(d, A, resolution: 0) == 1, "b.5 u1 is kept as an ordinary mark")
  expect(scalar(d.db, "SELECT COUNT(*) FROM backup_assets") == 0, "b.6 the manifest itself is empty")
  // (b2) A signs in while GET /files still fails: nothing uploads.
  server.marksOnline = true
  var t = signIn(d, account: A)
  var g = gate(d, server, account: A, ticket: t)
  expect(g == .deferred(.resolveKeptFailed), "b.7 GET /files unreachable at sign-in: the gate defers (got \(String(describing: g)))")
  expect(ManifestRebuildGate.backoff(for: .resolveKeptFailed, consecutiveFailures: 1) == 30, "b.8 30 s backoff, like a failed fetch")
  expect(kept(d, A, resolution: 1) == 1, "b.9 x1 is still kept, unresolved")
  expect(server.uploadCount(A, "x1") == 0, "b.10 nothing uploaded while unresolved")
  var pause = ServerCheckPause()
  expect(pause.recordRebuild(.resolveKeptFailed, lacksBackedUp: false) && pause.cause == .checkFailed,
         "b.11 the surfaces say 'paused, could not check'")
  // Online: resolved, promoted, marked, never uploaded again.
  server.filesOnline = true
  t = signIn(d, account: A)
  g = gate(d, server, account: A, ticket: t)
  expect(g == .ready(rebuilt: true, promoted: 0, keptApplied: 2), "b.12 resolved: x1 and u1 applied as kept marks (got \(String(describing: g)))")
  expect(status(d, "x1") == "uploaded:f-x1:\(A)", "b.13 x1 is uploaded with f-x1 (got \(status(d, "x1")))")
  expect(kept(d, A, resolution: 1) == 0 && kept(d, A, resolution: 0) == 0, "b.14 the kept rows are consumed")
  let up = batch(d, server, account: A)
  expect(up == ["p2"], "b.15 only p2 uploads (got \(up))")
  expect(server.uploadCount(A, "x1") == 0, "b.16 x1 is NOT uploaded a second time")
  catchUp(d, server, account: A, ticket: t)
  expect(server.marks[A]?["x1"] == "f-x1", "b.17 the catch-up marks x1 on the server")
  // The next batch asks nothing again.
  let before = server.inspects.count
  g = gate(d, server, account: A, ticket: t, alreadyReady: true)
  expect(g == .ready(rebuilt: false, promoted: 0, keptApplied: 0) && server.inspects.count == before,
         "b.18 the next gate pass has nothing to resolve (got \(String(describing: g)), \(server.inspects.count - before) GETs)")
}

// MARK: - (c) NOT complete on the server: uploaded again, exactly once

for (label, complete, onlineAtSignOut) in [("c1 still uploading, offline", false, false),
                                           ("c2 still uploading, online", false, true)] {
  let d = Device("\(label.prefix(2)).db")
  let server = FakeServer()
  _ = d.queue.sync { d.fence.bind(accountId: A) }
  seedA(d, server: server, x1Complete: complete)
  server.filesOnline = onlineAtSignOut
  server.marksOnline = onlineAtSignOut
  _ = signOutFlush(d, server, account: A)
  expect(server.marks[A]?["x1"] == nil, "\(label): x1 is never marked")
  expect(signOutPurge(d), "\(label): reset")
  expect(kept(d, A, resolution: 1) == 1, "\(label): x1 kept for resolution")
  server.filesOnline = true
  server.marksOnline = true
  let t = signIn(d, account: A)
  let g = gate(d, server, account: A, ticket: t)
  expect(g != nil && g != .deferred(.resolveKeptFailed), "\(label): resolved (got \(String(describing: g)))")
  expect(kept(d, A, resolution: 1) == 0, "\(label): the unresolved row is dropped")
  expect(status(d, "x1").hasPrefix("pending_upload"), "\(label): x1 is pending (got \(status(d, "x1")))")
  let up = batch(d, server, account: A)
  expect(up.contains("x1"), "\(label): x1 uploads")
  _ = gate(d, server, account: A, ticket: t, alreadyReady: true)
  let again = batch(d, server, account: A)
  expect(again.isEmpty && server.uploadCount(A, "x1") == 1, "\(label): x1 uploaded exactly once (got \(server.uploadCount(A, "x1")))")
}

do {
  // c3: 404 (the server has no such file for A): not complete.
  let d = Device("c3.db")
  let server = FakeServer()
  _ = d.queue.sync { d.fence.bind(accountId: A) }
  seedA(d, server: server)
  server.files["f-x1"] = nil
  server.filesOnline = false
  server.marksOnline = false
  _ = signOutFlush(d, server, account: A)
  signOutPurge(d)
  server.filesOnline = true
  server.marksOnline = true
  let t = signIn(d, account: A)
  _ = gate(d, server, account: A, ticket: t)
  _ = batch(d, server, account: A)
  expect(server.uploadCount(A, "x1") == 1 && kept(d, A, resolution: 1) == 0, "c3: a 404 is not complete: x1 uploads once")
}

// MARK: - (d) another account never sees A's kept entries

do {
  let d = Device("d.db")
  let server = FakeServer()
  _ = d.queue.sync { d.fence.bind(accountId: A) }
  seedA(d, server: server)
  server.filesOnline = false
  server.marksOnline = false
  _ = signOutFlush(d, server, account: A)
  signOutPurge(d)
  server.filesOnline = true
  server.marksOnline = true
  expect(kept(d, A, resolution: 1) == 1, "d.0 A's x1 kept")
  let tB = signIn(d, account: B)
  let gB = gate(d, server, account: B, ticket: tB)
  expect(gB == .ready(rebuilt: true, promoted: 0, keptApplied: 0), "d.1 B's gate is ready with nothing of A's (got \(String(describing: gB)))")
  expect(server.inspects.isEmpty, "d.2 B never asks about A's file (got \(server.inspects))")
  expect(kept(d, A, resolution: 1) == 1, "d.3 A's kept entry is untouched by B")
  expect(scalar(d.db, "SELECT COUNT(*) FROM backup_assets WHERE remote_file_id = 'f-x1'") == 0, "d.4 A's file id never lands in B's manifest")
  expect(d.queue.sync { BackupManifestStore.keptInFlight(d.db, accountId: B, nowMs: now) } == [], "d.5 B's load returns none")
  // A store-level write for B never resolves A's row either.
  expect(d.queue.sync { BackupManifestStore.resolveKeptInFlight(d.db, accountId: B, assetId: "x1", fileId: "f-x1", complete: true) },
         "d.6 B's resolve runs")
  expect(kept(d, A, resolution: 1) == 1, "d.7 and leaves A's unresolved row alone")
  // B signs out; A comes back and is resolved as in (b).
  _ = batch(d, server, account: B)
  signOutPurge(d)
  let tA = signIn(d, account: A)
  _ = gate(d, server, account: A, ticket: tA)
  _ = batch(d, server, account: A)
  expect(server.uploadCount(A, "x1") == 0 && status(d, "x1") == "uploaded:f-x1:\(A)",
         "d.8 A, back on the device, gets x1 resolved and does not upload it (got \(status(d, "x1")))")
}

// MARK: - (e) an unresolved row is never promoted as a mark

do {
  let d = Device("e.db")
  _ = d.queue.sync { d.fence.bind(accountId: A) }
  exec(d.db, """
  INSERT INTO backup_assets (local_asset_id, created_at, asset_type, status) VALUES ('x1', '2026-10-18T00:00:00Z', 'photo', 'pending_upload');
  INSERT INTO backup_pending_marks (account_id, local_asset_id, remote_file_id, created_at_ms, needs_resolution)
  VALUES ('\(A)', 'x1', 'f-x1', \(now), 1);
  """)
  let promoted = BackupManifestStore.applyPendingMarks(d.db, accountId: A, nowMs: now)
  expect(promoted == 0, "e.1 applyPendingMarks promotes 0 unresolved rows (got \(String(describing: promoted)))")
  expect(status(d, "x1").hasPrefix("pending_upload"), "e.2 x1 stays pending until resolved (got \(status(d, "x1")))")
  expect(kept(d, A, resolution: 1) == 1, "e.3 the unresolved row is not consumed")
}

// MARK: - (f) discard and expiry apply to the unresolved rows too

do {
  for (label, discard) in [("f1 A deleted (named)", BackupManifestStore.MarkDiscard(accountIds: [A], all: false)),
                           ("f2 deletion, no account known", BackupManifestStore.MarkDiscard.everything)] {
    let d = Device("\(label.prefix(2)).db")
    let server = FakeServer()
    _ = d.queue.sync { d.fence.bind(accountId: A) }
    seedA(d, server: server)
    exec(d.db, """
    INSERT INTO backup_pending_marks (account_id, local_asset_id, remote_file_id, created_at_ms, needs_resolution)
    VALUES ('\(B)', 'pb', 'f-pb', \(now - day), 1)
    """)
    expect(signOutPurge(d, discard: discard), "\(label): reset")
    expect(kept(d, A, resolution: 1) == 0 && kept(d, A, resolution: 0) == 0, "\(label): nothing of A is kept")
    expect(kept(d, B, resolution: 1) == (discard.all ? 0 : 1), "\(label): B's unresolved row \(discard.all ? "goes too" : "stays")")
  }
  // f3: the reset alone (no capture before the purge, e.g. a row the staged
  // purge did not touch) still keeps an in-flight row, minus a discarded account.
  let d = Device("f3.db")
  exec(d.db, """
  INSERT INTO backup_assets (local_asset_id, remote_file_id, created_at, asset_type, status, upload_session_id, staged_account_id)
  VALUES ('ia', 'f-ia', '2026-10-18T00:00:00Z', 'photo', 'uploading', 's-ia', '\(A)'),
         ('ib', 'f-ib', '2026-10-18T00:00:00Z', 'photo', 'uploading', 's-ib', '\(B)'),
         ('in', 'f-in', '2026-10-18T00:00:00Z', 'photo', 'uploading', NULL, '\(A)');
  """)
  expect(BackupManifestStore.resetInPlace(d.db, nowMs: now, discard: BackupManifestStore.MarkDiscard(accountIds: [B], all: false)),
         "f3.1 reset")
  expect(kept(d, A, resolution: 1) == 1 && kept(d, B, resolution: 1) == 0,
         "f3.2 the reset keeps A's in-flight row and none of the deleted B's (got A \(kept(d, A, resolution: 1)), B \(kept(d, B, resolution: 1)))")
  expect(scalar(d.db, "SELECT COUNT(*) FROM backup_pending_marks WHERE local_asset_id = 'in'") == 0,
         "f3.3 a row without an upload session is not kept (nothing can be complete)")
  // f4: 30-day expiry.
  exec(d.db, """
  INSERT INTO backup_pending_marks (account_id, local_asset_id, remote_file_id, created_at_ms, needs_resolution)
  VALUES ('\(A)', 'old', 'f-old', \(now - 31 * day), 1)
  """)
  expect(d.queue.sync { BackupManifestStore.keptInFlight(d.db, accountId: A, nowMs: now) }?.map(\.assetId) == ["ia"],
         "f4.1 an unresolved row past 30 days is not loaded")
  expect(BackupManifestStore.expirePendingMarks(d.db, nowMs: now) == 1, "f4.2 and the expiry deletes it")
}

// MARK: - (g) a confirmed mark wins over an unresolved row of the same photo

do {
  let d = Device("g.db")
  exec(d.db, """
  INSERT INTO backup_assets (local_asset_id, remote_file_id, created_at, asset_type, status, upload_session_id, staged_account_id)
  VALUES ('x1', 'f-x1-new', '2026-10-18T00:00:00Z', 'photo', 'uploading', 's-new', '\(A)');
  INSERT INTO backup_pending_marks (account_id, local_asset_id, remote_file_id, created_at_ms, needs_resolution)
  VALUES ('\(A)', 'x1', 'f-x1-confirmed', \(now - day), 0);
  """)
  _ = BackupManifestStore.keepInFlightUploads(d.db, nowMs: now)
  expect(text(d.db, "SELECT remote_file_id || ':' || needs_resolution FROM backup_pending_marks WHERE local_asset_id = 'x1'") == "f-x1-confirmed:0",
         "g.1 an in-flight row never replaces a confirmed mark")
  exec(d.db, "UPDATE backup_pending_marks SET needs_resolution = 1, remote_file_id = 'f-x1-old'")
  _ = BackupManifestStore.keepInFlightUploads(d.db, nowMs: now)
  expect(text(d.db, "SELECT remote_file_id || ':' || needs_resolution FROM backup_pending_marks WHERE local_asset_id = 'x1'") == "f-x1-new:1",
         "g.2 a newer in-flight upload replaces an older unresolved row")
}

// MARK: - (h) the failed-reset carry keeps the flag

do {
  let d = Device("h.db")
  exec(d.db, """
  INSERT INTO backup_assets (local_asset_id, remote_file_id, created_at, asset_type, status, upload_session_id, staged_account_id)
  VALUES ('ia', 'f-ia', '2026-10-18T00:00:00Z', 'photo', 'staged_upload', 's-ia', '\(A)');
  INSERT INTO backup_assets (local_asset_id, remote_file_id, created_at, asset_type, status, uploaded_account_id)
  VALUES ('ua', 'f-ua', '2026-10-18T00:00:00Z', 'photo', 'uploaded', '\(A)');
  INSERT INTO backup_pending_marks (account_id, local_asset_id, remote_file_id, created_at_ms, needs_resolution)
  VALUES ('\(A)', 'ka', 'f-ka', \(now - day), 1);
  """)
  let snap = BackupManifestStore.pendingMarksSnapshot(d.db, nowMs: now) ?? []
  let byId = Dictionary(uniqueKeysWithValues: snap.map { ($0.assetId, $0.needsResolution) })
  expect(byId == ["ia": true, "ua": false, "ka": true], "h.1 the snapshot carries the flag of every row (got \(byId))")
  let fresh = Device("h-fresh.db")
  expect(BackupManifestStore.insertPendingMarks(fresh.db, snap), "h.2 written into the replacement")
  expect(kept(fresh, A, resolution: 1) == 2 && kept(fresh, A, resolution: 0) == 1, "h.3 two unresolved, one confirmed in the new file")
  exec(fresh.db, """
  INSERT INTO backup_assets (local_asset_id, created_at, asset_type, status)
  VALUES ('ia', '2026-10-18T00:00:00Z', 'photo', 'pending_upload'), ('ua', '2026-10-18T00:00:00Z', 'photo', 'pending_upload'),
         ('ka', '2026-10-18T00:00:00Z', 'photo', 'pending_upload')
  """)
  expect(BackupManifestStore.applyPendingMarks(fresh.db, accountId: A, nowMs: now) == 1,
         "h.4 only the confirmed ua is promoted from the carried rows")
  expect(status(fresh, "ia").hasPrefix("pending_upload") && status(fresh, "ka").hasPrefix("pending_upload"),
         "h.5 the carried unresolved ia and ka stay pending until resolved")
}

// MARK: - (i) an older table gains the column

do {
  let path = root.appendingPathComponent("i.db").path
  let db = open(path)
  exec(db, schema)
  exec(db, """
  CREATE TABLE backup_pending_marks (account_id TEXT NOT NULL, local_asset_id TEXT NOT NULL, remote_file_id TEXT NOT NULL,
                                     created_at_ms INTEGER NOT NULL, PRIMARY KEY (account_id, local_asset_id));
  INSERT INTO backup_pending_marks VALUES ('\(A)', 'old-mark', 'f-om', \(now));
  INSERT INTO backup_assets (local_asset_id, created_at, asset_type, status) VALUES ('old-mark', '2026-10-18T00:00:00Z', 'photo', 'pending_upload');
  """)
  BackupManifestStore.migrate(db)
  expect(scalar(db, "SELECT COUNT(*) FROM backup_pending_marks WHERE needs_resolution = 0") == 1, "i.1 an earlier build's mark reads as confirmed")
  expect(BackupManifestStore.applyPendingMarks(db, accountId: A, nowMs: now) == 1, "i.2 and is promoted as before")
  sqlite3_close_v2(db)
}

// MARK: - (j) the flush budget holds with a stalled GET /files

do {
  let d = Device("j.db")
  let server = FakeServer()
  _ = d.queue.sync { d.fence.bind(accountId: A) }
  seedA(d, server: server)
  let start = Date()
  let outcome = signOutFlush(d, server, account: A, deadline: 1.0, slowInspect: 10)
  let elapsed = Date().timeIntervalSince(start)
  expect(elapsed < 1.5 && outcome?.timedOut == true, "j.1 a stalled GET does not hold sign-out past the deadline (took \(elapsed), \(String(describing: outcome)))")
  expect(signOutPurge(d), "j.2 reset")
  expect(kept(d, A, resolution: 1) == 1, "j.3 the unsettled x1 is kept for resolution")
}

// MARK: - (k) control: the round-13 shape loses x1 and uploads it twice

do {
  let d = Device("k.db")
  let server = FakeServer()
  _ = d.queue.sync { d.fence.bind(accountId: A) }
  seedA(d, server: server)
  server.filesOnline = false
  server.marksOnline = false
  _ = signOutFlush(d, server, account: A)
  signOutPurge(d, keepInFlight: false)
  // Round 13's reset had no in-flight keep; the staged purge already
  // cleared the ids, so this one finds nothing either.
  exec(d.db, "DELETE FROM backup_pending_marks WHERE needs_resolution = 1")
  server.filesOnline = true
  server.marksOnline = true
  let t = signIn(d, account: A)
  _ = gate(d, server, account: A, ticket: t, resolve: false)
  _ = batch(d, server, account: A)
  expect(server.uploadCount(A, "x1") == 1,
         "k.1 control: without the keep, x1 (complete on the server) uploads a SECOND time (got \(server.uploadCount(A, "x1")))")
}

// MARK: - Report

if failures.isEmpty {
  print("KeptInFlightUploadTests: \(total) assertions, 0 failed")
  exit(0)
} else {
  for f in failures { print("FAIL: \(f)") }
  print("KeptInFlightUploadTests: \(failures.count) of \(total) assertions FAILED")
  exit(1)
}
