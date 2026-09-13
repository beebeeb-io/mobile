import Foundation

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
