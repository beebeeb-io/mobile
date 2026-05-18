import Foundation
import Security

/// Thin wrapper that loads the wrapped master key from the App Group Keychain
/// inside the File Provider extension and decrypts it via the Secure Enclave.
///
/// The main app's `KeychainManager` (in modules/beebeeb-crypto/ios/) writes the
/// wrapped key with `kSecAttrAccessibleAfterFirstUnlock` and the shared access
/// group, so the extension can read it after the device has been unlocked once
/// after boot — without prompting the user.
///
/// Returns 32 raw bytes that the caller should immediately pass to
/// `MasterKeyHandle.fromKeychainBytes` and zero out afterwards.
enum KeychainKeyLoader {
  enum LoadError: Error {
    case notFound
    case readFailed(OSStatus)
    case decryptFailed
    case seKeyNotFound
  }

  private static let seKeyTag = "io.beebeeb.sekey".data(using: .utf8)!
  private static let seKeyTagExt = "io.beebeeb.sekey.ext".data(using: .utf8)!
  private static let eciesAlgorithm = SecKeyAlgorithm.eciesEncryptionCofactorVariableIVX963SHA256AESGCM

  /// Read and unwrap the master key for `label`.
  ///
  /// Tries the extension SE key first (`.devicePasscode` — no biometric prompt),
  /// then falls back to the primary SE key. This allows the FileProvider extension
  /// to decrypt without triggering Face ID from extension context.
  ///
  /// Returns `Data` of length 32. The caller MUST zero out the returned bytes
  /// after constructing a `MasterKeyHandle` from them.
  static func loadMasterKey(label: String = BeebeebConstants.masterKeyLabel) throws -> Data {
    // Try the extension key first — .devicePasscode, no biometric prompt
    if let extKey = findSEKey(tag: seKeyTagExt),
       let extWrapped = try? fetchWrappedBlob(label: label, service: BeebeebConstants.keychainServiceExt) {
      var cfErr: Unmanaged<CFError>?
      if let plain = SecKeyCreateDecryptedData(extKey, eciesAlgorithm, extWrapped as CFData, &cfErr) {
        return plain as Data
      }
    }

    // Fall back to primary key
    let wrapped = try fetchWrappedBlob(label: label, service: BeebeebConstants.keychainService)
    guard let seKey = findSEKey(tag: seKeyTag) else { throw LoadError.seKeyNotFound }

    var cfErr: Unmanaged<CFError>?
    guard let plain = SecKeyCreateDecryptedData(seKey, eciesAlgorithm, wrapped as CFData, &cfErr) else {
      throw LoadError.decryptFailed
    }
    return plain as Data
  }

  // MARK: - Private

  private static func fetchWrappedBlob(label: String, service: String) throws -> Data {
    let accessGroup = "\(appIdentifierPrefix())\(BeebeebConstants.keychainAccessGroup)"
    let query: [CFString: Any] = [
      kSecClass: kSecClassGenericPassword,
      kSecAttrService: service,
      kSecAttrAccount: label,
      kSecAttrAccessGroup: accessGroup,
      kSecReturnData: true,
      kSecMatchLimit: kSecMatchLimitOne,
    ]

    var result: CFTypeRef?
    let status = SecItemCopyMatching(query as CFDictionary, &result)
    if status == errSecItemNotFound { throw LoadError.notFound }
    guard status == errSecSuccess, let data = result as? Data else {
      throw LoadError.readFailed(status)
    }
    return data
  }

  private static func findSEKey(tag: Data) -> SecKey? {
    let query: [CFString: Any] = [
      kSecClass: kSecClassKey,
      kSecAttrKeyType: kSecAttrKeyTypeECSECPrimeRandom,
      kSecAttrApplicationTag: tag,
      kSecAttrTokenID: kSecAttrTokenIDSecureEnclave,
      kSecReturnRef: true,
    ]
    var result: CFTypeRef?
    guard SecItemCopyMatching(query as CFDictionary, &result) == errSecSuccess,
          let obj = result else { return nil }
    return unsafeBitCast(obj, to: SecKey.self)
  }

  /// Resolve the team identifier prefix at runtime from the bundle's keychain
  /// access groups entitlement, so we don't hard-code it.
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
