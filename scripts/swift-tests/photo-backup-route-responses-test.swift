import Darwin
import Foundation
import SQLite3

// Task 1667 round 5 (Codex P1 "Fail closed when the identifier route returns
// 404") — standalone swiftc test for how the engine reads the two
// photo-backup map routes. Compiled with the REAL shipped sources
// (modules/beebeeb-crypto/ios/PhotoBackupServerResponses.swift,
// BackupManifestStore.swift, ManifestRebuildGate.swift, SignOutMarkFlush.swift)
// by scripts/swift-ci/run-swift-tests.sh.
//
// Every server this app talks to has both routes, and the identifiers handler
// (server routes/photo_backup.rs `identifier_map`) never answers 404. The mark
// handler answers 404 with the API's own body when the file is gone or not the
// caller's (`ApiError::NotFound` -> `{"error":"not found"}`, application/json,
// server beebeeb-api/src/error.rs). What it proves:
//   1. An identifiers 404 (any body) is a failed fetch, never an empty map.
//   2. A mark 404 is "file gone, done" ONLY with the API's exact NotFound
//      body; any other 404 (HTML, empty, wrong shape, wrong type) is a failure.
//   3. End to end through the real rebuild gate on a real SQLite manifest,
//      with real HTTP responses from a URLProtocol stub: an identifiers 404
//      defers (no upload starts, the gate is not ready, the fetch backoff
//      applies); a later 200 applies the map.
//   4. End to end through the real sign-out flush + reset + re-sign-in: a mark
//      404 with the API body is done; a mark 404 with any other body stays
//      unmarked, is kept as a pending mark by the sign-out reset, survives
//      another account's sign-in, and is promoted at the next sign-in.

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
func runBounded<T>(watchdog: TimeInterval = 20, _ op: @escaping () async -> T) -> T? {
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

// MARK: - Responses

let apiNotFound = Data(#"{"error":"not found"}"#.utf8)
let json = ["Content-Type": "application/json"]
let html = ["Content-Type": "text/html"]
let proxyHtml = Data("<html><head><title>404 Not Found</title></head><body>404 Not Found</body></html>".utf8)

struct Reply {
  let status: Int
  let headers: [String: String]
  let body: Data
}

/// The non-API 404s a proxy, a load balancer or a routing mistake can answer
/// with. None of them is the mark handler saying "file gone".
let foreign404s: [(label: String, reply: Reply)] = [
  ("HTML page", Reply(status: 404, headers: html, body: proxyHtml)),
  ("empty body, no type", Reply(status: 404, headers: [:], body: Data())),
  ("empty JSON body", Reply(status: 404, headers: json, body: Data())),
  ("API body as text/html", Reply(status: 404, headers: html, body: apiNotFound)),
  ("API body, no type", Reply(status: 404, headers: [:], body: apiNotFound)),
  ("NotFoundWithMessage shape", Reply(status: 404, headers: json, body: Data(#"{"error":"not found","message":"Gone."}"#.utf8))),
  ("different casing", Reply(status: 404, headers: json, body: Data(#"{"error":"Not Found"}"#.utf8))),
  ("different code", Reply(status: 404, headers: json, body: Data(#"{"error":"not_found"}"#.utf8))),
  ("other JSON key", Reply(status: 404, headers: json, body: Data(#"{"detail":"Not Found"}"#.utf8))),
  ("JSON array", Reply(status: 404, headers: json, body: Data(#"["not found"]"#.utf8))),
  ("JSON string", Reply(status: 404, headers: json, body: Data(#""not found""#.utf8))),
  ("plain text", Reply(status: 404, headers: ["Content-Type": "text/plain"], body: Data("not found".utf8))),
]

func fileGone(_ r: Reply) -> Bool {
  PhotoBackupServerResponses.markOutcome(statusCode: r.status, contentType: r.headers["Content-Type"], data: r.body) == .fileGone
}

// MARK: - 1. The identifiers route: any non-2xx, 404 included, is a failure

func identifiers(_ status: Int, _ body: Data) -> [String: String]? {
  try? PhotoBackupServerResponses.identifierMap(statusCode: status, data: body)
}

let goodMap = Data(#"{"identifiers":{"f-1":"p1","f-2":"p2"}}"#.utf8)
expect(identifiers(200, goodMap) == ["p1": "f-1", "p2": "f-2"], "identifiers 200: the map")
expect(identifiers(200, Data(#"{"identifiers":{}}"#.utf8)) == [:], "identifiers 200 with no rows: a valid empty map")
expect(identifiers(200, Data("{}".utf8)) == nil, "identifiers 200 with the wrong body: failure")
expect(identifiers(404, Data()) == nil, "identifiers 404, empty body: failure, not an empty map")
expect(identifiers(404, proxyHtml) == nil, "identifiers 404, HTML: failure, not an empty map")
expect(identifiers(404, apiNotFound) == nil, "identifiers 404, even with the API body: failure (the handler never 404s)")
expect(identifiers(404, Data(#"{"identifiers":{}}"#.utf8)) == nil, "identifiers 404 with a map-shaped body: failure")
for status in [301, 400, 401, 403, 405, 409, 429, 500, 502, 503] {
  expect(identifiers(status, goodMap) == nil, "identifiers \(status): failure")
}

// MARK: - 2. The mark route: 404 is "file gone" only with the API's NotFound body

func outcome(_ r: Reply) -> PhotoBackupServerResponses.MarkOutcome {
  PhotoBackupServerResponses.markOutcome(statusCode: r.status, contentType: r.headers["Content-Type"], data: r.body)
}

expect(outcome(Reply(status: 200, headers: json, body: Data(#"{"ok":true}"#.utf8))) == .marked, "mark 200: marked")
expect(outcome(Reply(status: 204, headers: [:], body: Data())) == .marked, "mark 204: marked")
expect(outcome(Reply(status: 404, headers: json, body: apiNotFound)) == .fileGone, "mark 404 + the API NotFound body: file gone")
expect(outcome(Reply(status: 404, headers: ["Content-Type": "application/json; charset=utf-8"], body: apiNotFound)) == .fileGone,
       "mark 404 + the API body with a charset parameter: file gone")
expect(outcome(Reply(status: 404, headers: ["Content-Type": "Application/JSON"], body: apiNotFound)) == .fileGone,
       "media type compared case-insensitively")
for (label, reply) in foreign404s {
  expect(outcome(reply) == .failed(statusCode: 404), "mark 404, \(label): a failure, not file gone (got \(outcome(reply)))")
}
for status in [400, 401, 403, 405, 409, 410, 429, 500, 502, 503] {
  let r = Reply(status: status, headers: json, body: apiNotFound)
  expect(outcome(r) == .failed(statusCode: status), "mark \(status) with a NotFound-looking body: failure")
}
expect(PhotoBackupServerResponses.MarkOutcome.marked.recordsServerMark, "marked records server_marked_at")
expect(PhotoBackupServerResponses.MarkOutcome.fileGone.recordsServerMark, "file gone records server_marked_at (done)")
expect(!PhotoBackupServerResponses.MarkOutcome.failed(statusCode: 404).recordsServerMark, "a failed 404 records nothing")

// MARK: - Stub transport (URLProtocol): replies per path + ?id=

final class StubRoutes: URLProtocol {
  static let lock = NSLock()
  static var replies: [String: Reply] = [:]
  static var hits: [String: Int] = [:]

  static func key(_ url: URL?) -> String {
    guard let url, let c = URLComponents(url: url, resolvingAgainstBaseURL: false) else { return "?" }
    let id = c.queryItems?.first(where: { $0.name == "id" })?.value
    return c.path + (id.map { "?id=\($0)" } ?? "")
  }

  static func set(_ k: String, _ r: Reply) { lock.lock(); replies[k] = r; lock.unlock() }
  static func hitCount(_ k: String) -> Int { lock.lock(); defer { lock.unlock() }; return hits[k] ?? 0 }
  static func reset() { lock.lock(); replies = [:]; hits = [:]; lock.unlock() }

  override class func canInit(with request: URLRequest) -> Bool { true }
  override class func canonicalRequest(for request: URLRequest) -> URLRequest { request }

  override func startLoading() {
    let k = Self.key(request.url)
    Self.lock.lock()
    Self.hits[k, default: 0] += 1
    let r = Self.replies[k] ?? Reply(status: 500, headers: [:], body: Data())
    Self.lock.unlock()
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
  config.timeoutIntervalForResource = 60
  config.protocolClasses = [StubRoutes.self]
  return URLSession(configuration: config)
}()

let base = "https://api.invalid/api/v1/files/photo-backup"
let identifiersPath = "/api/v1/files/photo-backup/identifiers"

/// NativeBackupEngine.fetchServerIdentifierMap's shape: GET, then the shipped
/// classifier on the status and body.
func fetchIdentifiers() async throws -> [String: String] {
  var request = URLRequest(url: URL(string: "\(base)/identifiers")!)
  request.httpMethod = "GET"
  let (data, response) = try await session.data(for: request)
  let status = (response as? HTTPURLResponse)?.statusCode ?? 0
  return try PhotoBackupServerResponses.identifierMap(statusCode: status, data: data)
}

/// NativeBackupEngine.markOnServer's shape: POST, the shipped classifier, and
/// `recordServerMarked` only when the outcome records a mark.
func markOnServer(_ db: OpaquePointer, assetId: String, fileId: String, timeout: TimeInterval) async -> Bool {
  var request = URLRequest(url: URL(string: "\(base)/mark?id=\(assetId)")!)
  request.httpMethod = "POST"
  request.timeoutInterval = timeout
  guard let result = try? await session.data(for: request) else { return false }
  let (data, response) = result
  let http = response as? HTTPURLResponse
  let outcome = PhotoBackupServerResponses.markOutcome(
    statusCode: http?.statusCode ?? 0,
    contentType: http?.value(forHTTPHeaderField: "Content-Type"),
    data: data
  )
  guard outcome.recordsServerMark else { return false }
  BackupManifestStore.recordServerMarked(db, assetId: assetId, fileId: fileId, nowMs: now)
  return true
}

// MARK: - SQLite fixtures

let fm = FileManager.default
let root = fm.temporaryDirectory.appendingPathComponent("bb-1667-routes-\(UUID().uuidString)", isDirectory: true)
try! fm.createDirectory(at: root, withIntermediateDirectories: true)
defer { try? fm.removeItem(at: root) }

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

let acctA = "acct-A"

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

func manifest(_ name: String) -> OpaquePointer {
  let db = open(root.appendingPathComponent(name).path)
  exec(db, schema)
  BackupManifestStore.migrate(db)
  return db
}

func insertPending(_ db: OpaquePointer, _ ids: [String]) {
  for id in ids {
    exec(db, """
    INSERT INTO backup_assets (local_asset_id, created_at, asset_type, status)
    VALUES ('\(id)', '2026-10-18T00:00:00Z', 'photo', 'pending_upload')
    """)
  }
}

/// An upload of acct-A the server's map does not have yet. `order` sets
/// uploaded_at, so the flush (newest first) visits rows in a known order.
func insertUnmarked(_ db: OpaquePointer, _ id: String, file: String, order: Int) {
  exec(db, """
  INSERT INTO backup_assets (local_asset_id, remote_file_id, created_at, asset_type, status,
                             uploaded_account_id, uploaded_at)
  VALUES ('\(id)', '\(file)', '2026-10-18T00:00:00Z', 'photo', 'uploaded', '\(acctA)',
          '2026-10-18T0\(order):00:00Z')
  """)
}

func pendingUploads(_ db: OpaquePointer) -> Int {
  scalar(db, "SELECT COUNT(*) FROM backup_assets WHERE status = 'pending_upload'")
}

func marked(_ db: OpaquePointer, _ id: String) -> Bool {
  scalar(db, "SELECT server_marked_at IS NOT NULL FROM backup_assets WHERE local_asset_id = '\(id)'") == 1
}

func kept(_ db: OpaquePointer, _ id: String) -> Bool {
  scalar(db, "SELECT COUNT(*) FROM backup_pending_marks WHERE account_id = '\(acctA)' AND local_asset_id = '\(id)'") == 1
}

/// NativeBackupEngine.ensureManifestReadyForUploads's wiring.
func gateSteps(_ db: OpaquePointer, fetches: Box<Int>, applies: Box<Int>) -> ManifestRebuildGate.Steps {
  ManifestRebuildGate.Steps(
    needsRebuild: {
      guard BackupManifestStore.claim(db, accountId: acctA, nowMs: now) != nil else { return nil }
      return BackupManifestStore.needsServerRebuild(db, accountId: acctA)
    },
    hasDeviceId: { true },
    fetchMap: {
      fetches.set((fetches.get() ?? 0) + 1)
      return try await fetchIdentifiers()
    },
    isStillCurrent: { true },
    applyMap: { map in
      applies.set((applies.get() ?? 0) + 1)
      return BackupManifestStore.applyServerMap(
        db, accountId: acctA, localToFileId: map, uploadedAtIso: "2026-10-18T03:00:00Z", nowMs: now
      )
    },
    applyKept: { BackupManifestStore.applyPendingMarks(db, accountId: acctA, nowMs: now) }
  )
}

func runGate(_ db: OpaquePointer, fetches: Box<Int> = Box(), applies: Box<Int> = Box()) -> ManifestRebuildGate.Outcome? {
  runBounded { await ManifestRebuildGate.run(alreadyReady: false, steps: gateSteps(db, fetches: fetches, applies: applies)) }
}

// MARK: - 3. Identifiers 404 through the real gate: deferred, then a 200 applies

let mapReply = Reply(status: 200, headers: json, body: Data(#"{"identifiers":{"f-1":"p1","f-2":"p2","f-3":"p3"}}"#.utf8))

for (label, reply) in [("empty", Reply(status: 404, headers: [:], body: Data())),
                       ("HTML", Reply(status: 404, headers: html, body: proxyHtml)),
                       ("API body", Reply(status: 404, headers: json, body: apiNotFound))] {
  StubRoutes.reset()
  let db = manifest("identifiers-404-\(label.replacingOccurrences(of: " ", with: "-")).db")
  // Right after sign-out + sign-in: emptied, the scan inserted every photo as
  // pending; one kept mark (p4) from the last sign-out.
  insertPending(db, ["p1", "p2", "p3", "p4", "p5"])
  exec(db, "INSERT INTO backup_pending_marks VALUES ('\(acctA)', 'p4', 'f-4', \(now))")

  StubRoutes.set(identifiersPath, reply)
  let applies = Box<Int>()
  let deferred = runGate(db, applies: applies)
  expect(StubRoutes.hitCount(identifiersPath) == 1, "identifiers 404 (\(label)): the stub was asked once")
  expect(deferred == .deferred(.fetchFailed),
         "identifiers 404 (\(label)): the gate defers as a failed fetch, it is NOT ready (got \(String(describing: deferred)))")
  expect((applies.get() ?? 0) == 0, "identifiers 404 (\(label)): no map applied")
  expect(pendingUploads(db) == 5, "identifiers 404 (\(label)): 0 rows promoted, so processBatch queues no upload (got \(pendingUploads(db)) pending)")
  expect(scalar(db, "SELECT COUNT(*) FROM backup_assets WHERE status = 'uploaded'") == 0, "identifiers 404 (\(label)): nothing declared uploaded")
  expect(BackupManifestStore.pendingMarkCount(db, accountId: acctA) == 1, "identifiers 404 (\(label)): the kept mark is untouched")
  if case let .deferred(reason)? = deferred {
    expect(ManifestRebuildGate.backoff(for: reason, consecutiveFailures: 1) == 30,
           "identifiers 404 (\(label)): the same 30 s fetch backoff as any failed fetch")
  }

  // The route answers again: the same gate applies the map and the kept mark.
  StubRoutes.set(identifiersPath, mapReply)
  let ready = runGate(db)
  expect(ready == .ready(rebuilt: true, promoted: 3, keptApplied: 1),
         "identifiers 404 (\(label)) then 200: ready, 3 promoted + 1 kept (got \(String(describing: ready)))")
  expect(pendingUploads(db) == 1, "identifiers 404 (\(label)) then 200: only p5 (never uploaded) left to upload")
  sqlite3_close_v2(db)
}

// MARK: - 4. Mark 404 through the real flush + sign-out reset + re-sign-in

do {
  StubRoutes.reset()
  let db = manifest("mark-404.db")
  // Newest first: m-ok (200), m-gone (404 + the API body), m-proxy (404 HTML).
  insertUnmarked(db, "m-ok", file: "f-ok", order: 3)
  insertUnmarked(db, "m-gone", file: "f-gone", order: 2)
  insertUnmarked(db, "m-proxy", file: "f-proxy", order: 1)
  let markPath = "/api/v1/files/photo-backup/mark"
  StubRoutes.set("\(markPath)?id=m-ok", Reply(status: 200, headers: json, body: Data(#"{"ok":true}"#.utf8)))
  StubRoutes.set("\(markPath)?id=m-gone", Reply(status: 404, headers: json, body: apiNotFound))
  StubRoutes.set("\(markPath)?id=m-proxy", Reply(status: 404, headers: html, body: proxyHtml))

  let flushed = runBounded {
    await SignOutMarkFlush.run(
      deadline: 8, attemptsPerRow: 2, retryDelay: 0.01,
      loadRows: { (BackupManifestStore.pendingServerMarks(db, accountId: acctA, limit: Int(Int32.max)) ?? []) },
      mark: { row, timeout in await markOnServer(db, assetId: row.assetId, fileId: row.fileId, timeout: timeout) }
    )
  }
  expect(flushed?.candidates == 3 && flushed?.marked == 2,
         "sign-out flush: 3 candidates, 2 done (200 + API 404) (got \(String(describing: flushed?.candidates))/\(String(describing: flushed?.marked)))")
  expect(marked(db, "m-ok"), "mark 200: server_marked_at set")
  expect(marked(db, "m-gone"), "mark 404 with the API NotFound body: done, server_marked_at set")
  expect(!marked(db, "m-proxy"), "mark 404 with an HTML body: NO server_marked_at")
  expect(StubRoutes.hitCount("\(markPath)?id=m-proxy") == 2, "the HTML 404 was retried (2 attempts), not taken as done")

  // Sign-out: the reset keeps exactly the association the server does not have.
  expect(BackupManifestStore.resetInPlace(db, nowMs: now), "the sign-out reset commits")
  expect(scalar(db, "SELECT COUNT(*) FROM backup_assets") == 0, "manifest empty after sign-out")
  expect(kept(db, "m-proxy"), "the HTML-404 upload is kept as a pending mark through sign-out")
  expect(!kept(db, "m-gone"), "the API-404 upload (file gone) is not kept")
  expect(!kept(db, "m-ok"), "the marked upload is not kept")

  // Another account uses the device in between: acct-A's kept row stays.
  insertPending(db, ["m-ok", "m-gone", "m-proxy"])
  _ = BackupManifestStore.claim(db, accountId: "acct-B", nowMs: now)
  expect(BackupManifestStore.applyPendingMarks(db, accountId: "acct-B", nowMs: now) == 0, "acct-B promotes nothing of acct-A's")
  expect(kept(db, "m-proxy"), "acct-A's kept mark survives acct-B's sign-in")
  exec(db, "DELETE FROM backup_assets")
  expect(BackupManifestStore.resetInPlace(db, nowMs: now), "acct-B signs out")
  expect(kept(db, "m-proxy"), "and survives acct-B's sign-out")

  // acct-A signs in again: the scan inserts every photo; the server map has m-ok.
  insertPending(db, ["m-ok", "m-gone", "m-proxy"])
  StubRoutes.set(identifiersPath, Reply(status: 200, headers: json, body: Data(#"{"identifiers":{"f-ok":"m-ok"}}"#.utf8)))
  let ready = runGate(db)
  expect(ready == .ready(rebuilt: true, promoted: 1, keptApplied: 1),
         "re-sign-in: the server map promotes m-ok, the kept mark promotes m-proxy (got \(String(describing: ready)))")
  expect(text(db, "SELECT status || ':' || remote_file_id || ':' || uploaded_account_id FROM backup_assets WHERE local_asset_id = 'm-proxy'")
         == "uploaded:f-proxy:acct-A", "m-proxy is uploaded again with its own file, not queued for a second upload")
  expect((BackupManifestStore.pendingServerMarks(db, accountId: acctA, limit: 10) ?? []).map { $0.assetId } == ["m-proxy"],
         "m-proxy is still unmarked: the catch-up sends it to the server")
  expect(!kept(db, "m-proxy"), "the kept row is consumed")
  sqlite3_close_v2(db)
}

// Every other non-API 404 shape: not done, kept through sign-out.
for (label, reply) in foreign404s {
  StubRoutes.reset()
  let slug = label.replacingOccurrences(of: " ", with: "-").replacingOccurrences(of: "/", with: "-")
  let db = manifest("mark-foreign-\(slug).db")
  insertUnmarked(db, "m-1", file: "f-1", order: 1)
  StubRoutes.set("/api/v1/files/photo-backup/mark?id=m-1", reply)
  let flushed = runBounded {
    await SignOutMarkFlush.run(
      deadline: 8, attemptsPerRow: 2, retryDelay: 0.01,
      loadRows: { (BackupManifestStore.pendingServerMarks(db, accountId: acctA, limit: 10) ?? []) },
      mark: { row, timeout in await markOnServer(db, assetId: row.assetId, fileId: row.fileId, timeout: timeout) }
    )
  }
  expect(flushed?.marked == 0, "mark 404, \(label): not done")
  expect(!marked(db, "m-1"), "mark 404, \(label): no server_marked_at")
  _ = BackupManifestStore.resetInPlace(db, nowMs: now)
  expect(kept(db, "m-1"), "mark 404, \(label): kept as a pending mark through sign-out")
  sqlite3_close_v2(db)
}

// MARK: - Report

if failures.isEmpty {
  print("PhotoBackupRouteResponsesTests: \(total) assertions, 0 failed")
  exit(0)
} else {
  for f in failures { print("FAIL: \(f)") }
  print("PhotoBackupRouteResponsesTests: \(failures.count) of \(total) assertions FAILED")
  exit(1)
}
