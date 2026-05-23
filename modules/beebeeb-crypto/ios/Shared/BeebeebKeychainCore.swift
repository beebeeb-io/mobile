import Foundation
import Security

/// Shared Secure-Enclave-wrapped master key read + lookup logic for Beebeeb.
///
/// **Single source of truth (task 0436).** Consumed by all three keychain
/// surfaces:
///
///   - `modules/beebeeb-crypto/ios/KeychainManager.swift` — main app. Also
///     writes (store/delete/access-control/string-storage). Uses
///     `BeebeebKeychainCore` for shared constants and read helpers.
///   - `targets/file-provider/BeebeebKeychainCore.swift` — symlink to this
///     file. File Provider extension reads with `mode: .extensionOnly`.
///   - `targets/share-extension/BeebeebKeychainCore.swift` — symlink to this
///     file. Share Extension reads with `mode: .extensionThenPrimary`.
///
/// Constants (SE key tag, access group, service names, ECIES algorithm) live
/// here so a change to the wrap version, access control, or key tag is made
/// in exactly one place. Each extension target compiles its own copy of the
/// `BeebeebKeychainCore` enum, but they're separate binaries — no link
/// conflict.
///
/// The canonical master-key account label is owned by the JS layer
/// (`MASTER_KEY_LABEL = 'io.beebeeb.master-key'` in
/// `src/lib/crypto-context.tsx`). Callers should pass that label explicitly
/// rather than relying on a default, so the source of truth stays on the
/// writer side.
enum BeebeebKeychainCore {

    enum LoadError: Error {
        case notFound
        case readFailed(OSStatus)
        case writeFailed(OSStatus)
        case decryptFailed
        case seKeyNotFound
    }

    /// Selects which Secure-Enclave key the loader tries.
    enum LoadMode {
        /// Try the primary SE key only. Used by the main app, where a Face ID
        /// or passcode prompt is acceptable. **Extensions must not use this**
        /// — Files.app and the share sheet can't surface a clean prompt.
        case primaryOnly
        /// Try the extension SE key (`.devicePasscode`, no biometric prompt)
        /// only. File Provider uses this exclusively.
        case extensionOnly
        /// Try the extension SE key first; fall back to the primary key if
        /// the extension key is missing. Share Extension uses this so a user
        /// who has never run a backup (no extension key yet) can still
        /// trigger Face ID once via the share sheet.
        case extensionThenPrimary
    }

    // MARK: - Constants

    static let seKeyTag = "io.beebeeb.sekey".data(using: .utf8)!
    static let seKeyTagExt = "io.beebeeb.sekey.ext".data(using: .utf8)!
    static let wrappedKeyService = "io.beebeeb.masterkey"
    static let wrappedKeyServiceExt = "io.beebeeb.masterkey.ext"
    static let eciesAlgorithm = SecKeyAlgorithm.eciesEncryptionCofactorVariableIVX963SHA256AESGCM

    /// Fully-qualified keychain access group. Team ID prefix is hardcoded
    /// to match `R8352WDJJR.` (declared in `app.json:appleTeamId`, in
    /// `plugins/share-extension/withShareExtension.js`'s entitlements
    /// template, and in `targets/file-provider/expo-target.config.js`).
    /// Keep all four in sync if the team ID ever changes (task 0428 fixed
    /// the original runtime-probe bug that returned `""` on fresh install).
    static let accessGroup: String? = "R8352WDJJR.io.beebeeb.shared"

    // MARK: - Public read API

    /// Load and decrypt the wrapped master key for `label`.
    /// Returns `nil` when no wrapped blob exists or when the SE decryption
    /// fails (e.g. extension key locked by `.devicePasscode` policy).
    /// Non-throwing — Share Extension callers expect nil-on-failure so they
    /// can show a user-visible "unlock to share" error and abort (never
    /// stage plaintext, per task 0428).
    static func loadMasterKey(label: String, mode: LoadMode) -> Data? {
        // Extension SE key path (.devicePasscode, no Face ID prompt)
        if mode != .primaryOnly,
           let extKey = findSEKey(tag: seKeyTagExt),
           let wrapped = fetchWrappedBlob(service: wrappedKeyServiceExt, label: label) {
            var cfErr: Unmanaged<CFError>?
            if let plain = SecKeyCreateDecryptedData(extKey, eciesAlgorithm, wrapped as CFData, &cfErr) {
                return plain as Data
            }
        }

        guard mode != .extensionOnly else { return nil }

        // Primary SE key path (may trigger biometric/passcode prompt)
        guard let wrapped = fetchWrappedBlob(service: wrappedKeyService, label: label),
              let primaryKey = findSEKey(tag: seKeyTag) else {
            return nil
        }
        var cfErr: Unmanaged<CFError>?
        guard let plain = SecKeyCreateDecryptedData(primaryKey, eciesAlgorithm, wrapped as CFData, &cfErr) else {
            return nil
        }
        return plain as Data
    }

    /// Throwing variant for callers (File Provider) that surface typed errors
    /// up to system frameworks. Distinguishes "no SE key at all" from
    /// "blob missing" so Files.app can show a coherent message.
    static func loadMasterKeyThrowing(label: String, mode: LoadMode) throws -> Data {
        if let key = loadMasterKey(label: label, mode: mode) {
            return key
        }
        // Determine which gate failed for a cleaner error
        let extKeyMissing = findSEKey(tag: seKeyTagExt) == nil
        let primaryKeyMissing = findSEKey(tag: seKeyTag) == nil
        switch mode {
        case .primaryOnly:
            throw primaryKeyMissing ? LoadError.seKeyNotFound : LoadError.notFound
        case .extensionOnly:
            throw extKeyMissing ? LoadError.seKeyNotFound : LoadError.notFound
        case .extensionThenPrimary:
            throw (extKeyMissing && primaryKeyMissing) ? LoadError.seKeyNotFound : LoadError.notFound
        }
    }

    // MARK: - Lookup helpers (internal so KeychainManager can reuse on the write path)

    /// Find an SE key by application tag. Tries the access-group-scoped
    /// lookup first, then falls back to no-access-group (for keys created
    /// before the App Group rollout — legacy installs from earlier builds).
    static func findSEKey(tag: Data) -> SecKey? {
        var query: [CFString: Any] = [
            kSecClass: kSecClassKey,
            kSecAttrKeyType: kSecAttrKeyTypeECSECPrimeRandom,
            kSecAttrApplicationTag: tag,
            kSecAttrTokenID: kSecAttrTokenIDSecureEnclave,
            kSecReturnRef: true,
        ]
        if let group = accessGroup { query[kSecAttrAccessGroup] = group }

        var result: CFTypeRef?
        var status = SecItemCopyMatching(query as CFDictionary, &result)
        if status == errSecSuccess, let obj = result {
            return unsafeBitCast(obj, to: SecKey.self)
        }
        if accessGroup != nil {
            var legacy = query
            legacy.removeValue(forKey: kSecAttrAccessGroup)
            status = SecItemCopyMatching(legacy as CFDictionary, &result)
            if status == errSecSuccess, let obj = result {
                return unsafeBitCast(obj, to: SecKey.self)
            }
        }
        return nil
    }

    // MARK: - Generic string storage (App-Group-shared)
    //
    // Used by task 0447 for the user's session token + apiBaseUrl. Items
    // are written with the App Group access group + accessibility
    // `kSecAttrAccessibleAfterFirstUnlockThisDeviceOnly`, so the File
    // Provider extension + Share Extension can read them after first
    // unlock — and `ThisDeviceOnly` excludes them from unencrypted
    // iCloud / iTunes device backups (where they previously leaked as
    // App-Group UserDefaults plist entries).
    //
    // Same `stringStorageService` as `KeychainManager`'s 0430 helpers, so
    // a future cleanup that promotes all string keys to a single owner
    // can deduplicate without a separate keychain item migration.

    static let stringStorageService = "io.beebeeb.string-storage"
    static let appGroupSuiteName = "group.io.beebeeb.shared"

    /// Persist `value` under `key` in the shared Keychain. Replaces any
    /// existing value at the same key. Also clears any legacy App Group
    /// UserDefaults entry at the same key (belt-and-suspenders against the
    /// pre-0447 plaintext leak resurfacing on the next write).
    static func storeString(_ value: String, key: String) throws {
        let data = Data(value.utf8)
        deleteStringFromKeychain(key: key)
        var attrs: [CFString: Any] = [
            kSecClass: kSecClassGenericPassword,
            kSecAttrService: stringStorageService,
            kSecAttrAccount: key,
            kSecAttrAccessible: kSecAttrAccessibleAfterFirstUnlockThisDeviceOnly,
            kSecValueData: data,
        ]
        if let group = accessGroup { attrs[kSecAttrAccessGroup] = group }
        let status = SecItemAdd(attrs as CFDictionary, nil)
        guard status == errSecSuccess else {
            throw LoadError.writeFailed(status)
        }
        UserDefaults(suiteName: appGroupSuiteName)?.removeObject(forKey: key)
    }

    /// Return the stored string at `key`, or `nil` if neither the Keychain
    /// nor the legacy App Group UserDefaults has a value. Performs an
    /// on-demand migration the first time a legacy UserDefaults entry is
    /// encountered: writes to Keychain, then clears UserDefaults ONLY on
    /// `errSecSuccess` from `SecItemAdd`. If the write fails, the legacy
    /// value is still returned (existing sessions survive the failure;
    /// migration retries on the next read).
    static func loadString(key: String) -> String? {
        if let existing = readStringFromKeychain(key: key) {
            return existing
        }
        let defaults = UserDefaults(suiteName: appGroupSuiteName)
        guard let legacy = defaults?.string(forKey: key) else { return nil }
        do {
            try storeString(legacy, key: key)
            // `storeString` cleared the App-Group UserDefaults entry on
            // success — nothing else to do here.
            return legacy
        } catch {
            NSLog("[Beebeeb] keychain migration failed for \(key): \(error.localizedDescription) — keeping App Group UserDefaults entry until next launch")
            return legacy
        }
    }

    /// Remove the string at `key` from BOTH the shared Keychain and the
    /// legacy App Group UserDefaults entry. Used at sign-out so a stale
    /// session token can't survive even via the migration path.
    static func deleteString(key: String) {
        deleteStringFromKeychain(key: key)
        UserDefaults(suiteName: appGroupSuiteName)?.removeObject(forKey: key)
    }

    private static func readStringFromKeychain(key: String) -> String? {
        var query: [CFString: Any] = [
            kSecClass: kSecClassGenericPassword,
            kSecAttrService: stringStorageService,
            kSecAttrAccount: key,
            kSecReturnData: true,
            kSecMatchLimit: kSecMatchLimitOne,
        ]
        if let group = accessGroup { query[kSecAttrAccessGroup] = group }
        var result: CFTypeRef?
        var status = SecItemCopyMatching(query as CFDictionary, &result)
        if status == errSecItemNotFound, accessGroup != nil {
            query.removeValue(forKey: kSecAttrAccessGroup)
            status = SecItemCopyMatching(query as CFDictionary, &result)
        }
        guard status == errSecSuccess, let data = result as? Data else { return nil }
        return String(data: data, encoding: .utf8)
    }

    private static func deleteStringFromKeychain(key: String) {
        var query: [CFString: Any] = [
            kSecClass: kSecClassGenericPassword,
            kSecAttrService: stringStorageService,
            kSecAttrAccount: key,
        ]
        if let group = accessGroup { query[kSecAttrAccessGroup] = group }
        SecItemDelete(query as CFDictionary)
    }

    /// Fetch a wrapped-key blob from the generic-password keychain class.
    /// Tries access-group-scoped lookup first, then falls back to
    /// no-access-group for the same legacy reason as `findSEKey`.
    static func fetchWrappedBlob(service: String, label: String) -> Data? {
        var query: [CFString: Any] = [
            kSecClass: kSecClassGenericPassword,
            kSecAttrService: service,
            kSecAttrAccount: label,
            kSecReturnData: true,
            kSecMatchLimit: kSecMatchLimitOne,
        ]
        if let group = accessGroup { query[kSecAttrAccessGroup] = group }

        var result: CFTypeRef?
        var status = SecItemCopyMatching(query as CFDictionary, &result)
        if status == errSecItemNotFound, accessGroup != nil {
            query.removeValue(forKey: kSecAttrAccessGroup)
            status = SecItemCopyMatching(query as CFDictionary, &result)
        }
        guard status == errSecSuccess else { return nil }
        return result as? Data
    }
}
