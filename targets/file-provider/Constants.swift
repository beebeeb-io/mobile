import Foundation

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
  /// Uses a `.devicePasscode` SE key so extensions can decrypt without Face ID.
  static let keychainServiceExt = "io.beebeeb.masterkey.ext"

  /// Keychain account label for the wrapped master key.
  /// Must match the label used by the JS layer (`MASTER_KEY_LABEL` in
  /// `crypto-context.tsx`) and `BeebeebCryptoBridge.kMasterKeyLabel`.
  static let masterKeyLabel = "io.beebeeb.master-key"

  /// SQLite filename inside the App Group container.
  static let cacheDatabaseFilename = "file-provider-cache.sqlite"

  /// API base URL fallback used by the File Provider when the main app hasn't
  /// written `userDefaultsApiBaseUrlKey` yet. Defaults to production (task 0442)
  /// — workspace rule forbids localhost defaults in production code paths.
  /// In dev, the main app overrides this via UserDefaults during sign-in; if
  /// the override is missing, the extension safely points at production rather
  /// than silently hitting whatever's listening on :3001 in a misconfigured
  /// simulator.
  static let defaultApiBaseUrl = "https://api.beebeeb.io"

  /// UserDefaults key (in App Group) that the main app writes after sign-in.
  static let userDefaultsApiBaseUrlKey = "io.beebeeb.apiBaseUrl"

  /// UserDefaults key for the session token, mirrored from SecureStore by the main app.
  static let userDefaultsSessionTokenKey = "io.beebeeb.sessionToken"

  /// Logical root directory shown in the iOS Files app.
  static let rootContainerIdentifier = "io.beebeeb.root"
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

  /// Path to the SQLite cache.
  static var cacheDatabaseUrl: URL {
    url.appendingPathComponent(BeebeebConstants.cacheDatabaseFilename)
  }

  /// Subdirectory holding decrypted file content kept on disk for pinned items.
  static var pinnedContentDirectory: URL {
    let dir = url.appendingPathComponent("pinned", isDirectory: true)
    try? FileManager.default.createDirectory(at: dir, withIntermediateDirectories: true)
    return dir
  }

  /// Subdirectory for transient decrypted blobs returned to the system from `fetchContents`.
  static var temporaryContentDirectory: URL {
    let dir = url.appendingPathComponent("temp", isDirectory: true)
    try? FileManager.default.createDirectory(at: dir, withIntermediateDirectories: true)
    return dir
  }
}
