import Foundation

// Task 1962 round 4 (Bug 7) — adversarial matrix cases 1-3 against the REAL
// shipped `ThumbnailQueueDB` plus `PlaintextStorageProtection.removeItem`
// (the purge's preserving semantics). No simulator, no app process.

var assertions = 0
func check(_ condition: @autoclosure () -> Bool, _ name: String) {
    guard condition() else { print("FAIL: \(name)"); exit(1) }
    assertions += 1
    print("PASS: \(name)")
}

let fm = FileManager.default

func makeTempDir() -> URL {
    let dir = fm.temporaryDirectory.appendingPathComponent("bb-thumbnail-queue-\(UUID().uuidString)")
    try! fm.createDirectory(at: dir, withIntermediateDirectories: true)
    return dir
}

func dbPath(_ dir: URL, _ suffix: String = "") -> URL {
    URL(fileURLWithPath: dir.appendingPathComponent("thumbnail_queue.sqlite").path + suffix)
}

func exists(_ url: URL) -> Bool { fm.fileExists(atPath: url.path) }

/// Raw on-disk bytes of `url` contain `needle`? This is the only assertion
/// that can see a value sitting in a freed SQLite page — `SELECT` cannot.
func rawContains(_ url: URL, _ needle: String) -> Bool {
    guard let data = try? Data(contentsOf: url) else { return false }
    return data.range(of: Data(needle.utf8)) != nil
}

func anyFileContains(_ dir: URL, _ needle: String) -> Bool {
    ["", "-wal", "-shm"].contains { rawContains(dbPath(dir, $0), needle) }
}

/// Task 1962 round 5 (P2.5) — every queue file must be excluded from iCloud
/// backup from the moment it exists, not at the next cold launch's hardenAll().
func isBackupExcluded(_ url: URL) -> Bool {
    (try? url.resourceValues(forKeys: [.isExcludedFromBackupKey]).isExcludedFromBackup) ?? false
}

func allFilesBackupExcluded(_ dir: URL) -> Bool {
    ["", "-wal", "-shm"].allSatisfy { isBackupExcluded(dbPath(dir, $0)) }
}

// MARK: - Case 1 (7b, 7c): forced sign-out resets through the DB, purge preserves the files

let dir1 = makeTempDir()
let db1 = ThumbnailQueueDB(directory: dir1)
check(!exists(dbPath(dir1)), "case1: init() does not open or create the database (7a)")
db1.enqueue(fileIds: ["A-file-1", "A-file-2", "A-file-3"], qualityPreset: "medium")
check(db1.stats().pending == 3, "case1: account A has 3 queued ids")
check(exists(dbPath(dir1)), "case1: first use opens the database lazily")
check(allFilesBackupExcluded(dir1),
      "case1: .sqlite/-wal/-shm are backup-excluded right after the lazy open (P2.5)")

// Forced sign-out: `purgePlaintextStorage` -> cancelAll (pool absent here) ->
// prepareForStoragePurge -> purgeAll(preserving: ThumbnailQueueDB.storagePurgePaths()).
db1.performPrepareForStoragePurge(forceResetFailure: false)
check(db1.stats() == (0, 0, 0, 0, 0), "case1: the queue holds 0 of A's ids after the reset (7c)")
check(!anyFileContains(dir1, "A-file-1"), "case1: raw bytes of .sqlite/-wal/-shm contain none of A's ids (secure_delete + TRUNCATE)")

// Purge stub = the production preserving sweep against this directory.
try? PlaintextStorageProtection.removeItem(at: dir1, preserving: db1.purgePaths)
check(exists(dbPath(dir1)) && exists(dbPath(dir1, "-wal")) && exists(dbPath(dir1, "-shm")),
      "case1: the purge kept .sqlite/-wal/-shm (DB owns their lifecycle, 7b)")
check(!anyFileContains(dir1, "A-file-2"), "case1: raw bytes stay clean after the purge sweep")

// B signs in on the same device.
db1.enqueue(fileIds: ["B-file-1"], qualityPreset: "medium")
let popped = db1.popReady(limit: 10).map { $0.fileId }
check(popped == ["B-file-1"], "case1: only B's id is ready for B")

// MARK: - Case 2 (7d, 7a): a failed reset closes before unlinking and reopens fresh

let dir2 = makeTempDir()
let db2 = ThumbnailQueueDB(directory: dir2)
db2.enqueue(fileIds: ["A-file-4", "A-file-5"], qualityPreset: "medium")
db2.performPrepareForStoragePurge(forceResetFailure: true)
check(!exists(dbPath(dir2)) && !exists(dbPath(dir2, "-wal")) && !exists(dbPath(dir2, "-shm")),
      "case2: reset failure closed the connection and unlinked all three files (7d)")
db2.enqueue(fileIds: ["fresh-after-failure"], qualityPreset: "large")
check(exists(dbPath(dir2)), "case2: next use reopens a fresh database (7a)")
check(allFilesBackupExcluded(dir2),
      "case2: the recreated .sqlite/-wal/-shm are backup-excluded (P2.5)")
check(db2.stats().pending == 1, "case2: the reopened database holds only the new id")
check(!anyFileContains(dir2, "A-file-4") && !anyFileContains(dir2, "A-file-5"),
      "case2: none of A's ids survive the failed-reset path")

// MARK: - Case 3 (7e, 7a): cold signed-out launch with leftovers from an older build

let dir3 = makeTempDir()
try! Data("legacy-A-file-6 sqlite".utf8).write(to: dbPath(dir3))
try! Data("legacy-A-file-7 wal".utf8).write(to: dbPath(dir3, "-wal"))
try! Data("legacy-shm".utf8).write(to: dbPath(dir3, "-shm"))
let db3 = ThumbnailQueueDB(directory: dir3)
check(exists(dbPath(dir3)) && exists(dbPath(dir3, "-wal")) && exists(dbPath(dir3, "-shm")),
      "case3: cold init() opened nothing (leftovers untouched, 7a)")
db3.performPrepareForStoragePurge(forceResetFailure: false)
check(!exists(dbPath(dir3)) && !exists(dbPath(dir3, "-wal")) && !exists(dbPath(dir3, "-shm")),
      "case3: with no connection the purge unlinked all three leftovers (7e)")
check(!anyFileContains(dir3, "legacy-A-file-6"), "case3: no legacy raw bytes remain")

// MARK: - Case 4 (P2.3): a failed unlink is REPORTED, not swallowed into "removed"

let dir4 = makeTempDir()
let db4 = ThumbnailQueueDB(directory: dir4)
db4.enqueue(fileIds: ["A-file-8"], qualityPreset: "medium")
// Round 4 discarded every unlink error through `try?` and still reported the
// reset as removed. Inject an unlink that always fails: the reset must count
// each of the three files as a failure instead of swallowing them.
struct UnlinkBoom: Error {}
db4.removeFile = { _ in throw UnlinkBoom() }
let failures4 = db4.performPrepareForStoragePurge(forceResetFailure: true)
// SQLite itself deletes -wal/-shm when the last connection closes, so only
// the main file reaches our unlink; the point is that its failure is reported.
check(failures4 >= 1, "case4: a failed unlink is reported as a purge failure (P2.3)")

// MARK: - Case 5 (P2.4): old freelist pages force the close-then-unlink path

let dir5 = makeTempDir()
let db5 = ThumbnailQueueDB(directory: dir5)
let bulky = (0..<200).map { "A-bulky-\($0)-\(String(repeating: "x", count: 900))" }
db5.enqueue(fileIds: bulky, qualityPreset: "medium")
db5.clearAll()
// clearAll() leaves the freed pages on the freelist of the main database. A
// successful DELETE+TRUNCATE reset leaves those free pages in the file, so the
// reset must take the close-then-unlink path or the ids' old pages survive (P2.4).
let failures5 = db5.performPrepareForStoragePurge(forceResetFailure: false)
check(failures5 == 0, "case5: the freelist path does not report removal failures")
check(!exists(dbPath(dir5)) && !exists(dbPath(dir5, "-wal")) && !exists(dbPath(dir5, "-shm")),
      "case5: a non-empty freelist takes the close-then-unlink path (P2.4)")
db5.enqueue(fileIds: ["fresh-after-freelist"], qualityPreset: "large")
check(db5.stats().pending == 1, "case5: the reopened database works after the freelist unlink")
check(!anyFileContains(dir5, "A-bulky-0"), "case5: none of the bulky ids survive")

print("thumbnail-queue-purge: \(assertions) assertions, 0 failed")
