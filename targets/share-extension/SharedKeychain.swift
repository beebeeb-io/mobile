import Foundation
import Security

/// Read-only access to the Beebeeb master key from the App Group Keychain.
///
/// Mirrors `KeychainKeyLoader` from the File Provider extension. The main app's
/// `KeychainManager` writes the SE-wrapped key with `kSecAttrAccessibleAfterFirstUnlock`
/// so extensions can read it after the first device unlock without a biometric prompt.
///
/// **Failure contract.** Returns `nil` when the master key is unavailable
/// (no entry yet, or extension key is locked by `.devicePasscode` policy).
/// Callers MUST surface a user-visible error and abort the share — they MUST
/// NOT write the plaintext file to disk as a fallback. The previous fallback
/// staged unencrypted bytes into the App Group container, which leaked
/// plaintext if the user uninstalled before the main app drained the queue.
enum SharedKeychain {

    private static let seKeyTag = "io.beebeeb.sekey".data(using: .utf8)!
    private static let seKeyTagExt = "io.beebeeb.sekey.ext".data(using: .utf8)!
    private static let eciesAlgorithm = SecKeyAlgorithm.eciesEncryptionCofactorVariableIVX963SHA256AESGCM
    private static let keychainService = "io.beebeeb.masterkey"
    private static let keychainServiceExt = "io.beebeeb.masterkey.ext"
    // Canonical label used by `MASTER_KEY_LABEL` in `src/lib/crypto-context.tsx`,
    // `BeebeebCryptoBridge.kMasterKeyLabel` in
    // `modules/beebeeb-crypto/ios/BeebeebCryptoBridge.swift`, and
    // `BeebeebConstants.masterKeyLabel` in
    // `targets/file-provider/Constants.swift`. The previous value `"primary"`
    // (task 0445) caused `SecItemCopyMatching` to return `errSecItemNotFound`
    // because the main app stores the wrapped master key with the canonical
    // label — `SharedKeychain.loadMasterKey()` would return `nil` for every
    // share even with correct entitlements (0433) and correct access-group
    // prefix (0428).
    private static let masterKeyLabel = "io.beebeeb.master-key"

    /// Fully-qualified keychain access group used by the extension. The team
    /// ID prefix (`R8352WDJJR.`) is hardcoded to match `KeychainKeyLoader`
    /// in the File Provider target and `KeychainManager` in
    /// `modules/beebeeb-crypto/ios/`. The previous implementation derived
    /// the prefix by probing the keychain for an unrelated item at runtime
    /// — that returned `""` on a fresh install (no items yet), which built
    /// a malformed access group and made `loadMasterKey()` return `nil`
    /// even though the entitlement was correctly provisioned. The hardcoded
    /// value avoids that bootstrap failure. The team ID is also declared
    /// once in `app.json` (`appleTeamId`) and once in
    /// `targets/share-extension/expo-target.config.js` — keep all four in
    /// sync if the team ID ever changes.
    private static let accessGroup = "R8352WDJJR.io.beebeeb.shared"

    /// Load the master key, preferring the extension SE key (.devicePasscode — no
    /// biometric prompt) and falling back to the primary SE key. Returns `nil`
    /// when neither path yields a key. Callers MUST treat `nil` as a hard
    /// failure (abort the share with a clear error) — never as a signal to
    /// stage plaintext.
    static func loadMasterKey() -> Data? {
        // Try the extension key first — .devicePasscode, no Face ID prompt
        if let extKey = findSEKey(tag: seKeyTagExt),
           let extWrapped = fetchWrappedBlob(service: keychainServiceExt) {
            var cfErr: Unmanaged<CFError>?
            if let plain = SecKeyCreateDecryptedData(extKey, eciesAlgorithm, extWrapped as CFData, &cfErr) {
                return plain as Data
            }
        }

        // Fall back to primary key
        guard let wrapped = fetchWrappedBlob(service: keychainService),
              let seKey = findSEKey(tag: seKeyTag) else {
            return nil
        }
        var cfErr: Unmanaged<CFError>?
        guard let plain = SecKeyCreateDecryptedData(seKey, eciesAlgorithm, wrapped as CFData, &cfErr) else {
            // SE access control may require biometrics — unavailable in extension context
            return nil
        }
        return plain as Data
    }

    // MARK: - Private

    private static func fetchWrappedBlob(service: String) -> Data? {
        let query: [CFString: Any] = [
            kSecClass: kSecClassGenericPassword,
            kSecAttrService: service,
            kSecAttrAccount: masterKeyLabel,
            kSecAttrAccessGroup: accessGroup,
            kSecReturnData: true,
            kSecMatchLimit: kSecMatchLimitOne,
        ]
        var result: CFTypeRef?
        guard SecItemCopyMatching(query as CFDictionary, &result) == errSecSuccess,
              let data = result as? Data else {
            return nil
        }
        return data
    }

    private static func findSEKey(tag: Data) -> SecKey? {
        let query: [CFString: Any] = [
            kSecClass: kSecClassKey,
            kSecAttrKeyType: kSecAttrKeyTypeECSECPrimeRandom,
            kSecAttrApplicationTag: tag,
            kSecAttrTokenID: kSecAttrTokenIDSecureEnclave,
            kSecAttrAccessGroup: accessGroup,
            kSecReturnRef: true,
        ]
        var result: CFTypeRef?
        guard SecItemCopyMatching(query as CFDictionary, &result) == errSecSuccess,
              let obj = result else {
            return nil
        }
        return unsafeBitCast(obj, to: SecKey.self)
    }
}
