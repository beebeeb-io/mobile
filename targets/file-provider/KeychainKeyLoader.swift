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
  private static let accessGroup = "R8352WDJJR.io.beebeeb.shared"

  /// Read and unwrap the master key for `label`.
  ///
  /// Uses only the extension SE key (`.devicePasscode` — no biometric prompt).
  /// The File Provider must never fall back to the primary key because that key
  /// may require Face ID and can cause repeated system prompts from Files.app.
  ///
  /// Returns `Data` of length 32. The caller MUST zero out the returned bytes
  /// after constructing a `MasterKeyHandle` from them.
  static func loadMasterKey(label: String = BeebeebConstants.masterKeyLabel) throws -> Data {
    guard let extKey = findSEKey(tag: seKeyTagExt) else {
      throw LoadError.seKeyNotFound
    }
    let wrapped = try fetchWrappedBlob(label: label, service: BeebeebConstants.keychainServiceExt)

    var cfErr: Unmanaged<CFError>?
    guard let plain = SecKeyCreateDecryptedData(extKey, eciesAlgorithm, wrapped as CFData, &cfErr) else {
      throw LoadError.decryptFailed
    }
    return plain as Data
  }

  // MARK: - Private

  private static func fetchWrappedBlob(label: String, service: String) throws -> Data {
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
      kSecAttrAccessGroup: accessGroup,
      kSecReturnRef: true,
    ]
    var result: CFTypeRef?
    guard SecItemCopyMatching(query as CFDictionary, &result) == errSecSuccess,
          let obj = result else { return nil }
    return unsafeBitCast(obj, to: SecKey.self)
  }

  // The main app uses the same explicit group in KeychainManager. Keeping the
  // extension query identical is more reliable on iOS than trying to inspect
  // expanded entitlements from inside the extension process.
}
