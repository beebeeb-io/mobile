import Darwin
import Foundation
import ManifestSQLite

// Task 1667 round 3 (Codex P1 "Enforce the eight-second sign-out deadline") —
// standalone swiftc test for the sign-out mark flush. Compiled with the REAL
// shipped sources (modules/beebeeb-crypto/ios/SignOutMarkFlush.swift,
// BackupManifestStore.swift) by scripts/swift-ci/run-swift-tests.sh.
//
// `App.signOut` awaits this flush BEFORE `logout()`, so a flush that outlives
// its deadline keeps the user signed in and delays the key/plaintext purge.
// What it proves:
//   1. A mark endpoint that never responds, behind a URLSession configured
//      like the engine's `metadataSession` (30 s request / 60 s resource),
//      does not hold the flush past the 8 s deadline + 1 s, and the stalled
//      URLSession task is cancelled (the stub's `stopLoading` runs).
//   2. The deadline holds even when the transport ignores cancellation.
//   3. No request is given a timeout longer than the budget left.
//   4. Loading the rows counts against the deadline too.
//   5. Against a real manifest: whatever the flush did not mark ends in
//      `backup_pending_marks` after the sign-out reset; what it marked does not.
//   6. Fast paths: all marked -> no timeout; an account change stops at once.

var failures: [String] = []
var total = 0

func expect(_ condition: Bool, _ label: String) {
  total += 1
  if !condition { failures.append(label) }
}

/// Runs `op` on the cooperative pool and waits at most `watchdog` seconds, so
/// a flush that never returns is a RED here, not a hung test run.
func runBounded<T>(watchdog: TimeInterval, _ op: @escaping () async -> T) -> (value: T?, elapsed: TimeInterval) {
  let sem = DispatchSemaphore(value: 0)
  let box = Box<T>()
  let start = Date()
  Task {
    let v = await op()
    box.set(v)
    sem.signal()
  }
  _ = sem.wait(timeout: .now() + watchdog)
  return (box.get(), Date().timeIntervalSince(start))
}

final class Box<T> {
  private let lock = NSLock()
  private var value: T?
  func set(_ v: T) { lock.lock(); value = v; lock.unlock() }
  func get() -> T? { lock.lock(); defer { lock.unlock() }; return value }
}

final class Counter {
  private let lock = NSLock()
  private var n = 0
  private var values: [TimeInterval] = []
  func bump() { lock.lock(); n += 1; lock.unlock() }
  var count: Int { lock.lock(); defer { lock.unlock() }; return n }
  func record(_ v: TimeInterval) { lock.lock(); values.append(v); lock.unlock() }
  var recorded: [TimeInterval] { lock.lock(); defer { lock.unlock() }; return values }
}

// MARK: - Stub transport (URLProtocol): 200 for ids in `okIds`, else never responds.

final class StubMarkProtocol: URLProtocol {
  static let lock = NSLock()
  static var okIds: Set<String> = []
  static let started = Counter()
  static let stopped = Counter()

  override class func canInit(with request: URLRequest) -> Bool { true }
  override class func canonicalRequest(for request: URLRequest) -> URLRequest { request }

  override func startLoading() {
    Self.started.bump()
    let id = request.url.flatMap { URLComponents(url: $0, resolvingAgainstBaseURL: false) }?
      .queryItems?.first(where: { $0.name == "id" })?.value ?? ""
    Self.lock.lock()
    let ok = Self.okIds.contains(id)
    Self.lock.unlock()
    guard ok else { return } // stalled endpoint: no response, no error, ever
    let response = HTTPURLResponse(url: request.url!, statusCode: 200, httpVersion: "HTTP/1.1", headerFields: nil)!
    client?.urlProtocol(self, didReceive: response, cacheStoragePolicy: .notAllowed)
    client?.urlProtocol(self, didLoad: Data("{}".utf8))
    client?.urlProtocolDidFinishLoading(self)
  }

  override func stopLoading() { Self.stopped.bump() }
}

func setOk(_ ids: Set<String>) {
  StubMarkProtocol.lock.lock()
  StubMarkProtocol.okIds = ids
  StubMarkProtocol.lock.unlock()
}

/// Same timeouts as NativeBackupEngine.setupMetadataSession().
func metadataLikeSession() -> URLSession {
  let config = URLSessionConfiguration.ephemeral
  config.timeoutIntervalForRequest = 30
  config.timeoutIntervalForResource = 60
  config.protocolClasses = [StubMarkProtocol.self]
  return URLSession(configuration: config)
}

/// The engine's `markOnServer` shape: one POST, request timeout = the budget
/// the flush hands it, true on 2xx.
func httpMark(_ session: URLSession, timeouts: Counter, onMarked: @escaping (String) -> Void = { _ in })
  -> (String, TimeInterval) async -> Bool {
  return { id, timeout in
    timeouts.record(timeout)
    var request = URLRequest(url: URL(string: "https://mark.invalid/api/v1/files/photo-backup/mark?id=\(id)")!)
    request.httpMethod = "POST"
    request.timeoutInterval = timeout
    do {
      let (_, response) = try await session.data(for: request)
      guard ((response as? HTTPURLResponse)?.statusCode ?? 0) / 100 == 2 else { return false }
      onMarked(id)
      return true
    } catch {
      return false
    }
  }
}

let deadline = SignOutMarkFlush.defaultDeadline
let margin: TimeInterval = 1.0
expect(deadline == 8, "the sign-out flush deadline is 8 s")

// MARK: - 1. A stalled mark endpoint does not hold sign-out past 8 s

do {
  setOk([])
  let session = metadataLikeSession()
  let timeouts = Counter()
  let stoppedBefore = StubMarkProtocol.stopped.count
  let r = runBounded(watchdog: 20) {
    await SignOutMarkFlush.run(
      loadRows: { ["s1", "s2", "s3"] },
      mark: httpMark(session, timeouts: timeouts)
    )
  }
  print("1. stalled endpoint: returned=\(r.value != nil) elapsed=\(String(format: "%.2f", r.elapsed))s")
  expect(r.value != nil, "1. the flush returns although the mark endpoint never responds")
  expect(r.elapsed <= deadline + margin, "1. the flush returns within 8 s + 1 s (took \(r.elapsed))")
  expect(r.value?.timedOut == true, "1. the outcome reports the timeout")
  expect(r.value?.marked == 0, "1. nothing counted as marked")
  expect(r.value?.candidates == 3, "1. all three rows were candidates")
  // The stalled URLSession task is cancelled, not left running.
  var waited = 0.0
  while StubMarkProtocol.stopped.count == stoppedBefore && waited < 1.0 { usleep(20_000); waited += 0.02 }
  expect(StubMarkProtocol.stopped.count > stoppedBefore, "1. the stalled URLSession task was cancelled (stopLoading ran)")
  session.invalidateAndCancel()
}

// 1b. A transport that ignores the timeout it is handed (uses the session's
// 30 s): only the hard deadline's cancel can stop the stalled task, so this
// isolates it from the per-request timeout that also fires in case 1.
do {
  setOk([])
  let session = metadataLikeSession()
  let timeouts = Counter()
  let stoppedBefore = StubMarkProtocol.stopped.count
  let full = httpMark(session, timeouts: timeouts)
  let r = runBounded(watchdog: 6) {
    await SignOutMarkFlush.run(deadline: 1.0, loadRows: { ["c1"] }, mark: { id, _ in await full(id, 30) })
  }
  var waited = 0.0
  while StubMarkProtocol.stopped.count == stoppedBefore && waited < 1.0 { usleep(20_000); waited += 0.02 }
  print("1b. transport ignores the handed timeout: elapsed=\(String(format: "%.2f", r.elapsed))s stopLoading after +\(String(format: "%.2f", waited))s")
  expect(r.elapsed <= 1.0 + 0.5, "1b. returns within the 1 s deadline + 0.5 s (took \(r.elapsed))")
  expect(StubMarkProtocol.stopped.count > stoppedBefore,
         "1b. the deadline cancels the stalled URLSession task itself (stopLoading within 1 s of returning)")
  session.invalidateAndCancel()
}

// MARK: - 2. The deadline holds when the transport ignores cancellation

final class Parked {
  static let lock = NSLock()
  static var continuations: [CheckedContinuation<Bool, Never>] = []
}

do {
  let calls = Counter()
  let r = runBounded(watchdog: 6) {
    await SignOutMarkFlush.run(
      deadline: 1.0,
      loadRows: { ["n1", "n2"] },
      mark: { _, _ in
        calls.bump()
        // Never resumed, and no cancellation handler: a call that ignores cancel.
        return await withCheckedContinuation { c in
          Parked.lock.lock(); Parked.continuations.append(c); Parked.lock.unlock()
        }
      }
    )
  }
  print("2. non-cooperative transport: returned=\(r.value != nil) elapsed=\(String(format: "%.2f", r.elapsed))s")
  expect(r.value != nil, "2. returns although the mark call ignores cancellation")
  expect(r.elapsed <= 1.0 + 0.5, "2. returns within the 1 s deadline + 0.5 s (took \(r.elapsed))")
  expect(r.value?.timedOut == true, "2. reported as timed out")
  expect(calls.count == 1, "2. no second request starts after the first stalled")
}

// MARK: - 3. No request timeout is longer than the budget left

do {
  setOk([])
  let session = metadataLikeSession()
  let timeouts = Counter()
  let r = runBounded(watchdog: 10) {
    await SignOutMarkFlush.run(deadline: 1.5, loadRows: { ["t1"] }, mark: httpMark(session, timeouts: timeouts))
  }
  let seen = timeouts.recorded
  print("3. request timeouts handed to the transport: \(seen)")
  expect(!seen.isEmpty, "3. the transport was called")
  expect(seen.allSatisfy { $0 > 0 && $0 <= 1.5 }, "3. every request timeout is > 0 and <= the 1.5 s budget (\(seen))")
  expect(r.elapsed <= 1.5 + 0.5, "3. returned within budget (took \(r.elapsed))")
  session.invalidateAndCancel()
}

// MARK: - 4. Loading the rows counts against the deadline

do {
  let r = runBounded(watchdog: 6) {
    await SignOutMarkFlush.run(
      deadline: 1.0,
      loadRows: { () -> [String] in Thread.sleep(forTimeInterval: 3); return ["l1"] },
      mark: { _, _ in true }
    )
  }
  print("4. slow row load: elapsed=\(String(format: "%.2f", r.elapsed))s")
  expect(r.value != nil, "4. returns while the row load is still blocked")
  expect(r.elapsed <= 1.0 + 0.5, "4. a 3 s row load does not stretch the 1 s deadline (took \(r.elapsed))")
  expect(r.value?.timedOut == true, "4. reported as timed out")
}

// MARK: - 5. Unmarked rows end in backup_pending_marks after the reset

let fm = FileManager.default
let root = fm.temporaryDirectory.appendingPathComponent("bb-1667-r3-\(UUID().uuidString)", isDirectory: true)
try! fm.createDirectory(at: root, withIntermediateDirectories: true)
defer { try? fm.removeItem(at: root) }

func open(_ path: String) -> OpaquePointer {
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

do {
  let db = open(root.appendingPathComponent("flush.db").path)
  // The columns resetInPlace / pendingServerMarks / recordServerMarked touch
  // (NativeBackupEngine.ensureTables + BackupManifestStore.migrate).
  exec(db, """
  CREATE TABLE backup_assets (
    local_asset_id TEXT PRIMARY KEY, remote_file_id TEXT, created_at TEXT NOT NULL,
    uploaded_at TEXT, asset_type TEXT NOT NULL, status TEXT NOT NULL, staged_file_id TEXT,
    -- Round 14: the reset's in-flight keep reads these (ensureTables has them).
    staged_account_id TEXT, upload_session_id TEXT
  );
  CREATE TABLE backup_upload_chunks (local_asset_id TEXT NOT NULL, chunk_index INTEGER NOT NULL);
  """)
  BackupManifestStore.migrate(db)
  // Newest first in pendingServerMarks (ORDER BY uploaded_at DESC): a1 is
  // sent first and answered; a2 then stalls; a3 is never reached.
  for (id, at) in [("a1", "2026-10-18T03:00:00Z"), ("a2", "2026-10-18T02:00:00Z"), ("a3", "2026-10-18T01:00:00Z")] {
    exec(db, """
    INSERT INTO backup_assets (local_asset_id, remote_file_id, created_at, uploaded_at, asset_type, status, uploaded_account_id)
    VALUES ('\(id)', 'f-\(id)', '\(at)', '\(at)', 'photo', 'uploaded', 'acct-A')
    """)
  }
  let dbQueue = DispatchQueue(label: "test.dbQueue")
  setOk(["a1"])
  let session = metadataLikeSession()
  let timeouts = Counter()
  let r = runBounded(watchdog: 10) {
    await SignOutMarkFlush.run(
      deadline: 2.0,
      loadRows: { dbQueue.sync { (BackupManifestStore.pendingServerMarks(db, accountId: "acct-A", limit: Int(Int32.max)) ?? []) } },
      mark: { row, timeout in
        await httpMark(session, timeouts: timeouts, onMarked: { _ in
          dbQueue.sync { BackupManifestStore.recordServerMarked(db, assetId: row.assetId, fileId: row.fileId, nowMs: 42) }
        })(row.assetId, timeout)
      }
    )
  }
  print("5. manifest flush: marked=\(r.value?.marked ?? -1) elapsed=\(String(format: "%.2f", r.elapsed))s")
  expect(r.elapsed <= 2.0 + 0.5, "5. the stalled second mark does not hold the flush past 2 s + 0.5 s (took \(r.elapsed))")
  expect(r.value?.marked == 1 && r.value?.candidates == 3, "5. 1 of 3 marked before the endpoint stalled")
  // The sign-out reset (prepareForStoragePurge -> resetInPlace) runs next.
  let resetOK = dbQueue.sync { BackupManifestStore.resetInPlace(db, nowMs: 1_000) }
  expect(resetOK, "5. the reset after a timed-out flush commits")
  expect(scalar(db, "SELECT COUNT(*) FROM backup_pending_marks WHERE account_id = 'acct-A'") == 2,
         "5. the two unmarked uploads are kept in backup_pending_marks")
  expect(scalar(db, "SELECT COUNT(*) FROM backup_pending_marks WHERE local_asset_id IN ('a2','a3') AND remote_file_id IN ('f-a2','f-a3')") == 2,
         "5. kept with their server file ids")
  expect(scalar(db, "SELECT COUNT(*) FROM backup_pending_marks WHERE local_asset_id = 'a1'") == 0,
         "5. the marked upload is not kept (the server has it)")
  expect(scalar(db, "SELECT COUNT(*) FROM backup_assets") == 0, "5. the manifest itself is empty")
  exsqlite3_close_v2(db)
  session.invalidateAndCancel()
}

// MARK: - 6. Fast paths

do {
  setOk(["ok1", "ok2", "ok3"])
  let session = metadataLikeSession()
  let timeouts = Counter()
  let r = runBounded(watchdog: 10) {
    await SignOutMarkFlush.run(loadRows: { ["ok1", "ok2", "ok3"] }, mark: httpMark(session, timeouts: timeouts))
  }
  expect(r.value?.marked == 3 && r.value?.timedOut == false, "6. a responsive endpoint marks all 3, no timeout")
  expect(r.elapsed < 2, "6. and returns promptly (took \(r.elapsed))")
  session.invalidateAndCancel()
}

do {
  let calls = Counter()
  let r = runBounded(watchdog: 10) {
    await SignOutMarkFlush.run(
      loadRows: { ["x1", "x2"] },
      shouldStop: { true },
      mark: { _, _ in calls.bump(); return false }
    )
  }
  expect(calls.count == 1, "6. an account change after a failed mark stops without a retry (calls \(calls.count))")
  expect(r.value?.timedOut == false && r.elapsed < 1, "6. and is not a timeout")
}

do {
  // A failing (not stalled) endpoint with a long retry pause still ends by the deadline.
  let r = runBounded(watchdog: 10) {
    await SignOutMarkFlush.run(deadline: 1.0, retryDelay: 5, loadRows: { ["r1"] }, mark: { _, _ in false })
  }
  expect(r.elapsed <= 1.0 + 0.5, "6. a retry pause never outlasts the deadline (took \(r.elapsed))")
}

// MARK: - Report

if failures.isEmpty {
  print("SignOutMarkFlushTests: \(total) assertions, 0 failed")
  exit(0)
} else {
  for f in failures { print("FAIL: \(f)") }
  print("SignOutMarkFlushTests: \(failures.count) of \(total) assertions FAILED")
  exit(1)
}
