import Foundation
import Security

enum KeychainError: LocalizedError {
  case seKeyGenerationFailed
  case seKeyNotFound
  case encryptionFailed
  case decryptionFailed
  case writeError(OSStatus)
  case readError(OSStatus)
  case invalidMasterKeySize

  var errorDescription: String? {
    switch self {
    case .seKeyGenerationFailed: return "Failed to generate Secure Enclave key"
    case .seKeyNotFound: return "Secure Enclave wrapping key not found"
    case .encryptionFailed: return "ECIES encryption failed"
    case .decryptionFailed: return "ECIES decryption failed — biometric or passcode required"
    case .writeError(let s): return "Keychain write error \(s)"
    case .readError(let s): return "Keychain read error \(s)"
    case .invalidMasterKeySize: return "Master key must be exactly 32 bytes"
    }
  }
}

/// Two-tier Secure Enclave key hierarchy for the Beebeeb master key.
///
/// Tier 1 — SE wrapping key: P-256 EC key stored in the Secure Enclave. Never exported.
/// Tier 2 — Wrapped master key: AES-256 master key encrypted by the SE public key (ECIES),
///           stored as kSecClassGenericPassword with kSecAttrAccessibleAfterFirstUnlock.
///
/// This allows background camera/contact backup to run after the first device unlock without
/// re-prompting biometrics, while still keeping the master key protected by hardware.
final class KeychainManager {

  // MARK: - Constants

  private static let seKeyTag = "io.beebeeb.sekey".data(using: .utf8)!
  private static let wrappedKeyService = "io.beebeeb.masterkey"
  private static let eciesAlgorithm = SecKeyAlgorithm.eciesEncryptionCofactorVariableIVX963SHA256AESGCM

  // Set to "<TEAM_ID>.io.beebeeb.shared" once App Groups entitlement is provisioned.
  // nil means items are scoped to the main app only (safe for development).
  private static let accessGroup: String? = nil

  // Persisted across launches in UserDefaults (not sensitive — it's just a policy flag).
  private static var requiresBiometric: Bool {
    get { UserDefaults.standard.bool(forKey: "io.beebeeb.requiresBiometric") }
    set { UserDefaults.standard.set(newValue, forKey: "io.beebeeb.requiresBiometric") }
  }

  // MARK: - Store

  /// Encrypt `masterKeyBytes` with the SE wrapping key and persist in Keychain.
  /// Generates the SE wrapping key on first call.
  static func store(masterKeyBytes: Data, label: String) throws {
    guard masterKeyBytes.count == 32 else {
      throw KeychainError.invalidMasterKeySize
    }

    let seKey = try getOrCreateSEKey()
    guard let publicKey = SecKeyCopyPublicKey(seKey) else {
      throw KeychainError.seKeyNotFound
    }

    var cfErr: Unmanaged<CFError>?
    guard let wrapped = SecKeyCreateEncryptedData(publicKey, eciesAlgorithm, masterKeyBytes as CFData, &cfErr) else {
      throw KeychainError.encryptionFailed
    }

    deleteWrappedItem(account: label)

    var attrs: [CFString: Any] = [
      kSecClass: kSecClassGenericPassword,
      kSecAttrService: wrappedKeyService,
      kSecAttrAccount: label,
      kSecAttrAccessible: kSecAttrAccessibleAfterFirstUnlock,
      kSecValueData: wrapped as Data,
    ]
    if let group = accessGroup { attrs[kSecAttrAccessGroup] = group }

    let status = SecItemAdd(attrs as CFDictionary, nil)
    guard status == errSecSuccess else {
      throw KeychainError.writeError(status)
    }
  }

  // MARK: - Load

  /// Decrypt and return the master key. Returns nil if no key is stored.
  /// Triggers biometric/passcode prompt if the SE access control requires it.
  static func load(label: String) throws -> Data? {
    var query: [CFString: Any] = [
      kSecClass: kSecClassGenericPassword,
      kSecAttrService: wrappedKeyService,
      kSecAttrAccount: label,
      kSecReturnData: true,
      kSecMatchLimit: kSecMatchLimitOne,
    ]
    if let group = accessGroup { query[kSecAttrAccessGroup] = group }

    var result: CFTypeRef?
    let status = SecItemCopyMatching(query as CFDictionary, &result)
    guard status == errSecSuccess else {
      if status == errSecItemNotFound { return nil }
      throw KeychainError.readError(status)
    }
    guard let wrapped = result as? Data else { return nil }

    guard let seKey = findSEKey() else {
      throw KeychainError.seKeyNotFound
    }

    var cfErr: Unmanaged<CFError>?
    guard let plaintext = SecKeyCreateDecryptedData(seKey, eciesAlgorithm, wrapped as CFData, &cfErr) else {
      throw KeychainError.decryptionFailed
    }
    return plaintext as Data
  }

  // MARK: - Delete

  /// Remove the SE wrapping key and all wrapped key blobs. Irreversible.
  static func delete() {
    let seQuery: [CFString: Any] = [
      kSecClass: kSecClassKey,
      kSecAttrKeyType: kSecAttrKeyTypeECSECPrimeRandom,
      kSecAttrApplicationTag: seKeyTag,
      kSecAttrTokenID: kSecAttrTokenIDSecureEnclave,
    ]
    SecItemDelete(seQuery as CFDictionary)

    var wrappedQuery: [CFString: Any] = [
      kSecClass: kSecClassGenericPassword,
      kSecAttrService: wrappedKeyService,
    ]
    if let group = accessGroup { wrappedQuery[kSecAttrAccessGroup] = group }
    SecItemDelete(wrappedQuery as CFDictionary)
  }

  // MARK: - Access control toggle

  /// Switch between .devicePasscode (background OK) and .biometryAny (foreground only).
  ///
  /// If a wrapping key already exists, all stored master keys are decrypted with the old
  /// SE key, the old key is deleted, a new SE key is generated with the updated access
  /// control, and all master keys are re-wrapped. Requires the user to authenticate with
  /// the current policy before switching.
  static func setAccessControl(requireBiometric: Bool) throws {
    let wasBiometric = requiresBiometric
    requiresBiometric = requireBiometric

    guard wasBiometric != requireBiometric, let oldSEKey = findSEKey() else {
      return
    }

    // Fetch all wrapped blobs so we can re-wrap them under the new SE key
    var fetchQuery: [CFString: Any] = [
      kSecClass: kSecClassGenericPassword,
      kSecAttrService: wrappedKeyService,
      kSecReturnData: true,
      kSecReturnAttributes: true,
      kSecMatchLimit: kSecMatchLimitAll,
    ]
    if let group = accessGroup { fetchQuery[kSecAttrAccessGroup] = group }

    var allItems: CFTypeRef?
    let fetchStatus = SecItemCopyMatching(fetchQuery as CFDictionary, &allItems)
    let items = fetchStatus == errSecSuccess ? (allItems as? [[CFString: Any]] ?? []) : []

    // Decrypt each blob with the old SE key (triggers auth prompt if needed)
    var plaintexts: [(account: String, data: Data)] = []
    for item in items {
      guard let wrapped = item[kSecValueData] as? Data,
            let account = item[kSecAttrAccount] as? String else { continue }
      var cfErr: Unmanaged<CFError>?
      if let plain = SecKeyCreateDecryptedData(oldSEKey, eciesAlgorithm, wrapped as CFData, &cfErr) {
        plaintexts.append((account: account, data: plain as Data))
      }
    }

    // Delete old SE key
    let seQuery: [CFString: Any] = [
      kSecClass: kSecClassKey,
      kSecAttrKeyType: kSecAttrKeyTypeECSECPrimeRandom,
      kSecAttrApplicationTag: seKeyTag,
      kSecAttrTokenID: kSecAttrTokenIDSecureEnclave,
    ]
    SecItemDelete(seQuery as CFDictionary)

    // Generate new SE key with updated access control
    let newSEKey = try generateSEKey()
    guard let newPublicKey = SecKeyCopyPublicKey(newSEKey) else {
      throw KeychainError.seKeyNotFound
    }

    // Re-wrap each master key under the new SE key
    for item in plaintexts {
      var cfErr: Unmanaged<CFError>?
      guard let rewrapped = SecKeyCreateEncryptedData(newPublicKey, eciesAlgorithm, item.data as CFData, &cfErr) else {
        continue
      }
      deleteWrappedItem(account: item.account)
      var attrs: [CFString: Any] = [
        kSecClass: kSecClassGenericPassword,
        kSecAttrService: wrappedKeyService,
        kSecAttrAccount: item.account,
        kSecAttrAccessible: kSecAttrAccessibleAfterFirstUnlock,
        kSecValueData: rewrapped as Data,
      ]
      if let group = accessGroup { attrs[kSecAttrAccessGroup] = group }
      SecItemAdd(attrs as CFDictionary, nil)
    }
  }

  // MARK: - Private helpers

  private static func getOrCreateSEKey() throws -> SecKey {
    if let existing = findSEKey() { return existing }
    return try generateSEKey()
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
    // SecKey is a CoreFoundation opaque type — unsafeBitCast is the standard
    // way to bridge CFTypeRef → SecKey without a redundant conditional-cast warning.
    return unsafeBitCast(obj, to: SecKey.self)
  }

  private static func generateSEKey() throws -> SecKey {
    let flags: SecAccessControlCreateFlags = requiresBiometric
      ? [.privateKeyUsage, .biometryAny]
      : [.privateKeyUsage, .devicePasscode]

    guard let access = SecAccessControlCreateWithFlags(
      kCFAllocatorDefault,
      kSecAttrAccessibleAfterFirstUnlockThisDeviceOnly,
      flags,
      nil
    ) else {
      throw KeychainError.seKeyGenerationFailed
    }

    let attributes: [CFString: Any] = [
      kSecAttrKeyType: kSecAttrKeyTypeECSECPrimeRandom,
      kSecAttrKeySizeInBits: 256,
      kSecAttrTokenID: kSecAttrTokenIDSecureEnclave,
      kSecPrivateKeyAttrs: [
        kSecAttrIsPermanent: true,
        kSecAttrApplicationTag: seKeyTag,
        kSecAttrAccessControl: access,
      ] as [CFString: Any],
    ]

    var cfErr: Unmanaged<CFError>?
    guard let key = SecKeyCreateRandomKey(attributes as CFDictionary, &cfErr) else {
      throw KeychainError.seKeyGenerationFailed
    }
    return key
  }

  private static func deleteWrappedItem(account: String) {
    var query: [CFString: Any] = [
      kSecClass: kSecClassGenericPassword,
      kSecAttrService: wrappedKeyService,
      kSecAttrAccount: account,
    ]
    if let group = accessGroup { query[kSecAttrAccessGroup] = group }
    SecItemDelete(query as CFDictionary)
  }
}
