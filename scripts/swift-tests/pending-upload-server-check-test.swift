import Darwin
import Foundation
import SQLite3

// Task 1667 round 10 (review of mobile#182 at 060bfeb0, findings 1, 2 and 4)
// — standalone swiftc test for the batch's server check, the dedupe
// guarantee. Compiled with the REAL shipped sources
// (PendingUploadServerCheck.swift, PhotoBackupServerClient.swift,
// PhotoBackupServerResponses.swift, BackupManifestStore.swift,
// ManifestRebuildGate.swift, ManifestWriteFence.swift,
// BackupManifestHandle.swift) by scripts/swift-ci/run-swift-tests.sh, against
// a real SQLite manifest, with every request answered by a fake server
// (URLProtocol) that keeps the server's real semantics:
//   - `POST /photo-backup/check` and `GET /photo-backup/identifiers` read
//     `photo_backup_state` for the device header and do NOT filter trashed
//     files (server photo_backup.rs, as of origin/main fe6a3ebe);
//   - `GET /files/index` lists only files with `is_trashed = FALSE`
//     (files.rs FILE_INDEX_SQL_1959), and answers `changed: false` for the
//     current hash.
//
// `checkBatch` below is `NativeBackupEngine.rowsCheckedAgainstServer` with
// the engine's own steps (the engine itself needs PhotoKit/UIKit and cannot
// be compiled here; native-backup-manifest-wiring.test.ts pins its wiring).
//
// What it proves:
//   (a) finding 1: rows inserted AFTER the one-shot rebuild (videos switched
//       on, a wider album selection, Limited -> Full access) are checked: the
//       ones the server already has become `uploaded` with their server file
//       id and do not upload; the rebuild gate on its own lets them upload.
//   (b) the observer race: a rebuild applied to the first observer rows
//       leaves the full scan's rows to the check, which catches them.
//   (c) finding 2: a hit whose file is in the Trash is NOT promoted (it
//       uploads), on the batch check, on the rebuild fast path, and after the
//       JS reconcile re-queued a row whose file was trashed.
//   (d) fail closed: every failed step (check 500/404/bad body, identifiers
//       503, files/index 500 or an unknown "unchanged", writer lock) defers
//       the batch: nothing uploads and nothing is promoted.
//   (e) fenced: a check that spans a sign-out reset writes nothing.
//   (f) the live index is revalidated by hash every time (a trash between
//       two batches is seen), (g) /check is chunked at 500, (h) the map
//       cache avoids a GET only when it covers every hit, (i) a hit the map
//       no longer has uploads.
//   (j) finding 4: a failed scan insert stays recorded until a FULL scan
//       inserts successfully; an incremental insert does not clear it.

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
func runBounded<T>(watchdog: TimeInterval = 30, _ op: @escaping () async -> T) -> T? {
  let sem = DispatchSemaphore(value: 0)
  let box = Box<T>()
  Task {
    box.set(await op())
    sem.signal()
  }
  _ = sem.wait(timeout: .now() + watchdog)
  return box.get()
}

let now: Int64 = 1_800_000_000_000
let accountA = "acct-A"
let deviceId = "dev-1"

// MARK: - Fake server

struct Reply {
  let status: Int
  let headers: [String: String]
  let body: Data
}

struct LoggedRequest {
  let path: String
  let query: String?
  let method: String
  let deviceHeader: String?
  let checkCount: Int
}

final class FakeServer {
  static let shared = FakeServer()
  let lock = NSLock()
  /// photo_backup_state for `deviceId`: local identifier -> file id.
  var map: [String: String] = [:]
  /// files: id -> is_trashed.
  var files: [String: Bool] = [:]
  /// Injected failures per path (one-shot when `oneShot`).
  var failing: [String: Reply] = [:]
  var log: [LoggedRequest] = []

  func reset() {
    lock.lock(); defer { lock.unlock() }
    map = [:]; files = [:]; failing = [:]; log = []
  }

  func with<T>(_ body: (FakeServer) -> T) -> T { lock.lock(); defer { lock.unlock() }; return body(self) }

  func requests(_ path: String) -> [LoggedRequest] { with { $0.log.filter { $0.path == path } } }

  var liveIds: [String] { files.filter { !$0.value }.map(\.key).sorted() }
  var indexHash: String { "h-" + String(liveIds.joined(separator: ",").hashValue) }

  static func json(_ object: Any, status: Int = 200) -> Reply {
    Reply(status: status, headers: ["Content-Type": "application/json"], body: try! JSONSerialization.data(withJSONObject: object))
  }

  func answer(_ request: URLRequest, body: Data?) -> Reply {
    lock.lock(); defer { lock.unlock() }
    let url = request.url!
    let comps = URLComponents(url: url, resolvingAgainstBaseURL: false)!
    let device = request.value(forHTTPHeaderField: "X-Beebeeb-Device-Id")
    var checkIds: [String] = []
    if comps.path.hasSuffix("/photo-backup/check"), let body,
       let obj = try? JSONSerialization.jsonObject(with: body) as? [String: Any],
       let ids = obj["identifiers"] as? [String] {
      checkIds = ids
    }
    log.append(LoggedRequest(path: comps.path, query: comps.query, method: request.httpMethod ?? "?",
                             deviceHeader: device, checkCount: checkIds.count))
    if let fail = failing[comps.path] { return fail }
    let deviceMap = device == deviceId ? map : [:]
    switch comps.path {
    case "/api/v1/files/photo-backup/check":
      // Server SQL: SELECT local_identifier FROM photo_backup_state WHERE
      // user_id = $1 AND device_id = $2 AND local_identifier = ANY($3).
      guard checkIds.count <= 500 else { return Self.json(["error": "too many"], status: 400) }
      let hits = checkIds.filter { deviceMap[$0] != nil }
      let needs = checkIds.filter { deviceMap[$0] == nil }
      return Self.json(["already_backed_up": hits, "needs_backup": needs])
    case "/api/v1/files/photo-backup/identifiers":
      var out: [String: String] = [:]
      for (local, file) in deviceMap { out[file] = local }
      return Self.json(["identifiers": out])
    case "/api/v1/files/index":
      let hash = indexHash
      let asked = comps.queryItems?.first(where: { $0.name == "hash" })?.value
      if asked == hash { return Self.json(["hash": hash, "changed": false, "count": liveIds.count]) }
      return Self.json(["hash": hash, "changed": true, "count": liveIds.count,
                        "files": liveIds.map { ["id": $0, "name_encrypted": "x"] }])
    default:
      return Reply(status: 404, headers: ["Content-Type": "application/json"], body: Data(#"{"error":"not found"}"#.utf8))
    }
  }
}

final class FakeServerProtocol: URLProtocol {
  override class func canInit(with request: URLRequest) -> Bool { true }
  override class func canonicalRequest(for request: URLRequest) -> URLRequest { request }
  override func startLoading() {
    var body = request.httpBody
    if body == nil, let stream = request.httpBodyStream {
      stream.open()
      var data = Data()
      var buffer = [UInt8](repeating: 0, count: 4096)
      while stream.hasBytesAvailable {
        let n = stream.read(&buffer, maxLength: buffer.count)
        if n <= 0 { break }
        data.append(buffer, count: n)
      }
      stream.close()
      body = data
    }
    let r = FakeServer.shared.answer(request, body: body)
    let response = HTTPURLResponse(url: request.url!, statusCode: r.status, httpVersion: "HTTP/1.1", headerFields: r.headers)!
    client?.urlProtocol(self, didReceive: response, cacheStoragePolicy: .notAllowed)
    client?.urlProtocol(self, didLoad: r.body)
    client?.urlProtocolDidFinishLoading(self)
  }
  override func stopLoading() {}
}

let session: URLSession = {
  let config = URLSessionConfiguration.ephemeral
  config.timeoutIntervalForRequest = 30
  config.protocolClasses = [FakeServerProtocol.self]
  return URLSession(configuration: config)
}()

func client(device: String = deviceId) -> PhotoBackupServerClient {
  PhotoBackupServerClient(session: session, baseURL: "https://api.invalid", authToken: "t", deviceId: device)
}

// MARK: - Manifest harness

let fm = FileManager.default
let root = fm.temporaryDirectory.appendingPathComponent("bb-1667-server-check-\(UUID().uuidString)", isDirectory: true)
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

func prepareSchema(_ db: OpaquePointer) {
  sqlite3_exec(db, schema, nil, nil, nil)
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
  precondition(sqlite3_open_v2(path, &db, SQLITE_OPEN_READWRITE | SQLITE_OPEN_CREATE | SQLITE_OPEN_FULLMUTEX, nil) == SQLITE_OK)
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

func rows(_ db: OpaquePointer, _ sql: String) -> [[String]] {
  var stmt: OpaquePointer?
  guard sqlite3_prepare_v2(db, sql, -1, &stmt, nil) == SQLITE_OK else { return [] }
  defer { sqlite3_finalize(stmt) }
  var out: [[String]] = []
  while sqlite3_step(stmt) == SQLITE_ROW {
    var row: [String] = []
    for i in 0..<sqlite3_column_count(stmt) {
      row.append(sqlite3_column_text(stmt, i).map { String(cString: $0) } ?? "NULL")
    }
    out.append(row)
  }
  return out
}

func status(_ db: OpaquePointer, _ id: String) -> String {
  rows(db, "SELECT status FROM backup_assets WHERE local_asset_id = '\(id)'").first?.first ?? "missing"
}

func remote(_ db: OpaquePointer, _ id: String) -> String {
  rows(db, "SELECT COALESCE(remote_file_id, 'NULL') FROM backup_assets WHERE local_asset_id = '\(id)'").first?.first ?? "missing"
}

func marked(_ db: OpaquePointer, _ id: String) -> Bool {
  rows(db, "SELECT server_marked_at IS NOT NULL FROM backup_assets WHERE local_asset_id = '\(id)'").first?.first == "1"
}

func insert(_ db: OpaquePointer, _ ids: [String], type: String = "photo") -> Bool {
  BackupManifestStore.insertScannedAssets(
    db, ids.map { BackupManifestStore.ScannedAsset(localAssetId: $0, createdAt: "2026-10-18T10:00:00Z", assetType: type) },
    nowMs: now
  )
}

func manifest(_ name: String) -> (BackupManifestHandle, OpaquePointer) {
  let dir = root.appendingPathComponent(name, isDirectory: true)
  try! fm.createDirectory(at: dir, withIntermediateDirectories: true)
  let handle = BackupManifestHandle(path: dir.appendingPathComponent("beebeeb-backup.db").path,
                                    pendingReset: PendingFlag().flag, now: { now }, prepareSchema: prepareSchema)
  precondition(handle.openIfClosed() == nil)
  handle.writeFence.bind(accountId: accountA)
  return (handle, handle.db!)
}

// MARK: - The engine's batch check (NativeBackupEngine.rowsCheckedAgainstServer)

final class EngineCaches {
  var live = LiveFileIndexCache()
  var map = IdentifierMapCache()
}

struct Candidate {
  let id: String
  let staged: Bool
}

/// Returns the rows the batch would upload, or nil (deferred: nothing uploads).
func checkBatch(
  _ handle: BackupManifestHandle, ticket: ManifestWriteFence.Ticket?, candidates: [Candidate],
  caches: EngineCaches, device: String = deviceId, current: @escaping () -> Bool = { true },
  outcome outBox: Box<PendingUploadServerCheck.Outcome>? = nil
) -> [String]? {
  let fresh = candidates.filter { !$0.staged }.map(\.id)
  guard !fresh.isEmpty else { return candidates.map(\.id) }
  let c = client(device: device)
  let steps = PendingUploadServerCheck.Steps(
    hasDeviceId: { !device.isEmpty },
    check: { ids in try await c.check(ids) },
    identifierMap: { hits in
      if let cached = caches.map.covering(hits, accountId: accountA, deviceId: device) { return cached }
      let map = try await c.identifierMap()
      caches.map.store(map, accountId: accountA, deviceId: device)
      return map
    },
    liveFileIds: {
      let index = try await c.fileIndex(knownHash: caches.live.knownHash(for: accountA))
      return try caches.live.accept(index, accountId: accountA)
    },
    isStillCurrent: current,
    promote: { hits in
      FencedManifestWrites.promoteCheckedHits(
        handle.db, fence: handle.writeFence, ticket: ticket, accountId: accountA,
        hits: hits, uploadedAtIso: "2026-10-18T10:00:00Z", nowMs: now
      )
    }
  )
  guard let outcome = runBounded({ await PendingUploadServerCheck.run(candidates: fresh, steps: steps) }) else {
    expect(false, "the check finished within the watchdog")
    return nil
  }
  outBox?.set(outcome)
  switch outcome {
  case let .proceed(skip, _, _):
    return candidates.map(\.id).filter { !skip.contains($0) }
  case .deferred:
    return nil
  }
}

/// The rebuild gate as the engine runs it, the map filtered by liveness.
func runRebuildGate(_ handle: BackupManifestHandle, ticket: ManifestWriteFence.Ticket, alreadyReady: Bool, caches: EngineCaches) -> ManifestRebuildGate.Outcome? {
  let c = client()
  let steps = ManifestRebuildGate.Steps(
    needsRebuild: {
      FencedManifestWrites.needsRebuild(handle.db, fence: handle.writeFence, ticket: ticket, accountId: accountA,
                                        scanInsertFailed: false, nowMs: now)
    },
    hasDeviceId: { true },
    fetchMap: {
      let map = try await c.identifierMap()
      return try await PendingUploadServerCheck.liveOnly(map) {
        let index = try await c.fileIndex(knownHash: caches.live.knownHash(for: accountA))
        return try caches.live.accept(index, accountId: accountA)
      }
    },
    isStillCurrent: { true },
    applyMap: { map in
      FencedManifestWrites.applyServerMap(handle.db, fence: handle.writeFence, ticket: ticket, accountId: accountA,
                                          map: map, uploadedAtIso: "2026-10-18T10:00:00Z", nowMs: now)
    },
    applyKept: {
      FencedManifestWrites.applyKept(handle.db, fence: handle.writeFence, ticket: ticket, accountId: accountA, nowMs: now)
    }
  )
  return runBounded { await ManifestRebuildGate.run(alreadyReady: alreadyReady, steps: steps) }
}

let checkPath = "/api/v1/files/photo-backup/check"
let idsPath = "/api/v1/files/photo-backup/identifiers"
let indexPath = "/api/v1/files/index"
let server = FakeServer.shared

/// Account A already backed up p1..p3 from this device (manifest + server).
func seedBackedUpPhotos(_ db: OpaquePointer) {
  _ = insert(db, ["p1", "p2", "p3"])
  for (i, p) in ["p1", "p2", "p3"].enumerated() {
    exec(db, "UPDATE backup_assets SET status = 'uploaded', remote_file_id = 'f-p\(i + 1)', uploaded_account_id = '\(accountA)', server_marked_at = \(now) WHERE local_asset_id = '\(p)'")
    server.with { $0.map[p] = "f-p\(i + 1)"; $0.files["f-p\(i + 1)"] = false }
  }
}

// MARK: - (a) finding 1: rows inserted after the one-shot rebuild

do {
  server.reset()
  let (handle, db) = manifest("a-videos")
  let ticket = handle.writeFence.issue(for: accountA)!
  seedBackedUpPhotos(db)
  // The server also has two videos from this device (an earlier install, or
  // before a sign-out); "Include videos" was off until now.
  server.with {
    $0.map["v1"] = "f-v1"; $0.files["f-v1"] = false
    $0.map["v2"] = "f-v2"; $0.files["f-v2"] = false
  }
  let caches = EngineCaches()
  // The rebuild gate on its own (060bfeb's only dedupe): uploadedCount > 0,
  // so it never looks at the server map again.
  let gate = runRebuildGate(handle, ticket: ticket, alreadyReady: false, caches: caches)
  expect(gate == .ready(rebuilt: false, promoted: 0, keptApplied: 0), "a0: control: the gate does not rebuild a manifest with uploads (got \(String(describing: gate)))")
  // Videos switched on: the scan inserts them.
  expect(insert(db, ["v1", "v2", "v3"], type: "video"), "a1: the scan inserts the videos")
  expect(status(db, "v1") == "pending_upload", "a1: v1 is queued")
  let upload = checkBatch(handle, ticket: ticket, candidates: ["v1", "v2", "v3"].map { Candidate(id: $0, staged: false) }, caches: caches)
  expect(upload == ["v3"], "a2: only the video the server does not have uploads (got \(String(describing: upload)))")
  expect(status(db, "v1") == "uploaded" && status(db, "v2") == "uploaded", "a3: the server's videos are uploaded in the manifest")
  expect(remote(db, "v1") == "f-v1" && remote(db, "v2") == "f-v2", "a3: with the server's file ids")
  expect(marked(db, "v1") && marked(db, "v2"), "a3: and already marked (the server has them)")
  expect(rows(db, "SELECT uploaded_account_id FROM backup_assets WHERE local_asset_id = 'v1'").first?.first == accountA, "a3: owned by the account")
  expect(status(db, "v3") == "pending_upload", "a3: v3 stays queued")
  let checks = server.requests(checkPath)
  expect(checks.count == 1 && checks[0].checkCount == 3 && checks[0].method == "POST", "a4: one /check with the 3 fresh rows")
  expect(server.with { $0.log }.allSatisfy { $0.deviceHeader == deviceId }, "a4: every request carries the device id")
  // A wider album selection / Limited -> Full: the same for photos.
  server.with { $0.map["p9"] = "f-p9"; $0.files["f-p9"] = false }
  expect(insert(db, ["p9", "p10"]), "a5: new photos from the wider selection")
  let upload2 = checkBatch(handle, ticket: ticket, candidates: [Candidate(id: "p9", staged: false), Candidate(id: "p10", staged: false)], caches: caches)
  expect(upload2 == ["p10"], "a5: p9 (on the server) is not uploaded again (got \(String(describing: upload2)))")
  // Rows already staged are resumptions; they are not re-asked.
  server.with { $0.log = [] }
  let staged = checkBatch(handle, ticket: ticket, candidates: [Candidate(id: "s1", staged: true)], caches: caches)
  expect(staged == ["s1"], "a6: a staged row continues its upload")
  expect(server.requests(checkPath).isEmpty, "a6: and costs no /check")
}

// MARK: - (b) the observer race: the rebuild ran on the first few rows only

do {
  server.reset()
  let (handle, db) = manifest("b-race")
  let ticket = handle.writeFence.issue(for: accountA)!
  let caches = EngineCaches()
  for i in 1...6 { server.with { $0.map["r\(i)"] = "f-r\(i)"; $0.files["f-r\(i)"] = false } }
  // An observer insert lands before the full scan, and the gate rebuilds onto it.
  expect(insert(db, ["r1"]), "b0: the observer inserts one row")
  let gate = runRebuildGate(handle, ticket: ticket, alreadyReady: false, caches: caches)
  expect(gate == .ready(rebuilt: true, promoted: 1, keptApplied: 0), "b1: the rebuild promotes the one row it sees (got \(String(describing: gate)))")
  // The full scan inserts the rest; the account is "ready", no rebuild again.
  expect(insert(db, ["r2", "r3", "r4", "r5", "r6", "n1"]), "b2: the full scan inserts the rest")
  let again = runRebuildGate(handle, ticket: ticket, alreadyReady: true, caches: caches)
  expect(again == .ready(rebuilt: false, promoted: 0, keptApplied: 0), "b2: control: the gate does not look again")
  let upload = checkBatch(handle, ticket: ticket, candidates: ["r2", "r3", "r4", "r5", "r6", "n1"].map { Candidate(id: $0, staged: false) }, caches: caches)
  expect(upload == ["n1"], "b3: only the new photo uploads (got \(String(describing: upload)))")
  expect((2...6).allSatisfy { status(db, "r\($0)") == "uploaded" }, "b3: the server's photos are uploaded in the manifest")
}

// MARK: - (c) finding 2: a file in the Trash is not a backup

do {
  server.reset()
  let (handle, db) = manifest("c-trash")
  let ticket = handle.writeFence.issue(for: accountA)!
  let caches = EngineCaches()
  server.with {
    $0.map["t1"] = "f-t1"; $0.files["f-t1"] = true   // only copy is in the Trash
    $0.map["t2"] = "f-t2"; $0.files["f-t2"] = false  // live
  }
  expect(insert(db, ["t1", "t2"]), "c0: rows queued")
  let box = Box<PendingUploadServerCheck.Outcome>()
  let upload = checkBatch(handle, ticket: ticket, candidates: [Candidate(id: "t1", staged: false), Candidate(id: "t2", staged: false)], caches: caches, outcome: box)
  expect(upload == ["t1"], "c1: the trashed photo uploads again, the live one does not (got \(String(describing: upload)))")
  expect(status(db, "t1") == "pending_upload" && remote(db, "t1") == "NULL", "c1: the trashed hit is NOT promoted")
  expect(status(db, "t2") == "uploaded", "c1: the live hit is promoted")
  expect(box.get() == .proceed(skip: ["t2"], promoted: ["t2"], notLive: ["t1"]), "c1: outcome names the trashed hit (got \(String(describing: box.get())))")

  // The rebuild fast path, on an emptied manifest: same rule.
  let (h2, db2) = manifest("c-trash-rebuild")
  let t2 = h2.writeFence.issue(for: accountA)!
  let caches2 = EngineCaches()
  expect(insert(db2, ["t1", "t2"]), "c2: the scan after a sign-in")
  let gate = runRebuildGate(h2, ticket: t2, alreadyReady: false, caches: caches2)
  expect(gate == .ready(rebuilt: true, promoted: 1, keptApplied: 0), "c3: the rebuild promotes only the live file (got \(String(describing: gate)))")
  expect(status(db2, "t1") == "pending_upload", "c3: the trashed photo stays queued after the rebuild")

  // The JS reconcile re-queued an upload whose file was trashed: it must not
  // be promoted back (which would loop until the 30-day purge).
  exec(db, "UPDATE backup_assets SET status = 'pending_upload', remote_file_id = NULL, uploaded_at = NULL WHERE local_asset_id = 't2'")
  server.with { $0.files["f-t2"] = true }
  let requeued = checkBatch(handle, ticket: ticket, candidates: [Candidate(id: "t2", staged: false)], caches: caches)
  expect(requeued == ["t2"], "c4: the re-queued photo whose file was trashed uploads (got \(String(describing: requeued)))")
  expect(status(db, "t2") == "pending_upload", "c4: and is not promoted back")
  // Restored from the Trash: a hit again.
  server.with { $0.files["f-t1"] = false }
  let restored = checkBatch(handle, ticket: ticket, candidates: [Candidate(id: "t1", staged: false)], caches: caches)
  expect(restored == [], "c5: a restored file counts again (got \(String(describing: restored)))")
}

// MARK: - (d) fail closed

do {
  server.reset()
  let (handle, db) = manifest("d-fail")
  let ticket = handle.writeFence.issue(for: accountA)!
  server.with { $0.map["d1"] = "f-d1"; $0.files["f-d1"] = false }
  expect(insert(db, ["d1", "d2"]), "d0: rows queued")
  let cands = [Candidate(id: "d1", staged: false), Candidate(id: "d2", staged: false)]
  let cases: [(String, String, Reply, PendingUploadServerCheck.DeferReason)] = [
    ("check 500", checkPath, Reply(status: 500, headers: [:], body: Data()), .checkFailed),
    ("check 404 (proxy)", checkPath, Reply(status: 404, headers: ["Content-Type": "text/html"], body: Data("<html>".utf8)), .checkFailed),
    ("check 404 (API body)", checkPath, Reply(status: 404, headers: ["Content-Type": "application/json"], body: Data(#"{"error":"not found"}"#.utf8)), .checkFailed),
    ("check body without needs_backup", checkPath, FakeServer.json(["already_backed_up": []]), .checkFailed),
    ("check body: a hit it did not ask for", checkPath, FakeServer.json(["already_backed_up": ["zzz"], "needs_backup": ["d1", "d2"]]), .checkFailed),
    ("check body: an id in both lists", checkPath, FakeServer.json(["already_backed_up": ["d1"], "needs_backup": ["d1", "d2"]]), .checkFailed),
    ("check body: an asked id missing", checkPath, FakeServer.json(["already_backed_up": [], "needs_backup": ["d2"]]), .checkFailed),
    ("check body: a non-string entry", checkPath, FakeServer.json(["already_backed_up": [1], "needs_backup": ["d1", "d2"]]), .checkFailed),
    ("identifiers 503", idsPath, Reply(status: 503, headers: [:], body: Data()), .mapFailed),
    ("identifiers malformed", idsPath, FakeServer.json(["identifiers": ["f-d1": 7]]), .mapFailed),
    ("files/index 500", indexPath, Reply(status: 500, headers: [:], body: Data()), .liveIndexFailed),
    ("files/index without files", indexPath, FakeServer.json(["hash": "h", "changed": true]), .liveIndexFailed),
    ("files/index unchanged for a hash never seen", indexPath, FakeServer.json(["hash": "h-other", "changed": false]), .liveIndexFailed),
  ]
  for (label, path, reply, reason) in cases {
    server.with { $0.failing = [path: reply] }
    let box = Box<PendingUploadServerCheck.Outcome>()
    let upload = checkBatch(handle, ticket: ticket, candidates: cands, caches: EngineCaches(), outcome: box)
    expect(upload == nil, "d1: \(label): nothing uploads (got \(String(describing: upload)))")
    expect(box.get() == .deferred(reason), "d1: \(label): deferred(\(reason)) (got \(String(describing: box.get())))")
    expect(status(db, "d1") == "pending_upload" && status(db, "d2") == "pending_upload", "d1: \(label): no row changed")
  }
  server.with { $0.failing = [:] }
  // A deferral backs off: fetch failures 30 s, a database failure 2..30 s; an account change none.
  expect(PendingUploadServerCheck.backoff(for: .checkFailed, consecutiveFailures: 1) == 30, "d2: check failure backs off 30 s")
  expect(PendingUploadServerCheck.backoff(for: .liveIndexFailed, consecutiveFailures: 3) == 30, "d2: index failure backs off 30 s")
  expect(PendingUploadServerCheck.backoff(for: .applyFailed, consecutiveFailures: 1) == 2, "d2: a write failure backs off 2 s first")
  expect(PendingUploadServerCheck.backoff(for: .accountChanged, consecutiveFailures: 1) == nil, "d2: an account change does not back off")
  // No device id: nothing is asked and nothing uploads.
  let noDevice = Box<PendingUploadServerCheck.Outcome>()
  expect(checkBatch(handle, ticket: ticket, candidates: cands, caches: EngineCaches(), device: "", outcome: noDevice) == nil, "d3: no device id: nothing uploads")
  expect(noDevice.get() == .deferred(.noDeviceId), "d3: deferred(noDeviceId)")
  // The account changed while asking: nothing written, nothing uploads.
  let changed = Box<PendingUploadServerCheck.Outcome>()
  expect(checkBatch(handle, ticket: ticket, candidates: cands, caches: EngineCaches(), current: { false }, outcome: changed) == nil, "d4: account changed: nothing uploads")
  expect(changed.get() == .deferred(.accountChanged) && status(db, "d1") == "pending_upload", "d4: deferred(accountChanged), nothing written")
  // The promotion cannot be written (another connection holds the writer lock).
  let locker = connect(handle.path)
  exec(locker, "BEGIN IMMEDIATE")
  sqlite3_busy_timeout(handle.db!, 0)
  let locked = Box<PendingUploadServerCheck.Outcome>()
  expect(checkBatch(handle, ticket: ticket, candidates: cands, caches: EngineCaches(), outcome: locked) == nil, "d5: writer lock: nothing uploads")
  expect(locked.get() == .deferred(.applyFailed), "d5: deferred(applyFailed) (got \(String(describing: locked.get())))")
  exec(locker, "ROLLBACK")
  sqlite3_close_v2(locker)
  expect(status(db, "d1") == "pending_upload", "d5: nothing promoted under the lock")
  // Released: the same batch goes through.
  expect(checkBatch(handle, ticket: ticket, candidates: cands, caches: EngineCaches()) == ["d2"], "d6: after the lock: d1 promoted, d2 uploads")
}

// MARK: - (e) fenced: a check that spans a sign-out reset writes nothing

do {
  server.reset()
  let (handle, db) = manifest("e-fence")
  let ticket = handle.writeFence.issue(for: accountA)!
  server.with { $0.map["e1"] = "f-e1"; $0.files["f-e1"] = false }
  expect(insert(db, ["e1"]), "e0: row queued")
  // The sign-out reset lands while the batch is asking the server.
  let box = Box<PendingUploadServerCheck.Outcome>()
  let upload = checkBatch(handle, ticket: ticket, candidates: [Candidate(id: "e1", staged: false)], caches: EngineCaches(),
                          current: { handle.resetForSignOut(outgoingAccountId: accountA) || true }, outcome: box)
  expect(upload == nil, "e1: nothing uploads")
  expect(box.get() == .deferred(.applyFailed), "e1: the promotion is fenced (got \(String(describing: box.get())))")
  expect(rows(handle.db!, "SELECT COUNT(*) FROM backup_assets").first?.first == "0", "e2: the emptied manifest stays empty (no row of A written back)")
}

// MARK: - (f) the live index is revalidated by hash on every use

do {
  server.reset()
  let (handle, db) = manifest("f-hash")
  let ticket = handle.writeFence.issue(for: accountA)!
  let caches = EngineCaches()
  server.with {
    $0.map["h1"] = "f-h1"; $0.files["f-h1"] = false
    $0.map["h2"] = "f-h2"; $0.files["f-h2"] = false
  }
  expect(insert(db, ["h1", "h2"]), "f0: rows queued")
  expect(checkBatch(handle, ticket: ticket, candidates: [Candidate(id: "h1", staged: false)], caches: caches) == [], "f1: h1 promoted")
  let first = server.requests(indexPath)
  expect(first.count == 1 && first[0].query == nil, "f1: the first index read asks for the list")
  // Unchanged vault: the second read sends the hash and gets "unchanged".
  expect(checkBatch(handle, ticket: ticket, candidates: [Candidate(id: "h2", staged: false)], caches: caches) == [], "f2: h2 promoted from the cached live set")
  let second = server.requests(indexPath)
  expect(second.count == 2 && (second[1].query ?? "").hasPrefix("hash="), "f2: the second read sends the cached hash")
  // A file trashed between two batches is seen at once.
  expect(insert(db, ["h3"]), "f3: a new row")
  server.with { $0.map["h3"] = "f-h3"; $0.files["f-h3"] = true }
  expect(checkBatch(handle, ticket: ticket, candidates: [Candidate(id: "h3", staged: false)], caches: caches) == ["h3"], "f3: a hit trashed since the last read uploads")
}

// MARK: - (g) /check is chunked at the route's 500 cap

do {
  server.reset()
  let (handle, db) = manifest("g-chunks")
  let ticket = handle.writeFence.issue(for: accountA)!
  let ids = (0..<1201).map { "g\($0)" }
  expect(insert(db, ids), "g0: 1201 rows queued")
  server.with { $0.map["g700"] = "f-g700"; $0.files["f-g700"] = false }
  let upload = checkBatch(handle, ticket: ticket, candidates: ids.map { Candidate(id: $0, staged: false) }, caches: EngineCaches())
  let checks = server.requests(checkPath)
  expect(checks.map(\.checkCount) == [500, 500, 201], "g1: three /check calls of 500, 500, 201 (got \(checks.map(\.checkCount)))")
  expect(upload?.count == 1200 && upload?.contains("g700") == false, "g1: the one hit in the second chunk is not uploaded")
}

// MARK: - (h) the identifier map cache, (i) a hit the map no longer has

do {
  server.reset()
  let (handle, db) = manifest("h-cache")
  let ticket = handle.writeFence.issue(for: accountA)!
  let caches = EngineCaches()
  server.with {
    for i in 1...3 { $0.map["k\(i)"] = "f-k\(i)"; $0.files["f-k\(i)"] = false }
  }
  expect(insert(db, ["k1", "k2", "k3", "k4"]), "h0: rows queued")
  expect(checkBatch(handle, ticket: ticket, candidates: [Candidate(id: "k1", staged: false)], caches: caches) == [], "h1: k1 promoted")
  expect(server.requests(idsPath).count == 1, "h1: one identifiers GET")
  expect(checkBatch(handle, ticket: ticket, candidates: [Candidate(id: "k2", staged: false)], caches: caches) == [], "h2: k2 promoted")
  expect(server.requests(idsPath).count == 1, "h2: the cached map covered k2: no second GET")
  // k4 was marked by another install of this device since: not in the cache.
  server.with { $0.map["k4"] = "f-k4"; $0.files["f-k4"] = false }
  expect(checkBatch(handle, ticket: ticket, candidates: [Candidate(id: "k4", staged: false)], caches: caches) == [], "h3: k4 promoted")
  expect(server.requests(idsPath).count == 2, "h3: a hit the cache does not know fetches the map again")
  expect(remote(db, "k4") == "f-k4", "h3: with its server file id")
  // (i) /check says backed up, but the association is gone by the map read
  // (the file was deleted in between): it uploads.
  let checkOnly = Reply(status: 200, headers: ["Content-Type": "application/json"],
                        body: try! JSONSerialization.data(withJSONObject: ["already_backed_up": ["k3"], "needs_backup": []]))
  server.with { $0.map["k3"] = nil; $0.files["f-k3"] = nil; $0.failing = [checkPath: checkOnly] }
  let fresh = EngineCaches()
  expect(checkBatch(handle, ticket: ticket, candidates: [Candidate(id: "k3", staged: false)], caches: fresh) == ["k3"], "i1: a hit the map no longer has uploads")
  expect(status(db, "k3") == "pending_upload", "i1: and is not promoted")
  server.with { $0.failing = [:] }
}

// MARK: - (j) finding 4: a failed scan insert stays recorded

do {
  var health = ScanInsertHealth()
  health.record(inserted: false, source: .fullScan)
  expect(health.failed, "j1: a failed full scan insert is recorded")
  health.record(inserted: true, source: .incremental)
  expect(health.failed, "j2: a later successful observer insert does NOT clear it")
  health.record(inserted: false, source: .incremental)
  expect(health.failed, "j3: a failed observer insert keeps it")
  health.record(inserted: true, source: .fullScan)
  expect(!health.failed, "j4: a successful full scan clears it")
  health.record(inserted: false, source: .incremental)
  expect(health.failed, "j5: a failed observer insert sets it too")
}

// MARK: - Result

print("pending-upload-server-check-test: \(failures.isEmpty ? "PASS" : "FAIL")")
for f in failures { print("  FAILED: \(f)") }
print("pending-upload-server-check-test: \(total) assertions, \(failures.count) failed")
exit(failures.isEmpty ? 0 : 1)
