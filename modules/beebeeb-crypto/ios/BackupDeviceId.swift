import Foundation
import Security

/// Task 1667 round 12 (review of mobile#182 at e9a93077, item 7).
///
/// Since round 10 every new camera-roll upload needs the canonical device id
/// (`X-Beebeeb-Device-Id` on `/photo-backup/check`, `/identifiers`, `/mark`).
/// Native kept it only in `UserDefaults` (`io.beebeeb.backupDeviceId`), written
/// when JS called `setBackupDeviceId` at enable. So after the app update, a
/// `BGProcessingTask` that ran before the user opened the app had no id, and
/// every batch deferred on `noDeviceId` (every 5 s) although the pre-PR engine
/// would have uploaded.
///
/// The id is not native's to make: `getDeviceId()` (src/lib/device-identity.ts)
/// keeps it in expo-secure-store under `bb_sync_device_id`, and it already keys
/// this device's server-side photo-backup state. A different id would make the
/// server's per-device map look empty and every photo upload again. So native
/// READS the same keychain item expo-secure-store wrote, and copies it into
/// `UserDefaults` (readable while the device is locked, which the keychain
/// item, `WHEN_UNLOCKED` by expo's default, is not). It never mints one.
///
/// The read mirrors `resolveCanonicalId`'s first two steps: the canonical key,
/// then the legacy backup key that JS would adopt as canonical. Step 3 (mint a
/// fresh UUID) stays JS's: an id native minted could race JS's own and leave
/// the two disagreeing.
///
/// JS also writes the id to native at every launch (`BackupProvider` mount)
/// and at enable, so the keychain read only matters before the first launch of
/// this build.
enum BackupDeviceId {
  /// `UserDefaults` key the engine reads (round 10).
  static let defaultsKey = "io.beebeeb.backupDeviceId"
  /// src/lib/device-identity.ts `DEVICE_ID_KEY` (the canonical id).
  static let canonicalSecureStoreKey = "bb_sync_device_id"
  /// src/lib/device-identity.ts `LEGACY_BACKUP_DEVICE_ID_KEY` (adopted by JS
  /// as canonical when no canonical id exists).
  static let legacySecureStoreKey = "beebeeb_device_id"

  /// One keychain read.
  enum Read: Equatable {
    case value(String)
    case notFound
    /// Any other status (the device is locked: `errSecInteractionNotAllowed`,
    /// or an item that needs authentication, which is never prompted for).
    case unavailable(OSStatus)
  }

  /// Where the id came from (diagnostics and tests).
  enum Source: String, Equatable {
    case defaults
    case secureStoreCanonical = "secure_store_canonical"
    case secureStoreLegacy = "secure_store_legacy"
  }

  struct Resolution: Equatable {
    let id: String?
    let source: Source?
    /// Why there is none (nil when there is one, or nothing was found).
    let unavailable: OSStatus?
  }

  /// The id to use: the one in `UserDefaults`, else the one expo-secure-store
  /// holds (canonical, then legacy). A keychain hit is persisted to
  /// `UserDefaults` through `persist`. An empty value counts as none.
  static func resolve(
    defaults: () -> String?,
    secureStore: (String) -> Read,
    persist: (String) -> Void
  ) -> Resolution {
    if let stored = defaults(), !stored.isEmpty {
      return Resolution(id: stored, source: .defaults, unavailable: nil)
    }
    var unavailable: OSStatus?
    for (key, source) in [(canonicalSecureStoreKey, Source.secureStoreCanonical), (legacySecureStoreKey, .secureStoreLegacy)] {
      switch secureStore(key) {
      case .value(let id) where !id.isEmpty:
        persist(id)
        return Resolution(id: id, source: source, unavailable: nil)
      case .value, .notFound:
        continue
      case .unavailable(let status):
        // The canonical item may exist but cannot be read now (locked). Do
        // not fall through to the legacy item: it may differ from the
        // canonical one JS uses.
        if key == canonicalSecureStoreKey { return Resolution(id: nil, source: nil, unavailable: status) }
        unavailable = status
      }
    }
    return Resolution(id: nil, source: nil, unavailable: unavailable)
  }

  // MARK: - expo-secure-store's keychain layout (expo-secure-store 57,
  // ios/SecureStoreModule.swift `query(with:options:requireAuthentication:)`)

  /// The keychain services expo-secure-store stores an item under, in its own
  /// read order, without the `"app:auth"` one: reading an item that requires
  /// authentication would show a Face ID prompt from a background task, and
  /// `bb_sync_device_id` is never stored with `requireAuthentication`.
  static let secureStoreServices = ["app:no-auth", "app"]

  /// The query for one service: `kSecAttrService` = service, `kSecAttrGeneric`
  /// and `kSecAttrAccount` = the key's UTF-8 bytes (expo's encoding), no
  /// access group (expo passes none, so the app's default group), and never
  /// any authentication UI.
  static func secureStoreQuery(key: String, service: String) -> [String: Any] {
    let encodedKey = Data(key.utf8)
    return [
      kSecClass as String: kSecClassGenericPassword,
      kSecAttrService as String: service,
      kSecAttrGeneric as String: encodedKey,
      kSecAttrAccount as String: encodedKey,
      kSecMatchLimit as String: kSecMatchLimitOne,
      kSecReturnData as String: kCFBooleanTrue as Any,
      kSecUseAuthenticationUI as String: kSecUseAuthenticationUISkip,
    ]
  }

  /// Reads one expo-secure-store item, as `getItemAsync(key)` would (minus
  /// the authenticated service).
  static func readSecureStore(_ key: String) -> Read {
    var lastFailure: OSStatus?
    for service in secureStoreServices {
      var item: CFTypeRef?
      let status = SecItemCopyMatching(secureStoreQuery(key: key, service: service) as CFDictionary, &item)
      switch status {
      case errSecSuccess:
        guard let data = item as? Data, let value = String(data: data, encoding: .utf8) else {
          lastFailure = errSecDecode
          continue
        }
        return .value(value)
      case errSecItemNotFound:
        continue
      default:
        lastFailure = status
      }
    }
    if let lastFailure { return .unavailable(lastFailure) }
    return .notFound
  }
}
