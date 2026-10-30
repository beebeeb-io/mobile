import Foundation

/// Task 1962 round 5 (Bug 6a/6c) — the one shared HTTP-cache hardening helper.
///
/// The app and both extensions used to carry three copies of this code, each
/// clearing the legacy `URLCache` store through an instance created with
/// `diskCapacity: 0`. A zero-capacity instance never opens the store, so
/// `removeAllCachedResponses()` on it is a no-op: responses written by older
/// builds stayed in the default `Library/Caches/Cache.db` (measured 5 rows ->
/// 5 rows on macOS 26; the same call through a 50 MB instance -> 0 rows).
///
/// Two responsibilities, kept deliberately separate:
/// - the launch path's single main-thread statement: install a zero-capacity
///   shared cache rooted at an explicit per-caller directory, so nothing new
///   is ever written to the default store;
/// - the off-main sweep: open the legacy *default* store with a non-zero disk
///   capacity (`directory: nil`) and remove every response from it.
enum LegacyURLCacheCleanup {
    /// Non-zero on purpose: this is what makes `URLCache` open the store so
    /// `removeAllCachedResponses()` can actually delete its rows.
    static let legacyDiskCapacity = 50 * 1024 * 1024

    /// A `URLCache` that stores nothing in memory or on disk, rooted at an
    /// explicit per-caller directory under `Caches/` (never the shared default
    /// directory, and never created on the caller's thread: with a zero disk
    /// capacity there is nothing to write). Callers assign this to
    /// `URLCache.shared` on the main thread; it is the only main-thread work.
    static func zeroCapacityURLCache(directoryName: String) -> URLCache {
        let cachesDirectory = FileManager.default.urls(for: .cachesDirectory, in: .userDomainMask).first
        let directory = cachesDirectory?.appendingPathComponent(directoryName, isDirectory: true)
        return URLCache(memoryCapacity: 0, diskCapacity: 0, directory: directory)
    }

    /// Synchronous sweep of the legacy default store. `directory` is `nil` in
    /// production (the default store); the harness passes a temp directory.
    /// Never call this on the main thread — use `clearLegacyDefaultStoreOffMainThread`.
    static func clearLegacyDefaultStore(directory: URL? = nil) {
        let legacy = URLCache(
            memoryCapacity: 0,
            diskCapacity: legacyDiskCapacity,
            directory: directory
        )
        legacy.removeAllCachedResponses()
    }

    /// The launch/extension entry point: one hop off the main thread (task 1669
    /// launch-watchdog lesson), then clear the legacy default store.
    static func clearLegacyDefaultStoreOffMainThread() {
        DispatchQueue.global(qos: .utility).async {
            clearLegacyDefaultStore()
        }
    }
}
