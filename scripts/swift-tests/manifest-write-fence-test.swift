import Darwin
import Foundation
import SQLite3

// Task 1667 round 8 (Codex P1 "Fence late photo scans before resetting the
// manifest", mobile#182 at 556ef334) — standalone swiftc test for the
// manifest write fence. Compiled with the REAL shipped sources
// (modules/beebeeb-crypto/ios/ManifestWriteFence.swift +
// BackupManifestHandle.swift + BackupManifestStore.swift +
// ManifestRebuildGate.swift) by scripts/swift-ci/run-swift-tests.sh, against
// real SQLite files.
//
// Each producer below has the engine's shape (NativeBackupEngine.swift):
//   ticket   = dbQueue.sync { manifestHandle.writeFence.issue(for: account) }   (manifestWriteTicket)
//   <PhotoKit fetch / change details / GET identifiers, which can take seconds>
//   dbQueue.sync/async { FencedManifestWrites.<write>(db, fence:, ticket:, ...) }
// The PhotoKit source is a stub whose fetch blocks until the test releases
// it; the sign-out is the real `resetForSignOut` on the same serial queue.
//
// (a) a scan whose fetch is delayed past a sign-out reset writes 0 rows.
// (b) the same for a photo-library observer callback and a rebuild step.
// (c) a scan started AFTER sign-in, under the new generation, writes normally.

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
let root = fm.temporaryDirectory.appendingPathComponent("bb-1667-fence-\(UUID().uuidString)", isDirectory: true)
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

/// Reads the file on disk through a connection of its own (what the next
/// launch, or the JS layer, would see).
func onDisk(_ path: String, _ sql: String) -> Int {
  var db: OpaquePointer?
  guard sqlite3_open_v2(path, &db, SQLITE_OPEN_READONLY, nil) == SQLITE_OK, let db else { return -1 }
  defer { sqlite3_close(db) }
  var stmt: OpaquePointer?
  guard sqlite3_prepare_v2(db, sql, -1, &stmt, nil) == SQLITE_OK else { return -1 }
  defer { sqlite3_finalize(stmt) }
  guard sqlite3_step(stmt) == SQLITE_ROW else { return -1 }
  return Int(sqlite3_column_int64(stmt, 0))
}

let allRows = "SELECT COUNT(*) FROM backup_assets"

/// The engine's manifest: one serial queue (dbQueue) and the real handle.
final class Manifest {
  let path: String
  let queue: DispatchQueue
  let handle: BackupManifestHandle
  let flag = PendingFlag()

  init(_ name: String) {
    path = root.appendingPathComponent("\(name).db").path
    queue = DispatchQueue(label: "test.dbQueue.\(name)")
    handle = BackupManifestHandle(path: path, pendingReset: flag.flag, prepareSchema: prepareSchema)
    let opened = queue.sync { handle.openIfClosed() }
    precondition(opened == nil, "open \(name)")
  }

  /// `bindAccount` (a JS-confirmed sign-in).
  func signIn(_ account: String) { queue.sync { handle.writeFence.bind(accountId: account) } }
  /// `prepareForStoragePurge` -> `resetForSignOut`, one dbQueue block.
  @discardableResult
  func signOut(_ account: String) -> Bool { queue.sync { handle.resetForSignOut(outgoingAccountId: account) } }
  /// `manifestWriteTicket`.
  func ticket(_ account: String?) -> ManifestWriteFence.Ticket? { queue.sync { handle.writeFence.issue(for: account) } }
  var dropped: [String] { queue.sync { handle.writeFence.droppedWriters } }
  var generation: UInt64 { queue.sync { handle.writeFence.generation } }
  func close() { queue.sync { if let db = handle.db { _ = BackupManifestStore.closeConnection(db) } } }
}

/// A stub PhotoKit source. `fetch()` reports that it started, then blocks
/// until the test releases it (the slow fetch of a large library).
final class StubPhotoKit {
  let started = DispatchSemaphore(value: 0)
  let release = DispatchSemaphore(value: 0)
  let assets: [BackupManifestStore.ScannedAsset]
  init(_ ids: [String]) {
    assets = ids.map { BackupManifestStore.ScannedAsset(localAssetId: $0, createdAt: "2026-10-01T10:00:00Z", assetType: "photo") }
  }
  func fetch() -> [BackupManifestStore.ScannedAsset] {
    started.signal()
    release.wait()
    return assets
  }
}

enum ScanResult: Equatable {
  case noTicket
  case wrote(FencedManifestWrites.ScanWrite)
}

/// `scanPhotoLibraryForPendingUploads`: ticket first, then the (slow)
/// PhotoKit fetch, then the fenced insert + album selection on dbQueue.
func startScan(_ m: Manifest, account: String?, photoKit: StubPhotoKit, done: Box<ScanResult>, group: DispatchGroup) {
  group.enter()
  DispatchQueue.global().async {
    defer { group.leave() }
    guard let ticket = m.ticket(account) else {
      done.set(.noTicket)
      return
    }
    let assets = photoKit.fetch()
    let selection = FencedManifestWrites.Selection(allowedAssetIds: Set(assets.map(\.localAssetId)), hasAlbumSelection: false)
    let written = m.queue.sync {
      FencedManifestWrites.scanInsert(
        m.handle.db, fence: m.handle.writeFence, ticket: ticket, writer: "scan.insert",
        assets: assets, selection: selection, nowMs: BackupManifestStore.currentMs()
      )
    }
    done.set(.wrote(written))
  }
}

let cameraRollA = (1...6).map { "A-photo-\($0)/L0/001" }

// MARK: - (a) a scan whose PhotoKit fetch finishes after the sign-out reset

do {
  let m = Manifest("a-scan")
  m.signIn("acct-A")
  let photoKit = StubPhotoKit(cameraRollA)
  let done = Box<ScanResult>()
  let group = DispatchGroup()
  startScan(m, account: "acct-A", photoKit: photoKit, done: done, group: group)
  expect(photoKit.started.wait(timeout: .now() + 5) == .success, "a1: the scan took its ticket and is inside the PhotoKit fetch")
  let generationBefore = m.generation
  expect(m.signOut("acct-A"), "a1: the sign-out reset succeeded")
  expect(m.generation > generationBefore, "a1: the reset advanced the fence generation")
  photoKit.release.signal()
  expect(group.wait(timeout: .now() + 5) == .success, "a1: the late scan finished")
  expect(done.get() == .wrote(.fenced), "a1: the late scan's insert was dropped by the fence (got \(String(describing: done.get())))")
  expect(onDisk(m.path, allRows) == 0, "a1: 0 rows of the outgoing account in the manifest on disk (got \(onDisk(m.path, allRows)))")
  expect(m.dropped == ["scan.insert"], "a1: exactly one dropped write, the scan's insert (got \(m.dropped))")

  // A scan that starts while signed out (after the reset, before any
  // sign-in) gets no ticket and writes nothing.
  let photoKit2 = StubPhotoKit(cameraRollA)
  photoKit2.release.signal()
  let done2 = Box<ScanResult>()
  startScan(m, account: "acct-A", photoKit: photoKit2, done: done2, group: group)
  expect(group.wait(timeout: .now() + 5) == .success, "a2: the signed-out scan finished")
  expect(done2.get() == .noTicket, "a2: no ticket while the fence is sealed by the sign-out")
  expect(onDisk(m.path, allRows) == 0, "a2: still 0 rows")

  // A write that comes with no ticket at all is dropped too.
  let noTicket = m.queue.sync {
    FencedManifestWrites.scanInsert(
      m.handle.db, fence: m.handle.writeFence, ticket: nil, writer: "scan.no_ticket",
      assets: photoKit.assets, selection: nil, nowMs: 1
    )
  }
  expect(noTicket == .fenced, "a3: a write without a ticket is dropped")
  expect(onDisk(m.path, allRows) == 0, "a3: still 0 rows")
  m.close()
}

// (a4) the sign-out reset FAILS (another connection holds the writer lock):
// the fence is advanced first anyway, and the late scan still writes nothing
// after the recovery reopened the handle.
do {
  let m = Manifest("a-failed-reset")
  m.signIn("acct-A")
  let photoKit = StubPhotoKit(cameraRollA)
  let done = Box<ScanResult>()
  let group = DispatchGroup()
  startScan(m, account: "acct-A", photoKit: photoKit, done: done, group: group)
  expect(photoKit.started.wait(timeout: .now() + 5) == .success, "a4: the scan is inside the PhotoKit fetch")
  var locker: OpaquePointer?
  precondition(sqlite3_open_v2(m.path, &locker, SQLITE_OPEN_READWRITE, nil) == SQLITE_OK)
  sqlite3_busy_timeout(locker, 0)
  expect(sqlite3_exec(locker, "BEGIN IMMEDIATE", nil, nil, nil) == SQLITE_OK, "a4: a second connection holds the writer lock")
  expect(m.signOut("acct-A") == false, "a4: the in-place reset failed (writer lock)")
  sqlite3_exec(locker, "ROLLBACK", nil, nil, nil)
  sqlite3_close(locker)
  let finish = m.queue.sync { m.handle.finishAfterFailedReset(allowUnlink: true) }
  expect(finish.ok && finish.reopened, "a4: the recovery emptied the file and reopened the handle")
  photoKit.release.signal()
  expect(group.wait(timeout: .now() + 5) == .success, "a4: the late scan finished")
  expect(done.get() == .wrote(.fenced), "a4: the late scan's insert was dropped (got \(String(describing: done.get())))")
  expect(onDisk(m.path, allRows) == 0, "a4: 0 rows after a failed reset + recovery")
  m.close()
}

// MARK: - (b) a photo-library observer callback

do {
  let m = Manifest("b-observer")
  m.signIn("acct-A")
  // `photoLibraryDidChange`: the ticket is taken on entry; the insert is
  // enqueued on dbQueue later (after the change details are computed).
  let ticket = m.ticket("acct-A")
  expect(ticket != nil, "b1: the callback got a ticket while A is signed in")
  m.signOut("acct-A")
  let inserted = Array(cameraRollA.prefix(3)).map {
    BackupManifestStore.ScannedAsset(localAssetId: $0, createdAt: "2026-10-01T10:00:00Z", assetType: "photo")
  }
  let wrote = Box<FencedManifestWrites.ScanWrite>()
  let sem = DispatchSemaphore(value: 0)
  m.queue.async {
    wrote.set(FencedManifestWrites.scanInsert(
      m.handle.db, fence: m.handle.writeFence, ticket: ticket, writer: "photo_library_change.insert",
      assets: inserted, selection: nil, nowMs: BackupManifestStore.currentMs()
    ))
    sem.signal()
  }
  _ = sem.wait(timeout: .now() + 5)
  expect(wrote.get() == .fenced, "b1: the observer's insert after the reset was dropped (got \(String(describing: wrote.get())))")
  expect(onDisk(m.path, allRows) == 0, "b1: 0 rows of the outgoing account (got \(onDisk(m.path, allRows)))")

  // The callback whose insert was enqueued BEFORE the reset's block: it ran
  // first (FIFO), and the reset removed its rows.
  m.signIn("acct-A")
  let early = m.ticket("acct-A")
  let sem2 = DispatchSemaphore(value: 0)
  m.queue.async {
    _ = FencedManifestWrites.scanInsert(
      m.handle.db, fence: m.handle.writeFence, ticket: early, writer: "photo_library_change.insert",
      assets: inserted, selection: nil, nowMs: BackupManifestStore.currentMs()
    )
    sem2.signal()
  }
  let resetAfter = m.signOut("acct-A")
  _ = sem2.wait(timeout: .now() + 5)
  expect(resetAfter, "b2: the reset after an earlier insert succeeded")
  expect(onDisk(m.path, allRows) == 0, "b2: the insert that ran before the reset was removed by it")
  m.close()
}

// MARK: - (b) a rebuild step: GET identifiers in flight across the sign-out

do {
  let m = Manifest("b-rebuild")
  m.signIn("acct-A")
  guard let ticketA = m.ticket("acct-A") else { fatalError("no ticket for A") }
  let fetchStarted = DispatchSemaphore(value: 0)
  let fetchRelease = DispatchSemaphore(value: 0)
  let serverMapA = Dictionary(uniqueKeysWithValues: cameraRollA.enumerated().map { ($1, "file-of-A-\($0)") })

  // `ensureManifestReadyForUploads`'s steps, each database step in its own
  // dbQueue block behind the batch's ticket.
  func steps(_ ticket: ManifestWriteFence.Ticket, account: String, fetch: @escaping () async throws -> [String: String]) -> ManifestRebuildGate.Steps {
    ManifestRebuildGate.Steps(
      needsRebuild: {
        m.queue.sync {
          FencedManifestWrites.needsRebuild(
            m.handle.db, fence: m.handle.writeFence, ticket: ticket, accountId: account,
            scanInsertFailed: false, nowMs: BackupManifestStore.currentMs()
          )
        }
      },
      hasDeviceId: { true },
      fetchMap: fetch,
      // The engine's `currentAccountId == accountId` read: not in the write's
      // critical section, so it can pass just before the reset. Modelled as
      // passing.
      isStillCurrent: { true },
      applyMap: { map in
        m.queue.sync {
          FencedManifestWrites.applyServerMap(
            m.handle.db, fence: m.handle.writeFence, ticket: ticket, accountId: account,
            map: map, uploadedAtIso: "2026-10-18T10:00:00Z", nowMs: BackupManifestStore.currentMs()
          )
        }
      },
      applyKept: {
        m.queue.sync {
          FencedManifestWrites.applyKept(
            m.handle.db, fence: m.handle.writeFence, ticket: ticket, accountId: account,
            nowMs: BackupManifestStore.currentMs()
          )
        }
      }
    )
  }

  let outcome = Box<ManifestRebuildGate.Outcome>()
  let gateDone = DispatchSemaphore(value: 0)
  Task {
    let result = await ManifestRebuildGate.run(alreadyReady: false, steps: steps(ticketA, account: "acct-A", fetch: {
      fetchStarted.signal()
      await withCheckedContinuation { (c: CheckedContinuation<Void, Never>) in
        DispatchQueue.global().async { fetchRelease.wait(); c.resume() }
      }
      return serverMapA
    }))
    outcome.set(result)
    gateDone.signal()
  }
  expect(fetchStarted.wait(timeout: .now() + 5) == .success, "b3: A's rebuild is inside GET identifiers")
  // Sign-out A, sign-in B, and B's own scan (new generation) queues the
  // same camera roll while A's fetch is still in flight.
  m.signOut("acct-A")
  m.signIn("acct-B")
  let photoKitB = StubPhotoKit(cameraRollA)
  photoKitB.release.signal()
  let scanB = Box<ScanResult>()
  let group = DispatchGroup()
  startScan(m, account: "acct-B", photoKit: photoKitB, done: scanB, group: group)
  _ = group.wait(timeout: .now() + 5)
  expect(scanB.get() == .wrote(.written(inserted: true)), "b3: B's scan wrote its rows")
  fetchRelease.signal()
  expect(gateDone.wait(timeout: .now() + 10) == .success, "b3: A's rebuild finished")
  expect(outcome.get() == .deferred(.applyMapFailed), "b3: A's server map write was dropped, the gate deferred (got \(String(describing: outcome.get())))")
  expect(onDisk(m.path, "SELECT COUNT(*) FROM backup_assets WHERE uploaded_account_id = 'acct-A' OR remote_file_id LIKE 'file-of-A-%'") == 0,
         "b3: 0 rows carry A's account or A's file ids")
  expect(onDisk(m.path, "SELECT COUNT(*) FROM backup_assets WHERE status = 'pending_upload'") == cameraRollA.count,
         "b3: B's \(cameraRollA.count) rows are still queued for B (got \(onDisk(m.path, "SELECT COUNT(*) FROM backup_assets WHERE status = 'pending_upload'")))")
  expect(m.dropped.contains("rebuild.apply_map"), "b3: the dropped write was the map (got \(m.dropped))")

  // B's own rebuild (its own ticket) applies normally.
  guard let ticketB = m.ticket("acct-B") else { fatalError("no ticket for B") }
  let serverMapB = [cameraRollA[0]: "file-of-B-0"]
  let outcomeB = runBounded { await ManifestRebuildGate.run(alreadyReady: false, steps: steps(ticketB, account: "acct-B", fetch: { serverMapB })) }
  expect(outcomeB == .ready(rebuilt: true, promoted: 1, keptApplied: 0), "b4: B's rebuild applies its own map (got \(String(describing: outcomeB)))")
  expect(onDisk(m.path, "SELECT COUNT(*) FROM backup_assets WHERE uploaded_account_id = 'acct-B' AND remote_file_id = 'file-of-B-0'") == 1,
         "b4: B's photo is recorded as B's upload")
  m.close()
}

// MARK: - (c) a scan started AFTER sign-in, under the new generation

do {
  let m = Manifest("c-new-generation")
  m.signIn("acct-A")
  let oldTicket = m.ticket("acct-A")
  m.signOut("acct-A")
  m.signIn("acct-B")
  let photoKit = StubPhotoKit(cameraRollA)
  photoKit.release.signal()
  let done = Box<ScanResult>()
  let group = DispatchGroup()
  startScan(m, account: "acct-B", photoKit: photoKit, done: done, group: group)
  expect(group.wait(timeout: .now() + 5) == .success, "c1: B's scan finished")
  expect(done.get() == .wrote(.written(inserted: true)), "c1: B's scan wrote (got \(String(describing: done.get())))")
  expect(onDisk(m.path, allRows) == cameraRollA.count, "c1: \(cameraRollA.count) rows queued for B (got \(onDisk(m.path, allRows)))")
  expect(m.dropped.isEmpty, "c1: nothing dropped (got \(m.dropped))")

  // A's old ticket is dead under B's generation; B's re-bind changes nothing.
  let stale = m.queue.sync {
    FencedManifestWrites.recordServerMarked(
      m.handle.db, fence: m.handle.writeFence, ticket: oldTicket, assetId: cameraRollA[0], fileId: "file-of-A-0", nowMs: 1
    )
  }
  expect(stale == false, "c2: a write under A's old ticket is dropped under B")
  let generation = m.generation
  m.signIn("acct-B")
  expect(m.generation == generation, "c2: re-binding the same account keeps the generation")
  expect(m.ticket("acct-A") == nil, "c2: no ticket for A while B is bound")

  // An account switch WITHOUT a reset (a new token, then bindAccount(B'))
  // also starts a new generation: B's in-flight ticket dies.
  let ticketB = m.ticket("acct-B")
  m.signIn("acct-C")
  let afterSwitch = m.queue.sync {
    FencedManifestWrites.applyKept(m.handle.db, fence: m.handle.writeFence, ticket: ticketB, accountId: "acct-B", nowMs: 1)
  }
  expect(afterSwitch == nil, "c3: B's ticket is dropped once C is bound")
  m.close()
}

// MARK: - the fence's own rules

do {
  let fence = ManifestWriteFence()
  expect(fence.issue(for: nil) == nil && fence.issue(for: "") == nil, "f1: no account, no ticket")
  let first = fence.issue(for: "acct-A")
  expect(first != nil && fence.state == .bound("acct-A"), "f1: a fresh process binds lazily on the first ticket")
  expect(fence.issue(for: "acct-B") == nil, "f1: no ticket for another account")
  expect(fence.admits(first, writer: "x"), "f1: a current ticket is admitted")
  fence.advanceForSignOut()
  expect(fence.admits(first, writer: "x") == false, "f2: the sign-out reset kills every earlier ticket")
  expect(fence.state == .sealed && fence.issue(for: "acct-A") == nil, "f3: sealed after a sign-out")
  fence.bind(accountId: "acct-A")
  let again = fence.issue(for: "acct-A")
  expect(again != nil && fence.admits(again, writer: "x"), "f3: the next sign-in (even the same account) unseals")
  var reported: [String] = []
  let traced = ManifestWriteFence(onDrop: { writer, _, _ in reported.append(writer) })
  _ = traced.admits(nil, writer: "w1")
  expect(reported == ["w1"] && traced.droppedWrites == 1, "f4: every dropped write is reported")
}

// MARK: - Report

if failures.isEmpty {
  print("ManifestWriteFenceTests: \(total) assertions, 0 failed")
  exit(0)
} else {
  for f in failures { print("FAIL: \(f)") }
  print("ManifestWriteFenceTests: \(failures.count) of \(total) assertions FAILED")
  exit(1)
}
