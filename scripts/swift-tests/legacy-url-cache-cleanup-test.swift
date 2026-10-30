import Foundation
import SQLite3

// Task 1962 round 5 (Bug 6a/6c) — the legacy default `URLCache` store must be
// cleared through an instance with a NON-zero disk capacity. A zero-capacity
// instance never opens the store, so `removeAllCachedResponses()` leaves every
// persisted row behind (measured 5 -> 5 on macOS 26). This harness proves it
// against a real Cache.db at a temp directory, then runs the shipped helper.

var assertions = 0
func check(_ condition: @autoclosure () -> Bool, _ name: String) {
    guard condition() else { print("FAIL: \(name)"); exit(1) }
    assertions += 1
    print("PASS: \(name)")
}

let fm = FileManager.default

func makeTempDir() -> URL {
    let dir = fm.temporaryDirectory.appendingPathComponent("bb-legacy-url-cache-\(UUID().uuidString)")
    try! fm.createDirectory(at: dir, withIntermediateDirectories: true)
    return dir
}

func seed(_ dir: URL, count: Int) {
    let cache = URLCache(memoryCapacity: 0, diskCapacity: 50 * 1024 * 1024, directory: dir)
    for i in 0..<count {
        let url = URL(string: "https://api.example.test/legacy/\(i)")!
        let request = URLRequest(url: url)
        let response = HTTPURLResponse(
            url: url,
            statusCode: 200,
            httpVersion: "HTTP/1.1",
            headerFields: ["Cache-Control": "max-age=3600", "Content-Type": "application/json"]
        )!
        let body = Data("{\"legacy_id\":\(i)}".utf8)
        cache.storeCachedResponse(CachedURLResponse(response: response, data: body), for: request)
    }
}

/// URLCache commits to disk on its own queue; poll briefly so the assertion
/// sees the committed rows (the first cold run can take more than half a second).
func waitForRowCount(_ dir: URL, _ expected: Int) -> Bool {
    let deadline = Date().addingTimeInterval(5)
    while Date() < deadline {
        if rowCount(dir) == expected { return true }
        Thread.sleep(forTimeInterval: 0.1)
    }
    return rowCount(dir) == expected
}

func rowCount(_ dir: URL) -> Int {
    var db: OpaquePointer?
    let path = dir.appendingPathComponent("Cache.db").path
    guard sqlite3_open_v2(path, &db, SQLITE_OPEN_READONLY, nil) == SQLITE_OK else { return -1 }
    defer { sqlite3_close(db) }
    var stmt: OpaquePointer?
    guard sqlite3_prepare_v2(db, "SELECT count(*) FROM cfurl_cache_response;", -1, &stmt, nil) == SQLITE_OK else {
        return -1
    }
    defer { sqlite3_finalize(stmt) }
    guard sqlite3_step(stmt) == SQLITE_ROW else { return -1 }
    return Int(sqlite3_column_int(stmt, 0))
}

let dir = makeTempDir()
seed(dir, count: 5)
check(waitForRowCount(dir, 5), "seed wrote 5 rows to a default-style Cache.db")

// The shipped helper opens the store with a non-zero disk capacity and clears it.
LegacyURLCacheCleanup.clearLegacyDefaultStore(directory: dir)
check(waitForRowCount(dir, 0), "the legacy default store holds 0 rows after the cleanup")

print("legacy-url-cache-cleanup: \(assertions) assertions, 0 failed")
