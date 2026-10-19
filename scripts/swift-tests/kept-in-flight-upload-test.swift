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
//   prepareForStoragePurge     -> purgeAllStagedAssets (round 15: the shipped
//                                 BackupManifestStore.purgeAllStaged, which
//                                 keeps the in-flight uploads first), the
//                                 fence advance, resetInPlace
//   teardownAllBackup / disablePhotoBackup / the read-only stop (round 15)
//                              -> clearAccountAndPurgeStaged -> purgeAllStaged
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
// Round 15 (review of mobile#182 at dd97f2ac): (l) a forced 401 sign-out
// (teardown before the signed-out purge), (m) Camera Roll toggle-off, (n) the
// read-only stop, (o) only the API's own GET /files answer resolves a kept
// row (the shipped PhotoBackupServerResponses.existingUpload), (p) a trashed
// file is not backed up, (q) local vs server resolution failures and the
// pause, (r) one in-flight predicate.

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

  /// Round 15: files in the Trash (`is_trashed` true; still complete).
  var trashed: Set<String> = []
  /// Round 15: when set, GET /files/{id} answers exactly this (an edge page,
  /// an empty body, a 429, ...) instead of the API's answer.
  var httpOverride: (status: Int, contentType: String?, retryAfter: String?, body: String)?

  /// Round 15: GET /api/v1/files/{id} as HTTP: the API's own answer
  /// (server `get_file`: JSON with boolean is_uploading and is_trashed, or
  /// `ApiError::NotFound` = 404 {"error":"not found"}), unless overridden.
  func http(account: String, fileId: String) throws -> (status: Int, contentType: String?, retryAfter: String?, body: String) {
    inspects.append(fileId)
    guard filesOnline else { throw Unreachable() }
    if let httpOverride { return httpOverride }
    guard let f = files[fileId], f.owner == account else {
      return (404, "application/json", nil, #"{"error":"not found"}"#)
    }
    return (200, "application/json", nil,
            #"{"id":"\#(fileId)","is_uploading":\#(!f.complete),"is_trashed":\#(trashed.contains(fileId)),"is_folder":false}"#)
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

/// Round 15: NativeBackupEngine.clearAccountAndPurgeStaged ->
/// purgeAllStagedAssets, which is the SHIPPED `BackupManifestStore
/// .purgeAllStaged` (keep the in-flight uploads, then clear every staged
/// row). Every teardown runs it: teardownAllBackup (the provider unmount,
/// sign-out and forced 401 sign-out alike), disablePhotoBackup (the Camera
/// Roll toggle-off), the read-only stop, and prepareForStoragePurge.
@discardableResult
func stagedPurge(_ d: Device) -> (keptInFlight: Int?, purged: Int) {
  d.queue.sync {
    BackupManifestStore.purgeAllStaged(
      d.db, nowMs: now, error: "Re-encrypting: account signed out before upload completed", removeFiles: { _ in }
    )
  }
}

/// CONTROL ONLY: dd97f2ac's purgeAllStagedAssets (clearStagedStateForRestage
/// on every staged row, no keep), for the red/control runs.
func stagedPurgeDd97f2a(_ d: Device) {
  d.queue.sync {
    exec(d.db, """
    UPDATE backup_assets
       SET status = 'pending_reupload', remote_file_id = NULL, upload_session_id = NULL,
           staged_file_id = NULL, staged_dir = NULL, staged_at = NULL
     WHERE staged_file_id IS NOT NULL
    """)
  }
}

/// NativeBackupEngine.prepareForStoragePurge, in its order: the staged purge
/// (round 15: the shipped `purgeAllStaged`, which keeps the in-flight uploads
/// first), the fence advance + reset (resetForSignOut). `keepInFlight: false`
/// is the round-13 control (dd97f2ac's staged purge, no keep).
@discardableResult
func signOutPurge(_ d: Device, discard: BackupManifestStore.MarkDiscard = .none, keepInFlight: Bool = true) -> Bool {
  if keepInFlight { stagedPurge(d) } else { stagedPurgeDd97f2a(d) }
  return d.queue.sync {
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
          alreadyReady: Bool = false, resolve: Bool = true,
          ask: ((BackupManifestStore.KeptInFlight) throws -> Bool)? = nil) -> ManifestRebuildGate.Outcome? {
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
        ask: { row in try ask?(row) ?? server.inspect(account: account, fileId: row.fileId) },
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

// MARK: - Round 15 (review of mobile#182 at dd97f2ac)

/// The engine's `backoffUntil` for one device.
final class EngineBackoff { var until: Date? }

/// NativeBackupEngine.inspectExistingUpload (round 15) + the resolution's
/// `== .complete`: the shipped classifier reads the HTTP answer; a 429 sets
/// the backoff from Retry-After (60 s without one) and throws.
func engineAsk(_ server: FakeServer, account: String, backoff: EngineBackoff, clock: Date)
  -> (BackupManifestStore.KeptInFlight) throws -> Bool {
  return { row in
    let r = try server.http(account: account, fileId: row.fileId)
    do {
      return try PhotoBackupServerResponses.existingUpload(
        statusCode: r.status, contentType: r.contentType, retryAfter: r.retryAfter, data: Data(r.body.utf8)
      ) == .complete
    } catch let limited as PhotoBackupServerResponses.RateLimited {
      backoff.until = clock.addingTimeInterval(limited.retryAfter ?? 60)
      throw limited
    }
  }
}

/// NativeBackupEngine.ensureManifestReadyForUploads' deferred branch (round 15).
func engineDefer(_ outcome: ManifestRebuildGate.Outcome?, backoff: EngineBackoff, clock: Date, failures: Int = 1) {
  guard case let .deferred(reason)? = outcome,
        let wait = ManifestRebuildGate.backoff(for: reason, consecutiveFailures: failures) else { return }
  backoff.until = ManifestRebuildGate.backoffDeadline(existing: backoff.until, now: clock, wait: wait)
}

/// The in-flight x1 of A, its upload complete on the server, the response
/// lost (round 14's seed), signed-in A bound.
func deviceWithInFlightX1(_ name: String, x1Complete: Bool = true) -> (Device, FakeServer) {
  let d = Device(name)
  let server = FakeServer()
  _ = d.queue.sync { d.fence.bind(accountId: A) }
  seedA(d, server: server, x1Complete: x1Complete)
  return (d, server)
}

// MARK: - (l) P1 item 1: a forced 401 sign-out (teardown BEFORE the signed-out purge)

// Real call order on a forced sign-out (App.tsx registerSessionExpiredHandler
// -> setUser(null)): the CryptoProvider key changes, BackupProvider unmounts,
// its cleanup sends teardownAllBackup (stopBackupEngines) -> the engine's
// clearAccountAndPurgeStaged -> purgeAllStaged. THEN the signed-out effect's
// purge runs: no mark flush (the token is gone), prepareForStoragePurge ->
// clearAccountAndPurgeStaged again -> the fence advance + resetInPlace.
do {
  let (d, server) = deviceWithInFlightX1("l.db")
  // 1. The provider unmount's teardown.
  let teardown = stagedPurge(d)
  expect(teardown.keptInFlight == 1 && teardown.purged == 1,
         "l.1 the unmount teardown keeps x1 before clearing its ids (got kept \(String(describing: teardown.keptInFlight)), purged \(teardown.purged))")
  expect(text(d.db, "SELECT remote_file_id FROM backup_pending_marks WHERE local_asset_id = 'x1' AND needs_resolution = 1") == "f-x1",
         "l.2 kept with its server file id f-x1")
  expect(status(d, "x1") == "pending_reupload::", "l.3 the teardown cleared x1's ids (got \(status(d, "x1")))")
  // 2. The signed-out purge (no flush: the 401 already cleared the token).
  expect(signOutPurge(d), "l.4 the signed-out purge's reset succeeds")
  expect(kept(d, A, resolution: 1) == 1, "l.5 x1 survives the signed-out purge for resolution (got \(kept(d, A, resolution: 1)))")
  // 3. A signs in again: x1 is resolved complete, promoted, marked; 0 second uploads.
  let t = signIn(d, account: A)
  let g = gate(d, server, account: A, ticket: t)
  expect(g == .ready(rebuilt: true, promoted: 0, keptApplied: 2), "l.6 the gate resolves x1 and applies x1 + u1 (got \(String(describing: g)))")
  let up = batch(d, server, account: A)
  catchUp(d, server, account: A, ticket: t)
  expect(up == ["p2"], "l.7 only p2 uploads (got \(up))")
  expect(server.uploadCount(A, "x1") == 0, "l.8 x1 is NOT uploaded a second time (got \(server.uploadCount(A, "x1")))")
  expect(server.marks[A]?["x1"] == "f-x1", "l.9 x1 is marked on the server with f-x1")
}

// (l-control) dd97f2ac's order: the teardown's staged purge kept nothing, the
// signed-out purge's own keep (prepareForStoragePurge) then saw 0 rows with
// ids: x1 uploads a second time.
do {
  let (d, server) = deviceWithInFlightX1("l-control.db")
  stagedPurgeDd97f2a(d) // the unmount teardown at dd97f2ac
  _ = d.queue.sync { BackupManifestStore.keepInFlightUploads(d.db, nowMs: now) } // prepareForStoragePurge's keep at dd97f2ac
  stagedPurgeDd97f2a(d)
  _ = d.queue.sync { () -> Bool in d.fence.advanceForSignOut(); return BackupManifestStore.resetInPlace(d.db, nowMs: now) }
  let t = signIn(d, account: A)
  _ = gate(d, server, account: A, ticket: t)
  _ = batch(d, server, account: A)
  expect(server.uploadCount(A, "x1") == 1,
         "l.c control: dd97f2ac's teardown-first order uploads x1 a SECOND time (got \(server.uploadCount(A, "x1")))")
}

// MARK: - (m) P1 item 1: Camera Roll toggled off mid-complete, then re-enabled

// disablePhotoBackup -> stop() -> clearAccountAndPurgeStaged (Contacts and
// Calendar not bound). No sign-out: the manifest stays, the account stays.
// The re-enable binds the same account; the gate resolves the kept row before
// any upload (`alreadyReady` both ways: the engine keeps manifestReadyForAccount).
for alreadyReady in [true, false] {
  let label = "m(\(alreadyReady ? "ready" : "not-ready"))"
  let (d, server) = deviceWithInFlightX1("m-\(alreadyReady).db")
  stagedPurge(d)
  expect(kept(d, A, resolution: 1) == 1, "\(label).1 the toggle-off keeps x1 for resolution")
  expect(status(d, "x1") == "pending_reupload::", "\(label).2 x1 is queued again in the manifest (got \(status(d, "x1")))")
  // Re-enable: the engine binds A again (same fence generation: no sign-out).
  let t = d.queue.sync { d.fence.issue(for: A) }!
  let g = gate(d, server, account: A, ticket: t, alreadyReady: alreadyReady)
  if case .ready? = g {} else { expect(false, "\(label).3 the gate is ready (got \(String(describing: g)))") }
  expect(status(d, "x1") == "uploaded:f-x1:\(A)", "\(label).4 x1 is promoted with f-x1 before any upload (got \(status(d, "x1")))")
  let up = batch(d, server, account: A)
  expect(up == ["p2"], "\(label).5 only p2 uploads (got \(up))")
  expect(server.uploadCount(A, "x1") == 0, "\(label).6 x1 is NOT uploaded a second time")
}
do {
  let (d, server) = deviceWithInFlightX1("m-control.db")
  stagedPurgeDd97f2a(d)
  let t = d.queue.sync { d.fence.issue(for: A) }!
  _ = gate(d, server, account: A, ticket: t, alreadyReady: true)
  _ = batch(d, server, account: A)
  expect(server.uploadCount(A, "x1") == 1,
         "m.c control: dd97f2ac's toggle-off purge uploads x1 a SECOND time (got \(server.uploadCount(A, "x1")))")
}

// MARK: - (n) P1 item 1: the read-only stop, then writable again

// The account turns read-only: backup-context stops the engines
// (teardownAllBackup -> clearAccountAndPurgeStaged). Later it is writable
// again and backup starts for the same account; the first gate pass is
// OFFLINE (deferred, nothing uploads), the next one resolves.
do {
  let (d, server) = deviceWithInFlightX1("n.db")
  stagedPurge(d)
  expect(kept(d, A, resolution: 1) == 1, "n.1 the read-only stop keeps x1 for resolution")
  let t = d.queue.sync { d.fence.issue(for: A) }!
  server.filesOnline = false
  let g1 = gate(d, server, account: A, ticket: t, alreadyReady: true)
  expect(g1 == .deferred(.resolveKeptFailed), "n.2 offline: the gate defers (got \(String(describing: g1)))")
  expect(kept(d, A, resolution: 1) == 1, "n.3 x1 is still kept")
  server.filesOnline = true
  let g2 = gate(d, server, account: A, ticket: t, alreadyReady: true)
  if case .ready? = g2 {} else { expect(false, "n.4 online: ready (got \(String(describing: g2)))") }
  let up = batch(d, server, account: A)
  expect(up == ["p2"] && server.uploadCount(A, "x1") == 0, "n.5 x1 is not uploaded again (uploads \(up))")
}

// MARK: - (o) P1 item 2: only the API's own answer resolves a kept row

/// A kept x1 after an offline sign-out, then A's sign-in with GET /files
/// answering `answer`. Returns the gate outcome, whether x1 is still kept,
/// the backoff and x1's upload count after the batch (when ready).
func resolveWith(_ name: String, answer: (status: Int, contentType: String?, retryAfter: String?, body: String)?,
                 trashed: Bool = false, x1Complete: Bool = true)
  -> (gate: ManifestRebuildGate.Outcome?, stillKept: Bool, backoffSeconds: TimeInterval?, x1Uploads: Int, x1: String) {
  let (d, server) = deviceWithInFlightX1(name, x1Complete: x1Complete)
  server.filesOnline = false
  server.marksOnline = false
  _ = signOutFlush(d, server, account: A)
  signOutPurge(d)
  server.filesOnline = true
  server.marksOnline = true
  if trashed { server.trashed.insert("f-x1") }
  server.httpOverride = answer
  let clock = Date(timeIntervalSince1970: 1_800_000_000)
  let backoff = EngineBackoff()
  let t = signIn(d, account: A)
  let g = gate(d, server, account: A, ticket: t, ask: engineAsk(server, account: A, backoff: backoff, clock: clock))
  engineDefer(g, backoff: backoff, clock: clock)
  let stillKept = kept(d, A, resolution: 1) == 1
  if case .ready? = g { _ = batch(d, server, account: A) }
  return (g, stillKept, backoff.until.map { $0.timeIntervalSince(clock) }, server.uploadCount(A, "x1"), status(d, "x1"))
}

do {
  let html = resolveWith("o-html.db", answer: (404, "text/html", nil, "<html><body>404 Not Found</body></html>"))
  expect(html.gate == .deferred(.resolveKeptFailed), "o.1 HTML 404: the gate defers (got \(String(describing: html.gate)))")
  expect(html.stillKept, "o.2 HTML 404: x1 stays kept")
  expect(html.x1Uploads == 0, "o.3 HTML 404: x1 is not uploaded")

  let empty = resolveWith("o-empty.db", answer: (404, nil, nil, ""))
  expect(empty.gate == .deferred(.resolveKeptFailed), "o.4 empty 404: the gate defers (got \(String(describing: empty.gate)))")
  expect(empty.stillKept && empty.x1Uploads == 0, "o.5 empty 404: x1 stays kept, not uploaded")

  let jsonOther = resolveWith("o-json404.db", answer: (404, "application/json", nil, #"{"error":"not found","message":"route"}"#))
  expect(jsonOther.gate == .deferred(.resolveKeptFailed), "o.6 a 404 with another JSON shape defers")

  // The API's own 404 (x1 is not this account's file / gone): dropped, uploads once.
  let api404 = resolveWith("o-api404.db", answer: (404, "application/json; charset=utf-8", nil, #"{"error":"not found"}"#))
  if case .ready? = api404.gate {} else { expect(false, "o.7 API 404: ready (got \(String(describing: api404.gate)))") }
  expect(!api404.stillKept, "o.8 API 404: the kept row is dropped")
  expect(api404.x1Uploads == 1, "o.9 API 404: x1 uploads exactly once (got \(api404.x1Uploads))")

  let noFlag = resolveWith("o-noflag.db", answer: (200, "application/json", nil, #"{"id":"f-x1","is_trashed":false}"#))
  expect(noFlag.gate == .deferred(.resolveKeptFailed), "o.10 2xx without is_uploading: defers (got \(String(describing: noFlag.gate)))")
  expect(noFlag.stillKept && noFlag.x1Uploads == 0, "o.11 2xx without is_uploading: x1 stays kept, not uploaded")

  let numeric = resolveWith("o-numeric.db", answer: (200, "application/json", nil, #"{"is_uploading":0,"is_trashed":0}"#))
  expect(numeric.gate == .deferred(.resolveKeptFailed), "o.12 2xx with 0/1 instead of booleans: defers")

  let htmlOk = resolveWith("o-html200.db", answer: (200, "text/html", nil, "<html>captive portal</html>"))
  expect(htmlOk.gate == .deferred(.resolveKeptFailed), "o.13 an HTML 2xx: defers")

  let server5xx = resolveWith("o-503.db", answer: (503, "text/html", nil, "busy"))
  expect(server5xx.gate == .deferred(.resolveKeptFailed) && server5xx.backoffSeconds == 30,
         "o.14 503: defers with the 30 s fetch backoff (got \(String(describing: server5xx.backoffSeconds)))")

  let limited = resolveWith("o-429.db", answer: (429, "application/json", "120", #"{"error":"rate limited"}"#))
  expect(limited.gate == .deferred(.resolveKeptFailed), "o.15 429: defers")
  expect(limited.backoffSeconds == 120, "o.16 429 Retry-After: 120 is honoured, not overwritten with 30 s (got \(String(describing: limited.backoffSeconds)))")
  expect(limited.stillKept && limited.x1Uploads == 0, "o.17 429: x1 stays kept, not uploaded")

  let limitedNoHeader = resolveWith("o-429b.db", answer: (429, nil, nil, ""))
  expect(limitedNoHeader.backoffSeconds == 60, "o.18 429 without Retry-After: 60 s (got \(String(describing: limitedNoHeader.backoffSeconds)))")

  // The API's own answers still resolve.
  let complete = resolveWith("o-complete.db", answer: nil)
  if case .ready? = complete.gate {} else { expect(false, "o.19 API complete: ready") }
  expect(complete.x1Uploads == 0 && complete.x1 == "uploaded:f-x1:\(A)", "o.20 API complete: x1 promoted, 0 uploads (got \(complete.x1))")
  let uploading = resolveWith("o-uploading.db", answer: nil, x1Complete: false)
  expect(!uploading.stillKept && uploading.x1Uploads == 1, "o.21 API is_uploading true: dropped, x1 uploads once")
}

// The shipped classifier, one answer at a time.
do {
  func classify(_ status: Int, _ ct: String?, _ ra: String?, _ body: String) -> String {
    do {
      return "\(try PhotoBackupServerResponses.existingUpload(statusCode: status, contentType: ct, retryAfter: ra, data: Data(body.utf8)))"
    } catch let r as PhotoBackupServerResponses.RateLimited {
      return "rateLimited(\(r.retryAfter.map { "\($0)" } ?? "nil"))"
    } catch {
      return "throws"
    }
  }
  expect(classify(404, "text/html", nil, "<html/>") == "throws", "o.c1 HTML 404 throws")
  expect(classify(404, nil, nil, "") == "throws", "o.c2 empty 404 throws")
  expect(classify(404, "application/json", nil, #"{"error":"not found"}"#) == "gone", "o.c3 API 404 is gone")
  expect(classify(200, "application/json", nil, #"{"is_trashed":false}"#) == "throws", "o.c4 2xx without is_uploading throws")
  expect(classify(429, nil, "120", "") == "rateLimited(120.0)", "o.c5 429 Retry-After 120 (got \(classify(429, nil, "120", "")))")
  expect(classify(200, "application/json", nil, #"{"is_uploading":false,"is_trashed":false}"#) == "complete", "o.c6 complete")
  expect(classify(200, "application/json", nil, #"{"is_uploading":false,"is_trashed":true}"#) == "completeInTrash", "o.c7 complete in the Trash")
  expect(classify(200, "application/json", nil, #"{"is_uploading":true,"is_trashed":false}"#) == "uploading", "o.c8 uploading")
  expect(classify(500, "application/json", nil, #"{"error":"internal"}"#) == "throws", "o.c9 500 throws")
  expect(classify(200, "application/json", nil, #"[]"#) == "throws", "o.c10 a JSON array throws")
}

// MARK: - (p) P2 item 3: a trashed file is not backed up

do {
  let r = resolveWith("p.db", answer: nil, trashed: true)
  if case .ready? = r.gate {} else { expect(false, "p.1 ready (got \(String(describing: r.gate)))") }
  expect(!r.stillKept, "p.2 the kept row is dropped (not promoted as a mark)")
  expect(r.x1Uploads == 1, "p.3 x1 is queued and uploads once (got \(r.x1Uploads))")
  // The flush never marks a trashed in-flight upload either.
  let (d, server) = deviceWithInFlightX1("p-flush.db")
  server.trashed.insert("f-x1")
  let outcome = runBounded {
    await SignOutMarkFlush.settleInFlight(
      isComplete: {
        let h = try server.http(account: A, fileId: "f-x1")
        return try PhotoBackupServerResponses.existingUpload(
          statusCode: h.status, contentType: h.contentType, retryAfter: h.retryAfter, data: Data(h.body.utf8)
        ) == .complete
      },
      recordUploaded: { expect(false, "p.4 a trashed upload is not recorded as uploaded"); return true },
      mark: { expect(false, "p.5 a trashed upload is not marked"); return true }
    )
  }
  expect(outcome == true, "p.6 the flush settles it (nothing to mark)")
  expect(server.marks[A]?["x1"] == nil, "p.7 no mark for x1")
  expect(status(d, "x1").hasPrefix("staged_upload"), "p.8 x1 stays in flight, so the reset keeps it for resolution")
}

// MARK: - (q) P2 item 6: local failures vs server failures, and the pause

do {
  // A local failure: the load is fenced (the ticket is from before a sign-out).
  let (d, server) = deviceWithInFlightX1("q.db")
  server.filesOnline = false
  server.marksOnline = false
  _ = signOutFlush(d, server, account: A)
  signOutPurge(d)
  server.filesOnline = true
  server.marksOnline = true
  let t = signIn(d, account: A)
  // A stale ticket: another sign-out advanced the fence since it was issued.
  let stale = t
  _ = d.queue.sync { d.fence.advanceForSignOut() }
  _ = d.queue.sync { d.fence.bind(accountId: A) }
  server.inspects = []
  let gLocal = gate(d, server, account: A, ticket: stale, alreadyReady: true)
  expect(gLocal == .deferred(.resolveKeptStoreFailed), "q.1 a fenced load defers as a LOCAL failure (got \(String(describing: gLocal)))")
  expect(server.inspects.isEmpty, "q.2 no request was made (got \(server.inspects))")
  expect(ManifestRebuildGate.backoff(for: .resolveKeptStoreFailed, consecutiveFailures: 1) == 2,
         "q.3 the database backoff (2 s), not the 30 s fetch backoff")
  var pause = ServerCheckPause()
  expect(pause.recordGate(.deferred(.resolveKeptStoreFailed), lacksBackedUp: false) == false && pause.cause == nil,
         "q.4 a local failure shows NO server pause")
  // A server failure pauses; ANY later successful pass clears it.
  expect(pause.recordGate(.deferred(.resolveKeptFailed), lacksBackedUp: false) && pause.cause == .checkFailed,
         "q.5 a server failure shows the 'could not check' pause")
  expect(pause.recordGate(.ready(rebuilt: false, promoted: 0, keptApplied: 0), lacksBackedUp: false) && pause.cause == nil,
         "q.6 a successful pass that did not rebuild clears the pause")
  _ = pause.recordGate(.deferred(.fetchFailed), lacksBackedUp: false)
  expect(pause.recordGate(.ready(rebuilt: true, promoted: 1, keptApplied: 0), lacksBackedUp: false) && pause.cause == nil,
         "q.7 a rebuilding pass clears it too")
  // The record step failing (busy writer) is local as well.
  let rLocal = runBounded {
    await KeptUploadResolution.run(
      load: { [BackupManifestStore.KeptInFlight(assetId: "x1", fileId: "f-x1")] },
      ask: { _ in true },
      record: { _, _ in false }
    )
  }
  expect(rLocal == .storeFailed, "q.8 a failed write is a local failure")
  let rServer = runBounded {
    await KeptUploadResolution.run(
      load: { [BackupManifestStore.KeptInFlight(assetId: "x1", fileId: "f-x1")] },
      ask: { _ in throw Unreachable() },
      record: { _, _ in true }
    )
  }
  expect(rServer == .serverFailed, "q.9 a failed ask is a server failure")
}

// MARK: - (r) P2 item 8: one in-flight predicate for the keep, the snapshot and the flush load

do {
  let d = Device("r.db")
  // Every edge of the predicate: status, owner, file id, session id.
  let shapes: [(id: String, status: String, owner: String?, file: String?, session: String?)] = [
    ("k1", "staging", A, "f1", "s1"), ("k2", "staged_upload", A, "f2", "s2"), ("k3", "uploading", B, "f3", "s3"),
    ("n1", "pending_upload", A, "f4", "s4"), ("n2", "uploading", nil, "f5", "s5"), ("n3", "uploading", "", "f6", "s6"),
    ("n4", "uploading", A, nil, "s7"), ("n5", "uploading", A, "", "s8"), ("n6", "uploading", A, "f9", nil),
    ("n7", "uploading", A, "f10", ""), ("n8", "uploaded", A, "f11", "s11"), ("n9", "failed", A, "f12", "s12"),
  ]
  func q(_ v: String?) -> String { v.map { "'\($0)'" } ?? "NULL" }
  for sh in shapes {
    exec(d.db, """
    INSERT INTO backup_assets (local_asset_id, remote_file_id, created_at, asset_type, status, upload_session_id, staged_account_id)
    VALUES ('\(sh.id)', \(q(sh.file)), '2026-10-18T00:00:00Z', 'photo', '\(sh.status)', \(q(sh.session)), \(q(sh.owner)))
    """)
  }
  let snapshot = Set(d.queue.sync { BackupManifestStore.pendingMarksSnapshot(d.db, nowMs: now) }!
    .filter { $0.needsResolution }.map { "\($0.accountId)/\($0.assetId)" })
  let flushA = d.queue.sync { BackupManifestStore.inFlightUploads(d.db, accountId: A) }!.map { "\(A)/\($0.assetId)" }
  let flushB = d.queue.sync { BackupManifestStore.inFlightUploads(d.db, accountId: B) }!.map { "\(B)/\($0.assetId)" }
  _ = d.queue.sync { BackupManifestStore.keepInFlightUploads(d.db, nowMs: now) }
  var keptRows: Set<String> = []
  var stmt: OpaquePointer?
  sqlite3_prepare_v2(d.db, "SELECT account_id || '/' || local_asset_id FROM backup_pending_marks WHERE needs_resolution = 1", -1, &stmt, nil)
  while sqlite3_step(stmt) == SQLITE_ROW { keptRows.insert(String(cString: sqlite3_column_text(stmt, 0))) }
  sqlite3_finalize(stmt)
  let expected: Set<String> = ["\(A)/k1", "\(A)/k2", "\(B)/k3"]
  expect(keptRows == expected, "r.1 the keep selects exactly k1, k2, k3 (got \(keptRows.sorted()))")
  expect(snapshot == expected, "r.2 the failed-reset snapshot selects the same rows (got \(snapshot.sorted()))")
  expect(Set(flushA + flushB) == expected, "r.3 the flush load selects the same rows (got \((flushA + flushB).sorted()))")
  let kia = d.queue.sync { BackupManifestStore.keptInFlight(d.db, accountId: A, nowMs: now) }!.map { $0.assetId }
  expect(kia == ["k1", "k2"], "r.4 the kept reader reads A's rows through the same reader (got \(kia))")
}

// MARK: - Round 16 (review of mobile#182 at 083d5f23)

/// Another connection on the same file (the JS layer's expo-sqlite) takes the
/// write lock, holds it for `holdMs`, then commits. `started` fires once the
/// lock is held.
func holdWriteLock(_ path: String, holdMs: UInt32) -> (started: DispatchSemaphore, done: DispatchSemaphore) {
  let started = DispatchSemaphore(value: 0)
  let done = DispatchSemaphore(value: 0)
  Thread.detachNewThread {
    let js = open(path)
    exec(js, "BEGIN IMMEDIATE")
    exec(js, "UPDATE backup_assets SET retry_count = retry_count WHERE local_asset_id = 'p2'")
    started.signal()
    usleep(holdMs * 1000)
    exec(js, "COMMIT")
    sqlite3_close(js)
    done.signal()
  }
  return (started, done)
}

func busyTimeout(_ d: Device) -> Int { scalar(d.db, "PRAGMA busy_timeout") }

// MARK: - (s) finding 1: the teardown's keep waits for a brief writer lock

// The engine's connection has no busy timeout. At 083d5f23 the keep failed at
// once on SQLITE_BUSY when JS held the write lock, and the purge cleared the
// ids anyway (traced kept=-1).
do {
  let (d, _) = deviceWithInFlightX1("s.db")
  expect(busyTimeout(d) == 0, "s.0 the engine-shaped connection starts with no busy timeout (got \(busyTimeout(d)))")
  let js = holdWriteLock(root.appendingPathComponent("s.db").path, holdMs: 300)
  js.started.wait()
  let t0 = Date()
  let r = stagedPurge(d)
  let waited = Date().timeIntervalSince(t0)
  js.done.wait()
  expect(r.keptInFlight == 1 && r.purged == 1,
         "s.1 with JS holding the write lock for 300 ms, the keep still keeps x1 (got kept \(String(describing: r.keptInFlight)), purged \(r.purged))")
  expect(waited >= 0.2 && waited < 2.0, "s.2 the keep WAITED for the lock (\(String(format: "%.3f", waited)) s, expected 0.2..2)")
  expect(text(d.db, "SELECT remote_file_id FROM backup_pending_marks WHERE account_id = '\(A)' AND local_asset_id = 'x1' AND needs_resolution = 1") == "f-x1",
         "s.3 x1 is kept for A with f-x1")
  expect(status(d, "x1") == "pending_reupload::", "s.4 then the purge cleared x1 (got \(status(d, "x1")))")
  expect(busyTimeout(d) == 0, "s.5 the busy timeout is restored to 0 after the keep (got \(busyTimeout(d)))")
  // A connection that had its own timeout gets it back.
  sqlite3_busy_timeout(d.db, 500)
  _ = d.queue.sync { BackupManifestStore.keepInFlightUploads(d.db, nowMs: now) }
  expect(busyTimeout(d) == 500, "s.6 a connection's own timeout (500 ms) is restored (got \(busyTimeout(d)))")
  sqlite3_busy_timeout(d.db, 0)
}

// (s-control) the same lock with no wait (083d5f23's keep, busyTimeoutMs 0):
// the keep fails, nothing is kept. Proves s.1 met a real lock.
do {
  let (d, _) = deviceWithInFlightX1("s-control.db")
  let js = holdWriteLock(root.appendingPathComponent("s-control.db").path, holdMs: 300)
  js.started.wait()
  let r = d.queue.sync {
    BackupManifestStore.purgeAllStaged(d.db, nowMs: now, error: "control", keepBusyTimeoutMs: 0, removeFiles: { _ in })
  }
  js.done.wait()
  expect(r.keptInFlight == nil, "s.c1 control: with no wait the keep fails on the lock (got \(String(describing: r.keptInFlight)))")
  expect(kept(d, A, resolution: 1) == 0, "s.c2 control: nothing is kept (got \(kept(d, A, resolution: 1)))")
}

// MARK: - (t) finding 2: a missed teardown, then a relaunch as B

// A's teardown never ran (handleConfirmedAccountMismatch unbinds without a
// purge, then the app died). The app relaunches with B's token:
// bindAccount(B) -> claimManifest(B) -> purgeMismatchedStagedAssets(B) (the
// shipped BackupManifestStore.claim and .purgeMismatchedStaged). B signs out
// later; A returns.
func seedMissedTeardownExtras(_ d: Device) {
  exec(d.db, """
  INSERT INTO backup_assets (local_asset_id, remote_file_id, created_at, asset_type, status, retry_count,
                             staged_file_id, staged_dir, upload_session_id, staged_account_id)
  VALUES ('b1', 'f-b1', '2026-10-18T00:00:00Z', 'photo', 'staged_upload', 0, 'sf-b1', '/staging/sf-b1', 's-b1', '\(B)');
  INSERT INTO backup_assets (local_asset_id, remote_file_id, created_at, asset_type, status, retry_count,
                             staged_file_id, staged_dir, upload_session_id, staged_account_id)
  VALUES ('n1', 'f-n1', '2026-10-18T00:00:00Z', 'photo', 'staged_upload', 0, 'sf-n1', '/staging/sf-n1', 's-n1', NULL);
  """)
}

/// NativeBackupEngine.bindAccount(B) after A's missed teardown.
func relaunchAs(_ d: Device, _ account: String) -> (claimed: (adopted: Int, requeued: Int)?, purge: (keptInFlight: Int?, purged: Int)) {
  d.queue.sync {
    d.fence.bind(accountId: account)
    let claimed = BackupManifestStore.claim(d.db, accountId: account, nowMs: now)
    let purge = BackupManifestStore.purgeMismatchedStaged(
      d.db, currentAccountId: account, nowMs: now,
      error: "Re-encrypting: staged ciphertext not verified for this account", removeFiles: { _ in }
    )
    return (claimed, purge)
  }
}

do {
  let (d, server) = deviceWithInFlightX1("t.db")
  seedMissedTeardownExtras(d)
  let r = relaunchAs(d, B)
  expect(r.claimed?.requeued == 1, "t.1 claim(B) re-queues A's uploaded u1 (got \(String(describing: r.claimed)))")
  expect(r.purge.keptInFlight == 1 && r.purge.purged == 2,
         "t.2 the mismatch purge keeps A's in-flight x1 only, and purges x1 + the untagged n1 (got kept \(String(describing: r.purge.keptInFlight)), purged \(r.purge.purged))")
  expect(text(d.db, "SELECT remote_file_id FROM backup_pending_marks WHERE account_id = '\(A)' AND local_asset_id = 'x1' AND needs_resolution = 1") == "f-x1",
         "t.3 x1 is kept for A, to resolve, with f-x1")
  expect(text(d.db, "SELECT remote_file_id FROM backup_pending_marks WHERE account_id = '\(A)' AND local_asset_id = 'u1' AND needs_resolution = 0") == "f-u1",
         "t.4 claim keeps A's unmarked u1 as a mark before re-queueing it")
  expect(kept(d, B, resolution: 1) == 0, "t.5 B's own in-flight b1 is not kept by B's mismatch purge (got \(kept(d, B, resolution: 1)))")
  expect(status(d, "b1") == "staged_upload:f-b1:", "t.6 B's own staged b1 is untouched (got \(status(d, "b1")))")
  expect(scalar(d.db, "SELECT COUNT(*) FROM backup_pending_marks WHERE local_asset_id = 'n1'") == 0,
         "t.7 the untagged n1 has no owner to keep it for and is only purged")
  expect(status(d, "x1") == "pending_reupload::" && status(d, "n1") == "pending_reupload::",
         "t.8 x1 and n1 lost their staged state (got \(status(d, "x1")), \(status(d, "n1")))")
  // B's session ends.
  expect(signOutPurge(d), "t.9 B's sign-out reset succeeds")
  expect(kept(d, A, resolution: 1) == 1 && kept(d, A, resolution: 0) == 1,
         "t.10 A's kept x1 (to resolve) and u1 (mark) survive B's session (got \(kept(d, A, resolution: 1)), \(kept(d, A, resolution: 0)))")
  // A returns.
  let t = signIn(d, account: A)
  let g = gate(d, server, account: A, ticket: t)
  if case .ready? = g {} else { expect(false, "t.11 A's gate is ready (got \(String(describing: g)))") }
  let up = batch(d, server, account: A)
  catchUp(d, server, account: A, ticket: t)
  expect(up == ["p2"], "t.12 only p2 uploads for A (got \(up))")
  expect(server.uploadCount(A, "x1") == 0, "t.13 x1 is NOT uploaded a second time (got \(server.uploadCount(A, "x1")))")
  expect(server.uploadCount(A, "u1") == 0, "t.14 u1 is NOT uploaded a second time (got \(server.uploadCount(A, "u1")))")
  expect(server.marks[A]?["x1"] == "f-x1" && server.marks[A]?["u1"] == "f-u1", "t.15 x1 and u1 are marked on the server for A")
  expect(server.inspects.filter { $0 == "f-b1" }.isEmpty, "t.16 A never asks about B's file")
}

// (t-control) 083d5f23's bindAccount: the engine's old select + restage, and
// the claim without its keep: x1 and u1 upload a second time when A returns.
do {
  let (d, server) = deviceWithInFlightX1("t-control.db")
  seedMissedTeardownExtras(d)
  d.queue.sync {
    d.fence.bind(accountId: B)
    exec(d.db, """
    UPDATE backup_assets SET status = 'pending_upload', remote_file_id = NULL, uploaded_account_id = NULL, server_marked_at = NULL
     WHERE uploaded_account_id IS NOT NULL AND uploaded_account_id != '\(B)' AND staged_file_id IS NULL
    """)
    exec(d.db, """
    UPDATE backup_assets
       SET status = 'pending_reupload', remote_file_id = NULL, upload_session_id = NULL,
           staged_file_id = NULL, staged_dir = NULL, staged_at = NULL
     WHERE staged_file_id IS NOT NULL AND (staged_account_id IS NULL OR staged_account_id != '\(B)')
    """)
  }
  _ = signOutPurge(d)
  let t = signIn(d, account: A)
  _ = gate(d, server, account: A, ticket: t)
  _ = batch(d, server, account: A)
  expect(server.uploadCount(A, "x1") == 1 && server.uploadCount(A, "u1") == 1,
         "t.c control: 083d5f23's relaunch as B makes A upload x1 and u1 a SECOND time (got x1 \(server.uploadCount(A, "x1")), u1 \(server.uploadCount(A, "u1")))")
}

// MARK: - (u) finding 2: uploadSingleAsset's per-row mismatch refusal

do {
  let (d, server) = deviceWithInFlightX1("u.db")
  // A second in-flight row of A that this refusal does not touch.
  exec(d.db, """
  INSERT INTO backup_assets (local_asset_id, remote_file_id, created_at, asset_type, status, retry_count,
                             staged_file_id, staged_dir, upload_session_id, staged_account_id)
  VALUES ('y1', 'f-y1', '2026-10-18T00:00:00Z', 'photo', 'staged_upload', 0, 'sf-y1', '/staging/sf-y1', 's-y1', '\(A)');
  """)
  server.files["f-y1"] = (A, false)
  let r = d.queue.sync {
    BackupManifestStore.restageMismatchedRow(d.db, assetId: "x1", error: "Re-encrypting: staged ciphertext not verified for this account", nowMs: now)
  }
  expect(r.keptInFlight == 1 && r.cleared, "u.1 the refusal keeps x1, then clears it (got kept \(String(describing: r.keptInFlight)), cleared \(r.cleared))")
  expect(text(d.db, "SELECT remote_file_id FROM backup_pending_marks WHERE account_id = '\(A)' AND local_asset_id = 'x1' AND needs_resolution = 1") == "f-x1",
         "u.2 x1 is kept for A with f-x1")
  expect(scalar(d.db, "SELECT COUNT(*) FROM backup_pending_marks WHERE local_asset_id = 'y1'") == 0,
         "u.3 scoped to the one row: y1 is not kept")
  expect(status(d, "x1") == "pending_reupload::" && status(d, "y1") == "staged_upload:f-y1:",
         "u.4 x1 is cleared, y1 untouched (got \(status(d, "x1")), \(status(d, "y1")))")
  // A returns (B's session never purged anything else here): x1 resolves complete.
  expect(signOutPurge(d), "u.5 the next sign-out reset succeeds")
  let t = signIn(d, account: A)
  _ = gate(d, server, account: A, ticket: t)
  _ = batch(d, server, account: A)
  expect(server.uploadCount(A, "x1") == 0, "u.6 x1 is NOT uploaded a second time (got \(server.uploadCount(A, "x1")))")
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
