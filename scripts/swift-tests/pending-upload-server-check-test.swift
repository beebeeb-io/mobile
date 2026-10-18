import Darwin
import Foundation
import SQLite3

// Task 1667 round 10 (review of mobile#182 at 060bfeb0, findings 1, 2 and 4),
// reworked in round 11 (review of de23774e, findings 2 and 9; server task
// 2036) — standalone swiftc test for the camera-roll dedupe against the
// server. Compiled with the REAL shipped sources
// (PendingUploadServerCheck.swift, PhotoBackupServerClient.swift,
// PhotoBackupServerResponses.swift, BackupManifestStore.swift,
// ManifestRebuildGate.swift, ManifestWriteFence.swift,
// BackupManifestHandle.swift) by scripts/swift-ci/run-swift-tests.sh, against
// a real SQLite manifest, with every request answered by a fake server
// (URLProtocol) with task 2036's semantics:
//   - `POST /photo-backup/check` and `GET /photo-backup/identifiers` read
//     `photo_backup_state` for the device header and leave out files in the
//     Trash; `/check` also returns `backed_up: [{local_identifier, file_id}]`;
//   - `task2036 = false` plays a server without 2036 (no `backed_up`, no
//     Trash filter);
//   - `GET /files/index` is not served: any request to it is logged and the
//     run asserts there were none.
//
// `checkBatch` / `bulkPass` below are `NativeBackupEngine
// .rowsCheckedAgainstServer` / `.bulkServerCheckIfRequested` with the
// engine's own steps (the engine needs PhotoKit/UIKit and cannot be compiled
// here; native-backup-manifest-wiring.test.ts pins its wiring).
//
// What it proves:
//   (a) finding 1: rows inserted AFTER the one-shot rebuild are checked: the
//       server's hits become `uploaded` with the file id from `backed_up`.
//   (b) the observer race: the full scan's rows are caught by the check.
//   (c) a file in the Trash is not a backup: the server leaves it out, so
//       the row uploads (batch check, rebuild, a re-queued row).
//   (d) fail closed: every failed step or malformed body defers the batch.
//   (e) round 11 finding 2: a server without `backed_up` fails closed:
//       nothing promoted, nothing uploads, fetch backoff, logged once; the
//       rebuild applies nothing either once that was seen.
//   (f) fenced: a check that spans a sign-out reset writes nothing.
//   (g) /check is chunked at the route's 500 cap.
//   (h) round 11 finding 9: the bulk pass asks about ALL pending rows in
//       chunks of 500 and promotes the hits; the per-batch guard skips the
//       rows it covered and still checks new or uncovered ones; a failed
//       bulk chunk leaves its rows to the per-batch guard.
//   (i) round 11 finding 9 cost: 5,000 videos the server already has are
//       promoted with 10 `/check` requests (was ~420 batch cycles).
//   (j) a failed scan insert stays recorded until a FULL scan inserts.
//   (k) round 11 finding 2: no request ever went to `GET /files/index`.

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
  /// false: a server without task 2036 (no `backed_up`, no Trash filter).
  var task2036 = true
  /// Injected failures per path.
  var failing: [String: Reply] = [:]
  var log: [LoggedRequest] = []

  func reset() {
    lock.lock(); defer { lock.unlock() }
    map = [:]; files = [:]; failing = [:]; log = []; task2036 = true
  }

  func with<T>(_ body: (FakeServer) -> T) -> T { lock.lock(); defer { lock.unlock() }; return body(self) }

  func requests(_ path: String) -> [LoggedRequest] { with { $0.log.filter { $0.path == path } } }

  static func json(_ object: Any, status: Int = 200) -> Reply {
    Reply(status: status, headers: ["Content-Type": "application/json"], body: try! JSONSerialization.data(withJSONObject: object))
  }

  /// The device's associations the route reads: with task 2036 only files
  /// out of the Trash (`JOIN files f ... AND f.is_trashed = FALSE`).
  func visible(_ deviceMap: [String: String]) -> [String: String] {
    guard task2036 else { return deviceMap }
    return deviceMap.filter { files[$0.value] == false }
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
    let deviceMap = visible(device == deviceId ? map : [:])
    switch comps.path {
    case "/api/v1/files/photo-backup/check":
      guard checkIds.count <= 500 else { return Self.json(["error": "too many"], status: 400) }
      let hits = checkIds.filter { deviceMap[$0] != nil }
      let needs = checkIds.filter { deviceMap[$0] == nil }
      var out: [String: Any] = ["already_backed_up": hits, "needs_backup": needs]
      if task2036 {
        out["backed_up"] = hits.map { ["local_identifier": $0, "file_id": deviceMap[$0]!] }
      }
      return Self.json(out)
    case "/api/v1/files/photo-backup/identifiers":
      var out: [String: String] = [:]
      for (local, file) in deviceMap { out[file] = local }
      return Self.json(["identifiers": out])
    default:
      // Includes /api/v1/files/index: native code must never ask for it.
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

// MARK: - The engine's two passes (NativeBackupEngine)

struct Candidate {
  let id: String
  let staged: Bool
}

final class EngineState {
  var coverage = ServerCheckCoverage()
  var lacksBackedUp = false
}

func steps(_ handle: BackupManifestHandle, ticket: ManifestWriteFence.Ticket?, device: String = deviceId,
           state: EngineState, current: @escaping () -> Bool = { true }) -> PendingUploadServerCheck.Steps {
  let c = client(device: device)
  return PendingUploadServerCheck.Steps(
    hasDeviceId: { !device.isEmpty },
    check: { ids in
      do {
        let hits = try await c.check(ids)
        state.lacksBackedUp = false
        return hits
      } catch let error as PhotoBackupServerResponses.ServerLacksBackedUp {
        state.lacksBackedUp = true
        throw error
      }
    },
    isStillCurrent: current,
    promote: { hits in
      FencedManifestWrites.promoteCheckedHits(
        handle.db, fence: handle.writeFence, ticket: ticket, accountId: accountA,
        hits: hits, uploadedAtIso: "2026-10-18T10:00:00Z", nowMs: now
      )
    }
  )
}

/// `rowsCheckedAgainstServer`: the rows the batch would upload, or nil
/// (deferred: nothing uploads).
func checkBatch(
  _ handle: BackupManifestHandle, ticket: ManifestWriteFence.Ticket?, candidates: [Candidate],
  state: EngineState = EngineState(), device: String = deviceId, current: @escaping () -> Bool = { true },
  outcome outBox: Box<PendingUploadServerCheck.Outcome>? = nil
) -> [String]? {
  let freshAll = candidates.filter { !$0.staged }.map(\.id)
  guard !freshAll.isEmpty else { return candidates.map(\.id) }
  let fresh = state.coverage.uncovered(freshAll, accountId: accountA, generation: ticket?.generation ?? 0, now: Date())
  guard !fresh.isEmpty else { return candidates.map(\.id) }
  let st = steps(handle, ticket: ticket, device: device, state: state, current: current)
  guard let outcome = runBounded({ await PendingUploadServerCheck.run(candidates: fresh, steps: st) }) else {
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

/// `bulkServerCheckIfRequested`: every fresh pending row not covered yet.
func bulkPass(_ handle: BackupManifestHandle, ticket: ManifestWriteFence.Ticket, state: EngineState) -> PendingUploadServerCheck.BulkOutcome? {
  guard let all = BackupManifestStore.freshPendingIds(handle.db!) else { return nil }
  let candidates = state.coverage.uncovered(all, accountId: accountA, generation: ticket.generation, now: Date())
  let st = steps(handle, ticket: ticket, state: state)
  let outcome = runBounded { await PendingUploadServerCheck.bulk(candidates: candidates, steps: st) }
  if let outcome {
    state.coverage.record(outcome.needsBackup, accountId: accountA, generation: ticket.generation, now: Date())
  }
  return outcome
}

/// The rebuild gate as the engine runs it: the identifiers map only, and no
/// map at all once the server was seen without `backed_up`.
func runRebuildGate(_ handle: BackupManifestHandle, ticket: ManifestWriteFence.Ticket, alreadyReady: Bool,
                    state: EngineState = EngineState()) -> ManifestRebuildGate.Outcome? {
  let c = client()
  let steps = ManifestRebuildGate.Steps(
    needsRebuild: {
      FencedManifestWrites.needsRebuild(handle.db, fence: handle.writeFence, ticket: ticket, accountId: accountA,
                                        scanInsertFailed: false, nowMs: now)
    },
    hasDeviceId: { true },
    fetchMap: {
      guard !state.lacksBackedUp else { throw PhotoBackupServerResponses.ServerLacksBackedUp() }
      return try await c.identifierMap()
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
/// Every request any section sent to the file index (asserted 0 at the end).
var indexRequestsSeen = 0
func resetServer() {
  indexRequestsSeen += server.requests(indexPath).count
  server.reset()
}

/// Account A already backed up p1..p3 from this device (manifest + server).
func seedBackedUpPhotos(_ db: OpaquePointer) {
  _ = insert(db, ["p1", "p2", "p3"])
  for (i, p) in ["p1", "p2", "p3"].enumerated() {
    exec(db, "UPDATE backup_assets SET status = 'uploaded', remote_file_id = 'f-p\(i + 1)', uploaded_account_id = '\(accountA)', server_marked_at = \(now) WHERE local_asset_id = '\(p)'")
    server.with { $0.map[p] = "f-p\(i + 1)"; $0.files["f-p\(i + 1)"] = false }
  }
}

func onServer(_ local: String, _ file: String, trashed: Bool = false) {
  server.with { $0.map[local] = file; $0.files[file] = trashed }
}

// MARK: - (a) finding 1: rows inserted after the one-shot rebuild

do {
  resetServer()
  let (handle, db) = manifest("a-videos")
  let ticket = handle.writeFence.issue(for: accountA)!
  seedBackedUpPhotos(db)
  onServer("v1", "f-v1")
  onServer("v2", "f-v2")
  let gate = runRebuildGate(handle, ticket: ticket, alreadyReady: false)
  expect(gate == .ready(rebuilt: false, promoted: 0, keptApplied: 0), "a0: control: the gate does not rebuild a manifest with uploads (got \(String(describing: gate)))")
  expect(insert(db, ["v1", "v2", "v3"], type: "video"), "a1: the scan inserts the videos")
  let upload = checkBatch(handle, ticket: ticket, candidates: ["v1", "v2", "v3"].map { Candidate(id: $0, staged: false) })
  expect(upload == ["v3"], "a2: only the video the server does not have uploads (got \(String(describing: upload)))")
  expect(status(db, "v1") == "uploaded" && status(db, "v2") == "uploaded", "a3: the server's videos are uploaded in the manifest")
  expect(remote(db, "v1") == "f-v1" && remote(db, "v2") == "f-v2", "a3: with the file ids from backed_up")
  expect(marked(db, "v1") && marked(db, "v2"), "a3: and already marked (the server has them)")
  expect(status(db, "v3") == "pending_upload", "a3: v3 stays queued")
  let checks = server.requests(checkPath)
  expect(checks.count == 1 && checks[0].checkCount == 3 && checks[0].method == "POST", "a4: one /check with the 3 fresh rows")
  expect(server.requests(idsPath).count == 0, "a4: the batch needs no identifiers GET (file ids come with /check)")
  expect(server.with { $0.log }.allSatisfy { $0.deviceHeader == deviceId }, "a4: every request carries the device id")
  onServer("p9", "f-p9")
  expect(insert(db, ["p9", "p10"]), "a5: new photos from the wider selection")
  let upload2 = checkBatch(handle, ticket: ticket, candidates: [Candidate(id: "p9", staged: false), Candidate(id: "p10", staged: false)])
  expect(upload2 == ["p10"], "a5: p9 (on the server) is not uploaded again (got \(String(describing: upload2)))")
  server.with { $0.log = [] }
  let staged = checkBatch(handle, ticket: ticket, candidates: [Candidate(id: "s1", staged: true)])
  expect(staged == ["s1"], "a6: a staged row continues its upload")
  expect(server.requests(checkPath).isEmpty, "a6: and costs no /check")
}

// MARK: - (b) the observer race: the rebuild ran on the first few rows only

do {
  resetServer()
  let (handle, db) = manifest("b-race")
  let ticket = handle.writeFence.issue(for: accountA)!
  for i in 1...6 { onServer("r\(i)", "f-r\(i)") }
  expect(insert(db, ["r1"]), "b0: the observer inserts one row")
  let gate = runRebuildGate(handle, ticket: ticket, alreadyReady: false)
  expect(gate == .ready(rebuilt: true, promoted: 1, keptApplied: 0), "b1: the rebuild promotes the one row it sees (got \(String(describing: gate)))")
  expect(insert(db, ["r2", "r3", "r4", "r5", "r6", "n1"]), "b2: the full scan inserts the rest")
  let upload = checkBatch(handle, ticket: ticket, candidates: ["r2", "r3", "r4", "r5", "r6", "n1"].map { Candidate(id: $0, staged: false) })
  expect(upload == ["n1"], "b3: only the new photo uploads (got \(String(describing: upload)))")
  expect((2...6).allSatisfy { status(db, "r\($0)") == "uploaded" }, "b3: the server's photos are uploaded in the manifest")
}

// MARK: - (c) a file in the Trash is not a backup (the server leaves it out)

do {
  resetServer()
  let (handle, db) = manifest("c-trash")
  let ticket = handle.writeFence.issue(for: accountA)!
  onServer("t1", "f-t1", trashed: true)
  onServer("t2", "f-t2")
  expect(insert(db, ["t1", "t2"]), "c0: rows queued")
  let box = Box<PendingUploadServerCheck.Outcome>()
  let upload = checkBatch(handle, ticket: ticket, candidates: [Candidate(id: "t1", staged: false), Candidate(id: "t2", staged: false)], outcome: box)
  expect(upload == ["t1"], "c1: the trashed photo uploads again, the live one does not (got \(String(describing: upload)))")
  expect(status(db, "t1") == "pending_upload" && remote(db, "t1") == "NULL", "c1: the trashed photo is NOT promoted")
  expect(status(db, "t2") == "uploaded" && remote(db, "t2") == "f-t2", "c1: the live one is promoted with its file id")
  expect(box.get() == .proceed(skip: ["t2"], promoted: ["t2"], checked: ["t1", "t2"]), "c1: outcome (got \(String(describing: box.get())))")

  let (h2, db2) = manifest("c-trash-rebuild")
  let t2 = h2.writeFence.issue(for: accountA)!
  expect(insert(db2, ["t1", "t2"]), "c2: the scan after a sign-in")
  let gate = runRebuildGate(h2, ticket: t2, alreadyReady: false)
  expect(gate == .ready(rebuilt: true, promoted: 1, keptApplied: 0), "c3: the rebuild (identifiers map only) promotes only the live file (got \(String(describing: gate)))")
  expect(status(db2, "t1") == "pending_upload", "c3: the trashed photo stays queued after the rebuild")

  exec(db, "UPDATE backup_assets SET status = 'pending_upload', remote_file_id = NULL, uploaded_at = NULL WHERE local_asset_id = 't2'")
  server.with { $0.files["f-t2"] = true }
  let requeued = checkBatch(handle, ticket: ticket, candidates: [Candidate(id: "t2", staged: false)])
  expect(requeued == ["t2"], "c4: the re-queued photo whose file was trashed uploads (got \(String(describing: requeued)))")
  expect(status(db, "t2") == "pending_upload", "c4: and is not promoted back")
  server.with { $0.files["f-t1"] = false }
  let restored = checkBatch(handle, ticket: ticket, candidates: [Candidate(id: "t1", staged: false)])
  expect(restored == [], "c5: a restored file counts again (got \(String(describing: restored)))")
}

// MARK: - (d) fail closed

do {
  resetServer()
  let (handle, db) = manifest("d-fail")
  let ticket = handle.writeFence.issue(for: accountA)!
  onServer("d1", "f-d1")
  expect(insert(db, ["d1", "d2"]), "d0: rows queued")
  let cands = [Candidate(id: "d1", staged: false), Candidate(id: "d2", staged: false)]
  let ok: [String: Any] = ["already_backed_up": ["d1"], "needs_backup": ["d2"],
                           "backed_up": [["local_identifier": "d1", "file_id": "f-d1"]]]
  func body(_ change: (inout [String: Any]) -> Void) -> Reply {
    var b = ok
    change(&b)
    return FakeServer.json(b)
  }
  let cases: [(String, Reply)] = [
    ("check 500", Reply(status: 500, headers: [:], body: Data())),
    ("check 404 (proxy)", Reply(status: 404, headers: ["Content-Type": "text/html"], body: Data("<html>".utf8))),
    ("check 404 (API body)", Reply(status: 404, headers: ["Content-Type": "application/json"], body: Data(#"{"error":"not found"}"#.utf8))),
    ("body without needs_backup", body { $0["needs_backup"] = nil }),
    ("a hit it did not ask for", body { $0["already_backed_up"] = ["zzz"]; $0["needs_backup"] = ["d1", "d2"] }),
    ("an id in both lists", body { $0["needs_backup"] = ["d1", "d2"] }),
    ("an asked id missing", body { $0["already_backed_up"] = []; $0["backed_up"] = [] }),
    ("a non-string entry", body { $0["already_backed_up"] = [1] }),
    ("backed_up not an array", body { $0["backed_up"] = ["d1": "f-d1"] }),
    ("backed_up entry without file_id", body { $0["backed_up"] = [["local_identifier": "d1"]] }),
    ("backed_up entry with an empty file_id", body { $0["backed_up"] = [["local_identifier": "d1", "file_id": ""]] }),
    ("backed_up entry with a numeric file_id", body { $0["backed_up"] = [["local_identifier": "d1", "file_id": 7]] }),
    ("backed_up names an id it was not asked", body { $0["backed_up"] = [["local_identifier": "zzz", "file_id": "f-z"]] }),
    ("backed_up names an id twice", body { $0["backed_up"] = [["local_identifier": "d1", "file_id": "f-d1"], ["local_identifier": "d1", "file_id": "f-x"]] }),
    ("backed_up misses a hit", body { $0["backed_up"] = [] }),
    ("backed_up names a needs_backup id", body { $0["backed_up"] = [["local_identifier": "d1", "file_id": "f-d1"], ["local_identifier": "d2", "file_id": "f-d2"]] }),
  ]
  for (label, reply) in cases {
    server.with { $0.failing = [checkPath: reply] }
    let box = Box<PendingUploadServerCheck.Outcome>()
    let upload = checkBatch(handle, ticket: ticket, candidates: cands, outcome: box)
    expect(upload == nil, "d1: \(label): nothing uploads (got \(String(describing: upload)))")
    expect(box.get() == .deferred(.checkFailed), "d1: \(label): deferred(checkFailed) (got \(String(describing: box.get())))")
    expect(status(db, "d1") == "pending_upload" && status(db, "d2") == "pending_upload", "d1: \(label): no row changed")
  }
  server.with { $0.failing = [:] }
  expect(PendingUploadServerCheck.backoff(for: .checkFailed, consecutiveFailures: 1) == 30, "d2: check failure backs off 30 s")
  expect(PendingUploadServerCheck.backoff(for: .applyFailed, consecutiveFailures: 1) == 2, "d2: a write failure backs off 2 s first")
  expect(PendingUploadServerCheck.backoff(for: .accountChanged, consecutiveFailures: 1) == nil, "d2: an account change does not back off")
  let noDevice = Box<PendingUploadServerCheck.Outcome>()
  expect(checkBatch(handle, ticket: ticket, candidates: cands, device: "", outcome: noDevice) == nil, "d3: no device id: nothing uploads")
  expect(noDevice.get() == .deferred(.noDeviceId), "d3: deferred(noDeviceId)")
  let changed = Box<PendingUploadServerCheck.Outcome>()
  expect(checkBatch(handle, ticket: ticket, candidates: cands, current: { false }, outcome: changed) == nil, "d4: account changed: nothing uploads")
  expect(changed.get() == .deferred(.accountChanged) && status(db, "d1") == "pending_upload", "d4: deferred(accountChanged), nothing written")
  let locker = connect(handle.path)
  exec(locker, "BEGIN IMMEDIATE")
  sqlite3_busy_timeout(handle.db!, 0)
  let locked = Box<PendingUploadServerCheck.Outcome>()
  expect(checkBatch(handle, ticket: ticket, candidates: cands, outcome: locked) == nil, "d5: writer lock: nothing uploads")
  expect(locked.get() == .deferred(.applyFailed), "d5: deferred(applyFailed) (got \(String(describing: locked.get())))")
  exec(locker, "ROLLBACK")
  sqlite3_close_v2(locker)
  expect(status(db, "d1") == "pending_upload", "d5: nothing promoted under the lock")
  expect(checkBatch(handle, ticket: ticket, candidates: cands) == ["d2"], "d6: after the lock: d1 promoted, d2 uploads")
}

// MARK: - (e) round 11 finding 2: a server without `backed_up` fails closed

do {
  resetServer()
  server.with { $0.task2036 = false }
  let (handle, db) = manifest("e-old-server")
  let ticket = handle.writeFence.issue(for: accountA)!
  onServer("o1", "f-o1")                 // live
  onServer("o2", "f-o2", trashed: true)  // only copy in the Trash (the old server cannot tell)
  expect(insert(db, ["o1", "o2", "o3"]), "e0: rows queued")
  let state = EngineState()
  let box = Box<PendingUploadServerCheck.Outcome>()
  let upload = checkBatch(handle, ticket: ticket, candidates: ["o1", "o2", "o3"].map { Candidate(id: $0, staged: false) },
                          state: state, outcome: box)
  expect(upload == nil, "e1: nothing of the batch uploads (got \(String(describing: upload)))")
  expect(box.get() == .deferred(.serverLacksBackedUp), "e1: deferred(serverLacksBackedUp) (got \(String(describing: box.get())))")
  expect(["o1", "o2", "o3"].allSatisfy { status(db, $0) == "pending_upload" }, "e2: nothing promoted (not even the old server's hits)")
  expect(PendingUploadServerCheck.backoff(for: .serverLacksBackedUp, consecutiveFailures: 1) == 30, "e3: the fetch backoff (30 s)")
  // The rebuild applies nothing once the server was seen without backed_up.
  let (h2, db2) = manifest("e-old-server-rebuild")
  let t2 = h2.writeFence.issue(for: accountA)!
  expect(insert(db2, ["o1", "o2"]), "e4: an emptied manifest after a sign-in")
  let gate = runRebuildGate(h2, ticket: t2, alreadyReady: false, state: state)
  expect(gate == .deferred(.fetchFailed), "e4: the rebuild defers on a server without backed_up (got \(String(describing: gate)))")
  expect(status(db2, "o2") == "pending_upload" && status(db2, "o1") == "pending_upload", "e4: nothing promoted from the unfiltered map")
  // The bulk pass stops at once and promotes nothing.
  let bulk = bulkPass(handle, ticket: ticket, state: state)
  expect(bulk?.stopped == .serverLacksBackedUp && bulk?.promoted.isEmpty == true && bulk?.needsBackup.isEmpty == true,
         "e5: the bulk pass stops, nothing promoted or covered (got \(String(describing: bulk)))")
  // Logged once per process.
  let notice = PendingUploadServerCheck.OnceNotice()
  expect(notice.shouldFire() && !notice.shouldFire() && !notice.shouldFire(), "e6: the notice fires once")
  expect(PendingUploadServerCheck.serverLacksBackedUpMessage == "server lacks backed_up (task 2036)", "e6: the logged text")
  // Once the server has task 2036, the same batch goes through.
  server.with { $0.task2036 = true }
  let after = checkBatch(handle, ticket: ticket, candidates: ["o1", "o2", "o3"].map { Candidate(id: $0, staged: false) }, state: state)
  expect(after == ["o2", "o3"], "e7: with task 2036 the live hit is promoted, the trashed one and the new one upload (got \(String(describing: after)))")
  expect(!state.lacksBackedUp, "e7: the flag clears on the first answer with backed_up")
}

// MARK: - (f) fenced: a check that spans a sign-out reset writes nothing

do {
  resetServer()
  let (handle, db) = manifest("f-fence")
  let ticket = handle.writeFence.issue(for: accountA)!
  onServer("e1", "f-e1")
  expect(insert(db, ["e1"]), "f0: row queued")
  let box = Box<PendingUploadServerCheck.Outcome>()
  let upload = checkBatch(handle, ticket: ticket, candidates: [Candidate(id: "e1", staged: false)],
                          current: { handle.resetForSignOut(outgoingAccountId: accountA) || true }, outcome: box)
  expect(upload == nil, "f1: nothing uploads")
  expect(box.get() == .deferred(.applyFailed), "f1: the promotion is fenced (got \(String(describing: box.get())))")
  expect(rows(handle.db!, "SELECT COUNT(*) FROM backup_assets").first?.first == "0", "f2: the emptied manifest stays empty")
}

// MARK: - (g) /check is chunked at the route's 500 cap

do {
  resetServer()
  let (handle, db) = manifest("g-chunks")
  let ticket = handle.writeFence.issue(for: accountA)!
  let ids = (0..<1201).map { "g\($0)" }
  expect(insert(db, ids), "g0: 1201 rows queued")
  onServer("g700", "f-g700")
  let upload = checkBatch(handle, ticket: ticket, candidates: ids.map { Candidate(id: $0, staged: false) })
  let checks = server.requests(checkPath)
  expect(checks.map(\.checkCount) == [500, 500, 201], "g1: three /check calls of 500, 500, 201 (got \(checks.map(\.checkCount)))")
  expect(upload?.count == 1200 && upload?.contains("g700") == false, "g1: the one hit in the second chunk is not uploaded")
}

// MARK: - (h) round 11 finding 9: the bulk pass

do {
  resetServer()
  let (handle, db) = manifest("h-bulk")
  let ticket = handle.writeFence.issue(for: accountA)!
  let ids = (0..<1201).map { "k\($0)" }
  expect(insert(db, ids), "h0: 1201 rows queued")
  for i in 0..<900 { onServer("k\(i)", "f-k\(i)") }
  onServer("k950", "f-k950", trashed: true)
  // A staged row is a resumption: not part of the bulk pass.
  exec(db, "UPDATE backup_assets SET status = 'staged_upload', staged_file_id = 'f-staged' WHERE local_asset_id = 'k1200'")
  let state = EngineState()
  let bulk = bulkPass(handle, ticket: ticket, state: state)
  let checks = server.requests(checkPath)
  expect(checks.map(\.checkCount) == [500, 500, 200], "h1: the bulk pass asks about all 1200 fresh rows in chunks of 500 (got \(checks.map(\.checkCount)))")
  expect(bulk?.requests == 3 && bulk?.promoted.count == 900 && bulk?.needsBackup.count == 300 && bulk?.stopped == nil,
         "h1: 900 promoted, 300 covered as needs backup (got \(String(describing: bulk)))")
  expect(status(db, "k0") == "uploaded" && remote(db, "k0") == "f-k0", "h2: a hit is uploaded with its file id")
  expect(status(db, "k950") == "pending_upload", "h2: the trashed one stays queued")
  // The per-batch guard skips covered rows: no request for a batch of them.
  server.with { $0.log = [] }
  let batch = checkBatch(handle, ticket: ticket, candidates: ["k950", "k951", "k952"].map { Candidate(id: $0, staged: false) }, state: state)
  expect(batch == ["k950", "k951", "k952"], "h3: covered rows upload")
  expect(server.requests(checkPath).isEmpty, "h3: and cost no /check")
  // A row inserted after the pass is checked per batch (only it).
  expect(insert(db, ["k-new"]), "h4: a new row")
  onServer("k-new", "f-k-new")
  let mixed = checkBatch(handle, ticket: ticket, candidates: ["k951", "k-new"].map { Candidate(id: $0, staged: false) }, state: state)
  expect(mixed == ["k951"], "h4: the new row (on the server) is promoted, the covered one uploads (got \(String(describing: mixed)))")
  expect(server.requests(checkPath).map(\.checkCount) == [1], "h4: one /check with just the uncovered row")
  // A second bulk pass asks only about uncovered rows (none now).
  server.with { $0.log = [] }
  let again = bulkPass(handle, ticket: ticket, state: state)
  expect(again?.requests == 0 && server.requests(checkPath).isEmpty, "h5: nothing left to ask (got \(String(describing: again)))")
  // Coverage is per generation: after a sign-out + sign-in nothing is covered.
  handle.writeFence.advanceForSignOut()
  handle.writeFence.bind(accountId: accountA)
  let newTicket = handle.writeFence.issue(for: accountA)!
  expect(state.coverage.uncovered(["k951"], accountId: accountA, generation: newTicket.generation, now: Date()) == ["k951"],
         "h6: a new generation is not covered")
  expect(state.coverage.uncovered(["k951"], accountId: "acct-other", generation: ticket.generation, now: Date()) == ["k951"],
         "h6: another account is not covered")
  expect(state.coverage.uncovered(["k951"], accountId: accountA, generation: ticket.generation,
                                  now: Date().addingTimeInterval(ServerCheckCoverage.maxAge + 1)) == ["k951"],
         "h6: coverage expires after 15 minutes")
  var cleared = state.coverage
  cleared.clear()
  expect(cleared.uncovered(["k951"], accountId: accountA, generation: ticket.generation, now: Date()) == ["k951"], "h6: clear() uncovers")

  // A bulk chunk that fails: the chunks before it count, its rows and the
  // rest stay uncovered (the per-batch guard checks them, fail closed).
  resetServer()
  let (h2, db2) = manifest("h-bulk-fail")
  let t2 = h2.writeFence.issue(for: accountA)!
  let ids2 = (0..<1000).map { String(format: "m%04d", $0) }
  // Newest first: m0999 .. m0000 (created_at ascending by id).
  for (i, id) in ids2.enumerated() {
    _ = BackupManifestStore.insertScannedAssets(db2, [BackupManifestStore.ScannedAsset(localAssetId: id, createdAt: String(format: "2026-10-18T10:%02d:%02dZ", i / 60, i % 60), assetType: "photo")], nowMs: now)
  }
  onServer("m0999", "f-m0999") // in the first chunk (newest)
  onServer("m0000", "f-m0000") // in the second chunk
  let state2 = EngineState()
  // The second /check fails.
  var calls = 0
  let st = PendingUploadServerCheck.Steps(
    hasDeviceId: { true },
    check: { ids in
      calls += 1
      if calls == 2 { throw PhotoBackupServerResponses.UnexpectedResponse(statusCode: 503, reason: "test") }
      return try await client().check(ids)
    },
    isStillCurrent: { true },
    promote: { hits in
      FencedManifestWrites.promoteCheckedHits(h2.db, fence: h2.writeFence, ticket: t2, accountId: accountA,
                                              hits: hits, uploadedAtIso: "2026-10-18T10:00:00Z", nowMs: now)
    }
  )
  let all = BackupManifestStore.freshPendingIds(db2) ?? []
  expect(all.count == 1000 && all.first == "m0999", "h7: fresh rows newest first (got \(all.count), first \(all.first ?? "-"))")
  let partial = runBounded { await PendingUploadServerCheck.bulk(candidates: all, steps: st) }
  expect(partial?.stopped == .checkFailed && partial?.requests == 2, "h7: the pass stops at the failed chunk (got \(String(describing: partial)))")
  expect(partial?.promoted == ["m0999"] && partial?.needsBackup.count == 499, "h7: the first chunk's work counts")
  if let partial { state2.coverage.record(partial.needsBackup, accountId: accountA, generation: t2.generation, now: Date()) }
  expect(status(db2, "m0000") == "pending_upload", "h8: the failed chunk's hit is not promoted")
  let guardBatch = checkBatch(h2, ticket: t2, candidates: [Candidate(id: "m0000", staged: false), Candidate(id: "m0500", staged: false)], state: state2)
  expect(guardBatch == ["m0500"], "h8: the per-batch guard checks the uncovered rows: the hit is promoted (got \(String(describing: guardBatch)))")
  expect(status(db2, "m0000") == "uploaded", "h8: m0000 promoted by the guard")
}

// MARK: - (i) round 11 finding 9 cost: 5,000 hits, bulk first, then batches of 12

do {
  resetServer()
  let (handle, db) = manifest("i-cost")
  let ticket = handle.writeFence.issue(for: accountA)!
  seedBackedUpPhotos(db)
  let videos = (0..<5000).map { "vid\($0)" }
  expect(insert(db, videos, type: "video"), "i0: 5,000 videos switched on")
  for v in videos { server.with { $0.map[v] = "f-\(v)"; $0.files["f-\(v)"] = false } }
  let state = EngineState()
  // The drain: one bulk pass at its start, then batches of 12 until no fresh row is left.
  _ = bulkPass(handle, ticket: ticket, state: state)
  var cycles = 0
  while let pending = BackupManifestStore.freshPendingIds(handle.db!), !pending.isEmpty, cycles < 1000 {
    cycles += 1
    let batch = Array(pending.prefix(12)).map { Candidate(id: $0, staged: false) }
    guard let upload = checkBatch(handle, ticket: ticket, candidates: batch, state: state) else { break }
    // What the batch would upload, modelled as uploaded.
    for id in upload { exec(db, "UPDATE backup_assets SET status = 'uploaded' WHERE local_asset_id = '\(id)'") }
  }
  let requests = server.requests(checkPath).count
  expect(requests == 10, "i1: 5,000 hits cost 10 /check requests (got \(requests))")
  expect(cycles == 0, "i1: no batch cycle was needed to promote them (got \(cycles))")
  expect(rows(db, "SELECT COUNT(*) FROM backup_assets WHERE status = 'uploaded' AND local_asset_id LIKE 'vid%'").first?.first == "5000",
         "i2: all 5,000 are uploaded in the manifest")
}

// MARK: - (j) a failed scan insert stays recorded

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

// MARK: - (k) round 11 finding 2: no request ever reached GET /files/index

resetServer()
expect(indexRequestsSeen == 0, "k1: native code never asked for /api/v1/files/index (got \(indexRequestsSeen))")

// MARK: - Result

print("pending-upload-server-check-test: \(failures.isEmpty ? "PASS" : "FAIL")")
for f in failures { print("  FAILED: \(f)") }
print("pending-upload-server-check-test: \(total) assertions, \(failures.count) failed")
exit(failures.isEmpty ? 0 : 1)
