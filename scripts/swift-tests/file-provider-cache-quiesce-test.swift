import Foundation
import SQLite3

// Task LD-0002 round 2 (TestFlight 258, `RUNNINGBOARD 0xdead10cc`): the File
// Provider cache database under the background execution gate, on the REAL
// `FileProviderCacheDB`, `FileProviderCacheSync.apply` and
// `PlaintextStorageProtection.resetSQLiteInPlace` (compiled with
// BackupExecutionGate.swift and linked against the same vanilla SQLite object
// the app gets through the Rust core, see scripts/swift-ci/run-swift-tests.sh).
//
//   c1  a closed gate refuses a connection: `enter()` is nil, nothing opens;
//       the gate opens again on foreground
//   c2  THE CRASH: a long `syncFileProviderCache` write is in its transaction,
//       the background expiry fires; when the quiesce returns no section is in
//       flight, no write transaction is open (no hot journal, a second writer
//       gets the lock at once), and the call answered "not now" with NOTHING
//       written (one transaction: all or none)
//   c3  a gate that closed and reopened since `enter()` stays closed for that
//       section (an aborted statement may be behind it)
//   c4  a write that is never refused while the gate is open is unchanged by
//       the gate: every row lands, the prune pass deletes what it should
//   c5  the sign-out reset (`resetSQLiteInPlace`, one DELETE over many rows
//       then VACUUM) is refused when the gate is closed, is rolled back and
//       leaves no lock when an expiry lands mid-statement, and still resets
//       the file with the gate open
//   c6  a cold launch with no engine built: the lifecycle seed opens (or closes) the
//       gate from the real state, follows foreground, and quiesces a write on
//       didEnterBackground; with the engine built it leaves the sequence to it
//   c7  the typed answer the JS bridge receives
//   c9  the extension (a second connection) holds the write lock, the expiry
//       fires while the app's connection sits in the busy wait: the quiesce
//       returns at once, and when the extension lets go afterwards NOTHING of the
//       app's takes the lock (a plain busy timeout would still be waiting)
//   c10 a BEGIN that fails stops the write before any upsert
//   c11 a reset the gate refused is owed, survives in its store, is paid on the
//       next opening before anything else writes, and is not forgotten when the
//       payment fails
//   c12 the gate's open state and closure count are read in one step
//   c13 the quiesce's three waits run under ONE deadline (their sum is never waited)
//   c14 the debt is also counted when the app-group defaults are unavailable
//   c8  a gate that closes BETWEEN the reset's statements (an interrupt is a
//       no-op there): at every checkpoint the reset is all or nothing

var failures: [String] = []
var total = 0

func expect(_ condition: Bool, _ label: String) {
  total += 1
  if !condition { failures.append(label) }
}

let fm = FileManager.default
let root = fm.temporaryDirectory.appendingPathComponent("bb-ld0002-fpcache-\(UUID().uuidString)", isDirectory: true)
try! fm.createDirectory(at: root, withIntermediateDirectories: true)
defer { try? fm.removeItem(at: root) }

func freshDatabase(_ name: String) -> URL {
  let dir = root.appendingPathComponent(name, isDirectory: true)
  try! fm.createDirectory(at: dir, withIntermediateDirectories: true)
  return dir.appendingPathComponent("file-provider-cache.sqlite")
}

let schema = [
  """
  CREATE TABLE IF NOT EXISTS file_cache (
    id TEXT PRIMARY KEY, parent_id TEXT, name_encrypted TEXT, name_decrypted TEXT,
    display_name TEXT, display_name_source_name TEXT, display_name_source_parent TEXT,
    mime_type TEXT, size_bytes INTEGER NOT NULL DEFAULT 0, is_folder INTEGER NOT NULL DEFAULT 0,
    is_pinned INTEGER NOT NULL DEFAULT 0, has_thumbnail INTEGER NOT NULL DEFAULT 0,
    thumbnail_data BLOB, thumbnail_nonce BLOB, created_at TEXT, updated_at TEXT,
    sync_anchor INTEGER NOT NULL DEFAULT 0, is_materialized INTEGER NOT NULL DEFAULT 0
  );
  """,
  "CREATE INDEX IF NOT EXISTS idx_file_cache_parent ON file_cache(parent_id);",
  "CREATE TABLE IF NOT EXISTS sync_state (key TEXT PRIMARY KEY, value TEXT);",
]

func exec(_ db: OpaquePointer, _ sql: String) {
  var err: UnsafeMutablePointer<CChar>?
  if sqlite3_exec(db, sql, nil, nil, &err) != SQLITE_OK {
    let msg = err.map { String(cString: $0) } ?? "?"
    sqlite3_free(err)
    fatalError("SQL failed: \(msg)\n\(sql)")
  }
}

/// The test's OWN connection (never the cache's).
func withConnection<T>(_ url: URL, busyMs: Int32 = 0, _ body: (OpaquePointer) -> T) -> T {
  var db: OpaquePointer?
  precondition(sqlite3_open_v2(url.path, &db, SQLITE_OPEN_READWRITE | SQLITE_OPEN_CREATE | SQLITE_OPEN_FULLMUTEX, nil) == SQLITE_OK)
  sqlite3_busy_timeout(db, busyMs)
  defer { sqlite3_close(db) }
  return body(db!)
}

func createSchema(_ url: URL) {
  withConnection(url) { db in for sql in schema { exec(db, sql) } }
}

/// -1 when the database is locked (a write transaction is open elsewhere).
func rowCount(_ url: URL) -> Int {
  withConnection(url) { db in
    var stmt: OpaquePointer?
    guard sqlite3_prepare_v2(db, "SELECT count(*) FROM file_cache", -1, &stmt, nil) == SQLITE_OK else { return -1 }
    defer { sqlite3_finalize(stmt) }
    guard sqlite3_step(stmt) == SQLITE_ROW else { return -1 }
    return Int(sqlite3_column_int64(stmt, 0))
  }
}

/// True when a second writer gets the database's write lock at once (busy
/// timeout 0): no write transaction is open on any other connection.
func writeLockIsFree(_ url: URL) -> Bool {
  withConnection(url, busyMs: 0) { db in
    guard sqlite3_exec(db, "BEGIN IMMEDIATE", nil, nil, nil) == SQLITE_OK else { return false }
    sqlite3_exec(db, "ROLLBACK", nil, nil, nil)
    return true
  }
}

func journalExists(_ url: URL) -> Bool {
  fm.fileExists(atPath: url.path + "-journal")
}

func makeEntries(_ n: Int, parents: Int = 50) -> [[String: Any]] {
  (0..<n).map { i in
    [
      "id": "file-\(i)", "parent_id": "parent-\(i % parents)",
      "name_encrypted": "ciphertext-\(i)", "name_decrypted": "decrypted name \(i).txt",
      "mime_type": "text/plain", "size_bytes": i, "is_folder": false,
      "created_at": "2026-11-07T00:00:00Z", "updated_at": "2026-11-07T00:00:00Z",
    ]
  }
}

/// What `syncFileProviderCache` does with its connection: enter the gate, open,
/// attach, prepare, run the transaction, finish. The module's closure is pinned
/// to this shape by src/lib/file-provider-cache-gate-wiring.test.ts.
func runSync(
  _ cache: FileProviderCacheDB, _ url: URL, entries: [[String: Any]],
  prune: Bool = false, pruneParents: [Any]? = nil
) -> FileProviderCacheOutcome<FileProviderCacheSyncResult> {
  guard let section = cache.enter() else { return .notNow }
  var db: OpaquePointer?
  guard sqlite3_open_v2(url.path, &db, SQLITE_OPEN_READWRITE | SQLITE_OPEN_CREATE | SQLITE_OPEN_FULLMUTEX, nil) == SQLITE_OK, let db else {
    section.finish(closing: db)
    return .notNow
  }
  defer { section.finish(closing: db) }
  section.attach(db)
  section.setBusyTimeout(db, milliseconds: 2000)
  sqlite3_exec(db, "PRAGMA secure_delete = ON", nil, nil, nil)
  for sql in schema { sqlite3_exec(db, sql, nil, nil, nil) }
  return FileProviderCacheSync.apply(db: db, section: section, entries: entries, prune: prune, pruneParents: pruneParents)
}

func waitUntil(_ timeout: TimeInterval, _ condition: () -> Bool) -> Bool {
  let deadline = Date().addingTimeInterval(timeout)
  while Date() < deadline {
    if condition() { return true }
    usleep(2_000)
  }
  return condition()
}

func backgroundGate() -> BackupExecutionGate {
  // The app is in the background with its grace task live: the gate is open
  // until the grace task's expiry closes it.
  let gate = BackupExecutionGate(foreground: false)
  _ = gate.beginAssertion(.backgroundGrace)
  return gate
}

// ── c1 ───────────────────────────────────────────────────────────────────
do {
  let url = freshDatabase("c1")
  createSchema(url)
  let gate = BackupExecutionGate(foreground: false) // background, no assertion: closed
  let cache = FileProviderCacheDB(gate: gate)

  expect(cache.enter() == nil, "c1: a closed gate refuses a connection (enter() is nil)")
  let refused = runSync(cache, url, entries: makeEntries(10))
  if case .notNow = refused { expect(true, "c1: a sync with the gate closed answers not-now") }
  else { expect(false, "c1: a sync with the gate closed answers not-now") }
  expect(rowCount(url) == 0, "c1: and writes nothing")
  expect(cache.sectionsInFlight == 0, "c1: and opens no connection")

  gate.setForeground(true)
  let reopened = runSync(cache, url, entries: makeEntries(10))
  if case .done(let result) = reopened { expect(result.count == 10, "c1: foreground opens the gate again: all 10 rows written") }
  else { expect(false, "c1: foreground opens the gate again: all 10 rows written") }
  expect(rowCount(url) == 10, "c1: and they are on disk")
}

// ── c2 ───────────────────────────────────────────────────────────────────
do {
  let url = freshDatabase("c2")
  createSchema(url)
  let gate = backgroundGate()
  let cache = FileProviderCacheDB(gate: gate)

  let finished = DispatchSemaphore(value: 0)
  var outcome: FileProviderCacheOutcome<FileProviderCacheSyncResult>?
  Thread.detachNewThread {
    // A 40k-vault-sized push: one transaction of hundreds of thousands of
    // upserts, far longer than the expiry's two seconds.
    outcome = runSync(cache, url, entries: makeEntries(400_000, parents: 200), prune: true, pruneParents: ["parent-0"])
    finished.signal()
  }

  let inTransaction = waitUntil(10) { cache.sectionsInFlight == 1 && journalExists(url) }
  expect(inTransaction, "c2: precondition: the write is in its transaction (a hot journal exists)")
  expect(!writeLockIsFree(url), "c2: precondition: the write lock is held while the sync runs")

  let started = Date()
  let quiesced = BackupSQLiteQuiesce.run(
    gate: gate,
    interrupt: { cache.interruptInFlightStatements() },
    waitForQuiet: { cache.waitForQuiet(timeout: $0) }
  )
  let elapsed = Date().timeIntervalSince(started)

  expect(quiesced == .quiet, "c2: the quiesce returns quiet, not timed out (got \(quiesced.rawValue))")
  expect(elapsed < 0.75, "c2: well inside the 2 s bound (\(String(format: "%.2f", elapsed)) s)")
  expect(cache.sectionsInFlight == 0, "c2: no connection is in flight when the handler returns")
  expect(!journalExists(url), "c2: no hot journal: no write transaction is open")
  expect(writeLockIsFree(url), "c2: a second writer gets the write lock at once")
  expect(rowCount(url) == 0, "c2: nothing was written (the transaction rolled back)")

  _ = finished.wait(timeout: .now() + 10)
  if case .notNow? = outcome { expect(true, "c2: the call answered not-now") } else { expect(false, "c2: the call answered not-now") }

  // After the quiesce the gate refuses everything until foreground.
  expect(cache.enter() == nil, "c2: a call arriving after the expiry is refused")
  gate.setForeground(true)
  let retried = runSync(cache, url, entries: makeEntries(100))
  if case .done(let r) = retried { expect(r.count == 100, "c2: the retry on foreground writes all rows") }
  else { expect(false, "c2: the retry on foreground writes all rows") }
}

// ── c3 ───────────────────────────────────────────────────────────────────
do {
  let gate = backgroundGate()
  let cache = FileProviderCacheDB(gate: gate)
  let section = cache.enter()!
  expect(section.admits, "c3: a fresh section is admitted")
  gate.expire()
  gate.setForeground(true) // an app switch: the gate is open again
  expect(gate.canStartSQLiteWork, "c3: precondition: the gate itself is open again")
  expect(!section.admits, "c3: the section that entered before the closure stays refused")
  section.finish(closing: nil)
  expect(cache.sectionsInFlight == 0, "c3: and leaves cleanly")
  expect(cache.enter() != nil, "c3: a new section is admitted")
}

// ── c4 ───────────────────────────────────────────────────────────────────
do {
  let url = freshDatabase("c4")
  createSchema(url)
  let gate = BackupExecutionGate(foreground: true)
  let cache = FileProviderCacheDB(gate: gate)

  _ = runSync(cache, url, entries: makeEntries(300, parents: 3))
  expect(rowCount(url) == 300, "c4: 300 rows written with the gate open")
  // Complete listing of parent-0 with only 10 children: the other 90 go.
  let keep = makeEntries(300, parents: 3).filter { ($0["parent_id"] as? String) == "parent-0" }.prefix(10)
  let pruned = runSync(cache, url, entries: Array(keep), prune: true)
  if case .done(let r) = pruned {
    expect(r.count == 10 && r.didPrune && r.touchedParentIdentifiers == ["parent-0"] && !r.touchesRoot,
           "c4: prune result: 10 upserted, prune ran, only parent-0 touched")
  } else { expect(false, "c4: prune result") }
  expect(rowCount(url) == 210, "c4: 90 stale rows under parent-0 pruned, the 200 sibling rows untouched (got \(rowCount(url)))")
  expect(cache.sectionsInFlight == 0, "c4: no connection left behind")
}

// ── c5 ───────────────────────────────────────────────────────────────────
do {
  // Closed gate: refused, rows untouched.
  let url = freshDatabase("c5-closed")
  createSchema(url)
  withConnection(url) { db in
    exec(db, "BEGIN")
    for i in 0..<1_000 { exec(db, "INSERT INTO file_cache(id, parent_id, name_decrypted) VALUES('f\(i)', 'p', 'n\(i)')") }
    exec(db, "COMMIT")
  }
  let closed = BackupExecutionGate(foreground: false)
  let closedCache = FileProviderCacheDB(gate: closed)
  let refused = PlaintextStorageProtection.resetSQLiteInPlace(url, scope: closedCache)
  expect(!refused.ok && !refused.bumpCommitted, "c5: a reset with the gate closed is refused (fails closed)")
  expect(rowCount(url) == 1_000, "c5: and touches no row")
  expect(closedCache.sectionsInFlight == 0, "c5: and leaves no connection")

  // Expiry mid-statement: ONE DELETE over a large table (secure_delete zeroes
  // every page), then VACUUM. No statement boundary for a loop check to use;
  // the interrupt (and the progress handler) has to stop it.
  let big = freshDatabase("c5-big")
  createSchema(big)
  withConnection(big) { db in
    // A trigger makes `DELETE FROM file_cache` row-by-row work (no truncate
    // shortcut): one statement that runs for seconds.
    exec(db, "CREATE TABLE deleted_log (id TEXT, name TEXT)")
    exec(db, "CREATE TRIGGER log_delete AFTER DELETE ON file_cache BEGIN INSERT INTO deleted_log VALUES (old.id, old.name_decrypted); END")
    exec(db, "BEGIN")
    exec(db, """
    WITH RECURSIVE n(i) AS (SELECT 1 UNION ALL SELECT i + 1 FROM n WHERE i < 1000000)
    INSERT INTO file_cache(id, parent_id, name_decrypted, mime_type)
    SELECT 'f' || i, 'p' || (i % 100), 'decrypted name number ' || i || ' padding padding padding padding', 'text/plain' FROM n
    """)
    exec(db, "COMMIT")
  }
  let gate = backgroundGate()
  let cache = FileProviderCacheDB(gate: gate)
  let done = DispatchSemaphore(value: 0)
  var result: (ok: Bool, bumpCommitted: Bool)?
  Thread.detachNewThread {
    result = PlaintextStorageProtection.resetSQLiteInPlace(big, scope: cache)
    done.signal()
  }
  let inReset = waitUntil(10) { cache.sectionsInFlight == 1 && journalExists(big) }
  expect(inReset, "c5: precondition: the reset is in its transaction (a hot journal exists)")
  let started = Date()
  let quiesced = BackupSQLiteQuiesce.run(
    gate: gate,
    interrupt: { cache.interruptInFlightStatements() },
    waitForQuiet: { cache.waitForQuiet(timeout: $0) }
  )
  let elapsed = Date().timeIntervalSince(started)
  expect(quiesced == .quiet, "c5: the quiesce returns quiet, not timed out (got \(quiesced.rawValue))")
  expect(elapsed < 0.75, "c5: well inside the 2 s bound (\(String(format: "%.2f", elapsed)) s)")
  expect(cache.sectionsInFlight == 0, "c5: no connection is in flight when the handler returns")
  expect(!journalExists(big), "c5: no hot journal: no write transaction is open")
  expect(writeLockIsFree(big), "c5: a second writer gets the write lock at once")
  _ = done.wait(timeout: .now() + 10)
  expect(result?.ok == false && result?.bumpCommitted == false, "c5: the reset reports a failure, no bump committed")
  expect(rowCount(big) == 1_000_000, "c5: the rollback left every row (the reset is all or nothing)")
  expect(cache.resetOwed, "c5: a reset the gate stopped AFTER admitting it is owed too (the old rows are still there)")

  // Gate open (foreground): the same file resets.
  gate.setForeground(true)
  let reset = PlaintextStorageProtection.resetSQLiteInPlace(big, scope: cache)
  expect(reset.ok && reset.bumpCommitted, "c5: with the gate open the reset succeeds")
  expect(rowCount(big) == 0, "c5: and empties the table")
}

// ── c8 ───────────────────────────────────────────────────────────────────
// A gate that closes BETWEEN two statements of the reset (an interrupt is a
// no-op there). Sweep the closure over every checkpoint the reset asks: at no
// point may it commit a half-reset, or report a success it did not make.
final class FlippingScope: SQLiteResetScope, SQLiteResetSection {
  var asked = 0
  let admitsFirst: Int
  init(admitsFirst: Int) { self.admitsFirst = admitsFirst }
  func begin() -> SQLiteResetSection? { self }
  var admits: Bool { asked += 1; return asked <= admitsFirst }
  func attach(_ db: OpaquePointer) {}
  func setBusyTimeout(_ db: OpaquePointer, milliseconds: Int32) { sqlite3_busy_timeout(db, milliseconds) }
  func finish(closing db: OpaquePointer?) { if let db { sqlite3_close(db) } }
}

func seedForSweep(_ url: URL) {
  createSchema(url)
  withConnection(url) { db in
    exec(db, "CREATE TABLE extra (v TEXT)")
    exec(db, "INSERT INTO file_cache(id, parent_id, name_decrypted) VALUES('a','p','x'), ('b','p','y'), ('c','p','z')")
    exec(db, "INSERT INTO extra VALUES ('1'), ('2')")
    exec(db, "PRAGMA user_version = 5")
  }
}

func scalar(_ url: URL, _ sql: String) -> Int {
  withConnection(url) { db -> Int in
    var stmt: OpaquePointer?
    guard sqlite3_prepare_v2(db, sql, -1, &stmt, nil) == SQLITE_OK else { return -1 }
    defer { sqlite3_finalize(stmt) }
    guard sqlite3_step(stmt) == SQLITE_ROW else { return -1 }
    return Int(sqlite3_column_int64(stmt, 0))
  }
}

do {
  // How many times does a full reset ask the gate? Once after the open, once
  // after the table listing, then after each statement: secure_delete, BEGIN,
  // each of the 3 DELETEs, the user_version bump (that one is the COMMIT's
  // check), and once more before VACUUM = 9.
  let probeURL = freshDatabase("c8-probe")
  seedForSweep(probeURL)
  let probe = FlippingScope(admitsFirst: 1_000)
  let full = PlaintextStorageProtection.resetSQLiteInPlace(probeURL, scope: probe)
  expect(full.ok && full.bumpCommitted, "c8: precondition: with the gate open throughout, the reset completes")
  expect(probe.asked == 9, "c8: a full reset asks the gate at 9 checkpoints (asked \(probe.asked))")
  let commitCheckpoint = probe.asked - 1 // the check after the user_version bump gates the COMMIT; VACUUM's is the last

  var wrongOutcomes: [String] = []
  var locked: [Int] = []
  for k in 0...probe.asked {
    let url = freshDatabase("c8-\(k)")
    seedForSweep(url)
    let result = PlaintextStorageProtection.resetSQLiteInPlace(url, scope: FlippingScope(admitsFirst: k))
    let rows = rowCount(url)
    let extraRows = scalar(url, "SELECT count(*) FROM extra")
    let version = scalar(url, "PRAGMA user_version")
    if !writeLockIsFree(url) { locked.append(k) }
    if k < commitCheckpoint {
      // closed before the COMMIT was allowed: nothing committed, nothing changed
      if result.ok || result.bumpCommitted || rows != 3 || extraRows != 2 || version != 5 {
        wrongOutcomes.append("k=\(k): closed before COMMIT but ok=\(result.ok) bump=\(result.bumpCommitted) rows=\(rows) extra=\(extraRows) v=\(version)")
      }
    } else {
      // the COMMIT was allowed: both tables empty and the epoch bumped; ok only if VACUUM was too
      if !result.bumpCommitted || rows != 0 || extraRows != 0 || version != 6 || (result.ok != (k > commitCheckpoint)) {
        wrongOutcomes.append("k=\(k): committed state wrong: ok=\(result.ok) bump=\(result.bumpCommitted) rows=\(rows) extra=\(extraRows) v=\(version)")
      }
    }
  }
  expect(wrongOutcomes.isEmpty, "c8: at every checkpoint the reset is all or nothing and reports what it did: \(wrongOutcomes)")
  expect(locked.isEmpty, "c8: no write transaction is left open at any checkpoint (locked at k=\(locked))")
}

// ── c9 ───────────────────────────────────────────────────────────────────
do {
  let url = freshDatabase("c9")
  createSchema(url)
  let gate = backgroundGate()
  let cache = FileProviderCacheDB(gate: gate)
  var ext: OpaquePointer?
  precondition(sqlite3_open_v2(url.path, &ext, SQLITE_OPEN_READWRITE | SQLITE_OPEN_FULLMUTEX, nil) == SQLITE_OK)
  exec(ext!, "BEGIN IMMEDIATE") // the extension's write lock

  let finished = DispatchSemaphore(value: 0)
  var outcome: FileProviderCacheOutcome<FileProviderCacheSyncResult>?
  Thread.detachNewThread {
    outcome = runSync(cache, url, entries: makeEntries(50))
    finished.signal()
  }
  expect(waitUntil(5) { cache.sectionsInFlight == 1 }, "c9: precondition: the app's connection is in flight")
  usleep(200_000) // inside the busy wait for the extension's lock

  let started = Date()
  let quiesced = BackupSQLiteQuiesce.run(
    gate: gate,
    interrupt: { cache.interruptInFlightStatements() },
    waitForQuiet: { cache.waitForQuiet(timeout: $0) }
  )
  let elapsed = Date().timeIntervalSince(started)
  expect(quiesced == .quiet, "c9: the quiesce returns quiet while the connection waits on the extension's lock (got \(quiesced.rawValue))")
  expect(elapsed < 0.75, "c9: and at once, not when the busy timeout runs out (\(String(format: "%.2f", elapsed)) s)")
  expect(cache.sectionsInFlight == 0, "c9: no connection is in flight when the handler returns")

  // The extension lets go AFTER the quiesce returned and the app is about to be suspended.
  exec(ext!, "ROLLBACK")
  sqlite3_close(ext)
  usleep(300_000)
  expect(!journalExists(url), "c9: the app's connection did not take the lock afterwards (no hot journal)")
  expect(writeLockIsFree(url), "c9: no cache connection can take RESERVED once the extension lets go")
  expect(rowCount(url) == 0, "c9: nothing was written")
  _ = finished.wait(timeout: .now() + 5)
  if case .notNow? = outcome { expect(true, "c9: the call answered not-now") } else { expect(false, "c9: the call answered not-now") }

  // The sign-out reset waits the same way.
  let resetURL = freshDatabase("c9-reset")
  createSchema(resetURL)
  let resetGate = backgroundGate()
  let resetCache = FileProviderCacheDB(gate: resetGate)
  var ext2: OpaquePointer?
  precondition(sqlite3_open_v2(resetURL.path, &ext2, SQLITE_OPEN_READWRITE | SQLITE_OPEN_FULLMUTEX, nil) == SQLITE_OK)
  exec(ext2!, "BEGIN IMMEDIATE")
  let resetDone = DispatchSemaphore(value: 0)
  Thread.detachNewThread {
    _ = PlaintextStorageProtection.resetSQLiteInPlace(resetURL, scope: resetCache)
    resetDone.signal()
  }
  expect(waitUntil(5) { resetCache.sectionsInFlight == 1 }, "c9: precondition: the reset is in flight")
  usleep(200_000)
  let resetStarted = Date()
  let resetQuiesced = BackupSQLiteQuiesce.run(
    gate: resetGate,
    interrupt: { resetCache.interruptInFlightStatements() },
    waitForQuiet: { resetCache.waitForQuiet(timeout: $0) }
  )
  expect(resetQuiesced == .quiet && Date().timeIntervalSince(resetStarted) < 0.75, "c9: a reset waiting on the extension's lock stops at once too")
  exec(ext2!, "ROLLBACK")
  sqlite3_close(ext2)
  _ = resetDone.wait(timeout: .now() + 5)
}

// ── c10 ──────────────────────────────────────────────────────────────────
do {
  let url = freshDatabase("c10")
  createSchema(url)
  let gate = BackupExecutionGate(foreground: true)
  let cache = FileProviderCacheDB(gate: gate)
  let section = cache.enter()!
  var db: OpaquePointer?
  precondition(sqlite3_open_v2(url.path, &db, SQLITE_OPEN_READWRITE | SQLITE_OPEN_FULLMUTEX, nil) == SQLITE_OK)
  section.attach(db!)
  exec(db!, "BEGIN") // already inside a transaction: the BEGIN inside apply fails
  let outcome = FileProviderCacheSync.apply(db: db!, section: section, entries: makeEntries(5), prune: false, pruneParents: nil)
  if case .notNow = outcome { expect(true, "c10: a failed BEGIN answers not-now") } else { expect(false, "c10: a failed BEGIN answers not-now") }
  sqlite3_exec(db, "ROLLBACK", nil, nil, nil)
  section.finish(closing: db)
  expect(rowCount(url) == 0, "c10: and no upsert ran")
}

// ── c11 ──────────────────────────────────────────────────────────────────
do {
  let url = freshDatabase("c11")
  createSchema(url)
  withConnection(url) { db in
    exec(db, "INSERT INTO file_cache(id, parent_id, name_decrypted) VALUES('a','p','old account name'), ('b','p','another')")
  }
  var stored = false
  let store = (get: { stored }, set: { (value: Bool) in stored = value })
  let gate = BackupExecutionGate(foreground: false) // a sign-out in the background
  let cache = FileProviderCacheDB(gate: gate, owedStore: store)
  expect(!cache.resetOwed, "c11: nothing owed at first")

  let refused = PlaintextStorageProtection.resetSQLiteInPlace(url, scope: cache)
  expect(!refused.ok, "c11: precondition: the gate refused the sign-out reset")
  expect(cache.resetOwed && stored, "c11: a refused reset is owed, and the debt is persisted")
  expect(rowCount(url) == 2, "c11: precondition: the old account's rows are still on disk")

  var attempts = 0
  let stillClosed = cache.settleOwedReset { attempts += 1; return PlaintextStorageProtection.resetSQLiteInPlace(url, scope: cache).ok }
  expect(!stillClosed && cache.resetOwed && rowCount(url) == 2, "c11: a payment the closed gate refuses again leaves the debt (it is not forgotten)")

  gate.setForeground(true)
  let paid = cache.settleOwedReset { attempts += 1; return PlaintextStorageProtection.resetSQLiteInPlace(url, scope: cache).ok }
  expect(paid && !cache.resetOwed && !stored, "c11: on the next opening the reset runs and the debt is cleared")
  expect(rowCount(url) == 0, "c11: the old account's rows are gone")

  let before = attempts
  expect(cache.settleOwedReset { attempts += 1; return true } && attempts == before, "c11: nothing owed: the reset is not run again")

  stored = true // another launch
  let afterRestart = FileProviderCacheDB(gate: gate, owedStore: store)
  expect(afterRestart.resetOwed, "c11: the debt survives a relaunch (read from the store)")
}

// ── c12 ──────────────────────────────────────────────────────────────────
do {
  let gate = BackupExecutionGate(foreground: true)
  var state = gate.openState()
  expect(state.open && state.closures == 0, "c12: open, never closed")
  gate.expire() // a foreground gate: not closed
  state = gate.openState()
  gate.setForeground(false)
  state = gate.openState()
  expect(!state.open && state.closures == 1, "c12: closed once, read together")
  gate.setForeground(true)
  state = gate.openState()
  expect(state.open && state.closures == 1, "c12: reopened, the closure still counted")

  // A closure that lands while a section enters must never be forgotten once the gate reopens.
  // Best effort: the window between two separate reads is nanoseconds wide; a mutant that reads the
  // state in two steps (m15) was NOT caught in 60000 iterations. The one-step read is pinned by the
  // API checks above and by swift-app-group-sqlite-audit.test.ts, not by this race.
  var forgotten = 0
  for _ in 0..<4000 {
    let g = BackupExecutionGate(foreground: true)
    let c = FileProviderCacheDB(gate: g)
    let go = DispatchSemaphore(value: 0)
    let done = DispatchSemaphore(value: 0)
    Thread.detachNewThread { go.wait(); g.setForeground(false); done.signal() }
    go.signal()
    let section = c.enter()
    done.wait()
    g.setForeground(true)
    if let section, section.admits { forgotten += 1 }
    section?.finish(closing: nil)
  }
  expect(forgotten == 0, "c12: a section that entered before a closure is refused after the reopen (forgotten \(forgotten) of 4000)")
}

// ── c13 ──────────────────────────────────────────────────────────────────
do {
  var timeoutsSeen: [TimeInterval] = []
  let seenLock = NSLock()
  func slow(_ t: TimeInterval) -> Bool {
    seenLock.lock(); timeoutsSeen.append(t); seenLock.unlock()
    usleep(UInt32(min(t, 3.0) * 1_000_000)) // never quiet within its bound
    return false
  }
  let started = Date()
  let allQuiet = BackupSQLiteQuiesce.waitForAll(timeout: 0.5, [slow, slow, slow])
  let elapsed = Date().timeIntervalSince(started)
  expect(!allQuiet, "c13: three waits that time out report not quiet")
  expect(elapsed < 0.9, "c13: and take ONE deadline in total, not three (\(String(format: "%.2f", elapsed)) s for 3 x 0.5 s)")
  expect(timeoutsSeen.count == 3 && timeoutsSeen.allSatisfy { $0 == 0.5 }, "c13: each wait is given the full bound at once")

  let quickStarted = Date()
  let quick = BackupSQLiteQuiesce.waitForAll(timeout: 2.0, [{ _ in true }, { _ in true }, { _ in true }])
  expect(quick && Date().timeIntervalSince(quickStarted) < 0.5, "c13: waits that are quiet return at once")
  expect(!BackupSQLiteQuiesce.waitForAll(timeout: 0.5, [{ _ in true }, { _ in false }]), "c13: one wait that is not quiet makes the result not quiet")
}

// ── c14 ──────────────────────────────────────────────────────────────────
do {
  let gate = BackupExecutionGate(foreground: true)
  var calls = 0
  // the app-group defaults are unavailable: the store reads false whatever is set
  let cache = FileProviderCacheDB(gate: gate, owedStore: (get: { calls += 1; return false }, set: { _ in }))
  cache.markResetOwed()
  expect(cache.resetOwed, "c14: with an unusable store the in-memory debt still counts")
}

// ── c6 ───────────────────────────────────────────────────────────────────
// A cold launch with NO engine built anywhere in this process (this driver never builds one).
do {
  func lifecycle(_ gate: BackupExecutionGate, _ center: NotificationCenter, cache: FileProviderCacheDB, engineBuilt: Bool = false, pay: @escaping () -> Void = {}) -> BackupGateLifecycle {
    BackupGateLifecycle(
      gate: gate, center: center, engineIsBuilt: { engineBuilt },
      interrupt: { cache.interruptInFlightStatements() },
      waitForQuiet: { cache.waitForQuiet(timeout: $0) },
      payOwedReset: pay
    )
  }

  // a cold launch in the foreground: the gate is seeded, the cache opens, nobody built an engine
  let foregroundGate = BackupExecutionGate(foreground: true)
  let foregroundCache = FileProviderCacheDB(gate: foregroundGate)
  lifecycle(foregroundGate, NotificationCenter(), cache: foregroundCache).start(isBackground: false)
  let first = foregroundCache.enter()
  expect(first != nil, "c6: a cold launch in the foreground, with no engine built, gets the cache open")
  first?.finish(closing: nil)

  // a cold launch in the BACKGROUND (a BGProcessingTask, a background URLSession wake): closed from the first call
  let backgroundGate = BackupExecutionGate(foreground: true) // the gate's own initial value
  let backgroundCache = FileProviderCacheDB(gate: backgroundGate)
  lifecycle(backgroundGate, NotificationCenter(), cache: backgroundCache).start(isBackground: true)
  expect(backgroundCache.enter() == nil, "c6: a cold launch in the background starts with the cache closed (the seed, not the gate's default)")

  // the app then comes to the foreground
  let center = NotificationCenter()
  let followed = BackupExecutionGate(foreground: true)
  let followedCache = FileProviderCacheDB(gate: followed)
  let observer = lifecycle(followed, center, cache: followedCache)
  observer.start(isBackground: true)
  center.post(name: BackupGateLifecycle.willEnterForeground, object: nil)
  expect(followedCache.enter() != nil, "c6: willEnterForeground opens it")
  observer.start(isBackground: false) // idempotent: a second start only re-seeds

  // a scene-based app activates through its scene: those notifications reopen the gate too
  let sceneCenter = NotificationCenter()
  let sceneGate = BackupExecutionGate(foreground: true)
  let sceneCache = FileProviderCacheDB(gate: sceneGate)
  var paid = 0
  let sceneObserver = lifecycle(sceneGate, sceneCenter, cache: sceneCache, pay: { paid += 1 })
  sceneObserver.start(isBackground: true) // seeded closed (a scene app can report .background at launch)
  expect(sceneCache.enter() == nil && paid == 0, "c6: seeded closed; a background start pays nothing yet")
  sceneCenter.post(name: BackupGateLifecycle.sceneDidActivate, object: nil)
  expect(sceneCache.enter() != nil, "c6: the scene activating reopens the gate (a cold user launch in a scene-based app)")
  sceneGate.expire(); sceneGate.setForeground(false)
  sceneCenter.post(name: BackupGateLifecycle.sceneWillEnterForeground, object: nil)
  expect(sceneCache.enter() != nil, "c6: so does the scene entering the foreground")
  sceneCenter.post(name: BackupGateLifecycle.willEnterForeground, object: nil)
  sceneCenter.post(name: BackupGateLifecycle.didBecomeActive, object: nil)
  expect(paid == 4, "c6: every foreground pays an owed reset, with no engine and no cache writer (paid \(paid) of 4)")
  let paidAtStart = paid
  sceneObserver.start(isBackground: false)
  expect(paid == paidAtStart + 1, "c6: and so does a start in the foreground (a debt left by a previous launch)")

  // didEnterBackground with no engine built: closes the gate and quiesces a write that is in flight
  let url = freshDatabase("c6-bg")
  createSchema(url)
  let gate = BackupExecutionGate(foreground: true)
  let cache = FileProviderCacheDB(gate: gate)
  let notifications = NotificationCenter()
  let noEngine = lifecycle(gate, notifications, cache: cache)
  noEngine.start(isBackground: false)
  let finished = DispatchSemaphore(value: 0)
  var outcome: FileProviderCacheOutcome<FileProviderCacheSyncResult>?
  Thread.detachNewThread {
    outcome = runSync(cache, url, entries: makeEntries(400_000, parents: 200), prune: true, pruneParents: ["parent-0"])
    finished.signal()
  }
  expect(waitUntil(10) { cache.sectionsInFlight == 1 && journalExists(url) }, "c6: precondition: the write is in its transaction")
  let started = Date()
  notifications.post(name: BackupGateLifecycle.didEnterBackground, object: nil) // runs the handler on this thread
  let elapsed = Date().timeIntervalSince(started)
  expect(!gate.canStartSQLiteWork, "c6: didEnterBackground with no engine closes the gate")
  expect(cache.sectionsInFlight == 0 && !journalExists(url) && writeLockIsFree(url) && rowCount(url) == 0,
         "c6: and quiesces the write before it returns: no section, no hot journal, the lock free, nothing written")
  expect(elapsed < 1.5, "c6: inside the bound (\(String(format: "%.2f", elapsed)) s)")
  _ = finished.wait(timeout: .now() + 10)
  if case .notNow? = outcome { expect(true, "c6: the write answered not-now") } else { expect(false, "c6: the write answered not-now") }

  // with the engine built the engine owns the sequence: this observer does nothing
  let builtGate = BackupExecutionGate(foreground: true)
  let builtCache = FileProviderCacheDB(gate: builtGate)
  let builtCenter = NotificationCenter()
  let builtObserver = lifecycle(builtGate, builtCenter, cache: builtCache, engineBuilt: true)
  builtObserver.start(isBackground: false)
  builtCenter.post(name: BackupGateLifecycle.didEnterBackground, object: nil)
  expect(builtObserver.isFollowing && builtGate.canStartSQLiteWork, "c6: with the engine built, didEnterBackground leaves the gate to the engine")

  // the built flag is a plain flag: reading it builds nothing, setting it is one call
  expect(!BackupGateLifecycle.engineIsBuilt, "c6: the built flag starts false")
  BackupGateLifecycle.noteEngineBuilt()
  expect(BackupGateLifecycle.engineIsBuilt, "c6: and is set by noteEngineBuilt()")
}

// ── c15 ──────────────────────────────────────────────────────────────────
do {
  let url = freshDatabase("c15")
  createSchema(url)
  withConnection(url) { db in
    exec(db, "CREATE TRIGGER poison BEFORE INSERT ON file_cache WHEN NEW.name_decrypted = 'poison' BEGIN SELECT RAISE(ABORT, 'poison'); END")
  }
  let gate = BackupExecutionGate(foreground: true)
  let cache = FileProviderCacheDB(gate: gate)
  var entries = makeEntries(50)
  entries[30]["name_decrypted"] = "poison"
  let outcome = runSync(cache, url, entries: entries)
  if case .failed = outcome { expect(true, "c15: a step that fails with the gate open fails the transaction") }
  else { expect(false, "c15: a step that fails with the gate open fails the transaction") }
  expect(rowCount(url) == 0, "c15: nothing of the listing was written (49 rows are not 'ok')")
  expect(FileProviderCacheOutcome<Int>.failed.bridged["status"] as? String == "failed", "c15: and it reaches JS as failed, never as ok")
}

// ── c16 ──────────────────────────────────────────────────────────────────
do {
  let gate = BackupExecutionGate(foreground: true)
  let cache = FileProviderCacheDB(gate: gate)
  cache.markResetOwed()
  var fallbacks = 0
  var resets = 0
  // a reset that keeps failing with the gate OPEN (full disk, corrupt file): bounded, then the cache is removed
  expect(!cache.settleOwedReset({ resets += 1; return false }, fallback: { fallbacks += 1; return true }), "c16: failure 1: still owed")
  expect(!cache.settleOwedReset({ resets += 1; return false }, fallback: { fallbacks += 1; return true }), "c16: failure 2: still owed")
  expect(fallbacks == 0, "c16: no fallback before the bound")
  expect(cache.settleOwedReset({ resets += 1; return false }, fallback: { fallbacks += 1; return true }) && fallbacks == 1 && !cache.resetOwed,
         "c16: failure 3: the fallback runs and the debt is cleared (writers are not refused for ever)")

  // a refusal by the gate costs nothing: it is not a failure of the reset
  let closed = BackupExecutionGate(foreground: false)
  let closedCache = FileProviderCacheDB(gate: closed)
  closedCache.markResetOwed()
  var closedFallbacks = 0
  for _ in 0..<6 { _ = closedCache.settleOwedReset({ false }, fallback: { closedFallbacks += 1; return true }) }
  expect(closedFallbacks == 0 && closedCache.resetOwed, "c16: refusals by a closed gate never trigger the fallback (6 of them)")
}

// ── c7 ───────────────────────────────────────────────────────────────────
do {
  let ok = FileProviderCacheOutcome<Int>.done(7).bridged
  let notNow = FileProviderCacheOutcome<Int>.notNow.bridged
  expect(ok["status"] as? String == "ok" && ok["count"] as? Int == 7, "c7: done(7) bridges as {status: ok, count: 7}")
  expect(notNow["status"] as? String == "not_now" && notNow["count"] == nil, "c7: notNow bridges as {status: not_now}")
}

if failures.isEmpty {
  print("file-provider-cache-quiesce-test: \(total) assertions, 0 failed")
} else {
  print("file-provider-cache-quiesce-test: \(failures.count) of \(total) assertions FAILED")
  for f in failures { print("  FAILED: \(f)") }
  exit(1)
}
