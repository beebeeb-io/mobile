import Foundation
import Security

/// Read-only access to the Beebeeb master key from the App Group Keychain.
///
/// Mirrors `KeychainKeyLoader` from the File Provider extension. The main app's
/// `KeychainManager` writes the SE-wrapped key with `kSecAttrAccessibleAfterFirstUnlock`
/// so extensions can read it after the first device unlock without a biometric prompt.
///
/// Returns nil (never throws) — callers degrade gracefully by staging plaintext
/// for the main app to encrypt on next launch.
enum SharedKeychain {

    private static let seKeyTag = "io.beebeeb.sekey".data(using: .utf8)!
    private static let eciesAlgorithm = SecKeyAlgorithm.eciesEncryptionCofactorVariableIVX963SHA256AESGCM
    private static let keychainService = "io.beebeeb.masterkey"
    private static let masterKeyLabel = "primary"
    private static let keychainAccessGroup = "io.beebeeb.shared"

    static func loadMasterKey() -> Data? {
        guard let wrapped = fetchWrappedBlob(),
              let seKey = findSEKey() else {
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

    private static func fetchWrappedBlob() -> Data? {
        let accessGroup = "\(appIdentifierPrefix())\(keychainAccessGroup)"
        let query: [CFString: Any] = [
            kSecClass: kSecClassGenericPassword,
            kSecAttrService: keychainService,
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

    private static func findSEKey() -> SecKey? {
        let query: [CFString: Any] = [
            kSecClass: kSecClassKey,
            kSecAttrKeyType: kSecAttrKeyTypeECSECPrimeRandom,
            kSecAttrApplicationTag: seKeyTag,
            kSecAttrTokenID: kSecAttrTokenIDSecureEnclave,
            kSecReturnRef: true,
        ]
        var result: CFTypeRef?
        guard SecItemCopyMatching(query as CFDictionary, &result) == errSecSuccess,
              let obj = result else {
            return nil
        }
        return unsafeBitCast(obj, to: SecKey.self)
    }

    /// Resolve the team ID prefix at runtime from the bundle's keychain entitlements.
    /// Same approach as `KeychainKeyLoader.appIdentifierPrefix` in the File Provider.
    private static func appIdentifierPrefix() -> String {
        let query: [CFString: Any] = [
            kSecClass: kSecClassGenericPassword,
            kSecAttrAccount: "__beebeeb_prefix_probe__",
            kSecAttrService: "__beebeeb_prefix_probe__",
            kSecReturnAttributes: true,
            kSecMatchLimit: kSecMatchLimitOne,
        ]
        var result: CFTypeRef?
        let status = SecItemCopyMatching(query as CFDictionary, &result)
        if status == errSecSuccess,
           let attrs = result as? [String: Any],
           let group = attrs[kSecAttrAccessGroup as String] as? String,
           let dot = group.firstIndex(of: ".") {
            return String(group[..<group.index(after: dot)])
        }
        return ""
    }
}
