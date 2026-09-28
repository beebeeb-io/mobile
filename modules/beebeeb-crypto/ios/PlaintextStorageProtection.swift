import Foundation
import SQLite3

/// Task 0300 / pre-mortem item 12 — the single source of truth for every
/// on-disk location this app writes that iOS would otherwise include in an
/// iCloud or Finder backup.
///
/// iOS backs up `Documents/`, `Library/Application Support/`, and App Group
/// containers by default; it excludes `Library/Caches/`. Before this type
/// existed, `grep -rn 'isExcludedFromBackup'` over the whole mobile repo
/// returned zero matches, so decrypted thumbnails (`ThumbnailService.swift`),
/// decrypted PhotoKit renders (`PhotoKitResolver.swift`), the decrypted-name
/// cache (`src/lib/name-cache.ts`), pre-encryption share staging
/// (`PendingSharesAccess.swift`), and the File Provider extension's decrypted
/// `pinned`/`temp` App Group directories (`targets/file-provider/Constants.swift`
/// — a SEPARATE compiled `.appex` target this same file is also added to,
/// see Task 2) all shipped inside user backups.
///
/// Protection class is `.completeUntilFirstUserAuthentication`, NOT `.complete`:
/// `NativeBackupEngine` uploads from a background URLSession and
/// `PhotoBackupManager` runs on PHKit callbacks, both of which must read these
/// paths while the device is locked.
public enum PlaintextStorageProtection {
  public enum Kind: Sendable {
    case directory
    case file
  }

  public struct Entry {
    public let url: URL
    public let kind: Kind
    /// Short, non-identifying description of what lives here. Used in the audit
    /// report and in `docs/0300-plaintext-lifecycle-audit.md`.
    public let contains: String
    /// Task 1593 round 4 — true for a SQLite database a SECOND process (the
    /// File Provider extension, `targets/file-provider/CacheManager.swift`)
    /// may hold open via its own live connection. `purgeAll()` must not
    /// `removeItem` such a path: unlinking it leaves the extension's already-
    /// open file descriptor (and whatever rows are resident on it) completely
    /// unaffected, so the "purge" would not actually reach the data, and the
    /// extension would go on serving decrypted names from its still-open
    /// handle. Instead its rows are deleted transactionally through a SEPARATE
    /// short-lived connection and the WAL is checkpointed+truncated in place
    /// (same technique as `resetFileProviderCacheDatabase` in
    /// `BeebeebCryptoModule.swift`, which cannot be called from here directly
    /// — that file compiles only into the main app's `BeebeebCrypto` pod,
    /// while this file is ALSO compiled directly into the `BeebeebFileProvider`
    /// extension target, see the header comment above).
    public let resettableInPlace: Bool

    public init(url: URL, kind: Kind, contains: String, resettableInPlace: Bool = false) {
      self.url = url
      self.kind = kind
      self.contains = contains
      self.resettableInPlace = resettableInPlace
    }
  }

  private static let appGroupIdentifier = "group.io.beebeeb.shared"

  private static var documents: URL {
    FileManager.default.urls(for: .documentDirectory, in: .userDomainMask)[0]
  }

  private static var applicationSupport: URL {
    FileManager.default.urls(for: .applicationSupportDirectory, in: .userDomainMask)[0]
  }

  private static var appGroupContainer: URL? {
    FileManager.default.containerURL(forSecurityApplicationGroupIdentifier: appGroupIdentifier)
  }

  public static func registry() -> [Entry] {
    let docs = documents
    let support = applicationSupport
    let bundleId = Bundle.main.bundleIdentifier ?? "io.beebeeb.app"

    var entries: [Entry] = [
      Entry(url: docs.appendingPathComponent("beebeeb-thumbnails-v3", isDirectory: true),
            kind: .directory, contains: "decrypted thumbnail WebP bytes"),
      Entry(url: docs.appendingPathComponent("beebeeb-photokit-cache", isDirectory: true),
            kind: .directory, contains: "decrypted PhotoKit PNG renders"),
      Entry(url: docs.appendingPathComponent("offline", isDirectory: true),
            kind: .directory, contains: "ciphertext offline blobs (size, not confidentiality)"),
      Entry(url: docs.appendingPathComponent("PendingShareUploads", isDirectory: true),
            kind: .directory, contains: "pre-encryption share-sheet staging"),
      Entry(url: docs.appendingPathComponent("SQLite", isDirectory: true),
            kind: .directory, contains: "expo-sqlite databases incl. beebeeb-backup.db"),
      Entry(url: docs.appendingPathComponent("beebeeb-name-cache-v1.json", isDirectory: false),
            kind: .file, contains: "decrypted file names and mime types"),
      Entry(url: docs.appendingPathComponent("beebeeb-file-index-cache-v1.json", isDirectory: false),
            kind: .file, contains: "file index rows (names still ciphertext)"),
      Entry(url: docs.appendingPathComponent("local-id-map.json", isDirectory: false),
            kind: .file, contains: "fileId to PHAsset localIdentifier map"),
      Entry(url: docs.appendingPathComponent("thumbnail_queue.sqlite", isDirectory: false),
            kind: .file, contains: "thumbnail work queue"),
      Entry(url: docs.appendingPathComponent("beebeeb-simulator-master-key.txt", isDirectory: false),
            kind: .file, contains: "raw master key — simulator-only, gated on Device.isDevice"),
      Entry(url: support.appendingPathComponent("NativeBackupStaging", isDirectory: true),
            kind: .directory, contains: "staged .enc backup chunks awaiting upload"),
      Entry(url: support.appendingPathComponent("Beebeeb", isDirectory: true),
            kind: .directory, contains: "PhotoBackupManager backup.db"),
      Entry(url: support.appendingPathComponent(bundleId, isDirectory: true)
              .appendingPathComponent("RCTAsyncLocalStorage_V1", isDirectory: true),
            kind: .directory, contains: "AsyncStorage key-value store"),
    ]

    if let group = appGroupContainer {
      entries.append(Entry(url: group.appendingPathComponent("IncomingShares", isDirectory: true),
                           kind: .directory,
                           contains: "plaintext inbound share payloads from the Share Extension"))
      entries.append(Entry(url: group.appendingPathComponent("widget-data.json", isDirectory: false),
                           kind: .file, contains: "widget storage totals and recent display names"))
      entries.append(Entry(url: group.appendingPathComponent("pinned", isDirectory: true),
                           kind: .directory,
                           contains: "File Provider extension — decrypted pinned file content"))
      entries.append(Entry(url: group.appendingPathComponent("temp", isDirectory: true),
                           kind: .directory,
                           contains: "File Provider extension — decrypted transient fetchContents blobs"))
      // Task 1593 round 4 (security re-review of #141, P1-1) — the File
      // Provider's decrypted-name cache. Written by BOTH processes: the main
      // app's `syncFileProviderCache` (src/lib/file-provider-mount.ts) and the
      // extension's `CacheManager` keep a live connection to the SAME file, so
      // this entry must reset in place rather than unlink (see
      // `resettableInPlace` above). Without a registry entry the full purge
      // (`purgeAll`, run from EVERY sign-out incl. forced ones) never reset
      // it, and only a normal `signOut()`'s `removeFileProviderAccess` did.
      entries.append(Entry(url: group.appendingPathComponent("file-provider-cache.sqlite", isDirectory: false),
                           kind: .file,
                           contains: "File Provider extension — decrypted file names + metadata cache",
                           resettableInPlace: true))
    }

    return entries
  }

  /// Set exclude-from-backup and the file-protection class on one path.
  /// Returns `false` instead of throwing — a protection failure must never
  /// take down a launch, but it must be visible in the trace.
  @discardableResult
  public static func protect(_ url: URL) -> Bool {
    guard FileManager.default.fileExists(atPath: url.path) else { return false }
    var target = url
    var values = URLResourceValues()
    values.isExcludedFromBackup = true
    do {
      try target.setResourceValues(values)
    } catch {
      RuntimeTrace.event("storage.protect.failed", ["path": url.lastPathComponent])
      return false
    }
    do {
      try FileManager.default.setAttributes(
        [.protectionKey: FileProtectionType.completeUntilFirstUserAuthentication],
        ofItemAtPath: url.path
      )
    } catch {
      RuntimeTrace.event("storage.protect.attributes_failed", ["path": url.lastPathComponent])
    }
    return true
  }

  /// Idempotent. Directories are created first so the exclusion is in place
  /// BEFORE the first byte is written; files are skipped when absent (creating
  /// an empty JSON file would break the readers' `info.exists` checks) and are
  /// picked up by the next launch or the next `hardenAll()` from JS.
  @discardableResult
  public static func hardenAll() -> [String: Bool] {
    var results: [String: Bool] = [:]
    for entry in registry() {
      if entry.kind == .directory {
        try? FileManager.default.createDirectory(
          at: entry.url, withIntermediateDirectories: true
        )
      }
      results[entry.url.lastPathComponent] = protect(entry.url)
    }
    return results
  }

  /// Read the resource values back. Paths + booleans only — no user data.
  public static func audit() -> [[String: Any]] {
    registry().map { entry -> [String: Any] in
      let exists = FileManager.default.fileExists(atPath: entry.url.path)
      let excluded = (try? entry.url.resourceValues(forKeys: [.isExcludedFromBackupKey]))?
        .isExcludedFromBackup ?? false
      let attributes = try? FileManager.default.attributesOfItem(atPath: entry.url.path)
      let protection = (attributes?[.protectionKey] as? FileProtectionType)?.rawValue ?? "unset"
      return [
        "name": entry.url.lastPathComponent,
        "kind": entry.kind == .directory ? "directory" : "file",
        "contains": entry.contains,
        "exists": exists,
        "excludedFromBackup": excluded,
        "protection": protection,
      ]
    }
  }

  /// Permanently delete every registered plaintext path. Called on sign-out
  /// (task 1399 follow-up — Codex flagged that the generic `signOut()` left
  /// decrypted thumbnails/names on disk for whoever signs in next on the
  /// same device) and, before that, explicitly from the account-deletion
  /// success path. A zero-knowledge app must not leave one user's decrypted
  /// data recoverable on disk once they have signed out.
  ///
  /// Idempotent and never throws: a path that does not exist counts toward
  /// `removed` (already clean, not a failure), so re-running this after a
  /// partial failure only retries the entries that actually failed last
  /// time. A removal failure is traced (path leaf name only — no user data)
  /// but never aborts the sweep of the remaining entries, and must never
  /// block the caller's sign-out.
  @discardableResult
  public static func purgeAll() -> (removed: Int, failed: Int) {
    var removed = 0
    var failed = 0
    for entry in registry() {
      guard FileManager.default.fileExists(atPath: entry.url.path) else {
        removed += 1 // already absent - counts as clean, not a failure
        continue
      }
      if entry.resettableInPlace {
        if resetSQLiteInPlace(entry.url) {
          removed += 1
        } else {
          RuntimeTrace.event("storage.purge.failed", ["path": entry.url.lastPathComponent])
          failed += 1
        }
        continue
      }
      do {
        try FileManager.default.removeItem(at: entry.url)
        removed += 1
      } catch {
        RuntimeTrace.event("storage.purge.failed", ["path": entry.url.lastPathComponent])
        failed += 1
      }
    }
    return (removed, failed)
  }

  /// Empty every user table of a SQLite database IN PLACE (same inode, same
  /// path) instead of unlinking it, so a second process's already-open
  /// connection to this exact file (the File Provider extension's
  /// `CacheManager`) observes the empty tables on its next read instead of
  /// continuing to serve rows from a file descriptor this purge never
  /// touched. Falls back to deleting the file + its `-wal`/`-shm` siblings
  /// when the database cannot be opened at all (corrupt / not yet created —
  /// there is then no live connection to preserve).
  @discardableResult
  private static func resetSQLiteInPlace(_ url: URL) -> Bool {
    var db: OpaquePointer?
    guard sqlite3_open_v2(
      url.path, &db, SQLITE_OPEN_READWRITE | SQLITE_OPEN_FULLMUTEX, nil
    ) == SQLITE_OK, let db else {
      sqlite3_close(db)
      let fileManager = FileManager.default
      var ok = true
      // Task 1593 round 5 (P2-7) — the `-journal` sibling is the rollback
      // journal this database actually uses (see the comment below: it is
      // never put into WAL mode), so a mid-transaction crash can leave
      // decrypted rows sitting in `<name>-journal` even though the main file
      // was never opened successfully here.
      for suffix in ["", "-wal", "-shm", "-journal"] {
        let sibling = URL(fileURLWithPath: url.path + suffix)
        guard fileManager.fileExists(atPath: sibling.path) else { continue }
        do {
          try fileManager.removeItem(at: sibling)
        } catch {
          ok = false
        }
      }
      return ok
    }
    defer { sqlite3_close(db) }

    // A second process (the File Provider extension's `CacheManager`) may
    // hold this exact file open; without a timeout a lock held for the
    // couple hundred ms a concurrent read/write typically needs fails this
    // reset immediately with SQLITE_BUSY instead of waiting for it.
    sqlite3_busy_timeout(db, 2000)

    // Discover the user tables rather than hardcoding schema here: this file
    // is compiled into two SEPARATE targets (the main app pod and the
    // BeebeebFileProvider extension) and must not drift from whichever one
    // last changed the schema in BeebeebCryptoModule.swift / CacheManager.swift.
    var tables: [String] = []
    var stmt: OpaquePointer?
    // Task 1593 round 5 (P1-2) — a failed prepare here used to fall through
    // silently (`tables` stayed empty, the function returned `true` anyway,
    // so `purgeAll()` counted a no-op reset as a success). Fail loudly
    // instead: the caller traces `storage.purge.failed` and retries next time.
    guard sqlite3_prepare_v2(
      db, "SELECT name FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%'", -1, &stmt, nil
    ) == SQLITE_OK else {
      sqlite3_finalize(stmt)
      return false
    }
    while sqlite3_step(stmt) == SQLITE_ROW {
      if let cName = sqlite3_column_text(stmt, 0) {
        tables.append(String(cString: cName))
      }
    }
    sqlite3_finalize(stmt)

    // Task 1593 round 5 (P1-1) — a plain `DELETE` only unlinks a row from the
    // b-tree; the page it lived on goes onto the freelist with the decrypted
    // bytes (e.g. `name_decrypted`) still physically present and readable
    // with a raw byte scan of the file (reproduced on macOS system SQLite:
    // 500 known marker names inserted, reset with the OLD sequence below,
    // `strings db | grep -c MARKER` = 500; with `secure_delete = ON` set
    // before the transaction, = 0 — evidence: _qa-evidence/1593/r5-sqlite-bytes.txt).
    // `secure_delete = ON` makes every DELETE overwrite the row's bytes with
    // zeros as it deletes them, and must be set BEFORE the transaction that
    // does the deleting.
    var ok = sqlite3_exec(db, "PRAGMA secure_delete = ON", nil, nil, nil) == SQLITE_OK
    ok = ok && sqlite3_exec(db, "BEGIN", nil, nil, nil) == SQLITE_OK
    for table in tables {
      ok = ok && sqlite3_exec(db, "DELETE FROM \"\(table)\"", nil, nil, nil) == SQLITE_OK
    }
    if ok {
      ok = sqlite3_exec(db, "COMMIT", nil, nil, nil) == SQLITE_OK
    } else {
      sqlite3_exec(db, "ROLLBACK", nil, nil, nil)
    }
    // This database is never put into WAL mode anywhere in this codebase
    // (`grep -rn "journal_mode" modules/ targets/ src/` finds it set only for
    // NativeBackupEngine's, ThumbnailQueueDB's and BackupDatabase's own
    // separate databases) — it always uses the default rollback journal. The
    // `PRAGMA wal_checkpoint(TRUNCATE)` this comment used to describe as
    // "truncating the WAL" was therefore a silent no-op on this file. VACUUM
    // is the step that actually rewrites the database, dropping freelist
    // pages entirely instead of leaving them marked free for reuse (defense
    // in depth on top of `secure_delete`, e.g. for pages freed by earlier
    // writes from before this fix shipped).
    //
    // Task 1593 round 6 (new-3) — VACUUM needs the file exclusively; the
    // File Provider extension's own live connection to this same path
    // (`targets/file-provider/CacheManager.swift`) can transiently hold it
    // just long enough for a single short read to return `SQLITE_BUSY` even
    // with `sqlite3_busy_timeout` set above (VACUUM does its own internal
    // locking rather than honouring that timeout on retry). One retry after
    // a short fixed wait is enough for that transient case; a still-BUSY
    // second attempt is a real failure, not silently swallowed.
    ok = ok && vacuumRetryingOnceOnBusy(db)
    return ok
  }

  /// See the `new-3` doc comment on the `VACUUM` call site above. Shared
  /// shape with `BeebeebCryptoModule.swift`'s identical helper for
  /// `resetFileProviderCacheDatabase` — kept as two small private copies
  /// rather than one shared symbol because this file, unlike that one,
  /// compiles into both the main app pod and the File Provider `.appex`
  /// target (see this file's header comment), and a cross-file shared
  /// helper would need to live somewhere both targets already import.
  private static func vacuumRetryingOnceOnBusy(_ db: OpaquePointer?) -> Bool {
    if sqlite3_exec(db, "VACUUM", nil, nil, nil) == SQLITE_OK {
      return true
    }
    guard sqlite3_errcode(db) == SQLITE_BUSY else {
      return false
    }
    usleep(50_000) // 50ms
    return sqlite3_exec(db, "VACUUM", nil, nil, nil) == SQLITE_OK
  }

  /// Write the audit to `Library/Caches/beebeeb-plaintext-audit.json` so the
  /// simulator verification script can read it off the app container. `Caches`
  /// is itself excluded from backup by iOS.
  @discardableResult
  public static func writeAuditReport() -> String? {
    guard let caches = FileManager.default.urls(for: .cachesDirectory, in: .userDomainMask).first
    else { return nil }
    let url = caches.appendingPathComponent("beebeeb-plaintext-audit.json")
    guard let data = try? JSONSerialization.data(
      withJSONObject: audit(), options: [.prettyPrinted, .sortedKeys]
    ) else { return nil }
    guard (try? data.write(to: url, options: .atomic)) != nil else { return nil }
    return url.path
  }
}
