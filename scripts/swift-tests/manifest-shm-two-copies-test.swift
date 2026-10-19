import Darwin
import Foundation
import ManifestSQLite

// Task 2033 (TestFlight build 240 launch crash) — standalone swiftc test that
// reproduced, deterministically, the hazard behind
// `EXC_BAD_ACCESS (SIGBUS) / FS pagein error: 22 / cluster_pagein past EOF`
// in `NativeBackupEngine.countWhere` (the JS progress poll at launch) while
// expo-sqlite's thread was inside `unixShmMap -> seekAndWriteFd` for its first
// statement on the manifest (`PRAGMA journal_mode = WAL`, BackupDatabase.ts
// `migrate`).
//
// Build 240 had two SQLite copies on the manifest: the engine's
// `import SQLite3` bound the vanilla `sqlite3_*` the Rust core's static
// library (`libbeebeeb_uniffi.a`) exports (SQLite 3.46.0, libsqlite3-sys
// bundled; the crash's `sqlite3_step` frame is inside the Beebeeb image), and
// JS ran on expo-sqlite's own copy (`exsqlite3_*`, 3.50.3).
//
// The fix (Option A): the manifest has ONE copy, expo-sqlite's. The test
// wires both sides as the app does now:
//   * the ENGINE side is the REAL shipped `BackupManifestHandle` /
//     `BackupManifestStore` (compiled in by scripts/swift-ci/run-swift-tests.sh)
//     on `import ManifestSQLite`, through the SAME module map the app's
//     BeebeebCrypto pod uses (modules/beebeeb-crypto/ios/ManifestSQLite), and
//     linked against expo's exact amalgamation. The engine-side helpers below
//     (`countWhere`, `exec`, the schema) mirror NativeBackupEngine, which binds
//     the same module.
//   * the JS side is expo-sqlite's copy as expo's own module calls it: the
//     exact `node_modules/expo-sqlite/vendor/sqlite3/sqlite3.c` the app
//     compiles (symbols renamed `exsqlite3_*`), built by the runner into a
//     dylib with the podspec's flags and loaded here with dlopen
//     (`BB_EXPO_SQLITE_DYLIB`). It is the image the engine side links, so
//     (e0) checks both sides resolve to one copy.
//   * the Rust core's copy is still in the binary, as in the app: the runner
//     links a vanilla `sqlite3_*` object (expo's amalgamation with the rename
//     reversed, or `BB_ENGINE_SQLITE_SRC`, e.g. libsqlite3-sys 0.30.1's
//     sqlite3.c = the app's exact 3.46.0). (e0) checks it is present and that
//     the engine code does not use it. The macOS system copy never stands in
//     for it: Apple's libsqlite3 locks the `-shm` in a way F_GETLK from
//     another copy does see (run 2026-10-19), so it would hide the bug.
//
// Red on e0d9b86 / 17565132 (engine on the vanilla copy; see the task's
// evidence for the exact failing assertions). Green from task 2033's fix on.
//
// The mechanism (sqlite3.c `unixLockSharedMemory`): the first connection a
// SQLite copy opens on a WAL database asks F_GETLK whether anyone holds the
// DMS byte of `-shm`. F_GETLK never reports locks held by the SAME process, so
// expo's copy always concludes it is the first user and truncates `-shm` to 3
// bytes, then re-extends it page by page. The engine's copy has that file
// mmapped (32 KB, one WAL-index page): any access of a page past the new EOF
// faults with SIGBUS ("cluster_pagein past EOF"). The engine touches the
// hash-table half of the page (offset >= 16 KB; the crash faulted at 18554)
// whenever the WAL has frames to look up or rebuild.
//
// The test makes the on-device race deterministic: expo's `ftruncate` system
// call is wrapped (`xSetSystemCall`, a public SQLite VFS API) and the engine's
// read runs INSIDE the truncate window, in a child process so a SIGBUS can be
// observed instead of killing the runner.
//
//   (s) instrument self-test: expo's first connection on a file nobody else
//       has open truncates its `-shm` (the wrapper sees it). Proves the
//       wrapper can see a truncation, so (a)'s "none seen" means something.
//   (a) the engine's handle is open (the 240 JS open gate opens it first),
//       the upgrade claim has written WAL frames; JS's first open must not
//       truncate the `-shm` the engine has mapped.
//   (b) same state, the engine's progress read runs inside the truncate
//       window (child process): the child must not die of SIGBUS.
//   (c) control: the same with the WAL checkpointed empty first (no frames to
//       look up): survives even on the broken build, so (b)'s fault comes
//       from the frame lookup, not from the harness.
//   (d) the second hazard: a write transaction (`BEGIN IMMEDIATE`) on either
//       side must exclude the other side's (SQLITE_BUSY). The two copies let
//       both hold one at once (rc 0 and 0).
//   (e) the hazard behind task 1667's "never close while the other side may
//       hold the file" rules: the last connection of one side closing while
//       the other side's is open must leave `-wal`/`-shm` in place, and the
//       other side's writes must stay visible. With two copies, a close
//       concluded it was the file's last connection and deleted them (task
//       1667 simulator finding). Kept as evidence; the rules themselves stay
//       (task 2033: simplify only what is proven, see CLAUDE.md).

var failures: [String] = []
var total = 0

func expect(_ condition: Bool, _ label: String) {
  total += 1
  if !condition { failures.append(label) }
}

let fm = FileManager.default

// MARK: - expo-sqlite's copy (dlopen, exsqlite3_*)

typealias ExOpen = @convention(c) (UnsafePointer<CChar>?, UnsafeMutablePointer<OpaquePointer?>?, Int32, UnsafePointer<CChar>?) -> Int32
typealias ExExec = @convention(c) (OpaquePointer?, UnsafePointer<CChar>?, OpaquePointer?, UnsafeMutableRawPointer?, UnsafeMutablePointer<UnsafeMutablePointer<CChar>?>?) -> Int32
typealias ExClose = @convention(c) (OpaquePointer?) -> Int32
typealias ExVfsFind = @convention(c) (UnsafePointer<CChar>?) -> UnsafeMutablePointer<exsqlite3_vfs>?
typealias ExVersion = @convention(c) () -> UnsafePointer<CChar>?

guard let expoDylib = ProcessInfo.processInfo.environment["BB_EXPO_SQLITE_DYLIB"], !expoDylib.isEmpty else {
  // Never a silent skip: without expo's copy this test proves nothing.
  print("manifest-shm-two-copies: BB_EXPO_SQLITE_DYLIB is not set (scripts/swift-ci/run-swift-tests.sh builds it)")
  exit(1)
}
guard let lib = dlopen(expoDylib, RTLD_NOW | RTLD_LOCAL) else {
  print("manifest-shm-two-copies: dlopen failed: \(String(cString: dlerror()))")
  exit(1)
}
func sym<T>(_ name: String, _ type: T.Type) -> T {
  guard let p = dlsym(lib, name) else {
    print("manifest-shm-two-copies: missing symbol \(name)")
    exit(1)
  }
  return unsafeBitCast(p, to: type)
}
let exOpen = sym("exsqlite3_open_v2", ExOpen.self)
let exExec = sym("exsqlite3_exec", ExExec.self)
let exClose = sym("exsqlite3_close_v2", ExClose.self)
let exVfsFind = sym("exsqlite3_vfs_find", ExVfsFind.self)
let exLibVersion = sym("exsqlite3_libversion", ExVersion.self)

// MARK: - the ftruncate wrapper on expo's copy

/// Suffix of the `-shm` path the wrapper reports on (set per scenario).
var watchedShmSuffix = ""
/// (size before, size after) of every truncation of the watched `-shm`.
var shmTruncations: [(Int64, Int64)] = []
/// Runs right after expo's copy truncated the watched `-shm`, before it
/// re-extends it: the window the on-device race hit.
var inTruncateWindow: (() -> Void)?

let ftruncateWrapper: @convention(c) (Int32, off_t) -> Int32 = { fd, length in
  var st = stat()
  let before = fstat(fd, &st) == 0 ? Int64(st.st_size) : -1
  var buf = [CChar](repeating: 0, count: Int(MAXPATHLEN) + 1)
  let named = fcntl(fd, F_GETPATH, &buf) != -1
  let path = named ? String(cString: buf) : ""
  let rc = ftruncate(fd, length)
  if rc == 0, !watchedShmSuffix.isEmpty, path.hasSuffix(watchedShmSuffix) {
    shmTruncations.append((before, Int64(length)))
    inTruncateWindow?()
  }
  return rc
}

guard let exVfs = exVfsFind(nil), let setSyscall = exVfs.pointee.xSetSystemCall else {
  print("manifest-shm-two-copies: expo's default VFS has no xSetSystemCall")
  exit(1)
}
guard setSyscall(exVfs, "ftruncate", unsafeBitCast(ftruncateWrapper, to: sqlite3_syscall_ptr.self)) == SQLITE_OK else {
  print("manifest-shm-two-copies: could not wrap expo's ftruncate")
  exit(1)
}

/// BackupDatabase.ts `openAndMigrate`: `SQLite.openDatabaseAsync` then the
/// first statement of `migrate`.
func jsOpen(_ path: String) -> (OpaquePointer?, Int32) {
  var db: OpaquePointer?
  let flags = SQLITE_OPEN_READWRITE | SQLITE_OPEN_CREATE | SQLITE_OPEN_FULLMUTEX
  guard exOpen(path, &db, flags, nil) == SQLITE_OK else { return (db, -1) }
  let rc = exExec(db, "PRAGMA journal_mode = WAL; PRAGMA foreign_keys = ON;", nil, nil, nil)
  return (db, rc)
}

// MARK: - the engine side (real shipped handle + store, `import ManifestSQLite`)

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

/// The engine's ensureTables (NativeBackupEngine) + the 1667 migration.
func prepareSchema(_ db: OpaquePointer) {
  exsqlite3_exec(db, schema, nil, nil, nil)
  BackupManifestStore.migrate(db)
}

final class PendingFlag {
  var pending = false
  var flag: BackupManifestHandle.ResetPendingFlag {
    BackupManifestHandle.ResetPendingFlag(get: { self.pending }, set: { self.pending = $0 })
  }
}

func exec(_ db: OpaquePointer, _ sql: String) {
  var err: UnsafeMutablePointer<CChar>?
  if exsqlite3_exec(db, sql, nil, nil, &err) != SQLITE_OK {
    let msg = err.map { String(cString: $0) } ?? "?"
    exsqlite3_free(err)
    fatalError("SQL failed: \(msg)\n\(sql)")
  }
}

/// NativeBackupEngine.pendingUploadCount -> countWhere (NativeBackupEngine.swift:1341/:7239),
/// on the same module the engine binds.
let pendingUploadCondition = "COALESCE(selected_for_backup, 1) = 1 AND status IN ('pending_upload', 'pending_reupload', 'staging', 'staged_upload', 'uploading') AND COALESCE(retry_count, 0) < 10"
func countWhere(_ db: OpaquePointer, _ condition: String) -> Int {
  var stmt: OpaquePointer?
  let sql = "SELECT COUNT(*) FROM backup_assets WHERE \(condition)"
  guard exsqlite3_prepare_v2(db, sql, -1, &stmt, nil) == SQLITE_OK else { return -1 }
  defer { exsqlite3_finalize(stmt) }
  return exsqlite3_step(stmt) == SQLITE_ROW ? Int(exsqlite3_column_int(stmt, 0)) : -1
}

func fileSize(_ path: String) -> Int64 {
  ((try? fm.attributesOfItem(atPath: path))?[.size] as? NSNumber)?.int64Value ?? -1
}

let now: Int64 = 1_800_000_000_000
let accountA = "acct-A"
let libraryRows = 3000

/// A manifest as build 239 left it (uploaded rows from before the
/// `uploaded_account_id` column), then the first launch of 240: the JS open
/// gate opens the engine's handle (`admitPeerOpen`), and the sign-in's
/// `claim` adopts every pre-column row (one UPDATE over the whole library:
/// WAL frames). The progress poll has the `-shm` mapped.
func upgradedEngine(_ dir: URL, checkpointFirst: Bool) -> (BackupManifestHandle, String) {
  try? fm.removeItem(at: dir)
  try! fm.createDirectory(at: dir, withIntermediateDirectories: true)
  let path = dir.appendingPathComponent("beebeeb-backup.db").path
  let handle = BackupManifestHandle(path: path, pendingReset: PendingFlag().flag, now: { now }, prepareSchema: prepareSchema)
  let gate = handle.admitPeerOpen(priorPeerHandlesClosed: true)
  precondition(gate.admitted && handle.db != nil, "setup: engine handle open, JS admitted")
  let db = handle.db!
  exec(db, "BEGIN")
  for i in 0..<libraryRows {
    exec(db, """
    INSERT INTO backup_assets (local_asset_id, remote_file_id, remote_path, content_hash, file_size, created_at, asset_type, status)
    VALUES ('asset-\(i)/L0/001', 'file-\(i)', '/Photos/IMG_\(i).HEIC', '\(String(repeating: "ab", count: 32))', \(1_000_000 + i),
            '2026-10-01T00:00:00Z', 'photo', 'uploaded')
    """)
  }
  exec(db, "COMMIT")
  let claimed = BackupManifestStore.claim(db, accountId: accountA, nowMs: now)
  precondition(claimed?.adopted == libraryRows, "setup: claim adopted every pre-column row (\(String(describing: claimed)))")
  if checkpointFirst {
    exec(db, "PRAGMA wal_checkpoint(TRUNCATE)")
  }
  precondition(countWhere(db, pendingUploadCondition) == 0, "setup: progress read")
  return (handle, path)
}

let root = fm.temporaryDirectory.appendingPathComponent("bb-2033-shm-\(getpid())", isDirectory: true)

// MARK: - child mode: the engine's progress read inside the truncate window

let args = CommandLine.arguments
if args.count >= 3, args[1] == "--child" {
  let checkpointFirst = args[2] == "checkpointed"
  let dir = root.appendingPathComponent("child-\(args[2])", isDirectory: true)
  let (handle, path) = upgradedEngine(dir, checkpointFirst: checkpointFirst)
  print("child: wal \(fileSize(path + "-wal")) bytes, shm \(fileSize(path + "-shm")) bytes before JS opens")
  watchedShmSuffix = "/child-\(args[2])/beebeeb-backup.db-shm"
  inTruncateWindow = {
    print("child: expo truncated -shm; engine progress read inside the window")
    fflush(stdout)
    _ = countWhere(handle.db!, pendingUploadCondition)
    print("child: engine read returned")
    fflush(stdout)
  }
  let (js, rc) = jsOpen(path)
  print("child: JS open rc=\(rc), truncations=\(shmTruncations.count)")
  print("child: survived")
  fflush(stdout)
  _ = exClose(js)
  try? fm.removeItem(at: dir)
  exit(0)
}

try? fm.removeItem(at: root)
try! fm.createDirectory(at: root, withIntermediateDirectories: true)
defer { try? fm.removeItem(at: root) }
print("expo copy (JS, dlopen): SQLite \(String(cString: exLibVersion()!)); engine side (import ManifestSQLite): SQLite \(String(cString: exsqlite3_libversion()))")

// MARK: - (e0) one copy: the engine side binds the image JS uses

func imagePath(_ p: UnsafeRawPointer?) -> String? {
  guard let p else { return nil }
  var info = Dl_info()
  guard dladdr(p, &info) != 0, let name = info.dli_fname else { return nil }
  return URL(fileURLWithPath: String(cString: name)).resolvingSymlinksInPath().path
}

do {
  let engineStep: @convention(c) (OpaquePointer?) -> Int32 = exsqlite3_step
  let engineImage = imagePath(unsafeBitCast(engineStep, to: UnsafeRawPointer.self))
  let jsImage = imagePath(dlsym(lib, "exsqlite3_step").map { UnsafeRawPointer($0) })
  let expoImage = URL(fileURLWithPath: expoDylib).resolvingSymlinksInPath().path
  expect(engineImage != nil && engineImage == jsImage && jsImage == expoImage,
         "e0: the engine's step and JS's step are the same copy, expo-sqlite's (engine \(engineImage ?? "?"), JS \(jsImage ?? "?"))")
  // The Rust core's stand-in is still in the binary (as libbeebeeb_uniffi.a's
  // copy is in the app): the test proves the engine does not use it, not
  // that it is absent.
  let exe = URL(fileURLWithPath: CommandLine.arguments[0]).resolvingSymlinksInPath().path
  let rustStep = dlsym(UnsafeMutableRawPointer(bitPattern: -5), "sqlite3_step") // RTLD_MAIN_ONLY
  expect(imagePath(rustStep.map { UnsafeRawPointer($0) }) == exe,
         "e0: a vanilla sqlite3_* (the Rust core's stand-in) is linked into the binary, as in the app")
  expect(engineImage != exe, "e0: the engine's step is not the vanilla copy in the binary")
}

// MARK: - (s) instrument self-test

do {
  let dir = root.appendingPathComponent("s-alone", isDirectory: true)
  try! fm.createDirectory(at: dir, withIntermediateDirectories: true)
  let path = dir.appendingPathComponent("beebeeb-backup.db").path
  watchedShmSuffix = "/s-alone/beebeeb-backup.db-shm"
  shmTruncations = []
  let (js, rc) = jsOpen(path)
  expect(rc == SQLITE_OK, "s1: expo's copy opens a fresh manifest (rc \(rc))")
  _ = exExec(js, "CREATE TABLE t(x); INSERT INTO t VALUES (1);", nil, nil, nil)
  expect(shmTruncations.count == 1 && shmTruncations.first?.1 == 3,
         "s2: the wrapper sees expo's first-connection -shm truncation (to 3 bytes) on a file nobody else holds (seen \(shmTruncations))")
  _ = exClose(js)
  watchedShmSuffix = ""
}

// MARK: - (a) JS's first open must not truncate the engine's mapped -shm

do {
  let dir = root.appendingPathComponent("a-upgrade", isDirectory: true)
  let (handle, path) = upgradedEngine(dir, checkpointFirst: false)
  let shmBefore = fileSize(path + "-shm")
  expect(shmBefore >= 32768, "a0: the engine has a full WAL-index page (\(shmBefore) bytes)")
  expect(fileSize(path + "-wal") > 32, "a0: the upgrade claim left WAL frames (\(fileSize(path + "-wal")) bytes)")
  watchedShmSuffix = "/a-upgrade/beebeeb-backup.db-shm"
  shmTruncations = []
  let (js, rc) = jsOpen(path)
  expect(rc == SQLITE_OK, "a1: JS's first statement succeeds (rc \(rc))")
  expect(shmTruncations.isEmpty,
         "a2: JS's first open never truncates the -shm the engine's open handle has mapped (truncations (before, after): \(shmTruncations))")
  expect(countWhere(handle.db!, "status = 'uploaded' AND uploaded_account_id = '\(accountA)'") == libraryRows,
         "a3: the engine still reads every adopted row after JS's open")
  watchedShmSuffix = ""
  _ = exClose(js)
}

// MARK: - (b) + (c) the engine's progress read inside the truncate window

func runChild(_ variant: String) -> (signal: Int32?, status: Int32, output: String) {
  let p = Process()
  p.executableURL = URL(fileURLWithPath: CommandLine.arguments[0])
  p.arguments = ["--child", variant]
  var env = ProcessInfo.processInfo.environment
  env["BB_EXPO_SQLITE_DYLIB"] = expoDylib
  p.environment = env
  let pipe = Pipe()
  p.standardOutput = pipe
  p.standardError = pipe
  try! p.run()
  let data = pipe.fileHandleForReading.readDataToEndOfFile()
  p.waitUntilExit()
  let out = String(decoding: data, as: UTF8.self)
  if p.terminationReason == .uncaughtSignal { return (p.terminationStatus, p.terminationStatus, out) }
  return (nil, p.terminationStatus, out)
}

func describe(_ r: (signal: Int32?, status: Int32, output: String)) -> String {
  let how = r.signal.map { "killed by signal \($0)\($0 == SIGBUS ? " (SIGBUS)" : "")" } ?? "exit \(r.status)"
  return "\(how); output: \(r.output.replacingOccurrences(of: "\n", with: " | "))"
}

do {
  let b = runChild("frames")
  print("(b) child: \(describe(b))")
  expect(b.signal == nil && b.status == 0 && b.output.contains("child: survived"),
         "b1: the engine's progress read during JS's first open does not fault (\(describe(b)))")

  let c = runChild("checkpointed")
  print("(c) child: \(describe(c))")
  expect(c.signal == nil && c.status == 0 && c.output.contains("child: survived"),
         "c1: control, WAL checkpointed empty first: the same read survives (\(describe(c)))")
}

// MARK: - (d) writer exclusion between the engine and JS

do {
  let dir = root.appendingPathComponent("d-lock", isDirectory: true)
  let (handle, path) = upgradedEngine(dir, checkpointFirst: false)
  let engine = handle.db!
  let (js, rc) = jsOpen(path)
  expect(rc == SQLITE_OK, "d0: JS opens next to the engine (rc \(rc))")
  // Measure exclusion, not waiting: the engine's own busy timeout
  // (BackupManifestHandle.busyTimeoutMs) is lifted for this check and
  // restored after; JS's connection here has none.
  exsqlite3_busy_timeout(engine, 0)
  let engineBegin = exsqlite3_exec(engine, "BEGIN IMMEDIATE", nil, nil, nil)
  let jsWhileEngine = exExec(js, "BEGIN IMMEDIATE", nil, nil, nil)
  if jsWhileEngine == SQLITE_OK { _ = exExec(js, "ROLLBACK", nil, nil, nil) }
  exsqlite3_exec(engine, "ROLLBACK", nil, nil, nil)
  expect(engineBegin == SQLITE_OK && jsWhileEngine == SQLITE_BUSY,
         "d1: while the engine holds BEGIN IMMEDIATE, JS's BEGIN IMMEDIATE is refused with SQLITE_BUSY (engine rc \(engineBegin), JS rc \(jsWhileEngine))")
  let jsBegin = exExec(js, "BEGIN IMMEDIATE", nil, nil, nil)
  let engineWhileJs = exsqlite3_exec(engine, "BEGIN IMMEDIATE", nil, nil, nil)
  if engineWhileJs == SQLITE_OK { exsqlite3_exec(engine, "ROLLBACK", nil, nil, nil) }
  _ = exExec(js, "ROLLBACK", nil, nil, nil)
  expect(jsBegin == SQLITE_OK && engineWhileJs == SQLITE_BUSY,
         "d2: while JS holds BEGIN IMMEDIATE, the engine's BEGIN IMMEDIATE is refused with SQLITE_BUSY (JS rc \(jsBegin), engine rc \(engineWhileJs))")
  // With the engine's busy timeout back, its write waits for JS's and lands.
  exsqlite3_busy_timeout(engine, BackupManifestHandle.busyTimeoutMs)
  _ = exExec(js, "BEGIN IMMEDIATE; UPDATE backup_assets SET retry_count = 1 WHERE local_asset_id = 'asset-0/L0/001';", nil, nil, nil)
  let release = DispatchWorkItem { _ = exExec(js, "COMMIT", nil, nil, nil) }
  DispatchQueue.global().asyncAfter(deadline: .now() + 0.2, execute: release)
  let started = Date()
  let waited = exsqlite3_exec(engine, "UPDATE backup_assets SET retry_count = 2 WHERE local_asset_id = 'asset-1/L0/001'", nil, nil, nil)
  let ms = Int(Date().timeIntervalSince(started) * 1000)
  release.wait()
  expect(waited == SQLITE_OK && ms >= 150 && ms < Int(BackupManifestHandle.busyTimeoutMs),
         "d3: with the engine's busy timeout, its write waits for JS's transaction and succeeds (rc \(waited) after \(ms) ms)")
  _ = exClose(js)
}

// MARK: - (e) the last connection of one side closing keeps -wal/-shm

do {
  // e1/e2: the engine side's only connection closes while JS's is open (a
  // failed sign-out reset closes the engine's handle; the recovery opens and
  // closes one of its own).
  let dir = root.appendingPathComponent("e-engine-close", isDirectory: true)
  try? fm.removeItem(at: dir)
  try! fm.createDirectory(at: dir, withIntermediateDirectories: true)
  let path = dir.appendingPathComponent("beebeeb-backup.db").path
  var engine: OpaquePointer?
  precondition(exsqlite3_open_v2(path, &engine, BackupManifestHandle.openFlags, nil) == SQLITE_OK && engine != nil)
  exec(engine!, "PRAGMA journal_mode = WAL")
  prepareSchema(engine!)
  exec(engine!, """
  INSERT INTO backup_assets (local_asset_id, content_hash, created_at, asset_type, status)
  VALUES ('e-asset', '', '2026-10-01T00:00:00Z', 'photo', 'uploaded')
  """)
  let (js, rc) = jsOpen(path)
  expect(rc == SQLITE_OK, "e0b: JS opens next to the engine (rc \(rc))")
  _ = exExec(js, "SELECT COUNT(*) FROM backup_assets", nil, nil, nil)
  let closed = BackupManifestStore.closeConnection(engine!)
  expect(closed && fm.fileExists(atPath: path + "-wal") && fm.fileExists(atPath: path + "-shm"),
         "e1: the engine side's last connection closing while JS is open leaves -wal and -shm in place (closed \(closed), wal \(fileSize(path + "-wal")), shm \(fileSize(path + "-shm")))")
  let write = exExec(js, "UPDATE backup_assets SET retry_count = 3 WHERE local_asset_id = 'e-asset'", nil, nil, nil)
  var reader: OpaquePointer?
  let reopened = exsqlite3_open_v2(path, &reader, BackupManifestHandle.openFlags, nil) == SQLITE_OK && reader != nil
  let seen = reopened ? countWhere(reader!, "retry_count = 3") : -1
  if let reader { _ = BackupManifestStore.closeConnection(reader) }
  expect(write == SQLITE_OK && seen == 1,
         "e2: JS's write after that close is seen by the engine's next connection (rc \(write), rows \(seen))")
  _ = exClose(js)

  // e3: the reverse, task 1667's simulator finding: JS closes while the
  // engine's handle is open.
  let dir3 = root.appendingPathComponent("e-js-close", isDirectory: true)
  let (handle, path3) = upgradedEngine(dir3, checkpointFirst: false)
  let (js3, rc3) = jsOpen(path3)
  let jsWrite = exExec(js3, "UPDATE backup_assets SET retry_count = 4 WHERE local_asset_id = 'asset-0/L0/001'", nil, nil, nil)
  let jsClosed = exClose(js3)
  let kept = fm.fileExists(atPath: path3 + "-wal") && fm.fileExists(atPath: path3 + "-shm")
  expect(rc3 == SQLITE_OK && jsWrite == SQLITE_OK && jsClosed == SQLITE_OK && kept
           && countWhere(handle.db!, "retry_count = 4") == 1,
         "e3: JS closing while the engine's handle is open leaves -wal/-shm and the engine reads JS's write (open \(rc3), write \(jsWrite), close \(jsClosed), kept \(kept))")
}

if failures.isEmpty {
  print("manifest-shm-two-copies: \(total) assertions, 0 failed")
  exit(0)
}
for f in failures { print("FAIL: \(f)") }
print("manifest-shm-two-copies: \(failures.count) of \(total) assertions FAILED")
exit(1)
