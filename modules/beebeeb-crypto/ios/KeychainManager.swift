import Foundation
import LocalAuthentication
import Security

enum KeychainError: LocalizedError {
  case seKeyGenerationFailed
  case seKeyNotFound
  case encryptionFailed
  case decryptionFailed
  case writeError(OSStatus)
  case readError(OSStatus)
  case invalidMasterKeySize
  /// Typed biometric/passcode outcome for the primary master-key load, carried
  /// to the JS layer as a stable code so cold-start warm-up (retry) is
  /// distinguished from a real cancel / auth failure / lockout (surface, stay
  /// locked — task 0882 / fail-closed 0428).
  case vaultAuth(BeebeebKeychainCore.AuthFailureReason)

  var errorDescription: String? {
    switch self {
    case .seKeyGenerationFailed: return "Failed to generate Secure Enclave key"
    case .seKeyNotFound: return "Secure Enclave wrapping key not found"
    case .encryptionFailed: return "ECIES encryption failed"
    case .decryptionFailed: return "ECIES decryption failed — biometric or passcode required"
    case .writeError(let s): return "Keychain write error \(s)"
    case .readError(let s): return "Keychain read error \(s)"
    case .invalidMasterKeySize: return "Master key must be exactly 32 bytes"
    case .vaultAuth(let reason): return reason.message
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
///
/// **Read logic is shared via `BeebeebKeychainCore`** (task 0436). This type
/// keeps the write paths (`store`, `setAccessControl`, etc.), the access-control
/// policy flag, the simulator-software-key path, and the string-storage
/// helpers added in 0430. Constants live in `BeebeebKeychainCore` and are
/// referenced through it rather than redeclared here.
final class KeychainManager {

  // MARK: - Constants
  //
  // The SE key tags, services, access group, and ECIES algorithm all live on
  // `BeebeebKeychainCore` — single source of truth across the main app and
  // both extensions. Local constants here are only for paths that have no
  // counterpart in extensions.

  #if DEBUG && targetEnvironment(simulator)
  private static let simulatorSoftwareKeyService = "io.beebeeb.masterkey.simulator-software"
  #endif

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
    #else
    // --- Primary SE key (biometric or passcode, per user preference) ---
    let seKey = try getOrCreateSEKey()
    guard let publicKey = SecKeyCopyPublicKey(seKey) else {
      throw KeychainError.seKeyNotFound
    }

    var cfErr: Unmanaged<CFError>?
    guard let wrapped = SecKeyCreateEncryptedData(publicKey, BeebeebKeychainCore.eciesAlgorithm, masterKeyBytes as CFData, &cfErr) else {
      throw KeychainError.encryptionFailed
    }

    deleteWrappedItem(account: label)

    var attrs: [CFString: Any] = [
      kSecClass: kSecClassGenericPassword,
      kSecAttrService: BeebeebKeychainCore.wrappedKeyService,
      kSecAttrAccount: label,
      kSecAttrAccessible: kSecAttrAccessibleAfterFirstUnlock,
      kSecValueData: wrapped as Data,
    ]
    if let group = BeebeebKeychainCore.accessGroup { attrs[kSecAttrAccessGroup] = group }

    let status = SecItemAdd(attrs as CFDictionary, nil)
    guard status == errSecSuccess else {
      throw KeychainError.writeError(status)
    }

    // --- Extension SE key (.devicePasscode always — no biometric prompt from extensions) ---
    try storeExtensionWrappedKey(masterKeyBytes: masterKeyBytes, label: label)
    #endif
  }

  /// Encrypt the master key under the extension SE key and persist alongside
  /// the primary blob. This is required: the File Provider intentionally never
  /// falls back to the primary key because it may require Face ID from Files.app.
  private static func storeExtensionWrappedKey(masterKeyBytes: Data, label: String) throws {
    let extSEKey = try getOrCreateExtensionSEKey()
    guard let extPublicKey = SecKeyCopyPublicKey(extSEKey) else {
      throw KeychainError.seKeyNotFound
    }

    var cfErr: Unmanaged<CFError>?
    guard let extWrapped = SecKeyCreateEncryptedData(extPublicKey, BeebeebKeychainCore.eciesAlgorithm, masterKeyBytes as CFData, &cfErr) else {
      throw KeychainError.encryptionFailed
    }

    deleteWrappedItem(account: label, service: BeebeebKeychainCore.wrappedKeyServiceExt)

    var extAttrs: [CFString: Any] = [
      kSecClass: kSecClassGenericPassword,
      kSecAttrService: BeebeebKeychainCore.wrappedKeyServiceExt,
      kSecAttrAccount: label,
      kSecAttrAccessible: kSecAttrAccessibleAfterFirstUnlock,
      kSecValueData: extWrapped as Data,
    ]
    if let group = BeebeebKeychainCore.accessGroup { extAttrs[kSecAttrAccessGroup] = group }
    let status = SecItemAdd(extAttrs as CFDictionary, nil)
    guard status == errSecSuccess else {
      throw KeychainError.writeError(status)
    }
  }

  // MARK: - Load

  /// Decrypt and return the master key. Returns nil if no key is stored.
  /// Triggers biometric/passcode prompt if the SE access control requires it.
  ///
  /// Delegates the SE-wrap read to `BeebeebKeychainCore`. On a successful
  /// read, also (re)writes the extension-wrapped blob so backup extensions
  /// can read the key without prompting; if the read came from a legacy
  /// no-access-group keychain item, re-stores with the access group set so
  /// the migration is idempotent.
  static func load(label: String) throws -> Data? {
    RuntimeTrace.event("keychain.manager.load.request", [
      "label": label,
      "mode": "primaryOnly",
      "promptMayAppear": true
    ])
    #if DEBUG && targetEnvironment(simulator)
    if let simulatorKey = try loadSimulatorSoftwareKey(label: label) {
      RuntimeTrace.event("keychain.manager.load.simulator_success", ["label": label])
      return simulatorKey
    }
    #endif

    // No wrapped blob at all → no key was ever provisioned here (fresh install /
    // device restore that dropped the SE blob). Return nil BEFORE evaluating any
    // biometric so a genuine recovery case never flashes a Face ID sheet. The JS
    // layer maps this nil → { reason: 'no_key' } → recovery-phrase prompt.
    guard BeebeebKeychainCore.fetchWrappedBlob(service: BeebeebKeychainCore.wrappedKeyService, label: label) != nil else {
      RuntimeTrace.event("keychain.manager.load.miss", ["label": label])
      return nil
    }

    // A key IS provisioned. Perform EXACTLY ONE explicit, user-initiated
    // evaluation (task 0882 primary fix) and reuse it for the SE decrypt via
    // kSecUseAuthenticationContext — this REPLACES the old too-early implicit
    // biometric raised inside SecKeyCreateDecryptedData (which fired before the
    // Secure Enclave was warm on a true cold restart, returned nil, and got
    // mislabeled as a generic `seKeyNotFound` → JS `transient`). Preserves the
    // 0792 exactly-one-prompt invariant (the explicit eval replaces, never adds,
    // a prompt) and runs off the main thread (see authenticateForPrimaryLoad).
    let authContext = try authenticateForPrimaryLoad(label: label)

    // Main app uses .primaryOnly — biometric/passcode prompt is acceptable
    // here. Extensions use .extensionOnly / .extensionThenPrimary.
    var decryptError: Unmanaged<CFError>?
    guard let plaintextData = BeebeebKeychainCore.loadMasterKey(
      label: label,
      mode: .primaryOnly,
      authContext: authContext,
      decryptError: &decryptError
    ) else {
      // Auth succeeded but the SE decrypt still returned nil this early in
      // process start. Map the (previously discarded) CFError to a typed reason
      // instead of a blanket seKeyNotFound (task 0882 companion). The common
      // case is a transient SE hiccup → notWarm → JS retries, and the retry
      // reuses `authContext` (no second prompt).
      let reason = BeebeebKeychainCore.classifyDecryptError(decryptError)
      RuntimeTrace.event("keychain.manager.load.decrypt_failed", [
        "label": label,
        "reason": reason.rawValue
      ])
      throw KeychainError.vaultAuth(reason)
    }

    // Keep the extension-wrapped blob in sync so backup extensions can read.
    try storeExtensionWrappedKey(masterKeyBytes: plaintextData, label: label)

    // Idempotent re-store under the access group. If the read came from
    // legacy no-access-group storage, this migrates it forward; if it
    // already had the access group, this is a no-op rewrite.
    try? store(masterKeyBytes: plaintextData, label: label)

    RuntimeTrace.event("keychain.manager.load.success", ["label": label])
    return plaintextData
  }

  // MARK: - Primary-load biometric evaluation (task 0882)

  /// Run EXACTLY ONE explicit, user-initiated biometric/passcode evaluation for
  /// the primary master-key load and return the satisfied `LAContext` so the SE
  /// decrypt can reuse it (`kSecUseAuthenticationContext`) without raising a
  /// second prompt (0792 exactly-one-prompt). This replaces the too-early
  /// IMPLICIT evaluation that `SecKeyCreateDecryptedData` used to raise on its
  /// own — that fired before the Secure Enclave was warm on a cold restart and
  /// silently failed (task 0882).
  ///
  /// Policy matches the primary SE key's access-control variant
  /// (`getOrCreateSEKey`, driven by `requiresBiometric`):
  ///   - `.biometryAny`    → `.deviceOwnerAuthenticationWithBiometrics`
  ///   - `.devicePasscode` → `.deviceOwnerAuthentication` (biometrics OR
  ///                          passcode — preserves the passcode-only fallback).
  ///
  /// Threading: `evaluatePolicy` is asynchronous and iOS presents its sheet on
  /// the main thread. We therefore MUST NOT block the main thread while waiting
  /// (that would prevent the sheet from presenting → deadlock). Expo
  /// AsyncFunctions already invoke this off the main thread; we wait on a
  /// semaphore from that background thread (main stays free for the sheet), and
  /// defensively fail-closed (retryable) rather than block if ever called on
  /// main.
  ///
  /// Throws `KeychainError.vaultAuth(reason)` on cancel / failure / lockout /
  /// unavailable so the JS layer decides retry-vs-surface (fail-closed, 0428).
  private static func authenticateForPrimaryLoad(label: String) throws -> LAContext {
    let context = LAContext()
    // Short reuse window so the immediately-following SE decrypt (and a cheap
    // post-auth transient retry) are covered by this single evaluation without
    // leaving a broad ambient-auth window open.
    context.touchIDAuthenticationAllowableReuseDuration = 10
    let reason = "Unlock your Beebeeb vault"

    let requireBiometricPolicy = requiresBiometric
    let policy: LAPolicy = requireBiometricPolicy
      ? .deviceOwnerAuthenticationWithBiometrics
      : .deviceOwnerAuthentication
    if requireBiometricPolicy {
      // No passcode-fallback button for the biometrics-only key (mirrors the
      // RN lock screen's disableDeviceFallback); the in-app password button is
      // the explicit fallback. Passcode-allowed keys keep the default sheet.
      context.localizedFallbackTitle = ""
    }

    var canEvalError: NSError?
    guard context.canEvaluatePolicy(policy, error: &canEvalError) else {
      RuntimeTrace.event("keychain.manager.load.cannot_evaluate", [
        "label": label,
        "requiresBiometric": requireBiometricPolicy,
        "error": canEvalError?.localizedDescription ?? "unknown"
      ])
      // Subsystem not ready yet this early in start (or biometrics not
      // enrolled) — retryable, not a user failure.
      throw KeychainError.vaultAuth(.notAvailable)
    }

    // Never block the main thread (invariant: no main-thread deadlock). Expo
    // AsyncFunctions run off-main; if we are ever on main, bail retryably rather
    // than risk stalling the UI that must present the sheet.
    if Thread.isMainThread {
      RuntimeTrace.event("keychain.manager.load.evaluate_on_main_skipped", ["label": label])
      throw KeychainError.vaultAuth(.notWarm)
    }

    let semaphore = DispatchSemaphore(value: 0)
    var evalSuccess = false
    var evalError: Error?
    context.evaluatePolicy(policy, localizedReason: reason) { success, error in
      evalSuccess = success
      evalError = error
      semaphore.signal()
    }
    semaphore.wait()

    if evalSuccess {
      RuntimeTrace.event("keychain.manager.load.evaluate_success", [
        "label": label,
        "requiresBiometric": requireBiometricPolicy
      ])
      return context
    }

    let failureReason = classifyLAError(evalError)
    RuntimeTrace.event("keychain.manager.load.evaluate_failed", [
      "label": label,
      "reason": failureReason.rawValue
    ])
    throw KeychainError.vaultAuth(failureReason)
  }

  /// Map an `LAError` from `evaluatePolicy` to a typed reason (task 0882).
  private static func classifyLAError(_ error: Error?) -> BeebeebKeychainCore.AuthFailureReason {
    guard let laError = error as? LAError else { return .authFailed }
    switch laError.code {
    case .userCancel, .systemCancel, .appCancel, .userFallback:
      return .userCanceled
    case .authenticationFailed:
      return .authFailed
    case .biometryLockout:
      return .biometryLockout
    case .biometryNotAvailable, .biometryNotEnrolled, .passcodeNotSet, .invalidContext, .notInteractive:
      return .notAvailable
    default:
      return .notWarm
    }
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
    RuntimeTrace.event("keychain.manager.set_access_control.request", [
      "requireBiometric": requireBiometric,
      "wasBiometric": wasBiometric,
      "promptMayAppear": wasBiometric
    ])

    guard wasBiometric != requireBiometric,
          let oldSEKey = BeebeebKeychainCore.findSEKey(tag: BeebeebKeychainCore.seKeyTag) else {
      RuntimeTrace.event("keychain.manager.set_access_control.noop", [
        "requireBiometric": requireBiometric,
        "wasBiometric": wasBiometric
      ])
      return
    }

    // Fetch all wrapped blobs so we can re-wrap them under the new SE key
    var fetchQuery: [CFString: Any] = [
      kSecClass: kSecClassGenericPassword,
      kSecAttrService: BeebeebKeychainCore.wrappedKeyService,
      kSecReturnData: true,
      kSecReturnAttributes: true,
      kSecMatchLimit: kSecMatchLimitAll,
    ]
    if let group = BeebeebKeychainCore.accessGroup { fetchQuery[kSecAttrAccessGroup] = group }

    var allItems: CFTypeRef?
    let fetchStatus = SecItemCopyMatching(fetchQuery as CFDictionary, &allItems)
    let items = fetchStatus == errSecSuccess ? (allItems as? [[CFString: Any]] ?? []) : []
    RuntimeTrace.event("keychain.manager.set_access_control.items_fetched", [
      "count": items.count,
      "status": fetchStatus
    ])

    // Decrypt each blob with the old SE key (triggers auth prompt if needed)
    var plaintexts: [(account: String, data: Data)] = []
    for item in items {
      guard let wrapped = item[kSecValueData] as? Data,
            let account = item[kSecAttrAccount] as? String else { continue }
      var cfErr: Unmanaged<CFError>?
      if let plain = SecKeyCreateDecryptedData(oldSEKey, BeebeebKeychainCore.eciesAlgorithm, wrapped as CFData, &cfErr) {
        plaintexts.append((account: account, data: plain as Data))
      }
    }

    // Delete old primary SE key
    deleteSEKey(tag: BeebeebKeychainCore.seKeyTag)

    // Generate new primary SE key with updated access control
    let newFlags: SecAccessControlCreateFlags = requireBiometric
      ? [.privateKeyUsage, .biometryAny]
      : [.privateKeyUsage, .devicePasscode]
    let newSEKey = try generateSEKey(tag: BeebeebKeychainCore.seKeyTag, flags: newFlags)
    guard let newPublicKey = SecKeyCopyPublicKey(newSEKey) else {
      throw KeychainError.seKeyNotFound
    }

    // Re-wrap each master key under the new primary SE key
    for item in plaintexts {
      var cfErr: Unmanaged<CFError>?
      guard let rewrapped = SecKeyCreateEncryptedData(newPublicKey, BeebeebKeychainCore.eciesAlgorithm, item.data as CFData, &cfErr) else {
        continue
      }
      deleteWrappedItem(account: item.account)
      var attrs: [CFString: Any] = [
        kSecClass: kSecClassGenericPassword,
        kSecAttrService: BeebeebKeychainCore.wrappedKeyService,
        kSecAttrAccount: item.account,
        kSecAttrAccessible: kSecAttrAccessibleAfterFirstUnlock,
        kSecValueData: rewrapped as Data,
      ]
      if let group = BeebeebKeychainCore.accessGroup { attrs[kSecAttrAccessGroup] = group }
      SecItemAdd(attrs as CFDictionary, nil)
    }

    // Always keep the extension wrapped key available. The File Provider never
    // falls back to the primary key, because that key may require Face ID from
    // an extension process and can cause repeated system prompts in Files.app.
    for item in plaintexts {
      try storeExtensionWrappedKey(masterKeyBytes: item.data, label: item.account)
    }
    RuntimeTrace.event("keychain.manager.set_access_control.success", [
      "requireBiometric": requireBiometric,
      "rewrapped": plaintexts.count
    ])
  }

  /// Switch access control using the already-unlocked master key.
  ///
  /// The JS layer keeps the master key in memory only while the vault is open.
  /// When the user enables Face ID from Settings, using that plaintext avoids
  /// one extra prompt under the old device-passcode policy.
  static func replaceAccessControl(requireBiometric: Bool, masterKeyBytes: Data, label: String) throws {
    RuntimeTrace.event("keychain.manager.replace_access_control.request", [
      "requireBiometric": requireBiometric,
      "label": label
    ])
    guard masterKeyBytes.count == 32 else {
      RuntimeTrace.event("keychain.manager.replace_access_control.invalid_key_size", [
        "label": label,
        "size": masterKeyBytes.count
      ])
      throw KeychainError.invalidMasterKeySize
    }

    let previousPolicy = requiresBiometric
    deleteSEKey()
    deleteWrappedItems()
    requiresBiometric = requireBiometric

    do {
      try store(masterKeyBytes: masterKeyBytes, label: label)
      RuntimeTrace.event("keychain.manager.replace_access_control.success", [
        "requireBiometric": requireBiometric,
        "label": label
      ])
    } catch {
      deleteSEKey()
      deleteWrappedItems()
      requiresBiometric = previousPolicy
      try? store(masterKeyBytes: masterKeyBytes, label: label)
      RuntimeTrace.event("keychain.manager.replace_access_control.failed_rolled_back", [
        "requireBiometric": requireBiometric,
        "label": label,
        "error": error.localizedDescription
      ])
      throw error
    }
  }

  // MARK: - Arbitrary string storage (for backup token, server URL, etc.)
  //
  // Used to keep the backup auth token and server URL out of UserDefaults.
  // UserDefaults plist files are included verbatim in unencrypted iTunes /
  // iCloud backups, so a bearer token there leaks on device restore /
  // forensic extraction. Keychain items written with
  // `kSecAttrAccessibleAfterFirstUnlockThisDeviceOnly` do NOT migrate via
  // unencrypted backups, which is the property we need (task 0430).
  //
  // The access group is the same as for the master key, so background
  // tasks running in the main app's address space and extensions sharing
  // the `keychain-access-groups` entitlement can read the value.
  //
  // String storage is intentionally not consolidated into BeebeebKeychainCore
  // — only the main app writes these, and the orthogonal API would just
  // expand the shared surface for no benefit (per ios-engineer's note on
  // 0436).

  private static let stringStorageService = "io.beebeeb.string-storage"

  static func storeString(_ value: String, key: String) throws {
    let data = Data(value.utf8)
    deleteString(key: key)

    var attrs: [CFString: Any] = [
      kSecClass: kSecClassGenericPassword,
      kSecAttrService: stringStorageService,
      kSecAttrAccount: key,
      kSecAttrAccessible: kSecAttrAccessibleAfterFirstUnlockThisDeviceOnly,
      kSecValueData: data,
    ]
    if let group = BeebeebKeychainCore.accessGroup { attrs[kSecAttrAccessGroup] = group }

    let status = SecItemAdd(attrs as CFDictionary, nil)
    guard status == errSecSuccess else { throw KeychainError.writeError(status) }
  }

  /// Returns the stored string for `key`. Performs a one-time on-demand
  /// migration: if the keychain entry is missing but UserDefaults still
  /// holds the legacy value, copy it into the keychain and remove the
  /// UserDefaults key. UserDefaults is only cleared after the keychain
  /// write returns `errSecSuccess` — never partially, to avoid losing the
  /// only copy of an auth token if the keychain write fails.
  static func loadString(key: String) -> String? {
    if let existing = readStringFromKeychain(key: key) {
      return existing
    }

    let defaults = UserDefaults.standard
    guard let legacy = defaults.string(forKey: key) else { return nil }
    do {
      try storeString(legacy, key: key)
      defaults.removeObject(forKey: key)
      return legacy
    } catch {
      NSLog("[Beebeeb] keychain migration failed for \(key): \(error.localizedDescription) — falling back to UserDefaults until next launch")
      return legacy
    }
  }

  static func deleteString(key: String) {
    var query: [CFString: Any] = [
      kSecClass: kSecClassGenericPassword,
      kSecAttrService: stringStorageService,
      kSecAttrAccount: key,
    ]
    if let group = BeebeebKeychainCore.accessGroup { query[kSecAttrAccessGroup] = group }
    SecItemDelete(query as CFDictionary)
    // Also clear any legacy UserDefaults entry so the migration path can't
    // resurrect a stale value on the next read.
    UserDefaults.standard.removeObject(forKey: key)
  }

  private static func readStringFromKeychain(key: String) -> String? {
    var query: [CFString: Any] = [
      kSecClass: kSecClassGenericPassword,
      kSecAttrService: stringStorageService,
      kSecAttrAccount: key,
      kSecReturnData: true,
      kSecMatchLimit: kSecMatchLimitOne,
    ]
    if let group = BeebeebKeychainCore.accessGroup { query[kSecAttrAccessGroup] = group }

    var result: CFTypeRef?
    var status = SecItemCopyMatching(query as CFDictionary, &result)
    if status == errSecItemNotFound, BeebeebKeychainCore.accessGroup != nil {
      query.removeValue(forKey: kSecAttrAccessGroup)
      status = SecItemCopyMatching(query as CFDictionary, &result)
    }
    guard status == errSecSuccess, let data = result as? Data else { return nil }
    return String(data: data, encoding: .utf8)
  }

  // MARK: - Private write helpers

  private static func getOrCreateSEKey() throws -> SecKey {
    if let existing = BeebeebKeychainCore.findSEKey(tag: BeebeebKeychainCore.seKeyTag) { return existing }
    let flags: SecAccessControlCreateFlags = requiresBiometric
      ? [.privateKeyUsage, .biometryAny]
      : [.privateKeyUsage, .devicePasscode]
    return try generateSEKey(tag: BeebeebKeychainCore.seKeyTag, flags: flags)
  }

  private static func getOrCreateExtensionSEKey() throws -> SecKey {
    if let existing = BeebeebKeychainCore.findSEKey(tag: BeebeebKeychainCore.seKeyTagExt) { return existing }
    return try generateSEKey(tag: BeebeebKeychainCore.seKeyTagExt, flags: [.privateKeyUsage, .devicePasscode])
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
    if let group = BeebeebKeychainCore.accessGroup { attributes[kSecAttrAccessGroup] = group }

    var cfErr: Unmanaged<CFError>?
    guard let key = SecKeyCreateRandomKey(attributes as CFDictionary, &cfErr) else {
      throw KeychainError.seKeyGenerationFailed
    }
    return key
  }

  private static func deleteWrappedItem(account: String, service: String = BeebeebKeychainCore.wrappedKeyService) {
    var query: [CFString: Any] = [
      kSecClass: kSecClassGenericPassword,
      kSecAttrService: service,
      kSecAttrAccount: account,
    ]
    if let group = BeebeebKeychainCore.accessGroup { query[kSecAttrAccessGroup] = group }
    SecItemDelete(query as CFDictionary)
  }

  private static func deleteSEKey() {
    deleteSEKey(tag: BeebeebKeychainCore.seKeyTag)
    deleteSEKey(tag: BeebeebKeychainCore.seKeyTagExt)
  }

  private static func deleteSEKey(tag: Data) {
    var query: [CFString: Any] = [
      kSecClass: kSecClassKey,
      kSecAttrKeyType: kSecAttrKeyTypeECSECPrimeRandom,
      kSecAttrApplicationTag: tag,
      kSecAttrTokenID: kSecAttrTokenIDSecureEnclave,
    ]
    if let group = BeebeebKeychainCore.accessGroup { query[kSecAttrAccessGroup] = group }
    SecItemDelete(query as CFDictionary)

    if BeebeebKeychainCore.accessGroup != nil {
      var legacyQuery = query
      legacyQuery.removeValue(forKey: kSecAttrAccessGroup)
      SecItemDelete(legacyQuery as CFDictionary)
    }
  }

  private static func deleteWrappedItems() {
    deleteWrappedItems(service: BeebeebKeychainCore.wrappedKeyService)
    deleteWrappedItems(service: BeebeebKeychainCore.wrappedKeyServiceExt)
  }

  private static func deleteWrappedItems(service: String) {
    var query: [CFString: Any] = [
      kSecClass: kSecClassGenericPassword,
      kSecAttrService: service,
    ]
    if let group = BeebeebKeychainCore.accessGroup { query[kSecAttrAccessGroup] = group }
    SecItemDelete(query as CFDictionary)

    if BeebeebKeychainCore.accessGroup != nil {
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
    if let group = BeebeebKeychainCore.accessGroup {
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
