import Darwin
import Foundation
import SQLite3
import Security

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

  /// Task 1593 f2 (lead design decision: MARKER FIRST — supersedes f1's
  /// mark-only-after-a-failed-bump design below). f1 only marked pending
  /// AFTER an epoch advance had already failed — the window BEFORE that
  /// (consent reset, the early bump attempt, the domain removal, opening
  /// the DB at all) was unmarked, so an extension write racing any of THOSE
  /// steps was never refused, only ever caught (probabilistically, per
  /// round 12's `resweepFileProviderContentDirectories` doc comment) by a
  /// resweep after the fact. Marking unconditionally, at the very START of
  /// every purge — before this file's own `Entry.resettableInPlace` reset
  /// even opens a connection — removes that window entirely: `isPurgePending()`
  /// refuses every extension write for the ENTIRE duration of the purge,
  /// not just the tail end of it.
  ///
  /// A FRESH random nonce is written every call (never "only if absent" —
  /// f1's idempotency guard is gone on purpose): the nonce is what lets
  /// `clearPurgePending(nonce:)` tell "MY purge is now durably finished, and
  /// nobody has re-marked since I started" from "a DIFFERENT, concurrently-
  /// running purge re-marked while I was mid-flight" — the second case must
  /// NOT be cleared just because the first one happened to finish. Plain
  /// file, deliberately no SQLite (its own creation cannot fail the same
  /// correlated way a DB write under contention can) at
  /// `file-provider-db/purge-pending`, in the SAME directory the cache DB
  /// lives in (the `containerOnly` registry entry above already protects
  /// that directory on the DB's own creation path; this still calls
  /// `protect()` on both directly, rather than assuming that already ran,
  /// since a fresh install racing its very first purge before the directory
  /// has ever been touched must not leave the marker itself unprotected).
  ///
  /// While the marker is present, `CacheManager.beginImmediate()` /
  /// `purgeEpochUnchanged(since:)` (targets/file-provider/CacheManager.swift)
  /// refuse EVERY extension write outright — epoch match or not — which
  /// transitively covers every writer that goes through them:
  /// `replaceChildren`, `upsert(_:expectedEpoch:)`, `delete(id:expectedEpoch:)`,
  /// and `FileProviderExtension.fetchContents`'s temp/pinned writes.
  ///
  /// Cleared ONLY at the end, ONLY by this SAME purge's own final,
  /// durably-committed epoch bump (`resetSQLiteInPlace` below) — via
  /// `clearPurgePending(nonce:)`'s atomic rename-claim against the exact
  /// `Data` this call returns — or by a LATER purge/registration's own
  /// successful bump clearing a STALE marker this one failed to clear
  /// itself (see `resetSQLiteInPlace`'s and
  /// `BeebeebCryptoModule.swift`'s `bumpFileProviderCacheVersion`'s doc
  /// comments for exactly which call sites clear and why).
  ///
  /// Task 1593 f3 (independent security review of eff81b7) — a PRIOR round
  /// of this file added a chmod-0400-the-cache-database fallback for a
  /// `createFile` failure on a full volume. Removed entirely: 0400 makes
  /// the database read-only for EVERY writer, not just the File Provider
  /// extension — the next `bumpFileProviderCacheVersion` / `resetSQLiteInPlace`
  /// on this SAME device (registration, sign-in, a later purge) would open
  /// it `SQLITE_OPEN_READWRITE` and get `SQLITE_READONLY`, so the epoch can
  /// never advance and a later `forceReset` mount fails silently with the
  /// PREVIOUS account's names still cached — turning a rare, transient,
  /// self-healing disk-pressure condition into a durable one. It also never
  /// revoked the extension's own already-open file descriptor to that
  /// database, so it could not have closed the race it existed for anyway.
  /// A `createFile` failure is now a plain, counted purge failure (traced
  /// `storage.purge.failed` by this call's caller,
  /// `BeebeebCryptoModule.swift`'s `purgePlaintextStorage`, whenever this
  /// returns `nil`) — the purge still runs its reset + epoch bump, and the
  /// EPOCH (not this marker) is what actually protects the data: see
  /// `bumpFileProviderCacheVersion`'s doc comment.
  @discardableResult
  public static func markPurgePending() -> Data? {
    guard let dir = fileProviderCacheDbDirectory else { return nil }
    try? FileManager.default.createDirectory(at: dir, withIntermediateDirectories: true)
    protect(dir)
    let nonce = randomPurgePendingNonce()
    let url = dir.appendingPathComponent(purgePendingMarkerName, isDirectory: false)
    guard FileManager.default.createFile(atPath: url.path, contents: nonce) else {
      // Task 1593 f3 — no fallback any more (see doc comment above). The
      // caller (`purgePlaintextStorage`) already counts a `nil` return as a
      // real, traced purge failure and continues the purge regardless.
      RuntimeTrace.event("storage.purge.pending_marker_failed", [:])
      return nil
    }
    protect(url)
    RuntimeTrace.event("storage.purge.pending_marked", [:])
    return nonce
  }

  /// 16 random bytes. Not a secret — this nonce protects nothing
  /// confidential, it only lets `clearPurgePending(nonce:)` distinguish
  /// "the marker still holds what I wrote" from "someone else overwrote it
  /// since". `SecRandomCopyBytes` is backed by the system CSPRNG and does
  /// not need any disk space to succeed; the `arc4random_buf` fallback below
  /// is for the (essentially unreachable) case it somehow fails, and is
  /// still fit for this non-secret, same-process-comparison purpose.
  private static func randomPurgePendingNonce() -> Data {
    var bytes = [UInt8](repeating: 0, count: 16)
    let status = bytes.withUnsafeMutableBytes { buffer -> Int32 in
      SecRandomCopyBytes(kSecRandomDefault, buffer.count, buffer.baseAddress!)
    }
    if status != errSecSuccess {
      arc4random_buf(&bytes, bytes.count)
    }
    return Data(bytes)
  }

  /// Reads the marker's raw on-disk bytes with no side effects. Task 1593
  /// f7 (Codex P1, PRRT_kwDOSLX6T86mme-b) — `registerMountedFileProviderDomainLocked`
  /// (`BeebeebCryptoModule.swift`) calls this at its own snapshot point, the
  /// same instant it reads `isPurgePending()`, to capture "the nonce that
  /// was pending when I started" — NOT `bumpFileProviderCacheVersion`
  /// itself, which used to call this right before its own `BEGIN IMMEDIATE`
  /// (well after that snapshot) and could thereby capture a DIFFERENT,
  /// concurrently-started purge's marker instead; see that function's doc
  /// comment for the full race and fix. `nil` means nothing is pending.
  public static func currentPurgePendingNonce() -> Data? {
    guard let dir = fileProviderCacheDbDirectory else { return nil }
    let url = dir.appendingPathComponent(purgePendingMarkerName, isDirectory: false)
    return try? Data(contentsOf: url)
  }

  /// Task 1593 f8 (Codex P1, PRRT_kwDOSLX6T86mm-UP) — the outcome of one
  /// atomic read of the purge-pending marker (`purgePendingSnapshot()`
  /// below). Replaces a caller pairing `isPurgePending()` (a plain
  /// `fileExists` check, sampled at one instant) with a SEPARATE
  /// `currentPurgePendingNonce()` read (sampled a moment later): a
  /// `markPurgePending()` landing strictly between those two calls made the
  /// first read see "nothing pending" while the second, later read picked
  /// up the brand-new marker's own nonce anyway — see
  /// `BeebeebCryptoModule.swift`'s `registerMountedFileProviderDomainLocked`
  /// for the full race this closes. A `Bool` and a `Data?` read from two
  /// different instants can never be made consistent after the fact; only
  /// reading the marker ONCE and deriving both facts from that one read
  /// can.
  ///
  /// `.unreadable` is its own case, never folded into `.none`: a marker
  /// file that exists but could not be read in full (permission failure,
  /// or `markPurgePending()`'s own `createFile` write landing in the
  /// middle of this read) is NOT the same fact as "no marker was ever
  /// written" — collapsing them the way `currentPurgePendingNonce()`'s
  /// `try? Data(contentsOf:)` does (both cases return `nil`) is exactly how
  /// a real-but-unreadable marker would previously have been treated as
  /// absent. `.isPending` below is `true` for `.unreadable` too — fails
  /// CLOSED, the same direction `clearPurgePending(nonce:)`'s own
  /// unreadable-claim branch already takes — while `.clearableNonce` stays
  /// `nil`: nothing this call read can be proven to BE the pending marker,
  /// so nothing here is ever a value this call could legitimately hand to
  /// `clearPurgePending(nonce:)`.
  public enum PurgePendingSnapshot: Equatable {
    case none
    case nonce(Data)
    case unreadable

    public var isPending: Bool {
      switch self {
      case .none: return false
      case .nonce, .unreadable: return true
      }
    }

    public var clearableNonce: Data? {
      switch self {
      case .nonce(let data): return data
      case .none, .unreadable: return nil
      }
    }
  }

  /// One atomic read of the purge-pending marker: a single `open()` /
  /// `read()` pair, never `isPurgePending()`'s `fileExists` check followed
  /// by a separate content read (`currentPurgePendingNonce()`, or the old
  /// `Data(contentsOf:)`-via-`try?` approach, which cannot distinguish "no
  /// such file" from any other read failure). Raw POSIX calls, matching
  /// this file's existing `rename`/`renamex_np`-based approach to the same
  /// marker in `clearPurgePending(nonce:)` above, rather than Foundation's
  /// `NSError` translation of a missing file (whose exact `CocoaError`
  /// code is an implementation detail of `Data(contentsOf:)`, not a
  /// contract this file otherwise depends on).
  ///
  /// `open()` failing with anything other than `ENOENT` (permission,
  /// too-many-open-files, or any other errno) returns `.unreadable`, not
  /// `.none` — a marker this call could not prove absent must not be
  /// reported as absent. Once open, a `read()` that returns 0 bytes (the
  /// file exists but is momentarily empty — `markPurgePending()`'s
  /// `createFile` opens-then-writes, so a reader can race the gap between
  /// those two steps) or a negative byte count (a read error, errno set)
  /// both return `.unreadable` for the same reason: this call read SOME
  /// evidence of the marker but not its full, trustworthy bytes, so it
  /// must not be handed back as a nonce anything could later compare
  /// against and clear. Only a full, successful read returns `.nonce`.
  public static func purgePendingSnapshot() -> PurgePendingSnapshot {
    guard let dir = fileProviderCacheDbDirectory else { return .none }
    let path = dir.appendingPathComponent(purgePendingMarkerName, isDirectory: false).path
    let fd = open(path, O_RDONLY)
    guard fd >= 0 else {
      return errno == ENOENT ? .none : .unreadable
    }
    defer { close(fd) }
    var buffer = [UInt8](repeating: 0, count: 256)
    let bytesRead = read(fd, &buffer, buffer.count)
    guard bytesRead > 0 else { return .unreadable }
    return .nonce(Data(buffer[0..<bytesRead]))
  }

  /// Task 1593 f3 (independent security review of eff81b7, reviewer P2) —
  /// the PRIOR compare-then-delete here (`Data(contentsOf:)`, then a
  /// SEPARATE `removeItem`) was a read-then-write race against a
  /// concurrent purge: `markPurgePending()` (marker-first) does an
  /// unconditional `createFile` at this exact fixed path, so a DIFFERENT
  /// purge can land its OWN fresh nonce in the gap between this call's
  /// read and its delete — and the delete would still fire, wiping that
  /// NEWER purge's still-in-progress mark out from under it while its
  /// purge is still running.
  ///
  /// Fixed with one atomic filesystem op that takes the marker OFF its live
  /// path before this call ever inspects a single byte: `rename(2)` it to a
  /// private `<marker>.claim-<uuid>` name in the SAME directory (same
  /// volume — always atomic, never crosses a mount point). Whatever bytes
  /// were on disk at that instant are now exclusively this call's to read;
  /// a purge that starts AFTER the rename creates a brand-new file at the
  /// (now-empty) live path via its own `createFile` and is entirely
  /// unaffected by anything this call does next.
  ///
  /// Three outcomes:
  ///  1. Nothing to claim (`rename` fails — ENOENT) — already cleared by a
  ///     prior purge/registration's own successful bump. No-op.
  ///  2. Claimed bytes == `nonce` — THIS call's own, still-current mark
  ///     (nobody re-marked since). Delete the claim: cleared.
  ///  3. Claimed bytes != `nonce` (including unreadable — fails CLOSED,
  ///     same direction as the old compare-then-delete's unreadable-marker
  ///     branch) — this call unknowingly claimed a DIFFERENT, still-in-
  ///     progress purge's mark. It must go back, so `isPurgePending()` /
  ///     `currentPurgePendingNonce()` keep reading it as pending until that
  ///     purge's OWN clear runs. Restored with
  ///     `renamex_np(_:_:RENAME_EXCL)` — exclusive: fails instead of
  ///     clobbering if a THIRD, even newer purge has since claimed the live
  ///     path again, in which case THAT mark is the rightful one and this
  ///     stale claim is simply discarded instead of overwriting it.
  public static func clearPurgePending(nonce: Data) {
    guard let dir = fileProviderCacheDbDirectory else { return }
    let liveUrl = dir.appendingPathComponent(purgePendingMarkerName, isDirectory: false)
    let claimUrl = dir.appendingPathComponent(
      "\(purgePendingMarkerName).claim-\(UUID().uuidString)", isDirectory: false
    )

    guard rename(liveUrl.path, claimUrl.path) == 0 else {
      RuntimeTrace.event("storage.purge.pending_clear_skipped", ["stage": "no_marker"])
      return
    }

    let claimed = (try? Data(contentsOf: claimUrl)) ?? Data()
    guard claimed == nonce else {
      RuntimeTrace.event("storage.purge.pending_clear_skipped", ["stage": "mismatch"])
      if renamex_np(claimUrl.path, liveUrl.path, UInt32(RENAME_EXCL)) != 0 {
        // A newer mark already occupies the live path (RENAME_EXCL
        // correctly refused to clobber it) — that purge's mark is the
        // rightful one; this stale claim has nothing safe left to do but
        // be removed.
        try? FileManager.default.removeItem(at: claimUrl)
      }
      return
    }

    do {
      try FileManager.default.removeItem(at: claimUrl)
      RuntimeTrace.event("storage.purge.pending_cleared", [:])
    } catch {
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
  /// Task 1593 f2 (lead design decision: MARKER FIRST) — `pendingNonce` is
  /// the exact `Data` this purge's OWN `markPurgePending()` call returned at
  /// the very start (before this function, or anything else this purge
  /// does, ever ran) — `nil` only if that mark ITSELF totally failed (both
  /// the primary marker file AND the chmod fallback).
  ///
  /// Task 1593 f4 (Codex thread PRRT_kwDOSLX6T86mknXP, item 1b) — f2/f3 had
  /// `resetSQLiteInPlace` clear the marker itself, immediately after its own
  /// `PRAGMA user_version` bump committed — BEFORE this function's own
  /// VACUUM-adjacent tail (the legacy sweep, the pinned/temp resweep) ever
  /// ran. That left a real gap: an operation delivered in the window between
  /// the bump committing and this function actually returning saw the
  /// marker already gone, so `CacheManager.beginImmediate()` /
  /// `purgeEpochUnchanged(since:)` no longer refused it — even though this
  /// purge itself was not yet done. The clear now happens HERE INSTEAD, only
  /// after the legacy sweep AND the resweep below have both already run, and
  /// only via the SAME compare-then-delete this purge's own bump proved safe
  /// (`resetBumpCommitted`, threaded up from `resetSQLiteInPlace`'s return
  /// value below) — so the marker now covers this purge's ENTIRE duration,
  /// not just the reset transaction's own commit.
  ///
  /// Task 1593 f5 (reviewer follow-up 2) — running AFTER the legacy sweep
  /// and resweep is not enough on its own; the clear guard below ALSO
  /// requires both of them to report zero failures (see the guard's own
  /// doc comment), so a purge that leaves plaintext behind in either one
  /// cannot report itself finished.
  @discardableResult
  public static func purgeAll(pendingNonce: Data? = nil) -> (removed: Int, failed: Int) {
    var removed = 0
    var failed = 0
    var resetBumpCommitted = false
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
        let result = resetSQLiteInPlace(entry.url)
        if result.ok {
          removed += 1
        } else {
          RuntimeTrace.event("storage.purge.failed", ["path": entry.url.lastPathComponent])
          failed += 1
        }
        // Task 1593 f4 (item 1b) — `||=` rather than a bare assignment: this
        // loop only ever visits one `resettableInPlace` entry today (see
        // `registry()`'s own comment), but a future SECOND one must not let
        // its own outcome silently overwrite an earlier successful bump this
        // purge already proved safe to clear on.
        resetBumpCommitted = resetBumpCommitted || result.bumpCommitted
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
    // Task 1593 f4 (item 1b) — the marker's ONE clearing point for this
    // purge, moved here from `resetSQLiteInPlace` (see this function's own
    // doc comment above). Only when THIS purge's own reset durably
    // committed its bump AND this purge's own mark-pending call itself
    // succeeded (`pendingNonce` non-nil) — a total mark-pending failure has
    // nothing this purge can prove safe to clear, matching every other
    // failure branch's "leave it for a later purge/registration" behavior.
    //
    // Task 1593 f5 (reviewer follow-up 2) — ALSO requires `legacy.failed
    // == 0` and `resweep.failed == 0`. `resetBumpCommitted` alone only
    // proves the SQL table rows and the `PRAGMA user_version` epoch bump
    // landed — it says nothing about `sweepLegacyFileProviderCache()` or
    // `resweepFileProviderContentDirectories()`'s own outcomes, even though
    // both run AFTER the reset and each can independently fail to actually
    // delete plaintext left in a legacy DB copy, `pinned/`, or `temp/` (see
    // each function's own doc comment for what it exists to catch).
    // Clearing the marker on a bump success alone, regardless of those two,
    // would tell every other reader (`CacheManager.beginImmediate()`,
    // `purgeEpochUnchanged(since:)`, `currentPurgeEpoch()`) that this purge
    // is done and it is safe to write again, while plaintext this SAME
    // purge was supposed to remove could still be sitting on disk. A failed
    // legacy sweep or resweep is retried by the NEXT purge (both functions
    // only ever act on entries they still find present), so leaving the
    // marker up here is not a permanent stall — it fails closed until that
    // retry actually succeeds.
    if resetBumpCommitted, legacy.failed == 0, resweep.failed == 0, let pendingNonce {
      clearPurgePending(nonce: pendingNonce)
    }
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
  ///
  /// Task 1593 f4 (item 1b, Codex thread PRRT_kwDOSLX6T86mknXP) — this used
  /// to take a `pendingNonce` and clear the marker itself, right after its
  /// own bump committed. That clear moved OUT to `purgeAll`'s own doc
  /// comment (see there for the full rationale — the marker now covers this
  /// entire purge, not just this one transaction), so this function no
  /// longer touches the marker at all, in either direction: neither failure
  /// branch below (this open failure, or the table-enumeration failure
  /// further down) ever called `markPurgePending()`, and that is still
  /// correct under f4 for the same reason it was under f2 — under
  /// marker-first the marker was ALREADY set before this function, before
  /// `purgeAll` even started iterating the registry, so every failure path
  /// here simply leaves it exactly as it found it. Returns `bumpCommitted`
  /// separately from `ok` so `purgeAll` can gate its OWN, now-relocated
  /// clear on "did this specific transaction's epoch bump durably commit",
  /// independent of whatever VACUUM (part of `ok`, not `bumpCommitted`) goes
  /// on to do afterward.
  @discardableResult
  private static func resetSQLiteInPlace(_ url: URL) -> (ok: Bool, bumpCommitted: Bool) {
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
      // Task 1593 f4 (item 1b) — the marker set at purge-start survives this
      // branch untouched (see this function's own doc comment above): no
      // call needed here, that IS the fail-closed behavior, and no bump
      // happened on this path either. Proven by
      // `f2 (item 2): resetSQLiteInPlace's failure branches leave the
      // marker-first mark untouched` in file-provider-purge-hygiene.test.ts.
      return (ok, false)
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
      // Task 1593 f4 (item 1b) — can't enumerate tables, so no bump either;
      // the marker set at purge-start (marker-first) is left exactly as it
      // is, per this function's own doc comment — no re-mark call here.
      return (false, false)
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
    // `ok` at THIS exact point reflects whether the epoch bump itself
    // durably committed (everything above, through COMMIT). VACUUM below is
    // a freelist-hygiene step that runs AFTER commit and must not itself
    // decide whether to clear the fail-closed marker: a VACUUM that fails
    // on an already-committed bump has not left a stale epoch readable
    // anywhere, so this must not treat that as "the bump failed". Captured
    // here, before VACUUM can touch `ok`.
    let bumpCommitted = ok
    // Task 1593 f4 (item 1b) — the marker clear that USED to sit right here
    // (immediately after this bump committed, before VACUUM) moved OUT to
    // `purgeAll`, which now only clears after ITS OWN legacy sweep and
    // pinned/temp resweep have also finished — see that function's doc
    // comment for the full rationale. `bumpCommitted` is still captured at
    // exactly this point (before VACUUM can touch `ok`) and returned to the
    // caller unchanged, so `purgeAll` can gate its relocated clear on the
    // SAME "did this transaction's own bump durably commit" signal, not on
    // VACUUM's outcome.
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
    return (ok, bumpCommitted)
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
