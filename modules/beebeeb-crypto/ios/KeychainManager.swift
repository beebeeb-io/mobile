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
  private static let seKeyTagExt = "io.beebeeb.sekey.ext".data(using: .utf8)!
  private static let wrappedKeyService = "io.beebeeb.masterkey"
  private static let wrappedKeyServiceExt = "io.beebeeb.masterkey.ext"
  #if DEBUG && targetEnvironment(simulator)
  private static let simulatorSoftwareKeyService = "io.beebeeb.masterkey.simulator-software"
  #endif
  private static let eciesAlgorithm = SecKeyAlgorithm.eciesEncryptionCofactorVariableIVX963SHA256AESGCM

  // Shared with the File Provider extension through the keychain-access-groups
  // entitlement. App Groups and keychain access groups are separate concepts.
  private static let accessGroup: String? = "R8352WDJJR.io.beebeeb.shared"

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

    #if DEBUG && targetEnvironment(simulator)
    try storeSimulatorSoftwareKey(masterKeyBytes: masterKeyBytes, label: label)
    return
    #endif

    // --- Primary SE key (biometric or passcode, per user preference) ---
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

    // --- Extension SE key (.devicePasscode always — no biometric prompt from extensions) ---
    storeExtensionWrappedKey(masterKeyBytes: masterKeyBytes, label: label)
  }

  /// Encrypt the master key under the extension SE key and persist alongside
  /// the primary blob. Best-effort: failure here does not block the main store
  /// because the primary key is already safely written. Extensions fall back to
  /// the primary key when the extension blob is absent.
  private static func storeExtensionWrappedKey(masterKeyBytes: Data, label: String) {
    guard let extSEKey = try? getOrCreateExtensionSEKey(),
          let extPublicKey = SecKeyCopyPublicKey(extSEKey) else { return }

    var cfErr: Unmanaged<CFError>?
    guard let extWrapped = SecKeyCreateEncryptedData(extPublicKey, eciesAlgorithm, masterKeyBytes as CFData, &cfErr) else { return }

    deleteWrappedItem(account: label, service: wrappedKeyServiceExt)

    var extAttrs: [CFString: Any] = [
      kSecClass: kSecClassGenericPassword,
      kSecAttrService: wrappedKeyServiceExt,
      kSecAttrAccount: label,
      kSecAttrAccessible: kSecAttrAccessibleAfterFirstUnlock,
      kSecValueData: extWrapped as Data,
    ]
    if let group = accessGroup { extAttrs[kSecAttrAccessGroup] = group }
    SecItemAdd(extAttrs as CFDictionary, nil)
  }

  // MARK: - Load

  /// Decrypt and return the master key. Returns nil if no key is stored.
  /// Triggers biometric/passcode prompt if the SE access control requires it.
  static func load(label: String) throws -> Data? {
    #if DEBUG && targetEnvironment(simulator)
    if let simulatorKey = try loadSimulatorSoftwareKey(label: label) {
      return simulatorKey
    }
    #endif

    var query: [CFString: Any] = [
      kSecClass: kSecClassGenericPassword,
      kSecAttrService: wrappedKeyService,
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
    guard status == errSecSuccess else {
      if status == errSecItemNotFound { return nil }
      throw KeychainError.readError(status)
    }
    guard let wrapped = result as? Data else { return nil }

    guard let seKey = findSEKey() ?? findLegacySEKey() else {
      throw KeychainError.seKeyNotFound
    }

    var cfErr: Unmanaged<CFError>?
    guard let plaintext = SecKeyCreateDecryptedData(seKey, eciesAlgorithm, wrapped as CFData, &cfErr) else {
      throw KeychainError.decryptionFailed
    }
    if query[kSecAttrAccessGroup] == nil, accessGroup != nil {
      try? store(masterKeyBytes: plaintext as Data, label: label)
    }
    return plaintext as Data
  }

  // MARK: - Delete

  /// Remove the SE wrapping key and all wrapped key blobs. Irreversible.
  static func delete() {
    deleteSEKey()
    deleteWrappedItems()
    #if DEBUG && targetEnvironment(simulator)
    deleteSimulatorSoftwareKeys()
    #endif
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

    // Delete old primary SE key
    deleteSEKey(tag: seKeyTag)

    // Generate new primary SE key with updated access control
    let newFlags: SecAccessControlCreateFlags = requireBiometric
      ? [.privateKeyUsage, .biometryAny]
      : [.privateKeyUsage, .devicePasscode]
    let newSEKey = try generateSEKey(tag: seKeyTag, flags: newFlags)
    guard let newPublicKey = SecKeyCopyPublicKey(newSEKey) else {
      throw KeychainError.seKeyNotFound
    }

    // Re-wrap each master key under the new primary SE key
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

    // Manage extension key: create when biometric ON, delete when OFF.
    // When biometric is OFF the primary key already uses .devicePasscode,
    // so extensions can use the primary key directly — no need for the ext copy.
    if requireBiometric {
      for item in plaintexts {
        storeExtensionWrappedKey(masterKeyBytes: item.data, label: item.account)
      }
    } else {
      deleteSEKey(tag: seKeyTagExt)
      deleteWrappedItems(service: wrappedKeyServiceExt)
    }
  }

  /// Switch access control using the already-unlocked master key.
  ///
  /// The JS layer keeps the master key in memory only while the vault is open.
  /// When the user enables Face ID from Settings, using that plaintext avoids
  /// one extra prompt under the old device-passcode policy.
  static func replaceAccessControl(requireBiometric: Bool, masterKeyBytes: Data, label: String) throws {
    guard masterKeyBytes.count == 32 else {
      throw KeychainError.invalidMasterKeySize
    }

    let previousPolicy = requiresBiometric
    deleteSEKey()
    deleteWrappedItems()
    requiresBiometric = requireBiometric

    do {
      try store(masterKeyBytes: masterKeyBytes, label: label)
    } catch {
      deleteSEKey()
      deleteWrappedItems()
      requiresBiometric = previousPolicy
      try? store(masterKeyBytes: masterKeyBytes, label: label)
      throw error
    }
  }

  // MARK: - Private helpers

  private static func getOrCreateSEKey() throws -> SecKey {
    if let existing = findSEKey() { return existing }
    let flags: SecAccessControlCreateFlags = requiresBiometric
      ? [.privateKeyUsage, .biometryAny]
      : [.privateKeyUsage, .devicePasscode]
    return try generateSEKey(tag: seKeyTag, flags: flags)
  }

  private static func getOrCreateExtensionSEKey() throws -> SecKey {
    if let existing = findSEKey(tag: seKeyTagExt) { return existing }
    return try generateSEKey(tag: seKeyTagExt, flags: [.privateKeyUsage, .devicePasscode])
  }

  private static func findSEKey() -> SecKey? {
    return findSEKey(tag: seKeyTag)
  }

  private static func findSEKey(tag: Data) -> SecKey? {
    var query: [CFString: Any] = [
      kSecClass: kSecClassKey,
      kSecAttrKeyType: kSecAttrKeyTypeECSECPrimeRandom,
      kSecAttrApplicationTag: tag,
      kSecAttrTokenID: kSecAttrTokenIDSecureEnclave,
      kSecReturnRef: true,
    ]
    if let group = accessGroup { query[kSecAttrAccessGroup] = group }
    return findSEKey(query: query)
  }

  private static func findLegacySEKey() -> SecKey? {
    let query: [CFString: Any] = [
      kSecClass: kSecClassKey,
      kSecAttrKeyType: kSecAttrKeyTypeECSECPrimeRandom,
      kSecAttrApplicationTag: seKeyTag,
      kSecAttrTokenID: kSecAttrTokenIDSecureEnclave,
      kSecReturnRef: true,
    ]
    return findSEKey(query: query)
  }

  private static func findSEKey(query: [CFString: Any]) -> SecKey? {
    var result: CFTypeRef?
    guard SecItemCopyMatching(query as CFDictionary, &result) == errSecSuccess,
          let obj = result else {
      return nil
    }
    // SecKey is a CoreFoundation opaque type — unsafeBitCast is the standard
    // way to bridge CFTypeRef → SecKey without a redundant conditional-cast warning.
    return unsafeBitCast(obj, to: SecKey.self)
  }

  /// Generate a Secure Enclave P-256 key with the given tag and access control flags.
  private static func generateSEKey(tag: Data, flags: SecAccessControlCreateFlags) throws -> SecKey {
    guard let access = SecAccessControlCreateWithFlags(
      kCFAllocatorDefault,
      kSecAttrAccessibleAfterFirstUnlockThisDeviceOnly,
      flags,
      nil
    ) else {
      throw KeychainError.seKeyGenerationFailed
    }

    var attributes: [CFString: Any] = [
      kSecAttrKeyType: kSecAttrKeyTypeECSECPrimeRandom,
      kSecAttrKeySizeInBits: 256,
      kSecAttrTokenID: kSecAttrTokenIDSecureEnclave,
      kSecPrivateKeyAttrs: [
        kSecAttrIsPermanent: true,
        kSecAttrApplicationTag: tag,
        kSecAttrAccessControl: access,
      ] as [CFString: Any],
    ]
    if let group = accessGroup { attributes[kSecAttrAccessGroup] = group }

    var cfErr: Unmanaged<CFError>?
    guard let key = SecKeyCreateRandomKey(attributes as CFDictionary, &cfErr) else {
      throw KeychainError.seKeyGenerationFailed
    }
    return key
  }

  private static func deleteWrappedItem(account: String, service: String = wrappedKeyService) {
    var query: [CFString: Any] = [
      kSecClass: kSecClassGenericPassword,
      kSecAttrService: service,
      kSecAttrAccount: account,
    ]
    if let group = accessGroup { query[kSecAttrAccessGroup] = group }
    SecItemDelete(query as CFDictionary)
  }

  private static func deleteSEKey() {
    deleteSEKey(tag: seKeyTag)
    deleteSEKey(tag: seKeyTagExt)
  }

  private static func deleteSEKey(tag: Data) {
    var query: [CFString: Any] = [
      kSecClass: kSecClassKey,
      kSecAttrKeyType: kSecAttrKeyTypeECSECPrimeRandom,
      kSecAttrApplicationTag: tag,
      kSecAttrTokenID: kSecAttrTokenIDSecureEnclave,
    ]
    if let group = accessGroup { query[kSecAttrAccessGroup] = group }
    SecItemDelete(query as CFDictionary)

    if accessGroup != nil {
      var legacyQuery = query
      legacyQuery.removeValue(forKey: kSecAttrAccessGroup)
      SecItemDelete(legacyQuery as CFDictionary)
    }
  }

  private static func deleteWrappedItems() {
    deleteWrappedItems(service: wrappedKeyService)
    deleteWrappedItems(service: wrappedKeyServiceExt)
  }

  private static func deleteWrappedItems(service: String) {
    var query: [CFString: Any] = [
      kSecClass: kSecClassGenericPassword,
      kSecAttrService: service,
    ]
    if let group = accessGroup { query[kSecAttrAccessGroup] = group }
    SecItemDelete(query as CFDictionary)

    if accessGroup != nil {
      query.removeValue(forKey: kSecAttrAccessGroup)
      SecItemDelete(query as CFDictionary)
    }
  }

  #if DEBUG && targetEnvironment(simulator)
  private static func simulatorSoftwareKeyQuery(label: String? = nil) -> [CFString: Any] {
    var query: [CFString: Any] = [
      kSecClass: kSecClassGenericPassword,
      kSecAttrService: simulatorSoftwareKeyService,
    ]
    if let label {
      query[kSecAttrAccount] = label
    }
    if let group = accessGroup {
      query[kSecAttrAccessGroup] = group
    }
    return query
  }

  private static func storeSimulatorSoftwareKey(masterKeyBytes: Data, label: String) throws {
    var attrs = simulatorSoftwareKeyQuery(label: label)
    SecItemDelete(attrs as CFDictionary)

    attrs[kSecAttrAccessible] = kSecAttrAccessibleAfterFirstUnlockThisDeviceOnly
    attrs[kSecValueData] = masterKeyBytes

    let status = SecItemAdd(attrs as CFDictionary, nil)
    guard status == errSecSuccess else {
      throw KeychainError.writeError(status)
    }
  }

  private static func loadSimulatorSoftwareKey(label: String) throws -> Data? {
    var query = simulatorSoftwareKeyQuery(label: label)
    query[kSecReturnData] = true
    query[kSecMatchLimit] = kSecMatchLimitOne

    var result: CFTypeRef?
    let status = SecItemCopyMatching(query as CFDictionary, &result)
    if status == errSecItemNotFound {
      return nil
    }
    guard status == errSecSuccess else {
      throw KeychainError.readError(status)
    }
    return result as? Data
  }

  private static func deleteSimulatorSoftwareKeys() {
    SecItemDelete(simulatorSoftwareKeyQuery() as CFDictionary)
  }
  #endif
}
