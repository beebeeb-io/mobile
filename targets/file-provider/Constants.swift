import Foundation
import FileProvider

/// Shared identifiers and paths for the Beebeeb File Provider Extension.
///
/// These constants are referenced from the main app and the extension. Keeping
/// them in one place makes it easy to verify the App Group / Keychain
/// configuration when capabilities are provisioned.
enum BeebeebConstants {
  /// App Group container shared between the main app and all extensions.
  static let appGroup = "group.io.beebeeb.shared"

  /// Keychain access group, prefixed at runtime with `$(AppIdentifierPrefix)`.
  /// The literal `AppIdentifierPrefix` placeholder is resolved by Security.framework.
  static let keychainAccessGroup = "io.beebeeb.shared"

  /// Keychain service used by `KeychainManager.store`/`load`.
  static let keychainService = "io.beebeeb.masterkey"

  /// Keychain service for the extension-specific wrapped master key blob.
  /// Legacy share/backup service. Files uses the dedicated versioned service
  /// defined by BeebeebKeychainCore.wrappedKeyServiceFiles.
  static let keychainServiceExt = "io.beebeeb.masterkey.ext"

  /// Keychain account label for the wrapped master key.
  /// Must match the label used by the JS layer (`MASTER_KEY_LABEL` in
  /// `crypto-context.tsx`) and `BeebeebCryptoBridge.kMasterKeyLabel`.
  static let masterKeyLabel = "io.beebeeb.master-key"

  /// SQLite filename inside the App Group container.
  static let cacheDatabaseFilename = "file-provider-cache.sqlite"

  /// API base URL fallback used by the File Provider when the main app
  /// hasn't written the corresponding keychain entry yet. Defaults to
  /// production (task 0442) — workspace rule forbids localhost defaults
  /// in production code paths. In dev, the main app overrides this via
  /// `BeebeebKeychainCore.storeString(...)` during sign-in (see task
  /// 0447); if the override is missing, the extension safely points at
  /// production rather than silently hitting whatever's listening on
  /// :3001 in a misconfigured simulator.
  static let defaultApiBaseUrl = "https://api.beebeeb.io"

  /// Account name used to store the API base URL in the shared Keychain.
  /// Historical name preserved (`userDefaults…Key`) — the key value is
  /// the same; only the storage backend moved from App Group UserDefaults
  /// to the shared Keychain in task 0447 (the old UserDefaults plist
  /// entry leaked into unencrypted device backups). `loadString` migrates
  /// the legacy value on first read.
  static let userDefaultsApiBaseUrlKey = "io.beebeeb.apiBaseUrl"

  /// Account name used to store the session token in the shared Keychain.
  /// Same migration story as `userDefaultsApiBaseUrlKey` — see task 0447.
  static let userDefaultsSessionTokenKey = "io.beebeeb.sessionToken"

  // Task 1593 round 8 (R2) — the purge-epoch counter used to live here as
  // an App Group `UserDefaults` key (`purgeEpochKey`), a separate value
  // from the cache database with no cross-process synchronisation
  // guarantee between the two. It now lives IN the cache database itself,
  // as its `PRAGMA user_version` — see `CacheManager.currentPurgeEpoch()`'s
  // doc comment for the full rationale. Removed here; nothing else in this
  // target referenced it.

  /// Logical root directory shown in the iOS Files app.
  static let rootContainerIdentifier = "io.beebeeb.root"

  /// File Provider domain registered by the containing app.
  static let fileProviderDomainIdentifier = NSFileProviderDomainIdentifier("io.beebeeb.files")
  static let fileProviderDisplayName = "Beebeeb"
  static var fileProviderDomain: NSFileProviderDomain {
    NSFileProviderDomain(identifier: fileProviderDomainIdentifier, displayName: fileProviderDisplayName)
  }
}

/// URL helpers for the App Group container.
enum AppGroupContainer {
  /// Root URL of the shared container. Crashes early if entitlements are misconfigured —
  /// a File Provider extension cannot do useful work without the App Group.
  static var url: URL {
    guard let url = FileManager.default
      .containerURL(forSecurityApplicationGroupIdentifier: BeebeebConstants.appGroup) else {
      fatalError("App Group \(BeebeebConstants.appGroup) is not provisioned. Check entitlements.")
    }
    return url
  }

  /// Task 1593 round 11 (Codex thread PRRT_kwDOSLX6T86miVoV) — dedicated,
  /// protected directory for the SQLite cache; see
  /// `PlaintextStorageProtection.migrateFileProviderCacheDatabaseIfNeeded`'s
  /// doc comment for why a directory (not just the file) is what actually
  /// closes the sidecar-protection gap, via inheritance. Same
  /// create-then-protect shape as `pinnedContentDirectory`/
  /// `temporaryContentDirectory` above.
  static var cacheDatabaseDirectory: URL {
    let dir = url.appendingPathComponent("file-provider-db", isDirectory: true)
    try? FileManager.default.createDirectory(at: dir, withIntermediateDirectories: true)
    PlaintextStorageProtection.protect(dir)
    return dir
  }

  /// Path to the SQLite cache. Task 1593 round 11 moved this from the App
  /// Group root into `cacheDatabaseDirectory`; every resolution migrates a
  /// pre-round-11 install's legacy top-level database the first time either
  /// process (main app or extension) next resolves this path.
  static var cacheDatabaseUrl: URL {
    let legacy = url.appendingPathComponent(BeebeebConstants.cacheDatabaseFilename)
    let migrated = cacheDatabaseDirectory.appendingPathComponent(BeebeebConstants.cacheDatabaseFilename)
    return PlaintextStorageProtection.migrateFileProviderCacheDatabaseIfNeeded(from: legacy, to: migrated)
  }

  /// Subdirectory holding decrypted file content kept on disk for pinned items.
  static var pinnedContentDirectory: URL {
    let dir = url.appendingPathComponent("pinned", isDirectory: true)
    try? FileManager.default.createDirectory(at: dir, withIntermediateDirectories: true)
    PlaintextStorageProtection.protect(dir)
    return dir
  }

  /// Subdirectory for transient decrypted blobs returned to the system from `fetchContents`.
  static var temporaryContentDirectory: URL {
    let dir = url.appendingPathComponent("temp", isDirectory: true)
    try? FileManager.default.createDirectory(at: dir, withIntermediateDirectories: true)
    PlaintextStorageProtection.protect(dir)
    return dir
  }
}
