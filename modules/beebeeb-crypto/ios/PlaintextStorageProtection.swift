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

    /// Task 1593 round 11 (Codex thread PRRT_kwDOSLX6T86miVoV) — true for a
    /// directory whose sole registry purpose is to carry file-protection-
    /// class + backup-exclusion INHERITANCE for a separately-registered
    /// `resettableInPlace` child living inside it (see the `file-provider-db`
    /// entry pair in `registry()`). `purgeAll()` must never `removeItem` it
    /// directly: unlinking the directory unlinks the child file's directory
    /// entry right along with it, defeating the exact protection
    /// `resettableInPlace` exists to give that child (a second process's
    /// already-open connection to it going untouched by the purge).
    /// `hardenAll()`'s existing generic directory branch (create + protect)
    /// already does the one thing this kind of entry needs, unchanged.
    public let containerOnly: Bool

    public init(
      url: URL, kind: Kind, contains: String, resettableInPlace: Bool = false, containerOnly: Bool = false
    ) {
      self.url = url
      self.kind = kind
      self.contains = contains
      self.resettableInPlace = resettableInPlace
      self.containerOnly = containerOnly
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
      //
      // Task 1593 round 11 (Codex thread PRRT_kwDOSLX6T86miVoV, P2) — rounds
      // 4-10 protected only the `.sqlite` file itself (plus, from round 10,
      // an explicit `protectSQLiteSidecars` call at each of the few moments
      // this code happens to run). That missed almost every real case: the
      // `-journal` rollback-journal sidecar this database actually uses
      // (never WAL — see `resetSQLiteInPlace`'s doc comment) is created and
      // deleted around every single transaction, so it is absent at both of
      // `protectSQLiteSidecars`'s call times (DB-open, launch's
      // `hardenAll()`) and unprotected for the whole lifetime of every OTHER
      // transaction — a crash mid-transaction at any of those moments leaves
      // a hot, unprotected, backup-eligible journal with decrypted bytes in
      // it. The fix here is structural instead of timing-dependent: the
      // database now lives inside its OWN directory (`file-provider-db`,
      // below), and iOS INHERITS both properties from the enclosing
      // directory for files newly created inside it — file protection class
      // (Apple's File System Programming Guide, "Encrypting Your App's
      // Files": "a file or directory's protection class is normally
      // inherited from its parent directory") and backup exclusion (the
      // backup daemon never descends into a directory marked excluded, so
      // nothing created inside one afterward is ever visited, regardless of
      // that new file's own attributes — the documented reason marking a
      // DIRECTORY excluded also excludes everything under it). Protecting
      // the directory once, at the moment it is created
      // (`migrateFileProviderCacheDatabaseIfNeeded`'s callers,
      // `AppGroupContainer.cacheDatabaseDirectory` /
      // `fileProviderCacheDatabaseDirectory()`), means every sidecar SQLite
      // ever creates inside it — at ANY point in its lifetime, not just the
      // moments this code happens to check — is already protected the
      // instant it exists. `protectSQLiteSidecars` (round 10) is kept as
      // cheap belt-and-suspenders on the file itself; it is no longer load-
      // bearing.
      let cacheDbDir = group.appendingPathComponent("file-provider-db", isDirectory: true)
      entries.append(Entry(
        url: cacheDbDir,
        kind: .directory,
        contains: "container directory for the File Provider decrypted-name cache DB — "
          + "protected so its SQLite sidecars inherit protection at creation time",
        containerOnly: true
      ))
      entries.append(Entry(
        url: cacheDbDir.appendingPathComponent("file-provider-cache.sqlite", isDirectory: false),
        kind: .file,
        contains: "File Provider extension — decrypted file names + metadata cache",
        resettableInPlace: true
      ))
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
      if entry.resettableInPlace {
        for (name, ok) in protectSQLiteSidecars(entry.url) {
          results[name] = ok
        }
      }
    }
    return results
  }

  /// Task 1593 round 10 (Codex thread PRRT_kwDOSLX6T86mhUiZ, P2) — SQLite's
  /// default rollback journal (this database is never WAL-mode — see
  /// `resetSQLiteInPlace`'s doc comment) can hold a copy of a page's
  /// PRE-modification bytes, including decrypted names, for the duration of
  /// a transaction. That `-journal` sibling (and, if this database is ever
  /// put into WAL mode in the future, `-wal`/`-shm`) is a SEPARATE inode
  /// from the main `.sqlite` file with its own, independently-tracked
  /// backup-exclusion attribute and protection class — `protect()`-ing the
  /// main file does nothing for it.
  ///
  /// A sidecar does not exist most of the time (SQLite creates `-journal` at
  /// `BEGIN` and deletes it at `COMMIT`/`ROLLBACK`), so it cannot be
  /// hardened once-and-for-all at DB-creation time the way the main file is
  /// — `protect()` itself already no-ops safely (returns `false`, no throw)
  /// for a sibling that does not currently exist at the moment this runs.
  /// The window that matters in practice is an ABNORMAL TERMINATION (a
  /// crash or jetsam mid-write) that leaves a "hot" journal sitting on disk,
  /// unprotected, until SQLite's next successful open recovers it — a
  /// backup that runs in that window (e.g. overnight, before the user next
  /// opens the app) would capture it unprotected. Calling this everywhere
  /// `protect()` is called on the main `file-provider-cache.sqlite` path
  /// (every creation site AND launch's `hardenAll()` above) means a hot
  /// journal left over from a previous session gets hardened the moment
  /// this file is next touched by either process. Scoped to
  /// `resettableInPlace` entries — currently only this one — because that
  /// flag already marks exactly the class of database this concern applies
  /// to: a live, second-process SQLite connection whose sidecars can carry
  /// plaintext.
  @discardableResult
  public static func protectSQLiteSidecars(_ databaseUrl: URL) -> [String: Bool] {
    var results: [String: Bool] = [:]
    for suffix in ["-journal", "-wal", "-shm"] {
      let sibling = URL(fileURLWithPath: databaseUrl.path + suffix)
      results[sibling.lastPathComponent] = protect(sibling)
    }
    return results
  }

  /// Task 1593 round 11 (Codex thread PRRT_kwDOSLX6T86miVoV) — relocates the
  /// File Provider cache database (and any `-journal`/`-wal`/`-shm`
  /// sidecars present) from a pre-round-11 install's top-level App Group
  /// path into its new, dedicated, protected directory. Called from both
  /// processes' path resolvers (`AppGroupContainer.cacheDatabaseUrl` in
  /// Constants.swift, `fileProviderCacheDatabaseUrl()` in
  /// BeebeebCryptoModule.swift) every time either one resolves the DB path,
  /// so it is always applied before the first open on whichever process
  /// gets there first after this code ships.
  ///
  /// `FileManager.moveItem` performs a real `rename(2)` between two paths on
  /// the SAME volume (both inside this one App Group container), which
  /// preserves the file's inode: a file descriptor a second process already
  /// has open against the OLD path (the extension's long-lived
  /// `CacheManager` connection) keeps working exactly as it did before the
  /// rename — nothing about an already-open connection needs to "notice" a
  /// path change mid-session. The only thing that must resolve the NEW path
  /// is the next FRESH `sqlite3_open_v2` call, on either side, and since the
  /// main app and this extension ship and update as one atomic app bundle,
  /// there is no version skew window where an old-code process could still
  /// be resolving the legacy path after this migration code is what is
  /// running.
  ///
  /// Idempotent and race-safe for two processes calling this around the
  /// same moment, AND for a process that was killed (jetsam, a crash)
  /// partway through a previous attempt: the cheap "nothing to do" fast
  /// path checks ALL FOUR legacy suffixes, not just the main file — an
  /// interrupted prior run that moved the main file but was killed before
  /// reaching `-journal` must not let that orphaned sidecar go unnoticed
  /// forever just because the main file's own presence at `to` looked like
  /// "already fully migrated." Each suffix is then handled independently:
  /// a legacy sibling whose destination ALREADY exists (an earlier attempt,
  /// possibly from a different process, already moved that one) is deleted
  /// rather than moved — the destination is the one now-protected copy, and
  /// leaving a leftover unprotected duplicate at the old path behind would
  /// recreate the exact leak this migration exists to close. A legacy
  /// source that has vanished by the time this actually checks it means the
  /// other process already won the race for THAT suffix — not a failure,
  /// since the desired end state (something now at `to` + that suffix)
  /// already holds.
  ///
  /// A move that fails for a real reason falls back to DELETING the legacy
  /// sibling rather than leaving it in place: this database is a rebuildable
  /// cache (the source of truth is the encrypted core + the server), so
  /// losing it costs one slower re-sync, whereas leaving decrypted names
  /// sitting unprotected at an old, un-registered path forever is the exact
  /// class of leak this task exists to close.
  @discardableResult
  public static func migrateFileProviderCacheDatabaseIfNeeded(from legacyUrl: URL, to newUrl: URL) -> URL {
    let fileManager = FileManager.default
    let suffixes = ["", "-journal", "-wal", "-shm"]
    let legacyHasAnySibling = suffixes.contains { fileManager.fileExists(atPath: legacyUrl.path + $0) }
    guard legacyHasAnySibling else { return newUrl }

    for suffix in suffixes {
      let source = URL(fileURLWithPath: legacyUrl.path + suffix)
      let destination = URL(fileURLWithPath: newUrl.path + suffix)
      guard fileManager.fileExists(atPath: source.path) else { continue }
      guard !fileManager.fileExists(atPath: destination.path) else {
        // Already migrated by an earlier, partially-completed attempt — the
        // destination is the real, protected copy; the stale legacy
        // duplicate must not be left sitting there unprotected.
        try? fileManager.removeItem(at: source)
        continue
      }
      do {
        try fileManager.moveItem(at: source, to: destination)
      } catch {
        // Task 1593 round 12 (Codex thread PRRT_kwDOSLX6T86mi6px, P2) — the
        // fallback deletion below used to be a bare `try?`: if it ALSO
        // failed (the move already failed for a real reason — permissions,
        // a full disk — so the delete can plausibly fail too), this
        // function fell straight through to `protect(newUrl)` / `return
        // newUrl` as if nothing were wrong, with the legacy, decrypted-name
        // copy still sitting at the OLD, un-registered, unprotected path.
        // Checking the result here still can't make THIS call's return
        // value reflect the failure (every caller is a path resolver that
        // needs a URL back regardless, to actually open a database), so the
        // authoritative fix is `purgeAll()`'s own `sweepLegacyFileProviderCache()`
        // (below) checking this exact on-disk path directly, every purge —
        // that is what makes a later purge still find and clear a leftover
        // this call couldn't. What DOES belong here is not pretending the
        // fallback succeeded: trace the SAME `storage.purge.failed` event
        // `purgeAll()` itself uses (not just the narrower, easy-to-miss
        // `storage.migrate.file_provider_cache_failed`) so this failure is
        // visible in the same place every other purge failure is, the
        // moment it actually happens — not only retroactively, the next
        // time a purge's own sweep happens to run.
        do {
          try fileManager.removeItem(at: source)
        } catch {
          RuntimeTrace.event("storage.purge.failed", [
            "path": source.lastPathComponent,
          ])
        }
        RuntimeTrace.event("storage.migrate.file_provider_cache_failed", [
          "suffix": suffix.isEmpty ? "main" : suffix,
        ])
      }
    }
    protect(newUrl)
    protectSQLiteSidecars(newUrl)
    return newUrl
  }

  /// Task 1593 round 12 (Codex thread PRRT_kwDOSLX6T86mi6px, P2) — companion
  /// to `migrateFileProviderCacheDatabaseIfNeeded` above. That function is
  /// only ever invoked LAZILY, from the two path resolvers
  /// (`AppGroupContainer.cacheDatabaseUrl` / `fileProviderCacheDatabaseUrl()`),
  /// whenever either process next opens the database — never from `purgeAll()`.
  /// If a migration attempt there fails to fully clean up (both the move
  /// AND the fallback delete fail for a suffix), the legacy copy keeps
  /// sitting at the OLD, un-registered path forever: `registry()` only ever
  /// lists the NEW `file-provider-db/` location, so an ordinary `purgeAll()`
  /// sweep would never even look for the legacy one, let alone report the
  /// failure — `bumpFileProviderCacheVersion()` and the NEW registry entry's
  /// reset both treat "the new database is clean" as the whole story, while
  /// decrypted names from a previous account sit untouched at the old path.
  ///
  /// Checked directly against the App Group container (never through an
  /// in-memory flag the migration function might set): the migration and
  /// this sweep can run in DIFFERENT processes (the extension's
  /// `CacheManager.init()` vs. the main app's `purgePlaintextStorage`), so
  /// only a fresh, on-disk check — the filesystem being the one thing both
  /// processes actually share — is reliable. Called from every `purgeAll()`
  /// invocation, so a failed migration attempt gets a fresh retry on every
  /// sign-out, and a real, persistent failure counts against THIS purge's
  /// own `(removed, failed)` total instead of silently vanishing.
  private static func sweepLegacyFileProviderCache() -> (removed: Int, failed: Int) {
    guard let group = appGroupContainer else { return (0, 0) }
    let legacyUrl = group.appendingPathComponent("file-provider-cache.sqlite", isDirectory: false)
    let fileManager = FileManager.default
    var removed = 0
    var failed = 0
    for suffix in ["", "-journal", "-wal", "-shm"] {
      let sibling = URL(fileURLWithPath: legacyUrl.path + suffix)
      guard fileManager.fileExists(atPath: sibling.path) else {
        removed += 1 // already absent - counts as clean, not a failure
        continue
      }
      do {
        try fileManager.removeItem(at: sibling)
        removed += 1
      } catch {
        RuntimeTrace.event("storage.purge.failed", ["path": sibling.lastPathComponent])
        failed += 1
      }
    }
    return (removed, failed)
  }

  // MARK: - Fail-closed purge-pending marker

  private static let purgePendingMarkerName = "purge-pending"

  private static var fileProviderCacheDbDirectory: URL? {
    appGroupContainer?.appendingPathComponent("file-provider-db", isDirectory: true)
  }

  /// Task 1593 f1 (follow-up to #144; security reviewer P2, downgraded from
  /// P1 because it needs THREE failed epoch advances in one purge PLUS an
  /// in-flight extension fetch racing exactly the right window to leak a
  /// name — see `resweepFileProviderContentDirectories`'s doc comment for
  /// round 12's narrower, probabilistic mitigation of the same gap) —
  /// `bumpFileProviderCacheVersion()` (the early bump in
  /// `purgePlaintextStorage`, BeebeebCryptoModule.swift) and this file's own
  /// `resetSQLiteInPlace` (the purge's LAST, atomic epoch-bump-plus-reset
  /// step) can each fail to durably advance `PRAGMA user_version` — a
  /// corrupt DB, a lock the busy timeout couldn't clear, a disk-full COMMIT.
  /// When that happens there is no proof the epoch a concurrent extension
  /// write already captured has been invalidated, so `CacheManager`'s epoch
  /// check alone is only PROBABILISTICALLY safe. This marker turns that
  /// uncertainty into a hard, fail-CLOSED refusal instead of a fail-open
  /// gap: a PLAIN FILE (deliberately no SQLite — its own creation cannot
  /// fail the same correlated way a DB write under contention can) at
  /// `file-provider-db/purge-pending`, inside the SAME directory the cache
  /// DB itself lives in (the `containerOnly` registry entry above already
  /// protects that directory on the DB's own creation path; `markPurgePending`
  /// below still calls `protect()` on both directly, rather than assuming
  /// that already ran, since a fresh install racing its very first purge
  /// before the directory has ever been touched must not leave the marker
  /// itself unprotected).
  ///
  /// While the marker exists, `CacheManager.beginImmediate()` /
  /// `purgeEpochUnchanged(since:)` (targets/file-provider/CacheManager.swift)
  /// refuse EVERY extension write outright — epoch match or not — which
  /// transitively covers every writer that goes through them:
  /// `replaceChildren`, `upsert(_:expectedEpoch:)`, `delete(id:expectedEpoch:)`,
  /// and `FileProviderExtension.fetchContents`'s temp/pinned writes.
  ///
  /// Cleared only after a LATER epoch advance actually succeeds — never
  /// optimistically, and never merely because the failure that set it has
  /// passed. `bumpFileProviderCacheVersion()` clears it on its own success
  /// (the next purge's early bump, OR — its other call site, added
  /// alongside this marker — `ensureFileProviderCacheDatabase()` at File
  /// Provider domain REGISTRATION time); `resetSQLiteInPlace` below clears
  /// it on its own success too (the next purge's final reset). Any one
  /// successful, durable bump is sufficient: it is, by construction, a
  /// version strictly newer than anything an extension write could have
  /// captured before that bump's own transaction committed.
  @discardableResult
  public static func markPurgePending() -> Bool {
    guard let dir = fileProviderCacheDbDirectory else { return false }
    try? FileManager.default.createDirectory(at: dir, withIntermediateDirectories: true)
    protect(dir)
    let url = dir.appendingPathComponent(purgePendingMarkerName, isDirectory: false)
    if !FileManager.default.fileExists(atPath: url.path) {
      guard FileManager.default.createFile(atPath: url.path, contents: Data()) else {
        RuntimeTrace.event("storage.purge.pending_marker_failed", [:])
        return false
      }
    }
    protect(url)
    RuntimeTrace.event("storage.purge.pending_marked", [:])
    return true
  }

  /// See `markPurgePending()`'s doc comment for the full rationale and the
  /// two call sites that clear this (`bumpFileProviderCacheVersion()` and
  /// `resetSQLiteInPlace` below, both only on their OWN success).
  public static func clearPurgePending() {
    guard let dir = fileProviderCacheDbDirectory else { return }
    let url = dir.appendingPathComponent(purgePendingMarkerName, isDirectory: false)
    guard FileManager.default.fileExists(atPath: url.path) else { return }
    do {
      try FileManager.default.removeItem(at: url)
      RuntimeTrace.event("storage.purge.pending_cleared", [:])
    } catch {
      // Left in place deliberately — see `markPurgePending()`'s doc comment:
      // failing CLOSED (the marker survives) is the safe direction here. The
      // next successful bump retries this same removal.
      RuntimeTrace.event("storage.purge.pending_clear_failed", [:])
    }
  }

  /// `CacheManager.beginImmediate()` / `purgeEpochUnchanged(since:)` call
  /// this directly — this file compiles into the extension target too (see
  /// the header comment). A missing App Group container reads as "not
  /// pending": every write already fails for the unrelated, unrecoverable
  /// reason of having no container to write into, so this check cannot make
  /// that state any MORE closed than it already is.
  public static func isPurgePending() -> Bool {
    guard let dir = fileProviderCacheDbDirectory else { return false }
    return FileManager.default.fileExists(
      atPath: dir.appendingPathComponent(purgePendingMarkerName, isDirectory: false).path
    )
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
      // Task 1593 round 11 — see `containerOnly`'s doc comment: this entry
      // exists purely to protect its child via directory-level inheritance;
      // deleting the directory itself would unlink that child's own
      // directory entry, defeating `resettableInPlace` for it.
      if entry.containerOnly {
        continue
      }
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
    // Task 1593 round 12 (Codex thread PRRT_kwDOSLX6T86mi6px, P2) — see
    // `sweepLegacyFileProviderCache()`'s doc comment: `registry()` above
    // only ever lists the NEW `file-provider-db/` location, so without this
    // a legacy copy left behind by a failed migration attempt would never
    // be visited by a purge at all, let alone counted or retried.
    let legacy = sweepLegacyFileProviderCache()
    removed += legacy.removed
    failed += legacy.failed
    // Task 1593 round 12 (Codex thread PRRT_kwDOSLX6T86mjO56, P1) — see
    // `resweepFileProviderContentDirectories()`'s doc comment. Must run
    // LAST, after everything above (the `pinned`/`temp` deletion earlier in
    // this same loop, the SQL reset's own final epoch bump, and the legacy
    // sweep) — a resweep placed anywhere else could not close the exact
    // "written after pinned/temp were cleared but before the final reset"
    // window this exists for.
    let resweep = resweepFileProviderContentDirectories()
    removed += resweep.removed
    failed += resweep.failed
    return (removed, failed)
  }

  /// Task 1593 round 12 (Codex thread PRRT_kwDOSLX6T86mjO56, P1, fresh
  /// evidence beyond round 11's `fetchContents` thread) —
  /// `bumpFileProviderCacheVersion()` (BeebeebCryptoModule.swift, called
  /// BEFORE this purge even starts, specifically to invalidate any epoch an
  /// in-flight extension fetch may already have captured) can fail open,
  /// lock, or commit. Even when it succeeds, `registry()`'s own iteration
  /// order processes `pinned`/`temp` — both lazily RECREATED on next access
  /// (`AppGroupContainer.pinnedContentDirectory`/`temporaryContentDirectory`
  /// in Constants.swift each do `createDirectory` before returning) — well
  /// BEFORE it reaches the `file-provider-cache.sqlite` reset that performs
  /// the purge's OWN final epoch bump. An extension write racing exactly
  /// that gap can still pass its epoch check (the version has not moved
  /// yet from its point of view), recreate the just-deleted directory, and
  /// land a decrypted file that nothing downstream ever revisits — the
  /// purge finishes believing `pinned`/`temp` are clean because they WERE,
  /// briefly, at the moment this function looked.
  ///
  /// Rather than trying to make that race window provably zero (which would
  /// need blocking every extension write on this purge's own completion —
  /// the same class of cross-process, cooperative-pool-risking
  /// synchronization round 7b's new-P2 explicitly declined to build without
  /// simulator-driving rights to validate it does not itself introduce a
  /// hang), this re-deletes `pinned`/`temp` ONE MORE TIME after EVERYTHING
  /// else in `purgeAll()` — the registry() loop's own directory deletions,
  /// the SQL reset's own final epoch bump, and the legacy sweep — has
  /// already run. Anything that slipped through during this purge, whether
  /// it raced the early bump, the domain removal, or `registry()`'s own
  /// ordering, cannot survive a resweep that runs strictly after all of it.
  /// Unconditional: this does not depend on `bumpFileProviderCacheVersion()`
  /// having succeeded, so it closes the leak even when that bump failed.
  private static func resweepFileProviderContentDirectories() -> (removed: Int, failed: Int) {
    guard let group = appGroupContainer else { return (0, 0) }
    var removed = 0
    var failed = 0
    for name in ["pinned", "temp"] {
      let dir = group.appendingPathComponent(name, isDirectory: true)
      guard FileManager.default.fileExists(atPath: dir.path) else {
        removed += 1 // already absent - counts as clean, not a failure
        continue
      }
      do {
        try FileManager.default.removeItem(at: dir)
        removed += 1
      } catch {
        RuntimeTrace.event("storage.purge.failed", ["path": dir.lastPathComponent])
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
      // Task 1593 f1 — can't enumerate tables, so no bump either.
      markPurgePending()
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
    // Task 1593 round 8 (R2, security re-review) — this is "the purge's
    // reset transaction" for the one `resettableInPlace` entry that carries
    // a cross-process purge epoch (the File Provider cache DB —
    // `BeebeebCryptoModule.swift`'s `bumpFileProviderCacheVersion`'s doc
    // comment has the full rationale for why the epoch lives in this file's
    // own `PRAGMA user_version` rather than App Group UserDefaults).
    // Bumping it HERE too, inside the same BEGIN/COMMIT that empties every
    // table, is belt-and-suspenders with that earlier bump: this is the
    // LAST step of every purge, so anything that slipped past the earlier
    // bump (a write already mid-transaction when that ran) is still caught
    // — the version this reset ends on is guaranteed newer than anything
    // any writer could have captured before this transaction committed.
    var nextVersion: Int32 = 1
    var versionStmt: OpaquePointer?
    if sqlite3_prepare_v2(db, "PRAGMA user_version", -1, &versionStmt, nil) == SQLITE_OK,
       sqlite3_step(versionStmt) == SQLITE_ROW {
      nextVersion = sqlite3_column_int(versionStmt, 0) &+ 1
    }
    sqlite3_finalize(versionStmt)

    var ok = sqlite3_exec(db, "PRAGMA secure_delete = ON", nil, nil, nil) == SQLITE_OK
    ok = ok && sqlite3_exec(db, "BEGIN", nil, nil, nil) == SQLITE_OK
    for table in tables {
      ok = ok && sqlite3_exec(db, "DELETE FROM \"\(table)\"", nil, nil, nil) == SQLITE_OK
    }
    ok = ok && sqlite3_exec(db, "PRAGMA user_version = \(nextVersion)", nil, nil, nil) == SQLITE_OK
    if ok {
      ok = sqlite3_exec(db, "COMMIT", nil, nil, nil) == SQLITE_OK
    } else {
      sqlite3_exec(db, "ROLLBACK", nil, nil, nil)
    }
    // Task 1593 f1 — `ok` at THIS exact point reflects whether the epoch
    // bump itself durably committed (everything above, through COMMIT).
    // VACUUM below is a freelist-hygiene step that runs AFTER commit and
    // must not itself flip the fail-closed marker: a VACUUM that fails on
    // an already-committed bump has not left a stale epoch readable
    // anywhere, so marking pending for it would refuse every extension
    // write for a purely cosmetic reason. Captured here, before VACUUM can
    // touch `ok`. See `markPurgePending()`'s doc comment for the full
    // rationale.
    let bumpCommitted = ok
    if bumpCommitted {
      clearPurgePending()
    } else {
      markPurgePending()
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
    //
    // Task 1593 round 8 (R2) — VACUUM rewrites table b-tree pages, not the
    // database header's `application_id`/`user_version` fields, so the
    // `PRAGMA user_version` bump above survives it; verified directly (not
    // just asserted) at _qa-evidence/1593/r8-epoch-proof.txt — the same
    // sqlite3 CLI session that proves the BEGIN IMMEDIATE refusal also runs
    // this exact BEGIN→DELETE→user_version-bump→COMMIT→VACUUM sequence and
    // reads `PRAGMA user_version` back as the bumped value afterward.
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
